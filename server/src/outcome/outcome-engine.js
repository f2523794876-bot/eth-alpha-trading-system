// GMKG_DRAGONFLY_ARCHITECTURE.md §10.1/§10.3/§10.4/§10.4a/§10.5 — ForecastOutcomeEvent纯计算，无storage参数
// 唯一权威公式来源；V1_4C_SCOPE_SPEC.md §5只新增sourceOrigin字段，不重定义其余字段取值规则。
import { classifyDirection } from '../forecast/threshold-formula.js';

export function computeExpectedEnvelope(expectedPriceZones) {
  const zones = [expectedPriceZones.baseline, expectedPriceZones.upside, expectedPriceZones.downside];
  const lower = Math.min(...zones.map(z => z[0]));
  const upper = Math.max(...zones.map(z => z[1]));
  return { lower, upper };
}

const inZone = (price, zone) => Number.isFinite(price) && price >= zone[0] && price <= zone[1];

// 实施说明（判断依据非机械公式，非静默裁决）：V1_4_FORECAST_DATA_SPEC.md §7.5将invalidationConditions定义为
// 模板化文本（如"若价格跌破downside区间上沿，视为看涨证据减弱"），GMKG架构文档未冻结invalidationTriggered的
// 逐字段机器可判定公式。本实施采用与该模板文本语义一致、可复现的判定：UP预测下，路径最低价跌破downside区间
// 下沿视为触发；DOWN预测下，路径最高价突破upside区间上沿视为触发；RANGE预测下，rangeBreachExcursion>0视为触发
// （已经是§10.4冻结公式的直接推论，不是新增判断）。已在V1_4C_IMPLEMENTATION_REPORT.md中记录为需求解释判断。
function computeInvalidationTriggered({ expectedDirection, actualHigh, actualLow, expectedPriceZones, rangeBreachExcursion }) {
  if (expectedDirection === 'UP') return actualLow < expectedPriceZones.downside[0];
  if (expectedDirection === 'DOWN') return actualHigh > expectedPriceZones.upside[1];
  return rangeBreachExcursion > 0;
}

/**
 * snapshot: 只读引用ForecastSnapshot冻结字段（referencePrice/expectedDirection/directionThreshold/expectedPriceZones），
 *   本函数不得、也不会修改snapshot任何字段（GMKG §10.1 P0-2红线）。
 * located: bar-path-locator.js locatePathForEvaluation() 的原始返回值。
 */
export function computeForecastOutcome({ snapshot, located }) {
  const { referenceBarRef, targetBarRef, observedBars, missingBarRefs, endpointDataComplete, pathDataComplete,
    pathEligibleForStatistics, directionEligibleForStatistics, actualStartPrice, actualEndPrice, actualHigh, actualLow,
    exclusionReasons } = located;

  const actualReturn = (actualStartPrice != null && actualEndPrice != null && endpointDataComplete)
    ? (actualEndPrice - snapshot.referencePrice) / snapshot.referencePrice : null;
  const actualDirection = (actualReturn != null) ? classifyDirection(actualReturn, snapshot.directionThreshold) : null;
  const directionCorrect = directionEligibleForStatistics ? (actualDirection === snapshot.expectedDirection) : null;

  const envelope = computeExpectedEnvelope(snapshot.expectedPriceZones);
  const endpointInBaselineZone = endpointDataComplete ? inZone(actualEndPrice, snapshot.expectedPriceZones.baseline) : null;
  const endpointInAnyScenarioZone = endpointDataComplete
    ? (inZone(actualEndPrice, snapshot.expectedPriceZones.baseline) || inZone(actualEndPrice, snapshot.expectedPriceZones.upside) || inZone(actualEndPrice, snapshot.expectedPriceZones.downside))
    : null;
  const realizedRangeInsideExpectedEnvelope = pathEligibleForStatistics ? (actualLow >= envelope.lower && actualHigh <= envelope.upper) : null;
  const expectedEnvelopeTouched = pathEligibleForStatistics ? !(actualHigh < envelope.lower || actualLow > envelope.upper) : null;

  let mfe = null, mae = null, upperExcursion = null, lowerExcursion = null, maxAbsoluteExcursion = null, rangeBreachExcursion = null;
  if (pathEligibleForStatistics) {
    const referencePrice = snapshot.referencePrice;
    if (snapshot.expectedDirection === 'UP') {
      mfe = (actualHigh - referencePrice) / referencePrice;
      mae = (referencePrice - actualLow) / referencePrice;
    } else if (snapshot.expectedDirection === 'DOWN') {
      mfe = (referencePrice - actualLow) / referencePrice;
      mae = (actualHigh - referencePrice) / referencePrice;
    } else {
      upperExcursion = (actualHigh - referencePrice) / referencePrice;
      lowerExcursion = (referencePrice - actualLow) / referencePrice;
      maxAbsoluteExcursion = Math.max(upperExcursion, lowerExcursion);
      rangeBreachExcursion = Math.max(0, maxAbsoluteExcursion - snapshot.directionThreshold);
    }
  }

  const invalidationTriggered = pathEligibleForStatistics
    ? computeInvalidationTriggered({ expectedDirection: snapshot.expectedDirection, actualHigh, actualLow, expectedPriceZones: snapshot.expectedPriceZones, rangeBreachExcursion })
    : null;

  return Object.freeze({
    predictionId: snapshot.predictionId,
    actualStartPrice, actualEndPrice, actualReturn, actualDirection, directionCorrect,
    endpointInBaselineZone, endpointInAnyScenarioZone, realizedRangeInsideExpectedEnvelope, expectedEnvelopeTouched,
    actualHigh: pathEligibleForStatistics ? actualHigh : null, actualLow: pathEligibleForStatistics ? actualLow : null,
    mfe, mae, upperExcursion, lowerExcursion, maxAbsoluteExcursion, rangeBreachExcursion, invalidationTriggered,
    expectedBarCount: snapshot.expectedBarCount, observedBarCount: observedBars.length, missingBarRefs,
    endpointDataComplete, pathDataComplete, pathEligibleForStatistics, directionEligibleForStatistics,
    exclusionReasons, referenceBarRef, targetBarRef, sourceOrigin: 'SERVER'
  });
}
