import { canonicalJsonHash } from '../domain/hash.js';

export const REPLAY_AUTHENTICITY_MODES = Object.freeze(['resume', 'fresh']);

const field = (record, camelCase, snakeCase) => {
  if (record && Object.hasOwn(record, camelCase)) return record[camelCase];
  if (record && Object.hasOwn(record, snakeCase)) return record[snakeCase];
  return null;
};

function timestamp(record, camelCase, snakeCase) {
  const value = field(record, camelCase, snakeCase);
  if (value == null) return null;
  const epochMs = value instanceof Date ? value.getTime() : (typeof value === 'number' ? value : new Date(value).getTime());
  if (!Number.isFinite(epochMs)) {
    throw Object.assign(new Error(`Invalid replay snapshot timestamp: ${camelCase}`), { code: 'REPLAY_SNAPSHOT_CANONICALIZATION_FAILED', field: camelCase });
  }
  return epochMs;
}

function number(record, camelCase, snakeCase) {
  const value = field(record, camelCase, snakeCase);
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw Object.assign(new Error(`Invalid replay snapshot number: ${camelCase}`), { code: 'REPLAY_SNAPSHOT_CANONICALIZATION_FAILED', field: camelCase });
  }
  return numeric;
}

// This is deliberately an explicit allow-list of every research-semantic column in migration 005.
// Storage ownership/audit metadata is excluded below; adding a new semantic snapshot column therefore
// requires an intentional update here and in the contract test instead of being silently ignored.
export const REPLAY_SNAPSHOT_CANONICAL_FIELDS = Object.freeze([
  'predictionId', 'backfillBatchId', 'datasetVersion', 'instrument', 'horizon',
  'generatedAt', 'dataCutoffTime', 'targetStartTime', 'targetEndTime', 'referencePrice',
  'referenceBarRef', 'targetBarRef', 'expectedBarCount', 'expectedDirection',
  'directionThreshold', 'rawThreshold', 'thresholdFloor', 'thresholdCeiling',
  'thresholdFormulaVersion', 'atr14FourHourAtGeneration', 'targetStateAtGeneration',
  'proxyStateAtGeneration', 'fusionStateAtGeneration', 'candidateTrajectories',
  'scenarioWeights', 'probabilityStatus', 'calibratedProbabilities', 'brierScoreComponent',
  'expectedPriceZones', 'triggerConditions', 'invalidationConditions', 'algorithmVersion',
  'weightVersion', 'ruleVersion', 'dataVintageRefs', 'featureValuesUsed', 'featureRecordIds',
  'featureEngineVersion', 'contentHash', 'auxiliaryEvidence', 'historicalAsOfTime',
  'researchDataVintage', 'researchAvailabilityRuleVersion', 'sourceOrigin'
]);

export const REPLAY_SNAPSHOT_EXCLUDED_STORAGE_FIELDS = Object.freeze([
  'replay_snapshot_id', 'generation_run_id', 'created_at'
]);

const REPLAY_SNAPSHOT_STORED_COLUMNS = new Set([
  ...REPLAY_SNAPSHOT_EXCLUDED_STORAGE_FIELDS,
  'prediction_id', 'backfill_batch_id', 'dataset_version', 'instrument', 'horizon',
  'generated_at', 'data_cutoff_time', 'target_start_time', 'target_end_time', 'reference_price',
  'reference_bar_ref', 'target_bar_ref', 'expected_bar_count', 'expected_direction', 'direction_threshold',
  'raw_threshold', 'threshold_floor', 'threshold_ceiling', 'threshold_formula_version',
  'atr14_four_hour_at_generation', 'target_state_at_generation', 'proxy_state_at_generation',
  'fusion_state_at_generation', 'candidate_trajectories', 'scenario_weight_baseline',
  'scenario_weight_upside', 'scenario_weight_downside', 'probability_status', 'calibrated_probabilities',
  'brier_score_component', 'expected_price_zones', 'trigger_conditions', 'invalidation_conditions',
  'algorithm_version', 'weight_version', 'rule_version', 'data_vintage_refs', 'feature_values_used',
  'feature_record_ids', 'feature_engine_version', 'content_hash', 'auxiliary_evidence',
  'historical_as_of_time', 'research_data_vintage', 'research_availability_rule_version', 'source_origin'
]);

