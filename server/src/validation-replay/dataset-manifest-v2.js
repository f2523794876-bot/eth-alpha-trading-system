import { computeIntegrityBoundary, inspectIntegrityRows, toManifestIntegrityCheckResult } from '../backfill/integrity-check.js';
import { canonicalJsonHash } from '../domain/hash.js';
import { buildCanonicalManifestContent, computeDatasetVersion } from './canonical-manifest-content.js';
import {
  MANIFEST_CONTRACT_VERSION,
  MANIFEST_DATASET_TYPE,
  MANIFEST_MARKET_TYPE,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_SOURCE_ID,
  assertAuthoritativeDependencySet,
  authoritativeDependencySet,
  dependencyLabel
} from './multi-symbol-manifest-contract.js';

const RESEARCH_RULE = 'v1.4d-research-availability-1';
const SOURCE_SEMANTICS = 'market_bars:formal:spot';
const toMs = value => value instanceof Date ? value.getTime() : new Date(value).getTime();

export function canonicalV2LogicalWindow({ fixedAsOf, from, to, dependencySet = authoritativeDependencySet() }) {
  const normalizedDependencies = assertAuthoritativeDependencySet(dependencySet).dependencySet;
  const identity = Object.freeze({
    contractVersion: MANIFEST_CONTRACT_VERSION,
    datasetType: MANIFEST_DATASET_TYPE,
    fixedAsOf: new Date(fixedAsOf).toISOString(),
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    dependencySet: normalizedDependencies,
    sourceFormalSemantics: SOURCE_SEMANTICS
  });
  return Object.freeze({ identity, logicalWindowHash: canonicalJsonHash(identity) });
}

async function loadDependencyRows(pool, dependency, { from, to, fixedAsOf }) {
  const boundary = computeIntegrityBoundary({ from, to, asOf: fixedAsOf, interval: dependency.interval });
  const result = await pool.query(
    `SELECT DISTINCT ON (open_time)
       instrument, market_type, interval_name, source_id, open_time, close_time,
       vintage_id, revision_number, open::text, high::text, low::text, close::text,
       volume::text, quote_volume::text
     FROM public.market_bars
     WHERE instrument=$1 AND market_type=$2 AND interval_name=$3 AND source_id=$4
       AND open_time>=to_timestamp($5/1000.0) AND open_time<to_timestamp($6/1000.0)
       AND close_time<=to_timestamp($7/1000.0)
     ORDER BY open_time, revision_number DESC, vintage_id DESC`,
    [dependency.symbol, dependency.marketType, dependency.interval, MANIFEST_SOURCE_ID, from, to, fixedAsOf]
  );
  for (const row of result.rows) {
    const openTime = toMs(row.open_time), closeTime = toMs(row.close_time);
    if (row.instrument !== dependency.symbol || row.interval_name !== dependency.interval || row.market_type !== dependency.marketType || row.source_id !== MANIFEST_SOURCE_ID ||
      !Number.isSafeInteger(openTime) || !Number.isSafeInteger(closeTime) || openTime < from || openTime >= to || closeTime > to || closeTime > fixedAsOf) {
      throw Object.assign(new Error(`Query returned an invalid row for ${dependencyLabel(dependency)}`), {
        code: 'DATASET_MANIFEST_DEPENDENCY_INCOMPLETE', dependency, vintageId: row.vintage_id
      });
    }
  }
  const integrity = inspectIntegrityRows(result.rows, boundary);
  const rows = result.rows.map(row => ({
    symbol: row.instrument,
    intervalName: row.interval_name,
    marketType: row.market_type,
    source: dependency.source,
    openTime: toMs(row.open_time),
    closeTime: toMs(row.close_time),
    vintageId: row.vintage_id,
    revisionNumber: Number(row.revision_number),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    quoteVolume: row.quote_volume
  }));
  return { boundary, integrity, rows };
}

export async function findV2BackfillBatchIds(pool, dependencySet, { from, to }) {
  const ids = [];
  for (const dependency of dependencySet) {
    const result = await pool.query(
      `SELECT DISTINCT backfill_batch_id
       FROM historical_validation.backfill_batches
       WHERE symbol=$1 AND interval_name=$2
         AND requested_start_utc<to_timestamp($4/1000.0)
         AND requested_end_utc>to_timestamp($3/1000.0)`,
      [dependency.symbol, dependency.interval, from, to]
    );
    ids.push(...result.rows.map(row => row.backfill_batch_id));
  }
  return ids;
}

