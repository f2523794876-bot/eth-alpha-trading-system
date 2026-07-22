// V1_4C_SCOPE_SPEC.md §4/§13 — ForecastSnapshot字段契约、predictionId、contentHash，纯函数，无storage参数
import { canonicalJsonHash } from '../domain/hash.js';
import { ALGORITHM_VERSION, WEIGHT_VERSION } from './forecast-version.js';
import { SOURCE_DATASET_VERSION, FEATURE_ALGORITHM_VERSION } from '../features/feature-version.js';

// §13.1：GMKG-SRV-前缀防止与浏览器端predictionId碰撞
export function buildPredictionId({ instrument, horizon, referenceCloseTime, algorithmVersion = ALGORITHM_VERSION }) {
  if (!instrument || (horizon !== '24h' && horizon !== '72h') || !Number.isSafeInteger(referenceCloseTime)) {
    throw Object.assign(new Error('Invalid prediction identity'), { code: 'PREDICTION_IDENTITY_INVALID' });
  }
  return `GMKG-SRV-${instrument}-${horizon}-${referenceCloseTime}-${algorithmVersion}`;
}

// §13.2：contentHash严格包括这7项，复用既有canonicalJsonHash
export function computeForecastContentHash({ predictionId, featureValuesUsed, algorithmVersion, weightVersion, datasetVersion, featureEngineVersion, scenarioWeights }) {
  return canonicalJsonHash({ predictionId, featureValuesUsed, algorithmVersion, weightVersion, datasetVersion, featureEngineVersion, scenarioWeights });
}

// §10.1情景权重归一化+舍入不变量：三项均为有限非负数，和恰好等于100，余差记入权重最大项
export function normalizeScenarioWeights({ baseline, upside, downside }) {
  const raw = [baseline, upside, downside];
  if (raw.some(v => !Number.isFinite(v) || v < 0)) throw Object.assign(new Error('Invalid scenario weights'), { code: 'SCENARIO_WEIGHTS_INVALID' });
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw Object.assign(new Error('Invalid scenario weights'), { code: 'SCENARIO_WEIGHTS_INVALID' });
  const scaled = raw.map(v => (v / sum) * 100);
  const rounded = scaled.map(v => Math.round(v));
  const diff = 100 - rounded.reduce((a, b) => a + b, 0);
  if (diff !== 0) { const maxIdx = rounded.indexOf(Math.max(...rounded)); rounded[maxIdx] += diff; }
  return { baseline: rounded[0], upside: rounded[1], downside: rounded[2] };
}

// §4 完整字段表结构性校验（不做业务规则判断，只做形状/红线核对）
export function validateForecastSnapshot(record) {
  const errors = [];
  const required = ['predictionId', 'instrument', 'horizon', 'generatedAt', 'dataCutoffTime', 'targetStartTime', 'targetEndTime', 'referencePrice',
    'referenceBarRef', 'targetBarRef', 'expectedBarCount', 'expectedDirection', 'directionThreshold', 'rawThreshold', 'thresholdFloor', 'thresholdCeiling',
    'thresholdFormulaVersion', 'atr14FourHourAtGeneration', 'targetStateAtGeneration', 'proxyStateAtGeneration', 'fusionStateAtGeneration',
    'candidateTrajectories', 'scenarioWeights', 'probabilityStatus', 'calibratedProbabilities', 'expectedPriceZones', 'triggerConditions',
    'invalidationConditions', 'algorithmVersion', 'weightVersion', 'datasetVersion', 'dataVintageRefs', 'featureValuesUsed', 'featureRecordIds',
    'featureEngineVersion', 'contentHash', 'auxiliaryEvidence'];
  for (const key of required) if (record[key] === undefined) errors.push(`MISSING_${key}`);
  if (record.targetStateAtGeneration !== 'UNKNOWN') errors.push('TARGET_STATE_MUST_BE_UNKNOWN');
  if (record.fusionStateAtGeneration !== 'UNKNOWN') errors.push('FUSION_STATE_MUST_BE_UNKNOWN');
  if (record.probabilityStatus !== 'rule_based') errors.push('PROBABILITY_STATUS_MUST_BE_RULE_BASED');
  if (record.calibratedProbabilities !== null) errors.push('CALIBRATED_PROBABILITIES_MUST_BE_NULL');
  const w = record.scenarioWeights || {};
  const sum = (w.baseline || 0) + (w.upside || 0) + (w.downside || 0);
  if (![w.baseline, w.upside, w.downside].every(v => Number.isFinite(v) && v >= 0) || sum !== 100) errors.push('SCENARIO_WEIGHTS_INVALID');
  if (record.directionThreshold < record.thresholdFloor || record.directionThreshold > record.thresholdCeiling) errors.push('DIRECTION_THRESHOLD_OUT_OF_CLAMP');
  if (record.expectedBarCount !== 96 && record.expectedBarCount !== 288) errors.push('EXPECTED_BAR_COUNT_INVALID');
  return Object.freeze({ ok: errors.length === 0, errors });
}

// V1_4_FORECAST_DATA_SPEC.md §7.3：情景区间冻结公式（唯一权威）
export function computeExpectedPriceZones(referencePrice, directionThreshold) {
  const t = directionThreshold;
  return {
    baseline: [referencePrice * (1 - 0.5 * t), referencePrice * (1 + 0.5 * t)],
    upside: [referencePrice * (1 + t), referencePrice * (1 + 2 * t)],
    downside: [referencePrice * (1 - 2 * t), referencePrice * (1 - t)]
  };
}

