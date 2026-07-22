// V1_4C_SCOPE_SPEC.md §4.1 — directionThreshold唯一权威公式，纯函数，无storage参数
import { THRESHOLD_FORMULA_VERSION } from './forecast-version.js';

const HORIZON_PARAMS = Object.freeze({
  '24h': Object.freeze({ periods: 6, floor: 0.008, ceiling: 0.05 }),
  '72h': Object.freeze({ periods: 18, floor: 0.015, ceiling: 0.08 })
});

export const clamp = (value, floor, ceiling) => Math.min(Math.max(value, floor), ceiling);

// bars: 恰好15根按open_time升序排列的已收盘4H bar（{open,high,low,close}均为可转数字的十进制字符串或number）
// bars[0]仅提供prevClose；bars[1..14]各自产生一个TR样本；atr14 = 14个TR样本均值
export function computeFourHourAtr14FromBars(bars) {
  if (!Array.isArray(bars) || bars.length !== 15) throw Object.assign(new Error('ATR14_4H_INSUFFICIENT'), { code: 'ATR14_4H_INSUFFICIENT' });
  const n = bars.map(b => ({ high: Number(b.high), low: Number(b.low), close: Number(b.close) }));
  if (n.some(b => !Number.isFinite(b.high) || !Number.isFinite(b.low) || !Number.isFinite(b.close))) {
    throw Object.assign(new Error('ATR14_4H_INSUFFICIENT'), { code: 'ATR14_4H_INSUFFICIENT' });
  }
  const trueRanges = [];
  for (let i = 1; i <= 14; i++) {
    const prevClose = n[i - 1].close, cur = n[i];
    trueRanges.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)));
  }
  const atr14 = trueRanges.reduce((a, b) => a + b, 0) / 14;
  if (!Number.isFinite(atr14) || atr14 <= 0) throw Object.assign(new Error('ATR14_4H_INSUFFICIENT'), { code: 'ATR14_4H_INSUFFICIENT' });
  return atr14;
}

// §4.1 公式：rawThreshold = atr14FourHourAtGeneration / referencePrice × sqrt(periods)；directionThreshold = clamp(rawThreshold, floor, ceiling)
export function computeDirectionThreshold({ atr14FourHourAtGeneration, referencePrice, horizon }) {
  const params = HORIZON_PARAMS[horizon];
  if (!params) throw Object.assign(new Error(`Invalid horizon: ${horizon}`), { code: 'INVALID_HORIZON' });
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) throw Object.assign(new Error('ATR14_4H_INSUFFICIENT'), { code: 'ATR14_4H_INSUFFICIENT' });
  if (!Number.isFinite(atr14FourHourAtGeneration) || atr14FourHourAtGeneration <= 0) throw Object.assign(new Error('ATR14_4H_INSUFFICIENT'), { code: 'ATR14_4H_INSUFFICIENT' });
  const rawThreshold = (atr14FourHourAtGeneration / referencePrice) * Math.sqrt(params.periods);
  const directionThreshold = clamp(rawThreshold, params.floor, params.ceiling);
  return {
    rawThreshold, directionThreshold,
    thresholdFloor: params.floor, thresholdCeiling: params.ceiling,
    thresholdFormulaVersion: THRESHOLD_FORMULA_VERSION
  };
}

// GMKG §10.3 方向判定：actualReturn>=+threshold→UP；actualReturn<=-threshold→DOWN；否则RANGE
export function classifyDirection(actualReturn, directionThreshold) {
  if (!Number.isFinite(actualReturn) || !Number.isFinite(directionThreshold)) return null;
  if (actualReturn >= directionThreshold) return 'UP';
  if (actualReturn <= -directionThreshold) return 'DOWN';
  return 'RANGE';
}
