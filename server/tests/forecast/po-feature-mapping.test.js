import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveBtcDirection, btcAlignmentServer, isNearSupport, isNearResistance, isFalseBreakoutVetoed, CORRELATION_FLOOR } from '../../src/forecast/po-feature-mapping.js';

test('BTC对齐：正相关(>=+0.3)沿用btcTrendState方向', () => {
  assert.equal(effectiveBtcDirection(0.5, 'UP'), 'UP');
  assert.equal(effectiveBtcDirection(0.5, 'DOWN'), 'DOWN');
});
test('BTC对齐：正相关边界(=+0.3)含边界', () => {
  assert.equal(effectiveBtcDirection(0.3, 'UP'), 'UP');
});
test('BTC对齐：负相关(<=-0.3)取反', () => {
  assert.equal(effectiveBtcDirection(-0.5, 'UP'), 'DOWN');
  assert.equal(effectiveBtcDirection(-0.5, 'DOWN'), 'UP');
});
test('BTC对齐：负相关边界(=-0.3)含边界取反', () => {
  assert.equal(effectiveBtcDirection(-0.3, 'UP'), 'DOWN');
});
test('BTC对齐：|correlation|<0.3为UNKNOWN', () => {
  assert.equal(effectiveBtcDirection(0.29, 'UP'), 'UNKNOWN');
  assert.equal(effectiveBtcDirection(-0.29, 'UP'), 'UNKNOWN');
  assert.equal(effectiveBtcDirection(0, 'UP'), 'UNKNOWN');
});
test('BTC对齐：缺失/NaN/Infinity/BTC趋势缺失或RANGE恒为UNKNOWN，不得默认SUPPORT/ALIGNED', () => {
  assert.equal(effectiveBtcDirection(NaN, 'UP'), 'UNKNOWN');
  assert.equal(effectiveBtcDirection(Infinity, 'UP'), 'UNKNOWN');
  assert.equal(effectiveBtcDirection(0.5, null), 'UNKNOWN');
  assert.equal(effectiveBtcDirection(0.5, 'RANGE'), 'UNKNOWN');
  assert.equal(effectiveBtcDirection(undefined, 'UP'), 'UNKNOWN');
});

test('btcAlignmentServer：正相关+同向=SUPPORT', () => {
  assert.equal(btcAlignmentServer('UP', 'UP', 0.5), 'SUPPORT');
});
test('btcAlignmentServer：正相关+反向=OPPOSE', () => {
  assert.equal(btcAlignmentServer('DOWN', 'UP', 0.5), 'OPPOSE');
});
test('btcAlignmentServer：负相关+候选方向与effective相反时=OPPOSE（考察符号反转后再比较）', () => {
  // correlation=-0.5, btcTrendState=UP => effective=DOWN；candidateDirection=DOWN => 同向 => SUPPORT
  assert.equal(btcAlignmentServer('DOWN', 'UP', -0.5), 'SUPPORT');
  assert.equal(btcAlignmentServer('UP', 'UP', -0.5), 'OPPOSE');
});
test('btcAlignmentServer：任一方为UNKNOWN时结果为UNKNOWN', () => {
  assert.equal(btcAlignmentServer('UP', 'UP', 0.1), 'UNKNOWN');
  assert.equal(btcAlignmentServer('RANGE', 'UP', 0.5), 'UNKNOWN');
});
test('legacy lowercase BTC and candidate trends are rejected rather than normalized', () => {
  for (const legacy of ['up', 'down', 'flat']) assert.equal(effectiveBtcDirection(0.5, legacy), 'UNKNOWN');
  assert.equal(btcAlignmentServer('up', 'UP', 0.5), 'UNKNOWN');
  assert.equal(btcAlignmentServer('down', 'DOWN', 0.5), 'UNKNOWN');
});
test('CORRELATION_FLOOR冻结值为0.3', () => { assert.equal(CORRELATION_FLOOR, 0.3); });

test('isNearSupport/isNearResistance：ATR归一化距离在容差内为true', () => {
  assert.equal(isNearSupport(0.2), true);
  assert.equal(isNearSupport(0.3), true);
  assert.equal(isNearSupport(0.31), false);
  assert.equal(isNearResistance(0.29), true);
  assert.equal(isNearSupport(NaN), false);
});

test('isFalseBreakoutVetoed：NONE和null不否决，其他非空值否决', () => {
  assert.equal(isFalseBreakoutVetoed('NONE'), false);
  assert.equal(isFalseBreakoutVetoed(null), false);
  assert.equal(isFalseBreakoutVetoed('HIGH'), true);
  assert.equal(isFalseBreakoutVetoed('LOW'), true);
});
