// R1/R2/R3/R4/R6：回填幂等/UTC边界/未收盘隔离/缺口重复乱序检测/available_at诚实语义/revision处理。
// 使用隔离测试库（TEST_DATABASE_URL），绝不指向生产数据库。
//
// 每个用例通过 pool.connect() 取出单一专用连接并在其上 BEGIN/ROLLBACK，
// 确保 backfillInterval() 内部的多条 query 全部落在同一事务里、测试结束后可靠回滚，
// 不使用共享 Pool 直接跑 BEGIN/ROLLBACK（那样每次 pool.query() 可能取到池中不同连接，
// BEGIN 与实际写入不在同一会话，ROLLBACK 形同虚设，会向测试库残留脏数据）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { checkIntegrity } from '../../src/backfill/integrity-check.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;

function makeMockAdapter({ pages, serverTimeMs }) {
  let call = 0;
  return {
    serverTime: async () => ({ body: { serverTime: serverTimeMs }, requestId: randomUUID() }),
    spotKlines: async () => {
      const page = pages[call] || [];
      call += 1;
      return { body: page, requestId: randomUUID(), status: 200, headers: {} };
    }
  };
}

// formal kline tuple: [openTime, open, high, low, close, volume, closeTime, quoteVolume, tradeCount, takerBuyBase, takerBuyQuote]
function kline(openTime, closeTime, closeStr = '1000.00') {
  return [openTime, '999.00', '1001.00', '998.00', closeStr, '10.5', closeTime, '10500.00', 5, '5.0', '5000.00'];
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

test('R1/R4/R6：回填写入formal K线，available_at/fetched_at为回填执行时间而非close_time，revision恒0', { skip }, async () => {
  await withTxClient(async (client) => {
    const openTime = Date.UTC(2026, 0, 1, 0, 0, 0);
    const closeTime = openTime + 900000 - 1;
    const nowMs = closeTime + 60000;
    const adapter = makeMockAdapter({ pages: [[kline(openTime, closeTime)]], serverTimeMs: nowMs });

    const result = await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime, now: () => nowMs });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.rowsInserted, 1);

    const row = (await client.query(
      `SELECT extract(epoch from available_at)*1000 AS "availableAtMs", extract(epoch from fetched_at)*1000 AS "fetchedAtMs",
              revision_number AS "revisionNumber"
       FROM market_bars WHERE instrument='ETHUSDT' AND interval_name='15m' AND close_time=to_timestamp($1/1000.0)`,
      [closeTime]
    )).rows[0];
    assert.ok(row, 'row must exist');
    assert.equal(row.revisionNumber, 0);
    assert.equal(Number(row.availableAtMs), nowMs, 'available_at must equal backfill execution time');
    assert.notEqual(Number(row.availableAtMs), closeTime, 'available_at must NOT equal close_time (P0 leak-prevention red线)');
    assert.equal(Number(row.fetchedAtMs), nowMs);
  });
});

test('R1：重复执行同一批次幂等，第二次rowsDeduped等于全部行数', { skip }, async () => {
  await withTxClient(async (client) => {
    const openTime = Date.UTC(2026, 0, 2, 0, 0, 0);
    const closeTime = openTime + 900000 - 1;
    const nowMs = closeTime + 60000;
    const adapter1 = makeMockAdapter({ pages: [[kline(openTime, closeTime)]], serverTimeMs: nowMs });
    const adapter2 = makeMockAdapter({ pages: [[kline(openTime, closeTime)]], serverTimeMs: nowMs + 60000 });

    const first = await backfillInterval({ pool: client, adapter: adapter1, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime, now: () => nowMs });
    const second = await backfillInterval({ pool: client, adapter: adapter2, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime, now: () => nowMs + 60000 });
    assert.equal(first.rowsInserted, 1);
    assert.equal(second.rowsInserted, 0);
    assert.equal(second.rowsDeduped, 1);
  });
});

