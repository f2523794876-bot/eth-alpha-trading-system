import test from 'node:test';
import assert from 'node:assert/strict';
import { ForecastGenerator } from '../../src/forecast/generator-service.js';
import { createFakeLeasePool } from '../helpers/fake-lease-pool.js';

const FAR_FUTURE = Date.now() + 3_600_000;

test('runOnce()尚未完成时调用stop()必须等待其结束才返回，且随后释放自身lease', async () => {
  const pool = createFakeLeasePool();
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const serverTimeProvider = async () => { await gate; return { ok: false, reason: 'SERVER_TIME_UNAVAILABLE_TEST' }; };
  const generator = new ForecastGenerator({ pool, holderId: 'gen-inflight', serverTimeProvider, leaseTtlMs: 60000 });
  await generator.start({ intervalMs: 10_000_000 });

  const runPromise = generator.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(generator.inflight.size, 1, 'runOnce()应已注册进inflight');

  let stopSettled = false;
  const stopPromise = generator.stop().then(() => { stopSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopSettled, false, 'stop()不得在runOnce()完成前先行返回');

  releaseGate();
  const result = await runPromise;
  assert.equal(result.status, 'BLOCKED');
  await stopPromise;
  assert.equal(stopSettled, true);
  assert.equal(generator.inflight.size, 0, 'runOnce()结束后inflight不得残留');
  assert.equal(generator.lease, null);
  const leaseRow = pool.getLease('forecast-generator');
  assert.ok(leaseRow.expiresAt <= Date.now(), 'stop()必须释放自身持有的lease');
  assert.equal(pool.releaseCallCount('forecast-generator'), 1);
});

test('stop()之后不会再产生新的调度执行', async () => {
  const pool = createFakeLeasePool();
  let calls = 0;
  const serverTimeProvider = async () => { calls += 1; return { ok: false, reason: 'X' }; };
  const generator = new ForecastGenerator({ pool, holderId: 'gen-noschedule', serverTimeProvider, leaseTtlMs: 60000 });
  await generator.start({ intervalMs: 20, heartbeatIntervalMs: 20 });
  await generator.stop();
  const callsAtStop = calls;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls, callsAtStop, '停止后不应再有新的runOnce被调度触发');
  assert.equal(generator.timers.length, 0);
  assert.equal(generator.heartbeatTimer, null);
});

test('停止后不会释放其他owner/token持有的lease', async () => {
  const pool = createFakeLeasePool();
  const serverTimeProvider = async () => ({ ok: false, reason: 'X' });
  const generator = new ForecastGenerator({ pool, holderId: 'gen-stale-owner', serverTimeProvider, leaseTtlMs: 60000 });
  await generator.start({ intervalMs: 10_000_000 });
  // 模拟另一实例在本实例lease过期后已抢占同名lease（真实场景：本实例heartbeat长时间失败但尚未来得及调用stop()）
  pool.seedLease('forecast-generator', { holderId: 'other-instance', fencingToken: 99, expiresAt: FAR_FUTURE });

  await assert.doesNotReject(generator.stop());
  const leaseRow = pool.getLease('forecast-generator');
  assert.equal(leaseRow.holderId, 'other-instance');
  assert.equal(leaseRow.fencingToken, 99);
  assert.ok(leaseRow.expiresAt >= FAR_FUTURE, '不得触碰其他owner持有的lease行');
});

test('重复调用stop()是幂等的，不会重复释放lease', async () => {
  const pool = createFakeLeasePool();
  const serverTimeProvider = async () => ({ ok: false, reason: 'X' });
  const generator = new ForecastGenerator({ pool, holderId: 'gen-idempotent', serverTimeProvider, leaseTtlMs: 60000 });
  await generator.start({ intervalMs: 10_000_000 });

  const [a, b] = await Promise.all([generator.stop(), generator.stop()]);
  assert.equal(a, undefined);
  assert.equal(b, undefined);
  await generator.stop();
  assert.equal(pool.releaseCallCount('forecast-generator'), 1, '并发/重复调用stop()只应触发一次release');
  assert.equal(generator.lease, null);
  assert.equal(generator.running, false);
});

test('runOnce()因fencing token被拒绝而失败时，inflight不残留', async () => {
  const pool = createFakeLeasePool();
  const serverTimeProvider = async () => ({ ok: true, sourceServerTime: Date.now() });
  const generator = new ForecastGenerator({ pool, holderId: 'gen-fencing', serverTimeProvider, leaseTtlMs: 60000 });
  await generator.start({ intervalMs: 10_000_000 });
  // 抢占同名lease使当前fencingToken失效，触发transaction()内assertLease()的FENCING_TOKEN_REJECTED路径
  pool.seedLease('forecast-generator', { holderId: 'takeover', fencingToken: 42, expiresAt: FAR_FUTURE });

  await assert.rejects(
    generator.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' }),
    error => error.code === 'FENCING_TOKEN_REJECTED'
  );
  assert.equal(generator.inflight.size, 0, '被拒绝的runOnce()结算后不得残留于inflight');
  assert.equal(generator.leaseLost, true);
});

test('某个stop()场景下lease释放失败不会抛出未处理异常（仅记录）', async () => {
  const pool = createFakeLeasePool();
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/^\s*UPDATE collector_leases SET expires_at=clock_timestamp\(\),heartbeat_at=clock_timestamp\(\)/.test(sql)) {
      throw Object.assign(new Error('simulated release failure'), { code: 'SIMULATED_RELEASE_FAILURE' });
    }
    return originalQuery(sql, params);
  };
  const warnings = [];
  const serverTimeProvider = async () => ({ ok: false, reason: 'X' });
  const generator = new ForecastGenerator({ pool, holderId: 'gen-release-fail', serverTimeProvider, leaseTtlMs: 60000, logger: { error() {}, warn: (...args) => warnings.push(args) } });
  await generator.start({ intervalMs: 10_000_000 });

  await assert.doesNotReject(generator.stop());
  assert.equal(generator.lease, null);
  assert.ok(warnings.length >= 1, 'lease release失败应被记录而不是让stop()抛出');
});
