// 实时看板HTTP接口集成测试——通过真实fetch()打真实createApiServer()实例，驱动真实
// buildRealtimeDashboard()/repository.latestBars/latestProvisionalBar/latestForecastSnapshot生产路径
// （MemoryRepository为其内存实现，与api.test.js既有测试同一套fixture风格），不绕开真实分页/映射逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/api/server.js';
import { MemoryRepository } from '../src/db/memory.js';

function readyCollector(ok = true, status = ok ? 'HEALTHY' : 'DEGRADED') {
  return {
    health: () => ({ state: status }),
    status: () => ({ running: true }),
    readiness: async () => ({ ok, status, checks: { database: ok, migrations: true, lease: true, serverTime: true, coreDataFresh: ok } })
  };
}

function seedBar(repo, { openTime, closeTime, close, marketType = 'spot', interval = '15m', instrument = 'ETHUSDT' }) {
  repo.bars.push({ instrument, marketType, interval, openTime, closeTime, open: close, high: close, low: close, close, qualityState: 'NORMAL' });
}
function seedProvisional(repo, { openTime, closeTime, close, fetchedAt, marketType = 'spot', interval = '15m', instrument = 'ETHUSDT' }) {
  repo.provisional.push({ instrument, marketType, interval, openTime, closeTime, open: close, high: close, low: close, close, fetchedAt });
}
function seedForecast(repo, { horizon, referencePrice = 3000, generatedAt, targetEndTime, instrument = 'ETHUSDT', scenarioWeights = { baseline: 30, upside: 50, downside: 20 } }) {
  repo.forecasts.push({
    predictionId: `GMKG-SRV-${instrument}-${horizon}-${generatedAt}-v1`, instrument, horizon,
    generatedAt, dataCutoffTime: generatedAt, targetStartTime: generatedAt, targetEndTime,
    referencePrice, expectedDirection: 'UP', scenarioWeights, probabilityStatus: 'rule_based',
    expectedPriceZones: { baseline: [referencePrice * 0.99, referencePrice * 1.01], upside: [referencePrice * 1.02, referencePrice * 1.04], downside: [referencePrice * 0.96, referencePrice * 0.98] },
    triggerConditions: [`${horizon}目标窗口内，若15分钟已收盘价格突破upsideScenario.priceZone下沿，视为upside情景触发确认`],
    invalidationConditions: [`若${horizon}目标窗口内已收盘价格跌破downsideScenario.priceZone上沿，视为baseline/upside情景证据减弱`]
  });
}

async function boot(collector, repository) {
  const api = createApiServer({ collector, repository, host: '127.0.0.1', port: 0 });
  const address = await api.start();
  return { api, base: `http://127.0.0.1:${address.port}` };
}

test('OBSERVE状态下UP/DOWN/RANGE三套预测同时完整返回', async () => {
  const repo = new MemoryRepository();
  seedBar(repo, { openTime: 1000, closeTime: 1899, close: 3000 });
  seedProvisional(repo, { openTime: 1900, closeTime: 2799, close: 3060, fetchedAt: 2000000000000 });
  seedForecast(repo, { horizon: '24h', generatedAt: 1000, targetEndTime: 9999999999999 });
  const x = await boot(readyCollector(true), repo);
  try {
    const body = await (await fetch(`${x.base}/api/v1/dashboard/realtime?instrument=ETHUSDT`)).json();
    assert.equal(body.data.tradingPermission.mode, 'OBSERVE');
    assert.equal(body.data.forecast24h.up.probabilityPct, 50);
    assert.equal(body.data.forecast24h.down.probabilityPct, 20);
    assert.equal(body.data.forecast24h.range.probabilityPct, 30);
  } finally { await x.api.stop(); }
});

test('BLOCK（数据健康降级）状态下UP/DOWN/RANGE预测仍完整可见，不被许可状态覆盖或清空', async () => {
  const repo = new MemoryRepository();
  seedBar(repo, { openTime: 1000, closeTime: 1899, close: 3000 });
  seedForecast(repo, { horizon: '24h', generatedAt: 1000, targetEndTime: 9999999999999 });
  const x = await boot(readyCollector(false, 'DEGRADED'), repo);
  try {
    const body = await (await fetch(`${x.base}/api/v1/dashboard/realtime?instrument=ETHUSDT`)).json();
    assert.equal(body.data.tradingPermission.mode, 'BLOCK');
    assert.equal(body.data.tradingPermission.reason, 'DATA_HEALTH_DEGRADED');
    assert.equal(body.data.forecast24h.status, 'ACTIVE');
    assert.equal(body.data.forecast24h.up.probabilityPct, 50, 'BLOCK不得清空/替代多头预测');
    assert.equal(body.data.forecast24h.down.probabilityPct, 20, 'BLOCK不得清空/替代空头预测');
    assert.equal(body.data.forecast24h.range.probabilityPct, 30, 'BLOCK不得清空/替代RANGE预测');
  } finally { await x.api.stop(); }
});

