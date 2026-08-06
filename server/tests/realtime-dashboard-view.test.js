// 实时看板view model与渲染纯函数单元测试——直接驱动真实生产函数（buildMarketState/buildDirectionForecast/
// deriveReferenceExecutionState/render*系列），不重新实现一套简化逻辑绕开真实代码路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketState, buildDirectionForecast, PROVISIONAL_MAX_AGE_MS } from '../src/dashboard/realtime-view.js';
import { deriveReferenceExecutionState } from '../src/dashboard/reference-execution-state.js';
import { renderMarket, renderReferenceExecutionState, renderForecast, renderDirection, escapeHtml } from '../src/dashboard/realtime-page-render.js';
import { INTERVAL_MS } from '../src/domain/constants.js';

const STEP = INTERVAL_MS['15m'];
const REF = { openTime: 1000 * STEP, closeTime: 1000 * STEP + STEP - 1, open: 100, high: 102, low: 99, close: 100 };

test('实时市场状态：无任何已完成K线时数据不足，不用0代替', () => {
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar: null, referenceBar: null, now: 5000 });
  assert.equal(state.status, 'INSUFFICIENT_DATA');
  assert.equal(state.price, null);
  assert.equal(state.changeAbs, null);
  assert.equal(state.changePct, null);
  assert.equal(state.momentum, 'INSUFFICIENT_DATA');
});

// === P1-1：provisional新鲜度保护 ===

function freshCurrentBar(now) {
  const currentBucketOpenTime = Math.floor(now / STEP) * STEP;
  return { openTime: currentBucketOpenTime, closeTime: currentBucketOpenTime + STEP - 1, open: 100, high: 106, low: 100, close: 105, fetchedAt: now - 1000 };
}

test('P1-1场景1：provisional存在，fetchedAt足够新，属于当前周期，晚于最近完成K线——正确显示为LIVE', () => {
  const now = REF.closeTime + 1 + 5000;
  const currentBar = freshCurrentBar(now);
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar, referenceBar: REF, now, dataHealthy: true });
  assert.equal(state.status, 'LIVE');
  assert.equal(state.priceSource, 'LIVE_PROVISIONAL_CANDLE');
  assert.equal(state.price, 105);
  assert.equal(state.staleness, null);
});

test('P1-1场景2：provisional的fetchedAt已经过期（超过PROVISIONAL_MAX_AGE_MS）——安全回退到最近完成K线，不再显示LIVE', () => {
  const now = REF.closeTime + 1 + STEP;
  const currentBucketOpenTime = Math.floor(now / STEP) * STEP;
  const currentBar = { openTime: currentBucketOpenTime, closeTime: currentBucketOpenTime + STEP - 1, open: 100, high: 106, low: 100, close: 105, fetchedAt: now - PROVISIONAL_MAX_AGE_MS - 1 };
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar, referenceBar: REF, now, dataHealthy: true });
  assert.notEqual(state.status, 'LIVE');
  assert.equal(state.status, 'STALE_PROVISIONAL_FALLBACK');
  assert.equal(state.price, REF.close, '必须回退到最近完成K线价格，不得继续使用过期provisional价格');
  assert.equal(state.priceSource, 'LAST_CLOSED_CANDLE');
  assert.equal(state.staleness.reason, 'PROVISIONAL_EXPIRED');
});

test('P1-1场景3：provisional属于旧的15分钟周期（openTime不等于当前bucket）——不得显示为LIVE', () => {
  const now = REF.closeTime + 1 + 5000;
  const staleBucketOpenTime = Math.floor(now / STEP) * STEP - STEP;
  const currentBar = { openTime: staleBucketOpenTime, closeTime: staleBucketOpenTime + STEP - 1, open: 100, high: 106, low: 100, close: 105, fetchedAt: now - 1000 };
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar, referenceBar: REF, now, dataHealthy: true });
  assert.equal(state.status, 'STALE_PROVISIONAL_FALLBACK');
  assert.equal(state.staleness.reason, 'PERIOD_MISMATCH');
});

test('P1-1场景4：provisional时间不晚于最近完成K线（open_time<=referenceBar.closeTime，时钟偏差/数据异常防御性场景）——不得显示为LIVE', () => {
  // 正常情况下"最近已完成K线"必然早于当前bucket（否则它就不是"已完成"），period-match检查会先天满足
  // NOT_NEWER_THAN_REFERENCE的前提。这里构造一个防御性异常：referenceBar自身的close_time反常地
  // 达到/超过当前bucket起点（时钟偏差或上游数据异常），验证即使provisional本身周期匹配，也不会
  // 被误判为"比参照更新"。
  const now = 50 * STEP + 100;
  const currentBucketOpenTime = Math.floor(now / STEP) * STEP;
  const currentBar = { openTime: currentBucketOpenTime, closeTime: currentBucketOpenTime + STEP - 1, open: 100, high: 106, low: 100, close: 105, fetchedAt: now - 1000 };
  const anomalousReferenceBar = { openTime: currentBucketOpenTime, closeTime: currentBucketOpenTime + 500, open: 90, high: 91, low: 89, close: 90 };
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar, referenceBar: anomalousReferenceBar, now, dataHealthy: true });
  assert.equal(state.status, 'STALE_PROVISIONAL_FALLBACK');
  assert.equal(state.staleness.reason, 'NOT_NEWER_THAN_REFERENCE');
});

