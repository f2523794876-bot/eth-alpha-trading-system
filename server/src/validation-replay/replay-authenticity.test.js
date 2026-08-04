import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPLAY_SNAPSHOT_CANONICAL_FIELDS, REPLAY_SNAPSHOT_EXCLUDED_STORAGE_FIELDS,
  assertReplayAuthenticity, assertReplaySnapshotIdentity, assertReportAuthenticity, assertScorecardRunAuthenticity,
  canonicalReplaySnapshot, compareReplaySnapshotContent, createReplayAuthenticitySummary,
  recordGenerationAuthenticity
} from './replay-authenticity.js';
import { buildValidationReports } from './report-builder.js';

const T0 = Date.UTC(2026, 0, 1);

function candidate(overrides = {}) {
  return {
    predictionId: 'GMKG-REPLAY-ETH-24h-1-alg-dataset', backfillBatchId: null,
    datasetVersion: 'dataset', instrument: 'ETH', horizon: '24h',
    generatedAt: T0, dataCutoffTime: T0, targetStartTime: T0, targetEndTime: T0 + 86400000,
    referencePrice: 1000, referenceBarRef: { closeTime: T0 }, targetBarRef: { closeTime: T0 + 86400000 },
    expectedBarCount: 96, expectedDirection: 'UP', directionThreshold: 0.01, rawThreshold: 0.01,
    thresholdFloor: 0.008, thresholdCeiling: 0.05, thresholdFormulaVersion: 'threshold-1',
    atr14FourHourAtGeneration: 10, targetStateAtGeneration: 'UNKNOWN',
    proxyStateAtGeneration: 'PO_TREND_UP_STRUCTURE', fusionStateAtGeneration: 'UNKNOWN',
    candidateTrajectories: { stateConfidence: 90 }, scenarioWeights: { baseline: 30, upside: 50, downside: 20 },
    probabilityStatus: 'rule_based', calibratedProbabilities: null, brierScoreComponent: null,
    expectedPriceZones: { baseline: [990, 1010] }, triggerConditions: ['trigger'], invalidationConditions: ['invalid'],
    algorithmVersion: 'alg', weightVersion: 'weight', ruleVersion: 'rule', dataVintageRefs: [],
    featureValuesUsed: { trend4h: 'UP' }, featureRecordIds: ['feature-1'], featureEngineVersion: 'feature-engine',
    contentHash: 'a'.repeat(64), auxiliaryEvidence: {}, historicalAsOfTime: T0,
    researchDataVintage: { records: [] }, researchAvailabilityRuleVersion: 'availability-1',
    sourceOrigin: 'HISTORICAL_REPLAY', ...overrides
  };
}

