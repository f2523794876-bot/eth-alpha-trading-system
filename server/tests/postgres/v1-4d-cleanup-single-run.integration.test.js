// §三.1/P1-1（独立复审）：cleanup-single-run.js 事务保护真实PostgreSQL验证——
// 六步删除必须在同一client/同一事务内执行（显式BEGIN/COMMIT/失败ROLLBACK），client必须安全释放，
// 不扩大清理范围，dataset_manifests永久保留，对跨run共享/FK限制失败给出明确可诊断错误且不留半清理状态。
//
// 与其余V1.4D postgres集成测试的"单client+外层BEGIN/ROLLBACK"约定不同——本模块被测函数自己管理
// 独立的client生命周期（pool.connect()/BEGIN/COMMIT或ROLLBACK/release()），若测试仍用外层事务包裹，
// cleanupSingleRun内部另开的连接看不到外层事务里尚未提交的数据（不同session之间不可见未提交数据）。
// 因此本文件改用真实Pool（数据全部真实commit），每个测试用例结束后在finally里显式清理自己写入的行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { generateReplaySnapshot } from '../../src/validation-replay/replay-generator.js';
import { evaluateReplayOutcomes } from '../../src/validation-replay/replay-evaluator.js';
import { buildValidationReports as buildValidationReportsImpl } from '../../src/validation-replay/report-builder.js';
import { cleanupSingleRun } from '../../src/validation-replay/cleanup-single-run.js';
import { RESEARCH_AVAILABILITY_RULE_VERSION } from '../../src/validation-replay/research-availability.js';

const buildValidationReports = args => buildValidationReportsImpl({
  ...args,
  authenticitySummary: {
    schema_version: 'v1.4d-rerun-authenticity/1', mode: 'resume', expected_count: 1,
    attempted_count: 1, inserted_count: 1, reused_identical_count: 0,
    conflict_count: 0, blocked_count: 0, evaluated_count: 1, gate_status: 'PASSED'
  }
});
import { FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION } from '../../src/features/feature-version.js';
import { sha256 } from '../../src/domain/hash.js';

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(TEST_DATABASE_URL);
const FOUR_HOUR_MS = 14400000;
const FIFTEEN_MIN_MS = 900000;
const DAY_MS = 86400000;

const ALGORITHM_VERSION = 'v1.4c-server-po-rule-1';
const WEIGHT_VERSION = 'v1.4c-server-weight-1';
const DATASET_VERSION = 'v1.4d-sha256-' + '44'.repeat(32);
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

