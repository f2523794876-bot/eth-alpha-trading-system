// R5/R7.1a：backfill-cli-entry.js 的 historical_validation.backfill_batches 审计行生命周期
// （创建/恢复/ATTENTION_REQUIRED标记/FAILED标记），使用隔离测试库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { runBackfillForInterval, main as backfillMain } from '../../src/backfill/backfill-cli-entry.js';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(TEST_DATABASE_URL);

function makeMockAdapter({ pages, serverTimeMs, calls }) {
  let call = 0;
  return {
    serverTime: async () => ({ body: { serverTime: serverTimeMs }, requestId: randomUUID() }),
    spotKlines: async (symbol, interval, opts) => {
      calls?.push(opts);
      const page = pages[call] || [];
      call += 1;
      return { body: page, requestId: randomUUID(), status: 200, headers: {} };
    }
  };
}

function kline(openTime, closeTime, closeStr = '1000.00') {
  return [openTime, '999.00', '1001.00', '998.00', closeStr, '10.5', closeTime, '10500.00', 5, '5.0', '5000.00'];
}

// R11.4修复后，--resume只接受真正仍处于RUNNING的批次。此前多个测试把"first run"跑到一个自然终态
// （ATTENTION_REQUIRED/SUCCEEDED）后直接对它发起--resume，依赖的是修复前"resume可以复活任意终态"的
// 错误行为——现在必须改为真实模拟"进程在finalize之前被杀死"：直接创建status='RUNNING'的审计行，
// 再直接调用底层backfillInterval()（不经过runBackfillForInterval的finalize包装）完成"抓取+落库+
// 推进游标"，使批次行精确停留在真实中断时的状态（status仍是RUNNING，last_completed_open_time已推进）。
async function createRunningBatch(client, { symbol, interval, requestedStart, requestedEnd, fixedAsOf = requestedEnd - 1, pages, serverTimeMs, calls }) {
  const backfillBatchId = randomUUID();
  await client.query(
    `INSERT INTO historical_validation.backfill_batches(backfill_batch_id,symbol,interval_name,requested_start_utc,requested_end_utc,fixed_as_of,status,started_at)
     VALUES($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),to_timestamp($6/1000.0),'RUNNING',now())`,
    [backfillBatchId, symbol, interval, requestedStart, requestedEnd, fixedAsOf]
  );
  const adapter = makeMockAdapter({ pages, serverTimeMs, calls });
  const result = await backfillInterval({ pool: client, adapter, symbol, interval, startTime: requestedStart, endTime: requestedEnd, fixedAsOf, backfillBatchId, now: () => serverTimeMs });
  return { backfillBatchId, result };
}

async function withTxClient(fn) {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

test('R5：正常回填后batch标记SUCCEEDED，且integrity无异常', { skip }, async () => {
  await withTxClient(async (client) => {
    const openTime = Date.UTC(2026, 1, 1, 0, 0, 0);
    const closeTime = openTime + 900000 - 1;
    const nowMs = closeTime + 60000;
    const adapter = makeMockAdapter({ pages: [[kline(openTime, closeTime)]], serverTimeMs: nowMs });

    // requested_start_utc < requested_end_utc 是 backfill_batches 表的CHECK约束（审计请求区间，非单点），
    // 故此处endTime取下一根bar的open_time，即便本次mock只返回一页(一根bar)。
    const result = await runBackfillForInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime + 900000, fixedAsOf: closeTime, now: () => nowMs });
    assert.equal(result.status, 'SUCCEEDED');

    const batch = (await client.query('SELECT status, rows_inserted FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [result.backfillBatchId])).rows[0];
    assert.equal(batch.status, 'SUCCEEDED');
  });
});

test('R7.1a：回填后完整性检测发现缺口时batch标记ATTENTION_REQUIRED，不自动重试覆盖', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 1, 2, 0, 0, 0);
    const bar0Open = base, bar0Close = base + 900000 - 1;
    const bar2Open = base + 1800000, bar2Close = bar2Open + 900000 - 1; // 跳过bar1，制造缺口
    const nowMs = bar2Close + 60000;
    const adapter = makeMockAdapter({ pages: [[kline(bar0Open, bar0Close), kline(bar2Open, bar2Close)]], serverTimeMs: nowMs });

    const result = await runBackfillForInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar2Close + 1, fixedAsOf: bar2Close, now: () => nowMs });
    assert.equal(result.status, 'ATTENTION_REQUIRED');
    assert.equal(result.integrity.gapCount, 1);

    const batch = (await client.query('SELECT status, error_code FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [result.backfillBatchId])).rows[0];
    assert.equal(batch.status, 'ATTENTION_REQUIRED');
    assert.equal(batch.error_code, 'INTEGRITY_CHECK_FAILED');
  });
});

