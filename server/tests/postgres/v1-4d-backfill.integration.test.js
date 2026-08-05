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

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(TEST_DATABASE_URL);

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
    const closedOpenTime = Date.UTC(2026, 0, 3, 0, 0, 0);
    const closedCloseTime = closedOpenTime + 900000 - 1;
    const futureOpenTime = closedOpenTime + 900000;
    const futureCloseTime = futureOpenTime + 900000 - 1;
    const fixedAsOf = closedCloseTime;
    const adapter = makeMockAdapter({
      pages: [[kline(closedOpenTime, closedCloseTime), kline(futureOpenTime, futureCloseTime)]],
      serverTimeMs: fixedAsOf
    });

    const result = await backfillInterval({
      pool: client, adapter, symbol: 'ETHUSDT', interval: '15m',
      startTime: closedOpenTime, endTime: closedOpenTime, requestedTo: futureOpenTime + 900000,
      fixedAsOf, now: () => fixedAsOf
    });
    assert.equal(result.rowsInserted, 1, 'fixedAsOf前已收盘K线必须正常写入');
    const closedCount = (await client.query(`SELECT count(*)::int AS n FROM market_bars WHERE instrument='ETHUSDT' AND close_time=to_timestamp($1/1000.0)`, [closedCloseTime])).rows[0].n;
    const futureCount = (await client.query(`SELECT count(*)::int AS n FROM market_bars WHERE instrument='ETHUSDT' AND close_time=to_timestamp($1/1000.0)`, [futureCloseTime])).rows[0].n;
    assert.equal(closedCount, 1);
    assert.equal(futureCount, 0, 'fixedAsOf后未收盘K线不得写入market_bars');
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

// R1.2：跨越PAGE_LIMIT(1000)分页边界的连续区间——构造1005根15m bar，第一页返回前1000根（触发继续分页），
// 第二页返回剩余5根（触发`rows.length < PAGE_LIMIT`自然结束）。验证页与页之间open_time序列无缺口无重复，
// 严格按intervalMs递增，且分页游标本身（第二次adapter.spotKlines调用的startTime参数）正确对齐到
// 第一页最后一根bar之后一个interval，不从头重新请求。
test('R1.2：跨越PAGE_LIMIT分页边界的连续区间，页与页之间open_time序列无缺口无重复', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 0, 20, 0, 0, 0);
    const totalBars = 1005;
    const allBars = [];
    for (let i = 0; i < totalBars; i += 1) {
      const openTime = base + i * 900000;
      allBars.push(kline(openTime, openTime + 900000 - 1, '1000.00'));
    }
    const page1 = allBars.slice(0, 1000);
    const page2 = allBars.slice(1000);
    const startTimes = [];
    const nowMs = allBars[allBars.length - 1][6] + 60000;
    const adapter = {
      serverTime: async () => ({ body: { serverTime: nowMs }, requestId: randomUUID() }),
      spotKlines: async (symbol, interval, opts) => {
        startTimes.push(opts.startTime);
        const page = startTimes.length === 1 ? page1 : page2;
        return { body: page, requestId: randomUUID(), status: 200, headers: {} };
      }
    };
    const endTime = base + totalBars * 900000;
    const result = await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: base, endTime, now: () => nowMs });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.rowsInserted, totalBars);
    assert.equal(startTimes.length, 2, '必须恰好发起两次分页请求（1000+5）');
    assert.equal(startTimes[0], base);
    assert.equal(startTimes[1], page1[page1.length - 1][0] + 900000, '第二页请求的startTime必须紧接第一页最后一根bar之后一个interval，不得从头重新请求');

    const rows = (await client.query(
      `SELECT open_time FROM market_bars WHERE instrument='ETHUSDT' AND interval_name='15m' AND open_time>=to_timestamp($1/1000.0) AND open_time<to_timestamp($2/1000.0) ORDER BY open_time ASC`,
      [base, endTime]
    )).rows;
    assert.equal(rows.length, totalBars);
    for (let i = 1; i < rows.length; i += 1) {
      const diff = rows[i].open_time.getTime() - rows[i - 1].open_time.getTime();
      assert.equal(diff, 900000, `第${i}根bar与前一根之间必须恰好间隔一个interval，不得有缺口或重复`);
    }

    const integrity = await checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from: base, to: endTime });
    assert.equal(integrity.gapCount, 0);
    assert.equal(integrity.duplicateCount, 0);
    assert.equal(integrity.outOfOrderCount, 0);
  });
});