async function ensureManifest(pool, { from, to }) {
  await pool.query(
    `INSERT INTO historical_validation.dataset_manifests(
       dataset_version, manifest_schema_version, manifest_hash_algorithm_version, manifest_contract_version, dataset_type, symbol, intervals, data_from, data_to,
       backfill_batch_ids, source_formal_semantics, research_availability_rule_version, record_count, per_interval_record_count,
       integrity_check_result, manifest_members
     ) VALUES($1,'v1.4d-manifest-schema-1','v1.4d-manifest-hash-1',1,'MARKET_BARS','ETHUSDT','["15m","4h"]'::jsonb,to_timestamp($2/1000.0),to_timestamp($3/1000.0),
       '[]'::jsonb,'market_bars:formal:spot',$4,0,'{}'::jsonb,'{"gapCount":0,"duplicateCount":0,"outOfOrderCount":0}'::jsonb,'[]'::jsonb)
     ON CONFLICT(dataset_version) DO NOTHING`,
    [DATASET_VERSION, from, to, RESEARCH_AVAILABILITY_RULE_VERSION]
  );
}
async function seedValidationRun(pool, { validationRunId, from, to }) {
  await pool.query(
    `INSERT INTO historical_validation.validation_runs(
       validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at
     ) VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
    [validationRunId, DATASET_VERSION, from, to, ALGORITHM_VERSION, RULE_VERSION]
  );
}
async function seedFourHourAtrBars(pool, { referenceCloseTime, count = 15, replayNowMs }) {
  const bars = [];
  for (let i = count - 1; i >= 0; i--) {
    const closeTime = referenceCloseTime - i * FOUR_HOUR_MS;
    bars.push(kline(closeTime - FOUR_HOUR_MS + 1, closeTime, (1000 + i).toFixed(2)));
  }
  const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
  const start = referenceCloseTime - (count - 1) * FOUR_HOUR_MS - FOUR_HOUR_MS + 1;
  await backfillInterval({ pool, adapter, symbol: 'ETHUSDT', interval: '4h', startTime: start, endTime: referenceCloseTime, now: () => replayNowMs });
}
async function seedReferenceBar(pool, { openTime, closeTime, replayNowMs }) {
  const adapter = makeMockAdapter({ pages: [[kline(openTime, closeTime, '1000.00')]], serverTimeMs: replayNowMs });
  await backfillInterval({ pool, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime, now: () => replayNowMs });
}
async function seedFeatureRecord(pool, { referenceCloseTime, historicalAsOfTime }) {
  await pool.query(
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
  await pool.query(
    `INSERT INTO feature_records(
       feature_id, symbol, target_interval, target_bar_open_time, target_bar_close_time, as_of_time, generated_at,
       feature_set_version, algorithm_version, source_dataset_version, completeness, quality_state, feature_values, availability, content_hash
     ) VALUES($1,'ETHUSDT','15m',to_timestamp($2/1000.0),to_timestamp($3/1000.0),to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6,$7,$8,1,'HEALTHY',$9::jsonb,'{}'::jsonb,$10)
     ON CONFLICT DO NOTHING`,
    [
      `feature-${referenceCloseTime}`, referenceCloseTime - FIFTEEN_MIN_MS + 1, referenceCloseTime, historicalAsOfTime, historicalAsOfTime,
      FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION, JSON.stringify(featureValues), sha256(featureValues)
    ]
  );
}
async function seedRhythmPoint(pool, { dayOffset, replayNowMs }) {
  const dayStart = Date.UTC(2026, 5, 1 + dayOffset, 0, 0, 0);
  const referenceCloseTime = dayStart - 1;
  const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
  await seedReferenceBar(pool, { openTime: referenceOpenTime, closeTime: referenceCloseTime, replayNowMs });
  await seedFourHourAtrBars(pool, { referenceCloseTime, count: 15, replayNowMs });
  await seedFeatureRecord(pool, { referenceCloseTime, historicalAsOfTime: referenceCloseTime });
  return { referenceCloseTime };
}
async function seedFullPath(pool, { referenceCloseTime, replayNowMs }) {
  const pathStart = referenceCloseTime + 1;
  const bars = [];
  for (let i = 0; i < 96; i++) { const o = pathStart + i * FIFTEEN_MIN_MS; bars.push(kline(o, o + FIFTEEN_MIN_MS - 1, '1000.00')); }
  const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
  await backfillInterval({ pool, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: pathStart, endTime: pathStart + 96 * FIFTEEN_MIN_MS, now: () => replayNowMs });
}

// 两个run之间可能存在共享/交叉FK引用（如某个run的outcome_event引用了另一个run"拥有"的snapshot，
// 见"共享/冲突引用"测试场景）——按表分阶段、跨全部validationRunIds一次性清空，而不是逐个run从头删到尾，
// 避免清理顺序本身在测试收尾阶段又触发一次FK RESTRICT。
async function purgeAllRunData(pool, validationRunIds) {
  if (!validationRunIds.length) return;
  await pool.query(`DELETE FROM historical_validation.replay_outcome_events WHERE evaluation_run_id IN (SELECT evaluation_run_id FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=ANY($1::uuid[]))`, [validationRunIds]);
  await pool.query(`DELETE FROM historical_validation.replay_snapshots WHERE generation_run_id IN (SELECT generation_run_id FROM historical_validation.replay_generation_runs WHERE validation_run_id=ANY($1::uuid[]))`, [validationRunIds]);
  await pool.query(`DELETE FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=ANY($1::uuid[])`, [validationRunIds]);
  await pool.query(`DELETE FROM historical_validation.replay_generation_runs WHERE validation_run_id=ANY($1::uuid[])`, [validationRunIds]);
  await pool.query(`DELETE FROM historical_validation.validation_reports WHERE validation_run_id=ANY($1::uuid[])`, [validationRunIds]);
  await pool.query(`DELETE FROM historical_validation.validation_runs WHERE validation_run_id=ANY($1::uuid[])`, [validationRunIds]);
}
async function purgeMarketData(pool, { fromOffset, toOffsetExclusive }) {
  const from = Date.UTC(2026, 5, 1 + fromOffset, 0, 0, 0) - DAY_MS;
  const to = Date.UTC(2026, 5, 1 + toOffsetExclusive, 0, 0, 0) + DAY_MS;
  await pool.query(`DELETE FROM feature_records WHERE symbol='ETHUSDT' AND target_bar_close_time>=to_timestamp($1/1000.0) AND target_bar_close_time<to_timestamp($2/1000.0)`, [from, to]);
  await pool.query(`DELETE FROM market_bars WHERE instrument='ETHUSDT' AND open_time>=to_timestamp($1/1000.0) AND open_time<to_timestamp($2/1000.0)`, [from, to]);
}

// 包装一个真实、专用（max:1、与realPool完全隔离）的Pool：.connect()返回的client在第N次.query()调用时
// 抛出模拟错误，其余调用原样转发给真实client；用于验证cleanupSingleRun在六步删除执行到中途失败时，
// 是否对已成功的前几步也执行了完整ROLLBACK。
//
// 必须使用专用Pool而非复用realPool——client.query被本函数整体替换为只接受(sql,params)两个参数的版本，
// 若这个被替换过的client实例经client.release()被交还给一个后续还会被共享使用的Pool（如realPool），
// pg.Pool内部对幂等复用的client发起下一次查询时会以client.query(text, values, callback)三参数形式调用
// （用于感知查询完成、决定何时可以把client重新标记为idle），而本函数替换后的两参数版本会静默丢弃第三个
// callback参数——originalQuery仍会真正执行SQL并拿到结果，但因为callback从未被调用，Pool内部据以对外层
// pool.query()返回的Promise永远不会resolve/reject，导致该连接从此在共享池中永久挂起（表现为：Postgres
// 侧该查询早已正常完成，进程CPU占用为0，但调用方await永远卡住）。用专用single-connection Pool规避这个
// 问题——被污染的client实例仅存在于这个用完即弃的专用Pool内，不会被任何其他测试或后续查询复用。
function wrapPoolFailingAtCall(connectionString, failAtCallIndex) {
  const dedicatedPool = new Pool({ connectionString, max: 1 });
  return {
    async connect() {
      const client = await dedicatedPool.connect();
      let callCount = 0;
      const originalQuery = client.query.bind(client);
      client.query = async (sql, params) => {
        callCount += 1;
        if (callCount === failAtCallIndex) {
          throw Object.assign(new Error('SIMULATED_MID_TRANSACTION_FAILURE'), { code: 'SIMULATED_FAILURE' });
        }
        return originalQuery(sql, params);
      };
      return client;
    },
    async _endDedicatedPool() { await dedicatedPool.end(); }
  };
}

test('正常清理成功并提交：按冻结顺序删除单run全部关联数据，不影响market_bars/feature_records/dataset_manifests/其他run，且真实COMMIT（跨连接可见）', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const runA = randomUUID();
  const runB = randomUUID();
  const dayA = 1, dayB = 2;
  try {
    const from = Date.UTC(2026, 5, 1) - DAY_MS;
    const to = Date.UTC(2026, 5, 10);
    await ensureManifest(pool, { from, to });
    await seedValidationRun(pool, { validationRunId: runA, from, to });
    await seedValidationRun(pool, { validationRunId: runB, from, to });

    const replayNowMs = Date.now();
    const { referenceCloseTime: refA } = await seedRhythmPoint(pool, { dayOffset: dayA, replayNowMs });
    const { referenceCloseTime: refB } = await seedRhythmPoint(pool, { dayOffset: dayB, replayNowMs });

    const genA = await generateReplaySnapshot({
      pool, validationRunId: runA, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: refA, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    const genB = await generateReplaySnapshot({
      pool, validationRunId: runB, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: refB, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(genA.status, 'INSERTED');
    assert.equal(genB.status, 'INSERTED');

    await seedFullPath(pool, { referenceCloseTime: refA, replayNowMs });
    const evalAsOfTimeA = refA + 96 * FIFTEEN_MIN_MS + 3600000;
    await evaluateReplayOutcomes({ pool, validationRunId: runA, evaluationVersion: EVALUATION_VERSION, historicalAsOfTime: evalAsOfTimeA, replayNowMs });

    await buildValidationReports({
      pool, validationRunId: runA, datasetVersion: DATASET_VERSION, algorithmVersion: ALGORITHM_VERSION,
      ruleVersion: RULE_VERSION, researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion: EVALUATION_VERSION
    });
    await buildValidationReports({
      pool, validationRunId: runB, datasetVersion: DATASET_VERSION, algorithmVersion: ALGORITHM_VERSION,
      ruleVersion: RULE_VERSION, researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion: EVALUATION_VERSION
    });

    const before = {
      marketBars: (await pool.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n,
      featureRecords: (await pool.query('SELECT count(*)::int AS n FROM feature_records')).rows[0].n,
      datasetManifests: (await pool.query('SELECT count(*)::int AS n FROM historical_validation.dataset_manifests')).rows[0].n,
      runBSnapshots: (await pool.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE prediction_id=$1', [genB.record.predictionId])).rows[0].n
    };
    assert.equal(before.runBSnapshots, 1);

    const result = await cleanupSingleRun(pool, { validationRunId: runA });
    assert.equal(result.status, 'DELETED');
    assert.equal(result.validationRunDeleted, true);

    // 用一个全新的、独立的连接重新查询——证明cleanupSingleRun确实COMMIT了（不是仍留在某个未提交的会话里）。
    const freshClient = await pool.connect();
    try {
      const after = {
        marketBars: (await freshClient.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n,
        featureRecords: (await freshClient.query('SELECT count(*)::int AS n FROM feature_records')).rows[0].n,
        datasetManifests: (await freshClient.query('SELECT count(*)::int AS n FROM historical_validation.dataset_manifests')).rows[0].n,
        runBSnapshots: (await freshClient.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE prediction_id=$1', [genB.record.predictionId])).rows[0].n
      };
      assert.deepEqual(after, before, 'market_bars/feature_records/dataset_manifests行数与runB的数据必须逐项不变（目标run之外的数据不受影响）');

      const manifestRow = (await freshClient.query('SELECT dataset_version FROM historical_validation.dataset_manifests WHERE dataset_version=$1', [DATASET_VERSION])).rows[0];
      assert.ok(manifestRow, 'dataset_manifests对应行必须仍然存在（永久保留，不随任何validation_run清理被删除）');

      const runAResidual = {
        validationRuns: (await freshClient.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs WHERE validation_run_id=$1', [runA])).rows[0].n,
        generationRuns: (await freshClient.query('SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1', [runA])).rows[0].n,
        evaluationRuns: (await freshClient.query('SELECT count(*)::int AS n FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1', [runA])).rows[0].n,
        snapshots: (await freshClient.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE prediction_id=$1', [genA.record.predictionId])).rows[0].n,
        outcomeEvents: (await freshClient.query('SELECT count(*)::int AS n FROM historical_validation.replay_outcome_events WHERE prediction_id=$1', [genA.record.predictionId])).rows[0].n,
        reports: (await freshClient.query('SELECT count(*)::int AS n FROM historical_validation.validation_reports WHERE validation_run_id=$1', [runA])).rows[0].n
      };
      for (const [key, value] of Object.entries(runAResidual)) assert.equal(value, 0, `${key} 必须清零`);

      const runBIntact = (await freshClient.query('SELECT status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [runB])).rows[0];
      assert.ok(runBIntact, 'runB的validation_runs行必须完好保留');
    } finally {
      freshClient.release();
    }
  } finally {
    await purgeAllRunData(pool, [runA, runB]);
    await purgeMarketData(pool, { fromOffset: dayA, toOffsetExclusive: dayB + 1 });
    await pool.end();
  }
});

test('中途删除失败后完整回滚：第三次DELETE（replay_evaluation_runs）人为失败时，前两步已执行的删除必须被整体撤销', { skip }, async () => {
  const realPool = new Pool({ connectionString: TEST_DATABASE_URL });
  const runA = randomUUID();
  const dayOffset = 3;
  try {
    const from = Date.UTC(2026, 5, 1) - DAY_MS;
    const to = Date.UTC(2026, 5, 10);
    await ensureManifest(realPool, { from, to });
    await seedValidationRun(realPool, { validationRunId: runA, from, to });

    const replayNowMs = Date.now();
    const { referenceCloseTime: ref } = await seedRhythmPoint(realPool, { dayOffset, replayNowMs });
    const gen = await generateReplaySnapshot({
      pool: realPool, validationRunId: runA, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: ref, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(gen.status, 'INSERTED');
    await seedFullPath(realPool, { referenceCloseTime: ref, replayNowMs });
    const evalAsOfTime = ref + 96 * FIFTEEN_MIN_MS + 3600000;
    await evaluateReplayOutcomes({ pool: realPool, validationRunId: runA, evaluationVersion: EVALUATION_VERSION, historicalAsOfTime: evalAsOfTime, replayNowMs });

    // 调用序列：1=BEGIN, 2=DELETE outcome_events, 3=DELETE snapshots, 4=DELETE evaluation_runs(人为失败点), ...
    const failingPool = wrapPoolFailingAtCall(TEST_DATABASE_URL, 4);
    try {
      await assert.rejects(
        cleanupSingleRun(failingPool, { validationRunId: runA }),
        (err) => err.code === 'CLEANUP_FAILED' && /SIMULATED_MID_TRANSACTION_FAILURE/.test(err.message)
      );
    } finally {
      await failingPool._endDedicatedPool();
    }

    const residual = {
      outcomeEvents: (await realPool.query('SELECT count(*)::int AS n FROM historical_validation.replay_outcome_events WHERE prediction_id=$1', [gen.record.predictionId])).rows[0].n,
      snapshots: (await realPool.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE prediction_id=$1', [gen.record.predictionId])).rows[0].n,
      evaluationRuns: (await realPool.query('SELECT count(*)::int AS n FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1', [runA])).rows[0].n,
      generationRuns: (await realPool.query('SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1', [runA])).rows[0].n,
      validationRun: (await realPool.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs WHERE validation_run_id=$1', [runA])).rows[0].n
    };
    assert.equal(residual.outcomeEvents, 1, 'step1(outcome_events)删除必须被回滚——数据必须仍然存在');
    assert.equal(residual.snapshots, 1, 'step2(snapshots)删除必须被回滚——数据必须仍然存在');
    assert.equal(residual.evaluationRuns, 1, '失败步骤本身之前的状态必须完整保留');
    assert.equal(residual.generationRuns, 1);
    assert.equal(residual.validationRun, 1, 'validation_runs行必须完整保留（未被删除，也未处于半清理状态）');
  } finally {
    await purgeAllRunData(realPool, [runA]);
    await purgeMarketData(realPool, { fromOffset: dayOffset, toOffsetExclusive: dayOffset + 1 });
    await realPool.end();
  }
});

test('两个run存在共享/冲突引用时，不产生半清理：FK RESTRICT失败必须给出明确可诊断错误且完整回滚', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const runA = randomUUID();
  const runB = randomUUID();
  const dayOffset = 5;
  try {
    const from = Date.UTC(2026, 5, 1) - DAY_MS;
    const to = Date.UTC(2026, 5, 10);
    await ensureManifest(pool, { from, to });
    await seedValidationRun(pool, { validationRunId: runA, from, to });
    await seedValidationRun(pool, { validationRunId: runB, from, to });

    const replayNowMs = Date.now();
    const { referenceCloseTime: ref } = await seedRhythmPoint(pool, { dayOffset, replayNowMs });

    // runA首先生成该快照——快照的generation_run_id归属runA（先到先得，ON CONFLICT DO NOTHING）。
    const genA = await generateReplaySnapshot({
      pool, validationRunId: runA, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: ref, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(genA.status, 'INSERTED');

    // runB对同一逻辑预测重复尝试生成——按§一冻结规则3天然去重(DEDUPED)，快照本身仍只属于runA的generation_run。
    const genB = await generateReplaySnapshot({
      pool, validationRunId: runB, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: ref, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(genB.status, 'REUSED_IDENTICAL');
    assert.equal(genB.record.prediction_id, genA.record.predictionId);

    // runB评估：命中同一条(被runA拥有的)快照，产出属于runB自己evaluation_run的outcome_event，
    // 但该行通过FK引用 replay_snapshots(prediction_id, research_availability_rule_version)。
    await seedFullPath(pool, { referenceCloseTime: ref, replayNowMs });
    const evalAsOfTime = ref + 96 * FIFTEEN_MIN_MS + 3600000;
    const evalB = await evaluateReplayOutcomes({ pool, validationRunId: runB, evaluationVersion: EVALUATION_VERSION, historicalAsOfTime: evalAsOfTime, replayNowMs });
    assert.equal(evalB.evaluated, 1);

    const before = {
      genARow: (await pool.query('SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1', [runA])).rows[0].n,
      snapshot: (await pool.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE prediction_id=$1', [genA.record.predictionId])).rows[0].n,
      runBOutcome: (await pool.query('SELECT count(*)::int AS n FROM historical_validation.replay_outcome_events WHERE prediction_id=$1', [genA.record.predictionId])).rows[0].n
    };
    assert.deepEqual(before, { genARow: 1, snapshot: 1, runBOutcome: 1 });

    // 清理runA：step1(删runA自己的outcome_events)对runA是no-op(runA从未评估过)；
    // step2尝试删除该快照时，被runB仍存在的outcome_event通过FK RESTRICT拦截——必须fail closed、完整回滚、错误可诊断。
    await assert.rejects(
      cleanupSingleRun(pool, { validationRunId: runA }),
      (err) => err.code === 'CLEANUP_BLOCKED_BY_SHARED_REFERENCE' && err.pgErrorCode === '23503' && err.validationRunId === runA
    );

    const after = {
      genARow: (await pool.query('SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1', [runA])).rows[0].n,
      snapshot: (await pool.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE prediction_id=$1', [genA.record.predictionId])).rows[0].n,
      runBOutcome: (await pool.query('SELECT count(*)::int AS n FROM historical_validation.replay_outcome_events WHERE prediction_id=$1', [genA.record.predictionId])).rows[0].n,
      runARow: (await pool.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs WHERE validation_run_id=$1', [runA])).rows[0].n,
      runBRow: (await pool.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs WHERE validation_run_id=$1', [runB])).rows[0].n
    };
    assert.deepEqual(after, { genARow: 1, snapshot: 1, runBOutcome: 1, runARow: 1, runBRow: 1 }, '冲突失败后不得产生任何半清理状态——runA与runB全部数据必须逐项保持不变');
  } finally {
    await purgeAllRunData(pool, [runA, runB]);
    await purgeMarketData(pool, { fromOffset: dayOffset, toOffsetExclusive: dayOffset + 1 });
    await pool.end();
  }
});