test('BLOCK（无任何预测）状态下市场状态仍展示，预测字段如实标注尚未生成，不伪造0值或概率', async () => {
  const repo = new MemoryRepository();
  seedBar(repo, { openTime: 1000, closeTime: 1899, close: 3000 });
  const x = await boot(readyCollector(true), repo);
  try {
    const body = await (await fetch(`${x.base}/api/v1/dashboard/realtime?instrument=ETHUSDT`)).json();
    assert.equal(body.data.tradingPermission.mode, 'BLOCK');
    assert.equal(body.data.tradingPermission.reason, 'NO_ACTIVE_FORECAST');
    assert.equal(body.data.marketState.status, 'LAST_CLOSED_ONLY');
    assert.equal(body.data.marketState.price, 3000);
    assert.equal(body.data.forecast24h.status, 'NOT_YET_GENERATED');
    assert.equal(body.data.forecast24h.up, null);
    assert.equal(body.data.forecast72h.status, 'NOT_YET_GENERATED');
  } finally { await x.api.stop(); }
});

test('24H与72H严格分开，互不覆盖', async () => {
  const repo = new MemoryRepository();
  seedBar(repo, { openTime: 1000, closeTime: 1899, close: 3000 });
  seedForecast(repo, { horizon: '24h', referencePrice: 3000, generatedAt: 1000, targetEndTime: 9999999999999, scenarioWeights: { baseline: 30, upside: 50, downside: 20 } });
  seedForecast(repo, { horizon: '72h', referencePrice: 3100, generatedAt: 2000, targetEndTime: 9999999999999, scenarioWeights: { baseline: 40, upside: 35, downside: 25 } });
  const x = await boot(readyCollector(true), repo);
  try {
    const body = await (await fetch(`${x.base}/api/v1/dashboard/realtime?instrument=ETHUSDT`)).json();
    assert.equal(body.data.forecast24h.referencePrice, 3000);
    assert.equal(body.data.forecast72h.referencePrice, 3100);
    assert.equal(body.data.forecast24h.up.probabilityPct, 50);
    assert.equal(body.data.forecast72h.up.probabilityPct, 35);
    assert.notEqual(body.data.forecast24h.predictionId, body.data.forecast72h.predictionId);
  } finally { await x.api.stop(); }
});

test('实时价格刷新（多次请求同一只读接口）不会新增正式预测样本、K线或进行中K线快照', async () => {
  const repo = new MemoryRepository();
  seedBar(repo, { openTime: 1000, closeTime: 1899, close: 3000 });
  seedProvisional(repo, { openTime: 1900, closeTime: 2799, close: 3010, fetchedAt: 2000 });
  seedForecast(repo, { horizon: '24h', generatedAt: 1000, targetEndTime: 9999999999999 });
  seedForecast(repo, { horizon: '72h', generatedAt: 1000, targetEndTime: 9999999999999 });
  const x = await boot(readyCollector(true), repo);
  try {
    const [barsBefore, provisionalBefore, forecastsBefore] = [repo.bars.length, repo.provisional.length, repo.forecasts.length];
    for (let i = 0; i < 5; i += 1) await fetch(`${x.base}/api/v1/dashboard/realtime?instrument=ETHUSDT`);
    assert.equal(repo.bars.length, barsBefore, '刷新实时看板不得新增market_bars');
    assert.equal(repo.provisional.length, provisionalBefore, '刷新实时看板不得新增provisional_market_bars');
    assert.equal(repo.forecasts.length, forecastsBefore, '刷新实时看板不得新增forecast_snapshots（不得因看起来实时而污染研究样本）');
  } finally { await x.api.stop(); }
});

test('页面刷新（GET /与/dashboard）返回HTML且不新增ForecastSnapshot', async () => {
  const repo = new MemoryRepository();
  seedForecast(repo, { horizon: '24h', generatedAt: 1000, targetEndTime: 9999999999999 });
  const x = await boot(readyCollector(true), repo);
  try {
    const before = repo.forecasts.length;
    const r1 = await fetch(`${x.base}/`);
    const r2 = await fetch(`${x.base}/dashboard`);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.match(r1.headers.get('content-type'), /text\/html/);
    assert.match(await r1.text(), /实时看板/);
    assert.equal(repo.forecasts.length, before, '访问看板页面本身不得新增ForecastSnapshot');
  } finally { await x.api.stop(); }
});