export async function computeV2ManifestContentForRange({ pool, from, to, fixedAsOf, backfillBatchIds }) {
  if (![from, to, fixedAsOf].every(Number.isSafeInteger) || from >= to) throw Object.assign(new Error('Invalid v2 manifest window'), { code: 'INVALID_MANIFEST_WINDOW' });
  const dependencySet = authoritativeDependencySet();
  const manifestMemberRows = [];
  const perDependencyRecordCount = {};
  const perDependencyIntegrityCheckResult = {};
  const groupStatistics = {};
  for (const dependency of dependencySet) {
    const loaded = await loadDependencyRows(pool, dependency, { from, to, fixedAsOf });
    if (loaded.boundary.effectiveTo !== to) {
      throw Object.assign(new Error(`${dependency.symbol} ${dependency.interval} requested range extends beyond fixed as-of`), {
        code: 'MANIFEST_RANGE_EXCEEDS_AS_OF', symbol: dependency.symbol, interval: dependency.interval,
        fixedAsOf, requestedTo: to, effectiveTo: loaded.boundary.effectiveTo
      });
    }
    const label = dependencyLabel(dependency);
    const result = toManifestIntegrityCheckResult(loaded.integrity);
    perDependencyRecordCount[label] = loaded.rows.length;
    perDependencyIntegrityCheckResult[label] = result;
    groupStatistics[label] = Object.freeze({
      ...dependency,
      expectedRecordCount: loaded.integrity.expectedBarCount,
      actualRecordCount: loaded.integrity.distinctRowCount,
      firstExpectedOpenTime: loaded.integrity.firstExpectedOpenTime,
      lastExpectedOpenTime: loaded.integrity.lastExpectedOpenTime,
      firstActualOpenTime: loaded.integrity.firstActualOpenTime,
      lastActualOpenTime: loaded.integrity.lastActualOpenTime,
      countMatches: loaded.integrity.countMatches,
      ...result
    });
    manifestMemberRows.push(...loaded.rows);
  }
  const resolvedBatchIds = backfillBatchIds ?? await findV2BackfillBatchIds(pool, dependencySet, { from, to });
  const built = buildCanonicalManifestContent({
    manifestContractVersion: MANIFEST_CONTRACT_VERSION,
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    datasetType: MANIFEST_DATASET_TYPE,
    dependencySet,
    dataFrom: new Date(from).toISOString(),
    dataTo: new Date(to).toISOString(),
    fixedAsOf: new Date(fixedAsOf).toISOString(),
    backfillBatchIds: resolvedBatchIds,
    manifestMemberRows,
    sourceFormalSemantics: SOURCE_SEMANTICS,
    researchAvailabilityRuleVersion: RESEARCH_RULE,
    perDependencyRecordCount,
    perDependencyIntegrityCheckResult
  });
  return { ...built, datasetVersion: computeDatasetVersion(built.contentObject), fixedAsOf, perDependencyRecordCount, perDependencyIntegrityCheckResult, groupStatistics };
}

export function validateV2ManifestGroups(groups) {
  const mismatches = Object.values(groups).filter(group => !group.countMatches || group.gapCount || group.duplicateCount || group.outOfOrderCount ||
    group.firstActualOpenTime !== group.firstExpectedOpenTime || group.lastActualOpenTime !== group.lastExpectedOpenTime);
  return { ok: mismatches.length === 0, mismatches };
}

function isPgPool(connection) {
  return connection &&
    typeof connection.connect === 'function' &&
    typeof connection.query === 'function' &&
    Number.isInteger(connection.totalCount) &&
    Number.isInteger(connection.idleCount) &&
    Number.isInteger(connection.waitingCount);
}

