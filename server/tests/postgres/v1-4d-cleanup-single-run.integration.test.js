// §三.1/V1_4D_CODEX_IMPLEMENTATION_TASK.md任务10：cleanup-single-run.js真实PostgreSQL验证——
// 按冻结顺序删除单个validation_run全部关联数据，public.market_bars/feature_records行数不变，
// dataset_manifests/backfill_batches不受影响，且不影响其他validation_run的数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { generateReplaySnapshot } from '../../src/validation-replay/replay-generator.js';
import { evaluateReplayOutcomes } from '../../src/validation-replay/replay-evaluator.js';
import { buildValidationReports } from '../../src/validation-replay/report-builder.js';
import { cleanupSingleRun } from '../../src/validation-replay/cleanup-single-run.js';
import { RESEARCH_AVAILABILITY_RULE_VERSION } from '../../src/validation-replay/research-availability.js';
import { FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION } from '../../src/features/feature-version.js';
import { sha256 } from '../../src/domain/hash.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;
const FOUR_HOUR_MS = 14400000;
const FIFTEEN_MIN_MS = 900000;
const DAY_MS = 86400000;

const ALGORITHM_VERSION = 'v1.4c-server-po-rule-1';
const WEIGHT_VERSION = 'v1.4c-server-weight-1';
const DATASET_VERSION = 'v1.4d-sha256-' + '33'.repeat(32);
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
async function seedFourHourAtrBars(client, { referenceCloseTime, count = 15, replayNowMs }) {
  const bars = [];
  for (let i = count - 1; i >= 0; i--) {
    const closeTime = referenceCloseTime - i * FOUR_HOUR_MS;
    bars.push(kline(closeTime - FOUR_HOUR_MS + 1, closeTime, (1000 + i).toFixed(2)));
  }
  const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
  const start = referenceCloseTime - (count - 1) * FOUR_HOUR_MS - FOUR_HOUR_MS + 1;
  await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '4h', startTime: start, endTime: referenceCloseTime, now: () => replayNowMs });
}
async function seedReferenceBar(client, { openTime, closeTime, replayNowMs }) {
  const adapter = makeMockAdapter({ pages: [[kline(openTime, closeTime, '1000.00')]], serverTimeMs: replayNowMs });
  await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime, now: () => replayNowMs });
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
async function seedValidationRun(client, { validationRunId, from, to }) {
  await client.query(
    `INSERT INTO historical_validation.dataset_manifests(
       dataset_version, manifest_schema_version, manifest_hash_algorithm_version, symbol, intervals, data_from, data_to,
       backfill_batch_ids, source_formal_semantics, research_availability_rule_version, record_count, per_interval_record_count,
       integrity_check_result, manifest_members
     ) VALUES($1,'v1.4d-manifest-schema-1','v1.4d-manifest-hash-1','ETHUSDT','["15m","4h"]'::jsonb,to_timestamp($2/1000.0),to_timestamp($3/1000.0),
       '[]'::jsonb,'market_bars:formal:spot',$4,0,'{}'::jsonb,'{"gapCount":0,"duplicateCount":0,"outOfOrderCount":0}'::jsonb,'[]'::jsonb)
     ON CONFLICT(dataset_version) DO NOTHING`,
    [DATASET_VERSION, from, to, RESEARCH_AVAILABILITY_RULE_VERSION]
  );
  await client.query(
    `INSERT INTO historical_validation.validation_runs(
       validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at
     ) VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
    [validationRunId, DATASET_VERSION, from, to, ALGORITHM_VERSION, RULE_VERSION]
  );
}
async function seedGeneratedSnapshot(client, { validationRunId, dayOffset }) {
  const dayStart = Date.UTC(2026, 6, 1 + dayOffset, 0, 0, 0);
  const referenceCloseTime = dayStart - 1;
  const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
  const replayNowMs = Date.now();
  await seedReferenceBar(client, { openTime: referenceOpenTime, closeTime: referenceCloseTime, replayNowMs });
  await seedFourHourAtrBars(client, { referenceCloseTime, count: 15, replayNowMs });
  await seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime: referenceCloseTime });
  const result = await generateReplaySnapshot({
    pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
    historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
    datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
  });
  return { predictionId: result.record.predictionId, referenceCloseTime };
}

test('cleanup-single-run：按冻结顺序删除单run全部关联数据，不影响market_bars/feature_records/dataset_manifests，也不影响其他run', { skip }, async () => {
  await withTxClient(async (client) => {
    const runA = randomUUID();
    const runB = randomUUID();
    const from = Date.UTC(2026, 6, 1) - DAY_MS;
    const to = Date.UTC(2026, 6, 10);
    await seedValidationRun(client, { validationRunId: runA, from, to });
    await seedValidationRun(client, { validationRunId: runB, from, to });

    const snapA = await seedGeneratedSnapshot(client, { validationRunId: runA, dayOffset: 1 });
    const snapB = await seedGeneratedSnapshot(client, { validationRunId: runB, dayOffset: 2 });

    const evalAsOfTimeA = snapA.referenceCloseTime + 96 * FIFTEEN_MIN_MS + 3600000;
    // 补齐runA的完整24h路径以便产出真实outcome行
    const pathStart = snapA.referenceCloseTime + 1;
    const bars = [];
    for (let i = 0; i < 96; i++) { const o = pathStart + i * FIFTEEN_MIN_MS; bars.push(kline(o, o + FIFTEEN_MIN_MS - 1, '1000.00')); }
    const replayNowMs = Date.now();
    const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: pathStart, endTime: pathStart + 96 * FIFTEEN_MIN_MS, now: () => replayNowMs });
    await evaluateReplayOutcomes({ pool: client, validationRunId: runA, evaluationVersion: EVALUATION_VERSION, historicalAsOfTime: evalAsOfTimeA, replayNowMs });

    await buildValidationReports({
      pool: client, validationRunId: runA, datasetVersion: DATASET_VERSION, algorithmVersion: ALGORITHM_VERSION,
      ruleVersion: RULE_VERSION, researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion: EVALUATION_VERSION
    });
    await buildValidationReports({
      pool: client, validationRunId: runB, datasetVersion: DATASET_VERSION, algorithmVersion: ALGORITHM_VERSION,
      ruleVersion: RULE_VERSION, researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion: EVALUATION_VERSION
    });

    const before = {
      marketBars: (await client.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n,
      featureRecords: (await client.query('SELECT count(*)::int AS n FROM feature_records')).rows[0].n,
      datasetManifests: (await client.query('SELECT count(*)::int AS n FROM historical_validation.dataset_manifests')).rows[0].n,
      runBSnapshots: (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE prediction_id=$1', [snapB.predictionId])).rows[0].n
    };
    assert.equal(before.runBSnapshots, 1);

    const result = await cleanupSingleRun(client, { validationRunId: runA });
    assert.equal(result.status, 'DELETED');
    assert.equal(result.validationRunDeleted, true);

    const after = {
      marketBars: (await client.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n,
      featureRecords: (await client.query('SELECT count(*)::int AS n FROM feature_records')).rows[0].n,
      datasetManifests: (await client.query('SELECT count(*)::int AS n FROM historical_validation.dataset_manifests')).rows[0].n,
      runBSnapshots: (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE prediction_id=$1', [snapB.predictionId])).rows[0].n
    };
    assert.deepEqual(after, before, 'market_bars/feature_records/dataset_manifests行数与runB的数据必须逐项不变');

    // runA全部关联行必须已清空
    const runAResidual = {
      validationRuns: (await client.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs WHERE validation_run_id=$1', [runA])).rows[0].n,
      generationRuns: (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1', [runA])).rows[0].n,
      evaluationRuns: (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1', [runA])).rows[0].n,
      snapshots: (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE prediction_id=$1', [snapA.predictionId])).rows[0].n,
      outcomeEvents: (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_outcome_events WHERE prediction_id=$1', [snapA.predictionId])).rows[0].n,
      reports: (await client.query('SELECT count(*)::int AS n FROM historical_validation.validation_reports WHERE validation_run_id=$1', [runA])).rows[0].n
    };
    for (const [key, value] of Object.entries(runAResidual)) assert.equal(value, 0, `${key} 必须清零`);
  });
});
