// V1_4D_DATA_BACKFILL_SPEC.md §2：回填CLI入口。
// npm run backfill:market-bars -- --symbol ETHUSDT --intervals 15m,1h,4h --from <UTC> --to <UTC> [--resume <backfill_batch_id>]
//
// 每个 (symbol, interval) 组合对应一条独立的 historical_validation.backfill_batches 审计行。
// 本模块不获取/续租/释放任何生产 collector_leases（§2.13）；不读取或写入 provisional_market_bars（同节）。

import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createPgPool } from '../db/postgres.js';
import { createGuardedResearchPgPool, exitCodeForCliError } from '../db/research-database-guard.js';
import { PublicHttpClient } from '../http/client.js';
import { BinancePublicAdapter } from '../sources/binance.js';
import { backfillInterval } from './binance-kline-backfill.js';
import { checkIntegrity, computeIntegrityBoundary } from './integrity-check.js';
import { INTERVAL_MS } from '../domain/constants.js';

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

// P1-6修复（独立复审）：resume batch的symbol/interval_name必须与当前请求一致，请求区间也必须一致——
// 一个backfill_batch_id按§2.11绑定唯一的(symbol, interval_name, requested_start_utc, requested_end_utc)
// 幂等单位，跨symbol/interval/区间"借用"一个resume ID在语义上没有意义（last_completed_open_time游标
// 是针对原(symbol,interval,range)算出来的，套到不同symbol/interval/range上会产生错误的续跑起点）。
// 拒绝必须发生在任何market_bars写入（backfillInterval调用）之前——本函数在此处提前return/throw，
// 不会走到下面的backfillInterval()。
export function assertResumeBatchCompatible(batch, { symbol, interval, startTime, endTime, fixedAsOf, backfillBatchId }) {
  if (batch.symbol !== symbol || batch.interval_name !== interval) {
    throw Object.assign(
      new Error(`--resume batch ${backfillBatchId} was recorded for (symbol=${batch.symbol}, interval=${batch.interval_name}), not (symbol=${symbol}, interval=${interval}); refusing to resume across a mismatched symbol/interval`),
      { code: 'BACKFILL_RESUME_SYMBOL_INTERVAL_MISMATCH', expectedSymbol: batch.symbol, expectedInterval: batch.interval_name, actualSymbol: symbol, actualInterval: interval }
    );
  }
  const batchStartMs = new Date(batch.requested_start_utc).getTime();
  const batchEndMs = new Date(batch.requested_end_utc).getTime();
  if (batchStartMs !== startTime || batchEndMs !== endTime) {
    throw Object.assign(
      new Error(`--resume batch ${backfillBatchId} was recorded for range [${batch.requested_start_utc}, ${batch.requested_end_utc}), not [${new Date(startTime).toISOString()}, ${new Date(endTime).toISOString()}); refusing to resume with an incompatible range`),
      { code: 'BACKFILL_RESUME_RANGE_MISMATCH' }
    );
  }
  const batchAsOfMs = new Date(batch.fixed_as_of).getTime();
  if (batchAsOfMs !== fixedAsOf) {
    throw Object.assign(new Error(`--resume batch ${backfillBatchId} has a different fixed as-of`), {
      code: 'BACKFILL_RESUME_AS_OF_MISMATCH', expectedAsOf: batchAsOfMs, actualAsOf: fixedAsOf
    });
  }
}

