// V1_4D_CODEX_IMPLEMENTATION_TASK.md §3.2 / V1_4D_HISTORICAL_REPLAY_SPEC.md §4.7：
// 回放专属数据访问层——物理独立于 server/src/forecast/bar-path-locator.js 的生产查询。
//
// P0-3修复（独立复审）：此前的实现（research-availability.js 的 createResearchAvailabilityQueryable）
// 用正则表达式在运行时改写 bar-path-locator.js 产出的生产SQL文本，把 production 的
// `available_at<=$N AND fetched_at<=$N` 判据替换成 researchAvailability 判据。这意味着 research 查询与
// production 查询在代码层面共用同一份SQL文本，只是"被一个开关/包装动态改写"——违反本任务书§3.2红线
// "两条查询路径物理上是两份独立的SQL语句"。
//
// 本模块不导入、不改写、不承载 bar-path-locator.js 的任何SQL。每个函数都有自己独立书写的、完整的、
// 字面量SQL文本，直接实现 researchAvailability(bar)=bar.close_time 语义（见
// V1_4D_DATA_BACKFILL_SPEC.md §2.9）：可得性判据是 `close_time<=asOfTime`（不含、也不需要 available_at——
// 对回填数据而言 available_at=回填执行的真实墙钟时间，与任何历史asOfTime比较恒假，是悖论，不是本模块的
// 可得性判据来源）+ `fetched_at<=replayNowMs`（防止读到回放任务发起时仍在进行中、尚未提交完成的并发回填
// 批次；replayNowMs 是回放任务发起时的真实系统时间，不是历史asOfTime，两者是完全独立的参数，不共享占位符）。
//
// 唯一与 bar-path-locator.js 共享的是其中的纯计算函数（rhythmBoundaryMs/computeAlignedReferenceCloseTime，
// 无SQL、无数据库副作用）与 threshold-formula.js 的 computeFourHourAtr14FromBars（同样是纯函数）——
// 这是任务书§3.2明确允许的"必要的共享纯函数"，不是被禁止的"共享承载不同时间语义的SQL"。

import { computeFourHourAtr14FromBars } from '../forecast/threshold-formula.js';
import { rhythmBoundaryMs, computeAlignedReferenceCloseTime } from '../forecast/bar-path-locator.js';

export { rhythmBoundaryMs, computeAlignedReferenceCloseTime };

const TIMEFRAME_MS = 900000; // 15分钟
const FOUR_HOUR_MS = 14400000;

const toMs = v => (v instanceof Date ? v.getTime() : Number(v));

// buildBarRef是bar-path-locator.js内部私有（未导出）的纯对象构造辅助，形状极简（无SQL、无判定逻辑），
// 本模块独立持有同形状的等价实现——按§3.2"保留必要的共享纯函数可以接受"的反面：这类纯粹是"把一行数据
// 包成一个对象"的辅助，重复几行代码远比强行导出生产模块的私有细节、或引入跨模块耦合更安全。
function buildBarRef(row, sequenceIndex, symbol, timeframeMs = TIMEFRAME_MS) {
  const openTime = toMs(row.open_time), closeTime = toMs(row.close_time);
  return Object.freeze({ symbol, timeframe: timeframeMs === TIMEFRAME_MS ? '15m' : '4h', openTime, closeTime, timeframeMs, sequenceIndex, barKey: `${symbol}-${timeframeMs === TIMEFRAME_MS ? '15m' : '4h'}-${closeTime}` });
}

// P1-1修复（独立复审）：research_data_vintage此前只保存{barKey, closeTime}，无法审计"这根K线到底是
// market_bars哪一条具体行(哪个revision/哪次回填批次)"。本函数从真实DB行构造完整审计记录——vintage_id是
// market_bars表上UNIQUE约束的那一列，是"这一条具体版本的K线"的权威身份证据，revision_number/source_id
// 佐证其修订与来源，available_at/fetched_at是该行在生产回填协议下的原始时间戳（与researchAvailability
// 使用的close_time判据是两回事——记录它们本身就是审计证据的一部分，不代表回放使用了它们做可得性判断）。
function buildAuditRecord(row, { instrument, symbol, interval }) {
  if (row.instrument !== instrument || row.interval_name !== interval) {
    throw Object.assign(
      new Error(`replay audit row identity mismatch: expected ${instrument}/${interval}, received ${row.instrument}/${row.interval_name}`),
      { code: 'REPLAY_AUDIT_IDENTITY_MISMATCH' }
    );
  }
  const values = {
    vintageId: row.vintage_id,
    symbol,
    interval,
    openTime: toMs(row.open_time),
    closeTime: toMs(row.close_time),
    availableAt: toMs(row.available_at),
    fetchedAt: toMs(row.fetched_at),
    sourceId: row.source_id,
    revisionNumber: Number(row.revision_number)
  };
  const missing = Object.entries(values)
    .filter(([key, value]) => (
      value == null ||
      (['openTime', 'closeTime', 'availableAt', 'fetchedAt', 'revisionNumber'].includes(key) && !Number.isFinite(value)) ||
      (['vintageId', 'symbol', 'interval', 'sourceId'].includes(key) && String(value).trim() === '')
    ))
    .map(([key]) => key);
  if (missing.length) {
    throw Object.assign(
      new Error(`replay audit record is missing critical market_bars field(s): ${missing.join(', ')}`),
      { code: 'INCOMPLETE_REPLAY_AUDIT_RECORD', missing }
    );
  }
  return Object.freeze({
    ...values,
    barKey: `${symbol}-${interval}-${values.closeTime}`
  });
}

