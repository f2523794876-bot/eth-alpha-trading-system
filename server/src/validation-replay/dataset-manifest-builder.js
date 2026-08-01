// V1_4D_HISTORICAL_REPLAY_SPEC.md §4.0/§2.8/§2.9：`npm run dataset:build-manifest` 核心逻辑。
// 流程：integrity-check.js确认零缺口/零重复/零乱序（不通过则拒绝）→ canonical-manifest-content.js构造内容对象
// → domain/hash.js canonicalJsonHash()计算完整64位content_hash → 拼出dataset_version → INSERT ON CONFLICT DO NOTHING。
// 本模块只读查询 public.market_bars/historical_validation.backfill_batches，只写 historical_validation.dataset_manifests一张表。
// 与 dataset-manifest-verifier.js（只读校验）职责严格分离，不得合并（V1_4D_CODEX_IMPLEMENTATION_TASK.md）。
//
// computeManifestContentForRange() 是构建（本模块）与校验（dataset-manifest-verifier.js §4.1a第2步）
// 共用的唯一一套"查询market_bars+规范化序列化"逻辑——校验流程要求"重新执行与manifest构建时完全相同的查询与
// 规范化序列化"，故此处刻意导出供verifier直接复用，不允许verifier另写第二套等价逻辑。

import { checkIntegrity, toManifestIntegrityCheckResult } from '../backfill/integrity-check.js';
import { buildCanonicalManifestContent, computeDatasetVersion } from './canonical-manifest-content.js';

export const RESEARCH_AVAILABILITY_RULE_VERSION = 'v1.4d-research-availability-1';

async function loadIntervalRows(pool, { symbol, marketType, interval, from, to }) {
  const result = await pool.query(
    `SELECT interval_name, open_time, vintage_id, revision_number,
            open::text AS open, high::text AS high, low::text AS low, close::text AS close,
            volume::text AS volume, quote_volume::text AS quote_volume
     FROM market_bars
     WHERE instrument=$1 AND market_type=$2 AND interval_name=$3
       AND open_time>=to_timestamp($4/1000.0) AND open_time<to_timestamp($5/1000.0)`,
    [symbol, marketType, interval, from, to]
  );
  return result.rows.map(row => ({
    intervalName: row.interval_name,
    openTime: row.open_time instanceof Date ? row.open_time.getTime() : new Date(row.open_time).getTime(),
    vintageId: row.vintage_id,
    revisionNumber: row.revision_number,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    quoteVolume: row.quote_volume
  }));
}

// 涵盖批次仅作审计溯源信息——manifest的正确性由内容哈希独立保证，不依赖此查询是否穷尽（§2.8）。
export async function findOverlappingBackfillBatchIds(pool, { symbol, intervals, from, to }) {
  const result = await pool.query(
    `SELECT DISTINCT backfill_batch_id FROM historical_validation.backfill_batches
     WHERE symbol=$1 AND interval_name = ANY($2::text[])
       AND requested_start_utc < to_timestamp($4/1000.0) AND requested_end_utc > to_timestamp($3/1000.0)`,
    [symbol, intervals, from, to]
  );
  return result.rows.map(row => row.backfill_batch_id);
}

// from/to: epoch毫秒（UTC）。intervals: 如 ['15m','1h','4h']。
// backfillBatchIds: 若调用方传入（校验路径——使用manifest行已记录的值，见§4.1a第2步），直接采用；
// 若省略（构建路径），现场查询与请求区间重叠的批次作为溯源信息。
export async function computeManifestContentForRange({ pool, symbol, intervals, from, to, marketType = 'spot', backfillBatchIds }) {
  const perIntervalRecordCount = {};
  let aggregateGapCount = 0, aggregateDuplicateCount = 0, aggregateOutOfOrderCount = 0;
  const manifestMemberRows = [];

  for (const interval of intervals) {
    const integrity = await checkIntegrity(pool, { instrument: symbol, marketType, interval, from, to });
    aggregateGapCount += integrity.gapCount;
    aggregateDuplicateCount += integrity.duplicateCount;
    aggregateOutOfOrderCount += integrity.outOfOrderCount;

    const rows = await loadIntervalRows(pool, { symbol, marketType, interval, from, to });
    perIntervalRecordCount[interval] = rows.length;
    manifestMemberRows.push(...rows);
  }

  const resolvedBackfillBatchIds = backfillBatchIds ?? await findOverlappingBackfillBatchIds(pool, { symbol, intervals, from, to });
  const integrityCheckResult = toManifestIntegrityCheckResult({
    gapCount: aggregateGapCount,
    duplicateCount: aggregateDuplicateCount,
    outOfOrderCount: aggregateOutOfOrderCount
  });

  const built = buildCanonicalManifestContent({
    symbol,
    intervals,
    dataFrom: new Date(from).toISOString(),
    dataTo: new Date(to).toISOString(),
    backfillBatchIds: resolvedBackfillBatchIds,
    manifestMemberRows,
    researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION,
    perIntervalRecordCount,
    integrityCheckResult
  });

  const datasetVersion = computeDatasetVersion(built.contentObject);

  return { ...built, perIntervalRecordCount, datasetVersion };
}

export async function buildDatasetManifest({ pool, symbol, intervals, from, to, marketType = 'spot' }) {
  const computed = await computeManifestContentForRange({ pool, symbol, intervals, from, to, marketType });
  const { contentObject, manifestMembers, backfillBatchIds, intervals: sortedIntervals, recordCount, perIntervalRecordCount, datasetVersion, duplicateBackfillBatchIdsRemoved } = computed;
  const warnings = [];

  const integrity = contentObject.integrityCheckResult;
  if (integrity.gapCount > 0 || integrity.duplicateCount > 0 || integrity.outOfOrderCount > 0) {
    return { status: 'REJECTED', errorCode: 'INTEGRITY_CHECK_FAILED', integrity };
  }

  // §2.9.2第1条：backfillBatchIds去重不应发生（DISTINCT查询已去重），若发生记一条WARNING，不阻断构建。
  if (duplicateBackfillBatchIdsRemoved > 0) {
    warnings.push(`duplicate backfillBatchIds removed: ${duplicateBackfillBatchIdsRemoved}`);
  }

  const insertResult = await pool.query(
    `INSERT INTO historical_validation.dataset_manifests(
       dataset_version, manifest_schema_version, manifest_hash_algorithm_version, symbol, intervals,
       data_from, data_to, backfill_batch_ids, source_formal_semantics, research_availability_rule_version,
       record_count, per_interval_record_count, integrity_check_result, manifest_members
     ) VALUES ($1,$2,$3,$4,$5::jsonb,to_timestamp($6/1000.0),to_timestamp($7/1000.0),$8::jsonb,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb)
     ON CONFLICT (dataset_version) DO NOTHING`,
    [
      datasetVersion,
      contentObject.manifestSchemaVersion,
      contentObject.manifestHashAlgorithmVersion,
      symbol,
      JSON.stringify(sortedIntervals),
      from,
      to,
      JSON.stringify(backfillBatchIds),
      contentObject.sourceFormalSemantics,
      contentObject.researchAvailabilityRuleVersion,
      recordCount,
      JSON.stringify(perIntervalRecordCount),
      JSON.stringify(contentObject.integrityCheckResult),
      JSON.stringify(manifestMembers)
    ]
  );

  return {
    status: 'SUCCEEDED',
    datasetVersion,
    recordCount,
    perIntervalRecordCount,
    integrityCheckResult: contentObject.integrityCheckResult,
    inserted: insertResult.rowCount > 0,
    warnings
  };
}
