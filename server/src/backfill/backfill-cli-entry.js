// V1_4D_DATA_BACKFILL_SPEC.md §2：回填CLI入口。
// npm run backfill:market-bars -- --symbol ETHUSDT --intervals 15m,1h,4h --from <UTC> --to <UTC> [--resume <backfill_batch_id>]
//
// 每个 (symbol, interval) 组合对应一条独立的 historical_validation.backfill_batches 审计行。
// 本模块不获取/续租/释放任何生产 collector_leases（§2.13）；不读取或写入 provisional_market_bars（同节）。

import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createPgPool } from '../db/postgres.js';
import { PublicHttpClient } from '../http/client.js';
import { BinancePublicAdapter } from '../sources/binance.js';
import { backfillInterval } from './binance-kline-backfill.js';
import { checkIntegrity } from './integrity-check.js';

const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      args[key] = value;
      if (value !== true) i += 1;
    }
  }
  return args;
}

export function parseUtc(value, label) {
  if (typeof value !== 'string' || !UTC_ISO_RE.test(value)) {
    throw Object.assign(new Error(`${label} must be UTC ISO8601 (YYYY-MM-DDTHH:mm:ssZ): got ${value}`), { code: 'INVALID_TIME_FORMAT' });
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw Object.assign(new Error(`${label} is not a valid timestamp`), { code: 'INVALID_TIME_FORMAT' });
  return ms;
}

// §2.12：回填前基线记录 + 回填后完整性校验；任一失败则整批标记 ATTENTION_REQUIRED，不自动重试覆盖。
export async function runBackfillForInterval({ pool, adapter, symbol, interval, startTime, endTime, resumeBatchId, now = Date.now }) {
  let backfillBatchId = resumeBatchId;
  let resumeFrom = startTime;

  if (backfillBatchId) {
    const existing = await pool.query('SELECT * FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [backfillBatchId]);
    if (!existing.rowCount) throw Object.assign(new Error(`Unknown backfill_batch_id: ${backfillBatchId}`), { code: 'BACKFILL_BATCH_NOT_FOUND' });
    const batch = existing.rows[0];
    if (batch.last_completed_open_time) resumeFrom = new Date(batch.last_completed_open_time).getTime() + 1;
    await pool.query(`UPDATE historical_validation.backfill_batches SET status='RUNNING' WHERE backfill_batch_id=$1`, [backfillBatchId]);
  } else {
    backfillBatchId = randomUUID();
    await pool.query(
      `INSERT INTO historical_validation.backfill_batches(backfill_batch_id,symbol,interval_name,requested_start_utc,requested_end_utc,status,started_at)
       VALUES($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),'RUNNING',now())`,
      [backfillBatchId, symbol, interval, startTime, endTime]
    );
  }

  try {
    const result = await backfillInterval({ pool, adapter, symbol, interval, startTime: resumeFrom, endTime, backfillBatchId, now });
    if (result.status === 'BLOCKED') {
      await pool.query(`UPDATE historical_validation.backfill_batches SET status='FAILED', error_code=$2, finished_at=now() WHERE backfill_batch_id=$1`, [backfillBatchId, result.reason]);
      return { backfillBatchId, status: 'FAILED', reason: result.reason };
    }

    // §2.12 回填后完整性校验：对整个请求区间（含本次之前已完成的部分）重新检测。
    const integrity = await checkIntegrity(pool, { instrument: symbol, interval, from: startTime, to: endTime });
    if (integrity.gapCount > 0 || integrity.duplicateCount > 0 || integrity.outOfOrderCount > 0) {
      await pool.query(
        `UPDATE historical_validation.backfill_batches SET status='ATTENTION_REQUIRED', error_code='INTEGRITY_CHECK_FAILED', finished_at=now() WHERE backfill_batch_id=$1`,
        [backfillBatchId]
      );
      return { backfillBatchId, status: 'ATTENTION_REQUIRED', integrity };
    }

    await pool.query(`UPDATE historical_validation.backfill_batches SET status='SUCCEEDED', finished_at=now() WHERE backfill_batch_id=$1`, [backfillBatchId]);
    return { backfillBatchId, status: 'SUCCEEDED', ...result, integrity };
  } catch (error) {
    await pool.query(`UPDATE historical_validation.backfill_batches SET status='FAILED', error_code=$2, finished_at=now() WHERE backfill_batch_id=$1`, [backfillBatchId, error.code || error.message]);
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const symbol = args.symbol;
  const intervals = String(args.intervals || '').split(',').map(s => s.trim()).filter(Boolean);
  const startTime = parseUtc(args.from, '--from');
  const endTime = parseUtc(args.to, '--to');
  if (!symbol || !intervals.length) throw Object.assign(new Error('--symbol and --intervals are required'), { code: 'MISSING_REQUIRED_ARG' });

  const config = loadConfig();
  const pool = await createPgPool(config);
  const client = new PublicHttpClient(config);
  const adapter = new BinancePublicAdapter({ client, spotBaseUrl: config.spotBaseUrl, futuresBaseUrl: config.futuresBaseUrl });
  try {
    const results = [];
    for (const interval of intervals) {
      const result = await runBackfillForInterval({ pool, adapter, symbol, interval, startTime, endTime, resumeBatchId: args.resume });
      results.push({ interval, ...result });
      console.info('backfill interval complete', { interval, status: result.status, backfillBatchId: result.backfillBatchId });
    }
    return results;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error('backfill failed', { code: error.code || error.message }); process.exitCode = 1; });
}
