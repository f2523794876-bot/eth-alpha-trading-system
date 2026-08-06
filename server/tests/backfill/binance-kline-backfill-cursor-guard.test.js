// P2-3：分页游标不前进保护——纯单元测试，不需要数据库。
//
// 使用 dryRun:true 驱动 backfillInterval() 的真实分页循环：dryRun 分支跳过
// insertRawPayload()/market_bars INSERT/backfill_batches UPDATE 全部pool调用
// （见 binance-kline-backfill.js 对应分支），因此这里可以在不连接Postgres的前提下
// 直接对生产分页循环本身做断言，而不是绕开循环单测某个辅助函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { INTERVAL_MS } from '../../src/domain/constants.js';

const INTERVAL = '15m';
const STEP_MS = INTERVAL_MS[INTERVAL];
const SYMBOL = 'ETHUSDT';
const PAGE_LIMIT = 1000;

// formal kline tuple: [openTime, open, high, low, close, volume, closeTime, quoteVolume, tradeCount, takerBuyBase, takerBuyQuote]
function kline(openTime) {
  const closeTime = openTime + STEP_MS - 1;
  return [openTime, '999.00', '1001.00', '998.00', '1000.00', '10.5', closeTime, '10500.00', 5, '5.0', '5000.00'];
}

// 一整页 count 根按 STEP_MS 严格间隔排列的合法收盘K线，从 startOpenTime 开始。
function fullPage(startOpenTime, count = PAGE_LIMIT) {
  const rows = [];
  for (let i = 0; i < count; i += 1) rows.push(kline(startOpenTime + i * STEP_MS));
  return rows;
}

// 模拟"adapter返回了陈旧/损坏页"：count 根K线全部挤在 startOpenTime 附近（每根只间隔1ms，
// 而不是标准STEP_MS），因此即使凑满 PAGE_LIMIT 根，最后一根的 openTime 仍远小于按STEP_MS
// 正常推进本应到达的位置——用于构造 nextCursor 严格小于 cursor（游标倒退）的场景。
// 每一行自身的 open/close 间距仍然是合法的STEP_MS（不触发TIME_MISALIGNED），只是相邻行之间
// 的open_time步进被压缩到1ms（只需严格递增，validateKlineRow/主循环均不要求逐行间隔=STEP_MS）。
function packedPage(startOpenTime, count = PAGE_LIMIT) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const openTime = startOpenTime + i;
    const closeTime = openTime + STEP_MS - 1;
    rows.push([openTime, '999.00', '1001.00', '998.00', '1000.00', '10.5', closeTime, '10500.00', 5, '5.0', '5000.00']);
  }
  return rows;
}

function makeAdapter(pages, { serverTimeMs, maxCalls }) {
  const calls = [];
  return {
    calls,
    serverTime: async () => ({ body: { serverTime: serverTimeMs }, requestId: randomUUID() }),
    spotKlines: async (symbol, interval, options) => {
      calls.push({ symbol, interval, ...options });
      if (maxCalls != null && calls.length > maxCalls) {
        throw new Error(`spotKlines must not be called more than ${maxCalls} times — cursor guard must fail closed instead of looping`);
      }
      const body = pages[calls.length - 1] || [];
      return { body, requestId: randomUUID(), status: 200, headers: {} };
    }
  };
}

test('P2-3正常分页：满页且下一游标严格前进时继续请求下一页，请求游标按预期递增，不误报游标停滞', async () => {
  const requestedStart = Date.UTC(2026, 0, 10, 0, 0, 0);
  const cursorAfterPage1 = requestedStart + PAGE_LIMIT * STEP_MS; // 满页后理论上的next cursor
  const page1 = fullPage(requestedStart, PAGE_LIMIT);
  const page2 = fullPage(cursorAfterPage1, 50); // 未满页，正常结束
  const endTime = cursorAfterPage1 + 60 * STEP_MS;
  const fixedAsOf = endTime + STEP_MS;
  const nowMs = fixedAsOf + STEP_MS;

  const adapter = makeAdapter([page1, page2], { serverTimeMs: nowMs, maxCalls: 2 });

  const result = await backfillInterval({
    pool: null, adapter, symbol: SYMBOL, interval: INTERVAL,
    startTime: requestedStart, endTime, fixedAsOf, dryRun: true, now: () => nowMs
  });

  assert.equal(result.status, 'DRY_RUN');
  assert.equal(result.rowsRejected, 0, '不应产生任何被拒绝行');
  assert.equal(result.rowsInserted, PAGE_LIMIT + 50, '两页的合法行都必须被计入');
  assert.equal(adapter.calls.length, 2, '满页后必须恰好再请求一次下一页，不多不少');
  assert.equal(adapter.calls[0].startTime, requestedStart, '第一次请求必须使用起始游标');
  assert.equal(adapter.calls[1].startTime, cursorAfterPage1, '第二次请求必须使用严格前进后的游标，而不是重复第一次的游标');
});