// An externally supplied Client/PoolClient remains caller-owned, including its
// surrounding transaction. Only a pg.Pool checkout is owned and released here.
export async function withManifestPersistenceConnection(connection, work) {
  if (!connection || typeof connection.query !== 'function') {
    throw Object.assign(new Error('A PostgreSQL Pool or connected Client is required'), { code: 'DATABASE_CONNECTION_REQUIRED' });
  }
  if (!isPgPool(connection)) return work(connection);

  const client = await connection.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        if (error && (typeof error === 'object' || typeof error === 'function')) error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function persist(pool, computed, window) {
  const execute = async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`dataset-manifest:${window.logicalWindowHash}`]);
    const existing = await client.query('SELECT dataset_version FROM historical_validation.dataset_manifests WHERE logical_window_hash=$1', [window.logicalWindowHash]);
    const versions = [...new Set(existing.rows.map(row => row.dataset_version))];
    if (versions.length) {
      if (versions.length === 1 && versions[0] === computed.datasetVersion) return false;
      throw Object.assign(new Error('A different manifest already governs this logical window'), { code: 'DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT', existingDatasetVersions: versions, candidateDatasetVersion: computed.datasetVersion });
    }
    try {
      const result = await client.query(
        `INSERT INTO historical_validation.dataset_manifests(
          dataset_version, manifest_schema_version, manifest_hash_algorithm_version,
          manifest_contract_version, dataset_type, symbol, symbols, dependency_set, intervals,
          data_from, data_to, fixed_as_of, logical_window_hash, backfill_batch_ids,
          source_formal_semantics, research_availability_rule_version, record_count,
          per_interval_record_count, integrity_check_result, manifest_members
        ) VALUES ($1,$2,$3,2,$4,NULL,$5::jsonb,$6::jsonb,$7::jsonb,
          to_timestamp($8/1000.0),to_timestamp($9/1000.0),to_timestamp($10/1000.0),$11,$12::jsonb,
          $13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb)`,
        [computed.datasetVersion, computed.contentObject.manifestSchemaVersion, computed.contentObject.manifestHashAlgorithmVersion,
          computed.contentObject.datasetType, JSON.stringify(computed.symbols), JSON.stringify(computed.dependencySet),
          JSON.stringify([...new Set(computed.dependencySet.map(value => value.interval))].sort()),
          Date.parse(computed.contentObject.dataFrom), Date.parse(computed.contentObject.dataTo), Date.parse(computed.contentObject.fixedAsOf),
          window.logicalWindowHash, JSON.stringify(computed.backfillBatchIds), computed.contentObject.sourceFormalSemantics,
          computed.contentObject.researchAvailabilityRuleVersion, computed.recordCount,
          JSON.stringify(computed.perDependencyRecordCount), JSON.stringify(computed.perDependencyIntegrityCheckResult), JSON.stringify(computed.manifestMembers)]
      );
      return result.rowCount > 0;
    } catch (error) {
      if (error.code === '23505') throw Object.assign(new Error('Concurrent manifest identity conflict'), { code: 'DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT', causeCode: error.code });
      throw error;
    }
  };
  return withManifestPersistenceConnection(pool, execute);
}

export async function buildDatasetManifestV2({ pool, from, to, fixedAsOf, dryRun = false }) {
  const computed = await computeV2ManifestContentForRange({ pool, from, to, fixedAsOf });
  const validation = validateV2ManifestGroups(computed.groupStatistics);
  if (!validation.ok) return { status: 'REJECTED', errorCode: 'DATASET_MANIFEST_DEPENDENCY_INCOMPLETE', groupStatistics: computed.groupStatistics, mismatches: validation.mismatches };
  const window = canonicalV2LogicalWindow({ fixedAsOf, from, to, dependencySet: computed.dependencySet });
  const warnings = [];
  if (computed.duplicateBackfillBatchIdsRemoved) warnings.push(`duplicate backfillBatchIds removed: ${computed.duplicateBackfillBatchIdsRemoved}`);
  if (computed.duplicateDependenciesRemoved) warnings.push(`duplicate dependencies removed: ${computed.duplicateDependenciesRemoved}`);
  if (computed.duplicateManifestMembersRemoved) warnings.push(`duplicate manifest members removed: ${computed.duplicateManifestMembersRemoved}`);
  const inserted = dryRun ? false : await persist(pool, computed, window);
  return {
    status: dryRun ? 'DRY_RUN' : 'SUCCEEDED',
    datasetVersion: computed.datasetVersion,
    manifestContractVersion: 2,
    datasetType: MANIFEST_DATASET_TYPE,
    symbols: computed.symbols,
    dependencySet: computed.dependencySet,
    recordCount: computed.recordCount,
    perDependencyRecordCount: computed.perDependencyRecordCount,
    perDependencyIntegrityCheckResult: computed.perDependencyIntegrityCheckResult,
    fixedAsOf,
    inserted,
    logicalWindowIdentity: window.identity,
    logicalWindowHash: window.logicalWindowHash,
    groupStatistics: computed.groupStatistics,
    warnings
  };
}
