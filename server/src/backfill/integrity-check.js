// V1_4D_DATA_BACKFILL_SPEC.md §2.12：回填前后完整性校验（gap/duplicate/out-of-order）。
// V1_4D_HISTORICAL_REPLAY_SPEC.md §2.8 integrity_check_result 冻结要求：
// dataset-manifest-builder.js 必须复用本模块的检测逻辑，不得另写第二套判定
// （V1_4D_CODEX_IMPLEMENTATION_TASK.md 对应任务说明）。
// 本模块只读查询 public.market_bars，不写入任何数据。

import { INTERVAL_MS } from '../domain/constants.js';

// 对指定 (instrument, marketType, interval, [from,to)) 范围内的 formal K线做严格的
// 步长/重复/顺序检测，返回 gapCount/duplicateCount/outOfOrderCount 三项结果与明细。
export async function checkIntegrity(pool, { instrument, marketType = 'spot', interval, from, to }) {
  const stepMs = INTERVAL_MS[interval];
  if (!stepMs) throw Object.assign(new Error(`Invalid interval: ${interval}`), { code: 'INVALID_INTERVAL' });

  const result = await pool.query(
    `SELECT open_time, close_time, revision_number
     FROM market_bars
     WHERE instrument=$1 AND market_type=$2 AND interval_name=$3
       AND open_time>=to_timestamp($4/1000.0) AND open_time<to_timestamp($5/1000.0)
     ORDER BY open_time ASC, revision_number DESC`,
    [instrument, marketType, interval, from, to]
  );

  const rows = result.rows;
  const toMs = v => (v instanceof Date ? v.getTime() : new Date(v).getTime());

  // 去重：同一 open_time 只取最高 revision（与生产 bar-path-locator.js 的既有DISTINCT ON模式一致，不重新发明）。
  const seen = new Map();
  let duplicateCount = 0;
  for (const row of rows) {
    const key = toMs(row.open_time);
    if (seen.has(key)) duplicateCount += 1; else seen.set(key, row);
  }
  const distinctRows = [...seen.values()].sort((a, b) => toMs(a.open_time) - toMs(b.open_time));

  let gapCount = 0;
  let outOfOrderCount = 0;
  const gapDetails = [];
  const outOfOrderDetails = [];
  for (let i = 0; i < distinctRows.length; i += 1) {
    const row = distinctRows[i];
    const openMs = toMs(row.open_time);
    const closeMs = toMs(row.close_time);
    if (closeMs <= openMs) { outOfOrderCount += 1; outOfOrderDetails.push({ openTime: openMs, closeTime: closeMs, reason: 'CLOSE_NOT_AFTER_OPEN' }); }
    else if (closeMs - openMs + 1 !== stepMs) { outOfOrderCount += 1; outOfOrderDetails.push({ openTime: openMs, closeTime: closeMs, reason: 'INTERVAL_MISALIGNED' }); }
    if (i > 0) {
      const prevOpenMs = toMs(distinctRows[i - 1].open_time);
      const expected = prevOpenMs + stepMs;
      if (openMs !== expected) {
        gapCount += 1;
        gapDetails.push({ afterOpenTime: prevOpenMs, expectedOpenTime: expected, actualOpenTime: openMs, missingCount: Math.max(0, Math.round((openMs - expected) / stepMs)) });
      }
    }
  }

  return {
    rowCount: rows.length,
    distinctRowCount: distinctRows.length,
    gapCount,
    duplicateCount,
    outOfOrderCount,
    gapDetails,
    outOfOrderDetails
  };
}

// §2.8 integrity_check_result 冻结形状：{gapCount, duplicateCount, outOfOrderCount}——
// manifest 内容哈希只覆盖这三个整数（不含明细数组），明细仅供人工诊断，不进入哈希。
export function toManifestIntegrityCheckResult(result) {
  return Object.freeze({ gapCount: result.gapCount, duplicateCount: result.duplicateCount, outOfOrderCount: result.outOfOrderCount });
}