test('P2-3游标相等：满页但计算得到的nextCursor===cursor时立即fail closed，不发起重复请求，不记为成功', async () => {
  const requestedStart = Date.UTC(2026, 0, 20, 0, 0, 0);
  const cursorAfterPage1 = requestedStart + PAGE_LIMIT * STEP_MS;
  const page1 = fullPage(requestedStart, PAGE_LIMIT);
  // 损坏的adapter：无视新的startTime，原样重复返回第一页——lastCompletedOpenTime与
  // 第一次完全相同，故本次算出的nextCursor恰好等于本次请求所用的cursor（cursorAfterPage1）。
  const page2Duplicate = fullPage(requestedStart, PAGE_LIMIT);
  const endTime = cursorAfterPage1 + 10 * STEP_MS;
  const fixedAsOf = endTime + STEP_MS;
  const nowMs = fixedAsOf + STEP_MS;

  const adapter = makeAdapter([page1, page2Duplicate], { serverTimeMs: nowMs, maxCalls: 2 });

  await assert.rejects(
    backfillInterval({
      pool: null, adapter, symbol: SYMBOL, interval: INTERVAL,
      startTime: requestedStart, endTime, fixedAsOf, dryRun: true, now: () => nowMs
    }),
    (err) => {
      assert.equal(err.code, 'BACKFILL_CURSOR_NOT_ADVANCING');
      assert.equal(err.cursor, cursorAfterPage1, '错误必须携带发起本次请求所用的当前游标');
      assert.equal(err.nextCursor, cursorAfterPage1, '错误必须携带计算得到的下一游标');
      assert.equal(err.nextCursor, err.cursor, '本场景nextCursor必须与cursor相等');
      assert.equal(err.lastCompletedOpenTime, requestedStart + (PAGE_LIMIT - 1) * STEP_MS, '错误必须携带最后一根K线的open_time');
      assert.equal(err.symbol, SYMBOL, '错误必须携带symbol，便于定位是哪个标的的回填任务');
      assert.equal(err.interval, INTERVAL, '错误必须携带interval，便于定位是哪个周期的回填任务');
      return true;
    }
  );
  assert.equal(adapter.calls.length, 2, '必须先处理合法第一页，再在游标停滞的第二页上立即fail closed，绝不能发起第三次重复请求');
});

test('P2-3游标倒退：满页但计算得到的nextCursor<cursor时立即fail closed，不发起重复请求', async () => {
  const requestedStart = Date.UTC(2026, 0, 30, 0, 0, 0);
  const cursorAfterPage1 = requestedStart + PAGE_LIMIT * STEP_MS;
  const page1 = fullPage(requestedStart, PAGE_LIMIT);
  // 损坏的adapter：第二页返回的仍是满页(PAGE_LIMIT条)，但全部挤在[requestedStart, requestedStart+PAGE_LIMIT)
  // 这一极窄区间内（每行只间隔1ms）——该页最后一根的open_time远小于cursorAfterPage1-STEP_MS，
  // 使nextCursor严格小于本次请求所用的cursor（cursorAfterPage1），复现"游标倒退"。
  const page2Regressed = packedPage(requestedStart, PAGE_LIMIT);
  const endTime = cursorAfterPage1 + 10 * STEP_MS;
  const fixedAsOf = endTime + STEP_MS;
  const nowMs = fixedAsOf + STEP_MS;

  const adapter = makeAdapter([page1, page2Regressed], { serverTimeMs: nowMs, maxCalls: 2 });

  await assert.rejects(
    backfillInterval({
      pool: null, adapter, symbol: SYMBOL, interval: INTERVAL,
      startTime: requestedStart, endTime, fixedAsOf, dryRun: true, now: () => nowMs
    }),
    (err) => {
      assert.equal(err.code, 'BACKFILL_CURSOR_NOT_ADVANCING');
      assert.equal(err.cursor, cursorAfterPage1);
      const expectedNextCursor = (requestedStart + (PAGE_LIMIT - 1)) + STEP_MS;
      assert.equal(err.nextCursor, expectedNextCursor);
      assert.ok(err.nextCursor < err.cursor, '本场景nextCursor必须严格小于cursor（真正的游标倒退，而不仅仅是停滞）');
      assert.equal(err.symbol, SYMBOL);
      assert.equal(err.interval, INTERVAL);
      return true;
    }
  );
  assert.equal(adapter.calls.length, 2, '游标倒退必须立即fail closed，不得对更早/重叠区间发起下一次请求');
});
