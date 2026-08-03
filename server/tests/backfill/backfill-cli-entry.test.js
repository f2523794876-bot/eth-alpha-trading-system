// R5：CLI参数与UTC时间格式fail-closed校验（静态单元测试，不需要数据库）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseUtc, main } from '../../src/backfill/backfill-cli-entry.js';
import { exitCodeForCliError, DATABASE_FAILURE_EXIT_CODE } from '../../src/db/research-database-guard.js';

const CLI_PATH = fileURLToPath(new URL('../../src/backfill/backfill-cli-entry.js', import.meta.url));

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

// Round 2（P1闭环）：三个数据库保护错误必须映射为独立、稳定、非零的DATABASE_FAILURE_EXIT_CODE，
// 与普通业务失败（此处用既有的RESUME_INTERVALS_CONFLICT代表）保持的默认exit 1可区分。
test('exitCodeForCliError：本CLI实际会抛出的三个数据库保护错误码映射到DATABASE_FAILURE_EXIT_CODE，非DB错误保持默认exit 1', () => {
  for (const code of ['DATABASE_URL_REQUIRED', 'DATABASE_URL_INVALID', 'DATABASE_TARGET_REJECTED']) {
    assert.equal(exitCodeForCliError({ code }), DATABASE_FAILURE_EXIT_CODE);
  }
  for (const code of ['RESUME_INTERVALS_CONFLICT', 'MISSING_REQUIRED_ARG', 'BACKFILL_RESUME_ALREADY_TERMINAL', undefined]) {
    assert.equal(exitCodeForCliError({ code }), 1);
  }
  assert.notEqual(DATABASE_FAILURE_EXIT_CODE, 1, 'DB失败码必须与普通业务失败码不同');
});

// 真实子进程级别验证：不经任何mock，直接spawn真实CLI文件，核对操作系统层面观察到的实际exit code——
// 这是比"调用main()后检查thrown error"更强的证据，证明顶层`main().catch(...)`确实调用了
// exitCodeForCliError并把结果真正赋给了process.exitCode。三种数据库保护场景均在触达任何网络/DB
// 连接之前失败，耗时应为毫秒级，不会真正访问网络或数据库。
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

test('真实子进程：普通业务错误（RESUME_INTERVALS_CONFLICT，不触达数据库）→ exit 1，与数据库失败码不同', () => {
  const result = spawnCli({}, ['--symbol', 'ETHUSDT', '--intervals', '15m,4h', '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-02T00:00:00Z', '--resume', 'abc']);
  assert.equal(result.status, 1);
  assert.notEqual(result.status, DATABASE_FAILURE_EXIT_CODE);
  assert.match(result.stderr, /RESUME_INTERVALS_CONFLICT/);
});
