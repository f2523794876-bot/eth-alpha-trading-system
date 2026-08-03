// dataset-manifest-cli-entry.js 数据库目标保护单元测试（不需要真实PostgreSQL，createPgPool通过
// main()的可选第二参数注入）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from './dataset-manifest-cli-entry.js';
import { exitCodeForCliError, DATABASE_FAILURE_EXIT_CODE } from '../db/research-database-guard.js';

const CLI_PATH = fileURLToPath(new URL('./dataset-manifest-cli-entry.js', import.meta.url));

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

// Round 2（P1闭环）：三个数据库保护错误必须映射为独立、稳定、非零的DATABASE_FAILURE_EXIT_CODE，
// 与普通业务失败（此处用MISSING_REQUIRED_ARG代表）保持的默认exit 1可区分。
test('exitCodeForCliError：本CLI实际会抛出的三个数据库保护错误码映射到DATABASE_FAILURE_EXIT_CODE，非DB错误保持默认exit 1', () => {
  for (const code of ['DATABASE_URL_REQUIRED', 'DATABASE_URL_INVALID', 'DATABASE_TARGET_REJECTED']) {
    assert.equal(exitCodeForCliError({ code }), DATABASE_FAILURE_EXIT_CODE);
  }
  for (const code of ['MISSING_REQUIRED_ARG', 'INVALID_TIME_FORMAT', undefined]) {
    assert.equal(exitCodeForCliError({ code }), 1);
  }
  assert.notEqual(DATABASE_FAILURE_EXIT_CODE, 1);
});

function spawnCli(env, argv) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('真实子进程：DATABASE_URL缺失 → exit 5', () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const result = spawnCli(env, VALID_ARGV);
  assert.equal(result.status, DATABASE_FAILURE_EXIT_CODE);
  assert.match(result.stderr, /DATABASE_URL_REQUIRED/);
});

test('真实子进程：DATABASE_URL格式非法 → exit 5', () => {
  const result = spawnCli({ DATABASE_URL: 'not-a-url' }, VALID_ARGV);
  assert.equal(result.status, DATABASE_FAILURE_EXIT_CODE);
  assert.match(result.stderr, /DATABASE_URL_INVALID/);
});

test('真实子进程：DATABASE_URL指向生产eth_alpha → exit 5', () => {
  const result = spawnCli({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/eth_alpha' }, VALID_ARGV);
  assert.equal(result.status, DATABASE_FAILURE_EXIT_CODE);
  assert.match(result.stderr, /DATABASE_TARGET_REJECTED/);
  assert.doesNotMatch(result.stderr, /u:p@127\.0\.0\.1/, '不得在stderr中泄漏连接串/用户名/密码');
});

test('真实子进程：普通业务错误（缺失--intervals，UTC参数本身合法，不触达数据库）→ exit 1，与数据库失败码不同', () => {
  const result = spawnCli({}, ['--symbol', 'ETHUSDT', '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-02T00:00:00Z']);
  assert.equal(result.status, 1);
  assert.notEqual(result.status, DATABASE_FAILURE_EXIT_CODE);
  assert.match(result.stderr, /MISSING_REQUIRED_ARG|--symbol and --intervals are required/);
});
