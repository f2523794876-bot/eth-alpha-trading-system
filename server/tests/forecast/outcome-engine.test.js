import test from 'node:test';
import assert from 'node:assert/strict';
import { computeForecastOutcome, computeExpectedEnvelope } from '../../src/outcome/outcome-engine.js';

function snapshot(overrides) {
  return {
    predictionId: 'p1', referencePrice: 100, directionThreshold: 0.02, expectedDirection: 'UP', expectedBarCount: 96,
    expectedPriceZones: { baseline: [100, 110], upside: [110, 120], downside: [90, 100] },
    ...overrides
  };
}
function located(overrides) {
  return {
    referenceBarRef: { closeTime: 0 }, targetBarRef: { closeTime: 1000 }, observedBars: [{ sequenceIndex: 1 }],
    missingBarRefs: [], endpointDataComplete: true, pathDataComplete: true, pathEligibleForStatistics: true, directionEligibleForStatistics: true,
    actualStartPrice: 100, actualEndPrice: 105, actualHigh: 108, actualLow: 98, exclusionReasons: [],
    ...overrides
  };
}

test('真值表：endpoint+path均完整 => 方向类与路径类指标均计算', () => {
  const result = computeForecastOutcome({ snapshot: snapshot(), located: located() });
  assert.equal(result.actualReturn, (105 - 100) / 100);
  assert.equal(result.actualDirection, 'UP');
  assert.equal(result.directionCorrect, true);
  assert.notEqual(result.mfe, null);
  assert.notEqual(result.mae, null);
});

test('真值表：endpoint完整但path不完整 => 方向类计算，路径类全部为null', () => {
  const result = computeForecastOutcome({ snapshot: snapshot(), located: located({ pathDataComplete: false, pathEligibleForStatistics: false }) });
  assert.notEqual(result.actualReturn, null);
  assert.equal(result.mfe, null);
  assert.equal(result.mae, null);
  assert.equal(result.actualHigh, null);
  assert.equal(result.actualLow, null);
  assert.equal(result.realizedRangeInsideExpectedEnvelope, null);
  assert.equal(result.expectedEnvelopeTouched, null);
  assert.equal(result.invalidationTriggered, null);
  // endpoint类指标仍可计算
  assert.notEqual(result.endpointInBaselineZone, null);
});

test('真值表：endpoint不完整（即使path完整）=> 方向类与路径类全部为null（referencePrice基准不可信）', () => {
  const result = computeForecastOutcome({ snapshot: snapshot(), located: located({ endpointDataComplete: false, directionEligibleForStatistics: false, pathEligibleForStatistics: false, actualStartPrice: null, actualEndPrice: null }) });
  assert.equal(result.actualReturn, null);
  assert.equal(result.actualDirection, null);
  assert.equal(result.directionCorrect, null);
  assert.equal(result.mfe, null);
  assert.equal(result.endpointInBaselineZone, null);
});

test('真值表：endpoint与path均不完整 => 全部为null', () => {
  const result = computeForecastOutcome({ snapshot: snapshot(), located: located({ endpointDataComplete: false, pathDataComplete: false, directionEligibleForStatistics: false, pathEligibleForStatistics: false, actualStartPrice: null, actualEndPrice: null }) });
  assert.equal(result.actualReturn, null);
  assert.equal(result.mfe, null);
  assert.equal(result.endpointInBaselineZone, null);
});

test('UP：mfe=(actualHigh-referencePrice)/referencePrice, mae=(referencePrice-actualLow)/referencePrice', () => {
  const result = computeForecastOutcome({ snapshot: snapshot({ expectedDirection: 'UP' }), located: located({ actualHigh: 110, actualLow: 95 }) });
  assert.equal(result.mfe, (110 - 100) / 100);
  assert.equal(result.mae, (100 - 95) / 100);
});
test('DOWN：mfe/mae互换方向', () => {
  const result = computeForecastOutcome({ snapshot: snapshot({ expectedDirection: 'DOWN' }), located: located({ actualHigh: 110, actualLow: 95, actualEndPrice: 90 }) });
  assert.equal(result.mfe, (100 - 95) / 100);
  assert.equal(result.mae, (110 - 100) / 100);
});
test('RANGE：mfe/mae恒为null，改用upperExcursion/lowerExcursion/maxAbsoluteExcursion/rangeBreachExcursion', () => {
  const result = computeForecastOutcome({ snapshot: snapshot({ expectedDirection: 'RANGE', directionThreshold: 0.02 }), located: located({ actualHigh: 110, actualLow: 95, actualEndPrice: 102 }) });
  assert.equal(result.mfe, null);
  assert.equal(result.mae, null);
  assert.equal(result.upperExcursion, (110 - 100) / 100);
  assert.equal(result.lowerExcursion, (100 - 95) / 100);
  assert.equal(result.maxAbsoluteExcursion, Math.max((110 - 100) / 100, (100 - 95) / 100));
  assert.equal(result.rangeBreachExcursion, Math.max(0, result.maxAbsoluteExcursion - 0.02));
});

test('区间覆盖：expectedEnvelope取三情景合并总下沿到总上沿', () => {
  const envelope = computeExpectedEnvelope({ baseline: [100, 110], upside: [110, 120], downside: [90, 100] });
  assert.deepEqual(envelope, { lower: 90, upper: 120 });
});

test('directionCorrect：directionEligibleForStatistics=false时恒为null，不得用近似值', () => {
  const result = computeForecastOutcome({ snapshot: snapshot(), located: located({ directionEligibleForStatistics: false, endpointDataComplete: false, actualStartPrice: null, actualEndPrice: null, pathEligibleForStatistics: false }) });
  assert.equal(result.directionCorrect, null);
});

test('sourceOrigin恒为SERVER', () => {
  const result = computeForecastOutcome({ snapshot: snapshot(), located: located() });
  assert.equal(result.sourceOrigin, 'SERVER');
});
