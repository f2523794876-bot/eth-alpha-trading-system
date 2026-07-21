// V1_4C_SCOPE_SPEC.md §8.3 — 映射二/三/四，纯函数，无storage参数。映射一（连续bar计数）在bar-path-locator.js（需查询market_bars历史）。
import { BTC_ALIGNMENT_FORMULA_VERSION } from './forecast-version.js';

export const CORRELATION_FLOOR = 0.3;
export const TOLERANCE_ATR_MULTIPLE = 0.3; // 复用V1_4_FORECAST_DATA_SPEC.md §4.2既有0.3xATR容差常量，语义收窄为"到失效线的距离容差"

// 映射二：srZones.lower/upper 不再构造区间宽度，swingHigh/swingLow只作单一失效线，"贴近"改用ATR归一化距离
export function isNearSupport(distanceToSupportAtr, toleranceAtrMultiple = TOLERANCE_ATR_MULTIPLE) {
  return Number.isFinite(distanceToSupportAtr) && distanceToSupportAtr <= toleranceAtrMultiple;
}
export function isNearResistance(distanceToResistanceAtr, toleranceAtrMultiple = TOLERANCE_ATR_MULTIPLE) {
  return Number.isFinite(distanceToResistanceAtr) && distanceToResistanceAtr <= toleranceAtrMultiple;
}

// 映射三：falseBreakoutRisk 只能作为当根拒绝证据，不得冒充跨bar确认(confirmation_failed)
export function isFalseBreakoutVetoed(falseBreakoutRisk) {
  return falseBreakoutRisk !== 'NONE' && falseBreakoutRisk != null;
}

// 映射四：带符号相关性 effectiveBtcDirection，本轮修正正负号语义
export function effectiveBtcDirection(correlation, btcTrendState, correlationFloor = CORRELATION_FLOOR) {
  if (!Number.isFinite(correlation)) return 'UNKNOWN';
  if (!btcTrendState || btcTrendState === 'flat') return 'UNKNOWN';
  if (correlation >= correlationFloor) return btcTrendState;                                   // 正相关，含边界：沿用BTC表面方向
  if (correlation <= -correlationFloor) return btcTrendState === 'up' ? 'down' : 'up';          // 负相关，含边界：方向取反
  return 'UNKNOWN';                                                                              // (-floor, +floor) 开区间：相关性不足
}

// btcAlignmentServer：effectiveBtcDirection 与 candidateDirection 比较 → SUPPORT/OPPOSE/UNKNOWN
export function btcAlignmentServer(candidateDirection, btcTrendState, ethBtcRollingCorrelation, correlationFloor = CORRELATION_FLOOR) {
  if (candidateDirection !== 'up' && candidateDirection !== 'down') return 'UNKNOWN';
  const effective = effectiveBtcDirection(ethBtcRollingCorrelation, btcTrendState, correlationFloor);
  if (effective === 'UNKNOWN') return 'UNKNOWN';
  return effective === candidateDirection ? 'SUPPORT' : 'OPPOSE';
}

export const btcAlignmentFormulaVersion = BTC_ALIGNMENT_FORMULA_VERSION;