function assertNoUnknownStoredColumns(record) {
  if (!record) return;
  const storedRecord = Object.hasOwn(record, 'prediction_id');
  const allowedFields = storedRecord
    ? REPLAY_SNAPSHOT_STORED_COLUMNS
    : new Set(REPLAY_SNAPSHOT_CANONICAL_FIELDS);
  const unknownColumns = Object.keys(record).filter(key => !allowedFields.has(key));
  if (unknownColumns.length) {
    throw Object.assign(new Error(`Unrecognized replay snapshot ${storedRecord ? 'column' : 'field'}(s): ${unknownColumns.join(', ')}`), {
      code: 'REPLAY_SNAPSHOT_CANONICALIZATION_FAILED', unknownColumns
    });
  }
}

export function canonicalReplaySnapshot(record) {
  assertNoUnknownStoredColumns(record);
  return {
    predictionId: field(record, 'predictionId', 'prediction_id'),
    backfillBatchId: field(record, 'backfillBatchId', 'backfill_batch_id'),
    datasetVersion: field(record, 'datasetVersion', 'dataset_version'),
    instrument: field(record, 'instrument', 'instrument'),
    horizon: field(record, 'horizon', 'horizon'),
    generatedAt: timestamp(record, 'generatedAt', 'generated_at'),
    dataCutoffTime: timestamp(record, 'dataCutoffTime', 'data_cutoff_time'),
    targetStartTime: timestamp(record, 'targetStartTime', 'target_start_time'),
    targetEndTime: timestamp(record, 'targetEndTime', 'target_end_time'),
    referencePrice: number(record, 'referencePrice', 'reference_price'),
    referenceBarRef: field(record, 'referenceBarRef', 'reference_bar_ref'),
    targetBarRef: field(record, 'targetBarRef', 'target_bar_ref'),
    expectedBarCount: number(record, 'expectedBarCount', 'expected_bar_count'),
    expectedDirection: field(record, 'expectedDirection', 'expected_direction'),
    directionThreshold: number(record, 'directionThreshold', 'direction_threshold'),
    rawThreshold: number(record, 'rawThreshold', 'raw_threshold'),
    thresholdFloor: number(record, 'thresholdFloor', 'threshold_floor'),
    thresholdCeiling: number(record, 'thresholdCeiling', 'threshold_ceiling'),
    thresholdFormulaVersion: field(record, 'thresholdFormulaVersion', 'threshold_formula_version'),
    atr14FourHourAtGeneration: number(record, 'atr14FourHourAtGeneration', 'atr14_four_hour_at_generation'),
    targetStateAtGeneration: field(record, 'targetStateAtGeneration', 'target_state_at_generation'),
    proxyStateAtGeneration: field(record, 'proxyStateAtGeneration', 'proxy_state_at_generation'),
    fusionStateAtGeneration: field(record, 'fusionStateAtGeneration', 'fusion_state_at_generation'),
    candidateTrajectories: field(record, 'candidateTrajectories', 'candidate_trajectories'),
    scenarioWeights: {
      baseline: number(record, 'scenarioWeightBaseline', 'scenario_weight_baseline') ?? number(record.scenarioWeights || {}, 'baseline', 'baseline'),
      upside: number(record, 'scenarioWeightUpside', 'scenario_weight_upside') ?? number(record.scenarioWeights || {}, 'upside', 'upside'),
      downside: number(record, 'scenarioWeightDownside', 'scenario_weight_downside') ?? number(record.scenarioWeights || {}, 'downside', 'downside')
    },
    probabilityStatus: field(record, 'probabilityStatus', 'probability_status'),
    calibratedProbabilities: field(record, 'calibratedProbabilities', 'calibrated_probabilities'),
    brierScoreComponent: number(record, 'brierScoreComponent', 'brier_score_component'),
    expectedPriceZones: field(record, 'expectedPriceZones', 'expected_price_zones'),
    triggerConditions: field(record, 'triggerConditions', 'trigger_conditions'),
    invalidationConditions: field(record, 'invalidationConditions', 'invalidation_conditions'),
    algorithmVersion: field(record, 'algorithmVersion', 'algorithm_version'),
    weightVersion: field(record, 'weightVersion', 'weight_version'),
    ruleVersion: field(record, 'ruleVersion', 'rule_version'),
    dataVintageRefs: field(record, 'dataVintageRefs', 'data_vintage_refs'),
    featureValuesUsed: field(record, 'featureValuesUsed', 'feature_values_used'),
    featureRecordIds: field(record, 'featureRecordIds', 'feature_record_ids'),
    featureEngineVersion: field(record, 'featureEngineVersion', 'feature_engine_version'),
    contentHash: field(record, 'contentHash', 'content_hash'),
    auxiliaryEvidence: field(record, 'auxiliaryEvidence', 'auxiliary_evidence'),
    historicalAsOfTime: timestamp(record, 'historicalAsOfTime', 'historical_as_of_time'),
    researchDataVintage: field(record, 'researchDataVintage', 'research_data_vintage'),
    researchAvailabilityRuleVersion: field(record, 'researchAvailabilityRuleVersion', 'research_availability_rule_version'),
    sourceOrigin: field(record, 'sourceOrigin', 'source_origin')
  };
}

