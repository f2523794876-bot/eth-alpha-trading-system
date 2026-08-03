// P0-1（独立复审）：真正的validation replay断点续跑——真实PostgreSQL验证。
// 证明：①resume时从首个未完成节奏点继续，不重复处理已完成的节奏点（不产生重复的generation_runs/
// replay_snapshots，也不对已完成点重新调用计算路径）；②中断恢复后的最终产出与"一次性不中断执行"
// 应该产生的产出一致（每个节奏点恰好一次生成尝试，not二次）；③resume所需状态不完整/不连续时fail closed；
// ④--resume参数不一致仍被拒绝（与断点续跑机制组合验证，非重复测试既有checkResumeParamConsistency逻辑本身）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest } from '../../src/validation-replay/dataset-manifest-builder.js';
import { generateReplaySnapshot } from '../../src/validation-replay/replay-generator.js';
import { evaluateReplayOutcomes } from '../../src/validation-replay/replay-evaluator.js';
import { runWalkForward, computeResumeCheckpoint, enumerateRhythmPoints } from '../../src/validation-replay/cli-entry.js';
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

async function seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime }) {
  await client.query(
    `INSERT INTO feature_sets(feature_set_version, algorithm_version, schema_version, definition, definition_hash)
     VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(feature_set_version) DO NOTHING`,
    [FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, 'v1.4b-schema-1', JSON.stringify({}), sha256({})]
  );
  const featureValues = {
    closeToEma5: 0, trend4h: 'down', trend1h: 'down', volumeRatio20: 1,
    swingHigh: 1100, swingLow: 900, breakoutState: null, upperWickRatio: 0.1, lowerWickRatio: 0.1,
    distanceToSupportAtr: 5, distanceToResistanceAtr: 5, falseBreakoutRisk: 'NONE',
    btcTrendState: 'flat', ethBtcRollingCorrelation: 0, logReturn1: 0
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

// 覆盖[windowFrom, windowTo)整个范围的连续15m K线（不留缺口）——manifest的完整性检查要求所在范围内
// market_bars按open_time连续，若两个相隔4小时的节奏点各自只孤立seed一根15m bar，中间的缺口会被判定为
// gapCount>0导致manifest构建被拒绝（REJECTED），故本测试对整个多节奏点窗口一次性铺满连续15m数据。
async function seedContiguous15mWindow(client, { windowFrom, windowTo, replayNowMs }) {
  const bars = [];
  for (let openTime = windowFrom; openTime < windowTo; openTime += FIFTEEN_MIN_MS) {
    bars.push(kline(openTime, openTime + FIFTEEN_MIN_MS - 1, '1000.00'));
  }
  const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
  await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: windowFrom, endTime: windowTo - 1, now: () => replayNowMs });
}