function storedFromCandidate(value) {
  const canonical = canonicalReplaySnapshot(value);
  return {
    replay_snapshot_id: 9, generation_run_id: 'storage-only', created_at: new Date(),
    prediction_id: canonical.predictionId, backfill_batch_id: canonical.backfillBatchId,
    dataset_version: canonical.datasetVersion, instrument: canonical.instrument, horizon: canonical.horizon,
    generated_at: new Date(canonical.generatedAt), data_cutoff_time: new Date(canonical.dataCutoffTime),
    target_start_time: new Date(canonical.targetStartTime), target_end_time: new Date(canonical.targetEndTime),
    reference_price: canonical.referencePrice.toFixed(8), reference_bar_ref: canonical.referenceBarRef,
    target_bar_ref: canonical.targetBarRef, expected_bar_count: canonical.expectedBarCount,
    expected_direction: canonical.expectedDirection, direction_threshold: canonical.directionThreshold.toFixed(8),
    raw_threshold: canonical.rawThreshold.toFixed(8), threshold_floor: canonical.thresholdFloor.toFixed(8),
    threshold_ceiling: canonical.thresholdCeiling.toFixed(8), threshold_formula_version: canonical.thresholdFormulaVersion,
    atr14_four_hour_at_generation: canonical.atr14FourHourAtGeneration.toFixed(8),
    target_state_at_generation: canonical.targetStateAtGeneration, proxy_state_at_generation: canonical.proxyStateAtGeneration,
    fusion_state_at_generation: canonical.fusionStateAtGeneration, candidate_trajectories: canonical.candidateTrajectories,
    scenario_weight_baseline: canonical.scenarioWeights.baseline, scenario_weight_upside: canonical.scenarioWeights.upside,
    scenario_weight_downside: canonical.scenarioWeights.downside, probability_status: canonical.probabilityStatus,
    calibrated_probabilities: canonical.calibratedProbabilities, brier_score_component: canonical.brierScoreComponent,
    expected_price_zones: canonical.expectedPriceZones, trigger_conditions: canonical.triggerConditions,
    invalidation_conditions: canonical.invalidationConditions, algorithm_version: canonical.algorithmVersion,
    weight_version: canonical.weightVersion, rule_version: canonical.ruleVersion, data_vintage_refs: canonical.dataVintageRefs,
    feature_values_used: canonical.featureValuesUsed, feature_record_ids: canonical.featureRecordIds,
    feature_engine_version: canonical.featureEngineVersion, content_hash: canonical.contentHash,
    auxiliary_evidence: canonical.auxiliaryEvidence, historical_as_of_time: new Date(canonical.historicalAsOfTime),
    research_data_vintage: canonical.researchDataVintage,
    research_availability_rule_version: canonical.researchAvailabilityRuleVersion, source_origin: canonical.sourceOrigin
  };
}

test('canonical replay snapshot binds every migration-005 semantic field and excludes only storage metadata', () => {
  assert.equal(REPLAY_SNAPSHOT_CANONICAL_FIELDS.length, 44);
  assert.deepEqual(REPLAY_SNAPSHOT_EXCLUDED_STORAGE_FIELDS, ['replay_snapshot_id', 'generation_run_id', 'created_at']);
  const value = candidate();
  assert.deepEqual(Object.keys(canonicalReplaySnapshot(value)), [...REPLAY_SNAPSHOT_CANONICAL_FIELDS]);
  assert.deepEqual(compareReplaySnapshotContent(storedFromCandidate(value), value).differingFields, []);
  assert.throws(
    () => canonicalReplaySnapshot({ ...storedFromCandidate(value), future_semantic_field: 'unreviewed' }),
    error => error.code === 'REPLAY_SNAPSHOT_CANONICALIZATION_FAILED' && error.unknownColumns.includes('future_semantic_field')
  );
  assert.throws(
    () => canonicalReplaySnapshot({ ...value, futureSemanticField: 'unreviewed' }),
    error => error.code === 'REPLAY_SNAPSHOT_CANONICALIZATION_FAILED' && error.unknownColumns.includes('futureSemanticField')
  );
});

test('same identity with any research-semantic mutation is rejected deterministically', () => {
  const original = candidate();
  for (const [field, replacement] of [
    ['expectedDirection', 'DOWN'], ['proxyStateAtGeneration', 'PO_UNKNOWN'], ['datasetVersion', 'other-dataset'],
    ['algorithmVersion', 'other-alg'], ['weightVersion', 'other-weight'], ['ruleVersion', 'other-rule'],
    ['historicalAsOfTime', T0 + 1], ['featureValuesUsed', { trend4h: 'DOWN' }],
    ['scenarioWeights', { baseline: 50, upside: 25, downside: 25 }], ['contentHash', 'b'.repeat(64)]
  ]) {
    const comparison = compareReplaySnapshotContent(storedFromCandidate(original), candidate({ [field]: replacement }));
    assert.equal(comparison.identical, false, field);
    assert.ok(comparison.differingFields.includes(field), field);
  }
  assert.throws(
    () => assertReplaySnapshotIdentity(storedFromCandidate(original), candidate({ weightVersion: 'changed' })),
    error => error.code === 'REPLAY_SNAPSHOT_IDENTITY_CONFLICT'
      && error.predictionId === original.predictionId
      && error.differingFields.includes('weightVersion')
  );
});

