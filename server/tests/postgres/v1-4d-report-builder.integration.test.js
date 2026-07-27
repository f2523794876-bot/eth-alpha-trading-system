// R13(raw/effective样本披露)/R19(purge披露)/R16(误差归因披露)/§五冻结字段清单：report-builder.js真实PostgreSQL验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { generateReplaySnapshot } from '../../src/validation-replay/replay-generator.js';
import { buildValidationReports } from '../../src/validation-replay/report-builder.js';
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
const DATASET_VERSION = 'v1.4d-sha256-' + '22'.repeat(32);
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
  const dayStart = Date.UTC(2026, 5, 1 + dayOffset, 0, 0, 0);
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
  return { predictionId: result.record.predictionId, targetStartTime: referenceCloseTime, targetEndTime: referenceCloseTime + 96 * FIFTEEN_MIN_MS };
}

async function insertOutcomeEvent(client, { predictionId, directionCorrect, actualDirection = 'RANGE', endpointDataComplete = true, pathDataComplete = true, mfe = 0.01, mae = 0.01 }) {
  const evaluationRunId = randomUUID();
  await client.query(
    `INSERT INTO historical_validation.replay_evaluation_runs(evaluation_run_id, validation_run_id, historical_as_of_time, status, started_at)
     SELECT $1, g.validation_run_id, now(), 'SUCCEEDED', now()
     FROM historical_validation.replay_snapshots s JOIN historical_validation.replay_generation_runs g ON g.generation_run_id=s.generation_run_id
     WHERE s.prediction_id=$2 LIMIT 1`,
    [evaluationRunId, predictionId]
  );
  await client.query(
    `INSERT INTO historical_validation.replay_outcome_events(
       prediction_id, evaluation_version, evaluation_run_id, research_availability_rule_version, evaluated_at,
       historical_as_of_time, as_of_time, endpoint_data_complete, path_data_complete, direction_eligible_for_statistics,
       path_eligible_for_statistics, actual_return, actual_direction, direction_correct, actual_high, actual_low, mfe, mae,
       range_specific_metrics, missing_bar_refs, research_data_vintage, source_origin, content_hash
     ) VALUES($1,$2,$3,$4,now(),now(),now(),$5,$6,true,true,0,$7,$8,1010,990,$9,$10,
       '{"realizedRangeInsideExpectedEnvelope":true,"expectedEnvelopeTouched":true,"upperExcursion":0.01,"lowerExcursion":0.01,"maxAbsoluteExcursion":0.01,"rangeBreachExcursion":0}'::jsonb,
       '[]'::jsonb,'{}'::jsonb,'HISTORICAL_REPLAY',$11)`,
    [predictionId, EVALUATION_VERSION, evaluationRunId, RESEARCH_AVAILABILITY_RULE_VERSION, endpointDataComplete, pathDataComplete, actualDirection, directionCorrect, mfe, mae, sha256({ predictionId, mfe, mae })]
  );
}

test('report-builder：ALL scope聚合raw/effective样本数、direction正确率、误差归因披露', { skip }, async () => {
  await withTxClient(async (client) => {
    const validationRunId = randomUUID();
    await seedValidationRun(client, { validationRunId, from: Date.UTC(2026, 5, 1) - DAY_MS, to: Date.UTC(2026, 5, 10) });

    const s1 = await seedGeneratedSnapshot(client, { validationRunId, dayOffset: 1 });
    const s2 = await seedGeneratedSnapshot(client, { validationRunId, dayOffset: 2 });
    const s3 = await seedGeneratedSnapshot(client, { validationRunId, dayOffset: 3 });

    await insertOutcomeEvent(client, { predictionId: s1.predictionId, directionCorrect: true });
    await insertOutcomeEvent(client, { predictionId: s2.predictionId, directionCorrect: true });
    await insertOutcomeEvent(client, { predictionId: s3.predictionId, directionCorrect: false });

    const reports = await buildValidationReports({
      pool: client, validationRunId, datasetVersion: DATASET_VERSION, algorithmVersion: ALGORITHM_VERSION,
      ruleVersion: RULE_VERSION, researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion: EVALUATION_VERSION
    });

    const allReport24h = reports.find(r => r.horizon === '24h' && r.reportScope === 'ALL');
    assert.ok(allReport24h);
    assert.equal(allReport24h.directionRawSampleCount, 3);
    assert.equal(allReport24h.directionEffectiveSampleCount, 3);
    assert.equal(allReport24h.purgedStraddlingCount, 0);
    assert.equal(allReport24h.upDownRangeBreakdown.RANGE.effectiveCount, 3);
    assert.equal(allReport24h.upDownRangeBreakdown.RANGE.directionCorrectCount, 2);
    assert.ok(Math.abs(allReport24h.upDownRangeBreakdown.RANGE.directionAccuracy - 2 / 3) < 1e-9);
    assert.equal(allReport24h.errorAttributionSummary.notEvaluableCauses.length, 5);
    assert.ok(allReport24h.errorAttributionSummary.notEvaluableCauses.includes('exogenous_shock'));
    assert.equal(allReport24h.calibratedProbabilitiesStatus, 'null (V1.4D not eligible)');
    assert.equal(allReport24h.sampleSufficient, false); // 3 < MIN_SAMPLE_THRESHOLDS['24h']=30

    const row = (await client.query(
      `SELECT * FROM historical_validation.validation_reports WHERE validation_run_id=$1 AND horizon='24h' AND report_scope='ALL'`,
      [validationRunId]
    )).rows[0];
    assert.ok(row, '数据库行必须已写入');
    assert.equal(row.brier_score_component, null);
    assert.equal(row.direction_raw_sample_count, 3);
    assert.match(row.content_hash, /^[0-9a-f]{64}$/);
  });
});