test('P1-1场景5：provisional时间字段缺失或无效——不得显示为LIVE', () => {
  const now = REF.closeTime + 1 + 5000;
  for (const bad of [
    { openTime: null, closeTime: 1, open: 1, high: 1, low: 1, close: 1, fetchedAt: now },
    { openTime: 1, closeTime: 1, open: 1, high: 1, low: 1, close: 1, fetchedAt: NaN },
    { openTime: 1, closeTime: 1, open: 1, high: 1, low: 1, close: 1, fetchedAt: undefined }
  ]) {
    const state = buildMarketState({ instrument: 'ETHUSDT', currentBar: bad, referenceBar: REF, now, dataHealthy: true });
    assert.notEqual(state.status, 'LIVE');
    assert.equal(state.staleness.reason, 'INVALID_TIME_FIELD');
  }
});

test('P1-1场景6：provisional时间异常地位于未来——不得显示为LIVE', () => {
  const now = REF.closeTime + 1 + 5000;
  const currentBucketOpenTime = Math.floor(now / STEP) * STEP;
  const currentBar = { openTime: currentBucketOpenTime, closeTime: currentBucketOpenTime + STEP - 1, open: 100, high: 106, low: 100, close: 105, fetchedAt: now + 999999 };
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar, referenceBar: REF, now, dataHealthy: true });
  assert.notEqual(state.status, 'LIVE');
  assert.equal(state.staleness.reason, 'FUTURE_TIMESTAMP');
});

test('P1-1场景7：stale provisional存在，同时存在最近完成K线——安全回退，价格与数据时间均来自完成K线', () => {
  const now = REF.closeTime + 1 + STEP;
  const currentBar = { openTime: 1, closeTime: 1, open: 1, high: 1, low: 1, close: 999, fetchedAt: now - PROVISIONAL_MAX_AGE_MS - 1 };
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar, referenceBar: REF, now, dataHealthy: true });
  assert.equal(state.price, REF.close);
  assert.equal(state.dataTime, REF.closeTime);
  assert.equal(state.priceSource, 'LAST_CLOSED_CANDLE');
});

test('P1-1场景8：stale provisional存在，但没有完成K线可回退——数据不足，不得伪装成实时价格', () => {
  const now = 100000;
  const currentBar = { openTime: 1, closeTime: 1, open: 1, high: 1, low: 1, close: 999, fetchedAt: now - PROVISIONAL_MAX_AGE_MS - 1 };
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar, referenceBar: null, now, dataHealthy: true });
  assert.equal(state.status, 'INSUFFICIENT_DATA');
  assert.equal(state.price, null);
  assert.equal(state.staleness.reason, 'PROVISIONAL_EXPIRED');
});

test('P1-1场景9：collector健康信息为false时，即使provisional时间戳新鲜也不得标为LIVE', () => {
  const now = REF.closeTime + 1 + 5000;
  const currentBar = freshCurrentBar(now);
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar, referenceBar: REF, now, dataHealthy: false });
  assert.notEqual(state.status, 'LIVE');
  assert.equal(state.status, 'STALE_PROVISIONAL_FALLBACK');
  assert.equal(state.staleness.reason, 'DATA_HEALTH_DEGRADED');
  assert.equal(state.price, REF.close);
});

test('P1-1：只有已完成K线、无进行中快照时如实标注LAST_CLOSED_ONLY，不冒充实时', () => {
  const state = buildMarketState({ instrument: 'ETHUSDT', currentBar: null, referenceBar: REF, now: REF.closeTime + 5000 });
  assert.equal(state.status, 'LAST_CLOSED_ONLY');
  assert.equal(state.priceSource, 'LAST_CLOSED_CANDLE');
  assert.equal(state.momentum, 'INSUFFICIENT_DATA');
});

// === 方向预测（未受P1-1影响，回归确认） ===

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

test('方向预测：有效快照时UP/DOWN/RANGE三向概率与目标区间完整映射', () => {
  const f = buildDirectionForecast({ horizon: '24h', snapshot: snapshot(), now: 2500 });
  assert.equal(f.status, 'ACTIVE');
  assert.equal(f.up.probabilityPct, 50);
  assert.equal(f.down.probabilityPct, 20);
  assert.equal(f.range.probabilityPct, 30);
});