// 为一个24h horizon节奏点准备15根4H ATR bar+feature_record（15m referenceBar由
// seedContiguous15mWindow统一铺好），使generateReplaySnapshot在该点必然产出INSERTED
// （同 v1-4d-cli-entry.integration.test.js 既有手法）。
async function seedRhythmPoint(client, { referenceCloseTime, replayNowMs }) {
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

async function buildVerifiedManifest(client, { from, to }) {
  const result = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m', '4h'], from, to });
  assert.equal(result.status, 'SUCCEEDED', 'manifest构建必须成功（前置bar数据必须无缺口）');
  return result.datasetVersion;
}

async function insertRunningValidationRun(client, { validationRunId, datasetVersion, symbol, horizons, from, to, algorithmVersion, ruleVersion }) {
  await client.query(
    `INSERT INTO historical_validation.validation_runs(
       validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, dry_run, status, started_at
     ) VALUES($1,$2,$3,$4::jsonb,to_timestamp($5/1000.0),to_timestamp($6/1000.0),$7,$8,false,'RUNNING',now())`,
    [validationRunId, datasetVersion, symbol, JSON.stringify(horizons), from, to, algorithmVersion, ruleVersion]
  );
}

test('P0-1：resume从首个未完成节奏点继续——已完成点不重复生成，最终每点恰好一次生成尝试（与不中断执行等价）', { skip }, async () => {
  await withTxClient(async (client) => {
    const point1CloseTime = Date.UTC(2026, 5, 1, 0, 0, 0) - 1;
    const point2CloseTime = point1CloseTime + FOUR_HOUR_MS;
    const replayNowMs = Date.now();
    const from = point1CloseTime - FOUR_HOUR_MS + 1;
    const to = point2CloseTime + 1;
    await seedContiguous15mWindow(client, { windowFrom: from, windowTo: to, replayNowMs });
    await seedRhythmPoint(client, { referenceCloseTime: point1CloseTime, replayNowMs });
    await seedRhythmPoint(client, { referenceCloseTime: point2CloseTime, replayNowMs });

    const points = enumerateRhythmPoints({ from, to, horizon: '24h' });
    assert.deepEqual(points, [point1CloseTime, point2CloseTime], '前提核验：本测试窗口必须恰好枚举出这两个节奏点');

    const datasetVersion = await buildVerifiedManifest(client, { from, to });
    const validationRunId = randomUUID();
    await insertRunningValidationRun(client, { validationRunId, datasetVersion, symbol: 'ETHUSDT', horizons: ['24h'], from, to, algorithmVersion: ALGORITHM_VERSION, ruleVersion: RULE_VERSION });

    // 模拟"进程在完成第1个节奏点(point1)的生成+评估之后、开始第2个节奏点之前"崩溃——直接调用底层模块
    // （cli-entry.js的循环体在真实执行时会做的同样两步），不经过cli-entry.js的循环，人为制造"跑到一半"的状态。
    await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h', historicalAsOfTime: point1CloseTime, replayNowMs,
      algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION, datasetVersion, ruleVersion: RULE_VERSION, backfillBatchIds: []
    });
    await evaluateReplayOutcomes({ pool: client, validationRunId, evaluationVersion: EVALUATION_VERSION, historicalAsOfTime: point1CloseTime, replayNowMs });

    // 核验checkpoint计算：point1已完成，point2未完成——resumeFromIndex必须恰好为1。
    const checkpoint = await computeResumeCheckpoint({ pool: client, validationRunId, horizon: '24h', points });
    assert.equal(checkpoint.resumeFromIndex, 1, 'point1已完成(generation+evaluation均SUCCEEDED)，checkpoint必须跳过它');
    assert.equal(checkpoint.totalPoints, 2);

    const genCountBeforeResume = (await client.query(
      `SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1 AND historical_as_of_time=to_timestamp($2/1000.0)`,
      [validationRunId, point1CloseTime]
    )).rows[0].n;
    assert.equal(genCountBeforeResume, 1);

    // 真正执行resume——必须只处理point2，不得重新处理point1。
    const plan = await runWalkForward({
      pool: client, resumeValidationRunId: validationRunId, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
      algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION,
      weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, nowMs: Date.now(), replayNowMs
    });

    assert.equal(plan.resumeCheckpoints['24h'].resumeFromIndex, 1, 'runWalkForward内部使用的checkpoint必须与独立计算一致');
    // plan.results只应包含point2的处理记录，不应包含point1（未被重新处理）。
    const processedPoints = new Set(plan.results.filter(r => r.phase === 'generation').map(r => r.historicalAsOfTime));
    assert.deepEqual(processedPoints, new Set([point2CloseTime]), 'resume后的本次调用只应处理point2，point1不得被重新处理');

    // 中断恢复结果与一次性完整执行结果完全一致的核心证据：point1的generation_runs行数必须仍然恰好为1
    // （证明没有被重新计算/重新写入一次），point2的generation_runs行数也恰好为1（本次resume新处理一次）——
    // 两点合计"每点恰好一次生成尝试"，与假设从未中断、一次性完整执行两个点会产生的行数完全一致。
    const genCountPoint1After = (await client.query(
      `SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1 AND historical_as_of_time=to_timestamp($2/1000.0)`,
      [validationRunId, point1CloseTime]
    )).rows[0].n;
    const genCountPoint2After = (await client.query(
      `SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1 AND historical_as_of_time=to_timestamp($2/1000.0)`,
      [validationRunId, point2CloseTime]
    )).rows[0].n;
    assert.equal(genCountPoint1After, 1, 'point1的generation_runs行数必须保持为1——resume不得重新处理已完成的点');
    assert.equal(genCountPoint2After, 1, 'point2的generation_runs行数必须恰好为1——resume必须处理且只处理一次');

    const snapshotCount = (await client.query(
      `SELECT count(*)::int AS n FROM historical_validation.replay_snapshots s
       JOIN historical_validation.replay_generation_runs g ON g.generation_run_id=s.generation_run_id
       WHERE g.validation_run_id=$1`,
      [validationRunId]
    )).rows[0].n;
    assert.equal(snapshotCount, 2, '两个节奏点各产出恰好一条replay_snapshots，无重复、无缺失');

    // validation_runs必须在resume后正常终结为SUCCEEDED（非dry-run路径）。
    const runRow = (await client.query('SELECT status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(runRow.status, 'SUCCEEDED');
  });
});

test('P0-1：checkpoint状态不连续（更靠后的节奏点已完成，更早的节奏点未完成）——fail closed，不得猜测续跑边界', { skip }, async () => {
  await withTxClient(async (client) => {
    const point1CloseTime = Date.UTC(2026, 5, 2, 0, 0, 0) - 1;
    const point2CloseTime = point1CloseTime + FOUR_HOUR_MS;
    const replayNowMs = Date.now();
    const from = point1CloseTime - FOUR_HOUR_MS + 1;
    const to = point2CloseTime + 1;
    await seedContiguous15mWindow(client, { windowFrom: from, windowTo: to, replayNowMs }); // manifest需要gap-free覆盖
    await seedRhythmPoint(client, { referenceCloseTime: point2CloseTime, replayNowMs }); // 只为point2准备4h ATR/feature数据

    const points = enumerateRhythmPoints({ from, to, horizon: '24h' });
    const datasetVersion = await buildVerifiedManifest(client, { from, to });
    const validationRunId = randomUUID();
    await insertRunningValidationRun(client, { validationRunId, datasetVersion, symbol: 'ETHUSDT', horizons: ['24h'], from, to, algorithmVersion: ALGORITHM_VERSION, ruleVersion: RULE_VERSION });

    // 人为只完成point2（跳过point1）——真实单线程顺序执行不会产生这种状态，这里是构造"审计记录不连续"
    // 的异常场景，验证checkpoint计算发现后必须fail closed，而不是善意地猜测"从point1续跑"或"全部视为完成"。
    await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h', historicalAsOfTime: point2CloseTime, replayNowMs,
      algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION, datasetVersion, ruleVersion: RULE_VERSION, backfillBatchIds: []
    });
    await evaluateReplayOutcomes({ pool: client, validationRunId, evaluationVersion: EVALUATION_VERSION, historicalAsOfTime: point2CloseTime, replayNowMs });

    await assert.rejects(
      computeResumeCheckpoint({ pool: client, validationRunId, horizon: '24h', points }),
      (err) => err.code === 'RESUME_CHECKPOINT_INCONSISTENT'
    );

    await assert.rejects(
      runWalkForward({
        pool: client, resumeValidationRunId: validationRunId, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
        algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION,
        weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, nowMs: Date.now(), replayNowMs
      }),
      (err) => err.code === 'RESUME_CHECKPOINT_INCONSISTENT'
    );
  });
});

