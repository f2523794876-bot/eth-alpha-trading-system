// P1-3（独立复审）：validation_runs异常终态治理——真实PostgreSQL验证。
// 此前的问题：manifest gate之外（生成/评估/报告阶段）出现未处理异常时，runWalkForward()直接把异常
// 冒泡出去，validation_runs行永远停留在RUNNING，既不会被标记FAILED，也不会保存任何结构化失败原因。
// 本文件用"故障注入pool"（对真实client.query的一层薄包装，只对特定SQL文本抛出模拟的DB错误，其余
// SQL原样转发给真实数据库）分别在生成/评估/报告三个阶段注入异常，验证：
// ①validation_runs最终状态为FAILED（不是停留在RUNNING，也不是被误标为SUCCEEDED）；
// ②error_code/blocked_reasons记录了正确的阶段与错误信息；③runWalkForward()本身向上抛出原始异常
// （不吞掉），main()的既有顶层catch（`main().catch(error => { ...; process.exitCode = 1; })`，
// 见cli-entry.js文件末尾，本轮未修改）因此必然会把这类未处理异常转换为非零退出码——该顶层catch本身
// 是无条件的（catch任意错误都设置exitCode=1），不需要为每一种故障场景单独用真实子进程复现一遍，
// 已有 v1-4d-cli-entry-subprocess.integration.test.js 独立证明了该顶层catch机制本身真实有效；
// ④没有错误的成功路径不会产生任何blocked_reasons/error_code（对照组）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest } from '../../src/validation-replay/dataset-manifest-builder.js';
import { runWalkForward } from '../../src/validation-replay/cli-entry.js';
import { generateReplaySnapshot } from '../../src/validation-replay/replay-generator.js';
import { FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION } from '../../src/features/feature-version.js';
import { sha256 } from '../../src/domain/hash.js';

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(TEST_DATABASE_URL);
const FOUR_HOUR_MS = 14400000;
const FIFTEEN_MIN_MS = 900000;

const ALGORITHM_VERSION = 'v1.4c-server-po-rule-1';
const WEIGHT_VERSION = 'v1.4c-server-weight-1';
const RULE_VERSION = 'v1.4c-po-rule-1';
const EVALUATION_VERSION = 'v1.4c-outcome-evaluation-1';

function makeMockAdapter({ pages, serverTimeMs }) {
  let call = 0;
  return {
    serverTime: async () => ({ body: { serverTime: serverTimeMs }, requestId: randomUUID() }),
    spotKlines: async () => { const page = pages[call] || []; call += 1; return { body: page, requestId: randomUUID(), status: 200, headers: {} }; }
  };
}
function kline(openTime, closeTime, closeStr = '1000.00') {
  return [openTime, '999.00', '2000.00', '500.00', closeStr, '10.5', closeTime, '10500.00', 5, '5.0', '5000.00'];
}
async function withTxClient(fn) {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const client = await pool.connect();
  try { await client.query('BEGIN'); await fn(client); }
  finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
}

// 故障注入pool：对匹配faultSqlSubstring的SQL语句抛出模拟的DB错误，其余SQL原样转发给真实client。
function makeFaultInjectingPool(client, faultSqlSubstring) {
  return {
    query: async (sql, params) => {
      if (sql.includes(faultSqlSubstring)) {
        throw Object.assign(new Error(`INJECTED_FAULT: simulated DB error for testing (matched: ${faultSqlSubstring})`), { code: 'INJECTED_FAULT' });
      }
      return client.query(sql, params);
    }
  };
}

