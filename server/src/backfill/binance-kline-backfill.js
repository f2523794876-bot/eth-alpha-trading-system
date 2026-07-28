// V1_4D_DATA_BACKFILL_SPEC.md §2：Binance历史K线分页拉取+写入 public.market_bars（formal数据）。
// 红线（§2.9冻结裁决1）：available_at/fetched_at 写回填任务真实执行时间，不得复用
// server/src/domain/normalize.js 第37行 `availableAt: closed ? closeTime : null` 的实时路径赋值逻辑
// ——本模块不导入 normalizeKlines()，只复用其中纯粹的行校验函数 validateKlineRow()。
// 本模块不获取/续租/释放任何生产 collector_leases（§2.13），直接使用传入的 pg pool 执行只追加式 INSERT。

import { randomUUID } from 'node:crypto';
import { validateKlineRow } from '../domain/normalize.js';
import { sha256 } from '../domain/hash.js';
import { measureServerTime } from '../collector/time-guard.js';
import { INTERVAL_MS, SCHEMA_VERSION, NORMALIZER_VERSION } from '../domain/constants.js';

const MARKET_BAR_COLUMNS = Object.freeze([
  'source_id','endpoint_id','instrument','market_type','interval_name','open_time','close_time',
  'open','high','low','close','volume','quote_volume','trade_count','taker_buy_base_volume','taker_buy_quote_volume',
  'observation_start','observation_end','published_at','available_at','first_available_at','fetched_at',
  'revision_number','vintage_id','raw_payload_id','request_id','schema_version','normalizer_version','quality_state','content_hash'
]);
const positionalValues = length => Array.from({ length }, (_, i) => `$${i + 1}`).join(',');
const PAGE_LIMIT = 1000;

// §2.6：去重键与ON CONFLICT策略——vintage_id唯一，DO NOTHING，绝不覆盖已有正式K线。
function vintageIdFor(instrument, marketType, interval, closeTime) {
  return `${instrument}-${marketType}-${interval}-${closeTime}-rev0`;
}

async function insertRawPayload(pool, { sourceId, endpointId, fetchedAt, httpStatus, headers, payload, schemaVersion, requestId }) {
  const rawPayloadId = randomUUID();
  const contentHash = sha256(payload);
  const result = await pool.query(
    `INSERT INTO raw_payloads(raw_payload_id,request_id,source_id,endpoint_id,fetched_at,http_status,response_headers,payload,content_hash,schema_version,quality_state)
     VALUES($1,$2,$3,$4,to_timestamp($5/1000.0),$6,$7::jsonb,$8::jsonb,$9,$10,$11)
     ON CONFLICT(request_id,content_hash) DO NOTHING RETURNING raw_payload_id`,
    [rawPayloadId, requestId, sourceId, endpointId, fetchedAt, httpStatus, JSON.stringify(headers || {}), JSON.stringify(payload), contentHash, schemaVersion, 'NORMAL']
  );
  if (result.rowCount) return result.rows[0].raw_payload_id;
  const existing = await pool.query('SELECT raw_payload_id FROM raw_payloads WHERE request_id=$1 AND content_hash=$2', [requestId, contentHash]);
  return existing.rows[0].raw_payload_id;
}

