// R15.1/R15.2/R15.3：replay_snapshots的calibrated_probabilities/brier_score_component/
// target_state_at_generation/fusion_state_at_generation必须在数据库层被CHECK约束拒绝，不能只在
// JavaScript应用层验证（此前的测试只覆盖了"写NULL/写'UNKNOWN'成功"这一正向路径，从未真正尝试过
// 违规INSERT去证明数据库真的会拒绝）。每个测试都断言SQLSTATE=23514（check_violation）与具体的
// CHECK约束名，并在拒绝后确认没有任何违规行残留。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest } from '../../src/validation-replay/dataset-manifest-builder.js';

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(TEST_DATABASE_URL);
const FIFTEEN_MIN_MS = 900000;

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

// 构造一份满足除本次故意违反的CHECK之外全部其他CHECK/NOT NULL/FK约束的合法基线行，供
// R15.1/R15.2/R15.3三处红线各自单独违反一次字段。所有CHECK约束的推导均来自migration
// 005_v1_4d_historical_validation_schema.up.sql的replay_snapshots定义原文。
async function insertBaselineDependencies(client, { base }) {
  const from = base, to = base + FIFTEEN_MIN_MS;
  const adapter = makeMockAdapter({ pages: [[kline(from, to - 1)]], serverTimeMs: to + 60000 });
  await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: from, endTime: from, now: () => to + 60000 });
  const manifest = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from, to });
  assert.equal(manifest.status, 'SUCCEEDED');

  const validationRunId = randomUUID();
  await client.query(
    `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
     VALUES($1,$2,'ETH','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),'algo-v1','rule-v1','RUNNING',now())`,
    [validationRunId, manifest.datasetVersion, from, to]
  );
  const generationRunId = randomUUID();
  await client.query(
    `INSERT INTO historical_validation.replay_generation_runs(generation_run_id,validation_run_id,instrument,horizon,historical_as_of_time,status,started_at,finished_at)
     VALUES($1,$2,'ETHUSDT','24h',to_timestamp($3/1000.0),'SUCCEEDED',now(),now())`,
    [generationRunId, validationRunId, base]
  );
  return { datasetVersion: manifest.datasetVersion, generationRunId };
}

const REPLAY_SNAPSHOT_COLUMNS = [
  'prediction_id', 'generation_run_id', 'backfill_batch_id', 'dataset_version', 'instrument', 'horizon',
  'generated_at', 'data_cutoff_time', 'target_start_time', 'target_end_time', 'reference_price', 'reference_bar_ref',
  'target_bar_ref', 'expected_bar_count', 'expected_direction', 'direction_threshold', 'raw_threshold',
  'threshold_floor', 'threshold_ceiling', 'threshold_formula_version', 'atr14_four_hour_at_generation',
  'target_state_at_generation', 'proxy_state_at_generation', 'fusion_state_at_generation', 'candidate_trajectories',
  'scenario_weight_baseline', 'scenario_weight_upside', 'scenario_weight_downside', 'probability_status',
  'calibrated_probabilities', 'brier_score_component', 'expected_price_zones', 'trigger_conditions',
  'invalidation_conditions', 'algorithm_version', 'weight_version', 'rule_version', 'data_vintage_refs',
  'feature_values_used', 'feature_record_ids', 'feature_engine_version', 'content_hash', 'auxiliary_evidence',
  'historical_as_of_time', 'research_data_vintage', 'research_availability_rule_version', 'source_origin'
];

