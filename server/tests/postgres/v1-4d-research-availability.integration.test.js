// research查询层端到端验证：证明 replay-bar-path-queries.js（P0-3修复：物理独立于生产SQL的研究查询层）
// 能够正确读取"available_at=回填执行真实墙钟时间(远晚于历史asOfTime)"的回填数据——若直接用生产
// bar-path-locator.js（未修改，同一份代码）跑同样的查询，会因available_at<=asOfTime恒假而查不到任何数据
// （悖论场景，见V1_4D_DATA_BACKFILL_SPEC.md §2.9），这正是research查询层物理独立存在的理由：两条路径用的是
// 完全不同的SQL语句（见replay-bar-path-queries.js），不是同一份SQL被参数/开关切换。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { computeFourHourAtr14ForReplay, locatePathForEvaluationForReplay } from '../../src/validation-replay/replay-bar-path-queries.js';
import { computeFourHourAtr14, locatePathForEvaluation } from '../../src/forecast/bar-path-locator.js';

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(TEST_DATABASE_URL);
const FOUR_HOUR_MS = 14400000;
const FIFTEEN_MIN_MS = 900000;

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

function kline(openTime, closeTime, closeStr) {
  return [openTime, closeStr, closeStr, closeStr, closeStr, '10.5', closeTime, '10500.00', 5, '5.0', '5000.00'];
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

test('computeFourHourAtr14ForReplay：能读到回填数据；生产bar-path-locator.js的computeFourHourAtr14对同一asOfTime读不到任何数据（悖论复现，证明二者是物理独立的两条查询路径）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    const bars = [];
    for (let i = 0; i < 15; i++) {
      const openTime = base + i * FOUR_HOUR_MS;
      const closeTime = openTime + FOUR_HOUR_MS - 1;
      bars.push(kline(openTime, closeTime, (1000 + i).toFixed(2)));
    }
    const historicalAsOfTime = base + 15 * FOUR_HOUR_MS - 1; // 恰好第15根收盘时刻
    const backfillWallClockMs = Date.now(); // 真实回填执行时间——远晚于historicalAsOfTime，制造悖论条件
    const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: backfillWallClockMs });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '4h', startTime: base, endTime: base + 15 * FOUR_HOUR_MS, now: () => backfillWallClockMs });

    // 生产查询（bar-path-locator.js，未修改的同一份代码，直接用真实pool）：available_at(=backfillWallClockMs，
    // 真实当下)<=historicalAsOfTime(2026年初)恒假，查不到任何数据。
    const rawResult = await computeFourHourAtr14(client, { instrument: 'ETHUSDT', asOfTime: historicalAsOfTime });
    assert.equal(rawResult.ok, false, '生产查询在历史asOfTime下应查询不到回填数据（悖论复现）');

    // research查询层（replay-bar-path-queries.js，独立SQL文本，只判close_time<=asOfTime AND fetched_at<=replayNowMs）：
    // 应能正确读到全部15根bar并计算出ATR14。
    const wrappedResult = await computeFourHourAtr14ForReplay(client, { instrument: 'ETHUSDT', asOfTime: historicalAsOfTime, replayNowMs: backfillWallClockMs });
    assert.equal(wrappedResult.ok, true, 'research查询层应能正确读到回填数据并计算出ATR14');
    assert.ok(Number.isFinite(wrappedResult.atr14FourHourAtGeneration));
    assert.equal(wrappedResult.auditRecords.length, 15, '必须为全部15根实际消费的bar产出审计记录');
  });
});

test('locatePathForEvaluationForReplay：能锚定referenceBarRef并完整遍历96根24h路径（回填数据+历史asOfTime）；生产locatePathForEvaluation对同一场景仍复现悖论', { skip }, async () => {
  await withTxClient(async (client) => {
    const referenceOpenTime = Date.UTC(2026, 3, 10, 0, 0, 0);
    const referenceCloseTime = referenceOpenTime + FIFTEEN_MIN_MS - 1;

    const bars = [kline(referenceOpenTime, referenceCloseTime, '1000.00')];
    for (let i = 0; i < 96; i++) {
      const openTime = referenceCloseTime + 1 + i * FIFTEEN_MIN_MS;
      const closeTime = openTime + FIFTEEN_MIN_MS - 1;
      bars.push(kline(openTime, closeTime, (1000 + i).toFixed(2)));
    }
    const lastCloseTime = referenceCloseTime + 96 * FIFTEEN_MIN_MS;
    const historicalAsOfTime = lastCloseTime + 3600000; // 路径完全走完之后的历史时刻(评估时点)，留出充分余量
    const backfillWallClockMs = Date.now(); // 真实回填执行时间——远晚于historicalAsOfTime，制造悖论条件
    const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: backfillWallClockMs });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: referenceOpenTime, endTime: lastCloseTime, now: () => backfillWallClockMs });

    const referenceBarRef = { symbol: 'ETH', timeframe: '15m', openTime: referenceOpenTime, closeTime: referenceCloseTime, timeframeMs: FIFTEEN_MIN_MS, sequenceIndex: 0, barKey: `ETH-15m-${referenceCloseTime}` };

    const rawResult = await locatePathForEvaluation(client, { instrument: 'ETHUSDT', referenceBarRef, expectedBarCount: 96, asOfTime: historicalAsOfTime });
    assert.equal(rawResult.endpointDataComplete, false, '生产查询在历史asOfTime下应查询不到回填数据（悖论复现）');

    const result = await locatePathForEvaluationForReplay(client, { instrument: 'ETHUSDT', referenceBarRef, expectedBarCount: 96, asOfTime: historicalAsOfTime, replayNowMs: backfillWallClockMs });

    assert.ok(result.referenceBarRef, 'referenceBarRef应被重新确认存在');
    assert.equal(result.pathDataComplete, true, '96根路径应完整（回填数据连续无缺口）');
    assert.equal(result.endpointDataComplete, true);
    assert.equal(result.observedBars.length, 96);
    assert.equal(result.actualStartPrice, 1000);
    assert.equal(result.actualEndPrice, 1095);
    assert.equal(result.auditRecords.length, 97, '审计记录必须覆盖referenceBar本身+96根observedBars');
  });
});