// §2.1/§2.5/§2.6/§2.7/§2.8/§2.9：单一周期、单一区间的分页回填主循环。
// 调用方（backfill-cli-entry.js）负责创建/更新 historical_validation.backfill_batches 审计行并传入 backfillBatchId。
export async function backfillInterval({
  pool, adapter, symbol, interval, marketType = 'spot',
  sourceId = 'binance-spot-rest', endpointId = 'binance-spot-klines',
  startTime, endTime, backfillBatchId, now = Date.now, onProgress
}) {
  if (!INTERVAL_MS[interval]) throw Object.assign(new Error(`Invalid interval: ${interval}`), { code: 'INVALID_INTERVAL' });
  if (!(Number.isSafeInteger(startTime) && Number.isSafeInteger(endTime) && startTime <= endTime)) {
    throw Object.assign(new Error('Invalid backfill time range'), { code: 'INVALID_TIME_RANGE' });
  }

  // §2.4：回填任务启动前必须校时，fail closed。
  const serverTime = await measureServerTime(adapter, { now });
  if (!serverTime.ok) return { status: 'BLOCKED', reason: serverTime.reason || 'SERVER_TIME_UNAVAILABLE' };
  const asOfMs = serverTime.sourceServerTime;

  let cursor = startTime;
  let rowsInserted = 0;
  let rowsDeduped = 0;
  let rowsRejected = 0;
  let lastCompletedOpenTime = null;

  while (cursor <= endTime) {
    const response = await adapter.spotKlines(symbol, interval, { startTime: cursor, endTime, limit: PAGE_LIMIT });
    const rows = Array.isArray(response.body) ? response.body : [];
    if (!rows.length) break;

    // §2.8：回填任务实际执行的真实系统时间——available_at/fetched_at 均取此值，不取 close_time。
    const fetchedAtMs = now();
    const rawPayloadId = await insertRawPayload(pool, {
      sourceId, endpointId, fetchedAt: fetchedAtMs, httpStatus: response.status,
      headers: response.headers, payload: rows, schemaVersion: 'binance-kline-v1', requestId: response.requestId
    });

    let previousOpenTime = null;
    for (const row of rows) {
      const errors = validateKlineRow(row, interval);
      const [openTime, open, high, low, close, volume, closeTime, quoteVolume, tradeCount, takerBuyBaseVolume, takerBuyQuoteVolume] = row;
      if (previousOpenTime !== null && openTime <= previousOpenTime) errors.push(openTime === previousOpenTime ? 'DUPLICATE_TIME' : 'NON_INCREASING_TIME');
      previousOpenTime = openTime;
      if (errors.length) { rowsRejected += 1; continue; }
      // §2.5：仅接受已收盘K线——最后一页可能包含尚未收盘的当前K线，必须过滤丢弃。
      if (closeTime > asOfMs) continue;

      const vintageId = vintageIdFor(symbol, marketType, interval, closeTime);
      const contentHash = sha256({ openTime, closeTime, open, high, low, close, volume, quoteVolume });
      const values = [
        sourceId, endpointId, symbol, marketType, interval, new Date(openTime), new Date(closeTime),
        open, high, low, close, volume, quoteVolume, tradeCount ?? null, takerBuyBaseVolume ?? null, takerBuyQuoteVolume ?? null,
        new Date(openTime), new Date(closeTime), new Date(closeTime),
        new Date(fetchedAtMs), // available_at = 回填真实执行时间（红线，不等于close_time）
        new Date(fetchedAtMs), // first_available_at = 同上（回填场景无"多次修订取更早可得时间"概念）
        new Date(fetchedAtMs), // fetched_at = 回填真实执行时间
        0, vintageId, rawPayloadId, response.requestId, SCHEMA_VERSION, NORMALIZER_VERSION, 'NORMAL', contentHash
      ];
      const result = await pool.query(
        `INSERT INTO market_bars(${MARKET_BAR_COLUMNS.join(',')}) VALUES(${positionalValues(values.length)}) ON CONFLICT(vintage_id) DO NOTHING`,
        values
      );
      if (result.rowCount) rowsInserted += 1; else rowsDeduped += 1;
    }

    lastCompletedOpenTime = rows[rows.length - 1][0];
    if (backfillBatchId) {
      await pool.query(
        `UPDATE historical_validation.backfill_batches
         SET last_completed_open_time=to_timestamp($1/1000.0), rows_inserted=$2, rows_deduped=$3
         WHERE backfill_batch_id=$4`,
        [lastCompletedOpenTime, rowsInserted, rowsDeduped, backfillBatchId]
      );
    }
    onProgress?.({ cursor, lastCompletedOpenTime, rowsInserted, rowsDeduped, rowsRejected });

    if (rows.length < PAGE_LIMIT) break; // 最后一页
    // P2-3修复（独立复审）：正常分页下lastCompletedOpenTime(本页最后一根bar的openTime)必须
    // >= 本次请求的cursor(向adapter请求的startTime)，故nextCursor必然严格大于cursor。若adapter
    // 返回了不符合请求区间的陈旧/重复页（异常实现、mock配置错误、或恶意/损坏响应），nextCursor可能
    // <=cursor（游标不推进）——不fail closed的话会造成对同一（或更早）区间的无限重复请求。
    // 显式守卫：一旦检测到游标未真正前进，立即fail closed并返回稳定、可诊断的错误，不静默截断
    // （NaN等异常值下`cursor<=endTime`可能巧合为false从而"安静地"提前结束，那样会产生未被发现的
    // 数据缺口，比抛错更危险，故此处不依赖while条件本身的副作用，主动显式校验）。
    const nextCursor = lastCompletedOpenTime + INTERVAL_MS[interval];
    if (!(nextCursor > cursor)) {
      throw Object.assign(
        new Error(`Backfill pagination cursor failed to advance (cursor=${cursor}, lastCompletedOpenTime=${lastCompletedOpenTime}, nextCursor=${nextCursor}) — refusing to loop indefinitely`),
        { code: 'BACKFILL_CURSOR_NOT_ADVANCING', cursor, lastCompletedOpenTime, nextCursor }
      );
    }
    cursor = nextCursor;
  }

  return { status: 'SUCCEEDED', rowsInserted, rowsDeduped, rowsRejected, lastCompletedOpenTime };
}