test('fresh and resume authenticity matrices distinguish inserts, identical reuse, conflicts and zero recomputation', () => {
  const resume = createReplayAuthenticitySummary({ mode: 'resume', expectedCount: 2 });
  recordGenerationAuthenticity(resume, 'REUSED_IDENTICAL');
  recordGenerationAuthenticity(resume, 'REUSED_IDENTICAL');
  assert.equal(assertReplayAuthenticity(resume).gate_status, 'PASSED');
  assert.equal(resume.inserted_count, 0);
  assert.equal(resume.reused_identical_count, 2);

  const fresh = createReplayAuthenticitySummary({ mode: 'fresh', expectedCount: 2 });
  recordGenerationAuthenticity(fresh, 'INSERTED');
  recordGenerationAuthenticity(fresh, 'INSERTED');
  assert.equal(assertReplayAuthenticity(fresh).gate_status, 'PASSED');

  for (const statuses of [['REUSED_IDENTICAL', 'REUSED_IDENTICAL'], ['INSERTED', 'REUSED_IDENTICAL'], ['INSERTED', 'CONFLICT']]) {
    const invalid = createReplayAuthenticitySummary({ mode: 'fresh', expectedCount: 2 });
    for (const status of statuses) recordGenerationAuthenticity(invalid, status);
    assert.throws(() => assertReplayAuthenticity(invalid), error => error.code === 'RERUN_AUTHENTICITY_CHECK_FAILED');
  }
});

test('report and scorecard reject missing, blocked and failed authenticity evidence', () => {
  assert.throws(() => assertReportAuthenticity(null), error => error.code === 'REPORT_RERUN_AUTHENTICITY_NOT_PROVEN');
  assert.throws(() => assertScorecardRunAuthenticity({ runStatus: 'FAILED', horizons: ['24h'], reportRows: [] }), error => error.code === 'SCORECARD_VALIDATION_RUN_NOT_ELIGIBLE');
  assert.throws(() => assertScorecardRunAuthenticity({ runStatus: 'SUCCEEDED', horizons: ['24h'], reportRows: [] }), error => error.code === 'SCORECARD_RERUN_AUTHENTICITY_NOT_PROVEN');
  const summary = createReplayAuthenticitySummary({ mode: 'fresh', expectedCount: 1 });
  recordGenerationAuthenticity(summary, 'INSERTED');
  assertReplayAuthenticity(summary);
  assert.equal(assertScorecardRunAuthenticity({
    runStatus: 'SUCCEEDED', horizons: ['24h'],
    reportRows: [{ horizon: '24h', reportScope: 'ALL', formalProxyDisclosure: { rerunAuthenticity: summary } }]
  }), summary);
});

test('failed validation run is rejected before report sample queries or writes', async () => {
  const summary = createReplayAuthenticitySummary({ mode: 'fresh', expectedCount: 1 });
  recordGenerationAuthenticity(summary, 'INSERTED');
  assertReplayAuthenticity(summary);
  const statements = [];
  const pool = { query: async sql => {
    statements.push(sql);
    return { rowCount: 1, rows: [{ status: 'FAILED' }] };
  } };
  await assert.rejects(buildValidationReports({
    pool, validationRunId: 'run', datasetVersion: 'dataset', algorithmVersion: 'algorithm',
    ruleVersion: 'rule', researchAvailabilityRuleVersion: 'availability', evaluationVersion: 'evaluation',
    authenticitySummary: summary
  }), error => error.code === 'REPORT_VALIDATION_RUN_NOT_ELIGIBLE');
  assert.equal(statements.length, 1);
  assert.match(statements[0], /SELECT status FROM historical_validation\.validation_runs/);
});
