// V1_4C_SCOPE_SPEC.md §10（96/288路径遍历）+ §4.1（4H ATR14取数）+ §8.3映射一（23根连续计数回放）
// 三者共享同一套as-of正确查询模式，均为只读查询，不写入market_bars任何字段。
import { computeFourHourAtr14FromBars } from './threshold-formula.js';

const TIMEFRAME_MS = 900000; // 15分钟，GMKG §10.1 BarRef.timeframeMs固定值
const FOUR_HOUR_MS = 14400000;

const toMs = v => (v instanceof Date ? v.getTime() : Number(v));

function buildBarRef(row, sequenceIndex, symbol, timeframeMs = TIMEFRAME_MS) {
  const openTime = toMs(row.open_time), closeTime = toMs(row.close_time);
  return Object.freeze({ symbol, timeframe: timeframeMs === TIMEFRAME_MS ? '15m' : '4h', openTime, closeTime, timeframeMs, sequenceIndex, barKey: `${symbol}-${timeframeMs === TIMEFRAME_MS ? '15m' : '4h'}-${closeTime}` });
}

// 查询最近N根连续、已收盘的某周期K线（revision-safe as-of查询），按open_time升序返回；
// 若数量不足N或存在缺口/乱序，contiguous=false（调用方据此fail closed/INSUFFICIENT_DATA，不得猜测）
async function queryRecentContiguousBars(queryable, { instrument, intervalName, stepMs, asOfTime, limit }) {
  const result = await queryable.query(
    `SELECT open_time, close_time, open::text, high::text, low::text, close::text, revision_number
     FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name=$2
       AND close_time<=to_timestamp($3/1000.0) AND available_at<=to_timestamp($3/1000.0) AND fetched_at<=to_timestamp($3/1000.0)
     ORDER BY open_time DESC, revision_number DESC
     LIMIT $4`,
    [instrument, intervalName, asOfTime, limit * 3] // 超采样以应对同一open_time多revision去重后仍不足limit的情形
  );
  // DISTINCT ON(open_time) 效果：按open_time去重，保留revision最高（=当时可见最新）的一行
  const seen = new Map();
  for (const row of result.rows) { const key = toMs(row.open_time); if (!seen.has(key)) seen.set(key, row); }
  const rows = [...seen.values()].sort((a, b) => toMs(a.open_time) - toMs(b.open_time));
  const tail = rows.slice(-limit);
  if (tail.length < limit) return { bars: tail, contiguous: false };
  for (let i = 1; i < tail.length; i++) {
    if (toMs(tail[i].open_time) !== toMs(tail[i - 1].close_time) + 1) return { bars: tail, contiguous: false };
  }
  return { bars: tail, contiguous: true };
}

// §4.1：4H ATR14，requiredBars=15（bars[0]仅提供prevClose，bars[1..14]产生14个完整TR样本）
export async function computeFourHourAtr14(queryable, { instrument, asOfTime }) {
  const { bars, contiguous } = await queryRecentContiguousBars(queryable, { instrument, intervalName: '4h', stepMs: FOUR_HOUR_MS, asOfTime, limit: 15 });
  if (!contiguous || bars.length !== 15) return { ok: false, reason: 'ATR14_4H_INSUFFICIENT' };
  try {
    const atr14FourHourAtGeneration = computeFourHourAtr14FromBars(bars);
    return { ok: true, atr14FourHourAtGeneration };
  } catch (error) {
    return { ok: false, reason: error.code || 'ATR14_4H_INSUFFICIENT' };
  }
}

// §8.3映射一：连续突破/跌破计数，requiredBars=20+M(=3)=23；每候选bar使用其自身严格之前的20根历史
export async function computeConsecutiveBreakoutBars(queryable, { instrument, asOfTime, direction, maxLookback = 3 }) {
  const requiredBars = 20 + maxLookback;
  const { bars, contiguous } = await queryRecentContiguousBars(queryable, { instrument, intervalName: '4h', stepMs: FOUR_HOUR_MS, asOfTime, limit: requiredBars });
  if (!contiguous || bars.length !== requiredBars) return { count: null, state: 'INSUFFICIENT_DATA', maxLookback };

  const candidateStates = [];
  for (let i = 20; i < requiredBars; i++) {
    const priorWindow = bars.slice(i - 20, i); // 严格早于候选bar自身，不使用该bar之后任何数据
    const priorHigh20 = Math.max(...priorWindow.map(b => Number(b.high)));
    const priorLow20 = Math.min(...priorWindow.map(b => Number(b.low)));
    const candidateClose = Number(bars[i].close);
    const isBreakout = direction === 'up' ? candidateClose > priorHigh20 : candidateClose < priorLow20;
    candidateStates.push(isBreakout ? 'BREAKOUT' : 'NOT_BREAKOUT');
  }
  let count = 0;
  for (let i = candidateStates.length - 1; i >= 0; i--) {
    if (candidateStates[i] === 'BREAKOUT') count += 1; else break;
  }
  return { count, state: count > 0 ? 'BREAKOUT_ACTIVE' : 'NOT_BREAKOUT', maxLookback };
}

