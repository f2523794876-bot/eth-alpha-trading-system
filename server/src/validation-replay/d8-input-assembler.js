// D8 is a deterministic projection of the authoritative research scorecard.
// No split, purge, classification, economic-cost or baseline formula exists
// here; all such values originate in research-scorecard.js::authoritativeD8.

const HORIZONS = ['24h', '72h'];
const DIRECTIONS = ['UP', 'DOWN', 'RANGE'];
const BASELINES = ['alwaysRange', 'follow4hTrend', 'historicalProportionRandom'];

function fail(code, message = code) { return Object.assign(new Error(message), { code }); }

export function assembleD8InputFromResearchRows({
  scorecardResult, validationRunId, evaluationVersion, evaluatedAt,
  thresholds, databaseAuditTrail
}) {
  const scorecard = scorecardResult?.scorecard;
  if (!scorecard || !databaseAuditTrail || databaseAuditTrail.validationRunId !== validationRunId ||
      databaseAuditTrail.evaluationVersion !== evaluationVersion || databaseAuditTrail.evaluatedAt !== evaluatedAt) {
    throw fail('D8_DATABASE_EVIDENCE_REQUIRED', 'D8 requires repository-derived database audit evidence');
  }
  const sampleAccounting = {}, rangeAttribution = {}, marketRegimeAtGeneration = {};
  const predictedUpCount = {}, predictedDownCount = {}, directionalCoverage = {}, marketRegimeCoverage = {};
  const baselineAvailabilityInput = {}, preCostLift = {}, postCostLift = {}, scoreHorizons = {};

  for (const horizon of HORIZONS) {
    const authoritative = scorecard.horizons?.[horizon]?.authoritativeD8;
    if (!authoritative?.sampleAccounting || !authoritative.rangeAttribution || !authoritative.marketRegimeAtGeneration) {
      throw fail('D8_AUTHORITATIVE_METRIC_MISSING', `authoritative D8 metrics are missing for ${horizon}`);
    }
    const sample = structuredClone(authoritative.sampleAccounting);
    const groups = structuredClone(authoritative.marketRegimeAtGeneration);
    if (!Number.isInteger(sample.rawTest) || !Number.isInteger(sample.effectiveTest) || sample.rawTest < sample.effectiveTest ||
        DIRECTIONS.some(label => !Number.isInteger(sample.classEffectiveTest?.[label]) || !Number.isInteger(groups?.[label]?.sampleCount) || !Number.isInteger(groups?.[label]?.directionCorrectCount))) {
      throw fail('D8_AUTHORITATIVE_METRIC_MISSING', `authoritative accounting is incomplete for ${horizon}`);
    }
    const model = structuredClone(authoritative.model);
    const baselines = structuredClone(authoritative.baselines);
    if (!model || !Number.isInteger(model.directionCorrectCount) ||
        ![model.macroF1, model.preCostExpectedReturn, model.postCostExpectedReturn].every(Number.isFinite) ||
        !Number.isInteger(authoritative.predictedUpCount) || !Number.isInteger(authoritative.predictedDownCount) ||
        ![authoritative.directionalCoverage, authoritative.marketRegimeCoverage, authoritative.preCostLift, authoritative.postCostLift]
          .every(value => value === null || Number.isFinite(value)) ||
        BASELINES.some(name => {
          const metric = baselines?.[name];
          if (!metric || !['AVAILABLE', 'NOT_EVALUABLE'].includes(metric.status)) return true;
          return metric.status === 'AVAILABLE'
            ? (!Number.isInteger(metric.sampleCount) || metric.sampleCount < 1 ||
               ![metric.macroF1, metric.preCostExpectedReturn, metric.postCostExpectedReturn].every(Number.isFinite))
            : (metric.sampleCount !== 0 || metric.macroF1 !== null || metric.preCostExpectedReturn !== null || metric.postCostExpectedReturn !== null);
        })) {
      throw fail(model ? 'D8_AUTHORITATIVE_METRIC_MISSING' : 'D8_AUTHORITATIVE_NOT_EVALUABLE', 'authoritative TEST metrics are incomplete');
    }
    sampleAccounting[horizon] = sample;
    rangeAttribution[horizon] = structuredClone(authoritative.rangeAttribution);
    marketRegimeAtGeneration[horizon] = groups;
    predictedUpCount[horizon] = authoritative.predictedUpCount;
    predictedDownCount[horizon] = authoritative.predictedDownCount;
    directionalCoverage[horizon] = authoritative.directionalCoverage;
    marketRegimeCoverage[horizon] = authoritative.marketRegimeCoverage;
    baselineAvailabilityInput[horizon] = baselines;
    scoreHorizons[horizon] = { model, baselines };
    preCostLift[horizon] = authoritative.preCostLift;
    postCostLift[horizon] = authoritative.postCostLift;
  }

  return {
    schemaVersion: 'v1.4d-go-no-go-input/2', validationRunId, evaluationVersion, evaluatedAt,
    sampleAccounting, rangeAttribution, marketRegimeAtGeneration, predictedUpCount, predictedDownCount,
    directionalCoverage, marketRegimeCoverage, preCostLift, postCostLift, baselineAvailabilityInput,
    thresholds,
    scorecard: { schemaVersion: 'v1.4d-research-scorecard/4-deterministic', validationRunId, evaluationVersion, evaluatedAt, horizons: scoreHorizons },
    auditTrail: structuredClone(databaseAuditTrail)
  };
}
