// T13 computeMarketRegimeStatistics() 测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMarketRegimeStatistics } from './governance-statistics.js';

test('UP/DOWN/RANGE三态计数与coverage：全部样本trend4h已知，coverage=1', () => {
  const rows = [
    { trend4hAtGeneration: 'UP', directionCorrect: true, predictedDirection: 'UP', isDirectionSample: true, isMarketRegimeSample: true },
    { trend4hAtGeneration: 'UP', directionCorrect: false, predictedDirection: 'UP', isDirectionSample: true, isMarketRegimeSample: true },
    { trend4hAtGeneration: 'DOWN', directionCorrect: true, predictedDirection: 'DOWN', isDirectionSample: true, isMarketRegimeSample: true },
    { trend4hAtGeneration: 'RANGE', directionCorrect: null, predictedDirection: 'RANGE', isDirectionSample: false, isMarketRegimeSample: true }
  ];
  const result = computeMarketRegimeStatistics(rows);
  assert.equal(result.marketRegimeAtGeneration.UP.sampleCount, 2);
  assert.equal(result.marketRegimeAtGeneration.UP.directionCorrectCount, 1);
  assert.equal(result.marketRegimeAtGeneration.DOWN.sampleCount, 1);
  assert.equal(result.marketRegimeAtGeneration.RANGE.sampleCount, 1);
  assert.equal(result.marketRegimeCoverage, 1);
  assert.equal(result.rangeTotal, 1);
  assert.equal(result.groupTotal, 4);
});

test('未知/缺失trend4h不归入任何合法组，且降低marketRegimeCoverage', () => {
  const rows = [
    { trend4hAtGeneration: 'UP', directionCorrect: true, predictedDirection: 'UP', isDirectionSample: true, isMarketRegimeSample: true },
    { trend4hAtGeneration: null, directionCorrect: true, predictedDirection: 'UP', isDirectionSample: true, isMarketRegimeSample: true },
    { trend4hAtGeneration: 'UNKNOWN_STATE', directionCorrect: false, predictedDirection: 'DOWN', isDirectionSample: true, isMarketRegimeSample: true }
  ];
  const result = computeMarketRegimeStatistics(rows);
  assert.equal(result.marketRegimeAtGeneration.UP.sampleCount, 1, '未知trend不得被伪装归入UP');
  assert.equal(result.groupTotal, 1);
  assert.equal(result.marketRegimeCoverage, 1 / 3);
});

test('effectiveTest=0（无market-regime-eligible样本）时coverage为null，不是0', () => {
  const result = computeMarketRegimeStatistics([]);
  assert.equal(result.marketRegimeCoverage, null);
  assert.equal(result.directionalCoverage, null);
  assert.equal(result.rangeTotal, 0);
  assert.equal(result.diagnostics.rangeClassAbsent, true);
});

test('directionalCoverage只统计isDirectionSample样本中predictedDirection为UP/DOWN的比例（RANGE预测不计入分子）', () => {
  const rows = [
    { trend4hAtGeneration: 'UP', directionCorrect: true, predictedDirection: 'UP', isDirectionSample: true, isMarketRegimeSample: true },
    { trend4hAtGeneration: 'RANGE', directionCorrect: null, predictedDirection: 'RANGE', isDirectionSample: true, isMarketRegimeSample: true }
  ];
  const result = computeMarketRegimeStatistics(rows);
  assert.equal(result.directionalCoverage, 0.5);
});

test('不接受非数组输入', () => {
  assert.throws(() => computeMarketRegimeStatistics(null), TypeError);
  assert.throws(() => computeMarketRegimeStatistics({}), TypeError);
});

test('输出对象不可变（Object.freeze）', () => {
  const result = computeMarketRegimeStatistics([{ trend4hAtGeneration: 'UP', directionCorrect: true, predictedDirection: 'UP', isDirectionSample: true, isMarketRegimeSample: true }]);
  assert.throws(() => { result.rangeTotal = 999; }, TypeError);
  assert.throws(() => { result.marketRegimeAtGeneration.UP.sampleCount = 999; }, TypeError);
});