test('R2.3：serverTime校时失败时batch标记FAILED', { skip }, async () => {
  await withTxClient(async (client) => {
    const adapter = { serverTime: async () => { throw Object.assign(new Error('down'), { code: 'NETWORK_ERROR' }); }, spotKlines: async () => { throw new Error('must not be called'); } };
    const result = await runBackfillForInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: 0, endTime: 900000, fixedAsOf: 899999 });
    assert.equal(result.status, 'FAILED');
    const batch = (await client.query('SELECT status FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [result.backfillBatchId])).rows[0];
    assert.equal(batch.status, 'FAILED');
  });
});

test('resume：携带已有backfill_batch_id时从last_completed_open_time之后续跑，不重复回填首段', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 1, 3, 0, 0, 0);
    const bar0Open = base, bar0Close = base + 900000 - 1;
    const bar1Open = base + 900000, bar1Close = bar1Open + 900000 - 1;
    const nowMs1 = bar0Close + 60000;

    // R11.4修复后，--resume只接受真正仍处于RUNNING的批次——用createRunningBatch精确模拟"进程在
    // finalize之前被杀死"：只喂一页(bar0)并直接调用底层backfillInterval()，批次行停留在RUNNING，
    // 不经过runBackfillForInterval的finalize（那会立刻把它转成ATTENTION_REQUIRED终态）。
    const calls1 = [];
    const first = await createRunningBatch(client, {
      symbol: 'ETHUSDT', interval: '15m', requestedStart: bar0Open, requestedEnd: bar1Close + 1,
      pages: [[kline(bar0Open, bar0Close)]], serverTimeMs: nowMs1, calls: calls1
    });
    // resume校验的重点是：续跑时 backfillInterval 传给 adapter.spotKlines 的 startTime 已经推进到 bar0之后，而不是从bar0Open重新拉取。
    assert.equal(calls1[0].startTime, bar0Open);
    const runningBatch = (await client.query('SELECT status FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [first.backfillBatchId])).rows[0];
    assert.equal(runningBatch.status, 'RUNNING', '中断模拟前提：批次必须真实停留在RUNNING，而不是任何终态');

    const nowMs2 = bar1Close + 60000;
    const calls2 = [];
    const adapter2 = makeMockAdapter({ pages: [[kline(bar1Open, bar1Close)]], serverTimeMs: nowMs2, calls: calls2 });
    const second = await runBackfillForInterval({ pool: client, adapter: adapter2, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar1Close + 1, fixedAsOf: bar1Close, resumeBatchId: first.backfillBatchId, now: () => nowMs2 });
    assert.equal(second.status, 'SUCCEEDED');
    assert.equal(calls2[0].startTime, bar1Open, 'resume游标必须推进到下一根15m K线的open_time，不得从bar0Open重新拉取');

    const bar0Count = (await client.query(`SELECT count(*)::int AS n FROM market_bars WHERE close_time=to_timestamp($1/1000.0)`, [bar0Close])).rows[0].n;
    const bar1Count = (await client.query(`SELECT count(*)::int AS n FROM market_bars WHERE close_time=to_timestamp($1/1000.0)`, [bar1Close])).rows[0].n;
    assert.equal(bar0Count, 1);
    assert.equal(bar1Count, 1);
  });
});

