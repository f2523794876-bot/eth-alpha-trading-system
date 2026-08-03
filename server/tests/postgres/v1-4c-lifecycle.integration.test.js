// V1.4C 生命周期加固（commit bc00658）真实PostgreSQL验证：补齐此前只在fake pool下验证过的6项行为——
// (1)ForecastGenerator/OutcomeEvaluator.releaseLease()真实生效 (2)owner/token/fencing隔离 (3)stop()等待真实
// 事务完成 (4)bootstrap()分阶段启动失败在真实连接下逆序回滚 (5)共享pg.Pool只关闭一次 (6)正常关停顺序。
// 沿用本仓库既有测试基础设施：TEST_DATABASE_URL隔离库名安全检查、runMigrations(down→up)重置schema、pgtest降级模式、
// Node内建test/assert。不修改任何生产实现（server/src/lifecycle.js、forecast/generator-service.js、
// outcome/evaluator-service.js、index.js）以迎合测试；本文件只使用它们已有的公开方法与构造参数。
//
// 复审补充（2026-07-25）：PG-4/PG-6最初只用手搭的stages数组直接调用startStagesWithRollback()/
// stopStagesInOrder()，从未真正调用src/index.js的bootstrap()，因此没有覆盖真实Collector/API装配、
// bootstrap()自身的catch回滚路径、以及它对共享pg.Pool的实际管理。本轮新增"PG-4-real"/"PG-6-real"两个
// 测试，直接import并调用真实的bootstrap()——利用它本就支持的config参数注入点（不修改bootstrap本身一行代码）：
// 把spotBaseUrl/futuresBaseUrl指向一个本机必然拒绝连接的端口（127.0.0.1:1），使Collector的真实HTTP请求
// 确定性地快速失败并被现有生产代码的容错路径吸收为BLOCKED状态（不抛异常，见collector/service.js runCycle()
// time.ok===false分支）——不需要另起一个假冒Binance的mock HTTP server，也没有绕开任何真实装配/真实网络层。
// 原有的"PG-4"/"PG-6"（不带-real后缀）继续保留，但改名为"编排层"专项，明确其覆盖范围仅是
// startStagesWithRollback()/stopStagesInOrder()这两个通用函数本身的正确性，不再暗示覆盖了bootstrap()装配。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPgPool } from '../../src/db/postgres.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ForecastGenerator, LEASE_NAME as GENERATOR_LEASE } from '../../src/forecast/generator-service.js';
import { OutcomeEvaluator, LEASE_NAME as EVALUATOR_LEASE } from '../../src/outcome/evaluator-service.js';
import { startStagesWithRollback, stopStagesInOrder, createIdempotentCloser } from '../../src/lifecycle.js';
import { bootstrap } from '../../src/index.js';

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const url = process.env.TEST_DATABASE_URL, enabled = isPostgresIntegrationTestAuthorized(url), pgtest = enabled ? test : test.skip;
let pool;
const COLLECTOR_LEASE = 'primary-collector';

// bootstrap()支持的config是一个普通参数（默认值才是loadConfig()），本身就是官方的注入点——直接构造一个
// 测试专用config对象传给bootstrap(config)，不需要也没有修改bootstrap()一行代码。spotBaseUrl/futuresBaseUrl
// 指向127.0.0.1:1（一个必然无人监听的特权端口，本机连接会被内核立即RST拒绝），让Collector的真实HTTP请求
// 快速且确定性地失败——不依赖真实Binance可达性（已知在部分GitHub Runner地区会被451阻塞，不确定性来源）。
// application_name标记本次bootstrap()内部创建的pg.Pool连接，供之后用pg_stat_activity真实核实"连接数归零"。
function buildBootstrapConfig({ collectorId, port, applicationName }) {
  const databaseUrl = new URL(url);
  databaseUrl.searchParams.set('application_name', applicationName);
  return Object.freeze({
    env: 'test', host: '127.0.0.1', port,
    databaseUrl: databaseUrl.toString(), dbSsl: false,
    collectorId,
    spotBaseUrl: 'http://127.0.0.1:1', futuresBaseUrl: 'http://127.0.0.1:1',
    timeoutMs: 2000, maxRetries: 0, backoffBaseMs: 1, backoffCapMs: 1,
    maxClockOffsetMs: 5000, leaseTtlMs: 60000,
    backfillPollMs: 200, backfillMaxAttempts: 1,
    forecastPollMs: 10_000_000, forecastFeatureWaitMs: 10, forecastFeatureWaitAttempts: 1,
    outcomePollMs: 10_000_000,
    freshnessGraceMultiplier: 3
  });
}

