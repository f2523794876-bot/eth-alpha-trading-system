import { canonicalV2LogicalWindow, computeV2ManifestContentForRange, findV2BackfillBatchIds } from './dataset-manifest-v2.js';
import { authoritativeDependencySet, dependencyLabel, sortV2Members, symbolsFromDependencies } from './multi-symbol-manifest-contract.js';
import { canonicalJsonStringify } from '../domain/hash.js';

const toMs = value => value instanceof Date ? value.getTime() : new Date(value).getTime();
const stable = value => canonicalJsonStringify(value);

function blocked(errorCode, detail = {}) {
  return { ok: false, errorCode, ...detail };
}

function objectCountsEqual(a, b) {
  const ak = Object.keys(a || {}).sort();
  const bk = Object.keys(b || {}).sort();
  return ak.length === bk.length && ak.every((key, index) => key === bk[index] && Number(a[key]) === Number(b[key]));
}

export function compareCanonicalV2ManifestMembers(storedMembers, recomputedMembers) {
  if (!Array.isArray(storedMembers) || !Array.isArray(recomputedMembers)) {
    return { ok: false, errorCode: 'DATASET_MANIFEST_MEMBER_CONTENT_MISMATCH' };
  }
  try {
    const storedCanonicalMembers = sortV2Members(storedMembers);
    const recomputedCanonicalMembers = sortV2Members(recomputedMembers);
    if (storedCanonicalMembers.length !== storedMembers.length || recomputedCanonicalMembers.length !== recomputedMembers.length) {
      return { ok: false, errorCode: 'DATASET_MANIFEST_MEMBER_CONTENT_MISMATCH' };
    }
    if (stable(storedCanonicalMembers) === stable(recomputedCanonicalMembers)) return { ok: true };
    return { ok: false, errorCode: 'DATASET_MANIFEST_MEMBER_CONTENT_MISMATCH' };
  } catch (error) {
    return {
      ok: false,
      errorCode: error.code === 'DATASET_MANIFEST_MEMBER_IDENTITY_MISSING'
        ? error.code
        : 'DATASET_MANIFEST_MEMBER_CONTENT_MISMATCH'
    };
  }
}

