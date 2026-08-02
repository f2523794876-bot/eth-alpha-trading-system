// R5：CLI参数与UTC时间格式fail-closed校验（静态单元测试，不需要数据库）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseUtc, main } from '../../src/backfill/backfill-cli-entry.js';

const VALID_ARGV = ['--symbol', 'ETHUSDT', '--intervals', '15m', '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-02T00:00:00Z'];

function withDatabaseUrl(value, fn) {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = value;
  return fn().finally(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });
}

function fakePool(databaseName = 'eth_alpha_v14d_test') {
  const calls = { query: 0, end: 0 };
  return { calls, async query() { calls.query += 1; return { rows: [{ database: databaseName }] }; }, async end() { calls.end += 1; } };
}

test('parseArgs：解析 --key value 形式的参数', () => {
  const args = parseArgs(['--symbol', 'ETHUSDT', '--intervals', '15m,1h,4h', '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-02T00:00:00Z']);
  assert.deepEqual(args, { symbol: 'ETHUSDT', intervals: '15m,1h,4h', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' });
});

test('parseArgs：无值的flag（如 --resume 缺参数时后面紧跟另一个--flag）被解析为boolean true', () => {
  const args = parseArgs(['--dry-run', '--symbol', 'ETHUSDT']);
  assert.equal(args['dry-run'], true);
  assert.equal(args.symbol, 'ETHUSDT');
});

test('parseUtc：接受严格的UTC ISO8601（含毫秒的Z后缀）', () => {
  assert.equal(parseUtc('2026-01-01T00:00:00Z', '--from'), Date.UTC(2026, 0, 1));
  assert.equal(parseUtc('2026-01-01T00:00:00.123Z', '--from'), Date.UTC(2026, 0, 1) + 123);
});

test('parseUtc：fail closed 拒绝非UTC/无Z后缀/本地时区偏移/非法格式', () => {
  for (const bad of ['2026-01-01', '2026-01-01T00:00:00', '2026-01-01T00:00:00+08:00', '2026/01/01T00:00:00Z', 'not-a-date', undefined, true]) {
    assert.throws(() => parseUtc(bad, '--from'), (err) => err.code === 'INVALID_TIME_FORMAT');
  }
});

// 数据库目标保护（research-database-guard.js）在main()层面的端到端覆盖：证明本CLI真的接入了共享保护，
// 不是只在shared模块自身的单测里成立。createPgPool通过main()新增的可选第二参数注入，不需要真实PostgreSQL。
test('main()：DATABASE_URL指向eth_alpha_v14d_test且current_database()确认一致时，保护通过，真正越过guard进入回填业务逻辑（用哨兵错误证明，不触发真实网络请求）', async () => {
  await withDatabaseUrl('postgresql://u:p@127.0.0.1:5432/eth_alpha_v14d_test', async () => {
    let queryCount = 0;
    const pool = {
      async query() {
        queryCount += 1;
        if (queryCount === 1) return { rows: [{ database: 'eth_alpha_v14d_test' }] }; // guard的身份核验
        throw Object.assign(new Error('SENTINEL_PAST_GUARD'), { code: 'SENTINEL_PAST_GUARD' }); // guard之后的第一次业务查询
      },
      async end() {}
    };
    await assert.rejects(main(VALID_ARGV, { createPgPool: async () => pool }), (e) => e.code === 'SENTINEL_PAST_GUARD');
    assert.ok(queryCount >= 2, 'guard通过后必须真的走到了业务查询（backfill_batches），证明保护本身没有误伤正常路径');
  });
});

test('main()：DATABASE_URL指向生产eth_alpha时拒绝，且从不建立数据库连接（createPgPool从未被调用，回填/联网逻辑无从谈起）', async () => {
  await withDatabaseUrl('postgresql://u:p@127.0.0.1:5432/eth_alpha', async () => {
    let called = false;
    const createPgPool = async () => { called = true; return fakePool(); };
    await assert.rejects(main(VALID_ARGV, { createPgPool }), (e) => e.code === 'DATABASE_TARGET_REJECTED');
    assert.equal(called, false, 'DATABASE_URL指向生产库时绝不应该尝试建立连接');
  });
});

test('main()：DATABASE_URL指向postgres维护库时拒绝', async () => {
  await withDatabaseUrl('postgresql://u:p@127.0.0.1:5432/postgres', async () => {
    await assert.rejects(main(VALID_ARGV, { createPgPool: async () => fakePool() }), (e) => e.code === 'DATABASE_TARGET_REJECTED');
  });
});

test('main()：DATABASE_URL缺失数据库名时拒绝', async () => {
  await withDatabaseUrl('postgresql://u:p@127.0.0.1:5432/', async () => {
    await assert.rejects(main(VALID_ARGV, { createPgPool: async () => fakePool() }), (e) => e.code === 'DATABASE_TARGET_REJECTED');
  });
});

test('main()：DATABASE_URL格式非法时拒绝，不抛出未分类异常', async () => {
  await withDatabaseUrl('not-a-url', async () => {
    await assert.rejects(main(VALID_ARGV, { createPgPool: async () => fakePool() }), (e) => e.code === 'DATABASE_URL_INVALID');
  });
});

test('main()：DATABASE_URL声明eth_alpha_v14d_test但真实连接后current_database()返回其他库名时拒绝，且不会调用任何回填相关的query之外的连接池方法', async () => {
  await withDatabaseUrl('postgresql://u:p@127.0.0.1:5432/eth_alpha_v14d_test', async () => {
    const pool = fakePool('eth_alpha');
    await assert.rejects(main(VALID_ARGV, { createPgPool: async () => pool }), (e) => e.code === 'DATABASE_TARGET_REJECTED');
    assert.equal(pool.calls.query, 1, '只应该执行一次身份核验查询，不得有任何业务查询');
    assert.equal(pool.calls.end, 1, '身份不符时必须关闭连接');
  });
});