async function probeApiPort(port, { timeoutMs = 1000 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

// bootstrap()回滚/正常关停时其内部创建的pg.Pool对外完全不可见（回滚路径下bootstrap()甚至不会把任何引用
// 返回给调用方）——用application_name标记那一个pool的全部连接，之后用pg_stat_activity真实计数，
// 是唯一能从黑盒外部确认"bootstrap()自己持有的那个真实pg.Pool确实被关闭"的手段，而不是猜测或看返回值。
async function countTaggedConnections(adminPool, applicationName) {
  const result = await adminPool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1', [applicationName]);
  return Number(result.rows[0].n);
}

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

// row级FOR UPDATE/FOR SHARE的真实等待在PostgreSQL里通常表现为等待方持有一条locktype='transactionid'的未授予
// pg_locks行（等待持有冲突锁的那个事务结束），该行的relation/database列按文档定义为NULL——不能像table级锁那样
// 用relation做过滤。同时用pg_stat_activity.wait_event_type='Lock'交叉确认（PostgreSQL用它标记"正在等待获取任意
// 锁"的后端），两者任一命中即视为已探测到真实阻塞，避免依赖locktype的内部实现细节。
async function waitForBlockedLockRequest(adminPool, { timeoutMs = 5000, pollMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await adminPool.query(
      `SELECT
         (SELECT count(*) FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()) +
         (SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND pid <> pg_backend_pid())
       AS n`
    );
    if (Number(result.rows[0].n) > 0) return true;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return false;
}

async function readLeaseRow(adminPool, leaseName) {
  const result = await adminPool.query(
    'SELECT lease_name, holder_id AS "holderId", fencing_token::bigint AS "fencingToken", expires_at AS "expiresAt" FROM collector_leases WHERE lease_name=$1',
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

pgtest('PG-1/PG-2 ForecastGenerator.releaseLease()：错误owner与旧token均不影响真实lease行，正确owner+token真实使其过期', { timeout: 30_000 }, async () => {
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

pgtest('PG-1/PG-2 OutcomeEvaluator.releaseLease()：错误owner与旧token均不影响真实lease行，正确owner+token真实使其过期', { timeout: 30_000 }, async () => {
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

pgtest('PG-1 stop()端到端路径：真实调用stop()后lease行在数据库中确实已过期', { timeout: 30_000 }, async () => {
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

pgtest('PG-3 ForecastGenerator.stop()在runOnce()真实事务被行锁阻塞期间不会提前返回，锁释放后才返回并完成lease收尾', { timeout: 30_000 }, async () => {
  await expireLease(pool, GENERATOR_LEASE);
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-lifecycle-gen-block', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000 });
  await gen.start({ intervalMs: 10_000_000, heartbeatIntervalMs: 10_000_000 }); // acquireLease()以其自身独立的INSERT...ON CONFLICT提交，早于下方barrier加锁，不会自我阻塞

  const barrier = await acquireRowLockBarrier(pool, GENERATOR_LEASE);
  let runPromise;
  try {
    runPromise = gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' });
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
    // 无论上面哪一步断言失败，都必须先解锁再等待runPromise真正落定，避免遗留一个仍在阻塞、
    // 未被任何人等待的真实事务/客户端连接漏到下一个测试。
    await barrier.release().catch(() => {});
    if (runPromise) await runPromise.catch(() => {});
  }

  const row = await readLeaseRow(pool, GENERATOR_LEASE);
  assert.ok(row.expiresAt.getTime() <= Date.now(), 'stop()等待真实事务结束后必须完成lease收尾（真实过期）');
  assert.equal(gen.inflight.size, 0, '事务结束后inflight不得残留');
});

pgtest('PG-3 OutcomeEvaluator.stop()在runOnce()真实事务被行锁阻塞期间不会提前返回，锁释放后才返回并完成lease收尾', { timeout: 30_000 }, async () => {
  await expireLease(pool, EVALUATOR_LEASE);
  const evaluator = new OutcomeEvaluator({ pool, holderId: 'v14c-lifecycle-eval-block', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000, evaluationVersion: 'v1.4c-lifecycle-eval-block' });
  await evaluator.start({ intervalMs: 10_000_000, heartbeatIntervalMs: 10_000_000 });

  const barrier = await acquireRowLockBarrier(pool, EVALUATOR_LEASE);
  let runPromise;
  try {
    runPromise = evaluator.runOnce();
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
    if (runPromise) await runPromise.catch(() => {});
  }

  const row = await readLeaseRow(pool, EVALUATOR_LEASE);
  assert.ok(row.expiresAt.getTime() <= Date.now(), 'stop()等待真实事务结束后必须完成lease收尾（真实过期）');
  assert.equal(evaluator.inflight.size, 0);
});

// ============================================================
// C. 编排层专项：startStagesWithRollback()/createIdempotentCloser()本身在真实pg.Pool下的正确性——
//    只验证这两个通用函数，不涉及bootstrap()真实装配（真实bootstrap()覆盖见"PG-4-real"）。
// ============================================================

pgtest('[编排层] startStagesWithRollback：真实连接下ForecastGenerator已启动、OutcomeEvaluator启动失败，逆序回滚真实释放Generator的lease，某stage.stop()报错不阻断其余回滚，原始错误被保留，共享池只关闭一次', { timeout: 30_000 }, async () => {
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
// C-real. bootstrap()真实装配启动失败回滚（PG-4）：真实Collector/API/ForecastGenerator/OutcomeEvaluator，
//    通过src/index.js的真实bootstrap()（而非手搭stages）触发一次真实的OutcomeEvaluator启动失败。
// ============================================================

pgtest('PG-4-real bootstrap()真实装配：OutcomeEvaluator真实启动失败时，已真实启动的Collector/API/ForecastGenerator被真实逆序清理，其内部共享pg.Pool真实只关闭一次', { timeout: 30_000 }, async () => {
  await expireLease(pool, COLLECTOR_LEASE);
  await expireLease(pool, GENERATOR_LEASE);
  await expireLease(pool, EVALUATOR_LEASE);

  const applicationName = `v14c_bootstrap_rollback_${randomUUID().slice(0, 8)}`;
  const collectorId = `v14c-bootstrap-rollback-${randomUUID().slice(0, 8)}`;
  const apiPort = 48173; // GitHub Actions job专属隔离容器内的固定端口，job结束即销毁，无跨job冲突风险

  // 预先让另一个holder持有Outcome的lease（未过期），使bootstrap()内部真实的OutcomeEvaluator.start()真实失败——
  // 这是唯一预置的条件；Collector/API/ForecastGenerator全部通过真实bootstrap()装配与启动，未做任何模拟替身。
  const competitor = new OutcomeEvaluator({ pool, holderId: 'v14c-bootstrap-rollback-competitor', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000 });
  await competitor.acquireLease();

  const config = buildBootstrapConfig({ collectorId, port: apiPort, applicationName });

  await assert.rejects(
    bootstrap(config),
    error => error.code === 'OUTCOME_EVALUATOR_LEASE_HELD',
    'bootstrap()必须重新抛出真实的OutcomeEvaluator启动失败错误，而不是被回滚清理过程中的任何错误替换'
  );

  // 真实DB验证：ForecastGenerator真实启动过，其lease必须已在bootstrap()真实回滚中被释放。
  // 注意：CollectorService.stop()（既有V1.4A实现，本轮及上一轮均未修改、也不在本轮允许修改范围）本就不会释放
  // 自己的primary-collector lease——它复用与Forecast/Outcome相同的"ON CONFLICT...WHERE expires_at<=now()
  // OR holder_id=EXCLUDED.holder_id"重入语义，同一进程用同一个collectorId重启时无需显式释放即可原地续用。
  // 这不是本轮要修复的缺口，因此Collector是否真正被清空改用下方"回滚后不再产生新的collection_runs活动"这一
  // DB可观测代理来验证（真正需要验证的是"定时器被clearInterval"，而不是"lease被释放"这件对Collector不适用的事）。
  const genRow = await readLeaseRow(pool, GENERATOR_LEASE);
  assert.ok(genRow.expiresAt.getTime() <= Date.now(), 'bootstrap()真实回滚必须释放真实ForecastGenerator持有的lease');

  // Outcome从未真实启动成功——其lease行必须仍由competitor持有，未被回滚误触碰
  const competitorRow = await readLeaseRow(pool, EVALUATOR_LEASE);
  assert.equal(competitorRow.holderId, 'v14c-bootstrap-rollback-competitor', '回滚不得触碰从未真实启动成功的OutcomeEvaluator对应lease行的持有者');

  // 真实端口验证：bootstrap()内部真实创建并启动过的API server，必须已被真实关闭，不再监听
  assert.equal(await probeApiPort(apiPort), false, 'bootstrap()真实回滚后，真实API端口不得继续监听');

  // 真实连接数验证：bootstrap()内部持有的那一个pg.Pool（application_name标记）的全部真实连接都必须已关闭，
  // 而不是仅仅"看起来"关闭——这是从外部黑盒确认"该pool被真实关闭"的唯一可靠手段
  assert.equal(await countTaggedConnections(pool, applicationName), 0, 'bootstrap()回滚后其内部真实共享pg.Pool的全部连接都必须已真实关闭');

  // 真实DB活动证明Collector的真实定时器确已被清空：等待远超缩短后的backfillPollMs(200ms)，
  // 不得再出现任何新的collection_runs行——若定时器未被真实clearInterval，此处会检测到持续增长
  const runsAfterRollback = Number((await pool.query('SELECT count(*)::int AS n FROM collection_runs WHERE collector_id=$1', [collectorId])).rows[0].n);
  await new Promise(resolve => setTimeout(resolve, 800));
  const runsAfterWait = Number((await pool.query('SELECT count(*)::int AS n FROM collection_runs WHERE collector_id=$1', [collectorId])).rows[0].n);
  assert.equal(runsAfterWait, runsAfterRollback, 'Collector的真实定时器必须已被真实清空，回滚后不得再产生任何新的collection_runs活动');
});

// ============================================================
// D. 编排层专项：stopStagesInOrder()本身在真实pg.Pool下的正确性——只验证该通用函数，
//    不涉及bootstrap()真实装配（真实bootstrap()完整四阶段覆盖见"PG-6-real"）。
// ============================================================

pgtest('[编排层] 正常关停：stopStagesInOrder等待真实在途事务与lease收尾完成后，共享池才会被关闭', { timeout: 30_000 }, async () => {
  const shutdownPool = await createPgPool({ databaseUrl: url, dbSsl: false });
  let barrier, runPromise;
  try {
    await expireLease(shutdownPool, GENERATOR_LEASE);
    const gen = new ForecastGenerator({ pool: shutdownPool, holderId: 'v14c-lifecycle-shutdown-gen', serverTimeProvider: okServerTime(NEVER_DUE), leaseTtlMs: 60000 });
    await gen.start({ intervalMs: 10_000_000, heartbeatIntervalMs: 10_000_000 });

    const stages = [
      { name: 'forecastGenerator', start: () => gen.start(), stop: () => gen.stop() }
    ];
    const closeDatabase = createIdempotentCloser(async () => { await shutdownPool.end(); });

    barrier = await acquireRowLockBarrier(shutdownPool, GENERATOR_LEASE);
    runPromise = gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' });
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
    if (barrier) await barrier.release().catch(() => {});
    if (runPromise) await runPromise.catch(() => {});
    await safeEndPool(shutdownPool);
  }
});

// ============================================================
// D-real. bootstrap()真实装配正常关停（PG-6）：真实Collector/API/ForecastGenerator/OutcomeEvaluator全部
//    真实启动成功后，调用bootstrap()真实返回的stop()，验证严格逆序（Outcome→Forecast→API→Collector→池）——
//    stopStagesInOrder()对stages数组是严格串行for循环（见src/lifecycle.js），阻塞其中排在最前的Outcome，
//    足以确定性证明后面全部三个阶段与最终关池都必须等它先完成才能开始，无需sleep猜测。
// ============================================================

pgtest('PG-6-real bootstrap()真实装配：正常关停严格按Outcome→Forecast→API→Collector逆序执行，Outcome真实事务未结束前，API仍在监听、Collector的lease仍有效、共享池仍未关闭；结束后四个组件与共享池全部真实收尾', { timeout: 30_000 }, async () => {
  await expireLease(pool, COLLECTOR_LEASE);
  await expireLease(pool, GENERATOR_LEASE);
  await expireLease(pool, EVALUATOR_LEASE);

  const applicationName = `v14c_bootstrap_shutdown_${randomUUID().slice(0, 8)}`;
  const collectorId = `v14c-bootstrap-shutdown-${randomUUID().slice(0, 8)}`;
  const config = buildBootstrapConfig({ collectorId, port: 0, applicationName }); // port:0由OS真实分配，bootstrap()成功后从返回值读取真实端口

  const app = await bootstrap(config);
  const apiPort = app.api.server.address().port;
  assert.equal(await probeApiPort(apiPort), true, 'bootstrap()真实成功后，真实API端口必须处于监听状态');
  assert.ok(await countTaggedConnections(pool, applicationName) > 0, 'bootstrap()真实成功后，其内部真实pg.Pool必须持有至少一个真实连接');

  const barrier = await acquireRowLockBarrier(pool, EVALUATOR_LEASE);
  let outcomeRunPromise;
  try {
    // 用app.outcomeEvaluator（bootstrap()真实构造并真实start()过的那一个实例，不是另起的替身）触发一次真实runOnce()
    outcomeRunPromise = app.outcomeEvaluator.runOnce();
    const blocked = await waitForBlockedLockRequest(pool, { timeoutMs: 5000 });
    assert.ok(blocked, '真实OutcomeEvaluator.runOnce()必须真实被行锁阻塞');

    // app.stop()是bootstrap()真实返回的那个关停闭包，内部真实调用stopStagesInOrder(真实4个stages)+真实closeDatabase()
    const stopFlag = await settledFlag(app.stop('TEST'));
    await tick(); await tick();
    assert.equal(stopFlag.settled, false, '正常关停不得在Outcome的真实事务仍被阻塞时提前完成');

    // stopStagesInOrder对stages数组严格串行执行（for...of + await），Outcome排在逆序的第一位；
    // 只要它还没完成，后面的forecastGenerator/api/collector三个stage必然连"开始执行stop()"都还没轮到——
    // 用三项独立、可观测的真实信号分别验证"确实还没轮到"。Collector.running直接读取bootstrap()真实返回的
    // app.collector实例（本测试是成功路径，持有真实引用，不像PG-4-real的失败路径完全拿不到内部引用）——
    // 不用lease行判断Collector，因为CollectorService.stop()本就不释放自己的lease（见PG-4-real同名注释）。
    assert.equal(await probeApiPort(apiPort), true, 'Outcome仍被真实事务阻塞时，API必须仍在真实监听（严格逆序：outcome必须先于api完成停止）');
    assert.equal(app.collector.running, true, 'Outcome仍被真实事务阻塞时，Collector必须仍处于running状态（尚未轮到collector.stop()）');
    assert.ok(await countTaggedConnections(pool, applicationName) > 0, 'Outcome仍被真实事务阻塞时，共享pg.Pool必须仍未被真实关闭');

    await barrier.release(); // 唯一的解锁动作，来自测试显式控制
    await outcomeRunPromise.catch(() => {});
    const deadline = Date.now() + 8000;
    while (!stopFlag.settled && Date.now() < deadline) await tick();
    assert.equal(stopFlag.settled, true, 'Outcome真实事务结束后，正常关停必须能够完整走完剩余三个阶段并完成');
    assert.equal(stopFlag.error, undefined, 'app.stop()不应因等待真实事务而抛出异常');
  } finally {
    await barrier.release().catch(() => {});
    if (outcomeRunPromise) await outcomeRunPromise.catch(() => {});
  }

  // 关停完成后：真实Collector确已停止运行且定时器清空，ForecastGenerator/OutcomeEvaluator的lease均已真实释放，
  // 真实API端口已真实关闭，bootstrap()内部真实pg.Pool的全部连接已真实归零——四阶段+关池全部到位
  assert.equal(await probeApiPort(apiPort), false, '关停完成后，真实API端口必须已真实关闭');
  assert.equal(app.collector.running, false, '关停完成后Collector必须已真实停止运行');
  assert.equal(app.collector.timers.length, 0, '关停完成后Collector的真实定时器必须已被清空');
  const genRowAfter = await readLeaseRow(pool, GENERATOR_LEASE);
  assert.ok(genRowAfter.expiresAt.getTime() <= Date.now(), '关停完成后ForecastGenerator的真实lease必须已释放');
  const evalRowAfter = await readLeaseRow(pool, EVALUATOR_LEASE);
  assert.ok(evalRowAfter.expiresAt.getTime() <= Date.now(), '关停完成后OutcomeEvaluator的真实lease必须已释放');
  assert.equal(await countTaggedConnections(pool, applicationName), 0, '关停完成后bootstrap()内部真实pg.Pool的全部连接都必须已真实关闭');
});