test('多头/空头目标区间与RANGE上下沿字段映射精确（非模糊字符串断言）', async () => {
  const repo = new MemoryRepository();
  seedBar(repo, { openTime: 1000, closeTime: 1899, close: 3000 });
  seedForecast(repo, { horizon: '24h', referencePrice: 3000, generatedAt: 1000, targetEndTime: 9999999999999 });
  const x = await boot(readyCollector(true), repo);
  try {
    const body = await (await fetch(`${x.base}/api/v1/dashboard/realtime?instrument=ETHUSDT`)).json();
    const f = body.data.forecast24h;
    assert.deepEqual(f.up.targetZone, [3000 * 1.02, 3000 * 1.04]);
    assert.deepEqual(f.down.targetZone, [3000 * 0.96, 3000 * 0.98]);
    assert.equal(f.range.upperBound, 3000 * 1.01);
    assert.equal(f.range.lowerBound, 3000 * 0.99);
  } finally { await x.api.stop(); }
});

test('数据时间与预测生成时间不会混淆', async () => {
  const repo = new MemoryRepository();
  seedBar(repo, { openTime: 1000, closeTime: 1899, close: 3000 });
  seedProvisional(repo, { openTime: 1900, closeTime: 2799, close: 3010, fetchedAt: 555555 });
  seedForecast(repo, { horizon: '24h', generatedAt: 111111, targetEndTime: 9999999999999 });
  const x = await boot(readyCollector(true), repo);
  try {
    const body = await (await fetch(`${x.base}/api/v1/dashboard/realtime?instrument=ETHUSDT`)).json();
    assert.equal(body.data.marketState.dataTime, 555555);
    assert.equal(body.data.forecast24h.generatedAt, 111111);
    assert.notEqual(body.data.marketState.dataTime, body.data.forecast24h.generatedAt);
  } finally { await x.api.stop(); }
});

test('实时涨跌比较基准明确且计算正确（相对上一根已完成15m K线收盘价）', async () => {
  const repo = new MemoryRepository();
  seedBar(repo, { openTime: 1000, closeTime: 1899, close: 3000 });
  seedProvisional(repo, { openTime: 1900, closeTime: 2799, close: 3150, fetchedAt: 2000 });
  const x = await boot(readyCollector(true), repo);
  try {
    const body = await (await fetch(`${x.base}/api/v1/dashboard/realtime?instrument=ETHUSDT`)).json();
    assert.equal(body.data.marketState.changeBasis.type, 'PREVIOUS_CLOSED_15M_CANDLE');
    assert.equal(body.data.marketState.changeBasis.closePrice, 3000);
    assert.equal(body.data.marketState.changeAbs, 150);
    assert.equal(body.data.marketState.changePct, 0.05);
  } finally { await x.api.stop(); }
});

test('旧接口原有核心功能不回退：既有/api/v1/sources与/api/v1/bars路由在新增看板路由后仍正常工作', async () => {
  const repo = new MemoryRepository();
  const x = await boot(readyCollector(true), repo);
  try {
    assert.equal((await fetch(`${x.base}/api/v1/sources`)).status, 200);
    assert.equal((await fetch(`${x.base}/api/v1/bars?instrument=ETHUSDT&interval=15m`)).status, 200);
  } finally { await x.api.stop(); }
});

test('数据健康降级时看板整体状态与许可原因如实展示', async () => {
  const repo = new MemoryRepository();
  const x = await boot(readyCollector(false, 'BLOCKED'), repo);
  try {
    const body = await (await fetch(`${x.base}/api/v1/dashboard/realtime?instrument=ETHUSDT`)).json();
    assert.equal(body.data.dataHealth.ok, false);
    assert.equal(body.data.dataHealth.status, 'BLOCKED');
    assert.equal(body.data.tradingPermission.mode, 'BLOCK');
  } finally { await x.api.stop(); }
});

test('新路由遵守既有GET-only约束', async () => {
  const repo = new MemoryRepository();
  const x = await boot(readyCollector(true), repo);
  try {
    assert.equal((await fetch(`${x.base}/api/v1/dashboard/realtime?instrument=ETHUSDT`, { method: 'POST' })).status, 405);
  } finally { await x.api.stop(); }
});

test('instrument使用既有白名单，非法值返回400', async () => {
  const repo = new MemoryRepository();
  const x = await boot(readyCollector(true), repo);
  try {
    const r = await fetch(`${x.base}/api/v1/dashboard/realtime?instrument=DOGEUSDT`);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'INVALID_INSTRUMENT');
  } finally { await x.api.stop(); }
});
