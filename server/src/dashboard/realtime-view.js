// 实时看板 View Model——纯函数，无I/O，无副作用。产品红线（不可违反）：
//   不能入场 ≠ 没有方向预测；交易许可 ≠ 行情方向预测。
// 本模块只负责"实时市场状态"与"方向预测（UP/DOWN/RANGE）"两层的字段映射，
// 严格不产生、不判断展示态参考执行状态（见同目录reference-execution-state.js，两者互不依赖）。
//
// 字段全部来自已存在的真实数据（server/src/db/postgres.js的latestBars/latestProvisionalBar/
// latestForecastSnapshot，底层分别读market_bars/provisional_market_bars/forecast_snapshots），
// 不臆造、不用0代替缺失、不编造概率或目标位——任何真实数据缺失的字段，输出显式状态字符串
// （INSUFFICIENT_DATA/NOT_YET_GENERATED等），由调用方（前端）据此渲染"数据不足"/"尚未生成"。
import { INTERVAL_MS } from '../domain/constants.js';

const PREVIOUS_CLOSED_CANDLE_BASIS = 'PREVIOUS_CLOSED_15M_CANDLE';
const MARKET_STATE_INTERVAL = '15m';

// P1-1修复（独立复审）：provisional_market_bars是"只追加"表——同一open_time的进行中K线会随采集轮询
// （collector/service.js每30秒一次）反复插入新快照，历史遗留、尚未被促升（promoted_market_bar_id仍为
// NULL）的旧快照会一直留在表里。repository.latestProvisionalBar()只按open_time/fetched_at倒序取一条，
// 本身不判断"新鲜"——如果调用方不做二次校验，一条数小时前的陈旧快照会被直接当成"当前进行中K线"展示为
// LIVE，这是错误的实时行情表达。以下判定统一收敛在View Model层（Repository继续只负责返回候选行，
// 不掺入新鲜度业务判断），Postgres/Memory两种Repository实现无需各自重复这套逻辑。
//
// 90秒 = 3 × collector 30秒采集轮询间隔——与domain/constants.js FRESHNESS_POLICY.graceMultiplier=3
// 同一保守倍数原则（"3次轮询都没等到新数据，视为异常"），不是任意选取的数字；由测试固定，不得放宽。
export const PROVISIONAL_MAX_AGE_MS = 90_000;

function assessProvisionalFreshness({ currentBar, referenceBar, now }) {
  if (!currentBar) return { fresh: false, reason: 'NO_PROVISIONAL_DATA' };
  const { openTime, fetchedAt } = currentBar;
  if (![openTime, fetchedAt, now].every(Number.isFinite)) return { fresh: false, reason: 'INVALID_TIME_FIELD' };
  if (fetchedAt > now) return { fresh: false, reason: 'FUTURE_TIMESTAMP' };
  if (now - fetchedAt > PROVISIONAL_MAX_AGE_MS) return { fresh: false, reason: 'PROVISIONAL_EXPIRED' };
  const currentBucketOpenTime = Math.floor(now / INTERVAL_MS[MARKET_STATE_INTERVAL]) * INTERVAL_MS[MARKET_STATE_INTERVAL];
  if (openTime !== currentBucketOpenTime) return { fresh: false, reason: 'PERIOD_MISMATCH' };
  if (referenceBar && !(openTime > referenceBar.closeTime)) return { fresh: false, reason: 'NOT_NEWER_THAN_REFERENCE' };
  return { fresh: true, reason: null };
}

