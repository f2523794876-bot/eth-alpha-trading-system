import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFourHourAtr14FromBars, computeDirectionThreshold, classifyDirection, clamp } from '../../src/forecast/threshold-formula.js';

function bar(high, low, close) { return { high, low, close }; }

test('ATR14 4H：恰好15根bar，14个TR样本均值', () => {
  const bars = [bar(100, 90, 95)];
  for (let i = 0; i < 14; i++) bars.push(bar(96 + i, 94 + i, 95 + i));
  const atr = computeFourHourAtr14FromBars(bars);
  assert.ok(Number.isFinite(atr) && atr > 0);
});

test('ATR14 4H：14根bar（数量不足）拒绝', () => {
  const bars = [bar(100, 90, 95)];
  for (let i = 0; i < 13; i++) bars.push(bar(96, 94, 95));
  assert.throws(() => computeFourHourAtr14FromBars(bars), error => error.code === 'ATR14_4H_INSUFFICIENT');
});

test('ATR14 4H：16根bar（数量过多）拒绝', () => {
  const bars = [];
  for (let i = 0; i < 16; i++) bars.push(bar(100, 90, 95));
  assert.throws(() => computeFourHourAtr14FromBars(bars), error => error.code === 'ATR14_4H_INSUFFICIENT');
});

test('ATR14 4H：非有限OHLC拒绝', () => {
  const bars = [bar(100, 90, 95)];
  for (let i = 0; i < 13; i++) bars.push(bar(96, 94, 95));
  bars.push(bar(NaN, 94, 95));
  assert.throws(() => computeFourHourAtr14FromBars(bars), error => error.code === 'ATR14_4H_INSUFFICIENT');
});

test('directionThreshold：24h clamp参数', () => {
  const result = computeDirectionThreshold({ atr14FourHourAtGeneration: 1, referencePrice: 1000, horizon: '24h' });
  assert.equal(result.thresholdFloor, 0.008);
  assert.equal(result.thresholdCeiling, 0.05);
  assert.equal(result.thresholdFormulaVersion, 'v1.4c-threshold-formula-2');
  assert.equal(result.directionThreshold, clamp(result.rawThreshold, 0.008, 0.05));
});

test('directionThreshold：72h clamp参数', () => {
  const result = computeDirectionThreshold({ atr14FourHourAtGeneration: 1, referencePrice: 1000, horizon: '72h' });
  assert.equal(result.thresholdFloor, 0.015);
  assert.equal(result.thresholdCeiling, 0.08);
});

test('directionThreshold：rawThreshold低于floor时clamp到floor（极小ATR）', () => {
  const result = computeDirectionThreshold({ atr14FourHourAtGeneration: 0.0001, referencePrice: 100000, horizon: '24h' });
  assert.equal(result.directionThreshold, 0.008);
});

test('directionThreshold：rawThreshold高于ceiling时clamp到ceiling（极大ATR）', () => {
  const result = computeDirectionThreshold({ atr14FourHourAtGeneration: 1000, referencePrice: 100, horizon: '24h' });
  assert.equal(result.directionThreshold, 0.05);
});

test('directionThreshold：referencePrice<=0拒绝', () => {
  assert.throws(() => computeDirectionThreshold({ atr14FourHourAtGeneration: 1, referencePrice: 0, horizon: '24h' }), error => error.code === 'ATR14_4H_INSUFFICIENT');
});

test('directionThreshold：非法horizon拒绝', () => {
  assert.throws(() => computeDirectionThreshold({ atr14FourHourAtGeneration: 1, referencePrice: 100, horizon: '48h' }), error => error.code === 'INVALID_HORIZON');
});

test('方向判定：actualReturn恰好等于+threshold为UP边界', () => {
  assert.equal(classifyDirection(0.02, 0.02), 'UP');
});
test('方向判定：actualReturn恰好等于-threshold为DOWN边界', () => {
  assert.equal(classifyDirection(-0.02, 0.02), 'DOWN');
});
test('方向判定：threshold区间内为RANGE', () => {
  assert.equal(classifyDirection(0.01, 0.02), 'RANGE');
  assert.equal(classifyDirection(-0.01, 0.02), 'RANGE');
});
test('方向判定：非有限输入返回null', () => {
  assert.equal(classifyDirection(NaN, 0.02), null);
  assert.equal(classifyDirection(0.01, Infinity), null);
});
