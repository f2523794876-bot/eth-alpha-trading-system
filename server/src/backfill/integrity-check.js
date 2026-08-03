// V1_4D_DATA_BACKFILL_SPEC.md §2.12：回填前后完整性校验（gap/duplicate/out-of-order）。
// V1_4D_HISTORICAL_REPLAY_SPEC.md §2.8 integrity_check_result 冻结要求：
// dataset-manifest-builder.js 必须复用本模块的检测逻辑，不得另写第二套判定
// （V1_4D_CODEX_IMPLEMENTATION_TASK.md 对应任务说明）。
// 本模块只读查询 public.market_bars，不写入任何数据。
//
// P0-4修复（独立复审）：此前的gap检测只比较"已返回行之间"的相邻open_time间隔，完全无法发现：
// ①请求区间[from,to)整体没有任何返回行（空结果）；②第一根K线晚于from（开头缺失/leading gap）；
// ③最后覆盖早于to（结尾缺失/trailing gap，含"最后一页没拉到"的情形）；④只返回了区间中间某一段连续
// 子区间（本质是leading gap+trailing gap同时发生）——这几类此前统统会被静默判定为"gapCount=0"（因为
// 相邻比较只在"已存在的行之间"进行，根本不知道边界之外该有什么）。
// 本轮改为：把[from,to)按stepMs展开成完整的"期望open_time位置序列"，与实际distinctRows的open_time集合
// 逐位比对，任何缺失位置（无论在开头、结尾还是中间）都计入gapCount——统一口径，不再区分"中间gap"与
// "边界gap"两套检测逻辑。连续缺失的位置合并为一个gap事件（gapDetails里一条记录，missingCount记录这次
// 缺了几根），语义与此前保持一致（gapCount是"gap事件数"，不是"缺失bar总数"）。

import { INTERVAL_MS } from '../domain/constants.js';

export function computeIntegrityBoundary({ from, to, asOf, interval }) {
  const stepMs = INTERVAL_MS[interval];
  if (!stepMs) throw Object.assign(new Error(`Invalid interval: ${interval}`), { code: 'INVALID_INTERVAL' });
  if (!(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from < to)) {
    throw Object.assign(new Error(`Invalid integrity check range: from=${from}, to=${to}`), { code: 'INVALID_INTEGRITY_RANGE' });
  }
  if (from % stepMs !== 0 || to % stepMs !== 0) {
    throw Object.assign(new Error(`Integrity range must align to ${interval} UTC buckets`), { code: 'UNALIGNED_INTEGRITY_RANGE', interval, from, to });
  }
  const fixedAsOf = asOf ?? to - 1;
  if (!Number.isSafeInteger(fixedAsOf)) {
    throw Object.assign(new Error(`Invalid fixed as-of: ${fixedAsOf}`), { code: 'INVALID_AS_OF' });
  }
  // Binance close_time is bucket end minus 1ms. This is the first bucket boundary
  // strictly after every candle which is closed at or before fixedAsOf.
  const asOfExclusiveBoundary = Math.floor((fixedAsOf + 1) / stepMs) * stepMs;
  const effectiveTo = Math.min(to, asOfExclusiveBoundary);
  if (effectiveTo <= from) {
    throw Object.assign(new Error('The requested range contains no candle closed by fixed as-of'), { code: 'EMPTY_AS_OF_RANGE', interval, from, to, fixedAsOf });
  }
  const expectedBarCount = (effectiveTo - from) / stepMs;
  return Object.freeze({
    interval,
    stepMs,
    requestedFrom: from,
    requestedTo: to,
    fixedAsOf,
    effectiveFrom: from,
    effectiveTo,
    firstExpectedOpenTime: from,
    lastExpectedOpenTime: effectiveTo - stepMs,
    lastAllowedCloseTime: effectiveTo - 1,
    expectedBarCount
  });
}