// 999/1000 是单页终止边界，1001 与下面 R1.3 是首次跨页边界，R1.2 的 1005
// 进一步覆盖多页后的短尾页。这里使用互不重叠的 2027 fixture，避免与其他集成测试
// 的时间范围发生 vintage_id 冲突。
for (const totalBars of [999, 1000]) {
  test(`R1.2边界：${totalBars}根连续K线不重复、不遗漏且不发起多余分页`, { skip }, async () => {
    await withTxClient(async (client) => {
      const base = Date.UTC(2027, totalBars === 999 ? 0 : 1, 1, 0, 0, 0);
      const allBars = Array.from({ length: totalBars }, (_, i) => {
        const openTime = base + i * 900000;
        return kline(openTime, openTime + 900000 - 1, '1000.00');
      });
      const startTimes = [];
      const endTime = allBars.at(-1)[0];
      const nowMs = allBars.at(-1)[6] + 60000;
      const adapter = {
        serverTime: async () => ({ body: { serverTime: nowMs }, requestId: randomUUID() }),
        spotKlines: async (symbol, interval, opts) => {
          startTimes.push(opts.startTime);
          const page = allBars
            .filter(row => row[0] >= opts.startTime && row[0] <= opts.endTime)
            .slice(0, 1000);
          return { body: page, requestId: randomUUID(), status: 200, headers: {} };
        }
      };

      const result = await backfillInterval({
        pool: client, adapter, symbol: 'ETHUSDT', interval: '15m',
        startTime: base, endTime, now: () => nowMs
      });

      assert.equal(result.status, 'SUCCEEDED');
      assert.equal(result.rowsInserted, totalBars);
      assert.equal(result.rowsDeduped, 0);
      assert.deepEqual(startTimes, [base], `${totalBars}根以内必须由单页完整覆盖`);

      const rows = (await client.query(
        `SELECT open_time FROM market_bars
         WHERE instrument='ETHUSDT' AND interval_name='15m'
           AND open_time>=to_timestamp($1/1000.0) AND open_time<=to_timestamp($2/1000.0)
         ORDER BY open_time ASC`,
        [base, endTime]
      )).rows;
      assert.equal(rows.length, totalBars);
      for (let i = 0; i < rows.length; i += 1) {
        assert.equal(rows[i].open_time.getTime(), base + i * 900000);
      }
    });
  });
}

// R1.3：请求区间恰好落在两页边界中间（不是PAGE_LIMIT的整数倍）——验证分页游标正确对齐，不产生半页重复请求。
// 用与R1.2相同的思路，但把总量设为1000+1（恰好跨过边界1根），第二页只有1根bar，用来确认边界对齐精确到
// "恰好1根"这个最紧的情形，而不仅是R1.2里较宽松的5根。
test('R1.3：请求区间恰好落在两页边界中间（第1000/1001根）——分页游标精确对齐，不产生半页重复请求', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 0, 22, 0, 0, 0);
    const totalBars = 1001;
    const allBars = [];
    for (let i = 0; i < totalBars; i += 1) {
      const openTime = base + i * 900000;
      allBars.push(kline(openTime, openTime + 900000 - 1, '1000.00'));
    }
    const page1 = allBars.slice(0, 1000);
    const page2 = allBars.slice(1000); // 恰好1根
    const startTimes = [];
    const nowMs = allBars[allBars.length - 1][6] + 60000;
    const adapter = {
      serverTime: async () => ({ body: { serverTime: nowMs }, requestId: randomUUID() }),
      spotKlines: async (symbol, interval, opts) => {
        startTimes.push(opts.startTime);
        const page = startTimes.length === 1 ? page1 : page2;
        return { body: page, requestId: randomUUID(), status: 200, headers: {} };
      }
    };
    const endTime = base + totalBars * 900000;
    const result = await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: base, endTime, now: () => nowMs });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.rowsInserted, totalBars);
    assert.equal(startTimes.length, 2);
    assert.equal(startTimes[1], page1[999][0] + 900000, '第1001根bar所在的第二页请求必须恰好从第1000根之后一个interval开始，不得重复请求第1000根');

    const dupCheck = (await client.query(
      `SELECT open_time, count(*)::int AS n FROM market_bars WHERE instrument='ETHUSDT' AND interval_name='15m' AND open_time>=to_timestamp($1/1000.0) AND open_time<to_timestamp($2/1000.0) GROUP BY open_time HAVING count(*)>1`,
      [base, endTime]
    )).rows;
    assert.equal(dupCheck.length, 0, '不得因半页边界对齐错误产生任何重复open_time的market_bars行');
  });
});

