// 实时看板组装层：把repository/collector的只读查询结果喂给纯函数view model（realtime-view.js/
// reference-execution-state.js），拼成一份API响应。本函数只调用repository的读方法（latestBars/
// latestProvisionalBar/latestForecastSnapshot）与collector.readiness()，不调用任何写方法，
// 不触发ForecastGenerator/CollectorService的采集或生成逻辑——刷新本接口不会新增market_bars/
// provisional_market_bars/forecast_snapshots的任何行，24H/72H预测仍完全服从现有冻结的生成节奏。
import { buildMarketState, buildDirectionForecast } from './realtime-view.js';
import { deriveReferenceExecutionState } from './reference-execution-state.js';

export async function buildRealtimeDashboard({ repository, collector, instrument, marketType = 'spot', interval = '15m', now = Date.now }) {
  const nowMs = now();
  const [readiness, recentBars, currentBar, snapshot24h, snapshot72h] = await Promise.all([
    collector.readiness(),
    repository.latestBars({ instrument, marketType, interval, limit: 1 }),
    repository.latestProvisionalBar({ instrument, marketType, interval }),
    repository.latestForecastSnapshot({ instrument, horizon: '24h' }),
    repository.latestForecastSnapshot({ instrument, horizon: '72h' })
  ]);

  const dataHealthy = !!readiness?.ok;
  const referenceBar = recentBars[0] || null;
  // P1-1：把collector健康信号一并传给View Model——不健康时即使provisional时间戳看起来新鲜，也不得标为LIVE。
  const marketState = buildMarketState({ instrument, currentBar, referenceBar, now: nowMs, dataHealthy });
  const forecast24h = buildDirectionForecast({ horizon: '24h', snapshot: snapshot24h, now: nowMs });
  const forecast72h = buildDirectionForecast({ horizon: '72h', snapshot: snapshot72h, now: nowMs });
  // P1-3：字段更名为referenceExecutionState（展示态参考执行状态），不再使用容易被误解为正式
  // 交易许可引擎的"tradingPermission"命名；disclosure字段由reference-execution-state.js原样提供，
  // API/页面不得省略。
  const referenceExecutionState = deriveReferenceExecutionState({ dataHealthy, marketState, forecast24h, forecast72h });

  return {
    instrument,
    generatedAt: nowMs,
    dataHealth: { ok: dataHealthy, status: readiness?.status || 'UNKNOWN', checks: readiness?.checks || null },
    marketState,
    forecast24h,
    forecast72h,
    referenceExecutionState
  };
}
