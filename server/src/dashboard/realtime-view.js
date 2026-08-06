// 实时看板 View Model——纯函数，无I/O，无副作用。产品红线（不可违反）：
//   不能入场 ≠ 没有方向预测；交易许可 ≠ 行情方向预测。
// 本模块只负责"实时市场状态"与"方向预测（UP/DOWN/RANGE）"两层的字段映射，
// 严格不产生、不判断交易许可（见同目录trading-permission.js，两者互不依赖）。
//
// 字段全部来自已存在的真实数据（server/src/db/postgres.js的latestBars/latestProvisionalBar/
// latestForecastSnapshot，底层分别读market_bars/provisional_market_bars/forecast_snapshots），
// 不臆造、不用0代替缺失、不编造概率或目标位——任何真实数据缺失的字段，输出显式状态字符串
// （INSUFFICIENT_DATA/NOT_YET_GENERATED等），由调用方（前端）据此渲染"数据不足"/"尚未生成"。

const PREVIOUS_CLOSED_CANDLE_BASIS = 'PREVIOUS_CLOSED_15M_CANDLE';

// currentBar: repository.latestProvisionalBar()结果（进行中K线的最新快照）或null。
// referenceBar: repository.latestBars({limit:1})[0]（最近一根已完成K线）或null——这是涨跌的唯一比较基准，
// 明确、权威、不臆造（"相对上一根已完成15m K线收盘价"）。
export function buildMarketState({ instrument, currentBar, referenceBar, now }) {
  if (!referenceBar) {
    return {
      instrument, status: 'INSUFFICIENT_DATA', price: null, priceSource: null, dataTime: null,
      changeAbs: null, changePct: null, changeBasis: null, momentum: 'INSUFFICIENT_DATA'
    };
  }
  // 没有进行中K线快照时（采集尚未捕获到当前bucket，或健康检查未通过），仍可基于最近一根已完成K线
  // 显示价格——但必须如实标注来源是"最近已完成K线"而不是"实时"，不得冒充为live tick。
  const price = currentBar ? currentBar.close : referenceBar.close;
  const priceSource = currentBar ? 'LIVE_PROVISIONAL_CANDLE' : 'LAST_CLOSED_CANDLE';
  const dataTime = currentBar ? currentBar.fetchedAt : referenceBar.closeTime;
  const changeAbs = price - referenceBar.close;
  const changePct = referenceBar.close !== 0 ? changeAbs / referenceBar.close : null;
  return {
    instrument,
    status: currentBar ? 'LIVE' : 'LAST_CLOSED_ONLY',
    price, priceSource, dataTime,
    changeAbs, changePct,
    changeBasis: { type: PREVIOUS_CLOSED_CANDLE_BASIS, closeTime: referenceBar.closeTime, closePrice: referenceBar.close },
    // 仓库当前不存在任何"变化速度/动量"的既有计算逻辑（审计已核实）——如实显示数据不足，不发明新公式冒充模型输出。
    momentum: 'INSUFFICIENT_DATA'
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