export function compareReplaySnapshotContent(existing, candidate) {
  const existingCanonical = canonicalReplaySnapshot(existing);
  const candidateCanonical = canonicalReplaySnapshot(candidate);
  const differingFields = REPLAY_SNAPSHOT_CANONICAL_FIELDS.filter(
    key => canonicalJsonHash(existingCanonical[key]) !== canonicalJsonHash(candidateCanonical[key])
  );
  return {
    identical: differingFields.length === 0,
    differingFields,
    existingCanonicalHash: canonicalJsonHash(existingCanonical),
    candidateCanonicalHash: canonicalJsonHash(candidateCanonical)
  };
}

export function assertReplaySnapshotIdentity(existing, candidate) {
  const comparison = compareReplaySnapshotContent(existing, candidate);
  if (!comparison.identical) {
    const predictionId = canonicalReplaySnapshot(candidate).predictionId;
    throw Object.assign(
      new Error(`Replay snapshot identity conflict for ${predictionId}; differing canonical fields: ${comparison.differingFields.join(', ')}`),
      {
        code: 'REPLAY_SNAPSHOT_IDENTITY_CONFLICT', predictionId,
        differingFields: comparison.differingFields,
        existingCanonicalHash: comparison.existingCanonicalHash,
        candidateCanonicalHash: comparison.candidateCanonicalHash
      }
    );
  }
  return comparison;
}

export function createReplayAuthenticitySummary({ mode = 'resume', expectedCount = 0 } = {}) {
  if (!REPLAY_AUTHENTICITY_MODES.includes(mode)) {
    throw Object.assign(new Error(`Invalid replay authenticity mode: ${mode}`), { code: 'INVALID_REPLAY_AUTHENTICITY_MODE' });
  }
  return {
    schema_version: 'v1.4d-rerun-authenticity/1', mode,
    expected_count: expectedCount, attempted_count: 0, inserted_count: 0,
    reused_identical_count: 0, conflict_count: 0, blocked_count: 0, evaluated_count: 0,
    gate_status: 'PENDING'
  };
}

