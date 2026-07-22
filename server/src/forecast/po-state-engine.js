// V1_4C_SCOPE_SPEC.md §8/§9 — 9个PO_代理状态判定，只读消费V1.4B feature_records白名单字段 + §8.3四项映射。
// 业务定义/必要/加分/否决条件继承V1_4_FORECAST_DATA_SPEC.md §4.2，不扩展、不重定义状态本身（§8.1红线）。
//
// 实施说明（规范内部口径澄清，非静默修改）：§8.2映射表将`e4.atr14`标注为可直接复用`feature_records.atr14`，
// 但§4.1已明确该字段恒为15m目标周期ATR、不是4H ATR；原浏览器PO_规则的`e4.atr14`语义上是4H ATR。
// 本实施选择复用已经为§4.1正确构建的4H ATR计算路径（bar-path-locator.js computeFourHourAtr14）
// 作为PO_状态规则的ATR来源（参数名`atr14FourHour`），而非使用15m-scoped的`feature_records.atr14`，
// 这是基于§4.1既有红线的一致性解释，未改变规范文本，已在V1_4C_IMPLEMENTATION_REPORT.md中记录。
import { isNearSupport, isNearResistance, isFalseBreakoutVetoed, btcAlignmentServer } from './po-feature-mapping.js';
import { PO_RULE_VERSION } from './forecast-version.js';

export const PO_STATES = Object.freeze([
  'PO_RANGE_LOW_STRUCTURE', 'PO_BREAKOUT_UP_STRUCTURE', 'PO_TREND_UP_STRUCTURE', 'PO_STALL_HIGH_STRUCTURE',
  'PO_BREAKDOWN_STRUCTURE', 'PO_TREND_DOWN_STRUCTURE', 'PO_SHARP_DROP_STRUCTURE', 'PO_RANGE_RECOVERY_STRUCTURE', 'PO_UNKNOWN'
]);

const n = v => (v === null || v === undefined ? null : Number(v));

// §4.4 stateConfidence：基础60（PRICE_ONLY_MODE结构性上限）+10(加分全满足)+10(e1/e4方向一致)-20(completeness<0.8)-15(非HEALTHY)，clamp[0,60]
function computeStateConfidence({ bonusMet, trendAligned, completeness, qualityState }) {
  let score = 60;
  if (bonusMet) score += 10;
  if (trendAligned) score += 10;
  if (!(Number.isFinite(completeness) && completeness >= 0.8)) score -= 20;
  if (qualityState !== 'HEALTHY') score -= 15;
  return Math.max(0, Math.min(60, score));
}

/**
 * inputs: 全部只读，来自V1.4B feature_records白名单字段 + bar-path-locator计算结果，不包含auxiliaryEvidence任何字段
 *  - close, closeToEma5, closeToEma10, closeToEma20, trend4h, trend1h, volumeRatio20,
 *    swingHigh, swingLow, breakoutState, upperWickRatio, lowerWickRatio,
 *    distanceToSupportAtr, distanceToResistanceAtr, falseBreakoutRisk,
 *    atr14FourHour（bar-path-locator计算，非feature_records.atr14）,
 *    qualityState, completeness,
 *    breakoutCount, breakdownCount（§8.3映射一，computeConsecutiveBreakoutBars结果，可能为null=INSUFFICIENT_DATA）,
 *    btcTrendState, ethBtcRollingCorrelation（§8.3映射四输入，仅通过btcAlignmentServer消费）,
 *    logReturn1（单bar对数收益率，PO_SHARP_DROP_STRUCTURE急跌幅度判定使用）
 */
