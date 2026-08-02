// dataset-manifest-cli-entry.js 数据库目标保护单元测试（不需要真实PostgreSQL，createPgPool通过
// main()的可选第二参数注入）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from './dataset-manifest-cli-entry.js';

const VALID_ARGV = ['--symbol', 'ETHUSDT', '--intervals', '15m', '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-02T00:00:00Z'];

function withDatabaseUrl(value, fn) {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = value;
  return fn().finally(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });
}

test('main()：DATABASE_URL指向eth_alpha_v14d_test且身份核验一致时，保护通过，越过guard进入manifest业务逻辑', async () => {
  await withDatabaseUrl('postgresql://u:p@127.0.0.1:5432/eth_alpha_v14d_test', async () => {
    let queryCount = 0;
    const pool = {
      async query() {
        queryCount += 1;
        if (queryCount === 1) return { rows: [{ database: 'eth_alpha_v14d_test' }] };
        throw Object.assign(new Error('SENTINEL_PAST_GUARD'), { code: 'SENTINEL_PAST_GUARD' });
      },
      async end() {}
    };
    await assert.rejects(main(VALID_ARGV, { createPgPool: async () => pool }), (e) => e.code === 'SENTINEL_PAST_GUARD');
    assert.ok(queryCount >= 2);
  });
});

test('main()：DATABASE_URL指向生产eth_alpha时拒绝，从不建立数据库连接', async () => {
  await withDatabaseUrl('postgresql://u:p@127.0.0.1:5432/eth_alpha', async () => {
    let called = false;
    await assert.rejects(
      main(VALID_ARGV, { createPgPool: async () => { called = true; return { query: async () => ({ rows: [] }), end: async () => {} }; } }),
      (e) => e.code === 'DATABASE_TARGET_REJECTED'
    );
    assert.equal(called, false);
  });
});

test('main()：DATABASE_URL指向postgres维护库时拒绝', async () => {
  await withDatabaseUrl('postgresql://u:p@127.0.0.1:5432/postgres', async () => {
    await assert.rejects(
      main(VALID_ARGV, { createPgPool: async () => ({ query: async () => ({ rows: [] }), end: async () => {} }) }),
      (e) => e.code === 'DATABASE_TARGET_REJECTED'
    );
  });
});

test('main()：DATABASE_URL缺失数据库名时拒绝', async () => {
  await withDatabaseUrl('postgresql://u:p@127.0.0.1:5432/', async () => {
    await assert.rejects(
      main(VALID_ARGV, { createPgPool: async () => ({ query: async () => ({ rows: [] }), end: async () => {} }) }),
      (e) => e.code === 'DATABASE_TARGET_REJECTED'
    );
  });
});

test('main()：DATABASE_URL格式非法时拒绝', async () => {
  await withDatabaseUrl('not-a-url', async () => {
    await assert.rejects(
      main(VALID_ARGV, { createPgPool: async () => ({ query: async () => ({ rows: [] }), end: async () => {} }) }),
      (e) => e.code === 'DATABASE_URL_INVALID'
    );
  });
});

test('main()：URL声明eth_alpha_v14d_test但current_database()返回其他库名时拒绝，且关闭连接、不再发起其他查询', async () => {
  await withDatabaseUrl('postgresql://u:p@127.0.0.1:5432/eth_alpha_v14d_test', async () => {
    const calls = { query: 0, end: 0 };
    const pool = { async query() { calls.query += 1; return { rows: [{ database: 'eth_alpha' }] }; }, async end() { calls.end += 1; } };
    await assert.rejects(main(VALID_ARGV, { createPgPool: async () => pool }), (e) => e.code === 'DATABASE_TARGET_REJECTED');
    assert.equal(calls.query, 1);
    assert.equal(calls.end, 1);
  });
});