// 实施说明（判断依据非机械冻结表，非静默裁决）：V1_4_FORECAST_DATA_SPEC.md §7.4冻结了scenarioWeights的三档分组
// （UP偏向/DOWN偏向/RANGE偏向），但未单独给出expectedDirection的proxyState映射表。本实施复用同一分组作为
// expectedDirection的判定依据（同一份分组语义，不是新增业务规则），已在V1_4C_IMPLEMENTATION_REPORT.md中记录。
const UP_BIASED_STATES = new Set(['PO_BREAKOUT_UP_STRUCTURE', 'PO_TREND_UP_STRUCTURE']);
const DOWN_BIASED_STATES = new Set(['PO_BREAKDOWN_STRUCTURE', 'PO_TREND_DOWN_STRUCTURE', 'PO_SHARP_DROP_STRUCTURE']);
export function deriveExpectedDirection(proxyState) {
  if (UP_BIASED_STATES.has(proxyState)) return 'UP';
  if (DOWN_BIASED_STATES.has(proxyState)) return 'DOWN';
  return 'RANGE';
}

// V1_4_FORECAST_DATA_SPEC.md §7.4：初始规则型打分表 + stateConfidence<45时向{45,27,28}线性插值，唯一权威口径
const SCENARIO_SCORE_TABLE = Object.freeze({
  PO_BREAKOUT_UP_STRUCTURE: { baseline: 30, upside: 50, downside: 20 },
  PO_TREND_UP_STRUCTURE: { baseline: 30, upside: 50, downside: 20 },
  PO_BREAKDOWN_STRUCTURE: { baseline: 30, upside: 20, downside: 50 },
  PO_TREND_DOWN_STRUCTURE: { baseline: 30, upside: 20, downside: 50 },
  PO_RANGE_LOW_STRUCTURE: { baseline: 50, upside: 25, downside: 25 },
  PO_RANGE_RECOVERY_STRUCTURE: { baseline: 50, upside: 25, downside: 25 },
  PO_UNKNOWN: { baseline: 50, upside: 25, downside: 25 },
  PO_STALL_HIGH_STRUCTURE: { baseline: 35, upside: 25, downside: 40 },
  PO_SHARP_DROP_STRUCTURE: { baseline: 30, upside: 20, downside: 50 }
});
const LOW_CONFIDENCE_TARGET = Object.freeze({ baseline: 45, upside: 27, downside: 28 });
export function computeRawScenarioScore(proxyState, stateConfidence) {
  const table = SCENARIO_SCORE_TABLE[proxyState] || SCENARIO_SCORE_TABLE.PO_UNKNOWN;
  if (!(Number.isFinite(stateConfidence) && stateConfidence >= 45)) {
    const t = Number.isFinite(stateConfidence) ? Math.max(0, stateConfidence) / 45 : 0;
    return {
      baseline: table.baseline * t + LOW_CONFIDENCE_TARGET.baseline * (1 - t),
      upside: table.upside * t + LOW_CONFIDENCE_TARGET.upside * (1 - t),
      downside: table.downside * t + LOW_CONFIDENCE_TARGET.downside * (1 - t)
    };
  }
  return { ...table };
}

// V1_4_FORECAST_DATA_SPEC.md §7.5：模板化文本，不需要额外数据源
export function buildTriggerConditions(horizon) {
  return [`${horizon}目标窗口内，若15分钟已收盘价格突破upsideScenario.priceZone下沿，视为upside情景触发确认`];
}
export function buildInvalidationConditions(horizon) {
  return [`若${horizon}目标窗口内已收盘价格跌破downsideScenario.priceZone上沿，视为baseline/upside情景证据减弱`];
}

export function finalizeForecastSnapshot(input) {
  const algorithmVersion = input.algorithmVersion || ALGORITHM_VERSION;
  const weightVersion = input.weightVersion || WEIGHT_VERSION;
  const datasetVersion = input.datasetVersion || SOURCE_DATASET_VERSION;
  const featureEngineVersion = input.featureEngineVersion || FEATURE_ALGORITHM_VERSION;
  const predictionId = buildPredictionId({ instrument: input.instrument, horizon: input.horizon, referenceCloseTime: input.referenceBarRef.closeTime, algorithmVersion });
  const scenarioWeights = normalizeScenarioWeights(input.scenarioWeights);
  const contentHash = computeForecastContentHash({ predictionId, featureValuesUsed: input.featureValuesUsed, algorithmVersion, weightVersion, datasetVersion, featureEngineVersion, scenarioWeights });
  const record = Object.freeze({
    ...input, predictionId, algorithmVersion, weightVersion, datasetVersion, featureEngineVersion, scenarioWeights, contentHash,
    targetStateAtGeneration: 'UNKNOWN', fusionStateAtGeneration: 'UNKNOWN', probabilityStatus: 'rule_based', calibratedProbabilities: null
  });
  const validation = validateForecastSnapshot(record);
  if (!validation.ok) throw Object.assign(new Error('Forecast snapshot contract rejected'), { code: 'FORECAST_CONTRACT_REJECTED', reasons: validation.errors });
  return record;
}