export function inspectIntegrityRows(rows, boundary) {
  const { effectiveFrom: from, effectiveTo: to, stepMs, expectedBarCount } = boundary;
  const toMs = v => (v instanceof Date ? v.getTime() : new Date(v).getTime());
  const seen = new Map();
  let duplicateCount = 0;
  for (const row of rows) {
    const key = toMs(row.open_time);
    if (seen.has(key)) duplicateCount += 1; else seen.set(key, row);
  }
  const distinctRows = [...seen.values()].sort((a, b) => toMs(a.open_time) - toMs(b.open_time));
  let outOfOrderCount = 0;
  const outOfOrderDetails = [];
  for (const row of distinctRows) {
    const openMs = toMs(row.open_time);
    const closeMs = toMs(row.close_time);
    if (closeMs <= openMs) { outOfOrderCount += 1; outOfOrderDetails.push({ openTime: openMs, closeTime: closeMs, reason: 'CLOSE_NOT_AFTER_OPEN' }); }
    else if (closeMs - openMs + 1 !== stepMs) { outOfOrderCount += 1; outOfOrderDetails.push({ openTime: openMs, closeTime: closeMs, reason: 'INTERVAL_MISALIGNED' }); }
  }
  const presentOpenTimes = new Set(distinctRows.map(row => toMs(row.open_time)));
  let gapCount = 0;
  const gapDetails = [];
  let runStart = null;
  let runLength = 0;
  const flushRun = (endOpenTime) => {
    if (runStart === null) return;
    gapCount += 1;
    const reason = runLength === expectedBarCount ? 'EMPTY_RESULT' : runStart === from ? 'LEADING_GAP_FIRST_BAR_MISSING' : endOpenTime == null ? 'TRAILING_GAP_LAST_BAR_MISSING' : 'MID_RANGE_GAP';
    gapDetails.push({ afterOpenTime: runStart - stepMs, expectedOpenTime: runStart, actualOpenTime: endOpenTime, missingCount: runLength, reason });
    runStart = null; runLength = 0;
  };
  for (let openTime = from; openTime < to; openTime += stepMs) {
    if (presentOpenTimes.has(openTime)) flushRun(openTime);
    else { if (runStart === null) runStart = openTime; runLength += 1; }
  }
  flushRun(null);
  return {
    ...boundary,
    rowCount: rows.length,
    distinctRowCount: distinctRows.length,
    actualBarCount: distinctRows.length,
    firstActualOpenTime: distinctRows.length ? toMs(distinctRows[0].open_time) : null,
    lastActualOpenTime: distinctRows.length ? toMs(distinctRows.at(-1).open_time) : null,
    emptyResult: distinctRows.length === 0,
    firstBarMissing: !presentOpenTimes.has(from),
    lastBarMissing: !presentOpenTimes.has(to - stepMs),
    gapCount, duplicateCount, outOfOrderCount, gapDetails, outOfOrderDetails,
    countMatches: distinctRows.length === expectedBarCount
  };
}

// 对指定 (instrument, marketType, interval, [from,to)) 范围内的 formal K线做严格的
// 步长/重复/顺序/边界覆盖检测，返回 gapCount/duplicateCount/outOfOrderCount 三项结果与明细。
export async function checkIntegrity(pool, { instrument, marketType = 'spot', interval, from, to, asOf }) {
  const boundary = computeIntegrityBoundary({ from, to, asOf, interval });

  const result = await pool.query(
    `SELECT open_time, close_time, revision_number
     FROM public.market_bars
     WHERE instrument=$1 AND market_type=$2 AND interval_name=$3
       AND open_time>=to_timestamp($4/1000.0) AND open_time<to_timestamp($5/1000.0)
     ORDER BY open_time ASC, revision_number DESC`,
    [instrument, marketType, interval, boundary.effectiveFrom, boundary.effectiveTo]
  );
  return inspectIntegrityRows(result.rows, boundary);
}

// §2.8 integrity_check_result 冻结形状：{gapCount, duplicateCount, outOfOrderCount}——
// manifest 内容哈希只覆盖这三个整数（不含明细数组），明细仅供人工诊断，不进入哈希。
export function toManifestIntegrityCheckResult(result) {
  return Object.freeze({ gapCount: result.gapCount, duplicateCount: result.duplicateCount, outOfOrderCount: result.outOfOrderCount });
}
