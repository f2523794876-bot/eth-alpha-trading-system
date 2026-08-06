// 实时看板组装层：把repository/collector的只读查询结果喂给纯函数view model（realtime-view.js/
// trading-permission.js），拼成一份API响应。本函数只调用repository的读方法（latestBars/
// latestProvisionalBar/latestForecastSnapshot）与collector.readiness()，不调用任何写方法，
// 不触发ForecastGenerator/CollectorService的采集或生成逻辑——刷新本接口不会新增market_bars/
// provisional_market_bars/forecast_snapshots的任何行，24H/72H预测仍完全服从现有冻结的生成节奏。
import { buildMarketState, buildDirectionForecast } from './realtime-view.js';
import { deriveTradingPermission } from './trading-permission.js';

export async function buildRealtimeDashboard({ repository, collector, instrument, marketType = 'spot', interval = '15m', now = Date.now }) {
  const nowMs = now();
  const [readiness, recentBars, currentBar, snapshot24h, snapshot72h] = await Promise.all([
    collector.readiness(),
    repository.latestBars({ instrument, marketType, interval, limit: 1 }),
    repository.latestProvisionalBar({ instrument, marketType, interval }),
    repository.latestForecastSnapshot({ instrument, horizon: '24h' }),
    repository.latestForecastSnapshot({ instrument, horizon: '72h' })
  ]);

  const referenceBar = recentBars[0] || null;
  const marketState = buildMarketState({ instrument, currentBar, referenceBar, now: nowMs });
  const forecast24h = buildDirectionForecast({ horizon: '24h', snapshot: snapshot24h, now: nowMs });
  const forecast72h = buildDirectionForecast({ horizon: '72h', snapshot: snapshot72h, now: nowMs });
  const tradingPermission = deriveTradingPermission({ dataHealthy: !!readiness?.ok, marketState, forecast24h, forecast72h });

  return {
    instrument,
    generatedAt: nowMs,
    dataHealth: { ok: !!readiness?.ok, status: readiness?.status || 'UNKNOWN', checks: readiness?.checks || null },
    marketState,
    forecast24h,
    forecast72h,
    tradingPermission
  };
}