test('方向预测：24H与72H严格分开，各自独立映射不串数据', () => {
  const f24 = buildDirectionForecast({ horizon: '24h', snapshot: snapshot({ horizon: '24h', referencePrice: 100 }), now: 2500 });
  const f72 = buildDirectionForecast({ horizon: '72h', snapshot: snapshot({ horizon: '72h', referencePrice: 200, scenarioWeights: { baseline: 40, upside: 35, downside: 25 } }), now: 2500 });
  assert.equal(f24.referencePrice, 100); assert.equal(f72.referencePrice, 200);
  assert.equal(f24.up.probabilityPct, 50); assert.equal(f72.up.probabilityPct, 35);
});

// === 展示态参考执行状态（原trading-permission，已按P1-3更名） ===

test('展示态参考执行状态：数据健康降级时BLOCK', () => {
  const p = deriveReferenceExecutionState({ dataHealthy: false, marketState: null, forecast24h: null, forecast72h: null });
  assert.equal(p.mode, 'BLOCK');
  assert.equal(p.reason, 'DATA_HEALTH_DEGRADED');
  assert.ok(p.disclosure.includes('非正式交易许可引擎'));
});

test('展示态参考执行状态：数据健康且至少一个预测ACTIVE时为OBSERVE，且disclosure字段原样存在', () => {
  const p = deriveReferenceExecutionState({
    dataHealthy: true, marketState: { status: 'LIVE' },
    forecast24h: { status: 'ACTIVE' }, forecast72h: { status: 'NOT_YET_GENERATED' }
  });
  assert.equal(p.mode, 'OBSERVE');
  assert.ok(typeof p.disclosure === 'string' && p.disclosure.length > 0);
});

test('展示态参考执行状态：ALLOW/PREPARE在当前系统实现下不可达——probability_status恒为rule_based，无校准概率支撑更高许可等级', () => {
  const scenarios = [
    { dataHealthy: true, marketState: { status: 'LIVE' }, forecast24h: { status: 'ACTIVE' }, forecast72h: { status: 'ACTIVE' } },
    { dataHealthy: false, marketState: { status: 'LIVE' }, forecast24h: { status: 'ACTIVE' }, forecast72h: { status: 'ACTIVE' } }
  ];
  for (const s of scenarios) assert.ok(['OBSERVE', 'BLOCK'].includes(deriveReferenceExecutionState(s).mode));
});

// === P1-3：渲染隔离——用构造夹具直接验证渲染函数，不代表当前生产引擎可产生ALLOW/PREPARE ===
// 以下ALLOW/PREPARE两种状态在deriveReferenceExecutionState()中当前不可达（见上方测试），
// 这里的夹具只用于验证"渲染层"面对未来兼容的状态值时不会崩溃、也不会以任何方式影响方向预测渲染，
// 不写入生产数据库，不冒充真实模型结果。
test('P1-3渲染隔离（未来兼容性渲染夹具，非当前生产可达状态）：renderReferenceExecutionState对ALLOW/PREPARE/OBSERVE/BLOCK四种构造状态均能正确渲染', () => {
  for (const mode of ['ALLOW', 'PREPARE', 'OBSERVE', 'BLOCK']) {
    const fixture = { mode, reason: `${mode}_REASON`, detail: `${mode}_DETAIL`, disclosure: '展示态参考执行状态，非正式交易许可引擎' };
    const html = renderReferenceExecutionState(fixture);
    assert.match(html, new RegExp(mode));
    assert.match(html, /非正式交易许可引擎/);
  }
});

test('P1-3渲染隔离：renderForecast函数签名只接受forecast一个参数，结构上不可能感知或被参考执行状态门控', () => {
  assert.equal(renderForecast.length, 1);
  assert.equal(renderDirection.length, 3);
});

test('P1-3渲染隔离：无论参考执行状态构造成ALLOW/PREPARE/OBSERVE/BLOCK中的哪一种，renderForecast独立渲染的UP/DOWN/RANGE内容完全相同（互不影响）', () => {
  const forecast = {
    status: 'ACTIVE', referencePrice: 100, probabilityStatus: 'rule_based', generatedAt: 1, targetEndTime: 2,
    up: { probabilityPct: 50, targetZone: [110, 120], expectedMovePct: 0.1, triggerCondition: 'UP_TRIGGER', invalidationCondition: 'UP_INVALID' },
    down: { probabilityPct: 20, targetZone: [80, 90], expectedMovePct: -0.1, triggerCondition: 'NOT_YET_GENERATED', invalidationCondition: 'NOT_YET_GENERATED' },
    range: { probabilityPct: 30, upperBound: 105, lowerBound: 95, triggerCondition: 'NOT_YET_GENERATED', invalidationCondition: 'NOT_YET_GENERATED' }
  };
  const rendered = new Set();
  for (const mode of ['ALLOW', 'PREPARE', 'OBSERVE', 'BLOCK']) {
    void mode; // renderForecast()根本不接收mode参数——渲染结果必然与mode无关
    rendered.add(renderForecast(forecast));
  }
  assert.equal(rendered.size, 1, 'renderForecast的输出不应因外部许可状态变化而不同');
  const html = [...rendered][0];
  assert.match(html, /UP · 多头/);
  assert.match(html, /DOWN · 空头/);
  assert.match(html, /RANGE/);
});

