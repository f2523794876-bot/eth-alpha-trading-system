// R13(raw/effective样本披露)/R19(purge披露)/R16(误差归因披露)/§五冻结字段清单：report-builder.js真实PostgreSQL验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { generateReplaySnapshot } from '../../src/validation-replay/replay-generator.js';
import { evaluateReplayOutcomes } from '../../src/validation-replay/replay-evaluator.js';
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
  return { predictionId: result.record.predictionId, targetStartTime: referenceCloseTime, targetEndTime: referenceCloseTime + 96 * FIFTEEN_MIN_MS, status: result.status, validationRunId };
}

// 与cleanup-single-run.js集成测试的seedFullPath同构：为referenceCloseTime之后的24h horizon路径补齐96根15m bar，
// 使evaluateReplayOutcomes能产出真实的path_eligible_for_statistics=true outcome（而不仅仅是direction）。
async function seedFullPath(client, { referenceCloseTime, replayNowMs }) {
  const pathStart = referenceCloseTime + 1;
  const bars = [];
  for (let i = 0; i < 96; i++) { const o = pathStart + i * FIFTEEN_MIN_MS; bars.push(kline(o, o + FIFTEEN_MIN_MS - 1, '1000.00')); }
  const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
  await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: pathStart, endTime: pathStart + 96 * FIFTEEN_MIN_MS, now: () => replayNowMs });
}

