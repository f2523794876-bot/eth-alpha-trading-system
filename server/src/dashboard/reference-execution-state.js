// P1-3修复（独立复审）：展示态参考执行状态——不是正式交易许可引擎。
//
// 命名澄清：此前字段名`tradingPermission`容易让人误以为是经过正式研究验证的交易许可决策能力。
// 本模块只产生一个"仅供展示参考"的保守状态标签，API/页面必须原样透出`disclosure`说明，不得省略。
//
// 与V1_4D_HISTORICAL_REPLAY_SPEC.md §2.3 / V1_4D_ACCEPTANCE_TESTS.md R20.1-R20.3红线定义的
// `ActionPermission`研究字段完全无关且不冲突：本模块不读写historical_validation schema任何表，
// 不在server/src/validation-replay/report-builder.js或research-scorecard.js的回放评估管线中出现，
// 计算结果从不写入任何表（纯函数，仅供API响应临时组装），只服务于本轮新增的实时看板展示。
// R20红线保护的是"离线回放研究评估"的诚实性，不是禁止系统任何位置展示一个仅供参考的状态标签。
//
// 判定完全基于系统当前真实、可验证的能力边界，不发明新的交易策略：
// forecast_snapshots.probability_status列有DB CHECK硬约束恒为'rule_based'，calibrated_probabilities
// 列同样被CHECK约束恒为NULL（server/migrations/004_v1_4c_forecast_engine.up.sql，
// forecast-contract.js:44-45）——即本系统从未产生过统计校准概率。因此本函数的状态上限恒为OBSERVE：
// ALLOW/PREPARE两档保留在枚举中以保持接口契约稳定（供未来真正接入校准模型、且产品决定将其升级为
// 正式许可引擎后启用），但当前实现下不可达，reason字段如实说明"为什么当前不可达"而不是略去或
// 伪造更高置信度。生产数据路径必须继续保持这一上限，不得因渲染/命名调整而放宽。
export const REFERENCE_EXECUTION_STATE_MODES = Object.freeze(['ALLOW', 'PREPARE', 'OBSERVE', 'BLOCK']);

const DISCLOSURE = '展示态参考执行状态，非正式交易许可引擎；不产生、不替代、不覆盖上方多头/空头/RANGE方向预测。';

export function deriveReferenceExecutionState({ dataHealthy, marketState, forecast24h, forecast72h }) {
  if (!dataHealthy) {
    return { mode: 'BLOCK', reason: 'DATA_HEALTH_DEGRADED', detail: '数据源健康检查未通过，暂停给出参考执行状态（方向预测仍在下方独立展示）', disclosure: DISCLOSURE };
  }
  if (!marketState || marketState.status === 'INSUFFICIENT_DATA') {
    return { mode: 'BLOCK', reason: 'MARKET_STATE_UNAVAILABLE', detail: '当前价格数据不足，无法评估执行条件（方向预测仍在下方独立展示）', disclosure: DISCLOSURE };
  }
  const anyForecastActive = [forecast24h, forecast72h].some(f => f?.status === 'ACTIVE');
  if (!anyForecastActive) {
    return { mode: 'BLOCK', reason: 'NO_ACTIVE_FORECAST', detail: '24H/72H预测均不可用或已过期，等待下一次正式生成（数据不足即如实展示，不代替方向判断）', disclosure: DISCLOSURE };
  }
  return {
    mode: 'OBSERVE',
    reason: 'RULE_BASED_PROBABILITY_ONLY',
    detail: '当前系统仅提供规则型情景权重（probability_status=rule_based），从未产生统计校准概率，建议观察、暂不建议直接执行（多头/空头/RANGE预测仍完整展示于下方，不因此状态被隐藏）',
    disclosure: DISCLOSURE
  };
}
