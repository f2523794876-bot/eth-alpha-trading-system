// P0-4（独立复审）：integrity-check.js 边界感知完整性检测——真实PostgreSQL验证。
// 此前的问题：checkIntegrity()只比较数据库中"已返回行"彼此之间的相邻open_time间隔，完全无法发现
// 请求区间[from,to)首尾覆盖不完整（空结果/第一根缺失/最后一根或最后一页缺失/只返回中间某一段连续子区间）
// 这几类情形——本文件逐场景验证修复后的行为：把[from,to)按stepMs展开的完整期望位置序列与实际存在的行
// 逐位比对，任何缺失（含首尾）都计入gapCount，从而fail closed（配合dataset-manifest-builder.js既有的
// "gapCount>0则REJECTED"判定，不需要额外修改调用方）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { checkIntegrity } from '../../src/backfill/integrity-check.js';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(TEST_DATABASE_URL);
const FIFTEEN_MIN_MS = 900000;

function kline(openTime, closeTime, closeStr = '1000.00') {
  return [openTime, '999.00', '2000.00', '500.00', closeStr, '10.5', closeTime, '10500.00', 5, '5.0', '5000.00'];
}
function makeMockAdapter({ pages, serverTimeMs }) {
  let call = 0;
  return {
    serverTime: async () => ({ body: { serverTime: serverTimeMs }, requestId: randomUUID() }),
    spotKlines: async () => { const page = pages[call] || []; call += 1; return { body: page, requestId: randomUUID(), status: 200, headers: {} }; }
  };
}
async function withTxClient(fn) {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const client = await pool.connect();
  try { await client.query('BEGIN'); await fn(client); }
  finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
}
// 直接按给定open_time集合插入bar（跳过集合外的位置，制造精确的缺口）。
async function seedExactBars(client, { openTimes, replayNowMs }) {
  if (!openTimes.length) return;
  const bars = openTimes.map(openTime => kline(openTime, openTime + FIFTEEN_MIN_MS - 1, '1000.00'));
  // 用单页、按open_time排序传入即可——backfillInterval按cursor推进分页拉取，这里用一次性page覆盖不连续的
  // openTimes会被其内部startTime/endTime窗口误判；改为逐个bar单独调用一次backfillInterval，
  // 每次startTime=endTime=该bar的openTime，精确控制只写入这些位置，不产生相邻位置的行。
  for (const openTime of openTimes) {
    const adapter = makeMockAdapter({ pages: [[kline(openTime, openTime + FIFTEEN_MIN_MS - 1, '1000.00')]], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime, now: () => replayNowMs });
  }
}

test('P0-4：完全空结果——请求区间内market_bars一行都没有，必须fail closed(gapCount>0, emptyResult=true)', { skip }, async () => {
  await withTxClient(async (client) => {
    const from = Date.UTC(2025, 7, 1, 0, 0, 0);
    const to = from + 10 * FIFTEEN_MIN_MS;
    const result = await checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from, to });
    assert.equal(result.emptyResult, true);
    assert.equal(result.distinctRowCount, 0);
    assert.equal(result.expectedBarCount, 10);
    assert.equal(result.firstBarMissing, true);
    assert.equal(result.lastBarMissing, true);
    assert.ok(result.gapCount > 0, '空结果必须被计为gap，不得因为"没有相邻行可比较"而被判定为gapCount=0');
    assert.equal(result.gapDetails[0].reason, 'EMPTY_RESULT');
    assert.equal(result.gapDetails[0].missingCount, 10);
  });
});

test('P0-4：第一根K线缺失（leading gap）——实际数据从requested from之后才开始，必须fail closed', { skip }, async () => {
  await withTxClient(async (client) => {
    const from = Date.UTC(2025, 7, 2, 0, 0, 0);
    const to = from + 10 * FIFTEEN_MIN_MS;
    const replayNowMs = Date.now();
    // 只填充索引2..9（跳过0,1），第一根(from本身)与第二根均缺失。
    await seedExactBars(client, { openTimes: [from + 2 * FIFTEEN_MIN_MS, from + 3 * FIFTEEN_MIN_MS, from + 4 * FIFTEEN_MIN_MS, from + 5 * FIFTEEN_MIN_MS, from + 6 * FIFTEEN_MIN_MS, from + 7 * FIFTEEN_MIN_MS, from + 8 * FIFTEEN_MIN_MS, from + 9 * FIFTEEN_MIN_MS], replayNowMs });

    const result = await checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from, to });
    assert.equal(result.emptyResult, false);
    assert.equal(result.firstBarMissing, true, '实际第一根K线晚于requested from，必须被判定为first bar missing');
    assert.equal(result.lastBarMissing, false, '最后一根(索引9)本身是存在的');
    assert.ok(result.gapCount >= 1);
    const leadingGap = result.gapDetails.find(g => g.reason === 'LEADING_GAP_FIRST_BAR_MISSING');
    assert.ok(leadingGap, '必须存在一条leading gap记录');
    assert.equal(leadingGap.missingCount, 2);
  });
});

