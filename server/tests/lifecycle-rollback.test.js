import test from 'node:test';
import assert from 'node:assert/strict';
import { startStagesWithRollback, stopStagesInOrder, createIdempotentCloser } from '../src/lifecycle.js';
import { CollectorService } from '../src/collector/service.js';
import { MemoryRepository } from '../src/db/memory.js';
import { createApiServer } from '../src/api/server.js';
import { ForecastGenerator } from '../src/forecast/generator-service.js';
import { OutcomeEvaluator } from '../src/outcome/evaluator-service.js';
import { createFakeLeasePool } from './helpers/fake-lease-pool.js';

const NOW = 1_784_000_000_000, OPEN = NOW - 1_800_000;
const bar = t => [t, '100', '101', '99', '100', '10', t + 899999, '1000', 10, '5', '500', '0'];
const response = (body, id = '00000000-0000-0000-0000-000000000001') => ({ body, requestId: id, status: 200, headers: {}, startedAt: NOW - 2, receivedAt: NOW, roundTripMs: 2 });
function fakeAdapter() {
  return {
    client: { breakerStates: () => ({}) },
    serverTime: async () => response({ serverTime: NOW }),
    spotKlines: async (s, i, opts = {}) => response([bar(OPEN), bar(OPEN + 900000)], `00000000-0000-0000-0000-00000000000${s === 'ETHUSDT' ? 1 : 2}`),
    futuresKlines: async () => response([bar(OPEN)]),
    fundingRates: async () => response([]),
    openInterest: async s => response({ symbol: s, openInterest: '1', time: NOW - 1000 }),
    longShortRatio: async () => response([]),
    takerFlow: async () => response([])
  };
}
const collectorConfig = { collectorId: 'rollback-test', leaseTtlMs: 60000, maxClockOffsetMs: 100000, timeoutMs: 1000 };

// 按bootstrap()在src/index.js中的真实wiring顺序（collector→api→forecastGenerator→outcomeEvaluator）搭建stages，
// 使用真实的CollectorService/api server/ForecastGenerator/OutcomeEvaluator类，只在数据依赖处替换为内存/fake实现，
// 不接触真实网络或PostgreSQL。
function buildHarness({ forecastServerTimeProvider = async () => ({ ok: false, reason: 'X' }), outcomeServerTimeProvider = async () => ({ ok: false, reason: 'X' }) } = {}) {
  const repo = new MemoryRepository({ requireLease: true, now: () => NOW });
  const collector = new CollectorService({ adapter: fakeAdapter(), repository: repo, config: collectorConfig, now: () => NOW, logger: { error() {} } });
  const api = createApiServer({ collector, repository: repo, host: '127.0.0.1', port: 0 });
  const forecastPool = createFakeLeasePool({ now: () => NOW });
  const forecastGenerator = new ForecastGenerator({ pool: forecastPool, holderId: 'gen-rollback', serverTimeProvider: forecastServerTimeProvider, leaseTtlMs: 60000 });
  const outcomePool = createFakeLeasePool({ now: () => NOW });
  const outcomeEvaluator = new OutcomeEvaluator({ pool: outcomePool, holderId: 'eval-rollback', serverTimeProvider: outcomeServerTimeProvider, leaseTtlMs: 60000 });

  const order = [];
  const stages = [
    { name: 'collector', start: () => collector.start().then(r => { order.push('start:collector'); return r; }), stop: () => collector.stop({ closeRepository: false }).then(() => order.push('stop:collector')) },
    { name: 'api', start: () => api.start().then(r => { order.push('start:api'); return r; }), stop: () => api.stop().then(() => order.push('stop:api')) },
    { name: 'forecastGenerator', start: () => forecastGenerator.start({ intervalMs: 10_000_000 }).then(r => { order.push('start:forecastGenerator'); return r; }), stop: () => forecastGenerator.stop().then(() => order.push('stop:forecastGenerator')) },
    { name: 'outcomeEvaluator', start: () => outcomeEvaluator.start({ intervalMs: 10_000_000 }).then(r => { order.push('start:outcomeEvaluator'); return r; }), stop: () => outcomeEvaluator.stop().then(() => order.push('stop:outcomeEvaluator')) }
  ];
  return { repo, collector, api, forecastGenerator, forecastPool, outcomeEvaluator, outcomePool, stages, order };
}

test('ForecastGenerator启动失败：已启动的collector/api按逆序回滚，OutcomeEvaluator从未被启动，原始错误被重新抛出', async () => {
  const h = buildHarness();
  const farFuture = NOW + 3_600_000;
  h.forecastPool.seedLease('forecast-generator', { holderId: 'other-owner', fencingToken: 5, expiresAt: farFuture });
  let outcomeStartCalled = false;
  const originalOutcomeStart = h.outcomeEvaluator.start.bind(h.outcomeEvaluator);
  h.outcomeEvaluator.start = (...args) => { outcomeStartCalled = true; return originalOutcomeStart(...args); };

  await assert.rejects(
    startStagesWithRollback(h.stages, { onStageStopError: () => {} }),
    error => error.code === 'FORECAST_GENERATOR_LEASE_HELD'
  );

  assert.deepEqual(h.order, ['start:collector', 'start:api', 'stop:api', 'stop:collector'], '必须按已启动组件的逆序回滚，且不回滚从未启动成功的forecastGenerator/outcomeEvaluator');
  assert.equal(outcomeStartCalled, false, 'forecastGenerator启动失败后不应继续尝试启动outcomeEvaluator');
  assert.equal(h.collector.running, false);
  assert.equal(h.collector.timers.length, 0, '回滚后不得残留collector定时器');
  assert.equal(h.api.server.listening, false, '回滚后API端口不得继续监听');
  assert.equal(h.forecastGenerator.running, false);
});