export function recordGenerationAuthenticity(summary, status, { incrementAttempt = true } = {}) {
  if (incrementAttempt) summary.attempted_count += 1;
  if (status === 'INSERTED') summary.inserted_count += 1;
  else if (status === 'REUSED_IDENTICAL') summary.reused_identical_count += 1;
  else if (status === 'BLOCKED') summary.blocked_count += 1;
  else if (status === 'CONFLICT') summary.conflict_count += 1;
  else throw Object.assign(new Error(`Unknown replay generation status: ${status}`), { code: 'REPLAY_AUTHENTICITY_ACCOUNTING_FAILED' });
  return summary;
}

export function assertReplayAuthenticity(summary, { final = true } = {}) {
  const accounted = summary.inserted_count + summary.reused_identical_count + summary.conflict_count + summary.blocked_count;
  const reasons = [];
  if (accounted !== summary.attempted_count) reasons.push('ATTEMPT_ACCOUNTING_MISMATCH');
  if (summary.conflict_count > 0) reasons.push('IDENTITY_CONFLICT');
  if (final && summary.attempted_count !== summary.expected_count) reasons.push('EXPECTED_COUNT_MISMATCH');
  if (summary.mode === 'fresh') {
    if (final && summary.inserted_count === 0) reasons.push('ZERO_FRESH_INSERTS');
    if (final && summary.inserted_count !== summary.expected_count) reasons.push('FRESH_INSERT_COUNT_MISMATCH');
    if (summary.reused_identical_count > 0) reasons.push('FRESH_REUSE_FORBIDDEN');
    if (summary.blocked_count > 0) reasons.push('FRESH_BLOCKED_POINTS');
  }
  if (reasons.length) {
    summary.gate_status = 'BLOCKED';
    throw Object.assign(new Error(`Replay recomputation authenticity failed: ${reasons.join(', ')}`), {
      code: 'RERUN_AUTHENTICITY_CHECK_FAILED', reasons, authenticitySummary: { ...summary }
    });
  }
  if (final) summary.gate_status = 'PASSED';
  return summary;
}

export function assertReportAuthenticity(summary) {
  if (!summary || summary.gate_status !== 'PASSED') {
    throw Object.assign(new Error('Validation report requires a passed replay authenticity gate'), { code: 'REPORT_RERUN_AUTHENTICITY_NOT_PROVEN' });
  }
  return assertReplayAuthenticity(summary);
}

export function assertScorecardRunAuthenticity({ runStatus, horizons, reportRows }) {
  if (runStatus !== 'SUCCEEDED') {
    throw Object.assign(new Error(`Scorecard requires a SUCCEEDED validation run, got ${runStatus ?? 'NOT_FOUND'}`), { code: 'SCORECARD_VALIDATION_RUN_NOT_ELIGIBLE' });
  }
  let acceptedSummary = null;
  for (const horizon of horizons || []) {
    const report = reportRows.find(row => row.horizon === horizon && (row.reportScope ?? row.report_scope) === 'ALL');
    const summary = report?.formalProxyDisclosure?.rerunAuthenticity
      ?? report?.formal_proxy_disclosure?.rerunAuthenticity;
    if (!summary) {
      throw Object.assign(new Error(`Scorecard authenticity evidence is missing for ${horizon}`), { code: 'SCORECARD_RERUN_AUTHENTICITY_NOT_PROVEN', horizon });
    }
    assertReportAuthenticity(summary);
    if (acceptedSummary && canonicalJsonHash(acceptedSummary) !== canonicalJsonHash(summary)) {
      throw Object.assign(new Error('Scorecard reports contain inconsistent replay authenticity evidence'), { code: 'SCORECARD_RERUN_AUTHENTICITY_INCONSISTENT' });
    }
    acceptedSummary = summary;
  }
  if (!acceptedSummary) {
    throw Object.assign(new Error('Scorecard validation run has no horizon authenticity evidence'), { code: 'SCORECARD_RERUN_AUTHENTICITY_NOT_PROVEN' });
  }
  return acceptedSummary;
}