// R3.3：目标区间与现有实时采集覆盖区间部分重叠——重叠部分因vintage_id冲突被ON CONFLICT DO NOTHING跳过，
// 不产生重复行，完整性校验仍通过。vintageIdFor()是纯函数`${instrument}-${marketType}-${interval}-${closeTime}-rev0`，
// 不区分调用方是回填还是实时采集器，故"预先存在一条实时采集写入的formal bar"可以直接用backfillInterval
// 自身模拟一次前置写入（生成的vintage_id与后续真正回填对同一close_time尝试写入时完全相同，机制等价）。
test('R3.3：目标区间与现有(模拟实时采集的)覆盖区间部分重叠——重叠部分因vintage_id冲突被跳过，不产生重复行，完整性校验仍通过', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 0, 24, 0, 0, 0);
    const bar0Open = base, bar0Close = base + 900000 - 1;
    const bar1Open = base + 900000, bar1Close = bar1Open + 900000 - 1;
    const bar2Open = base + 1800000, bar2Close = bar2Open + 900000 - 1;
    const nowMs = bar2Close + 60000;

    // 模拟"实时采集器已写入bar0/bar1"（用与后续回填尝试不同、但仍在kline()固定high/low=1001.00/998.00
    // 合法范围内的close价格标记，便于验证未被覆盖——用超出OHLC合法范围的价格会被validateKlineRow直接判为
    // 无效行拒绝，根本走不到ON CONFLICT去重这一步，无法验证本测试真正要覆盖的vintage_id冲突场景）。
    const liveAdapter = makeMockAdapter({ pages: [[kline(bar0Open, bar0Close, '999.10'), kline(bar1Open, bar1Close, '999.10')]], serverTimeMs: nowMs });
    await backfillInterval({ pool: client, adapter: liveAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar1Open, now: () => nowMs });

    // 目标区间[bar0,bar2]与上面已存在的[bar0,bar1]部分重叠。
    const overlapAdapter = makeMockAdapter({ pages: [[kline(bar0Open, bar0Close, '1000.50'), kline(bar1Open, bar1Close, '1000.50'), kline(bar2Open, bar2Close, '1000.00')]], serverTimeMs: nowMs });
    const result = await backfillInterval({ pool: client, adapter: overlapAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar2Open, now: () => nowMs });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.rowsDeduped, 2, '重叠的bar0/bar1必须因vintage_id冲突被ON CONFLICT DO NOTHING跳过');
    assert.equal(result.rowsInserted, 1, '只有非重叠的bar2真正新插入');

    const closes = (await client.query(
      `SELECT close::text FROM market_bars WHERE instrument='ETHUSDT' AND close_time IN (to_timestamp($1/1000.0),to_timestamp($2/1000.0)) ORDER BY close_time`,
      [bar0Close, bar1Close]
    )).rows;
    assert.deepEqual(closes.map(r => r.close), ['999.10', '999.10'], '重叠部分必须保留原有(实时采集)行内容，不被回填覆盖');

    const dupCheck = (await client.query(
      `SELECT close_time, count(*)::int AS n FROM market_bars WHERE instrument='ETHUSDT' AND close_time IN (to_timestamp($1/1000.0),to_timestamp($2/1000.0),to_timestamp($3/1000.0)) GROUP BY close_time HAVING count(*)>1`,
      [bar0Close, bar1Close, bar2Close]
    )).rows;
    assert.equal(dupCheck.length, 0, '不产生重复行');

    const integrity = await checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from: bar0Open, to: bar2Close + 1 });
    assert.equal(integrity.gapCount, 0);
    assert.equal(integrity.duplicateCount, 0);
    assert.equal(integrity.outOfOrderCount, 0);
  });
});

// P2-3修复（独立复审）：分页游标必须真正前进，否则fail closed而不是无限循环。构造一个损坏的adapter——
// 第一页返回恰好PAGE_LIMIT(1000)条合法K线，第二页无视新startTime并重复旧页。若无本项守卫，主循环会
// 对同一区间无限重复请求；有守卫后，应在重复页上立即fail closed，不得发起第三次请求。
test('P2-3红线：分页游标未真正前进时fail closed（BACKFILL_CURSOR_NOT_ADVANCING），不无限循环', { skip }, async () => {
  await withTxClient(async (client) => {
    const requestedStart = Date.UTC(2026, 0, 10, 0, 0, 0);
    const requestedEnd = requestedStart + 2000 * 900000;
    // 第一页返回1000条合法且位于fixedAsOf范围内的K线，使游标真实推进；第二页错误地重复同一页，
    // 此时page末尾推导出的nextCursor等于当前cursor，必须触发游标不前进保护。
    const eligibleRows = [];
    for (let i = 0; i < 1000; i += 1) {
      const openTime = requestedStart + i * 900000;
      eligibleRows.push(kline(openTime, openTime + 900000 - 1, '1000.00'));
    }
    let callCount = 0;
    const adapter = {
      serverTime: async () => ({ body: { serverTime: requestedEnd + 60000 }, requestId: randomUUID() }),
      spotKlines: async () => {
        callCount += 1;
        if (callCount > 2) throw new Error('must not be called a third time — cursor guard must fail closed on the repeated page');
        return { body: eligibleRows, requestId: randomUUID(), status: 200, headers: {} };
      }
    };

    await assert.rejects(
      backfillInterval({
        pool: client, adapter, symbol: 'ETHUSDT', interval: '15m',
        startTime: requestedStart, endTime: requestedEnd, fixedAsOf: requestedEnd - 1,
        now: () => requestedEnd + 60000
      }),
      (e) => e.code === 'BACKFILL_CURSOR_NOT_ADVANCING'
    );
    assert.equal(callCount, 2, '必须先处理合法第一页，再在重复第二页上触发游标保护');
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