test('OutcomeEvaluator启动失败：collector/api/forecastGenerator已启动的组件均按逆序回滚', async () => {
  const h = buildHarness({ forecastServerTimeProvider: async () => ({ ok: false, reason: 'X' }) });
  const farFuture = NOW + 3_600_000;
  h.outcomePool.seedLease('forecast-outcome-evaluator', { holderId: 'other-owner', fencingToken: 7, expiresAt: farFuture });

  await assert.rejects(
    startStagesWithRollback(h.stages, { onStageStopError: () => {} }),
    error => error.code === 'OUTCOME_EVALUATOR_LEASE_HELD'
  );

  assert.deepEqual(h.order, ['start:collector', 'start:api', 'start:forecastGenerator', 'stop:forecastGenerator', 'stop:api', 'stop:collector']);
  assert.equal(h.collector.running, false);
  assert.equal(h.collector.timers.length, 0);
  assert.equal(h.api.server.listening, false);
  assert.equal(h.forecastGenerator.running, false);
  assert.equal(h.forecastGenerator.lease, null, 'forecastGenerator回滚时必须释放它已经拿到的lease');
  const forecastLeaseRow = h.forecastPool.getLease('forecast-generator');
  assert.ok(forecastLeaseRow.expiresAt <= NOW, 'forecastGenerator的lease必须在回滚时被释放');
});

test('某个组件stop()报错不会阻止其余组件继续回滚，且最终抛出的仍是原始启动错误而非清理错误', async () => {
  const h = buildHarness();
  const farFuture = NOW + 3_600_000;
  h.forecastPool.seedLease('forecast-generator', { holderId: 'other-owner', fencingToken: 5, expiresAt: farFuture });
  // collector.stop()本身报错，模拟某组件清理失败
  const originalCollectorStop = h.collector.stop.bind(h.collector);
  h.stages[0].stop = async () => { h.order.push('stop:collector-attempt'); throw Object.assign(new Error('simulated collector stop failure'), { code: 'SIMULATED_STOP_FAILURE' }); };

  const rollbackErrors = [];
  await assert.rejects(
    startStagesWithRollback(h.stages, { onStageStopError: (stage, error) => rollbackErrors.push({ stage: stage.name, code: error.code }) }),
    error => error.code === 'FORECAST_GENERATOR_LEASE_HELD', '必须重新抛出原始启动错误，而不是collector.stop()的清理错误'
  );

  assert.deepEqual(h.order, ['start:collector', 'start:api', 'stop:api', 'stop:collector-attempt']);
  assert.deepEqual(rollbackErrors, [{ stage: 'collector', code: 'SIMULATED_STOP_FAILURE' }], '单个stage的stop()失败必须被记录，但不得中断其余stage回滚');
  assert.equal(h.api.server.listening, false, 'collector.stop()报错不应阻止api完成回滚');
  await originalCollectorStop({ closeRepository: false }).catch(() => {});
});

test('回滚完成后共享数据库只关闭一次，即使回滚路径与正常关停路径都尝试关闭', async () => {
  const h = buildHarness();
  const farFuture = NOW + 3_600_000;
  h.forecastPool.seedLease('forecast-generator', { holderId: 'other-owner', fencingToken: 5, expiresAt: farFuture });
  let closeCalls = 0;
  const closeDatabase = createIdempotentCloser(async () => { closeCalls += 1; });

  try {
    await startStagesWithRollback(h.stages, { onStageStopError: () => {} });
  } catch (startError) {
    await closeDatabase();
  }
  // 模拟同一进程内如果再次触发关停路径（例如SIGTERM与启动失败竞态），closeDatabase必须仍是no-op
  await closeDatabase();
  await closeDatabase();
  assert.equal(closeCalls, 1, '共享数据库连接池只能被关闭一次');
});

test('正常关停：全部启动成功后stop按逆序执行，Forecast/Outcome先于数据库关闭完成收尾', async () => {
  const h = buildHarness();
  await startStagesWithRollback(h.stages);
  assert.deepEqual(h.order, ['start:collector', 'start:api', 'start:forecastGenerator', 'start:outcomeEvaluator']);

  let dbClosed = false;
  const closeDatabase = createIdempotentCloser(async () => { dbClosed = true; });
  await stopStagesInOrder(h.stages, { onStageStopError: () => {} });
  await closeDatabase();

  assert.deepEqual(h.order, [
    'start:collector', 'start:api', 'start:forecastGenerator', 'start:outcomeEvaluator',
    'stop:outcomeEvaluator', 'stop:forecastGenerator', 'stop:api', 'stop:collector'
  ], '正常关停必须按启动的逆序执行，且outcomeEvaluator/forecastGenerator必须先于collector完成停止');
  assert.equal(h.forecastGenerator.lease, null);
  assert.equal(h.outcomeEvaluator.lease, null);
  assert.equal(h.api.server.listening, false);
  assert.equal(h.collector.timers.length, 0);
  assert.equal(dbClosed, true, '所有组件stop()完成后才关闭共享数据库');
});

test('createIdempotentCloser()对并发与重复调用都只执行一次底层close', async () => {
  let calls = 0;
  const close = createIdempotentCloser(async () => { calls += 1; });
  await Promise.all([close(), close(), close()]);
  await close();
  assert.equal(calls, 1);
});