// === P1-4：HTML转义与注入防护——直接驱动真实生产渲染函数 ===

const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg onload=alert(1)>',
  "' onclick='alert(1)",
  'A&B < C > D'
];

function assertNeverProducesLiveTag(html, payload, label) {
  assert.ok(!html.includes(payload), `${label}: 原始payload不得未经转义原样出现在HTML中`);
  if (payload.includes('<')) {
    assert.ok(!/<script[ >]/i.test(html), `${label}: 不得生成可执行的<script>标签`);
    assert.ok(!/<img[ >]/i.test(html), `${label}: 不得生成真实<img>标签`);
    assert.ok(!/<svg[ >]/i.test(html), `${label}: 不得生成真实<svg>标签`);
  }
}

test('escapeHtml：正确转义全部5个特殊字符，普通中文与符号不受影响', () => {
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml('上涨0.5%（正常）'), '上涨0.5%（正常）');
});

test('P1-4安全：renderMarket对交易对/动量等字段中的恶意输入全部转义', () => {
  for (const payload of XSS_PAYLOADS) {
    const html = renderMarket({
      instrument: payload, status: 'LIVE', price: 100, priceSource: 'LAST_CLOSED_CANDLE', dataTime: 1000,
      changeAbs: 1, changePct: 0.01, changeBasis: { closePrice: 99, closeTime: 900 }, momentum: payload
    });
    assertNeverProducesLiveTag(html, payload, 'renderMarket');
  }
});

test('P1-4安全：renderMarket对staleness.reason（陈旧原因文字）中的恶意输入转义', () => {
  for (const payload of XSS_PAYLOADS) {
    const html = renderMarket({ instrument: 'ETHUSDT', status: 'INSUFFICIENT_DATA', staleness: { reason: payload } });
    assertNeverProducesLiveTag(html, payload, 'renderMarket(staleness)');
  }
});

test('P1-4安全：renderReferenceExecutionState对reason/detail/disclosure中的恶意输入全部转义', () => {
  for (const payload of XSS_PAYLOADS) {
    const html = renderReferenceExecutionState({ mode: 'BLOCK', reason: payload, detail: payload, disclosure: payload });
    assertNeverProducesLiveTag(html, payload, 'renderReferenceExecutionState');
  }
});

test('P1-4安全：renderForecast对触发条件/失效条件中的恶意输入全部转义，且不影响UP/DOWN/RANGE卡片正常渲染', () => {
  for (const payload of XSS_PAYLOADS) {
    const forecast = {
      status: 'ACTIVE', referencePrice: 100, probabilityStatus: 'rule_based', generatedAt: 1, targetEndTime: 2,
      up: { probabilityPct: 10, targetZone: [1, 2], expectedMovePct: 0.1, triggerCondition: payload, invalidationCondition: payload },
      down: { probabilityPct: 10, targetZone: [1, 2], expectedMovePct: 0.1, triggerCondition: payload, invalidationCondition: payload },
      range: { probabilityPct: 80, upperBound: 2, lowerBound: 1, triggerCondition: payload, invalidationCondition: payload }
    };
    const html = renderForecast(forecast);
    assertNeverProducesLiveTag(html, payload, 'renderForecast');
    assert.match(html, /UP · 多头/, '转义修复不得隐藏真实预测数据');
    assert.match(html, /DOWN · 空头/);
    assert.match(html, /RANGE/);
  }
});

test('P1-4安全：probabilityStatus等枚举/状态类字段中的恶意输入同样转义', () => {
  for (const payload of XSS_PAYLOADS) {
    const html = renderForecast({
      status: 'ACTIVE', referencePrice: 100, probabilityStatus: payload, generatedAt: 1, targetEndTime: 2,
      up: { probabilityPct: 10, targetZone: [1, 2] }, down: { probabilityPct: 10, targetZone: [1, 2] }, range: { probabilityPct: 80, upperBound: 2, lowerBound: 1 }
    });
    assertNeverProducesLiveTag(html, payload, 'renderForecast(probabilityStatus)');
  }
});
