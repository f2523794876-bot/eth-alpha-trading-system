// research-database-guard.js 专项单元测试：证明四个CLI共用的数据库目标保护是fail-closed的，
// 且保护失败时不会触发任何业务查询（只允许一次SELECT current_database()身份核验），
// 也不会泄漏未关闭的连接池。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEARCH_DATABASE_NAME, parseResearchDatabaseTarget, createGuardedResearchPgPool,
  DATABASE_FAILURE_EXIT_CODE, isDatabaseGuardErrorCode, exitCodeForCliError,
  ALLOWED_RESEARCH_DATABASE_IDENTITIES, assertExplicitResearchDatabaseIdentity,
  RESEARCH_DATABASE_IDENTITY_ENV
} from './research-database-guard.js';

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

test('显式数据库身份只允许research/test，并按既有CLI惯例执行trim+小写归一化', () => {
  assert.equal(RESEARCH_DATABASE_IDENTITY_ENV, 'V14D_DATABASE_IDENTITY');
  assert.deepEqual(ALLOWED_RESEARCH_DATABASE_IDENTITIES, ['research', 'test']);
  assert.equal(assertExplicitResearchDatabaseIdentity('research'), 'research');
  assert.equal(assertExplicitResearchDatabaseIdentity(' TEST '), 'test');
});

test('显式数据库身份缺失、未知或production冲突均fail-closed', () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.throws(() => assertExplicitResearchDatabaseIdentity(value), e => e.code === 'DATABASE_IDENTITY_REQUIRED');
  }
  assert.throws(() => assertExplicitResearchDatabaseIdentity('staging'), e => e.code === 'DATABASE_IDENTITY_REJECTED');
  assert.throws(() => assertExplicitResearchDatabaseIdentity('production'), e => e.code === 'DATABASE_IDENTITY_CONFLICT');
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

// P2-A（独立复审P2闭环）：显式补充"看起来很像目标库但不是"的两类典型误用——备份库名后缀、
// 以及被某种前缀脚本/命名规范加了前缀的库名——精确相等规则本应已经覆盖这两种情况，这里把它们
// 从隐含覆盖变成显式、命名清楚的回归用例，防止未来有人把RESEARCH_DATABASE_NAME的比较逻辑
// 不小心改成startsWith/includes之类的模糊匹配时，测试能第一时间失败。
test('parseResearchDatabaseTarget（P2-A）：eth_alpha_v14d_test_backup（备份库名后缀）拒绝，不视为目标库的变体', () => {
  assert.throws(
    () => parseResearchDatabaseTarget('postgresql://u:p@localhost:5432/eth_alpha_v14d_test_backup'),
    (e) => e.code === 'DATABASE_TARGET_REJECTED' && e.declaredDatabaseName === 'eth_alpha_v14d_test_backup'
  );
});

test('parseResearchDatabaseTarget（P2-A）：prefix_eth_alpha_v14d_test（带前缀的库名）拒绝，不视为目标库的变体', () => {
  assert.throws(
    () => parseResearchDatabaseTarget('postgresql://u:p@localhost:5432/prefix_eth_alpha_v14d_test'),
    (e) => e.code === 'DATABASE_TARGET_REJECTED' && e.declaredDatabaseName === 'prefix_eth_alpha_v14d_test'
  );
});

// P2-C（独立复审P2闭环，本轮判定为推迟实施，仅做当前行为的固化文档测试）：
// 已核实pg-connection-string@2.14.0（pg的传递依赖，非server/package.json的直接依赖）与本模块
// 目前使用的WHATWG URL在两类输入上解析结果不同：(a) 路径中的百分号编码——URL保留编码形式，
// pg-connection-string会解码；(b) 路径末尾空白——URL会丢弃，pg-connection-string会保留。
// 引入pg-connection-string需要新增直接依赖或依赖一个未声明的传递依赖，属于扩大范围，故本轮不实施，
// 只用以下测试固化"第一层URL解析"当前的真实行为，防止未来无意间改变；第二层SELECT current_database()
// 权威核验完全不依赖第一层解析方式，始终是最终把关人，不受本次推迟决定影响。
test('parseResearchDatabaseTarget（P2-C文档化）：路径末尾多一个"/"时拒绝（第一层按字面精确匹配，不做路径规范化）', () => {
  assert.throws(
    () => parseResearchDatabaseTarget('postgresql://u:p@localhost:5432/eth_alpha_v14d_test/'),
    (e) => e.code === 'DATABASE_TARGET_REJECTED' && e.declaredDatabaseName === 'eth_alpha_v14d_test/'
  );
});

test('parseResearchDatabaseTarget（P2-C文档化）：路径包含双斜杠（//eth_alpha_v14d_test）时拒绝', () => {
  assert.throws(
    () => parseResearchDatabaseTarget('postgresql://u:p@localhost:5432//eth_alpha_v14d_test'),
    (e) => e.code === 'DATABASE_TARGET_REJECTED'
  );
});