test('R2.2：未收盘K线（close_time>服务器时间）必须被过滤丢弃', { skip }, async () => {
  await withTxClient(async (client) => {
    const openTime = Date.UTC(2026, 0, 3, 0, 0, 0);
    const closeTime = openTime + 900000 - 1;
    const nowMs = openTime + 100; // 服务器时间远早于close_time，代表bar尚未收盘
    const adapter = makeMockAdapter({ pages: [[kline(openTime, closeTime)]], serverTimeMs: nowMs });

    const result = await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime, now: () => nowMs });
    assert.equal(result.rowsInserted, 0, '未收盘K线不得写入market_bars');
    const count = (await client.query(`SELECT count(*)::int AS n FROM market_bars WHERE instrument='ETHUSDT' AND close_time=to_timestamp($1/1000.0)`, [closeTime])).rows[0].n;
    assert.equal(count, 0);
  });
});

test('R2.3：校时失败时fail closed，不发起任何写入', { skip }, async () => {
  await withTxClient(async (client) => {
    const adapter = { serverTime: async () => { throw Object.assign(new Error('network down'), { code: 'NETWORK_ERROR' }); }, spotKlines: async () => { throw new Error('must not be called'); } };
    const result = await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: 0, endTime: 900000 });
    assert.equal(result.status, 'BLOCKED');
  });
});

test('R3：checkIntegrity 检测出人为构造的缺口', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 0, 4, 0, 0, 0);
    // bar0: [base, base+900000-1]; bar1 故意跳过; bar2: [base+1800000, base+2700000-1]
    const bar0Open = base, bar0Close = base + 900000 - 1;
    const bar2Open = base + 1800000, bar2Close = bar2Open + 900000 - 1;
    const nowMs = bar2Close + 60000;
    const adapter = makeMockAdapter({ pages: [[kline(bar0Open, bar0Close), kline(bar2Open, bar2Close)]], serverTimeMs: nowMs });

    const result = await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar2Open, now: () => nowMs });
    assert.equal(result.rowsInserted, 2);
    const integrity = await checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from: bar0Open, to: bar2Close + 1 });
    assert.equal(integrity.gapCount, 1, '应检测到1个缺口（跳过了bar1）');
    assert.equal(integrity.duplicateCount, 0);
    assert.equal(integrity.outOfOrderCount, 0);
  });
});

test('R6：不修改现有revision=0记录——回填目标区间与已有行重叠时该行内容逐字节不变', { skip }, async () => {
  await withTxClient(async (client) => {
    const openTime = Date.UTC(2026, 0, 5, 0, 0, 0);
    const closeTime = openTime + 900000 - 1;
    const nowMs = closeTime + 60000;
    const adapter1 = makeMockAdapter({ pages: [[kline(openTime, closeTime, '1000.00')]], serverTimeMs: nowMs });
    // 第二次回填对同一时间点、不同close价格（模拟"上游数据看起来变了"），验证不会覆盖
    const adapter2 = makeMockAdapter({ pages: [[kline(openTime, closeTime, '9999.99')]], serverTimeMs: nowMs + 60000 });

    await backfillInterval({ pool: client, adapter: adapter1, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime, now: () => nowMs });
    const before = (await client.query(`SELECT close::text FROM market_bars WHERE instrument='ETHUSDT' AND close_time=to_timestamp($1/1000.0)`, [closeTime])).rows[0].close;
    await backfillInterval({ pool: client, adapter: adapter2, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime, now: () => nowMs + 60000 });
    const after = (await client.query(`SELECT close::text FROM market_bars WHERE instrument='ETHUSDT' AND close_time=to_timestamp($1/1000.0)`, [closeTime])).rows[0].close;
    assert.equal(before, '1000.00');
    assert.equal(after, '1000.00', '已有revision=0行必须保持不变，不被第二次回填覆盖');
  });
});