// P1-6修复（独立复审）：resume batch的symbol/interval_name必须与当前请求一致；单个--resume不得被
// 静默应用到多个interval；resume batch不存在时明确拒绝；拒绝必须发生在任何market_bars写入前。
test('P1-6：正确symbol和interval恢复成功（回归——修复前的合法用法必须继续可用）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 1, 10, 0, 0, 0);
    const bar0Open = base, bar0Close = base + 900000 - 1;
    const bar1Open = base + 900000, bar1Close = bar1Open + 900000 - 1;
    const nowMs1 = bar0Close + 60000;

    // R11.4修复后，resume只接受真正仍处于RUNNING的批次——用createRunningBatch模拟真实中断。
    const first = await createRunningBatch(client, {
      symbol: 'ETHUSDT', interval: '15m', requestedStart: bar0Open, requestedEnd: bar1Close + 1,
      pages: [[kline(bar0Open, bar0Close)]], serverTimeMs: nowMs1
    });

    const nowMs2 = bar1Close + 60000;
    const adapter2 = makeMockAdapter({ pages: [[kline(bar1Open, bar1Close)]], serverTimeMs: nowMs2 });
    const second = await runBackfillForInterval({ pool: client, adapter: adapter2, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar1Close + 1, fixedAsOf: bar1Close, resumeBatchId: first.backfillBatchId, now: () => nowMs2 });
    assert.equal(second.status, 'SUCCEEDED');
  });
});

test('P1-6红线：resume batch的symbol与当前请求不一致——拒绝(BACKFILL_RESUME_SYMBOL_INTERVAL_MISMATCH)，且不在市场数据表留下痕迹', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 1, 11, 0, 0, 0);
    const bar0Open = base, bar0Close = base + 900000 - 1;
    const nowMs = bar0Close + 60000;
    const adapter = makeMockAdapter({ pages: [[kline(bar0Open, bar0Close)]], serverTimeMs: nowMs });
    const first = await runBackfillForInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar0Open + 900000, fixedAsOf: bar0Close, now: () => nowMs });
    assert.equal(first.status, 'SUCCEEDED');

    const beforeMarketBars = (await client.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n;

    const wrongSymbolAdapter = { serverTime: async () => { throw new Error('must not be called — rejection must happen before any adapter interaction'); } };
    await assert.rejects(
      runBackfillForInterval({ pool: client, adapter: wrongSymbolAdapter, symbol: 'BTCUSDT', interval: '15m', startTime: bar0Open, endTime: bar0Open + 900000, fixedAsOf: bar0Close, resumeBatchId: first.backfillBatchId, now: () => nowMs }),
      (e) => e.code === 'BACKFILL_RESUME_SYMBOL_INTERVAL_MISMATCH' && e.expectedSymbol === 'ETHUSDT' && e.actualSymbol === 'BTCUSDT'
    );

    const afterMarketBars = (await client.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n;
    assert.equal(afterMarketBars, beforeMarketBars, '拒绝必须发生在任何market_bars写入之前——行数必须逐字节不变');

    const batchStatus = (await client.query('SELECT status FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [first.backfillBatchId])).rows[0].status;
    assert.equal(batchStatus, 'SUCCEEDED', '原batch本身的状态不得被这次被拒绝的resume尝试污染');
  });
});