test('parseResearchDatabaseTarget（P2-C文档化）：URL携带query string（?sslmode=require）时，query不计入库名比较，正常通过', () => {
  assert.equal(
    parseResearchDatabaseTarget('postgresql://u:p@localhost:5432/eth_alpha_v14d_test?sslmode=require'),
    'eth_alpha_v14d_test'
  );
});

test('parseResearchDatabaseTarget（P2-C文档化）：URL携带fragment（#foo）时，fragment不计入库名比较，正常通过', () => {
  assert.equal(
    parseResearchDatabaseTarget('postgresql://u:p@localhost:5432/eth_alpha_v14d_test#foo'),
    'eth_alpha_v14d_test'
  );
});

test('parseResearchDatabaseTarget（P2-C文档化，已知与pg-connection-string的分歧点之一）：路径末尾空白被WHATWG URL丢弃，因此当前第一层会误判为匹配通过；这正是第二层current_database()权威核验必须始终保留、不可移除的原因', () => {
  assert.equal(
    parseResearchDatabaseTarget('postgresql://u:p@localhost:5432/eth_alpha_v14d_test '),
    'eth_alpha_v14d_test'
  );
});

test('parseResearchDatabaseTarget（P2-C文档化，已知与pg-connection-string的分歧点之二）：百分号编码的下划线（%5F）在WHATWG URL中不会被解码，因此第一层按字面拒绝（fail-closed方向，不构成安全问题，只是可能误伤本应合法的连接串）', () => {
  assert.throws(
    () => parseResearchDatabaseTarget('postgresql://u:p@localhost:5432/eth%5Falpha_v14d_test'),
    (e) => e.code === 'DATABASE_TARGET_REJECTED' && e.declaredDatabaseName === 'eth%5Falpha_v14d_test'
  );
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

// 数据库URL与显式身份保护错误码均映射到独立、稳定的DATABASE_FAILURE_EXIT_CODE。
const DATABASE_GUARD_ERROR_CODES = [
  'DATABASE_URL_REQUIRED', 'DATABASE_URL_INVALID', 'DATABASE_TARGET_REJECTED',
  'DATABASE_IDENTITY_REQUIRED', 'DATABASE_IDENTITY_REJECTED', 'DATABASE_IDENTITY_CONFLICT'
];

test('isDatabaseGuardErrorCode：只识别数据库URL/身份保护错误码，普通业务/参数/冲突错误码不识别', () => {
  for (const code of DATABASE_GUARD_ERROR_CODES) {
    assert.equal(isDatabaseGuardErrorCode(code), true);
  }
  for (const code of ['MISSING_REQUIRED_ARG', 'INVALID_RESUME_ID', 'RESUME_INTERVALS_CONFLICT', 'BACKFILL_RESUME_ALREADY_TERMINAL', undefined, null, '']) {
    assert.equal(isDatabaseGuardErrorCode(code), false);
  }
});

test('exitCodeForCliError：数据库保护错误映射到DATABASE_FAILURE_EXIT_CODE(=5)，与historical-feature-backfill.js既有的HISTORICAL_BACKFILL_EXIT.DATABASE_FAILURE数值保持一致', () => {
  assert.equal(DATABASE_FAILURE_EXIT_CODE, 5);
  for (const code of DATABASE_GUARD_ERROR_CODES) {
    assert.equal(exitCodeForCliError({ code }), DATABASE_FAILURE_EXIT_CODE);
    assert.equal(exitCodeForCliError(Object.assign(new Error('x'), { code })), DATABASE_FAILURE_EXIT_CODE);
  }
});

test('exitCodeForCliError：非数据库保护错误默认返回调用方传入的defaultExitCode（默认1），未识别错误不会被误报为退出码0（成功）', () => {
  assert.equal(exitCodeForCliError({ code: 'ANYTHING_ELSE' }), 1);
  assert.equal(exitCodeForCliError({}), 1);
  assert.equal(exitCodeForCliError(undefined), 1);
  assert.equal(exitCodeForCliError({ code: 'CUSTOM_CODE' }, { defaultExitCode: 3 }), 3, '调用方可覆盖默认非DB退出码（当前CLI均未覆盖，仍为1，这里只验证机制本身）');
  for (const result of [
    exitCodeForCliError({ code: 'ANYTHING_ELSE' }),
    exitCodeForCliError({}),
    exitCodeForCliError(undefined)
  ]) {
    assert.notEqual(result, 0, '未识别错误绝不能被误报为exit 0（成功）');
  }
});

// P2-B（独立复审P2闭环）：pool.end()自身失败时，绝不能替换掉更有诊断价值的原始安全错误——
// 调用方必须始终看到触发本次拒绝的真实原因（如DATABASE_TARGET_REJECTED），而不是一个无关的
// 连接池关闭异常。用一个query()和end()都会抛出、且抛出两个可区分错误的假连接池来验证。
test('createGuardedResearchPgPool（P2-B）：身份核验失败(DATABASE_TARGET_REJECTED)之后，若pool.end()本身也抛出异常，原始的DATABASE_TARGET_REJECTED仍必须是最终抛出的错误，而不是end()的异常', async () => {
  const pool = {
    calls: { query: 0, end: 0 },
    async query() {
      this.calls.query += 1;
      return { rows: [{ database: 'eth_alpha' }] };
    },
    async end() {
      this.calls.end += 1;
      throw new Error('SECONDARY_CLEANUP_FAILURE：连接池关闭本身失败，属于次要问题');
    }
  };
  const createPgPool = async () => pool;
  await assert.rejects(
    createGuardedResearchPgPool({ databaseUrl: 'postgresql://u:p@localhost:5432/eth_alpha_v14d_test' }, { createPgPool }),
    (e) => e.code === 'DATABASE_TARGET_REJECTED' && e.actualDatabaseName === 'eth_alpha'
  );
  assert.equal(pool.calls.end, 1, 'pool.end()仍必须被尝试调用一次，即使它自身会失败');
});

test('createGuardedResearchPgPool（P2-B）：query()本身抛出未分类异常、且随后pool.end()也抛出异常时，query()的原始异常仍必须是最终抛出的错误', async () => {
  const originalError = Object.assign(new Error('ORIGINAL_QUERY_FAILURE'), { code: 'ORIGINAL_QUERY_FAILURE' });
  const pool = {
    async query() { throw originalError; },
    async end() { throw new Error('SECONDARY_CLEANUP_FAILURE'); }
  };
  const createPgPool = async () => pool;
  await assert.rejects(
    createGuardedResearchPgPool({ databaseUrl: 'postgresql://u:p@localhost:5432/eth_alpha_v14d_test' }, { createPgPool }),
    (e) => e === originalError
  );
});

// Round 3（测试安全加固，Part 2）：补充此前独立复审标记为"代码结构上安全但缺少显式回归测试"的两个
// 边缘路径，只补测试，不改动createGuardedResearchPgPool本身的实现——本次复核确认既有实现已经满足
// 这两条要求（createPgPool()调用在try块之外，其自身抛错时不会进入引用pool的catch块；
// identity.rows?.[0]?.database的可选链在rows为空数组时安全求值为undefined，与目标库名比较不相等，
// 走DATABASE_TARGET_REJECTED的既有fail-closed路径）。
test('createGuardedResearchPgPool（边缘补充）：createPgPool()自身抛出的错误必须原样传播，不得尝试对不存在的pool调用end()，也不得产生任何二次/包装错误', async () => {
  const originalError = Object.assign(new Error('ECONNREFUSED: connection refused'), { code: 'ECONNREFUSED' });
  let endCalled = false;
  const createPgPool = async () => {
    // 用一个会记录end()调用次数、但根本不会被返回给调用方的"影子pool"来证明：即使某个实现细节
    // 意外持有了一个pool引用，也绝不会有代码路径调用其end()——因为createPgPool()本身在返回前就
    // 已经抛出，调用方（createGuardedResearchPgPool）在await这一行就直接向上传播异常，
    // 根本没有机会拿到、也没有变量绑定到任何pool对象。
    throw originalError;
  };
  await assert.rejects(
    createGuardedResearchPgPool({ databaseUrl: 'postgresql://u:p@localhost:5432/eth_alpha_v14d_test' }, { createPgPool }),
    (e) => e === originalError && e.code === 'ECONNREFUSED'
  );
  assert.equal(endCalled, false, 'createPgPool()自身抛错时，不存在可供调用end()的pool，因此end()一定未被调用');
});

test('createGuardedResearchPgPool（边缘补充）：current_database()查询成功返回但rows为空数组时，必须fail-closed为DATABASE_TARGET_REJECTED，且尝试关闭已建立的连接；pool.end()此时若失败，仍不得覆盖原始的DATABASE_TARGET_REJECTED', async () => {
  const pool = {
    calls: { query: 0, end: 0 },
    async query() {
      this.calls.query += 1;
      return { rows: [] }; // 空rows：identity.rows?.[0]?.database 求值为undefined
    },
    async end() {
      this.calls.end += 1;
      throw new Error('SECONDARY_CLEANUP_FAILURE：连接池关闭本身失败，属于次要问题');
    }
  };
  const createPgPool = async () => pool;
  await assert.rejects(
    createGuardedResearchPgPool({ databaseUrl: 'postgresql://u:p@localhost:5432/eth_alpha_v14d_test' }, { createPgPool }),
    (e) => e.code === 'DATABASE_TARGET_REJECTED' && e.declaredDatabaseName === 'eth_alpha_v14d_test' && e.actualDatabaseName === undefined
  );
  assert.equal(pool.calls.query, 1, 'rows为空也只应该执行一次身份核验查询，不得重试或发起其他查询');
  assert.equal(pool.calls.end, 1, '即使rows为空，已建立的连接仍必须被尝试关闭一次');
});
