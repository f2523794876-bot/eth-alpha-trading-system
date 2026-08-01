// V1_4D_DATA_BACKFILL_SPEC.md §2.9 / V1_4D_HISTORICAL_REPLAY_SPEC.md §4.7：researchAvailability常量与
// research_data_vintage审计证据构造。
//
// P0-3修复（独立复审）：本文件此前还导出一个"查询包装函数"，用正则表达式在运行时改写
// bar-path-locator.js 产出的生产SQL文本——该包装函数已整体删除。研究查询的物理独立实现见
// server/src/validation-replay/replay-bar-path-queries.js（每个函数拥有自己独立书写的SQL，不改写、
// 不导入生产SQL文本），本文件只保留与SQL无关的常量与纯函数。
//
// researchAvailability(bar) = bar.close_time —— FROZEN_POLICY，回放专用反事实假设，不是生产系统当时真实获得
// 数据的时间。只存在于回放查询层，绝不写回 market_bars.available_at；bar-path-locator.js 本身不做任何修改
// （§4.7冻结要求）。

export const RESEARCH_AVAILABILITY_RULE_VERSION = 'v1.4d-research-availability-1';

// V1_4D_HISTORICAL_REPLAY_SPEC.md §2.3/§2.5冻结要求：每条replay_snapshots/replay_outcome_events记录必须携带
// research_data_vintage，显式声明"本记录基于researchAvailability(=close_time)假设生成，不代表系统历史上
// 真实持有此数据"——这是该记录合法性的完整审计证据链。
//
// P1-1修复（独立复审）：此前consumedBars只保存{barKey, closeTime}两个字段。本函数现在接收
// replay-bar-path-queries.js各函数返回的完整auditRecords（每条含vintageId/symbol/interval/openTime/
// closeTime/availableAt/fetchedAt/sourceId/revisionNumber），按vintageId去重后原样落入consumedBars——
// vintageId是market_bars表上UNIQUE约束的那一列，是"这一条具体版本的K线"的权威身份证据。只有真正参与过
// DB查询、拿到过真实行的bar才会出现在auditRecords里（缺口/未来占位BarRef从不出现在这里，见
// replay-bar-path-queries.js对missingBarRefs与auditRecords的区分），故不会为"未实际消费"的K线错误生成审计行。
export function buildResearchDataVintage({ auditRecords = [], backfillBatchIds = [], asOfTime }) {
  const requiredFields = Object.freeze([
    'vintageId', 'symbol', 'interval', 'openTime', 'closeTime',
    'availableAt', 'fetchedAt', 'sourceId', 'revisionNumber'
  ]);
  const seen = new Map();
  for (const record of auditRecords) {
    const missing = requiredFields.filter(field => (
      !record ||
      record[field] == null ||
      (['openTime', 'closeTime', 'availableAt', 'fetchedAt', 'revisionNumber'].includes(field) && !Number.isFinite(Number(record[field]))) ||
      (['vintageId', 'symbol', 'interval', 'sourceId'].includes(field) && String(record[field]).trim() === '')
    ));
    if (missing.length) {
      throw Object.assign(
        new Error(`research_data_vintage audit record is incomplete: ${missing.join(', ')}`),
        { code: 'INCOMPLETE_RESEARCH_DATA_VINTAGE', missing }
      );
    }
    if (!seen.has(record.vintageId)) seen.set(record.vintageId, record);
  }
  return {
    researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION,
    asOfTime,
    consumedBars: [...seen.values()],
    backfillBatchIds: [...new Set(backfillBatchIds)],
    disclosure: 'FROZEN_POLICY: researchAvailability(bar)=bar.close_time — a replay-only counterfactual assumption for historical research, not a record of when the system historically/actually possessed this data.'
  };
}