// currentBar: repository.latestProvisionalBar()结果（进行中K线的最新候选快照，未经新鲜度过滤）或null。
// referenceBar: repository.latestBars({limit:1})[0]（最近一根已完成K线）或null——这是涨跌的唯一比较基准，
// 明确、权威、不臆造（"相对上一根已完成15m K线收盘价"）。
// dataHealthy: collector.readiness().ok——collector自身报告不健康时，即使provisional时间戳看起来新鲜，
// 也不得继续标为LIVE（红线要求5：不得用旧数据在健康检查异常时冒充实时）。
export function buildMarketState({ instrument, currentBar, referenceBar, now, dataHealthy = true }) {
  const freshness = assessProvisionalFreshness({ currentBar, referenceBar, now });
  const usableLive = freshness.fresh && dataHealthy !== false;
  const staleness = currentBar && !usableLive
    ? { reason: dataHealthy === false ? 'DATA_HEALTH_DEGRADED' : freshness.reason, provisionalFetchedAt: currentBar.fetchedAt ?? null }
    : null;

  if (!referenceBar && !usableLive) {
    // 既没有可回退的已完成K线，进行中快照又不可信（缺失/过期/周期不匹配/健康检查未通过）——
    // 彻底无法给出价格，必须显式数据不足，不得伪装。
    return {
      instrument, status: 'INSUFFICIENT_DATA', price: null, priceSource: null, dataTime: null,
      changeAbs: null, changePct: null, changeBasis: null, momentum: 'INSUFFICIENT_DATA', staleness
    };
  }

  // usableLive时用进行中K线价格；否则安全回退到最近已完成K线（如果存在）——不得冒充为live tick。
  const price = usableLive ? currentBar.close : (referenceBar ? referenceBar.close : null);
  const priceSource = usableLive ? 'LIVE_PROVISIONAL_CANDLE' : (referenceBar ? 'LAST_CLOSED_CANDLE' : null);
  const dataTime = usableLive ? currentBar.fetchedAt : (referenceBar ? referenceBar.closeTime : null);
  const changeAbs = referenceBar != null ? price - referenceBar.close : null;
  const changePct = referenceBar && referenceBar.close !== 0 ? changeAbs / referenceBar.close : null;
  const changeBasis = referenceBar ? { type: PREVIOUS_CLOSED_CANDLE_BASIS, closeTime: referenceBar.closeTime, closePrice: referenceBar.close } : null;
  // STALE_PROVISIONAL_FALLBACK：确实存在一条进行中快照候选，但未通过新鲜度/健康校验，已安全回退到
  // 最近已完成K线——与"根本没有进行中快照"（LAST_CLOSED_ONLY）区分，便于前端展示"实时数据已过期"而不是
  // 笼统地什么都不说。
  const status = usableLive ? 'LIVE' : (referenceBar ? (currentBar ? 'STALE_PROVISIONAL_FALLBACK' : 'LAST_CLOSED_ONLY') : 'INSUFFICIENT_DATA');

  return {
    instrument, status, price, priceSource, dataTime, changeAbs, changePct, changeBasis,
    // 仓库当前不存在任何"变化速度/动量"的既有计算逻辑（审计已核实）——如实显示数据不足，不发明新公式冒充模型输出。
    momentum: 'INSUFFICIENT_DATA',
    staleness
  };
}

function zonePct(zone, referencePrice) {
  if (!Array.isArray(zone) || zone.length !== 2 || !(referencePrice > 0)) return null;
  return [ (zone[0] - referencePrice) / referencePrice, (zone[1] - referencePrice) / referencePrice ];
}

// snapshot: repository.latestForecastSnapshot({instrument,horizon})结果或null。
// 三向概率（scenario_weight_baseline/upside/downside）与三向目标区间（expected_price_zones.baseline/
// upside/downside）在forecast_snapshots的每一行都必然同时存在（forecast-contract.js冻结公式，
// DB CHECK约束三者之和恒为100）——这是系统真实产出的完整UP/DOWN/RANGE分布，不是只有单一主方向。
//
// 触发/失效条件目前只有一套面向"上行"的模板文本（trigger_conditions=突破上沿确认上行，
// invalidation_conditions=跌破下沿则上行证据减弱），后端从未生成对称的空头触发/失效模板。
// 因此down.triggerCondition/down.invalidationCondition与range的两个字段如实标注NOT_YET_GENERATED，
// 不得用up侧文本改写或推测出对称文案（那是编造，不是复用真实数据）。
export function buildDirectionForecast({ horizon, snapshot, now }) {
  if (!snapshot) {
    return { horizon, status: 'NOT_YET_GENERATED', predictionId: null, generatedAt: null, targetEndTime: null, referencePrice: null, probabilityStatus: null, up: null, down: null, range: null };
  }
  const expired = Number.isFinite(now) && now > snapshot.targetEndTime;
  const zones = snapshot.expectedPriceZones || {};
  const weights = snapshot.scenarioWeights || {};
  const upTrigger = Array.isArray(snapshot.triggerConditions) && snapshot.triggerConditions.length ? snapshot.triggerConditions[0] : null;
  const upInvalidation = Array.isArray(snapshot.invalidationConditions) && snapshot.invalidationConditions.length ? snapshot.invalidationConditions[0] : null;
  return {
    horizon,
    status: expired ? 'EXPIRED_AWAITING_NEXT_GENERATION' : 'ACTIVE',
    predictionId: snapshot.predictionId,
    generatedAt: snapshot.generatedAt,
    targetEndTime: snapshot.targetEndTime,
    referencePrice: snapshot.referencePrice,
    probabilityStatus: snapshot.probabilityStatus,
    up: {
      probabilityPct: weights.upside ?? null,
      targetZone: zones.upside ?? null,
      expectedMovePct: zonePct(zones.upside, snapshot.referencePrice),
      triggerCondition: upTrigger ?? 'NOT_YET_GENERATED',
      invalidationCondition: upInvalidation ?? 'NOT_YET_GENERATED'
    },
    down: {
      probabilityPct: weights.downside ?? null,
      targetZone: zones.downside ?? null,
      expectedMovePct: zonePct(zones.downside, snapshot.referencePrice),
      triggerCondition: 'NOT_YET_GENERATED',
      invalidationCondition: 'NOT_YET_GENERATED'
    },
    range: {
      probabilityPct: weights.baseline ?? null,
      upperBound: Array.isArray(zones.baseline) ? zones.baseline[1] ?? null : null,
      lowerBound: Array.isArray(zones.baseline) ? zones.baseline[0] ?? null : null,
      triggerCondition: 'NOT_YET_GENERATED',
      invalidationCondition: 'NOT_YET_GENERATED'
    }
  };
}