function buildBaselineValues({ base, datasetVersion, generationRunId, predictionId }) {
  const targetStart = base;
  const targetEnd = targetStart + 96 * FIFTEEN_MIN_MS;
  return {
    prediction_id: predictionId, generation_run_id: generationRunId, backfill_batch_id: null,
    dataset_version: datasetVersion, instrument: 'ETHUSDT', horizon: '24h',
    generated_at: new Date(base), data_cutoff_time: new Date(base), target_start_time: new Date(targetStart), target_end_time: new Date(targetEnd),
    reference_price: 1000, reference_bar_ref: { symbol: 'ETHUSDT', closeTime: base }, target_bar_ref: null,
    expected_bar_count: 96, expected_direction: null, direction_threshold: 0.02, raw_threshold: 0.02,
    threshold_floor: 0.008, threshold_ceiling: 0.05, threshold_formula_version: 'v1', atr14_four_hour_at_generation: 10,
    target_state_at_generation: 'UNKNOWN', proxy_state_at_generation: 'PO_UNKNOWN', fusion_state_at_generation: 'UNKNOWN',
    candidate_trajectories: {}, scenario_weight_baseline: 34, scenario_weight_upside: 33, scenario_weight_downside: 33,
    probability_status: 'rule_based', calibrated_probabilities: null, brier_score_component: null,
    expected_price_zones: {}, trigger_conditions: {}, invalidation_conditions: {},
    algorithm_version: 'algo-v1', weight_version: 'weight-v1', rule_version: 'rule-v1',
    data_vintage_refs: [], feature_values_used: {}, feature_record_ids: [], feature_engine_version: 'fe-v1',
    content_hash: 'a'.repeat(64), auxiliary_evidence: {},
    historical_as_of_time: new Date(base), research_data_vintage: {}, research_availability_rule_version: 'v1.4d-research-availability-1',
    source_origin: 'HISTORICAL_REPLAY'
  };
}

const JSONB_COLUMNS = new Set([
  'reference_bar_ref', 'target_bar_ref', 'candidate_trajectories', 'calibrated_probabilities',
  'expected_price_zones', 'trigger_conditions', 'invalidation_conditions', 'data_vintage_refs',
  'feature_values_used', 'feature_record_ids', 'auxiliary_evidence', 'research_data_vintage'
]);
const TIMESTAMP_COLUMNS = new Set(['generated_at', 'data_cutoff_time', 'target_start_time', 'target_end_time', 'historical_as_of_time']);

async function attemptInsert(client, valuesObj) {
  const placeholders = REPLAY_SNAPSHOT_COLUMNS.map((col, i) => {
    const idx = i + 1;
    if (JSONB_COLUMNS.has(col)) return `$${idx}::jsonb`;
    if (TIMESTAMP_COLUMNS.has(col)) return `$${idx}`;
    return `$${idx}`;
  }).join(',');
  const params = REPLAY_SNAPSHOT_COLUMNS.map(col => {
    const v = valuesObj[col];
    if (JSONB_COLUMNS.has(col)) return v === null ? null : JSON.stringify(v);
    return v;
  });
  return client.query(
    `INSERT INTO historical_validation.replay_snapshots(${REPLAY_SNAPSHOT_COLUMNS.join(',')}) VALUES(${placeholders})`,
    params
  );
}

// PostgreSQL在一次INSERT触发CHECK违规后会把当前事务标记为aborted，同一事务内后续任何语句
// （包括"确认无残留行"的核验查询）都会失败——用SAVEPOINT包裹违规INSERT尝试，失败后
// ROLLBACK TO SAVEPOINT把事务恢复到可继续使用的状态，同时仍然完整保留PostgreSQL抛出的
// 原始错误（code/message）供上层assert.rejects断言。
async function attemptInsertExpectingRejection(client, valuesObj) {
  await client.query('SAVEPOINT check_violation_probe');
  try {
    await attemptInsert(client, valuesObj);
    throw new Error('expected INSERT to be rejected by a CHECK constraint, but it succeeded');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT check_violation_probe');
    throw error;
  } finally {
    await client.query('RELEASE SAVEPOINT check_violation_probe');
  }
}

