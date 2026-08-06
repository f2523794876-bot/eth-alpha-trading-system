import { computeSplitEffectiveSamples } from './purge.js';

const HORIZONS = ['24h', '72h'];
const DIRECTIONS = ['UP', 'DOWN', 'RANGE'];
const BASELINES = ['alwaysRange', 'follow4hTrend', 'historicalProportionRandom'];

function fail(code, message) { return Object.assign(new Error(message || code), { code }); }
function epoch(value) { return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value); }
function count(rows, predicate) { return rows.reduce((n, row) => n + (predicate(row) ? 1 : 0), 0); }

function bestBaseline(mapped, field) {
  const available = BASELINES.filter(name => mapped[name].status === 'AVAILABLE');
  if (available.length !== BASELINES.length) return null;
  return available.reduce((best, name) => mapped[name][field] > mapped[best][field] ? name : best, available[0]);
}

function selectedRows(rows, horizon, trainEnd, validationEnd) {
  const timed = rows.filter(row => row.horizon === horizon && row.directionEligibleForStatistics === true)
    .map(row => ({ ...row, targetStartTime: epoch(row.targetStartTime), targetEndTime: epoch(row.targetEndTime) }));
  const split = computeSplitEffectiveSamples(timed, {
    eligibilityField: 'directionEligibleForStatistics', trainEnd: epoch(trainEnd), validationEnd: epoch(validationEnd)
  });
  const rawTest = timed.filter(row => row.targetStartTime >= epoch(validationEnd)).length;
  return { rawTest, training: split.training, test: split.test };
}

function macroF1(rows, prediction) {
  if (!rows.length) return null;
  return DIRECTIONS.reduce((sum, label) => {
    const tp = count(rows, r => r.actualDirection === label && prediction(r) === label);
    const fp = count(rows, r => r.actualDirection !== label && prediction(r) === label);
    const fn = count(rows, r => r.actualDirection === label && prediction(r) !== label);
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    return sum + (precision + recall ? 2 * precision * recall / (precision + recall) : 0);
  }, 0) / DIRECTIONS.length;
}

function economics(rows, prediction, totalBps) {
  if (!rows.length || rows.some(r => !Number.isFinite(Number(r.actualReturn)))) return null;
  const gross = rows.map(row => prediction(row) === 'UP' ? Number(row.actualReturn) : prediction(row) === 'DOWN' ? -Number(row.actualReturn) : 0);
  const post = rows.map((row, i) => gross[i] - (prediction(row) === 'RANGE' ? 0 : totalBps / 10000));
  return { pre: gross.reduce((a, b) => a + b, 0) / gross.length, post: post.reduce((a, b) => a + b, 0) / post.length };
}

function availableMetric(rows, prediction, totalBps) {
  const returns = economics(rows, prediction, totalBps);
  if (!returns) return null;
  return { status: 'AVAILABLE', reasonCode: 'NONE', sampleCount: rows.length, macroF1: macroF1(rows, prediction), preCostExpectedReturn: returns.pre, postCostExpectedReturn: returns.post };
}

function unavailable(reasonCode) { return { status: 'NOT_EVALUABLE', reasonCode, sampleCount: 0, macroF1: null, preCostExpectedReturn: null, postCostExpectedReturn: null }; }

