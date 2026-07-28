// V1_4D_HISTORICAL_REPLAY_SPEC.md §4.1a：Dataset Manifest 强制校验流程（P1闭环核心）。
// 供 cli-entry.js 在启动 validation:walk-forward 时调用——无论 --dry-run/--resume 与否，
// 在做任何 historical_as_of_time 推进或写入之前必须先完整跑完本模块的八步校验，任一步失败即fail closed。
// 与 dataset-manifest-builder.js（构建，写路径）职责严格分离，本模块只读，不写入任何表。
//
// §4.1a第7/8步（resume/dry-run场景下必须【重新完整执行】，不得因"上次已验证过"跳过）由调用方保证：
// verifyDatasetManifest() 本身是无状态纯查询函数，每次调用都完整执行全部步骤，不做任何跨调用缓存，
// 因此只要调用方在resume/dry-run时都重新调用一次本函数，第7/8步的"不得跳过"要求自然满足。

import { computeManifestContentForRange, findOverlappingBackfillBatchIds, RESEARCH_AVAILABILITY_RULE_VERSION } from './dataset-manifest-builder.js';

function toEpochMs(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function sortedJsonEqual(a, b) {
  const na = [...a].sort();
  const nb = [...b].sort();
  return JSON.stringify(na) === JSON.stringify(nb);
}

// perIntervalRecordCount是{interval: count}这样的flat对象——不能直接JSON.stringify比较两侧：
// 一侧来自JS对象字面量（键顺序=intervals排序顺序），另一侧是从Postgres jsonb列读回的对象，
// jsonb在存储时不保证保留原始键顺序（本模块开发期间用真实数据实测发现，同一内容两侧stringify结果
// 因键顺序不同而不相等，产生假阳性DATASET_RECORD_COUNT_MISMATCH），故按键排序后再比较值。
function perIntervalRecordCountEqual(a, b) {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) return false;
  return keysA.every(key => Number(a[key]) === Number(b[key]));
}