test('R15.1：replay_snapshots.calibrated_probabilities写入非NULL值必须被数据库CHECK约束拒绝（SQLSTATE 23514）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 6, 20, 0, 0, 0);
    const { datasetVersion, generationRunId } = await insertBaselineDependencies(client, { base });

    // 前提确认：完全合法的基线行（calibrated_probabilities=null）必须能正常插入——证明后续插入失败
    // 确实是calibrated_probabilities这一项CHECK导致的，而不是基线行本身构造有误。
    const baselineOk = buildBaselineValues({ base, datasetVersion, generationRunId, predictionId: `R15.1-baseline-${randomUUID()}` });
    await attemptInsert(client, baselineOk);

    const violating = buildBaselineValues({ base, datasetVersion, generationRunId, predictionId: `R15.1-violation-${randomUUID()}` });
    violating.calibrated_probabilities = { baseline: 0.5, upside: 0.3, downside: 0.2 };
    await assert.rejects(
      attemptInsertExpectingRejection(client, violating),
      (e) => {
        assert.equal(e.code, '23514', 'PostgreSQL SQLSTATE必须精确为23514（check_violation）');
        assert.match(e.message, /calibrated_probabilities/, '错误信息必须点名calibrated_probabilities对应的CHECK约束');
        return true;
      }
    );

    const residual = (await client.query(
      `SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE calibrated_probabilities IS NOT NULL`
    )).rows[0].n;
    assert.equal(residual, 0, '拒绝后不得有任何calibrated_probabilities非NULL的行残留');
  });
});

test('R15.2：replay_snapshots.brier_score_component写入非NULL值必须被数据库CHECK约束拒绝（SQLSTATE 23514）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 6, 21, 0, 0, 0);
    const { datasetVersion, generationRunId } = await insertBaselineDependencies(client, { base });

    const baselineOk = buildBaselineValues({ base, datasetVersion, generationRunId, predictionId: `R15.2-baseline-${randomUUID()}` });
    await attemptInsert(client, baselineOk);

    const violating = buildBaselineValues({ base, datasetVersion, generationRunId, predictionId: `R15.2-violation-${randomUUID()}` });
    violating.brier_score_component = 0.123;
    await assert.rejects(
      attemptInsertExpectingRejection(client, violating),
      (e) => {
        assert.equal(e.code, '23514');
        assert.match(e.message, /brier_score_component/);
        return true;
      }
    );

    const residual = (await client.query(
      `SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE brier_score_component IS NOT NULL`
    )).rows[0].n;
    assert.equal(residual, 0, '拒绝后不得有任何brier_score_component非NULL的行残留');
  });
});

test('R15.3：replay_snapshots.target_state_at_generation写入非UNKNOWN值必须被数据库CHECK约束拒绝（SQLSTATE 23514）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 6, 22, 0, 0, 0);
    const { datasetVersion, generationRunId } = await insertBaselineDependencies(client, { base });

    const baselineOk = buildBaselineValues({ base, datasetVersion, generationRunId, predictionId: `R15.3a-baseline-${randomUUID()}` });
    await attemptInsert(client, baselineOk);

    const violating = buildBaselineValues({ base, datasetVersion, generationRunId, predictionId: `R15.3a-violation-${randomUUID()}` });
    violating.target_state_at_generation = 'PO_TREND_UP_STRUCTURE';
    await assert.rejects(
      attemptInsertExpectingRejection(client, violating),
      (e) => {
        assert.equal(e.code, '23514');
        assert.match(e.message, /target_state_at_generation/);
        return true;
      }
    );

    const residual = (await client.query(
      `SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE target_state_at_generation <> 'UNKNOWN'`
    )).rows[0].n;
    assert.equal(residual, 0);
  });
});

test('R15.3：replay_snapshots.fusion_state_at_generation写入非UNKNOWN值必须被数据库CHECK约束拒绝（SQLSTATE 23514）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 6, 23, 0, 0, 0);
    const { datasetVersion, generationRunId } = await insertBaselineDependencies(client, { base });

    const baselineOk = buildBaselineValues({ base, datasetVersion, generationRunId, predictionId: `R15.3b-baseline-${randomUUID()}` });
    await attemptInsert(client, baselineOk);

    const violating = buildBaselineValues({ base, datasetVersion, generationRunId, predictionId: `R15.3b-violation-${randomUUID()}` });
    violating.fusion_state_at_generation = 'PO_TREND_DOWN_STRUCTURE';
    await assert.rejects(
      attemptInsertExpectingRejection(client, violating),
      (e) => {
        assert.equal(e.code, '23514');
        assert.match(e.message, /fusion_state_at_generation/);
        return true;
      }
    );

    const residual = (await client.query(
      `SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE fusion_state_at_generation <> 'UNKNOWN'`
    )).rows[0].n;
    assert.equal(residual, 0);
  });
});
