import { INTERVAL_MS, NORMALIZER_VERSION, SCHEMA_VERSION } from './constants.js';
import { sha256 } from './hash.js';
import { buildVintageRef } from './vintage.js';

const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
export const isDecimalString = value => typeof value === 'string' && decimalPattern.test(value);
const positive = value => isDecimalString(value) && Number(value) >= 0;

export function validateKlineRow(row, interval) {
  const errors = [];
  if (!Array.isArray(row) || row.length < 11) return ['ROW_SHAPE_INVALID'];
  const [openTime, open, high, low, close, volume, closeTime, quoteVolume] = row;
  if (!Number.isSafeInteger(openTime) || !Number.isSafeInteger(closeTime) || closeTime <= openTime) errors.push('TIME_INVALID');
  if (INTERVAL_MS[interval] && closeTime - openTime + 1 !== INTERVAL_MS[interval]) errors.push('TIME_MISALIGNED');
  if (![open, high, low, close].every(positive)) errors.push('OHLC_INVALID');
  else if (Number(high) < Math.max(Number(open), Number(close), Number(low)) || Number(low) > Math.min(Number(open), Number(close), Number(high))) errors.push('OHLC_RELATION_INVALID');
  if (!positive(volume) || !positive(quoteVolume)) errors.push('VOLUME_INVALID');
  return errors;
}

export function normalizeKlines({ rows, sourceId, endpointId, instrument, marketType, interval, serverTime, fetchedAt, rawPayloadId, requestId, firstAvailableByKey = new Map() }) {
  if (!Array.isArray(rows)) throw new Error('KLINES_NOT_ARRAY');
  const formal = []; const provisional = []; const rejected = []; let previousOpen = null;
  for (const row of rows) {
    const errors = validateKlineRow(row, interval);
    const openTime = row?.[0]; const closeTime = row?.[6];
    if (previousOpen !== null && openTime <= previousOpen) errors.push(openTime === previousOpen ? 'DUPLICATE_TIME' : 'NON_INCREASING_TIME');
    previousOpen = openTime;
    if (errors.length) { rejected.push({ row, errors }); continue; }
    const key = `${sourceId}:${marketType}:${instrument}:${interval}:${openTime}`;
    const values = { open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5], quoteVolume: row[7], tradeCount: row[8], takerBuyBaseVolume: row[9], takerBuyQuoteVolume: row[10] };
    const firstAvailableAt = firstAvailableByKey.get(key) ?? fetchedAt;
    const closed = closeTime <= serverTime;
    const item = {
      sourceId, endpointId, instrument, marketType, interval, openTime, closeTime,
      ...values, publishedAt: closeTime, availableAt: closed ? closeTime : null, firstAvailableAt: closed ? firstAvailableAt : null, fetchedAt,
      revisionNumber: closed ? 0 : null, vintageId: closed ? `${instrument}-${marketType}-${interval}-${closeTime}-rev0` : null,
      rawPayloadId, requestId, schemaVersion: SCHEMA_VERSION, normalizerVersion: NORMALIZER_VERSION,
      qualityState: closed ? 'NORMAL' : 'PROVISIONAL', contentHash: sha256({ openTime, closeTime, ...values })
    };
    if (closed) item.dataVintageRef = buildVintageRef({ sourceId, sourceRef: endpointId, fieldId: `${instrument}_${marketType}_${interval}_kline`, instrument, interval, observationStart: openTime, observationEnd: closeTime, publishedAt: closeTime, availableAt: closeTime, firstAvailableAt, fetchedAt, value: values });
    (closed ? formal : provisional).push(Object.freeze(item));
  }
  return { formal, provisional, rejected };
}

export function detectGaps(bars, interval) {
  const step = INTERVAL_MS[interval]; if (!step) throw new Error('INVALID_INTERVAL');
  const gaps = [];
  for (let i = 1; i < bars.length; i += 1) {
    const expected = bars[i - 1].openTime + step;
    if (bars[i].openTime > expected) gaps.push({ interval, startOpenTime: expected, endOpenTime: bars[i].openTime - step, missingCount: Math.floor((bars[i].openTime - expected) / step), status: 'OPEN' });
  }
  return gaps;
}

export function normalizeFunding(row, context) {
  if (!row || !positive(row.fundingRate) && !(isDecimalString(row.fundingRate) && Number.isFinite(Number(row.fundingRate))) || !Number.isSafeInteger(row.fundingTime)) throw new Error('FUNDING_INVALID');
  return pointFact('funding_rate', row.symbol, row.fundingTime, { fundingRate: row.fundingRate, markPrice: row.markPrice ?? null }, context);
}
export function normalizeOpenInterest(row, context) {
  if (!row || !positive(row.openInterest) || !Number.isSafeInteger(row.time)) throw new Error('OPEN_INTEREST_INVALID');
  return pointFact('open_interest', row.symbol, row.time, { openInterest: row.openInterest }, context);
}
export function normalizeLongShort(row, context) {
  if (!row || ![row.longShortRatio, row.longAccount, row.shortAccount].every(positive) || !Number.isSafeInteger(row.timestamp)) throw new Error('LONG_SHORT_INVALID');
  return pointFact('long_short_ratio', row.symbol || context.instrument, row.timestamp, { longShortRatio: row.longShortRatio, longAccount: row.longAccount, shortAccount: row.shortAccount }, context);
}
export function normalizeTakerFlow(row, context) {
  if (!row || ![row.buySellRatio, row.buyVol, row.sellVol].every(positive) || !Number.isSafeInteger(row.timestamp)) throw new Error('TAKER_FLOW_INVALID');
  return pointFact('taker_flow', context.instrument, row.timestamp, { buySellRatio: row.buySellRatio, buyVolume: row.buyVol, sellVolume: row.sellVol }, context);
}
function pointFact(fieldId, instrument, observedAt, values, context) {
  const firstAvailableAt = context.firstAvailableAt ?? context.fetchedAt;
  return Object.freeze({ ...context, fieldId, instrument, observedAt, observationPeriod: { start: observedAt, end: observedAt }, publishedAt: observedAt, availableAt: observedAt, firstAvailableAt, revisionNumber: context.revisionNumber ?? 0, vintageId: `${context.sourceId}:${fieldId}:${instrument}:${observedAt}:rev${context.revisionNumber ?? 0}`, schemaVersion: SCHEMA_VERSION, normalizerVersion: NORMALIZER_VERSION, contentHash: sha256(values), ...values });
}
