// 实时看板view model纯函数单元测试——直接驱动真实生产函数（buildMarketState/buildDirectionForecast/
// deriveTradingPermission），不重新实现一套简化逻辑绕开真实代码路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketState, buildDirectionForecast } from '../src/dashboard/realtime-view.js';
import { deriveTradingPermission } from '../src/dashboard/trading-permission.js';

const REF = { openTime: 1000, closeTime: 1899, open: 100, high: 102, low: 99, close: 100 };

test('实时市场状态：无任何已完成K线时数据不足，不用0代替', () => {
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar: null, referenceBar: null, now: 5000 });
  assert.equal(state.status, 'INSUFFICIENT_DATA');
  assert.equal(state.price, null);
  assert.equal(state.changeAbs, null);
  assert.equal(state.changePct, null);
  assert.equal(state.momentum, 'INSUFFICIENT_DATA');
});

test('实时市场状态：有进行中K线时按进行中价格计算涨跌，比较基准为上一根已完成K线', () => {
  const currentBar = { openTime: 1900, closeTime: 2799, open: 100, high: 106, low: 100, close: 105, fetchedAt: 2500 };
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar, referenceBar: REF, now: 2600 });
  assert.equal(state.status, 'LIVE');
  assert.equal(state.priceSource, 'LIVE_PROVISIONAL_CANDLE');
  assert.equal(state.price, 105);
  assert.equal(state.changeAbs, 5);
  assert.equal(state.changePct, 0.05);
  assert.deepEqual(state.changeBasis, { type: 'PREVIOUS_CLOSED_15M_CANDLE', closeTime: REF.closeTime, closePrice: REF.close });
  assert.equal(state.dataTime, 2500);
});

test('实时市场状态：只有已完成K线、无进行中快照时如实标注LAST_CLOSED_ONLY，不冒充实时', () => {
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar: null, referenceBar: REF, now: 5000 });
  assert.equal(state.status, 'LAST_CLOSED_ONLY');
  assert.equal(state.priceSource, 'LAST_CLOSED_CANDLE');
  assert.equal(state.price, REF.close);
  assert.equal(state.changeAbs, 0);
  assert.equal(state.momentum, 'INSUFFICIENT_DATA', '仓库当前无既有动量计算逻辑，不得发明新公式冒充模型输出');
});

function snapshot(overrides = {}) {
  return {
    predictionId: 'GMKG-SRV-ETHUSDT-24h-1899-v1', instrument: 'ETHUSDT', horizon: '24h',
    generatedAt: 2000, dataCutoffTime: 2000, targetStartTime: 1900, targetEndTime: 999999,
    referencePrice: 100, expectedDirection: 'UP',
    scenarioWeights: { baseline: 30, upside: 50, downside: 20 },
    probabilityStatus: 'rule_based',
    expectedPriceZones: { baseline: [95, 105], upside: [110, 120], downside: [80, 90] },
    triggerConditions: ['24h目标窗口内，若15分钟已收盘价格突破upsideScenario.priceZone下沿，视为upside情景触发确认'],
    invalidationConditions: ['若24h目标窗口内已收盘价格跌破downsideScenario.priceZone上沿，视为baseline/upside情景证据减弱'],
    ...overrides
  };
}

test('方向预测：无快照时NOT_YET_GENERATED，不伪造概率或目标位', () => {
  const f = buildDirectionForecast({ horizon: '24h', snapshot: null, now: 1000 });
  assert.equal(f.status, 'NOT_YET_GENERATED');
  assert.equal(f.up, null); assert.equal(f.down, null); assert.equal(f.range, null);
});

test('方向预测：有效快照时UP/DOWN/RANGE三向概率与目标区间完整映射', () => {
  const f = buildDirectionForecast({ horizon: '24h', snapshot: snapshot(), now: 2500 });
  assert.equal(f.status, 'ACTIVE');
  assert.equal(f.up.probabilityPct, 50);
  assert.deepEqual(f.up.targetZone, [110, 120]);
  assert.equal(f.down.probabilityPct, 20);
  assert.deepEqual(f.down.targetZone, [80, 90]);
  assert.equal(f.range.probabilityPct, 30);
  assert.equal(f.range.upperBound, 105);
  assert.equal(f.range.lowerBound, 95);
});

