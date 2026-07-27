import test from 'node:test';
import assert from 'node:assert/strict';
import { computePoStateDistribution, computeStateTransitionMatrix, computeInputConditionHitRates, buildPoDiagnosticReport } from './po-diagnostic.js';

test('computePoStateDistribution：只统计directionEligibleForStatistics=true的样本作为effective分母', () => {
  const samples = [
    { proxyStateAtGeneration: 'PO_UNKNOWN', targetStartTime: 1, directionEligibleForStatistics: true },
    { proxyStateAtGeneration: 'PO_UNKNOWN', targetStartTime: 2, directionEligibleForStatistics: true },
    { proxyStateAtGeneration: 'PO_TREND_UP_STRUCTURE', targetStartTime: 3, directionEligibleForStatistics: true },
    { proxyStateAtGeneration: 'PO_TREND_UP_STRUCTURE', targetStartTime: 4, directionEligibleForStatistics: false } // 不计入effective
  ];
  const { poStateDistribution, poUnknownShare, effectiveTotal } = computePoStateDistribution(samples);
  assert.equal(effectiveTotal, 3);
  assert.equal(poStateDistribution.PO_UNKNOWN.rawCount, 2);
  assert.equal(poStateDistribution.PO_UNKNOWN.effectiveCount, 2);
  assert.equal(poStateDistribution.PO_TREND_UP_STRUCTURE.rawCount, 2);
  assert.equal(poStateDistribution.PO_TREND_UP_STRUCTURE.effectiveCount, 1);
  assert.ok(Math.abs(poUnknownShare - 2 / 3) < 1e-9);
});

test('computeStateTransitionMatrix：按targetStartTime排序后统计相邻proxyState转移计数', () => {
  const samples = [
    { proxyStateAtGeneration: 'PO_UNKNOWN', targetStartTime: 2000 },
    { proxyStateAtGeneration: 'PO_TREND_UP_STRUCTURE', targetStartTime: 1000 },
    { proxyStateAtGeneration: 'PO_UNKNOWN', targetStartTime: 3000 }
  ];
  const matrix = computeStateTransitionMatrix(samples);
  // 排序后顺序: TREND_UP(1000) -> UNKNOWN(2000) -> UNKNOWN(3000)
  assert.equal(matrix.PO_TREND_UP_STRUCTURE.PO_UNKNOWN, 1);
  assert.equal(matrix.PO_UNKNOWN.PO_UNKNOWN, 1);
});

test('computeInputConditionHitRates：命中率按featureValuesList总数计算，空数组返回{}', () => {
  assert.deepEqual(computeInputConditionHitRates([]), {});
  const rates = computeInputConditionHitRates([
    { trend4h: 'up', breakoutState: 'BREAKOUT_UP', falseBreakoutRisk: 'NONE', swingHigh: 1, swingLow: 1 },
    { trend4h: 'down', breakoutState: null, falseBreakoutRisk: 'HIGH', swingHigh: null, swingLow: 1 }
  ]);
  assert.equal(rates.trend4hUp, 0.5);
  assert.equal(rates.trend4hDown, 0.5);
  assert.equal(rates.breakoutStateUp, 0.5);
  assert.equal(rates.falseBreakoutVetoed, 0.5);
  assert.equal(rates.swingHighOrLowMissing, 0.5);
});

test('buildPoDiagnosticReport：persistentUnknownDiagnosis只收集证据，不产出结论/数值建议', () => {
  const report = buildPoDiagnosticReport({ samples: [], featureValuesList: [], missingFeatureShare: 0.4 });
  assert.deepEqual(Object.keys(report.persistentUnknownDiagnosis).sort(), [
    'inputFieldsLongTermMissing', 'marketTrulyStructureless', 'stateEngineImplementationError', 'thresholdTooStrict'
  ]);
  assert.match(report.persistentUnknownDiagnosis.inputFieldsLongTermMissing.evidence[0], /0\.4/);
  assert.deepEqual(report.persistentUnknownDiagnosis.marketTrulyStructureless.evidence, []);
});