function randomPredictions(rows, training, seed) {
  if (!training.length) return null;
  const proportions = DIRECTIONS.map(d => count(training, r => r.actualDirection === d) / training.length);
  let state = seed | 0;
  const random = () => { state = state + 0x6D2B79F5 | 0; let t = Math.imul(state ^ state >>> 15, 1 | state); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const predictions = new Map();
  rows.forEach(row => { const v = random(); predictions.set(row.predictionId, v < proportions[0] ? 'UP' : v < proportions[0] + proportions[1] ? 'DOWN' : 'RANGE'); });
  return row => predictions.get(row.predictionId);
}

function exactMetrics(testRows, trainingRows, { totalBps, randomSeed }) {
  const modelPrediction = row => row.predictedDirection;
  const trendRows = testRows.filter(row => row.trend4hAtGeneration === 'UP' || row.trend4hAtGeneration === 'DOWN');
  const randomPrediction = randomPredictions(testRows, trainingRows, randomSeed);
  return {
    model: availableMetric(testRows, modelPrediction, totalBps),
    baselines: {
      alwaysRange: availableMetric(testRows, () => 'RANGE', totalBps) || unavailable('NO_EVALUATION_ROWS'),
      follow4hTrend: availableMetric(trendRows, row => row.trend4hAtGeneration, totalBps) || unavailable(testRows.length ? 'NO_VALID_TREND' : 'NO_EVALUATION_ROWS'),
      historicalProportionRandom: randomPrediction ? (availableMetric(testRows, randomPrediction, totalBps) || unavailable('INPUT_MISSING')) : unavailable('NO_TRAIN_SAMPLES')
    }
  };
}

export function assembleD8InputFromResearchRows({
  rows, scorecardResult, validationRunId, evaluationVersion, evaluatedAt,
  trainEnd, validationEnd, thresholds, auditTrail
}) {
  if (!Array.isArray(rows) || !scorecardResult?.scorecard) throw fail('D8_ASSEMBLY_INVALID_INPUT');
  const sampleAccounting = {}, rangeAttribution = {}, marketRegimeAtGeneration = {};
  const predictedUpCount = {}, predictedDownCount = {}, directionalCoverage = {}, marketRegimeCoverage = {};
  const baselineAvailabilityInput = {}, preCostLift = {}, postCostLift = {}, scoreHorizons = {};

  for (const horizon of HORIZONS) {
    const selected = selectedRows(rows, horizon, trainEnd, validationEnd);
    const testRows = selected.test;
    const classCounts = Object.fromEntries(DIRECTIONS.map(d => [d, count(testRows, r => r.actualDirection === d)]));
    const predicted = Object.fromEntries(DIRECTIONS.map(d => [d, count(testRows, r => r.predictedDirection === d)]));
    sampleAccounting[horizon] = {
      rawTest: selected.rawTest, effectiveTest: testRows.length, classEffectiveTest: classCounts,
      predictedUpCount: predicted.UP, predictedDownCount: predicted.DOWN, predictedRangeCount: predicted.RANGE
    };
    rangeAttribution[horizon] = {
      rangeTotal: classCounts.RANGE, predictedRangeCount: predicted.RANGE,
      correctlyPredictedRangeCount: count(testRows, r => r.predictedDirection === 'RANGE' && r.actualDirection === 'RANGE'),
      allPredictionsRange: testRows.length > 0 && predicted.RANGE === testRows.length
    };
    const groups = Object.fromEntries(DIRECTIONS.map(d => [d, {
      sampleCount: count(testRows, r => r.trend4hAtGeneration === d),
      directionCorrectCount: count(testRows, r => r.trend4hAtGeneration === d && r.directionCorrect === true)
    }]));
    marketRegimeAtGeneration[horizon] = groups;
    predictedUpCount[horizon] = predicted.UP;
    predictedDownCount[horizon] = predicted.DOWN;
    directionalCoverage[horizon] = testRows.length ? (predicted.UP + predicted.DOWN) / testRows.length : null;
    const groupTotal = DIRECTIONS.reduce((sum, d) => sum + groups[d].sampleCount, 0);
    marketRegimeCoverage[horizon] = testRows.length ? groupTotal / testRows.length : null;

    const assumptions = scorecardResult.scorecard.assumptions || {};
    const exact = exactMetrics(testRows, selected.training, { totalBps: assumptions.roundTripCostBps, randomSeed: (assumptions.randomSeed ?? 1404) + HORIZONS.indexOf(horizon) });
    const mappedBaselines = exact.baselines;
    const model = exact.model ? {
      directionCorrectCount: count(testRows, r => r.directionCorrect === true), macroF1: exact.model.macroF1,
      preCostExpectedReturn: exact.model.preCostExpectedReturn, postCostExpectedReturn: exact.model.postCostExpectedReturn
    } : { directionCorrectCount: 0, macroF1: 0, preCostExpectedReturn: 0, postCostExpectedReturn: 0 };
    baselineAvailabilityInput[horizon] = mappedBaselines;
    scoreHorizons[horizon] = { model, baselines: mappedBaselines };
    const preRef = bestBaseline(mappedBaselines, 'preCostExpectedReturn');
    const postRef = bestBaseline(mappedBaselines, 'postCostExpectedReturn');
    preCostLift[horizon] = preRef ? model.preCostExpectedReturn - mappedBaselines[preRef].preCostExpectedReturn : null;
    postCostLift[horizon] = postRef ? model.postCostExpectedReturn - mappedBaselines[postRef].postCostExpectedReturn : null;
  }
  return {
    schemaVersion: 'v1.4d-go-no-go-input/2', validationRunId, evaluationVersion, evaluatedAt,
    sampleAccounting, rangeAttribution, marketRegimeAtGeneration, predictedUpCount, predictedDownCount,
    directionalCoverage, marketRegimeCoverage, preCostLift, postCostLift, baselineAvailabilityInput,
    thresholds,
    scorecard: { schemaVersion: 'v1.4d-research-scorecard/4-deterministic', validationRunId, evaluationVersion, evaluatedAt, horizons: scoreHorizons },
    auditTrail: { ...auditTrail, validationRunId, evaluationVersion, evaluatedAt }
  };
}