test('P0-4：最后一根/最后一页缺失（trailing gap）——实际数据在requested to之前就停止了，必须fail closed', { skip }, async () => {
  await withTxClient(async (client) => {
    const from = Date.UTC(2025, 7, 3, 0, 0, 0);
    const to = from + 10 * FIFTEEN_MIN_MS;
    const replayNowMs = Date.now();
    // 只填充索引0..6（跳过7,8,9），最后三根缺失——模拟"最后一页没拉到"。
    await seedExactBars(client, { openTimes: [0, 1, 2, 3, 4, 5, 6].map(i => from + i * FIFTEEN_MIN_MS), replayNowMs });

    const result = await checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from, to });
    assert.equal(result.firstBarMissing, false);
    assert.equal(result.lastBarMissing, true, '实际最后覆盖早于requested to，必须被判定为last bar missing');
    const trailingGap = result.gapDetails.find(g => g.reason === 'TRAILING_GAP_LAST_BAR_MISSING');
    assert.ok(trailingGap, '必须存在一条trailing gap记录');
    assert.equal(trailingGap.missingCount, 3);
  });
});

test('P0-4：只返回中间一段连续子区间——首尾同时缺失，必须fail closed（两条gap记录：leading+trailing）', { skip }, async () => {
  await withTxClient(async (client) => {
    const from = Date.UTC(2025, 7, 4, 0, 0, 0);
    const to = from + 10 * FIFTEEN_MIN_MS;
    const replayNowMs = Date.now();
    // 只填充索引3..6，首（0-2）尾（7-9）均缺失。
    await seedExactBars(client, { openTimes: [3, 4, 5, 6].map(i => from + i * FIFTEEN_MIN_MS), replayNowMs });

    const result = await checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from, to });
    assert.equal(result.firstBarMissing, true);
    assert.equal(result.lastBarMissing, true);
    assert.equal(result.gapCount, 2, '首尾各一段缺口，必须记为两条独立的gap记录，不得合并或漏记其一');
    const reasons = result.gapDetails.map(g => g.reason).sort();
    assert.deepEqual(reasons, ['LEADING_GAP_FIRST_BAR_MISSING', 'TRAILING_GAP_LAST_BAR_MISSING']);
  });
});

test('P0-4：中间缺口——首尾均存在，仅中段缺失，必须fail closed', { skip }, async () => {
  await withTxClient(async (client) => {
    const from = Date.UTC(2025, 7, 5, 0, 0, 0);
    const to = from + 10 * FIFTEEN_MIN_MS;
    const replayNowMs = Date.now();
    // 跳过索引4,5（中段），其余全部存在。
    await seedExactBars(client, { openTimes: [0, 1, 2, 3, 6, 7, 8, 9].map(i => from + i * FIFTEEN_MIN_MS), replayNowMs });

    const result = await checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from, to });
    assert.equal(result.firstBarMissing, false);
    assert.equal(result.lastBarMissing, false);
    assert.equal(result.gapCount, 1);
    assert.equal(result.gapDetails[0].reason, 'MID_RANGE_GAP');
    assert.equal(result.gapDetails[0].missingCount, 2);
  });
});

test('P0-4：完整无缺口覆盖——gapCount/duplicateCount/outOfOrderCount全部为0', { skip }, async () => {
  await withTxClient(async (client) => {
    const from = Date.UTC(2025, 7, 6, 0, 0, 0);
    const to = from + 10 * FIFTEEN_MIN_MS;
    const replayNowMs = Date.now();
    await seedExactBars(client, { openTimes: Array.from({ length: 10 }, (_, i) => from + i * FIFTEEN_MIN_MS), replayNowMs });

    const result = await checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from, to });
    assert.equal(result.emptyResult, false);
    assert.equal(result.firstBarMissing, false);
    assert.equal(result.lastBarMissing, false);
    assert.equal(result.gapCount, 0);
    assert.equal(result.duplicateCount, 0);
    assert.equal(result.outOfOrderCount, 0);
    assert.equal(result.distinctRowCount, 10);
    assert.equal(result.expectedBarCount, 10);
  });
});

