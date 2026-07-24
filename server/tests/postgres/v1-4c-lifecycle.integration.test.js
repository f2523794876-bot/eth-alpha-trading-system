// V1.4C 生命周期加固（commit bc00658）真实PostgreSQL验证：补齐此前只在fake pool下验证过的6项行为——
// (1)ForecastGenerator/OutcomeEvaluator.releaseLease()真实生效 (2)owner/token/fencing隔离 (3)stop()等待真实
// 事务完成 (4)bootstrap()分阶段启动失败在真实连接下逆序回滚 (5)共享pg.Pool只关闭一次 (6)正常关停顺序。
// 沿用本仓库既有测试基础设施：TEST_DATABASE_URL隔离库名安全检查、runMigrations(down→up)重置schema、pgtest降级模式、
// Node内建test/assert。不修改任何生产实现（server/src/lifecycle.js、forecast/generator-service.js、
// outcome/evaluator-service.js、index.js）以迎合测试；本文件只使用它们已有的公开方法与构造参数。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createPgPool } from '../../src/db/postgres.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ForecastGenerator, LEASE_NAME as GENERATOR_LEASE } from '../../src/forecast/generator-service.js';
import { OutcomeEvaluator, LEASE_NAME as EVALUATOR_LEASE } from '../../src/outcome/evaluator-service.js';
import { startStagesWithRollback, stopStagesInOrder, createIdempotentCloser } from '../../src/lifecycle.js';

const url = process.env.TEST_DATABASE_URL, enabled = Boolean(url), pgtest = enabled ? test : test.skip;
let pool;

const okServerTime = at => async () => ({ ok: true, sourceServerTime: at });
const NEVER_DUE = 1; // serverTime远早于任何真实referenceBar边界，generateSnapshot/evaluatePending会快速判定为BLOCKED/无待处理项，不依赖任何market数据种子

// 真实数据库锁barrier：在collector_leases目标行上持有FOR UPDATE且不提交，使ForecastGenerator/OutcomeEvaluator
// 的transaction()内assertLease()（FOR SHARE，见forecast/generator-service.js、outcome/evaluator-service.js
// 头部assertLease实现）在Postgres锁管理器层面真实阻塞——不是模拟、不是sleep、是标准PostgreSQL行锁互斥语义
// （FOR UPDATE与FOR SHARE互斥）。等待/确认阻塞状态通过轮询pg_locks真实系统视图完成，不使用固定sleep推断顺序。
async function acquireRowLockBarrier(adminPool, leaseName) {
  const client = await adminPool.connect();
  await client.query('BEGIN');
  await client.query('SELECT * FROM collector_leases WHERE lease_name=$1 FOR UPDATE', [leaseName]);
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try { await client.query('COMMIT'); } finally { client.release(); }
    }
  };
}

// pg.Pool.end()被调用第二次时的行为在不同版本间不完全一致（可能reject也可能同步抛出）；测试清理路径统一走这个
// helper，保证无论哪种情况都不会让finally块本身抛出并掩盖真正的测试失败原因。
async function safeEndPool(candidatePool) {
  try { await candidatePool.end(); } catch { /* 已关闭或正在关闭，清理路径本就允许重复调用 */ }
}

