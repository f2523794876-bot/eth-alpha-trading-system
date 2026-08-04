import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePoState, PO_STATES } from '../../src/forecast/po-state-engine.js';

const base = {
  close: 100, closeToEma5: 0, trend4h: 'RANGE', trend1h: 'RANGE', volumeRatio20: 1.0,
  swingHigh: 110, swingLow: 90, breakoutState: 'NONE', upperWickRatio: 0.1, lowerWickRatio: 0.1,
  distanceToSupportAtr: 5, distanceToResistanceAtr: 5, falseBreakoutRisk: 'NONE',
  atr14FourHour: 1, qualityState: 'HEALTHY', completeness: 0.95,
  breakoutCount: null, breakdownCount: null, btcTrendState: 'RANGE', ethBtcRollingCorrelation: 0, logReturn1: 0
};

test('PO_STATES：恰好9个冻结状态', () => {
  assert.equal(PO_STATES.length, 9);
});

test('INSUFFICIENT_DATA：swingHigh缺失时不猜测', () => {
  const result = evaluatePoState({ ...base, swingHigh: NaN });
  assert.equal(result.operatingMode, 'INSUFFICIENT_DATA');
  assert.equal(result.proxyState, null);
});
test('INSUFFICIENT_DATA：4H ATR缺失或<=0时不猜测', () => {
  assert.equal(evaluatePoState({ ...base, atr14FourHour: null }).operatingMode, 'INSUFFICIENT_DATA');
  assert.equal(evaluatePoState({ ...base, atr14FourHour: 0 }).operatingMode, 'INSUFFICIENT_DATA');
});

test('PO_BREAKOUT_UP_STRUCTURE：突破且count∈{1,2}且无假突破否决', () => {
  const result = evaluatePoState({ ...base, breakoutState: 'BREAKOUT_UP', breakoutCount: 2, breakdownCount: 0, volumeRatio20: 1.5, btcTrendState: 'UP', ethBtcRollingCorrelation: 0.5, trend4h: 'UP', trend1h: 'UP' });
  assert.equal(result.proxyState, 'PO_BREAKOUT_UP_STRUCTURE');
  assert.equal(result.operatingMode, 'PRICE_ONLY_MODE');
  assert.ok(result.stateConfidence > 0 && result.stateConfidence <= 60);
});
test('PO_BREAKOUT_UP_STRUCTURE：假突破否决时不进入', () => {
  const result = evaluatePoState({ ...base, breakoutState: 'BREAKOUT_UP', breakoutCount: 2, falseBreakoutRisk: 'HIGH' });
  assert.notEqual(result.proxyState, 'PO_BREAKOUT_UP_STRUCTURE');
});
test('PO_BREAKOUT_UP_STRUCTURE：count=3不进入突破态（转入趋势判定范围）', () => {
  const result = evaluatePoState({ ...base, breakoutState: 'BREAKOUT_UP', breakoutCount: 3, trend4h: 'UP' });
  assert.notEqual(result.proxyState, 'PO_BREAKOUT_UP_STRUCTURE');
});

test('PO_BREAKDOWN_STRUCTURE：对称条件', () => {
  const result = evaluatePoState({ ...base, breakoutState: 'BREAKOUT_DOWN', breakdownCount: 1, breakoutCount: 0, btcTrendState: 'DOWN', ethBtcRollingCorrelation: 0.5 });
  assert.equal(result.proxyState, 'PO_BREAKDOWN_STRUCTURE');
});

test('PO_TREND_UP_STRUCTURE：trend4h=UP且count>=3（breakoutCount/breakdownCount同源于同一23根窗口，需同时非null）', () => {
  const result = evaluatePoState({ ...base, trend4h: 'UP', trend1h: 'UP', breakoutCount: 3, breakdownCount: 0, closeToEma5: 1 });
  assert.equal(result.proxyState, 'PO_TREND_UP_STRUCTURE');
});
test('PO_TREND_DOWN_STRUCTURE：对称条件', () => {
  const result = evaluatePoState({ ...base, trend4h: 'DOWN', trend1h: 'DOWN', breakdownCount: 3, breakoutCount: 0, closeToEma5: -1 });
  assert.equal(result.proxyState, 'PO_TREND_DOWN_STRUCTURE');
});
test('INSUFFICIENT_DATA优先于状态猜测：breakoutCount/breakdownCount任一为null时不得进入突破/跌破/趋势四态', () => {
  const result = evaluatePoState({ ...base, trend4h: 'UP', trend1h: 'UP', breakoutCount: 3, breakdownCount: null, closeToEma5: 1 });
  assert.notEqual(result.proxyState, 'PO_TREND_UP_STRUCTURE');
});