test('report-builder：TRAIN/VALIDATION/TEST三段切分与purgedStraddlingCount披露', { skip }, async () => {
  await withTxClient(async (client) => {
    const validationRunId = randomUUID();
    const from = Date.UTC(2026, 5, 1) - DAY_MS;
    const to = Date.UTC(2026, 5, 20);
    await seedValidationRun(client, { validationRunId, from, to });

    // dayOffset 1,2 -> train; 8 -> validation; 15 -> test（trainEnd/validationEnd选在样本targetEndTime之间，不产生跨界）
    const s1 = await seedGeneratedSnapshot(client, { validationRunId, dayOffset: 1 });
    const s2 = await seedGeneratedSnapshot(client, { validationRunId, dayOffset: 2 });
    const s3 = await seedGeneratedSnapshot(client, { validationRunId, dayOffset: 8 });
    const s4 = await seedGeneratedSnapshot(client, { validationRunId, dayOffset: 15 });
    for (const s of [s1, s2, s3, s4]) await insertOutcomeEvent(client, { predictionId: s.predictionId, directionCorrect: true });

    const trainEnd = Date.UTC(2026, 5, 5); // 早于s3(day8+96*15m～day9)targetEndTime，晚于s1/s2 targetEndTime
    const validationEnd = Date.UTC(2026, 5, 12);

    const reports = await buildValidationReports({
      pool: client, validationRunId, datasetVersion: DATASET_VERSION, algorithmVersion: ALGORITHM_VERSION,
      ruleVersion: RULE_VERSION, researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion: EVALUATION_VERSION,
      trainEnd, validationEnd
    });

    const train = reports.find(r => r.horizon === '24h' && r.reportScope === 'TRAIN');
    const validation = reports.find(r => r.horizon === '24h' && r.reportScope === 'VALIDATION');
    const testReport = reports.find(r => r.horizon === '24h' && r.reportScope === 'TEST');
    assert.equal(train.directionEffectiveSampleCount, 2);
    assert.equal(validation.directionEffectiveSampleCount, 1);
    assert.equal(testReport.directionEffectiveSampleCount, 1);
    assert.equal(train.purgedStraddlingCount, 0);

    const rows = await client.query(`SELECT report_scope FROM historical_validation.validation_reports WHERE validation_run_id=$1 AND horizon='24h'`, [validationRunId]);
    assert.deepEqual(rows.rows.map(r => r.report_scope).sort(), ['ALL', 'TEST', 'TRAIN', 'VALIDATION']);
  });
});

test('report-builder：重复调用为覆盖写(UPSERT)，不产生重复行', { skip }, async () => {
  await withTxClient(async (client) => {
    const validationRunId = randomUUID();
    await seedValidationRun(client, { validationRunId, from: Date.UTC(2026, 5, 1) - DAY_MS, to: Date.UTC(2026, 5, 10) });
    const s1 = await seedGeneratedSnapshot(client, { validationRunId, dayOffset: 1 });
    await insertOutcomeEvent(client, { predictionId: s1.predictionId, directionCorrect: true });

    const buildArgs = {
      pool: client, validationRunId, datasetVersion: DATASET_VERSION, algorithmVersion: ALGORITHM_VERSION,
      ruleVersion: RULE_VERSION, researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion: EVALUATION_VERSION
    };
    await buildValidationReports(buildArgs);
    await buildValidationReports(buildArgs);

    const count = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.validation_reports WHERE validation_run_id=$1 AND horizon='24h' AND report_scope='ALL'`, [validationRunId])).rows[0].n;
    assert.equal(count, 1);
  });
});