test('P1-6红线：resume batch的interval_name与当前请求不一致——拒绝(BACKFILL_RESUME_SYMBOL_INTERVAL_MISMATCH)', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 1, 12, 0, 0, 0);
    const bar0Open = base, bar0Close = base + 900000 - 1;
    const nowMs = bar0Close + 60000;
    const adapter = makeMockAdapter({ pages: [[kline(bar0Open, bar0Close)]], serverTimeMs: nowMs });
    const first = await runBackfillForInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar0Open + 900000, fixedAsOf: bar0Close, now: () => nowMs });
    assert.equal(first.status, 'SUCCEEDED');

    const beforeMarketBars = (await client.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n;
    const mustNotBeCalledAdapter = { serverTime: async () => { throw new Error('must not be called'); } };
    await assert.rejects(
      runBackfillForInterval({ pool: client, adapter: mustNotBeCalledAdapter, symbol: 'ETHUSDT', interval: '4h', startTime: bar0Open, endTime: bar0Open + 14400000, fixedAsOf: bar0Open + 14400000 - 1, resumeBatchId: first.backfillBatchId, now: () => nowMs }),
      (e) => e.code === 'BACKFILL_RESUME_SYMBOL_INTERVAL_MISMATCH' && e.expectedInterval === '15m' && e.actualInterval === '4h'
    );
    const afterMarketBars = (await client.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n;
    assert.equal(afterMarketBars, beforeMarketBars);
  });
});

test('P1-6：resume batch请求区间与当前请求不一致——拒绝(BACKFILL_RESUME_RANGE_MISMATCH)', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 1, 13, 0, 0, 0);
    const bar0Open = base, bar0Close = base + 900000 - 1;
    const nowMs = bar0Close + 60000;
    const adapter = makeMockAdapter({ pages: [[kline(bar0Open, bar0Close)]], serverTimeMs: nowMs });
    const first = await runBackfillForInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar0Open + 900000, fixedAsOf: bar0Close, now: () => nowMs });
    assert.equal(first.status, 'SUCCEEDED');

    const mustNotBeCalledAdapter = { serverTime: async () => { throw new Error('must not be called'); } };
    await assert.rejects(
      runBackfillForInterval({ pool: client, adapter: mustNotBeCalledAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar0Open + 900000 + 900000, fixedAsOf: bar0Close, resumeBatchId: first.backfillBatchId, now: () => nowMs }),
      (e) => e.code === 'BACKFILL_RESUME_RANGE_MISMATCH'
    );
  });
});

test('P1-6：不存在的resume batch——拒绝(BACKFILL_BATCH_NOT_FOUND)', { skip }, async () => {
  await withTxClient(async (client) => {
    const mustNotBeCalledAdapter = { serverTime: async () => { throw new Error('must not be called'); } };
    await assert.rejects(
      runBackfillForInterval({ pool: client, adapter: mustNotBeCalledAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: 0, endTime: 900000, fixedAsOf: 899999, resumeBatchId: randomUUID(), now: () => Date.now() }),
      (e) => e.code === 'BACKFILL_BATCH_NOT_FOUND'
    );
  });
});