test('PO_SHARP_DROP_STRUCTURE：单bar跌幅>=3xATR相对波幅且放量>=1.8', () => {
  const result = evaluatePoState({ ...base, logReturn1: -0.05, atr14FourHour: 1, close: 100, volumeRatio20: 2.0, lowerWickRatio: 0.4 });
  assert.equal(result.proxyState, 'PO_SHARP_DROP_STRUCTURE');
});
test('PO_SHARP_DROP_STRUCTURE：跌幅不足3xATR时不触发', () => {
  const result = evaluatePoState({ ...base, logReturn1: -0.01, atr14FourHour: 1, close: 100, volumeRatio20: 2.0 });
  assert.notEqual(result.proxyState, 'PO_SHARP_DROP_STRUCTURE');
});
test('PO_SHARP_DROP_STRUCTURE：放量不足1.8时不触发（绝对阈值语义）', () => {
  const result = evaluatePoState({ ...base, logReturn1: -0.05, atr14FourHour: 1, close: 100, volumeRatio20: 1.0 });
  assert.notEqual(result.proxyState, 'PO_SHARP_DROP_STRUCTURE');
});

test('PO_RANGE_LOW_STRUCTURE：贴近支撑且trend4h∈{RANGE,DOWN}', () => {
  const result = evaluatePoState({ ...base, distanceToSupportAtr: 0.1, trend4h: 'RANGE' });
  assert.equal(result.proxyState, 'PO_RANGE_LOW_STRUCTURE');
});

test('PO_STALL_HIGH_STRUCTURE：贴近压力且滞涨', () => {
  const result = evaluatePoState({ ...base, distanceToResistanceAtr: 0.1, distanceToSupportAtr: 5, trend4h: 'RANGE', closeToEma5: -0.5 });
  assert.equal(result.proxyState, 'PO_STALL_HIGH_STRUCTURE');
});

test('PO_RANGE_RECOVERY_STRUCTURE：区间内往复', () => {
  const result = evaluatePoState({ ...base, trend4h: 'RANGE', distanceToSupportAtr: 5, distanceToResistanceAtr: 5 });
  assert.equal(result.proxyState, 'PO_RANGE_RECOVERY_STRUCTURE');
});

test('PO_UNKNOWN：无法归类的过渡态兜底', () => {
  const result = evaluatePoState({ ...base, trend4h: 'UP', distanceToSupportAtr: 5, distanceToResistanceAtr: 5 });
  assert.equal(result.proxyState, 'PO_UNKNOWN');
});

test('auxiliaryEvidence隔离：funding/OI/taker等衍生品字段即使传入也不参与状态判定（不是函数已知参数，被忽略）', () => {
  const withDerivatives = { ...base, distanceToSupportAtr: 0.1, trend4h: 'RANGE', fundingRate: -0.05, fundingRateZScore: -5, openInterestChangeRatio: -0.9, longShortRatio: 0.1 };
  const without = { ...base, distanceToSupportAtr: 0.1, trend4h: 'RANGE' };
  assert.equal(evaluatePoState(withDerivatives).proxyState, evaluatePoState(without).proxyState);
});

test('stateConfidence：completeness<0.8时扣20分，非HEALTHY时再扣15分，clamp[0,60]', () => {
  const healthy = evaluatePoState({ ...base, distanceToSupportAtr: 0.1, trend4h: 'RANGE', completeness: 0.95, qualityState: 'HEALTHY' });
  const degraded = evaluatePoState({ ...base, distanceToSupportAtr: 0.1, trend4h: 'RANGE', completeness: 0.5, qualityState: 'DEGRADED' });
  assert.ok(degraded.stateConfidence < healthy.stateConfidence);
  assert.ok(degraded.stateConfidence >= 0 && degraded.stateConfidence <= 60);
});

test('legacy lowercase trend inputs do not enter Canonical UP/DOWN/RANGE branches', () => {
  assert.equal(evaluatePoState({ ...base, trend4h: 'up', trend1h: 'up', breakoutCount: 3, breakdownCount: 0 }).proxyState, 'PO_UNKNOWN');
  assert.equal(evaluatePoState({ ...base, trend4h: 'down', trend1h: 'down', breakoutCount: 0, breakdownCount: 3 }).proxyState, 'PO_UNKNOWN');
  assert.equal(evaluatePoState({ ...base, trend4h: 'flat', distanceToSupportAtr: 0.1, breakoutCount: 0, breakdownCount: 0 }).proxyState, 'PO_UNKNOWN');
});