test('P0-1：--resume显式传入与原run不一致的参数（--to不同）——拒绝续跑，不得静默接受新参数', { skip }, async () => {
  await withTxClient(async (client) => {
    const point1CloseTime = Date.UTC(2026, 5, 3, 0, 0, 0) - 1;
    const replayNowMs = Date.now();
    const from = point1CloseTime - FOUR_HOUR_MS + 1;
    const to = point1CloseTime + 1;
    await seedContiguous15mWindow(client, { windowFrom: from, windowTo: to, replayNowMs });
    await seedRhythmPoint(client, { referenceCloseTime: point1CloseTime, replayNowMs });
    const datasetVersion = await buildVerifiedManifest(client, { from, to });
    const validationRunId = randomUUID();
    await insertRunningValidationRun(client, { validationRunId, datasetVersion, symbol: 'ETHUSDT', horizons: ['24h'], from, to, algorithmVersion: ALGORITHM_VERSION, ruleVersion: RULE_VERSION });

    const differentTo = to + FOUR_HOUR_MS;
    await assert.rejects(
      runWalkForward({
        pool: client, resumeValidationRunId: validationRunId, symbol: 'ETHUSDT', from, to: differentTo, horizons: ['24h'],
        algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION,
        weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, nowMs: Date.now(), replayNowMs
      }),
      (err) => err.code === 'RESUME_PARAM_MISMATCH'
    );

    const genCount = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1`, [validationRunId])).rows[0].n;
    assert.equal(genCount, 0, '参数不一致被拒绝后，不得产生任何额外的业务写入');
  });
});
