// R5/R7.1a：backfill-cli-entry.js 的 historical_validation.backfill_batches 审计行生命周期
// （创建/恢复/ATTENTION_REQUIRED标记/FAILED标记），使用隔离测试库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { runBackfillForInterval } from '../../src/backfill/backfill-cli-entry.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;

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
    const result = await runBackfillForInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime + 900000, now: () => nowMs });
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

    const result = await runBackfillForInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar2Close, now: () => nowMs });
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
    const result = await runBackfillForInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: 0, endTime: 900000 });
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

    const calls1 = [];
    const adapter1 = makeMockAdapter({ pages: [[kline(bar0Open, bar0Close)]], serverTimeMs: nowMs1, calls: calls1 });
    const first = await runBackfillForInterval({ pool: client, adapter: adapter1, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar1Close, now: () => nowMs1 });
    // 首次运行只喂了一页(bar0)，第二页留空模拟"运行到一半中断"——checkIntegrity 会发现区间末尾缺口(ATTENTION_REQUIRED)，
    // resume校验的重点是：续跑时 backfillInterval 传给 adapter.spotKlines 的 startTime 已经推进到 bar0之后，而不是从bar0Open重新拉取。
    assert.equal(calls1[0].startTime, bar0Open);

    const nowMs2 = bar1Close + 60000;
    const calls2 = [];
    const adapter2 = makeMockAdapter({ pages: [[kline(bar1Open, bar1Close)]], serverTimeMs: nowMs2, calls: calls2 });
    const second = await runBackfillForInterval({ pool: client, adapter: adapter2, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar1Close, resumeBatchId: first.backfillBatchId, now: () => nowMs2 });
    assert.equal(second.status, 'SUCCEEDED');
    assert.equal(calls2[0].startTime, bar0Open + 1, 'resume游标必须推进到last_completed_open_time之后，不得从bar0Open重新拉取');

    const bar0Count = (await client.query(`SELECT count(*)::int AS n FROM market_bars WHERE close_time=to_timestamp($1/1000.0)`, [bar0Close])).rows[0].n;
    const bar1Count = (await client.query(`SELECT count(*)::int AS n FROM market_bars WHERE close_time=to_timestamp($1/1000.0)`, [bar1Close])).rows[0].n;
    assert.equal(bar0Count, 1);
    assert.equal(bar1Count, 1);
  });
});