async function seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime }) {
  await client.query(
    `INSERT INTO feature_sets(feature_set_version, algorithm_version, schema_version, definition, definition_hash)
     VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(feature_set_version) DO NOTHING`,
    [FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, 'v1.4b-schema-1', JSON.stringify({}), sha256({})]
  );
  const featureValues = {
    closeToEma5: 0, trend4h: 'DOWN', trend1h: 'DOWN', volumeRatio20: 1,
    swingHigh: 1100, swingLow: 900, breakoutState: null, upperWickRatio: 0.1, lowerWickRatio: 0.1,
    distanceToSupportAtr: 5, distanceToResistanceAtr: 5, falseBreakoutRisk: 'NONE',
    btcTrendState: 'RANGE', ethBtcRollingCorrelation: 0, logReturn1: 0
  };
  await client.query(
    `INSERT INTO feature_records(
       feature_id, symbol, target_interval, target_bar_open_time, target_bar_close_time, as_of_time, generated_at,
       feature_set_version, algorithm_version, source_dataset_version, completeness, quality_state, feature_values, availability, content_hash
     ) VALUES($1,'ETHUSDT','15m',to_timestamp($2/1000.0),to_timestamp($3/1000.0),to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6,$7,$8,1,'HEALTHY',$9::jsonb,'{}'::jsonb,$10)`,
    [
      `feature-${referenceCloseTime}`, referenceCloseTime - FIFTEEN_MIN_MS + 1, referenceCloseTime, historicalAsOfTime, historicalAsOfTime,
      FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION, JSON.stringify(featureValues), sha256(featureValues)
    ]
  );
}
async function seedRhythmPoint(client, { referenceCloseTime, replayNowMs }) {
  const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
  const refAdapter = makeMockAdapter({ pages: [[kline(referenceOpenTime, referenceCloseTime, '1000.00')]], serverTimeMs: replayNowMs });
  await backfillInterval({ pool: client, adapter: refAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: referenceOpenTime, endTime: referenceOpenTime, now: () => replayNowMs });

  const count = 15;
  const bars = [];
  for (let i = count - 1; i >= 0; i--) {
    const closeTime = referenceCloseTime - i * FOUR_HOUR_MS;
    bars.push(kline(closeTime - FOUR_HOUR_MS + 1, closeTime, (1000 + i).toFixed(2)));
  }
  const start = referenceCloseTime - (count - 1) * FOUR_HOUR_MS - FOUR_HOUR_MS + 1;
  const atrAdapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
  await backfillInterval({ pool: client, adapter: atrAdapter, symbol: 'ETHUSDT', interval: '4h', startTime: start, endTime: referenceCloseTime, now: () => replayNowMs });

  await seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime: referenceCloseTime });
}
async function fillContiguousCoverage(client, { from, to, replayNowMs }) {
  for (const [interval, stepMs] of [['15m', FIFTEEN_MIN_MS], ['4h', FOUR_HOUR_MS]]) {
    const bars = [];
    for (let openTime = from; openTime < to; openTime += stepMs) bars.push(kline(openTime, openTime + stepMs - 1, '1000.00'));
    if (!bars.length) continue;
    const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval, startTime: from, endTime: to - stepMs, now: () => replayNowMs });
  }
}
async function buildVerifiedManifest(client, { from, to, replayNowMs = Date.now() }) {
  await fillContiguousCoverage(client, { from, to, replayNowMs });
  const result = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m', '4h'], from, to });
  assert.equal(result.status, 'SUCCEEDED', 'manifest构建必须成功（前置bar数据必须无缺口）');
  return result.datasetVersion;
}

