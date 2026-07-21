// V1_4C_SCOPE_SPEC.md §13.3 — 五个独立版本号，各自独立递增，逻辑不变只调数值时只递增对应细分版本号
export const ALGORITHM_VERSION = 'v1.4c-server-po-rule-1';           // §4 predictionId/contentHash，PO_状态判定逻辑本身
export const WEIGHT_VERSION = 'v1.4c-server-weight-1';                // scenarioWeights计算规则
export const THRESHOLD_FORMULA_VERSION = 'v1.4c-threshold-formula-2'; // §4.1，本轮修正4H ATR14取数深度(15根)后的版本
export const BAR_COUNT_LOOKBACK_VERSION = 'v1.4c-bar-count-lookback-1'; // §8.3映射一，M=3回放深度
export const BTC_ALIGNMENT_FORMULA_VERSION = 'v1.4c-btc-alignment-2';  // §8.3映射四，本轮修正带符号相关性后的版本
export const EVALUATION_VERSION = 'v1.4c-outcome-evaluation-1';        // ForecastOutcomeEvent评估逻辑本身
export const PO_RULE_VERSION = 'v1.4c-po-rule-1';                      // 9个PO_状态判定逻辑本身（独立于ALGORITHM_VERSION的细分标注，供日志/审计引用）
