// 展示态、非持久化、按需派生的交易许可指示器。
//
// 与V1_4D_HISTORICAL_REPLAY_SPEC.md §2.3 / V1_4D_ACCEPTANCE_TESTS.md R20.1-R20.3红线定义的
// `ActionPermission`研究字段完全无关且不冲突：本模块不读写historical_validation schema任何表，
// 不在server/src/validation-replay/report-builder.js或research-scorecard.js的回放评估管线中出现，
// 计算结果从不写入任何表（纯函数，仅供API响应临时组装），只服务于本轮新增的实时看板展示。
// R20红线保护的是"离线回放研究评估"的诚实性，不是禁止系统任何位置展示一个仅供参考的许可态。
//
// 判定完全基于系统当前真实、可验证的能力边界，不发明新的交易策略：
// forecast_snapshots.probability_status列有DB CHECK硬约束恒为'rule_based'，calibrated_probabilities
// 列同样被CHECK约束恒为NULL（server/migrations/004_v1_4c_forecast_engine.up.sql，
// forecast-contract.js:44-45）——即本系统从未产生过统计校准概率。因此本函数的许可上限恒为OBSERVE：
// ALLOW/PREPARE两档保留在枚举中以保持接口契约稳定（供未来真正接入校准模型后启用），
// 但当前实现下不可达，reason字段如实说明"为什么当前不可达"而不是略去或伪造更高置信度。
export const TRADING_PERMISSION_MODES = Object.freeze(['ALLOW', 'PREPARE', 'OBSERVE', 'BLOCK']);

export function deriveTradingPermission({ dataHealthy, marketState, forecast24h, forecast72h }) {
  if (!dataHealthy) {
    return { mode: 'BLOCK', reason: 'DATA_HEALTH_DEGRADED', detail: '数据源健康检查未通过，暂停给出交易许可判断（方向预测仍在下方独立展示）' };
  }
  if (!marketState || marketState.status === 'INSUFFICIENT_DATA') {
    return { mode: 'BLOCK', reason: 'MARKET_STATE_UNAVAILABLE', detail: '当前价格数据不足，无法评估执行条件（方向预测仍在下方独立展示）' };
  }
  const anyForecastActive = [forecast24h, forecast72h].some(f => f?.status === 'ACTIVE');
  if (!anyForecastActive) {
    return { mode: 'BLOCK', reason: 'NO_ACTIVE_FORECAST', detail: '24H/72H预测均不可用或已过期，等待下一次正式生成（数据不足即如实展示，不代替方向判断）' };
  }
  return {
    mode: 'OBSERVE',
    reason: 'RULE_BASED_PROBABILITY_ONLY',
    detail: '当前系统仅提供规则型情景权重（probability_status=rule_based），从未产生统计校准概率，建议观察、暂不建议直接执行（多头/空头/RANGE预测仍完整展示于下方，不因此许可状态被隐藏）'
  };
}