test('P0-4：重复记录（同一open_time多个revision）——duplicateCount>0，不误算为gap', { skip }, async () => {
  await withTxClient(async (client) => {
    const from = Date.UTC(2025, 7, 7, 0, 0, 0);
    const to = from + 3 * FIFTEEN_MIN_MS;
    const replayNowMs = Date.now();
    await seedExactBars(client, { openTimes: [0, 1, 2].map(i => from + i * FIFTEEN_MIN_MS), replayNowMs });

    // 人为为索引1插入一条revision_number=1的新版本行（同open_time），模拟revision修订场景。
    const targetOpenTime = from + FIFTEEN_MIN_MS;
    const original = (await client.query(
      `SELECT * FROM market_bars WHERE instrument='ETHUSDT' AND interval_name='15m' AND open_time=to_timestamp($1/1000.0)`,
      [targetOpenTime]
    )).rows[0];
    await client.query(
      `INSERT INTO market_bars(
         source_id, endpoint_id, instrument, market_type, interval_name, open_time, close_time,
         open, high, low, close, volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume,
         observation_start, observation_end, published_at, available_at, first_available_at, fetched_at,
         revision_number, vintage_id, raw_payload_id, request_id, schema_version, normalizer_version, quality_state, content_hash
       )
       SELECT source_id, endpoint_id, instrument, market_type, interval_name, open_time, close_time,
              open, high, low, close, volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume,
              observation_start, observation_end, published_at, available_at, first_available_at, fetched_at,
              1, vintage_id || '-rev1', raw_payload_id, request_id, schema_version, normalizer_version, quality_state, content_hash
       FROM market_bars WHERE market_bar_id=$1`,
      [original.market_bar_id]
    );

    const result = await checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from, to });
    assert.equal(result.duplicateCount, 1, '同一open_time的第二个revision必须计为1次duplicate');
    assert.equal(result.gapCount, 0, '重复记录去重后仍然覆盖全部3个位置，不应产生gap');
    assert.equal(result.distinctRowCount, 3);
  });
});

test('P0-4：非法OHLC时间关系（close_time<=open_time 或 步长错位）——outOfOrderCount>0', { skip }, async () => {
  await withTxClient(async (client) => {
    const from = Date.UTC(2025, 7, 8, 0, 0, 0);
    const to = from + 2 * FIFTEEN_MIN_MS;
    const replayNowMs = Date.now();
    await seedExactBars(client, { openTimes: [from], replayNowMs });

    // 直接构造一条close_time与open_time步长不匹配的行（模拟数据损坏/错位）。
    const source = (await client.query(`SELECT * FROM market_bars WHERE instrument='ETHUSDT' AND interval_name='15m' LIMIT 1`)).rows[0];
    const misalignedOpenTime = from + FIFTEEN_MIN_MS;
    const misalignedCloseTime = misalignedOpenTime + FIFTEEN_MIN_MS + 500; // 步长多了500ms，故意错位
    await client.query(
      `INSERT INTO market_bars(
         source_id, endpoint_id, instrument, market_type, interval_name, open_time, close_time,
         open, high, low, close, volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume,
         observation_start, observation_end, published_at, available_at, first_available_at, fetched_at,
         revision_number, vintage_id, raw_payload_id, request_id, schema_version, normalizer_version, quality_state, content_hash
       )
       SELECT source_id, endpoint_id, instrument, market_type, interval_name,
              to_timestamp($2/1000.0), to_timestamp($3/1000.0),
              open, high, low, close, volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume,
              to_timestamp($2/1000.0), to_timestamp($3/1000.0), published_at, available_at, first_available_at, fetched_at,
              0, $4, raw_payload_id, request_id, schema_version, normalizer_version, quality_state, content_hash
       FROM market_bars WHERE market_bar_id=$1`,
      [source.market_bar_id, misalignedOpenTime, misalignedCloseTime, `ETHUSDT-spot-15m-${misalignedCloseTime}-rev0`]
    );

    const result = await checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from, to: to + FIFTEEN_MIN_MS });
    assert.ok(result.outOfOrderCount >= 1, '步长错位的bar必须被检出为outOfOrder');
    assert.equal(result.outOfOrderDetails[0].reason, 'INTERVAL_MISALIGNED');
  });
});

test('P0-4：不确定输入（from>=to 或 无效interval）必须fail closed（抛出异常，不返回貌似正常的结果）', { skip }, async () => {
  await withTxClient(async (client) => {
    await assert.rejects(
      checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from: 2000, to: 1000 }),
      (err) => err.code === 'INVALID_INTEGRITY_RANGE'
    );
    await assert.rejects(
      checkIntegrity(client, { instrument: 'ETHUSDT', interval: '3m', from: 1000, to: 2000 }),
      (err) => err.code === 'INVALID_INTERVAL'
    );
  });
});

test('P0-4：请求边界之外的行不得被计入（open_time<from 或 open_time>=to 的行必须被SQL天然排除，不影响本区间判定）', { skip }, async () => {
  await withTxClient(async (client) => {
    const from = Date.UTC(2025, 7, 9, 0, 0, 0);
    const to = from + 3 * FIFTEEN_MIN_MS;
    const replayNowMs = Date.now();
    // 完整填充请求区间[from,to)本身。
    await seedExactBars(client, { openTimes: [0, 1, 2].map(i => from + i * FIFTEEN_MIN_MS), replayNowMs });
    // 额外seed请求区间之外的bar（一根在from之前，一根在to之后）。
    await seedExactBars(client, { openTimes: [from - FIFTEEN_MIN_MS, to + FIFTEEN_MIN_MS], replayNowMs });

    const result = await checkIntegrity(client, { instrument: 'ETHUSDT', interval: '15m', from, to });
    assert.equal(result.distinctRowCount, 3, '边界之外的bar不得被计入本次区间的distinctRowCount');
    assert.equal(result.gapCount, 0);
    assert.equal(result.firstBarMissing, false);
    assert.equal(result.lastBarMissing, false);
  });
});
