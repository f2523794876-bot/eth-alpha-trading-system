import { canonicalJsonHash } from '../domain/hash.js';

const INVENTORY_SQL = `SELECT dataset_version, manifest_contract_version, dataset_type, symbol, symbols, dependency_set, intervals,
       source_formal_semantics, logical_window_hash, data_from, data_to, fixed_as_of, created_at
FROM historical_validation.dataset_manifests
ORDER BY created_at`;

export function legacyManifestInventorySql() {
  return INVENTORY_SQL;
}

export async function inventoryDatasetManifests(pool) {
  const result = await pool.query(INVENTORY_SQL);
  return result.rows.map(row => ({
    datasetVersion: row.dataset_version,
    manifestContractVersion: Number(row.manifest_contract_version),
    datasetType: row.dataset_type,
    symbol: row.symbol,
    symbols: row.symbols,
    dependencySet: row.dependency_set,
    intervals: row.intervals,
    sourceFormalSemantics: row.source_formal_semantics,
    logicalWindowHash: row.logical_window_hash,
    dataFrom: row.data_from,
    dataTo: row.data_to,
    fixedAsOf: row.fixed_as_of,
    createdAt: row.created_at,
    eligibleForV2FeatureBackfill: Number(row.manifest_contract_version) === 2,
    diagnosticStatus: Number(row.manifest_contract_version) === 1 ? 'LEGACY_READ_ONLY_NOT_ELIGIBLE_FOR_V2_FEATURE_BACKFILL' : Number(row.manifest_contract_version) === 2 ? 'V2_MANIFEST' : 'UNSUPPORTED_CONTRACT_VERSION'
  }));
}

export function diagnoseLegacyWindowConflicts(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.logicalWindowHash || `legacy-null-window:${canonicalJsonHash({ contractVersion: 1, datasetType: row.datasetType || 'MARKET_BARS', symbol: row.symbol, intervals: [...new Set(row.intervals || [])].sort(), dataFrom: row.dataFrom instanceof Date ? row.dataFrom.toISOString() : row.dataFrom, dataTo: row.dataTo instanceof Date ? row.dataTo.toISOString() : row.dataTo, sourceFormalSemantics: row.sourceFormalSemantics || 'market_bars:formal:spot' })}`;
    const values = groups.get(key) || [];
    values.push(row.datasetVersion);
    groups.set(key, values);
  }
  return [...groups.entries()].filter(([, versions]) => versions.length > 1).map(([logicalWindowIdentity, datasetVersions]) => ({ logicalWindowIdentity, datasetVersions: [...datasetVersions].sort() })).sort((a,b)=>a.logicalWindowIdentity.localeCompare(b.logicalWindowIdentity));
}