async function waitForBlockedLockRequest(adminPool, { relation = 'collector_leases', timeoutMs = 5000, pollMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await adminPool.query(
      `SELECT count(*)::int AS n FROM pg_locks l
       WHERE l.relation = $1::regclass AND NOT l.granted`,
      [relation]
    );
    if (result.rows[0].n > 0) return true;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return false;
}

async function readLeaseRow(adminPool, leaseName) {
  const result = await adminPool.query(
    'SELECT lease_name, holder_id, fencing_token::bigint AS "fencingToken", expires_at AS "expiresAt" FROM collector_leases WHERE lease_name=$1',
    [leaseName]
  );
  return result.rows[0] || null;
}

async function settledFlag(promise) {
  const flag = { settled: false, value: undefined, error: undefined };
  promise.then(value => { flag.settled = true; flag.value = value; }, error => { flag.settled = true; flag.error = error; });
  return flag;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

if (enabled) {
  before(async () => {
    if (!/test|ci|v14/i.test(new URL(url).pathname)) throw new Error('TEST_DATABASE_URL must name an isolated test/ci database');
    pool = await createPgPool({ databaseUrl: url, dbSsl: false });
    await runMigrations(pool, 'down'); await runMigrations(pool, 'up');
  });
  after(async () => pool?.end());
}

async function expireLease(adminPool, leaseName) {
  await adminPool.query("UPDATE collector_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_name=$1", [leaseName]);
}

// ============================================================
// A. Lease释放：真实owner/token/fencing隔离（PG-1 / PG-2）
// ============================================================

pgtest('PG-1/PG-2 ForecastGenerator.releaseLease()：错误owner与旧token均不影响真实lease行，正确owner+token真实使其过期', async () => {
  await expireLease(pool, GENERATOR_LEASE);
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-lifecycle-gen-release', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000 });
  const lease = await gen.acquireLease();
  assert.ok(lease, 'must have acquired a real lease row');
  const before = await readLeaseRow(pool, GENERATOR_LEASE);
  assert.equal(before.holderId, 'v14c-lifecycle-gen-release');
  assert.ok(before.expiresAt.getTime() > Date.now());

  // 错误owner：holderId不匹配，即使token正确
  await gen.releaseLease({ leaseName: GENERATOR_LEASE, holderId: 'someone-else', fencingToken: lease.fencingToken });
  let after = await readLeaseRow(pool, GENERATOR_LEASE);
  assert.equal(after.holderId, before.holderId, '错误owner释放不得影响真实lease行的holder_id');
  assert.equal(String(after.fencingToken), String(before.fencingToken));
  assert.equal(after.expiresAt.getTime(), before.expiresAt.getTime(), '错误owner释放不得改变真实lease行的expires_at');

  // 旧fencing_token：owner正确但token是过期值
  await gen.releaseLease({ leaseName: GENERATOR_LEASE, holderId: lease.holderId, fencingToken: Number(lease.fencingToken) + 999 });
  after = await readLeaseRow(pool, GENERATOR_LEASE);
  assert.equal(after.expiresAt.getTime(), before.expiresAt.getTime(), '旧/错误fencing_token释放不得改变真实lease行的expires_at');

  // 正确owner+当前token：真实生效
  await gen.releaseLease(lease);
  after = await readLeaseRow(pool, GENERATOR_LEASE);
  assert.ok(after.expiresAt.getTime() <= Date.now(), '正确owner+token释放后，真实数据库中的lease必须已过期');
  assert.equal(after.holderId, lease.holderId, '释放只应推进expires_at，不应变更holder_id/fencing_token');
  assert.equal(String(after.fencingToken), String(lease.fencingToken));
});

pgtest('PG-1/PG-2 OutcomeEvaluator.releaseLease()：错误owner与旧token均不影响真实lease行，正确owner+token真实使其过期', async () => {
  await expireLease(pool, EVALUATOR_LEASE);
  const evaluator = new OutcomeEvaluator({ pool, holderId: 'v14c-lifecycle-eval-release', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000, evaluationVersion: 'v1.4c-lifecycle-eval-release' });
  const lease = await evaluator.acquireLease();
  assert.ok(lease);
  const before = await readLeaseRow(pool, EVALUATOR_LEASE);

  await evaluator.releaseLease({ leaseName: EVALUATOR_LEASE, holderId: 'someone-else', fencingToken: lease.fencingToken });
  let after = await readLeaseRow(pool, EVALUATOR_LEASE);
  assert.equal(after.holderId, before.holderId);
  assert.equal(after.expiresAt.getTime(), before.expiresAt.getTime(), '错误owner释放不得影响真实lease行');

  await evaluator.releaseLease({ leaseName: EVALUATOR_LEASE, holderId: lease.holderId, fencingToken: Number(lease.fencingToken) + 999 });
  after = await readLeaseRow(pool, EVALUATOR_LEASE);
  assert.equal(after.expiresAt.getTime(), before.expiresAt.getTime(), '旧fencing_token释放不得影响真实lease行');

  await evaluator.releaseLease(lease);
  after = await readLeaseRow(pool, EVALUATOR_LEASE);
  assert.ok(after.expiresAt.getTime() <= Date.now(), '正确owner+token释放后必须真实过期');
});

pgtest('PG-1 stop()端到端路径：真实调用stop()后lease行在数据库中确实已过期', async () => {
  await expireLease(pool, GENERATOR_LEASE);
  await expireLease(pool, EVALUATOR_LEASE);
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-lifecycle-gen-e2e', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000 });
  const evaluator = new OutcomeEvaluator({ pool, holderId: 'v14c-lifecycle-eval-e2e', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000, evaluationVersion: 'v1.4c-lifecycle-eval-e2e' });
  await gen.start({ intervalMs: 10_000_000, heartbeatIntervalMs: 10_000_000 });
  await evaluator.start({ intervalMs: 10_000_000, heartbeatIntervalMs: 10_000_000 });
  await gen.stop();
  await evaluator.stop();
  const genRow = await readLeaseRow(pool, GENERATOR_LEASE);
  const evalRow = await readLeaseRow(pool, EVALUATOR_LEASE);
  assert.ok(genRow.expiresAt.getTime() <= Date.now(), 'gen.stop()后真实数据库lease必须已释放');
  assert.ok(evalRow.expiresAt.getTime() <= Date.now(), 'evaluator.stop()后真实数据库lease必须已释放');
});

// ============================================================
// B. stop()等待真实未提交事务（PG-3）——用collector_leases行上的真实FOR UPDATE/FOR SHARE互斥锁做barrier，
//    而不是固定sleep：assertLease()的FOR SHARE在Postgres锁管理器层面真实阻塞，直到barrier被显式释放。
// ============================================================

pgtest('PG-3 ForecastGenerator.stop()在runOnce()真实事务被行锁阻塞期间不会提前返回，锁释放后才返回并完成lease收尾', async () => {
  await expireLease(pool, GENERATOR_LEASE);
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-lifecycle-gen-block', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000 });
  await gen.start({ intervalMs: 10_000_000, heartbeatIntervalMs: 10_000_000 }); // acquireLease()以其自身独立的INSERT...ON CONFLICT提交，早于下方barrier加锁，不会自我阻塞

  const barrier = await acquireRowLockBarrier(pool, GENERATOR_LEASE);
  try {
    const runPromise = gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' });
    const blocked = await waitForBlockedLockRequest(pool, { timeoutMs: 5000 });
    assert.ok(blocked, 'runOnce()内assertLease()的FOR SHARE必须在真实PostgreSQL锁管理器上产生一条未授予的锁请求');
    assert.equal(gen.inflight.size, 1, 'runOnce()应已注册进inflight，证明确实在途');

    const stopFlag = await settledFlag(gen.stop());
    await tick(); await tick();
    assert.equal(stopFlag.settled, false, 'stop()绝不能在真实事务仍被行锁阻塞时提前返回');

    await barrier.release(); // 唯一的解锁动作，来自测试显式控制，而非计时器
    await runPromise;
    // stopFlag会在gen.stop()真正resolve后才置settled=true；轮询等待，不使用固定sleep臆测完成时刻
    const deadline = Date.now() + 5000;
    while (!stopFlag.settled && Date.now() < deadline) await tick();
    assert.equal(stopFlag.settled, true, '行锁释放、真实事务结束后stop()必须能够返回');
    assert.equal(stopFlag.error, undefined, 'stop()不应因等待真实事务而抛出异常');
  } finally {
    await barrier.release().catch(() => {});
  }

  const row = await readLeaseRow(pool, GENERATOR_LEASE);
  assert.ok(row.expiresAt.getTime() <= Date.now(), 'stop()等待真实事务结束后必须完成lease收尾（真实过期）');
  assert.equal(gen.inflight.size, 0, '事务结束后inflight不得残留');
});

pgtest('PG-3 OutcomeEvaluator.stop()在runOnce()真实事务被行锁阻塞期间不会提前返回，锁释放后才返回并完成lease收尾', async () => {
  await expireLease(pool, EVALUATOR_LEASE);
  const evaluator = new OutcomeEvaluator({ pool, holderId: 'v14c-lifecycle-eval-block', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000, evaluationVersion: 'v1.4c-lifecycle-eval-block' });
  await evaluator.start({ intervalMs: 10_000_000, heartbeatIntervalMs: 10_000_000 });

  const barrier = await acquireRowLockBarrier(pool, EVALUATOR_LEASE);
  try {
    const runPromise = evaluator.runOnce();
    const blocked = await waitForBlockedLockRequest(pool, { timeoutMs: 5000 });
    assert.ok(blocked, 'runOnce()内assertLease()的FOR SHARE必须在真实PostgreSQL锁管理器上产生一条未授予的锁请求');
    assert.equal(evaluator.inflight.size, 1);

    const stopFlag = await settledFlag(evaluator.stop());
    await tick(); await tick();
    assert.equal(stopFlag.settled, false, 'stop()绝不能在真实事务仍被行锁阻塞时提前返回');

    await barrier.release();
    await runPromise;
    const deadline = Date.now() + 5000;
    while (!stopFlag.settled && Date.now() < deadline) await tick();
    assert.equal(stopFlag.settled, true);
    assert.equal(stopFlag.error, undefined);
  } finally {
    await barrier.release().catch(() => {});
  }

  const row = await readLeaseRow(pool, EVALUATOR_LEASE);
  assert.ok(row.expiresAt.getTime() <= Date.now(), 'stop()等待真实事务结束后必须完成lease收尾（真实过期）');
  assert.equal(evaluator.inflight.size, 0);
});

// ============================================================
// C. bootstrap()分阶段启动失败在真实pg.Pool连接下逆序回滚（PG-4），共享池只关闭一次（PG-5）
// ============================================================

pgtest('PG-4/PG-5 startStagesWithRollback：真实连接下ForecastGenerator已启动、OutcomeEvaluator启动失败，逆序回滚真实释放Generator的lease，某stage.stop()报错不阻断其余回滚，原始错误被保留，共享池只关闭一次', async () => {
  // 独立于文件级共享pool的第二个真实pg.Pool——本测试会在末尾真实调用.end()，必须避免影响其他测试共用的pool
  const rollbackPool = await createPgPool({ databaseUrl: url, dbSsl: false });
  try {
    await expireLease(rollbackPool, GENERATOR_LEASE);
    await expireLease(rollbackPool, EVALUATOR_LEASE);
    // 预先让另一个holder持有Evaluator的lease且未过期，使outcomeEvaluator.start()在真实数据库判定下真实失败
    const competitor = new OutcomeEvaluator({ pool: rollbackPool, holderId: 'v14c-lifecycle-rollback-competitor', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000 });
    await competitor.acquireLease();

    const gen = new ForecastGenerator({ pool: rollbackPool, holderId: 'v14c-lifecycle-rollback-gen', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000 });
    const evaluator = new OutcomeEvaluator({ pool: rollbackPool, holderId: 'v14c-lifecycle-rollback-eval', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000 });

    const order = [];
    const rollbackErrors = [];
    const stages = [
      { name: 'flaky-marker', start: () => { order.push('start:flaky-marker'); }, stop: () => { order.push('stop:flaky-marker-attempt'); throw Object.assign(new Error('simulated stop failure'), { code: 'SIMULATED_STOP_FAILURE' }); } },
      { name: 'forecastGenerator', start: () => gen.start({ intervalMs: 10_000_000, heartbeatIntervalMs: 10_000_000 }).then(r => { order.push('start:forecastGenerator'); return r; }), stop: () => gen.stop().then(() => order.push('stop:forecastGenerator')) },
      { name: 'outcomeEvaluator', start: () => evaluator.start({ intervalMs: 10_000_000, heartbeatIntervalMs: 10_000_000 }).then(r => { order.push('start:outcomeEvaluator'); return r; }), stop: () => evaluator.stop().then(() => order.push('stop:outcomeEvaluator')) }
    ];

    await assert.rejects(
      startStagesWithRollback(stages, { onStageStopError: (stage, error) => rollbackErrors.push({ stage: stage.name, code: error.code }) }),
      error => error.code === 'OUTCOME_EVALUATOR_LEASE_HELD',
      '必须重新抛出真实的OutcomeEvaluator启动失败错误（真实lease被占用），而不是flaky-marker的清理错误'
    );

    assert.deepEqual(order, ['start:flaky-marker', 'start:forecastGenerator', 'stop:forecastGenerator', 'stop:flaky-marker-attempt'], '必须按已启动阶段的逆序回滚（outcomeEvaluator从未成功启动，不参与回滚）');
    assert.deepEqual(rollbackErrors, [{ stage: 'flaky-marker', code: 'SIMULATED_STOP_FAILURE' }], '某stage.stop()报错必须被记录，且不阻断其余stage继续回滚');

    // 真实数据库验证：ForecastGenerator的lease在回滚中被真实释放
    const genRow = await readLeaseRow(rollbackPool, GENERATOR_LEASE);
    assert.ok(genRow.expiresAt.getTime() <= Date.now(), '真实连接下回滚必须真实释放ForecastGenerator已持有的lease');
    assert.equal(gen.running, false);
    assert.equal(gen.timers.length, 0, '回滚后不得残留定时器');
    assert.equal(gen.heartbeatTimer, null);

    // 未被回滚触碰的Evaluator竞争者lease应保持不变（回滚不得误释放其他owner的lease）
    const competitorRow = await readLeaseRow(rollbackPool, EVALUATOR_LEASE);
    assert.equal(competitorRow.holderId, 'v14c-lifecycle-rollback-competitor');
    assert.ok(competitorRow.expiresAt.getTime() > Date.now());

    // PG-5：共享池只关闭一次，用createIdempotentCloser包装真实rollbackPool.end()
    let closeCalls = 0;
    const closeDatabase = createIdempotentCloser(async () => { closeCalls += 1; await rollbackPool.end(); });
    await closeDatabase();
    await closeDatabase();
    await closeDatabase();
    assert.equal(closeCalls, 1, '无论调用closeDatabase()多少次，真实pool.end()只能被真实调用一次');

    // 证明rollbackPool确实已被真实关闭（而非仅是flag）：再次查询必须失败
    await assert.rejects(rollbackPool.query('SELECT 1'), 'pool.end()之后对真实连接池发起查询必须失败，证明连接确已释放');
    return; // 已通过closeDatabase()真实关闭，跳过下方finally的重复end()
  } catch (error) {
    await safeEndPool(rollbackPool);
    throw error;
  }
});

// ============================================================
// D. 正常关停顺序：Forecast/Outcome等待在途真实事务、完成lease收尾，然后才关闭共享pg.Pool（PG-6）
// ============================================================

pgtest('PG-6 正常关停：stopStagesInOrder等待真实在途事务与lease收尾完成后，共享池才会被关闭', async () => {
  const shutdownPool = await createPgPool({ databaseUrl: url, dbSsl: false });
  try {
    await expireLease(shutdownPool, GENERATOR_LEASE);
    const gen = new ForecastGenerator({ pool: shutdownPool, holderId: 'v14c-lifecycle-shutdown-gen', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000 });
    await gen.start({ intervalMs: 10_000_000, heartbeatIntervalMs: 10_000_000 });

    const stages = [
      { name: 'forecastGenerator', start: () => gen.start(), stop: () => gen.stop() }
    ];
    const closeDatabase = createIdempotentCloser(async () => { await shutdownPool.end(); });

    const barrier = await acquireRowLockBarrier(shutdownPool, GENERATOR_LEASE);
    const runPromise = gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' });
    const blocked = await waitForBlockedLockRequest(shutdownPool, { timeoutMs: 5000 });
    assert.ok(blocked, 'runOnce()必须真实被行锁阻塞');

    const shutdownFlag = await settledFlag((async () => {
      await stopStagesInOrder(stages);
      await closeDatabase();
    })());
    await tick(); await tick();
    assert.equal(shutdownFlag.settled, false, '正常关停不得在Forecast的真实事务仍被阻塞时就关闭共享池');

    // 池尚未关闭：此刻仍可用同一个真实pool发起查询验证
    const stillOpen = await shutdownPool.query('SELECT 1 AS ok');
    assert.equal(stillOpen.rows[0].ok, 1, '关停流程等待期间共享池必须仍然可用（尚未close）');

    await barrier.release();
    await runPromise;
    const deadline = Date.now() + 5000;
    while (!shutdownFlag.settled && Date.now() < deadline) await tick();
    assert.equal(shutdownFlag.settled, true, '真实事务结束后关停流程必须能够完成');
    assert.equal(shutdownFlag.error, undefined);

    await assert.rejects(shutdownPool.query('SELECT 1'), '关停完成后共享池必须已被真实关闭');
  } finally {
    await safeEndPool(shutdownPool);
  }
});