function assertReplayNowMs(replayNowMs) {
  if (!Number.isSafeInteger(replayNowMs)) {
    throw Object.assign(new Error('replay bar-path queries require a real replayNowMs (wall-clock epoch ms), not a historical asOfTime'), { code: 'INVALID_REPLAY_NOW' });
  }
}

// researchAvailability专属：查询最近N根连续、已收盘的某周期K线，as-of边界只有 close_time/fetched_at 两项，
// 不含 available_at。逻辑（去重/连续性校验）与生产版本一致，因为这是描述"如何从查询结果里挑出连续N根"的
// 纯粹算法，不是"什么算可得"的时间语义本身——后者才是research/production物理分离要保护的核心。
async function queryRecentContiguousBarsForReplay(pool, { instrument, intervalName, asOfTime, replayNowMs, limit }) {
  assertReplayNowMs(replayNowMs);
  const result = await pool.query(
    `SELECT instrument, interval_name, open_time, close_time, open::text, high::text, low::text, close::text,
            revision_number, vintage_id, available_at, fetched_at, source_id
     FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name=$2
       AND close_time<=to_timestamp($3/1000.0) AND fetched_at<=to_timestamp($4/1000.0)
     ORDER BY open_time DESC, revision_number DESC
     LIMIT $5`,
    [instrument, intervalName, asOfTime, replayNowMs, limit * 3]
  );
  const seen = new Map();
  for (const row of result.rows) { const key = toMs(row.open_time); if (!seen.has(key)) seen.set(key, row); }
  const rows = [...seen.values()].sort((a, b) => toMs(a.open_time) - toMs(b.open_time));
  const tail = rows.slice(-limit);
  if (tail.length < limit) return { bars: tail, contiguous: false, auditRecords: [] };
  for (let i = 1; i < tail.length; i++) {
    if (toMs(tail[i].open_time) !== toMs(tail[i - 1].close_time) + 1) return { bars: tail, contiguous: false, auditRecords: [] };
  }
  return { bars: tail, contiguous: true, auditRecords: [] };
}

export async function computeFourHourAtr14ForReplay(pool, { instrument, asOfTime, replayNowMs, symbol = instrument === 'ETHUSDT' ? 'ETH' : instrument }) {
  const { bars, contiguous } = await queryRecentContiguousBarsForReplay(pool, { instrument, intervalName: '4h', asOfTime, replayNowMs, limit: 15 });
  if (!contiguous || bars.length !== 15) return { ok: false, reason: 'ATR14_4H_INSUFFICIENT', auditRecords: [] };
  try {
    const atr14FourHourAtGeneration = computeFourHourAtr14FromBars(bars);
    return { ok: true, atr14FourHourAtGeneration, auditRecords: bars.map(row => buildAuditRecord(row, { instrument, symbol, interval: '4h' })) };
  } catch (error) {
    return { ok: false, reason: error.code || 'ATR14_4H_INSUFFICIENT', auditRecords: [] };
  }
}