async function insertOutcomeEvent(client, {
  predictionId, directionCorrect, actualDirection = 'RANGE', endpointDataComplete = true, pathDataComplete = true,
  directionEligible = true, pathEligible = true, mfe = 0.01, mae = 0.01
}) {
  const evaluationRunId = randomUUID();
  await client.query(
    `INSERT INTO historical_validation.replay_evaluation_runs(evaluation_run_id, validation_run_id, historical_as_of_time, status, started_at)
     SELECT $1, g.validation_run_id, now(), 'SUCCEEDED', now()
     FROM historical_validation.replay_snapshots s JOIN historical_validation.replay_generation_runs g ON g.generation_run_id=s.generation_run_id
     WHERE s.prediction_id=$2 LIMIT 1`,
    [evaluationRunId, predictionId]
  );
  // CHECK红线：direction_eligible_for_statistics=false时方向字段必须NULL；path_eligible_for_statistics=false
  // 时路径字段必须NULL（与生产outcome-engine.js同构的两条CHECK，见migrations/005）。
  const actualReturn = directionEligible ? 0 : null;
  const actualDirectionValue = directionEligible ? actualDirection : null;
  const directionCorrectValue = directionEligible ? directionCorrect : null;
  const actualHigh = pathEligible ? 1010 : null;
  const actualLow = pathEligible ? 990 : null;
  const mfeValue = pathEligible ? mfe : null;
  const maeValue = pathEligible ? mae : null;
  const rangeMetrics = pathEligible
    ? '{"realizedRangeInsideExpectedEnvelope":true,"expectedEnvelopeTouched":true,"upperExcursion":0.01,"lowerExcursion":0.01,"maxAbsoluteExcursion":0.01,"rangeBreachExcursion":0}'
    : null;
  await client.query(
    `INSERT INTO historical_validation.replay_outcome_events(
       prediction_id, evaluation_version, evaluation_run_id, research_availability_rule_version, evaluated_at,
       historical_as_of_time, as_of_time, endpoint_data_complete, path_data_complete, direction_eligible_for_statistics,
       path_eligible_for_statistics, actual_return, actual_direction, direction_correct, actual_high, actual_low, mfe, mae,
       range_specific_metrics, missing_bar_refs, research_data_vintage, source_origin, content_hash
     ) VALUES($1,$2,$3,$4,now(),now(),now(),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
       '[]'::jsonb,'{}'::jsonb,'HISTORICAL_REPLAY',$17)`,
    [
      predictionId, EVALUATION_VERSION, evaluationRunId, RESEARCH_AVAILABILITY_RULE_VERSION, endpointDataComplete, pathDataComplete,
      directionEligible, pathEligible, actualReturn, actualDirectionValue, directionCorrectValue, actualHigh, actualLow, mfeValue, maeValue,
      rangeMetrics, sha256({ predictionId, mfe, mae })
    ]
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

// P2-4（独立复审）：purged_straddling_count计算口径核实——direction/path是两个独立的eligibility集合，
// 各自的"跨边界被剔除"样本集合原则上可以不同。构造一个样本A(direction-eligible但path-ineligible，
// 跨越trainEnd)与另一个样本B(path-eligible但direction-ineligible，不跨越任何边界)：direction的purge
// 集合只含A(=1)，path的purge集合只含B(不跨界，=0)——二者确实不相等，验证report-builder.js持久化的
// 是direction口径（见该文件对应新增注释），而不是二者恰好偶然相等时才"看似"正确。
test('P2-4：direction与path的purgedStraddlingCount可以互不相等——report写入的是direction口径，不静默假装二者恒等', { skip }, async () => {
  await withTxClient(async (client) => {
    const validationRunId = randomUUID();
    const from = Date.UTC(2026, 5, 1) - DAY_MS;
    const to = Date.UTC(2026, 5, 20);
    await seedValidationRun(client, { validationRunId, from, to });

    // A: dayOffset=1 -> targetStartTime≈2026-06-01末尾, targetEndTime≈2026-06-02末尾（24h horizon）。
    const sA = await seedGeneratedSnapshot(client, { validationRunId, dayOffset: 1 });
    // B: dayOffset=8 -> targetStartTime≈2026-06-08末尾, targetEndTime≈2026-06-09末尾，与A的窗口不重叠。
    const sB = await seedGeneratedSnapshot(client, { validationRunId, dayOffset: 8 });

    // trainEnd落在A的[targetStartTime,targetEndTime)内部——A跨越trainEnd。
    const trainEnd = Date.UTC(2026, 5, 2, 12, 0, 0);
    // validationEnd选在B窗口结束之后（B不跨越任何边界，完整落入VALIDATION段）。
    const validationEnd = Date.UTC(2026, 5, 10, 0, 0, 0);

    await insertOutcomeEvent(client, { predictionId: sA.predictionId, directionCorrect: true, directionEligible: true, pathEligible: false });
    await insertOutcomeEvent(client, { predictionId: sB.predictionId, directionCorrect: true, directionEligible: false, pathEligible: true });

    const reports = await buildValidationReports({
      pool: client, validationRunId, datasetVersion: DATASET_VERSION, algorithmVersion: ALGORITHM_VERSION,
      ruleVersion: RULE_VERSION, researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion: EVALUATION_VERSION,
      trainEnd, validationEnd
    });

    const train = reports.find(r => r.horizon === '24h' && r.reportScope === 'TRAIN');
    assert.ok(train);
    // direction侧：selected集合只含A(direction-eligible)，A跨trainEnd -> purgedStraddlingCount=1。
    // path侧（若被独立持久化）：selected集合只含B(path-eligible)，B不跨界 -> 应为0，与direction侧不同。
    assert.equal(train.purgedStraddlingCount, 1, 'report写入的purgedStraddlingCount必须是direction口径(=1)，不是被静默替换成path口径或二者的某种混合');

    const row = (await client.query(
      `SELECT purged_straddling_count FROM historical_validation.validation_reports WHERE validation_run_id=$1 AND horizon='24h' AND report_scope='TRAIN'`,
      [validationRunId]
    )).rows[0];
    assert.equal(row.purged_straddling_count, 1);
  });
});

// P2-5（独立复审）：跨run去重导致report-builder样本少计——runB对同一逻辑预测重复尝试生成，命中runA已插入
// 的快照（DEDUPED，snapshot本身的generation_run_id仍归属runA），但runB确实有自己的replay_generation_runs
// 行（status=SUCCEEDED, deduped_count=1）与自己的evaluation_run/outcome_event。修复前：report-builder对
// runB的查询用`g.generation_run_id=s.generation_run_id`判定归属，永远查不到这个样本（因为snapshot的
// generation_run_id指向runA），runB的报告统计比它真实处理过的样本数少计1个。修复后：报告必须反映runB
// 实际引用/处理过的样本，不能只根据snapshot最初的generation_run_id归属推断。
test('P2-5：runB对runA已生成的快照DEDUPED后，runB的报告必须包含该样本（此前因generation_run_id归属判定被漏计）', { skip }, async () => {
  await withTxClient(async (client) => {
    const runA = randomUUID();
    const runB = randomUUID();
    const from = Date.UTC(2026, 5, 1) - DAY_MS;
    const to = Date.UTC(2026, 5, 10);
    await seedValidationRun(client, { validationRunId: runA, from, to });
    // runB复用同一个已存在的dataset_manifests/dataset_version行（seedValidationRun对dataset_manifests
    // 用ON CONFLICT DO NOTHING，第二次调用是安全的幂等操作），只新增一条独立的validation_runs行。
    await client.query(
      `INSERT INTO historical_validation.validation_runs(
         validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at
       ) VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [runB, DATASET_VERSION, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );

    const dayStart = Date.UTC(2026, 5, 6, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    const replayNowMs = Date.now();
    await seedReferenceBar(client, { openTime: referenceOpenTime, closeTime: referenceCloseTime, replayNowMs });
    await seedFourHourAtrBars(client, { referenceCloseTime, count: 15, replayNowMs });
    await seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime: referenceCloseTime });

    const genA = await generateReplaySnapshot({
      pool: client, validationRunId: runA, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(genA.status, 'INSERTED');
    const genB = await generateReplaySnapshot({
      pool: client, validationRunId: runB, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(genB.status, 'DEDUPED', 'runB必须命中runA已插入的同一条快照(DEDUPED)才是本测试要验证的场景');
    assert.equal(genB.record.prediction_id, genA.record.predictionId);

    await seedFullPath(client, { referenceCloseTime, replayNowMs });
    const evalAsOfTime = referenceCloseTime + 96 * FIFTEEN_MIN_MS + 3600000;
    const evalB = await evaluateReplayOutcomes({ pool: client, validationRunId: runB, evaluationVersion: EVALUATION_VERSION, historicalAsOfTime: evalAsOfTime, replayNowMs });
    assert.equal(evalB.evaluated, 1, 'runB自己的evaluation sweep必须真实评估了这条(它deduped命中的)快照');

    const reportsB = await buildValidationReports({
      pool: client, validationRunId: runB, datasetVersion: DATASET_VERSION, algorithmVersion: ALGORITHM_VERSION,
      ruleVersion: RULE_VERSION, researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion: EVALUATION_VERSION
    });
    const allB = reportsB.find(r => r.horizon === '24h' && r.reportScope === 'ALL');
    assert.equal(allB.directionRawSampleCount, 1, 'runB的报告必须包含它实际deduped命中并评估过的样本，不得因snapshot归属runA而漏计为0');
    assert.equal(allB.directionEffectiveSampleCount, 1);
    assert.equal(allB.pathRawSampleCount, 1);
    assert.equal(allB.pathEffectiveSampleCount, 1);

    // runA自己的报告也必须能看到这条它自己插入的快照（回归——不应被本次修复破坏）。outcome_events的唯一约束
    // 是UNIQUE(prediction_id, evaluation_version, research_availability_rule_version)，不含validation_run_id
    // ——即同一条快照的评估结果是全局唯一、可安全跨run复用的单一canonical结果（§一冻结设计），不是"每个
    // run各自私有一份"；runA虽然自己没调用evaluateReplayOutcomes，但runB评估产出的这条outcome_event
    // 本就是该prediction_id在此evaluationVersion下唯一、双方共享的权威结果，runA的报告同样能看到它，
    // 这是设计意图而非本次P2-5修复引入的新泄漏——P2-5要修复的是"snapshot本身是否被算作runB处理过的样本"
    // （generation侧的判定），不是outcome_events本身的可见范围（那从一开始就是全局去重、天然共享的）。
    const reportsA = await buildValidationReports({
      pool: client, validationRunId: runA, datasetVersion: DATASET_VERSION, algorithmVersion: ALGORITHM_VERSION,
      ruleVersion: RULE_VERSION, researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion: EVALUATION_VERSION
    });
    const allA = reportsA.find(r => r.horizon === '24h' && r.reportScope === 'ALL');
    assert.equal(allA.directionRawSampleCount, 1, 'runA生成的快照必须出现在自己的报告中（回归：不应被本次EXISTS改写破坏）');
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