// §2.12：回填前基线记录 + 回填后完整性校验；任一失败则整批标记 ATTENTION_REQUIRED，不自动重试覆盖。
export async function runBackfillForInterval({ pool, adapter, symbol, interval, startTime, endTime, fixedAsOf, resumeBatchId, dryRun = false, now = Date.now }) {
  if (!Number.isSafeInteger(fixedAsOf)) throw Object.assign(new Error('--as-of is required'), { code: 'AS_OF_REQUIRED' });
  const boundary = computeIntegrityBoundary({ from: startTime, to: endTime, asOf: fixedAsOf, interval });
  let backfillBatchId = resumeBatchId;
  let resumeFrom = startTime;

  if (dryRun) {
    if (resumeBatchId) throw Object.assign(new Error('--dry-run cannot mutate or resume an existing audit batch'), { code: 'DRY_RUN_RESUME_CONFLICT' });
    const result = await backfillInterval({ pool, adapter, symbol, interval, startTime, endTime: boundary.lastExpectedOpenTime, requestedTo: endTime, fixedAsOf, dryRun: true, now });
    return { backfillBatchId: null, ...result, audit: { persisted: false, fixedAsOf: new Date(fixedAsOf).toISOString() } };
  }

  if (backfillBatchId) {
    const existing = await pool.query('SELECT * FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [backfillBatchId]);
    if (!existing.rowCount) throw Object.assign(new Error(`Unknown backfill_batch_id: ${backfillBatchId}`), { code: 'BACKFILL_BATCH_NOT_FOUND' });
    const batch = existing.rows[0];
    assertResumeBatchCompatible(batch, { symbol, interval, startTime, endTime, fixedAsOf, backfillBatchId });
    // R11.4修复：--resume只能作用于真正仍处于RUNNING（进程中途被杀死、从未走到finalize）的批次。
    // 此前对已到达任一终态（SUCCEEDED/FAILED/ATTENTION_REQUIRED）的批次重新--resume，会把该行静默
    // 改回RUNNING并重写finished_at，破坏终态不可变红线（R11.4）；ATTENTION_REQUIRED批次尤其不得被
    // 这样"自动重试覆盖"（R3.1红线原文："不自动重试覆盖"）。检查必须发生在任何状态写入或
    // backfillInterval调用之前。
    if (batch.status !== 'RUNNING') {
      throw Object.assign(
        new Error(`--resume batch ${backfillBatchId} is already in terminal state ${batch.status}; refusing to reprocess a finished batch`),
        { code: 'BACKFILL_RESUME_ALREADY_TERMINAL', currentStatus: batch.status }
      );
    }
    if (batch.last_completed_open_time) resumeFrom = new Date(batch.last_completed_open_time).getTime() + INTERVAL_MS[interval];
    // 防御性条件更新：仅在status确实仍为RUNNING时才生效，防止上面的检查与此处之间出现竞态窗口下的
    // 二次覆盖；受影响行数不为1时fail-closed，不得假装继续。
    const runningGuard = await pool.query(`UPDATE historical_validation.backfill_batches SET status='RUNNING' WHERE backfill_batch_id=$1 AND status='RUNNING'`, [backfillBatchId]);
    if (runningGuard.rowCount !== 1) {
      throw Object.assign(new Error(`backfill_batch_id ${backfillBatchId} status changed concurrently before resume could proceed`), { code: 'BACKFILL_BATCH_STATE_CONFLICT' });
    }
  } else {
    backfillBatchId = randomUUID();
    await pool.query(
      `INSERT INTO historical_validation.backfill_batches(backfill_batch_id,symbol,interval_name,requested_start_utc,requested_end_utc,fixed_as_of,status,started_at)
       VALUES($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),to_timestamp($6/1000.0),'RUNNING',now())`,
      [backfillBatchId, symbol, interval, startTime, endTime, fixedAsOf]
    );
  }

  try {
    const result = await backfillInterval({ pool, adapter, symbol, interval, startTime: resumeFrom, endTime: boundary.lastExpectedOpenTime, requestedTo: endTime, fixedAsOf, backfillBatchId, now });
    if (result.status === 'BLOCKED') {
      const failGuard = await pool.query(`UPDATE historical_validation.backfill_batches SET status='FAILED', error_code=$2, finished_at=now() WHERE backfill_batch_id=$1 AND status='RUNNING'`, [backfillBatchId, result.reason]);
      if (failGuard.rowCount !== 1) {
        throw Object.assign(new Error(`backfill_batch_id ${backfillBatchId} status changed concurrently while recording BLOCKED result`), { code: 'BACKFILL_BATCH_STATE_CONFLICT' });
      }
      return { backfillBatchId, status: 'FAILED', reason: result.reason };
    }

    // §2.12 回填后完整性校验：对整个请求区间（含本次之前已完成的部分）重新检测。
    const integrity = await checkIntegrity(pool, { instrument: symbol, interval, from: startTime, to: endTime, asOf: fixedAsOf });
    if (integrity.gapCount > 0 || integrity.duplicateCount > 0 || integrity.outOfOrderCount > 0) {
      const attentionGuard = await pool.query(
        `UPDATE historical_validation.backfill_batches SET status='ATTENTION_REQUIRED', error_code='INTEGRITY_CHECK_FAILED', finished_at=now() WHERE backfill_batch_id=$1 AND status='RUNNING'`,
        [backfillBatchId]
      );
      if (attentionGuard.rowCount !== 1) {
        throw Object.assign(new Error(`backfill_batch_id ${backfillBatchId} status changed concurrently while recording ATTENTION_REQUIRED result`), { code: 'BACKFILL_BATCH_STATE_CONFLICT' });
      }
      return { backfillBatchId, status: 'ATTENTION_REQUIRED', integrity };
    }

    const successGuard = await pool.query(`UPDATE historical_validation.backfill_batches SET status='SUCCEEDED', finished_at=now() WHERE backfill_batch_id=$1 AND status='RUNNING'`, [backfillBatchId]);
    if (successGuard.rowCount !== 1) {
      throw Object.assign(new Error(`backfill_batch_id ${backfillBatchId} status changed concurrently while recording SUCCEEDED result`), { code: 'BACKFILL_BATCH_STATE_CONFLICT' });
    }
    return { backfillBatchId, status: 'SUCCEEDED', ...result, integrity, audit: { persisted: true, fixedAsOf: new Date(fixedAsOf).toISOString() } };
  } catch (error) {
    // BACKFILL_BATCH_STATE_CONFLICT已经证明该行不再处于RUNNING（上面某个防御性条件更新0行命中），
    // 该行本身未被本次调用触碰，不需要（也不应该）再尝试标记FAILED——避免对一个已经处于其它终态的行
    // 做多余的条件更新尝试。其余任何真实异常（网络错误/校验失败等）才需要走FAILED归档路径。
    if (error.code !== 'BACKFILL_BATCH_STATE_CONFLICT') {
      const failGuard = await pool.query(`UPDATE historical_validation.backfill_batches SET status='FAILED', error_code=$2, finished_at=now() WHERE backfill_batch_id=$1 AND status='RUNNING'`, [backfillBatchId, error.code || error.message]);
      if (failGuard.rowCount !== 1) {
        // 该行在真正的失败发生前就已经离开RUNNING状态（理论上不应该发生，单线程调用下没有已知触发路径）——
        // 不伪造一个新的"归档成功"假象，也不生成一个掩盖原始异常的新错误，只标记后原样抛出原始异常。
        error.auditRowUnchanged = true;
      }
    }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), { createPgPool: createPgPoolOverride = createPgPool } = {}) {
  const args = parseArgs(argv);
  const symbol = args.symbol;
  const intervals = String(args.intervals || '').split(',').map(s => s.trim()).filter(Boolean);
  const startTime = parseUtc(args.from, '--from');
  const endTime = parseUtc(args.to, '--to');

  // P1-6修复（独立复审）：V1_4D_DATA_BACKFILL_SPEC.md§2.11只定义了"单个--resume续跑同一(symbol,interval)"
  // 的语义（回填任务按(interval_name,时间分页游标)为幂等单位），未定义"一个--resume ID分别套用到多个
  // --intervals"的合法语法。此前的实现把同一个args.resume原样传给下面循环里的每一次
  // runBackfillForInterval调用——若--intervals传了多个值，第一个interval校验通过后，同一个resume ID
  // 会被静默套用到其余完全不相关的interval上。冻结规范未批准这种"一份resume覆盖多interval"的用法，
  // 因此在此明确拒绝，不自行发明新语法。
  if (args.resume && intervals.length > 1) {
    throw Object.assign(
      new Error('--resume can only be combined with a single --intervals value — one backfill_batch_id maps to exactly one (symbol, interval_name); pass --resume separately per interval'),
      { code: 'RESUME_INTERVALS_CONFLICT' }
    );
  }

  if (args['as-of'] === undefined || args['as-of'] === true) throw Object.assign(new Error('--as-of is required'), { code: 'AS_OF_REQUIRED' });
  const fixedAsOf = parseUtc(args['as-of'], '--as-of');
  if (!symbol || !intervals.length) throw Object.assign(new Error('--symbol and --intervals are required'), { code: 'MISSING_REQUIRED_ARG' });

  const config = loadConfig();
  const pool = await createGuardedResearchPgPool(config, { createPgPool: createPgPoolOverride });
  const client = new PublicHttpClient(config);
  const adapter = new BinancePublicAdapter({ client, spotBaseUrl: config.spotBaseUrl, futuresBaseUrl: config.futuresBaseUrl });
  try {
    const results = [];
    for (const interval of intervals) {
      const result = await runBackfillForInterval({ pool, adapter, symbol, interval, startTime, endTime, fixedAsOf, resumeBatchId: args.resume, dryRun: args['dry-run'] === true });
      results.push({ interval, ...result });
      console.info('backfill interval complete', { interval, status: result.status, backfillBatchId: result.backfillBatchId });
    }
    return results;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error('backfill failed', { code: error.code || error.message }); process.exitCode = exitCodeForCliError(error); });
}