test('P1-6：main()——单个--resume加多个--intervals必须拒绝(RESUME_INTERVALS_CONFLICT)，不连接任何数据库', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL; // 确保即使校验意外未能提前拦截，也不会连接到任何真实数据库（含生产）。
  try {
    await assert.rejects(
      backfillMain(['--symbol', 'ETHUSDT', '--intervals', '15m,4h', '--from', '2026-02-01T00:00:00Z', '--to', '2026-02-02T00:00:00Z', '--resume', randomUUID()]),
      (e) => e.code === 'RESUME_INTERVALS_CONFLICT'
    );
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test('P1-6：校验优先级——无resume冲突时缺少--as-of仍稳定返回AS_OF_REQUIRED', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const common = ['--symbol', 'ETHUSDT', '--from', '2026-02-01T00:00:00Z', '--to', '2026-02-02T00:00:00Z'];
    await assert.rejects(
      backfillMain([...common, '--intervals', '15m', '--resume', randomUUID()]),
      error => error.code === 'AS_OF_REQUIRED'
    );
    await assert.rejects(
      backfillMain([...common, '--intervals', '15m,4h']),
      error => error.code === 'AS_OF_REQUIRED'
    );
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test('P1-6：单个--resume加单个interval不受影响——runBackfillForInterval正常resume路径不回归', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 1, 14, 0, 0, 0);
    const bar0Open = base, bar0Close = base + 900000 - 1;
    const bar1Open = base + 900000, bar1Close = bar1Open + 900000 - 1;
    const nowMs1 = bar0Close + 60000;
    // R11.4修复后，resume只接受真正仍处于RUNNING的批次——用createRunningBatch模拟真实中断。
    const first = await createRunningBatch(client, {
      symbol: 'ETHUSDT', interval: '15m', requestedStart: bar0Open, requestedEnd: bar1Close + 1,
      pages: [[kline(bar0Open, bar0Close)]], serverTimeMs: nowMs1
    });

    // main()级别RESUME_INTERVALS_CONFLICT只应在intervals.length>1时触发；单interval场景下main()
    // 必须把args.resume原样透传给runBackfillForInterval，continue正常resume。此处直接验证
    // runBackfillForInterval（main()对单interval时实际调用的同一底层函数）resume路径本身未被破坏。
    const nowMs2 = bar1Close + 60000;
    const adapter2 = makeMockAdapter({ pages: [[kline(bar1Open, bar1Close)]], serverTimeMs: nowMs2 });
    const second = await runBackfillForInterval({ pool: client, adapter: adapter2, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar1Close + 1, fixedAsOf: bar1Close, resumeBatchId: first.backfillBatchId, now: () => nowMs2 });
    assert.equal(second.status, 'SUCCEEDED');
    assert.equal(second.backfillBatchId, first.backfillBatchId, '单interval resume必须复用同一个backfill_batch_id');
  });
});

test('P1-6：main()——正常非resume多interval流程不回归（不传--resume时多个interval各自独立创建batch，互不干扰）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 1, 15, 0, 0, 0);
    const bar15mOpen = base, bar15mClose = base + 900000 - 1;
    const bar4hOpen = base, bar4hClose = base + 14400000 - 1;

    // 镜像main()循环体：不传resumeBatchId，对多个interval依次各自独立调用runBackfillForInterval——
    // 验证P1-6新增的symbol/interval一致性校验不会误伤"本来就没有resume"的正常多interval流程。
    const adapter15m = makeMockAdapter({ pages: [[kline(bar15mOpen, bar15mClose)]], serverTimeMs: bar15mClose + 60000 });
    const result15m = await runBackfillForInterval({ pool: client, adapter: adapter15m, symbol: 'ETHUSDT', interval: '15m', startTime: bar15mOpen, endTime: bar15mOpen + 900000, fixedAsOf: bar15mClose, now: () => bar15mClose + 60000 });
    const adapter4h = makeMockAdapter({ pages: [[kline(bar4hOpen, bar4hClose)]], serverTimeMs: bar4hClose + 60000 });
    const result4h = await runBackfillForInterval({ pool: client, adapter: adapter4h, symbol: 'ETHUSDT', interval: '4h', startTime: bar4hOpen, endTime: bar4hOpen + 14400000, fixedAsOf: bar4hClose, now: () => bar4hClose + 60000 });

    assert.equal(result15m.status, 'SUCCEEDED');
    assert.equal(result4h.status, 'SUCCEEDED');
    assert.notEqual(result15m.backfillBatchId, result4h.backfillBatchId, '不同interval必须产生各自独立的backfill_batch_id');

    const batches = (await client.query(
      'SELECT interval_name, status FROM historical_validation.backfill_batches WHERE backfill_batch_id=ANY($1::uuid[])',
      [[result15m.backfillBatchId, result4h.backfillBatchId]]
    )).rows;
    assert.equal(batches.length, 2);
    assert.ok(batches.every(b => b.status === 'SUCCEEDED'));
  });
});
