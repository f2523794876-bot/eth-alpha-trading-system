import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPredictionId, computeForecastContentHash, normalizeScenarioWeights, validateForecastSnapshot, finalizeForecastSnapshot, computeExpectedPriceZones, deriveExpectedDirection, computeRawScenarioScore } from '../../src/forecast/forecast-contract.js';

test('predictionId：GMKG-SRV-前缀+四要素', () => {
  const id = buildPredictionId({ instrument: 'ETH', horizon: '24h', referenceCloseTime: 123456, algorithmVersion: 'v1.4c-server-po-rule-1' });
  assert.equal(id, 'GMKG-SRV-ETH-24h-123456-v1.4c-server-po-rule-1');
});
test('predictionId：非法horizon拒绝', () => {
  assert.throws(() => buildPredictionId({ instrument: 'ETH', horizon: '48h', referenceCloseTime: 1 }), error => error.code === 'PREDICTION_IDENTITY_INVALID');
});

test('contentHash：同输入确定性一致，字段顺序不影响结果（canonicalJsonHash特性）', () => {
  const base = { predictionId: 'p1', featureValuesUsed: { a: 1, b: 2 }, algorithmVersion: 'v1', weightVersion: 'w1', datasetVersion: 'd1', featureEngineVersion: 'f1', scenarioWeights: { baseline: 60, upside: 20, downside: 20 } };
  const h1 = computeForecastContentHash(base);
  const h2 = computeForecastContentHash({ ...base, featureValuesUsed: { b: 2, a: 1 } });
  assert.equal(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
});

test('scenarioWeights归一化：和恰好等于100，余差记入最大项', () => {
  const w = normalizeScenarioWeights({ baseline: 1, upside: 1, downside: 1 });
  assert.equal(w.baseline + w.upside + w.downside, 100);
});
test('scenarioWeights归一化：含负值/NaN拒绝', () => {
  assert.throws(() => normalizeScenarioWeights({ baseline: -1, upside: 1, downside: 1 }), error => error.code === 'SCENARIO_WEIGHTS_INVALID');
  assert.throws(() => normalizeScenarioWeights({ baseline: NaN, upside: 1, downside: 1 }), error => error.code === 'SCENARIO_WEIGHTS_INVALID');
});

function baseInput() {
  return {
    instrument: 'ETH', horizon: '24h', generatedAt: 1000, dataCutoffTime: 900, targetStartTime: 900, targetEndTime: 900 + 96 * 900000,
    referencePrice: 2000, referenceBarRef: { closeTime: 900 }, targetBarRef: { closeTime: 900 + 96 * 900000 },
    expectedBarCount: 96, expectedDirection: 'RANGE', directionThreshold: 0.02, rawThreshold: 0.02, thresholdFloor: 0.008, thresholdCeiling: 0.05,
    thresholdFormulaVersion: 'v1.4c-threshold-formula-2', atr14FourHourAtGeneration: 10,
    proxyStateAtGeneration: 'PO_UNKNOWN',
    candidateTrajectories: {}, scenarioWeights: { baseline: 60, upside: 20, downside: 20 },
    expectedPriceZones: { baseline: [1900, 2100], upside: [2100, 2200], downside: [1800, 1900] },
    triggerConditions: [], invalidationConditions: [], dataVintageRefs: [], featureValuesUsed: { close: 2000 }, featureRecordIds: [1],
    auxiliaryEvidence: {}
  };
}

test('finalizeForecastSnapshot：产出通过结构校验，targetState/fusionState强制UNKNOWN，probabilityStatus=rule_based', () => {
  const record = finalizeForecastSnapshot(baseInput());
  assert.equal(record.targetStateAtGeneration, 'UNKNOWN');
  assert.equal(record.fusionStateAtGeneration, 'UNKNOWN');
  assert.equal(record.probabilityStatus, 'rule_based');
  assert.equal(record.calibratedProbabilities, null);
  assert.match(record.predictionId, /^GMKG-SRV-ETH-24h-900-/);
  assert.match(record.contentHash, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(record));
});

test('validateForecastSnapshot：expectedBarCount非96/288时拒绝', () => {
  const record = finalizeForecastSnapshot({ ...baseInput(), expectedBarCount: 96 });
  const bad = { ...record, expectedBarCount: 50 };
  const result = validateForecastSnapshot(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('EXPECTED_BAR_COUNT_INVALID'));
});

test('computeExpectedPriceZones：§7.3冻结公式', () => {
  const zones = computeExpectedPriceZones(100, 0.02);
  assert.deepEqual(zones.baseline, [99, 101]);
  assert.deepEqual(zones.upside, [102, 104]);
  assert.deepEqual(zones.downside, [96, 98]);
});

test('deriveExpectedDirection：UP/DOWN/RANGE分组', () => {
  assert.equal(deriveExpectedDirection('PO_BREAKOUT_UP_STRUCTURE'), 'UP');
  assert.equal(deriveExpectedDirection('PO_TREND_DOWN_STRUCTURE'), 'DOWN');
  assert.equal(deriveExpectedDirection('PO_SHARP_DROP_STRUCTURE'), 'DOWN');
  assert.equal(deriveExpectedDirection('PO_RANGE_LOW_STRUCTURE'), 'RANGE');
  assert.equal(deriveExpectedDirection('PO_UNKNOWN'), 'RANGE');
});

test('computeRawScenarioScore：stateConfidence>=45原样使用查表值', () => {
  const score = computeRawScenarioScore('PO_BREAKOUT_UP_STRUCTURE', 50);
  assert.deepEqual(score, { baseline: 30, upside: 50, downside: 20 });
});
test('computeRawScenarioScore：stateConfidence<45向{45,27,28}线性插值', () => {
  const score = computeRawScenarioScore('PO_BREAKOUT_UP_STRUCTURE', 0);
  assert.deepEqual(score, { baseline: 45, upside: 27, downside: 28 });
});

test('validateForecastSnapshot：directionThreshold超出clamp范围时拒绝', () => {
  const record = finalizeForecastSnapshot(baseInput());
  const bad = { ...record, directionThreshold: 0.9 };
  const result = validateForecastSnapshot(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('DIRECTION_THRESHOLD_OUT_OF_CLAMP'));
});