export async function verifyDatasetManifestV2({ pool, datasetVersion, manifest, currentResearchAvailabilityRuleVersion }) {
  const expectedDependencies = authoritativeDependencySet();
  if (manifest.manifest_schema_version !== 'v1.4d-manifest-schema-2' || manifest.dataset_type !== 'MARKET_BARS') {
    return blocked('DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED', { datasetVersion });
  }
  if (stable(manifest.dependency_set) !== stable(expectedDependencies) || stable(manifest.symbols) !== stable(symbolsFromDependencies(expectedDependencies))) {
    return blocked('DATASET_MANIFEST_DEPENDENCY_UNGOVERNED', { datasetVersion, expectedDependencies, manifestDependencies: manifest.dependency_set });
  }
  const from = toMs(manifest.data_from), to = toMs(manifest.data_to), fixedAsOf = toMs(manifest.fixed_as_of);
  if (![from, to, fixedAsOf].every(Number.isSafeInteger) || from >= to) return blocked('DATASET_TIME_RANGE_MISMATCH', { datasetVersion });
  if (manifest.source_formal_semantics !== 'market_bars:formal:spot') return blocked('DATASET_CONTENT_HASH_MISMATCH', { datasetVersion });
  const expectedWindow = canonicalV2LogicalWindow({ from, to, fixedAsOf, dependencySet: expectedDependencies });
  if (manifest.logical_window_hash !== expectedWindow.logicalWindowHash) {
    return blocked('DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT', { datasetVersion, manifestLogicalWindowHash: manifest.logical_window_hash, recomputedLogicalWindowHash: expectedWindow.logicalWindowHash });
  }
  const members = manifest.manifest_members;
  if (!Array.isArray(members) || !members.length) return blocked('DATASET_MANIFEST_MEMBERS_MISSING', { datasetVersion });
  const governedGroups = new Set(expectedDependencies.map(value => `${value.symbol}\0${value.interval}\0${value.marketType}\0${value.source}`));
  const seenVintageIds = new Set();
  for (const member of members) {
    if (!member || typeof member.symbol !== 'string' || typeof member.intervalName !== 'string' || typeof member.marketType !== 'string' ||
      typeof member.source !== 'string' || !Number.isSafeInteger(member.openTime) || !Number.isSafeInteger(member.closeTime) ||
      member.openTime < 0 || member.closeTime < 0 || member.openTime >= member.closeTime ||
      !Number.isSafeInteger(member.revisionNumber) || member.revisionNumber < 0 ||
      typeof member.vintageId !== 'string' || !/^[0-9a-f]{64}$/.test(member.rowContentHash || '')) {
      return blocked('DATASET_MANIFEST_MEMBER_IDENTITY_MISSING', { datasetVersion });
    }
    if (!governedGroups.has(`${member.symbol}\0${member.intervalName}\0${member.marketType}\0${member.source}`)) {
      return blocked('DATASET_MANIFEST_DEPENDENCY_UNGOVERNED', { datasetVersion, unexpectedMember: member.vintageId });
    }
    if (seenVintageIds.has(member.vintageId)) return blocked('DATASET_MANIFEST_MEMBER_IDENTITY_MISSING', { datasetVersion, duplicateVintageId: member.vintageId });
    seenVintageIds.add(member.vintageId);
  }
  const memberCounts = Object.fromEntries(expectedDependencies.map(dependency => [dependencyLabel(dependency), 0]));
  for (const member of members) {
    const label = `${member.symbol}:${member.intervalName}`;
    if (!(label in memberCounts)) return blocked('DATASET_MANIFEST_DEPENDENCY_UNGOVERNED', { datasetVersion, unexpectedMember: member.vintageId });
    memberCounts[label] += 1;
  }
  if (!objectCountsEqual(memberCounts, manifest.per_interval_record_count || {}) || Object.entries(memberCounts).some(([, count]) => count <= 0)) {
    return blocked('DATASET_MANIFEST_MEMBER_IDENTITY_MISSING', { datasetVersion, memberCounts, manifestCounts: manifest.per_interval_record_count });
  }
  for (const dependency of expectedDependencies) {
    const label = dependencyLabel(dependency);
    const integrity = manifest.integrity_check_result?.[label];
    if (!integrity || Number(integrity.gapCount) !== 0 || Number(integrity.duplicateCount) !== 0 || Number(integrity.outOfOrderCount) !== 0) {
      return blocked('DATASET_MANIFEST_DEPENDENCY_INCOMPLETE', { datasetVersion, dependency, integrity });
    }
  }
  const conflicts = await pool.query('SELECT dataset_version FROM historical_validation.dataset_manifests WHERE logical_window_hash=$1 ORDER BY dataset_version', [manifest.logical_window_hash]);
  if (conflicts.rowCount !== 1 || conflicts.rows[0].dataset_version !== datasetVersion) {
    return blocked('DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT', { datasetVersion, conflictingDatasetVersions: conflicts.rows.map(row => row.dataset_version) });
  }
  const recomputed = await computeV2ManifestContentForRange({
    pool,
    from,
    to,
    fixedAsOf,
    backfillBatchIds: manifest.backfill_batch_ids
  });
  if (recomputed.datasetVersion !== datasetVersion) return blocked('DATASET_CONTENT_HASH_MISMATCH', { datasetVersion, recomputedDatasetVersion: recomputed.datasetVersion });
  const memberComparison = compareCanonicalV2ManifestMembers(members, recomputed.manifestMembers);
  if (!memberComparison.ok) {
    return blocked(memberComparison.errorCode, {
      datasetVersion,
      storedMemberCount: members.length,
      recomputedMemberCount: recomputed.manifestMembers.length
    });
  }
  if (recomputed.recordCount !== Number(manifest.record_count) || !objectCountsEqual(recomputed.perDependencyRecordCount, manifest.per_interval_record_count)) {
    return blocked('DATASET_RECORD_COUNT_MISMATCH', { datasetVersion });
  }
  if (stable(recomputed.perDependencyIntegrityCheckResult) !== stable(manifest.integrity_check_result)) {
    return blocked('DATASET_MANIFEST_DEPENDENCY_INCOMPLETE', { datasetVersion });
  }
  const freshBatchIds = await findV2BackfillBatchIds(pool, expectedDependencies, {
    from, to
  });
  const storedBatchIds = [...new Set(manifest.backfill_batch_ids || [])].sort();
  if (stable([...new Set(freshBatchIds)].sort()) !== stable(storedBatchIds)) {
    return blocked('DATASET_BATCH_SET_MISMATCH', {
      datasetVersion, manifestBackfillBatchIds: storedBatchIds, freshlyDerivedBackfillBatchIds: [...new Set(freshBatchIds)].sort()
    });
  }
  if (manifest.research_availability_rule_version !== currentResearchAvailabilityRuleVersion) {
    return blocked('DATASET_RESEARCH_AVAILABILITY_VERSION_MISMATCH', { datasetVersion, manifestVersion: manifest.research_availability_rule_version, currentVersion: currentResearchAvailabilityRuleVersion });
  }
  return { ok: true, datasetVersion, manifest };
}