test('P1-3：生成阶段注入异常——validation_runs必须转为FAILED，error_code/blocked_reasons记录GENERATION阶段信息，异常原样向上抛出', { skip }, async () => {
  await withTxClient(async (client) => {
    const referenceCloseTime = Date.UTC(2026, 6, 15, 0, 0, 0) - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - FOUR_HOUR_MS + 1;
    const to = referenceCloseTime + 1;
    const datasetVersion = await buildVerifiedManifest(client, { from, to, replayNowMs });

    const faultyPool = makeFaultInjectingPool(client, 'INSERT INTO historical_validation.replay_snapshots');
    let capturedError;
    try {
      await runWalkForward({
        pool: faultyPool, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
        algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION,
        weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, dryRun: false,
        nowMs: Date.now(), replayNowMs
      });
      assert.fail('注入的异常必须导致runWalkForward()拒绝(reject)，不得被吞掉后返回正常plan');
    } catch (error) {
      capturedError = error;
    }
    assert.equal(capturedError.code, 'INJECTED_FAULT', '必须是原始注入的异常本身被抛出，不是被替换/包装成其他错误');

    const runRow = (await client.query(
      `SELECT status, error_code, blocked_reasons FROM historical_validation.validation_runs
       WHERE symbol='ETHUSDT' AND dataset_version=$1 ORDER BY created_at DESC LIMIT 1`,
      [datasetVersion]
    )).rows[0];
    assert.ok(runRow, 'validation_runs行必须已经存在(生成阶段之前已INSERT)');
    assert.equal(runRow.status, 'FAILED', '生成阶段异常后validation_runs必须转为FAILED，不得停留在RUNNING');
    assert.equal(runRow.error_code, 'INJECTED_FAULT');
    assert.equal(runRow.blocked_reasons.length, 1);
    assert.equal(runRow.blocked_reasons[0].phase, 'GENERATION');
    assert.match(runRow.blocked_reasons[0].message, /INJECTED_FAULT/);

    const reportCount = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.validation_reports`)).rows[0].n;
    assert.equal(reportCount, 0, '生成阶段就失败，不应该产出任何报告（不得出现"失败后仍有成功报告"）');
  });
});

test('P1-3：评估阶段注入异常——validation_runs必须转为FAILED，error_code/blocked_reasons记录EVALUATION阶段信息', { skip }, async () => {
  await withTxClient(async (client) => {
    // 评估器要求snapshot与generation证据属于当前validation_run。夹具先在覆盖生成点到成熟点的同一个
    // RUNNING run中生成首条snapshot，再resume该run推进到targetEndTime，确保真正触达outcome INSERT故障点。
    const referenceCloseTime = Date.UTC(2026, 6, 16, 0, 0, 0) - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });
    const targetEndTime = referenceCloseTime + 96 * FIFTEEN_MIN_MS;
    const from = referenceCloseTime - FOUR_HOUR_MS + 1;
    const to = targetEndTime + FOUR_HOUR_MS + 1;
    const datasetVersion = await buildVerifiedManifest(client, { from, to, replayNowMs });
    const validationRunId = randomUUID();
    await client.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id,dataset_version,symbol,horizons,from_utc,to_utc,algorithm_version,rule_version,dry_run,status,started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,false,'RUNNING',now())`,
      [validationRunId, datasetVersion, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );
    const generation = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETHUSDT', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION,
      weightVersion: WEIGHT_VERSION, datasetVersion, ruleVersion: RULE_VERSION, backfillBatchIds: []
    });
    assert.equal(generation.status, 'INSERTED');
    const snapshotCountBefore = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.replay_snapshots`)).rows[0].n;
    assert.equal(snapshotCountBefore, 1, '前置：必须先真实生成一条待评估快照');

    const faultyPool = makeFaultInjectingPool(client, 'INSERT INTO historical_validation.replay_outcome_events');
    let capturedError;
    try {
      await runWalkForward({
        pool: faultyPool, resumeValidationRunId: validationRunId,
        weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, dryRun: false,
        nowMs: Date.now(), replayNowMs
      });
      assert.fail('注入的异常必须导致runWalkForward()拒绝(reject)');
    } catch (error) {
      capturedError = error;
    }
    assert.equal(capturedError.code, 'INJECTED_FAULT');

    const runRow = (await client.query(
      `SELECT validation_run_id, status, error_code, blocked_reasons FROM historical_validation.validation_runs
       WHERE symbol='ETHUSDT' AND dataset_version=$1 ORDER BY created_at DESC LIMIT 1`,
      [datasetVersion]
    )).rows[0];
    assert.equal(runRow.status, 'FAILED');
    assert.equal(runRow.blocked_reasons[0].phase, 'EVALUATION');

    // resume后的其他生成点没有对应feature，均由真实性门禁BLOCKED；首条待评估snapshot仍是唯一记录。
    const snapshotCountAfter = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.replay_snapshots`)).rows[0].n;
    assert.equal(snapshotCountAfter, 1);
    const outcomeCount = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.replay_outcome_events`)).rows[0].n;
    assert.equal(outcomeCount, 0, '评估阶段故障注入后不得有任何outcome写入残留');
    const reportCount = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.validation_reports WHERE validation_run_id=$1`, [runRow.validation_run_id])).rows[0].n;
    assert.equal(reportCount, 0, '评估阶段失败的这次run，不应该产出任何报告（另一次成功的前置run产生的报告不受影响，不在本次断言范围内）');
  });
});