// dataset_version: 待验证的声明（不可信输入，见§4.1a红线）。
export async function verifyDatasetManifest({ pool, datasetVersion, marketType = 'spot', currentResearchAvailabilityRuleVersion = RESEARCH_AVAILABILITY_RULE_VERSION }) {
  // 第1步：manifest必须存在。
  const manifestResult = await pool.query('SELECT * FROM historical_validation.dataset_manifests WHERE dataset_version=$1', [datasetVersion]);
  if (!manifestResult.rowCount) {
    return { ok: false, errorCode: 'DATASET_MANIFEST_NOT_FOUND', datasetVersion };
  }
  const manifest = manifestResult.rows[0];
  const symbol = manifest.symbol;
  const intervals = manifest.intervals;
  const from = toEpochMs(manifest.data_from);
  const to = toEpochMs(manifest.data_to);
  const manifestBackfillBatchIds = manifest.backfill_batch_ids;

  // 第2步：用manifest记录的symbol/intervals/data_from/data_to/backfill_batch_ids，
  // 对public.market_bars重新执行与manifest构建时完全相同的查询与§2.9规范化序列化，
  // 复用 dataset-manifest-builder.js 的 computeManifestContentForRange()——不得另写第二套判定。
  const recomputed = await computeManifestContentForRange({
    pool, symbol, intervals, from, to, marketType,
    backfillBatchIds: manifestBackfillBatchIds
  });

  // 第3步：完整64字符哈希比对（datasetVersion整体比对即等价于content_hash逐字符比对）。
  if (recomputed.datasetVersion !== datasetVersion) {
    return {
      ok: false,
      errorCode: 'DATASET_CONTENT_HASH_MISMATCH',
      datasetVersion,
      recomputedDatasetVersion: recomputed.datasetVersion,
      manifestRecordCount: manifest.record_count,
      manifestDataFrom: manifest.data_from,
      manifestDataTo: manifest.data_to,
      recomputedRecordCount: recomputed.recordCount
    };
  }

  // 第4步：独立比对record_count/per_interval_record_count/data_from/data_to/backfill_batch_ids。
  //
  // P2-1可达性说明（独立复审，不得伪称四项字段级错误码都已被独立、等概率覆盖）：
  // - DATASET_TIME_RANGE_MISMATCH 在当前调用路径下【结构性不可达】——本函数第36-44行用于recompute的
  //   `from`/`to` 本身就是 `toEpochMs(manifest.data_from)`/`toEpochMs(manifest.data_to)`（见上方赋值），
  //   即此处比较的是同一来源算出来的两个值，永远相等，这不是"哈希先一步拦截"，而是此分支根本没有独立输入
  //   来源可以产生分歧，是纯粹的死代码。保留该分支只作为未来若recompute改为传入独立`from`/`to`时的
  //   防御性占位，不代表当前存在任何可触发它的真实场景（见本文件对应集成测试的显式反例断言）。
  // - DATASET_RECORD_COUNT_MISMATCH 在当前调用路径下【被第3步哈希比对天然先行拦截，实际不可达】——
  //   recompute使用的`from`/`to`固定等于manifest自身存储的区间（同上），而`recordCount`/
  //   `perIntervalRecordCount`都是§2.9冻结哈希内容对象的一部分（canonical-manifest-content.js），
  //   market_bars在该固定区间内的任何增减都会同时改变recordCount与recomputedContentHash，
  //   第3步的DATASET_CONTENT_HASH_MISMATCH必然先于此处触发，此分支目前只是纵深防御（哈希算法/
  //   哈希内容清单未来若有疏漏导致recordCount脱离哈希覆盖范围时的兜底），不代表已被独立验证覆盖。
  // - DATASET_BATCH_SET_MISMATCH 与前两者不同——是【真正独立可达】的检查：下方
  //   `findOverlappingBackfillBatchIds`对`historical_validation.backfill_batches`发起全新查询，
  //   不依赖manifest存储的`backfillBatchIds`（那是recompute哈希时使用的输入，即"信任manifest自称的
  //   批次集合"），而是从数据库当前实际状态重新推导"此刻与该区间重叠的批次"——manifest冻结后新增覆盖
  //   同一区间的批次这一场景下，content_hash不变（backfillBatchIds作为哈希输入仍是manifest原始存储值），
  //   但本步比对会独立发现漂移，产生真正独立于哈希比对结果的DATASET_BATCH_SET_MISMATCH（见对应集成测试）。
  if (recomputed.recordCount !== manifest.record_count) {
    return { ok: false, errorCode: 'DATASET_RECORD_COUNT_MISMATCH', datasetVersion, manifestRecordCount: manifest.record_count, recomputedRecordCount: recomputed.recordCount };
  }
  if (!perIntervalRecordCountEqual(recomputed.perIntervalRecordCount, manifest.per_interval_record_count)) {
    return { ok: false, errorCode: 'DATASET_RECORD_COUNT_MISMATCH', datasetVersion, manifestPerIntervalRecordCount: manifest.per_interval_record_count, recomputedPerIntervalRecordCount: recomputed.perIntervalRecordCount };
  }
  if (toEpochMs(manifest.data_from) !== from || toEpochMs(manifest.data_to) !== to) {
    return { ok: false, errorCode: 'DATASET_TIME_RANGE_MISMATCH', datasetVersion, manifestDataFrom: manifest.data_from, manifestDataTo: manifest.data_to };
  }
  // 独立重新派生"当前与该区间时间重叠的backfill_batch_ids"（而非直接复用manifest存储值），
  // 检测manifest冻结之后是否有新增/变化的批次覆盖同一区间——这是真正独立于manifest自身存储值的核验。
  const freshlyDerivedBackfillBatchIds = await findOverlappingBackfillBatchIds(pool, { symbol, intervals, from, to });
  if (!sortedJsonEqual(freshlyDerivedBackfillBatchIds, manifestBackfillBatchIds)) {
    return { ok: false, errorCode: 'DATASET_BATCH_SET_MISMATCH', datasetVersion, manifestBackfillBatchIds, freshlyDerivedBackfillBatchIds };
  }

  // 第5步：researchAvailability规则版本必须与当前代码内置版本一致。
  if (manifest.research_availability_rule_version !== currentResearchAvailabilityRuleVersion) {
    return {
      ok: false,
      errorCode: 'DATASET_RESEARCH_AVAILABILITY_VERSION_MISMATCH',
      datasetVersion,
      manifestVersion: manifest.research_availability_rule_version,
      currentVersion: currentResearchAvailabilityRuleVersion
    };
  }

  // 第6步：全部通过，允许进入historical_as_of_time推进循环。
  return { ok: true, datasetVersion, manifest };
}
