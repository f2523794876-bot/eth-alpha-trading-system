// research-database-guard.js 专项单元测试：证明四个CLI共用的数据库目标保护是fail-closed的，
// 且保护失败时不会触发任何业务查询（只允许一次SELECT current_database()身份核验），
// 也不会泄漏未关闭的连接池。
import test from 'node:test';
import assert from 'node:assert/strict';
import { RESEARCH_DATABASE_NAME, parseResearchDatabaseTarget, createGuardedResearchPgPool } from './research-database-guard.js';

function fakePool({ queryImpl } = {}) {
  const calls = { query: [], end: 0 };
  return {
    calls,
    async query(sql, params) {
      calls.query.push({ sql, params });
      if (queryImpl) return queryImpl(sql, params);
      return { rows: [{ database: RESEARCH_DATABASE_NAME }] };
    },
    async end() {
      calls.end += 1;
    }
  };
}

test('RESEARCH_DATABASE_NAME 精确等于 eth_alpha_v14d_test', () => {
  assert.equal(RESEARCH_DATABASE_NAME, 'eth_alpha_v14d_test');
});

test('parseResearchDatabaseTarget：eth_alpha_v14d_test 允许', () => {
  assert.equal(parseResearchDatabaseTarget('postgresql://u:p@localhost:5432/eth_alpha_v14d_test'), 'eth_alpha_v14d_test');
});

test('parseResearchDatabaseTarget：eth_alpha（生产库）拒绝', () => {
  assert.throws(
    () => parseResearchDatabaseTarget('postgresql://u:p@localhost:5432/eth_alpha'),
    (e) => e.code === 'DATABASE_TARGET_REJECTED' && e.declaredDatabaseName === 'eth_alpha'
  );
});

test('parseResearchDatabaseTarget：postgres（维护库）拒绝', () => {
  assert.throws(
    () => parseResearchDatabaseTarget('postgresql://u:p@localhost:5432/postgres'),
    (e) => e.code === 'DATABASE_TARGET_REJECTED' && e.declaredDatabaseName === 'postgres'
  );
});

test('parseResearchDatabaseTarget：缺失数据库名（路径为空）拒绝', () => {
  assert.throws(
    () => parseResearchDatabaseTarget('postgresql://u:p@localhost:5432/'),
    (e) => e.code === 'DATABASE_TARGET_REJECTED' && e.declaredDatabaseName === ''
  );
});

test('parseResearchDatabaseTarget：完全缺失DATABASE_URL拒绝，不尝试解析', () => {
  for (const value of [undefined, null, '']) {
    assert.throws(() => parseResearchDatabaseTarget(value), (e) => e.code === 'DATABASE_URL_REQUIRED');
  }
});

test('parseResearchDatabaseTarget：格式异常的URL拒绝（不抛出未捕获的URL解析异常）', () => {
  for (const value of ['not-a-url', 'postgresql://', 'eth_alpha_v14d_test', '   ']) {
    assert.throws(() => parseResearchDatabaseTarget(value), (e) => ['DATABASE_URL_INVALID', 'DATABASE_TARGET_REJECTED'].includes(e.code));
  }
});

test('parseResearchDatabaseTarget：任意其他未授权库名拒绝，不使用前缀/模式匹配（与测试隔离库门禁不同，这里要求精确相等）', () => {
  for (const name of ['eth_alpha_v14d_test_round4', 'eth_alpha_v14d_test2', 'arbitrary_database']) {
    assert.throws(
      () => parseResearchDatabaseTarget(`postgresql://u:p@localhost:5432/${name}`),
      (e) => e.code === 'DATABASE_TARGET_REJECTED'
    );
  }
});

test('createGuardedResearchPgPool：URL声明eth_alpha_v14d_test且current_database()确认一致时返回可用连接池，且只执行了一次身份核验查询', async () => {
  let created = false;
  const pool = fakePool();
  const createPgPool = async () => { created = true; return pool; };
  const result = await createGuardedResearchPgPool({ databaseUrl: 'postgresql://u:p@localhost:5432/eth_alpha_v14d_test' }, { createPgPool });
  assert.equal(created, true);
  assert.equal(result, pool);
  assert.equal(pool.calls.query.length, 1);
  assert.match(pool.calls.query[0].sql, /current_database/);
  assert.equal(pool.calls.end, 0, '成功路径不应关闭连接池');
});

test('createGuardedResearchPgPool：URL声明库名不符时，在建立连接前就拒绝——从不调用createPgPool（业务连接从未建立）', async () => {
  let createPgPoolCalled = false;
  const createPgPool = async () => { createPgPoolCalled = true; return fakePool(); };
  await assert.rejects(
    createGuardedResearchPgPool({ databaseUrl: 'postgresql://u:p@localhost:5432/eth_alpha' }, { createPgPool }),
    (e) => e.code === 'DATABASE_TARGET_REJECTED'
  );
  assert.equal(createPgPoolCalled, false, '库名在URL阶段就被拒绝时，绝不应该尝试真正建立数据库连接');
});

test('createGuardedResearchPgPool：URL声明eth_alpha_v14d_test，但连接后current_database()返回不同库名——拒绝，且关闭已建立的连接池，不返回可用连接给调用方', async () => {
  const pool = fakePool({ queryImpl: async () => ({ rows: [{ database: 'eth_alpha' }] }) });
  const createPgPool = async () => pool;
  await assert.rejects(
    createGuardedResearchPgPool({ databaseUrl: 'postgresql://u:p@localhost:5432/eth_alpha_v14d_test' }, { createPgPool }),
    (e) => e.code === 'DATABASE_TARGET_REJECTED' && e.declaredDatabaseName === 'eth_alpha_v14d_test' && e.actualDatabaseName === 'eth_alpha'
  );
  assert.equal(pool.calls.end, 1, '声明库名与运行时实际库名不符时必须关闭连接，不得泄漏');
  assert.equal(pool.calls.query.length, 1, '身份核验失败后不得再发起任何其他查询');
});

test('createGuardedResearchPgPool：postgres/生产eth_alpha/缺失库名均在URL阶段拒绝，从不创建连接池（业务repository/写入从未启动的最直接证明）', async () => {
  for (const badUrl of [
    'postgresql://u:p@localhost:5432/eth_alpha',
    'postgresql://u:p@localhost:5432/postgres',
    'postgresql://u:p@localhost:5432/',
    undefined
  ]) {
    let createPgPoolCalled = false;
    const createPgPool = async () => { createPgPoolCalled = true; return fakePool(); };
    await assert.rejects(createGuardedResearchPgPool({ databaseUrl: badUrl }, { createPgPool }));
    assert.equal(createPgPoolCalled, false);
  }
});