test('P1-3：报告阶段注入异常——validation_runs必须转为FAILED，error_code/blocked_reasons记录REPORT阶段信息，且不得被误标为SUCCEEDED', { skip }, async () => {
  await withTxClient(async (client) => {
    const referenceCloseTime = Date.UTC(2026, 6, 17, 0, 0, 0) - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - FOUR_HOUR_MS + 1;
    const to = referenceCloseTime + 1;
    const datasetVersion = await buildVerifiedManifest(client, { from, to, replayNowMs });

    const faultyPool = makeFaultInjectingPool(client, 'INSERT INTO historical_validation.validation_reports');
    let capturedError;
    try {
      await runWalkForward({
        pool: faultyPool, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
        algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION,
        weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, dryRun: false,
        nowMs: Date.now(), replayNowMs
      });
      assert.fail('注入的异常必须导致runWalkForward()拒绝(reject)');
    } catch (error) {
      capturedError = error;
    }
    assert.equal(capturedError.code, 'INJECTED_FAULT');

    const runRow = (await client.query(
      `SELECT status, error_code, blocked_reasons, finished_at FROM historical_validation.validation_runs
       WHERE symbol='ETHUSDT' AND dataset_version=$1 ORDER BY created_at DESC LIMIT 1`,
      [datasetVersion]
    )).rows[0];
    assert.equal(runRow.status, 'FAILED', '报告阶段失败时validation_runs不得被误标为SUCCEEDED——即使生成/评估两个阶段本身都已经成功完成');
    assert.equal(runRow.blocked_reasons[0].phase, 'REPORT');
    assert.ok(runRow.finished_at, 'FAILED终态必须记录finished_at');
  });
});

test('P1-3：无异常的成功路径——validation_runs为SUCCEEDED，不产生任何blocked_reasons/error_code（对照组）', { skip }, async () => {
  await withTxClient(async (client) => {
    const referenceCloseTime = Date.UTC(2026, 6, 18, 0, 0, 0) - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - FOUR_HOUR_MS + 1;
    const to = referenceCloseTime + 1;
    const datasetVersion = await buildVerifiedManifest(client, { from, to, replayNowMs });

    const plan = await runWalkForward({
      pool: client, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
      algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION,
      weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, dryRun: false,
      nowMs: Date.now(), replayNowMs
    });

    const runRow = (await client.query('SELECT status, error_code, blocked_reasons FROM historical_validation.validation_runs WHERE validation_run_id=$1', [plan.validationRunId])).rows[0];
    assert.equal(runRow.status, 'SUCCEEDED');
    assert.equal(runRow.error_code, null, '成功路径不得残留任何error_code');
    assert.deepEqual(runRow.blocked_reasons, [], '成功路径不得产生任何blocked_reasons');
  });
});

test('P1-3：dry-run模式下生成阶段注入异常（P0-2修复后dry-run真实执行计算路径，同样需要失败治理）——validation_runs必须转为FAILED，不得被之前的实现遗留为提前标记的SUCCEEDED', { skip }, async () => {
  await withTxClient(async (client) => {
    const referenceCloseTime = Date.UTC(2026, 6, 19, 0, 0, 0) - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - FOUR_HOUR_MS + 1;
    const to = referenceCloseTime + 1;
    const datasetVersion = await buildVerifiedManifest(client, { from, to, replayNowMs });

    // dry-run生成阶段不会真的INSERT replay_snapshots（那是dryRun分支被跳过的部分），但仍会执行
    // findExactFeatureForReplay等只读查询——用feature_records的SELECT作为注入点，模拟"只读查询本身
    // 也可能因DB故障而抛出"的真实场景。
    const faultyPool = makeFaultInjectingPool(client, 'FROM feature_records');
    let capturedError;
    try {
      await runWalkForward({
        pool: faultyPool, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
        algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION,
        weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, dryRun: true,
        nowMs: Date.now(), replayNowMs
      });
      assert.fail('注入的异常必须导致runWalkForward()拒绝(reject)');
    } catch (error) {
      capturedError = error;
    }
    assert.equal(capturedError.code, 'INJECTED_FAULT');

    const runRow = (await client.query(
      `SELECT status, dry_run, error_code, blocked_reasons FROM historical_validation.validation_runs
       WHERE symbol='ETHUSDT' AND dataset_version=$1 ORDER BY created_at DESC LIMIT 1`,
      [datasetVersion]
    )).rows[0];
    assert.equal(runRow.dry_run, true);
    assert.equal(runRow.status, 'FAILED', 'dry-run场景下生成阶段异常同样必须转为FAILED，不得停留在RUNNING或被提前标记的SUCCEEDED掩盖');
    assert.equal(runRow.blocked_reasons[0].phase, 'GENERATION');
  });
});