export async function computeConsecutiveBreakoutBarsForReplay(pool, { instrument, asOfTime, replayNowMs, direction, maxLookback = 3, symbol = instrument === 'ETHUSDT' ? 'ETH' : instrument }) {
  const requiredBars = 20 + maxLookback;
  const { bars, contiguous } = await queryRecentContiguousBarsForReplay(pool, { instrument, intervalName: '4h', asOfTime, replayNowMs, limit: requiredBars });
  if (!contiguous || bars.length !== requiredBars) return { count: null, state: 'INSUFFICIENT_DATA', maxLookback, auditRecords: [] };

  const candidateStates = [];
  for (let i = 20; i < requiredBars; i++) {
    const priorWindow = bars.slice(i - 20, i);
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
  return { count, state: count > 0 ? 'BREAKOUT_ACTIVE' : 'NOT_BREAKOUT', maxLookback, auditRecords: bars.map(row => buildAuditRecord(row, { instrument, symbol, interval: '4h' })) };
}

// referenceBar的candidate closeTime本身是 computeAlignedReferenceCloseTime(asOfTime, horizon) 的确定性
// 输出，数学上恒 <= asOfTime（见 bar-path-locator.js 同名函数注释），故此处不需要额外的fail-closed比较——
// 与 locatePathForEvaluationForReplay 不同：那里的 closeTime 来自调用方传入、早前生成阶段冻结的
// referenceBarRef，是一个"外部提供、需要独立验证"的值，本函数的 closeTime 是本函数自己刚计算出来的。
export async function locateReferenceBarAndPathForReplay(pool, { instrument, horizon, asOfTime, replayNowMs, symbol = instrument === 'ETHUSDT' ? 'ETH' : instrument }) {
  assertReplayNowMs(replayNowMs);
  const expectedBarCount = horizon === '24h' ? 96 : horizon === '72h' ? 288 : null;
  if (!expectedBarCount) throw Object.assign(new Error(`Invalid horizon: ${horizon}`), { code: 'INVALID_HORIZON' });

  const alignedCloseTime = computeAlignedReferenceCloseTime(asOfTime, horizon);
  const refResult = await pool.query(
    `SELECT vintage_id, instrument, interval_name, open_time, close_time, close::text,
            available_at, fetched_at, source_id, revision_number
     FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name='15m'
       AND close_time=to_timestamp($2/1000.0)
       AND close_time<=to_timestamp($3/1000.0) AND fetched_at<=to_timestamp($4/1000.0)
     ORDER BY revision_number DESC LIMIT 1`,
    [instrument, alignedCloseTime, asOfTime, replayNowMs]
  );
  if (!refResult.rows[0]) {
    return { referenceBarRef: null, targetBarRef: null, observedBars: [], missingBarRefs: [], endpointDataComplete: false, pathDataComplete: false, pathEligibleForStatistics: false, directionEligibleForStatistics: false, referencePrice: null, exclusionReasons: ['reference_bar_not_due_or_missing'] };
  }
  const referenceBar = refResult.rows[0];
  const referenceBarRef = buildBarRef(referenceBar, 0, symbol);
  const referenceAudit = buildAuditRecord(referenceBar, { instrument, symbol, interval: '15m' });
  const referencePrice = Number(referenceBar.close);
  const referenceCloseTime = toMs(referenceBar.close_time);
  const pathEndOpenTime = referenceCloseTime + 1 + (expectedBarCount - 1) * TIMEFRAME_MS;

  const pathResult = await pool.query(
    `SELECT instrument, interval_name, open_time, close_time, vintage_id, available_at, fetched_at, source_id, revision_number
     FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name='15m'
       AND open_time>=to_timestamp($2/1000.0) AND open_time<=to_timestamp($3/1000.0)
       AND close_time<=to_timestamp($4/1000.0) AND fetched_at<=to_timestamp($5/1000.0)
     ORDER BY open_time ASC, revision_number DESC`,
    [instrument, referenceCloseTime + 1, pathEndOpenTime, asOfTime, replayNowMs]
  );
  const byOpenTime = new Map();
  for (const row of pathResult.rows) { const key = toMs(row.open_time); if (!byOpenTime.has(key)) byOpenTime.set(key, row); }

  const observedBars = [];
  const observedAudits = [];
  const missingBarRefs = [];
  let cursorCloseTime = referenceCloseTime;
  for (let i = 1; i <= expectedBarCount; i++) {
    const expectedOpenTime = cursorCloseTime + 1;
    const row = byOpenTime.get(expectedOpenTime);
    if (row) {
      observedBars.push(buildBarRef(row, i, symbol));
      observedAudits.push(buildAuditRecord(row, { instrument, symbol, interval: '15m' }));
      cursorCloseTime = toMs(row.close_time);
    } else {
      const placeholderCloseTime = expectedOpenTime + TIMEFRAME_MS - 1;
      missingBarRefs.push(Object.freeze({ symbol, timeframe: '15m', openTime: expectedOpenTime, closeTime: placeholderCloseTime, timeframeMs: TIMEFRAME_MS, sequenceIndex: i, barKey: `${symbol}-15m-${placeholderCloseTime}` }));
      cursorCloseTime = placeholderCloseTime;
    }
  }

  const targetBarRef = observedBars.find(b => b.sequenceIndex === expectedBarCount) ?? null;
  const endpointDataComplete = referenceBarRef != null && targetBarRef != null;

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

  return {
    referenceBarRef, targetBarRef, observedBars, missingBarRefs,
    endpointDataComplete, pathDataComplete,
    pathEligibleForStatistics: pathDataComplete && endpointDataComplete,
    directionEligibleForStatistics: endpointDataComplete,
    referencePrice, expectedBarCount,
    exclusionReasons: missingBarRefs.map(b => `bar_missing:sequenceIndex=${b.sequenceIndex}`),
    auditRecords: [referenceAudit, ...observedAudits]
  };
}

// 评估期：referenceBarRef.closeTime 来自调用方传入（ForecastSnapshot生成时冻结的身份字段），不是本函数
// 自己刚算出来的值——必须独立校验 closeTime<=asOfTime，不得只依赖调用方保证（呼应本任务书P0-3"research
// 查询必须严格实现冻结规范中的as-of/availability约束"）。这里是一个普通JS条件判断，不是解析SQL文本的正则。
export async function locatePathForEvaluationForReplay(pool, { instrument, referenceBarRef, expectedBarCount, asOfTime, replayNowMs, symbol = referenceBarRef.symbol }) {
  assertReplayNowMs(replayNowMs);
  const referenceCloseTime = referenceBarRef.closeTime;
  if (!(Number.isFinite(referenceCloseTime) && Number.isFinite(asOfTime) && referenceCloseTime <= asOfTime)) {
    throw Object.assign(
      new Error(`replay evaluation query: referenceBarRef.closeTime (${referenceCloseTime}) exceeds asOfTime (${asOfTime}); refusing to read data that would not yet be available at the simulated historical clock (fail closed)`),
      { code: 'EXACT_MATCH_CLOSE_TIME_AFTER_AS_OF_TIME', closeTimeValue: referenceCloseTime, asOfTimeValue: asOfTime }
    );
  }

  const refResult = await pool.query(
    `SELECT vintage_id, instrument, interval_name, open_time, close_time, close::text,
            available_at, fetched_at, source_id, revision_number
     FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name='15m'
       AND close_time=to_timestamp($2/1000.0)
       AND close_time<=to_timestamp($3/1000.0) AND fetched_at<=to_timestamp($4/1000.0)
     ORDER BY revision_number DESC LIMIT 1`,
    [instrument, referenceCloseTime, asOfTime, replayNowMs]
  );
  const referenceRow = refResult.rows[0] || null;
  const referenceBarRefResolved = referenceRow ? buildBarRef(referenceRow, 0, symbol) : null;
  const referenceAudit = referenceRow ? buildAuditRecord(referenceRow, { instrument, symbol, interval: '15m' }) : null;
  const actualStartPrice = referenceRow ? Number(referenceRow.close) : null;

  const pathEndOpenTime = referenceCloseTime + 1 + (expectedBarCount - 1) * TIMEFRAME_MS;
  const pathResult = await pool.query(
    `SELECT instrument, interval_name, open_time, close_time, high::text, low::text, close::text,
            vintage_id, available_at, fetched_at, source_id, revision_number
     FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name='15m'
       AND open_time>=to_timestamp($2/1000.0) AND open_time<=to_timestamp($3/1000.0)
       AND close_time<=to_timestamp($4/1000.0) AND fetched_at<=to_timestamp($5/1000.0)
     ORDER BY open_time ASC, revision_number DESC`,
    [instrument, referenceCloseTime + 1, pathEndOpenTime, asOfTime, replayNowMs]
  );
  const byOpenTime = new Map();
  for (const row of pathResult.rows) { const key = toMs(row.open_time); if (!byOpenTime.has(key)) byOpenTime.set(key, row); }

  const observedBars = [];
  const observedAudits = [];
  const missingBarRefs = [];
  let cursorCloseTime = referenceCloseTime;
  for (let i = 1; i <= expectedBarCount; i++) {
    const expectedOpenTime = cursorCloseTime + 1;
    const row = byOpenTime.get(expectedOpenTime);
    if (row) {
      observedBars.push({ ...buildBarRef(row, i, symbol), high: Number(row.high), low: Number(row.low), close: Number(row.close) });
      observedAudits.push(buildAuditRecord(row, { instrument, symbol, interval: '15m' }));
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
    exclusionReasons: missingBarRefs.map(b => `bar_missing:sequenceIndex=${b.sequenceIndex}`),
    auditRecords: referenceAudit ? [referenceAudit, ...observedAudits] : observedAudits
  };
}