export function evaluatePoState(inputs) {
  const { close, closeToEma5, trend4h, trend1h, volumeRatio20, swingHigh, swingLow, breakoutState,
    upperWickRatio, lowerWickRatio, distanceToSupportAtr, distanceToResistanceAtr, falseBreakoutRisk,
    atr14FourHour, qualityState, completeness, breakoutCount, breakdownCount, btcTrendState, ethBtcRollingCorrelation, logReturn1 } = inputs;

  const stateEvidence = [], opposingEvidence = [];
  const px = n(close);

  // 数据不足：4H ATR缺失或关键字段缺失时不猜测，直接INSUFFICIENT_DATA（区别于PO_UNKNOWN，见§4.2红线）
  if (!Number.isFinite(px) || !Number.isFinite(atr14FourHour) || atr14FourHour <= 0 || !Number.isFinite(n(swingHigh)) || !Number.isFinite(n(swingLow))) {
    return { proxyState: null, operatingMode: 'INSUFFICIENT_DATA', stateConfidence: 0, stateEvidence: ['[PRICE_ONLY] 关键结构字段缺失，无法判定'], opposingEvidence: [], poRuleVersion: PO_RULE_VERSION };
  }
  const trendAligned = trend4h && trend1h && trend4h === trend1h;
  const btcUp = btcAlignmentServer('up', btcTrendState, ethBtcRollingCorrelation);
  const btcDown = btcAlignmentServer('down', btcTrendState, ethBtcRollingCorrelation);

  // 突破/跌破否决条件（映射三）：当根拒绝证据
  const falseBreakoutVeto = isFalseBreakoutVetoed(falseBreakoutRisk);
  if (falseBreakoutVeto) opposingEvidence.push('[PRICE_ONLY] 当根出现假突破拒绝信号（未实现跨bar确认）');

  const dataInsufficientForCount = breakoutCount === null || breakdownCount === null;

  // PO_BREAKOUT_UP_STRUCTURE：breakoutState=='BREAKOUT_UP' 且 count∈{1,2}，无假突破否决
  if (!dataInsufficientForCount && breakoutState === 'BREAKOUT_UP' && breakoutCount >= 1 && breakoutCount <= 2 && !falseBreakoutVeto) {
    stateEvidence.push(`[PRICE_ONLY] 价格结构显示向上突破，已持续${breakoutCount}根4H K线`);
    return finalize('PO_BREAKOUT_UP_STRUCTURE', { bonusMet: volumeRatio20 >= 1.2 && btcUp === 'SUPPORT', trendAligned, completeness, qualityState, stateEvidence, opposingEvidence });
  }
  // PO_BREAKDOWN_STRUCTURE：对称
  if (!dataInsufficientForCount && breakoutState === 'BREAKOUT_DOWN' && breakdownCount >= 1 && breakdownCount <= 2 && !falseBreakoutVeto) {
    stateEvidence.push(`[PRICE_ONLY] 价格结构显示向下突破，已持续${breakdownCount}根4H K线`);
    return finalize('PO_BREAKDOWN_STRUCTURE', { bonusMet: volumeRatio20 >= 1.2 && btcDown === 'SUPPORT', trendAligned, completeness, qualityState, stateEvidence, opposingEvidence });
  }
  // PO_TREND_UP_STRUCTURE：trend4h='up' 且 count>=M(=3，见§8.3/§8.4)
  if (!dataInsufficientForCount && trend4h === 'up' && breakoutCount >= 3 && !falseBreakoutVeto) {
    stateEvidence.push('[PRICE_ONLY] 价格结构延续上行（连续突破根数已超过2根）');
    return finalize('PO_TREND_UP_STRUCTURE', { bonusMet: n(closeToEma5) > 0 && trend1h === 'up', trendAligned, completeness, qualityState, stateEvidence, opposingEvidence });
  }
  // PO_TREND_DOWN_STRUCTURE：对称
  if (!dataInsufficientForCount && trend4h === 'down' && breakdownCount >= 3 && !falseBreakoutVeto) {
    stateEvidence.push('[PRICE_ONLY] 价格结构延续下行（连续跌破根数已超过2根）');
    return finalize('PO_TREND_DOWN_STRUCTURE', { bonusMet: n(closeToEma5) < 0 && trend1h === 'down', trendAligned, completeness, qualityState, stateEvidence, opposingEvidence });
  }

  // PO_SHARP_DROP_STRUCTURE：单根4H急跌，§4.2原文绝对阈值语义：单根跌幅相对ATR达到3倍，且放量>=1.8（绝对阈值，非相对阈值，同GMKG§7.1极值判定原则）
  // logReturn1为单bar对数收益率，atr14FourHour/close换算为相对波幅，两者可比
  if (Number.isFinite(logReturn1) && Number.isFinite(px) && px > 0) {
    const relativeAtr = atr14FourHour / px;
    if (logReturn1 <= -3 * relativeAtr && volumeRatio20 >= 1.8) {
      stateEvidence.push('[PRICE_ONLY] 价格结构层面观察到急跌，未确认强平/杠杆出清');
      return finalize('PO_SHARP_DROP_STRUCTURE', { bonusMet: n(lowerWickRatio) > 0.3, trendAligned, completeness, qualityState, stateEvidence, opposingEvidence });
    }
  }

  // PO_RANGE_LOW_STRUCTURE：贴近支撑 且 trend4h∈{flat,down}
  if (isNearSupport(distanceToSupportAtr) && (trend4h === 'flat' || trend4h === 'down') && !(breakoutState === 'BREAKOUT_DOWN' && breakdownCount >= 2)) {
    stateEvidence.push('[PRICE_ONLY] 价格结构显示贴近支撑位，未确认破位');
    return finalize('PO_RANGE_LOW_STRUCTURE', { bonusMet: volumeRatio20 >= 0.8 && volumeRatio20 <= 1.2, trendAligned, completeness, qualityState, stateEvidence, opposingEvidence });
  }
  // PO_STALL_HIGH_STRUCTURE：贴近压力 且 之前为上行趋势（滞涨代理：closeToEma5<=0但trend4h仍非down）
  if (isNearResistance(distanceToResistanceAtr) && trend4h !== 'down' && n(closeToEma5) <= 0) {
    stateEvidence.push('[PRICE_ONLY] 价格结构显示高位滞涨，未创新高');
    return finalize('PO_STALL_HIGH_STRUCTURE', { bonusMet: volumeRatio20 < 1.0 && n(upperWickRatio) > 0.3, trendAligned, completeness, qualityState, stateEvidence, opposingEvidence });
  }
  // PO_RANGE_RECOVERY_STRUCTURE：波动收窄后的修复代理（无法直接得知"是否曾发生SHARP_DROP"跨快照状态，保守只用价格結構本身：trend4h='flat'且贴近支撑与压力之间）
  if (trend4h === 'flat' && !isNearSupport(distanceToSupportAtr) && !isNearResistance(distanceToResistanceAtr)) {
    stateEvidence.push('[PRICE_ONLY] 价格结构在区间内往复，无持续方向');
    return finalize('PO_RANGE_RECOVERY_STRUCTURE', { bonusMet: false, trendAligned, completeness, qualityState, stateEvidence, opposingEvidence });
  }

  return finalize('PO_UNKNOWN', { bonusMet: false, trendAligned, completeness, qualityState, stateEvidence: ['[PRICE_ONLY] 价格结构处于无法归类的过渡态'], opposingEvidence });
}

function finalize(proxyState, { bonusMet, trendAligned, completeness, qualityState, stateEvidence, opposingEvidence }) {
  return {
    proxyState, operatingMode: 'PRICE_ONLY_MODE',
    stateConfidence: computeStateConfidence({ bonusMet, trendAligned, completeness, qualityState }),
    stateEvidence, opposingEvidence, poRuleVersion: PO_RULE_VERSION
  };
}
