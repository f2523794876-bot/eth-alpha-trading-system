// V1_4D_HISTORICAL_REPLAY_SPEC.md §2.9.1/§2.9.2：dataset_manifests 被哈希内容对象的确定性构造。
// 纯函数——只负责"选哪些字段、按什么顺序排列、以什么类型传入"，哈希计算委托给 domain/hash.js canonicalJsonHash()，
// 本模块不重新实现JSON规范化/哈希算法本身（V1_4D_CODEX_IMPLEMENTATION_TASK.md 对应任务红线）。

import { canonicalJsonHash } from '../domain/hash.js';

const INTERVAL_RANK = Object.freeze({ '15m': 0, '1h': 1, '4h': 2 });

function typeDisciplineError(fieldName, expected) {
  return Object.assign(new Error(`${fieldName} must be ${expected} (§2.9.5 caller类型纪律)`), { code: 'MANIFEST_TYPE_DISCIPLINE_VIOLATION' });
}

function assertNumericString(value, fieldName) {
  if (typeof value !== 'string') throw typeDisciplineError(fieldName, 'a string (Postgres numeric passthrough, no Number() conversion)');
}

// §2.9.3：固定字段集合(open,high,low,close,volume,quoteVolume)，六个numeric字段一律以字符串形式传入。
// canonicalJsonHash() 内部对对象键做 Object.keys().sort()，故此处键的书写顺序不影响哈希结果，
// 真正决定确定性的是"字段集合与每个字段的取值/类型"，而不是JS对象字面量的书写顺序。
export function computeRowContentHash({ open, high, low, close, volume, quoteVolume }) {
  assertNumericString(open, 'open');
  assertNumericString(high, 'high');
  assertNumericString(low, 'low');
  assertNumericString(close, 'close');
  assertNumericString(volume, 'volume');
  assertNumericString(quoteVolume, 'quoteVolume');
  return canonicalJsonHash({ open, high, low, close, volume, quoteVolume });
}

// §2.9.2：intervals 无专门排序规则条款，但为保证"同一内容不同调用顺序产生相同dataset_version"这一冻结性质（§2.9.7），
// 采用与规范全文示例一致的固定顺序（按周期长度升序）去重排序，不依赖调用方传入顺序。
// P2-2修复（独立复审）：INTERVAL_RANK只定义了15m/1h/4h三个冻结interval——此前对未知interval用
// `?? Number.MAX_SAFE_INTEGER`兜底，会把任何拼写错误/非法interval静默排到末尾，仍然参与哈希计算，
// 产出一个"看起来正常"但语义上无意义的dataset_version（其manifest_members实际引用了一个从未被
// 冻结定义过的interval的数据）。改为fail closed：遇到不在INTERVAL_RANK中的interval立即拒绝，不静默纳入。
function sortIntervals(intervals) {
  for (const interval of intervals) {
    if (!Object.hasOwn(INTERVAL_RANK, interval)) {
      throw Object.assign(new Error(`Unknown interval: ${interval} (only 15m/1h/4h are frozen)`), { code: 'UNKNOWN_INTERVAL', interval });
    }
  }
  return [...new Set(intervals)].sort((a, b) => INTERVAL_RANK[a] - INTERVAL_RANK[b]);
}

// §2.9.2 backfillBatchIds排序规则：先去重，再按UUID标准文本表示严格字典序升序。
function sortBackfillBatchIds(ids) {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// §2.9.2 manifestMembers排序规则：四元组(intervalName, openTime, revisionNumber, vintageId)依次比较，
// vintageId为全局唯一的最终决胜字段，杜绝前三字段并列时的排序歧义（红线）。
function sortManifestMembers(members) {
  return [...members].sort((a, b) => {
    if (a.intervalName !== b.intervalName) return a.intervalName < b.intervalName ? -1 : 1;
    if (a.openTime !== b.openTime) return a.openTime - b.openTime;
    if (a.revisionNumber !== b.revisionNumber) return a.revisionNumber - b.revisionNumber;
    if (a.vintageId !== b.vintageId) return a.vintageId < b.vintageId ? -1 : 1;
    return 0;
  });
}

// manifestMemberRows: 未排序、未去重的候选行数组，每项包含
// {intervalName, openTime(number,ms), vintageId, revisionNumber(number), open/high/low/close/volume/quoteVolume(string)}。
// 调用方(dataset-manifest-builder.js)负责查询market_bars得到这些候选行，本函数只负责排序与哈希内容对象构造。
export function buildCanonicalManifestContent({
  manifestSchemaVersion = 'v1.4d-manifest-schema-1',
  manifestHashAlgorithmVersion = 'v1.4d-manifest-hash-1',
  symbol,
  intervals,
  dataFrom,
  dataTo,
  backfillBatchIds,
  manifestMemberRows,
  sourceFormalSemantics = 'market_bars:formal:spot',
  researchAvailabilityRuleVersion,
  perIntervalRecordCount,
  integrityCheckResult
}) {
  if (typeof dataFrom !== 'string') throw typeDisciplineError('dataFrom', 'an ISO8601 string, not a Date object');
  if (typeof dataTo !== 'string') throw typeDisciplineError('dataTo', 'an ISO8601 string, not a Date object');

  const sortedIntervals = sortIntervals(intervals);
  const rawBackfillBatchIdCount = backfillBatchIds.length;
  const sortedBackfillBatchIds = sortBackfillBatchIds(backfillBatchIds);
  const duplicateBackfillBatchIdsRemoved = rawBackfillBatchIdCount - sortedBackfillBatchIds.length;

  const membersWithHash = manifestMemberRows.map(row => ({
    intervalName: row.intervalName,
    openTime: row.openTime,
    vintageId: row.vintageId,
    revisionNumber: row.revisionNumber,
    rowContentHash: computeRowContentHash(row)
  }));
  const manifestMembers = sortManifestMembers(membersWithHash);
  const recordCount = manifestMembers.length;

  // §2.9.1 冻结绑定字段清单——camelCase字段名与DB列snake_case是1:1机械映射，语义不变。
  const contentObject = {
    manifestSchemaVersion,
    manifestHashAlgorithmVersion,
    symbol,
    intervals: sortedIntervals,
    dataFrom,
    dataTo,
    backfillBatchIds: sortedBackfillBatchIds,
    manifestMembers,
    sourceFormalSemantics,
    researchAvailabilityRuleVersion,
    recordCount,
    perIntervalRecordCount,
    integrityCheckResult
  };

  return { contentObject, manifestMembers, backfillBatchIds: sortedBackfillBatchIds, intervals: sortedIntervals, recordCount, duplicateBackfillBatchIdsRemoved };
}

// §2.9.0：dataset_version = `v1.4d-sha256-${完整64位十六进制contentHash}`，不做任何截断。
export function computeDatasetVersion(contentObject) {
  const contentHash = canonicalJsonHash(contentObject);
  return `v1.4d-sha256-${contentHash}`;
}