// §10：referenceBar(sequenceIndex=0) + 96/288根目标路径(sequenceIndex 1..N)
export async function locateReferenceBarAndPath(queryable, { instrument, horizon, asOfTime, symbol = instrument === 'ETHUSDT' ? 'ETH' : instrument }) {
  const expectedBarCount = horizon === '24h' ? 96 : horizon === '72h' ? 288 : null;
  if (!expectedBarCount) throw Object.assign(new Error(`Invalid horizon: ${horizon}`), { code: 'INVALID_HORIZON' });

  const refResult = await queryable.query(
    `SELECT open_time, close_time, close::text FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name='15m'
       AND close_time<=to_timestamp($2/1000.0) AND available_at<=to_timestamp($2/1000.0) AND fetched_at<=to_timestamp($2/1000.0)
     ORDER BY open_time DESC, revision_number DESC LIMIT 1`,
    [instrument, asOfTime]
  );
  if (!refResult.rows[0]) {
    return { referenceBarRef: null, targetBarRef: null, observedBars: [], missingBarRefs: [], endpointDataComplete: false, pathDataComplete: false, pathEligibleForStatistics: false, directionEligibleForStatistics: false, referencePrice: null, exclusionReasons: ['reference_bar_missing'] };
  }
  const referenceBar = refResult.rows[0];
  const referenceBarRef = buildBarRef(referenceBar, 0, symbol);
  const referencePrice = Number(referenceBar.close);
  const referenceCloseTime = toMs(referenceBar.close_time);
  const pathEndOpenTime = referenceCloseTime + 1 + (expectedBarCount - 1) * TIMEFRAME_MS;
  const pathEndCloseTime = pathEndOpenTime + TIMEFRAME_MS - 1;

  // 批量查询目标路径范围内全部已收盘K线（等价于逐根查询的批处理版本，语义相同：不得使用未来数据，缺口逐根检测）
  const pathResult = await queryable.query(
    `SELECT open_time, close_time FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name='15m'
       AND open_time>=to_timestamp($2/1000.0) AND open_time<=to_timestamp($3/1000.0)
       AND close_time<=to_timestamp($4/1000.0) AND available_at<=to_timestamp($4/1000.0) AND fetched_at<=to_timestamp($4/1000.0)
     ORDER BY open_time ASC, revision_number DESC`,
    [instrument, referenceCloseTime + 1, pathEndOpenTime, asOfTime]
  );
  const byOpenTime = new Map();
  for (const row of pathResult.rows) { const key = toMs(row.open_time); if (!byOpenTime.has(key)) byOpenTime.set(key, row); } // revision DESC已排序，先到先得=最新revision

  const observedBars = [];
  const missingBarRefs = [];
  let cursorCloseTime = referenceCloseTime;
  for (let i = 1; i <= expectedBarCount; i++) {
    const expectedOpenTime = cursorCloseTime + 1;
    const row = byOpenTime.get(expectedOpenTime);
    if (row) {
      observedBars.push(buildBarRef(row, i, symbol));
      cursorCloseTime = toMs(row.close_time);
    } else {
      const placeholderCloseTime = expectedOpenTime + TIMEFRAME_MS - 1;
      missingBarRefs.push(Object.freeze({ symbol, timeframe: '15m', openTime: expectedOpenTime, closeTime: placeholderCloseTime, timeframeMs: TIMEFRAME_MS, sequenceIndex: i, barKey: `${symbol}-15m-${placeholderCloseTime}` }));
      cursorCloseTime = placeholderCloseTime; // 假设式前进，仅用于继续遍历定位后续bar
    }
  }

  const targetBarRef = observedBars.find(b => b.sequenceIndex === expectedBarCount) ?? null;
  const endpointDataComplete = referenceBarRef != null && targetBarRef != null;

  // §10.5.1九项不变量
  const observedBarCount = observedBars.length;
  const sequenceIndexes = observedBars.map(b => b.sequenceIndex);
  const uniqueSeq = new Set(sequenceIndexes);
  const barKeys = observedBars.map(b => b.barKey);
  const uniqueKeys = new Set(barKeys);
  const monotonic = observedBars.every((b, idx) => idx === 0 || b.openTime > observedBars[idx - 1].closeTime - TIMEFRAME_MS); // 相邻bar时间严格递增（openTime紧随前一根closeTime）
  const targetIndexMatches = targetBarRef ? targetBarRef.sequenceIndex === expectedBarCount : false;

  const pathDataComplete = (
    observedBarCount === expectedBarCount &&
    missingBarRefs.length === 0 &&
    uniqueSeq.size === expectedBarCount &&
    uniqueKeys.size === observedBarCount &&
    monotonic &&
    targetIndexMatches
  );

  return {
    referenceBarRef, targetBarRef, observedBars, missingBarRefs,
    endpointDataComplete, pathDataComplete,
    pathEligibleForStatistics: pathDataComplete && endpointDataComplete,
    directionEligibleForStatistics: endpointDataComplete,
    referencePrice, expectedBarCount,
    exclusionReasons: missingBarRefs.map(b => `bar_missing:sequenceIndex=${b.sequenceIndex}`)
  };
}

