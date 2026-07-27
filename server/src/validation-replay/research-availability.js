// V1_4D_DATA_BACKFILL_SPEC.md §2.9 / V1_4D_HISTORICAL_REPLAY_SPEC.md §4.7：researchAvailability查询封装。
// researchAvailability(bar) = bar.close_time —— FROZEN_POLICY，回放专用反事实假设，不是生产系统当时真实获得
// 数据的时间。只存在于本回放查询层，绝不写回 market_bars.available_at；bar-path-locator.js 本身不做任何修改
// （§4.7冻结要求）。复用方式是给其未经修改的导出函数传入本模块构造的"queryable"包装对象：查询执行时把生产
// 可得性判据(available_at<=asOfTime)替换为researchAvailability语义（已隐含于既有close_time过滤中，故丢弃
// 该多余判据即是等价变换），并把fetched_at的比较基准从asOfTime(历史模拟时钟)换成回放任务发起时的真实系统时间
// （见 V1_4D_DATA_BACKFILL_SPEC.md §2.9第4点：防止与仍在进行中的并发回填任务产生"看到未完成批次"的边界情况）。

export const RESEARCH_AVAILABILITY_RULE_VERSION = 'v1.4d-research-availability-1';

// bar-path-locator.js 内部四处查询在文本上固定采用
// `available_at<=to_timestamp($N/1000.0) AND fetched_at<=to_timestamp($N/1000.0)` 这一相邻结构
// （N恒等于asOfTime在params中的位置），本正则据此定位并整体替换。
// 为何丢弃available_at<=$N是等价变换而非放宽：该clause在生产路径表达"available_at<=asOfTime"，但对回填数据
// available_at=回填执行的真实墙钟时间，与任何历史asOfTime比较恒假（悖论，见backfill spec §2.9）；
// researchAvailability(bar)=close_time这一定义已经由同一query中既有的close_time过滤条件
// （显式<=asOfTime，或经调用方保证<=asOfTime的精确相等查询）隐含满足，故丢弃是等价变换，不是放宽判据。
const AVAILABLE_AT_FETCHED_AT_PATTERN = /available_at<=to_timestamp\(\$(\d+)\/1000\.0\)\s+AND\s+fetched_at<=to_timestamp\(\$\1\/1000\.0\)/;

// 包装一个"queryable"对象（duck-types同pg Pool/Client的.query(sql, params)接口），供直接传给
// bar-path-locator.js 的 computeFourHourAtr14/computeConsecutiveBreakoutBars/locateReferenceBarAndPath/
// locatePathForEvaluation 使用——这四个函数本身不做任何修改（§4.7冻结要求，不改签名不改已有生产查询）。
// replayNowMs: 回放任务发起时的真实系统时间（epoch ms），不是历史asOfTime，专用于fetched_at过滤。
export function createResearchAvailabilityQueryable(pool, { replayNowMs }) {
  if (!Number.isSafeInteger(replayNowMs)) {
    throw Object.assign(new Error('createResearchAvailabilityQueryable requires a real replayNowMs (wall-clock epoch ms), not a historical asOfTime'), { code: 'INVALID_REPLAY_NOW' });
  }
  return {
    async query(sql, params) {
      const match = AVAILABLE_AT_FETCHED_AT_PATTERN.exec(sql);
      if (!match) {
        // fail closed：若bar-path-locator.js未来的查询文本发生未预期变化，本包装拒绝盲目转发（那样会
        // 静默沿用生产available_at<=asOfTime判据，对回填数据必然查不到任何行，且不会被察觉是"包装失效"）。
        throw Object.assign(
          new Error('research-availability queryable received an unrecognized query shape; refusing to execute production available_at predicate unmodified (fail closed)'),
          { code: 'UNRECOGNIZED_QUERY_SHAPE' }
        );
      }
      // 注意：不能简单地把available_at子句整体删除再把fetched_at重新绑定到"追加在末尾的新参数"了事——
      // 若原asOfTime占位符($N)在删除available_at子句后不再被SQL文本任何地方引用，会在参数序号序列中
      // 留下一个"空洞"(如只出现$1,$2,$4而无$3)，PostgreSQL无法为这个从未在文本中出现的序号推断类型，
      // 报错"could not determine data type of parameter $3"（本模块开发期间用真实回放查询实测发现的问题，
      // 保留此注释防止未来重构不小心又引入同样的空洞）。修复：把available_at子句替换为一个仍然引用$N的
      // 永真式（$N对应的asOfTime数值本身不受影响），fetched_at改绑定到紧随其后、连续递增的新末位参数。
      const originalAsOfParamIndex = match[1];
      const newParamIndex = params.length + 1;
      const rewrittenSql = sql.replace(
        AVAILABLE_AT_FETCHED_AT_PATTERN,
        `to_timestamp($${originalAsOfParamIndex}/1000.0) IS NOT NULL AND fetched_at<=to_timestamp($${newParamIndex}/1000.0)`
      );
      return pool.query(rewrittenSql, [...params, replayNowMs]);
    }
  };
}

// V1_4D_HISTORICAL_REPLAY_SPEC.md §2.3/§2.5冻结要求：每条replay_snapshots/replay_outcome_events记录必须携带
// research_data_vintage，显式声明"本记录基于researchAvailability(=close_time)假设生成，不代表系统历史上
// 真实持有此数据"——这是该记录合法性的完整审计证据链。
export function buildResearchDataVintage({ barRefs, backfillBatchIds = [], asOfTime }) {
  return {
    researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION,
    asOfTime,
    consumedBars: barRefs.filter(Boolean).map(ref => ({ barKey: ref.barKey, closeTime: ref.closeTime })),
    backfillBatchIds: [...new Set(backfillBatchIds)],
    disclosure: 'FROZEN_POLICY: researchAvailability(bar)=bar.close_time — a replay-only counterfactual assumption for historical research, not a record of when the system historically/actually possessed this data.'
  };
}