test('方向预测：多头触发/失效条件来自真实模板，空头与RANGE的触发/失效如实标注尚未生成（不臆造对称文案）', () => {
  const f = buildDirectionForecast({ horizon: '24h', snapshot: snapshot(), now: 2500 });
  assert.match(f.up.triggerCondition, /upside情景触发确认/);
  assert.match(f.up.invalidationCondition, /baseline\/upside情景证据减弱/);
  assert.equal(f.down.triggerCondition, 'NOT_YET_GENERATED');
  assert.equal(f.down.invalidationCondition, 'NOT_YET_GENERATED');
  assert.equal(f.range.triggerCondition, 'NOT_YET_GENERATED');
  assert.equal(f.range.invalidationCondition, 'NOT_YET_GENERATED');
});

test('方向预测：预测生成时间与到期时间不与数据时间混淆', () => {
  const f = buildDirectionForecast({ horizon: '24h', snapshot: snapshot({ generatedAt: 3000, targetEndTime: 999999 }), now: 3500 });
  assert.equal(f.generatedAt, 3000);
  assert.equal(f.targetEndTime, 999999);
  assert.notEqual(f.generatedAt, f.targetEndTime);
});

test('方向预测：超过到期时间标注EXPIRED_AWAITING_NEXT_GENERATION，但字段仍保留可见（不清空）', () => {
  const f = buildDirectionForecast({ horizon: '24h', snapshot: snapshot({ targetEndTime: 2000 }), now: 5000 });
  assert.equal(f.status, 'EXPIRED_AWAITING_NEXT_GENERATION');
  assert.equal(f.up.probabilityPct, 50, '过期不代表隐藏方向预测数据');
});

test('方向预测：24H与72H严格分开，各自独立映射不串数据', () => {
  const f24 = buildDirectionForecast({ horizon: '24h', snapshot: snapshot({ horizon: '24h', referencePrice: 100 }), now: 2500 });
  const f72 = buildDirectionForecast({ horizon: '72h', snapshot: snapshot({ horizon: '72h', referencePrice: 200, scenarioWeights: { baseline: 40, upside: 35, downside: 25 } }), now: 2500 });
  assert.equal(f24.horizon, '24h'); assert.equal(f72.horizon, '72h');
  assert.equal(f24.referencePrice, 100); assert.equal(f72.referencePrice, 200);
  assert.equal(f24.up.probabilityPct, 50); assert.equal(f72.up.probabilityPct, 35);
});

test('交易许可：数据健康降级时BLOCK，原因明确', () => {
  const p = deriveTradingPermission({ dataHealthy: false, marketState: null, forecast24h: null, forecast72h: null });
  assert.equal(p.mode, 'BLOCK');
  assert.equal(p.reason, 'DATA_HEALTH_DEGRADED');
});

test('交易许可：当前价格数据不足时BLOCK', () => {
  const p = deriveTradingPermission({ dataHealthy: true, marketState: { status: 'INSUFFICIENT_DATA' }, forecast24h: null, forecast72h: null });
  assert.equal(p.mode, 'BLOCK');
  assert.equal(p.reason, 'MARKET_STATE_UNAVAILABLE');
});

test('交易许可：24H/72H预测均不可用或已过期时BLOCK', () => {
  const p = deriveTradingPermission({
    dataHealthy: true, marketState: { status: 'LIVE' },
    forecast24h: { status: 'NOT_YET_GENERATED' }, forecast72h: { status: 'EXPIRED_AWAITING_NEXT_GENERATION' }
  });
  assert.equal(p.mode, 'BLOCK');
  assert.equal(p.reason, 'NO_ACTIVE_FORECAST');
});

test('交易许可：数据健康且至少一个预测ACTIVE时为OBSERVE（系统当前上限，从不伪造ALLOW/PREPARE）', () => {
  const p = deriveTradingPermission({
    dataHealthy: true, marketState: { status: 'LIVE' },
    forecast24h: { status: 'ACTIVE' }, forecast72h: { status: 'NOT_YET_GENERATED' }
  });
  assert.equal(p.mode, 'OBSERVE');
  assert.equal(p.reason, 'RULE_BASED_PROBABILITY_ONLY');
});

test('交易许可：ALLOW/PREPARE在当前系统实现下不可达——probability_status恒为rule_based，无校准概率支撑更高许可等级', () => {
  const scenarios = [
    { dataHealthy: true, marketState: { status: 'LIVE' }, forecast24h: { status: 'ACTIVE' }, forecast72h: { status: 'ACTIVE' } },
    { dataHealthy: false, marketState: { status: 'LIVE' }, forecast24h: { status: 'ACTIVE' }, forecast72h: { status: 'ACTIVE' } },
    { dataHealthy: true, marketState: { status: 'INSUFFICIENT_DATA' }, forecast24h: { status: 'ACTIVE' }, forecast72h: { status: 'ACTIVE' } }
  ];
  for (const s of scenarios) assert.ok(['OBSERVE', 'BLOCK'].includes(deriveTradingPermission(s).mode));
});