// GMKG §10.5.0/§10.5.1：评估期使用，锚定ForecastSnapshot自身冻结的referenceBarRef/targetBarRef身份（而非“as-of最近一根”），
// 核对该具体bar当前（asOfTime）是否已存在、路径sequenceIndex 1..expectedBarCount是否满足九项不变量，并取得OHLC供MFE/MAE/actualHigh/actualLow使用。
export async function locatePathForEvaluation(queryable, { instrument, referenceBarRef, expectedBarCount, asOfTime, symbol = referenceBarRef.symbol }) {
  const referenceCloseTime = referenceBarRef.closeTime;
  const refResult = await queryable.query(
    `SELECT open_time, close_time, close::text FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name='15m'
       AND close_time=to_timestamp($2/1000.0)
       AND available_at<=to_timestamp($3/1000.0) AND fetched_at<=to_timestamp($3/1000.0)
     ORDER BY revision_number DESC LIMIT 1`,
    [instrument, referenceCloseTime, asOfTime]
  );
  const referenceRow = refResult.rows[0] || null;
  const referenceBarRefResolved = referenceRow ? buildBarRef(referenceRow, 0, symbol) : null;
  const actualStartPrice = referenceRow ? Number(referenceRow.close) : null;

  const pathEndOpenTime = referenceCloseTime + 1 + (expectedBarCount - 1) * TIMEFRAME_MS;
  const pathResult = await queryable.query(
    `SELECT open_time, close_time, high::text, low::text, close::text FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name='15m'
       AND open_time>=to_timestamp($2/1000.0) AND open_time<=to_timestamp($3/1000.0)
       AND close_time<=to_timestamp($4/1000.0) AND available_at<=to_timestamp($4/1000.0) AND fetched_at<=to_timestamp($4/1000.0)
     ORDER BY open_time ASC, revision_number DESC`,
    [instrument, referenceCloseTime + 1, pathEndOpenTime, asOfTime]
  );
  const byOpenTime = new Map();
  for (const row of pathResult.rows) { const key = toMs(row.open_time); if (!byOpenTime.has(key)) byOpenTime.set(key, row); }

  const observedBars = [];
  const missingBarRefs = [];
  let cursorCloseTime = referenceCloseTime;
  for (let i = 1; i <= expectedBarCount; i++) {
    const expectedOpenTime = cursorCloseTime + 1;
    const row = byOpenTime.get(expectedOpenTime);
    if (row) {
      observedBars.push({ ...buildBarRef(row, i, symbol), high: Number(row.high), low: Number(row.low), close: Number(row.close) });
      cursorCloseTime = toMs(row.close_time);
    } else {
      const placeholderCloseTime = expectedOpenTime + TIMEFRAME_MS - 1;
      missingBarRefs.push(Object.freeze({ symbol, timeframe: '15m', openTime: expectedOpenTime, closeTime: placeholderCloseTime, timeframeMs: TIMEFRAME_MS, sequenceIndex: i, barKey: `${symbol}-15m-${placeholderCloseTime}` }));
      cursorCloseTime = placeholderCloseTime;
    }
  }

  const targetBarRow = observedBars.find(b => b.sequenceIndex === expectedBarCount) ?? null;
  const targetBarRef = targetBarRow ? { symbol: targetBarRow.symbol, timeframe: targetBarRow.timeframe, openTime: targetBarRow.openTime, closeTime: targetBarRow.closeTime, timeframeMs: targetBarRow.timeframeMs, sequenceIndex: targetBarRow.sequenceIndex, barKey: targetBarRow.barKey } : null;
  const actualEndPrice = targetBarRow ? targetBarRow.close : null;
  const endpointDataComplete = referenceBarRefResolved != null && targetBarRef != null;

  const observedBarCount = observedBars.length;
  const uniqueSeq = new Set(observedBars.map(b => b.sequenceIndex));
  const uniqueKeys = new Set(observedBars.map(b => b.barKey));
  const monotonic = observedBars.every((b, idx) => idx === 0 || b.openTime > observedBars[idx - 1].closeTime - TIMEFRAME_MS);
  const targetIndexMatches = targetBarRef ? targetBarRef.sequenceIndex === expectedBarCount : false;
  const pathDataComplete = (
    observedBarCount === expectedBarCount &&
    missingBarRefs.length === 0 &&
    uniqueSeq.size === expectedBarCount &&
    uniqueKeys.size === observedBarCount &&
    monotonic &&
    targetIndexMatches
  );

  const actualHigh = observedBars.length ? Math.max(...observedBars.map(b => b.high)) : null;
  const actualLow = observedBars.length ? Math.min(...observedBars.map(b => b.low)) : null;

  return {
    referenceBarRef: referenceBarRefResolved, targetBarRef, observedBars, missingBarRefs,
    endpointDataComplete, pathDataComplete,
    pathEligibleForStatistics: pathDataComplete && endpointDataComplete,
    directionEligibleForStatistics: endpointDataComplete,
    actualStartPrice, actualEndPrice, actualHigh, actualLow,
    exclusionReasons: missingBarRefs.map(b => `bar_missing:sequenceIndex=${b.sequenceIndex}`)
  };
}
