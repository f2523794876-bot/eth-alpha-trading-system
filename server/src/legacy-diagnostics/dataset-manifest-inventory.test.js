import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseLegacyWindowConflicts, inventoryDatasetManifests, legacyManifestInventorySql } from './dataset-manifest-inventory.js';

test('R28.24 legacy inventory is SELECT-only and explicitly marks v1 ineligible', async () => {
  const calls = [];
  const pool = { query: async sql => { calls.push(sql); return { rows: [{ dataset_version: 'legacy', manifest_contract_version: 1, symbol: 'ETHUSDT', symbols: null, dependency_set: null }] }; } };
  const rows = await inventoryDatasetManifests(pool);
  assert.equal(rows[0].eligibleForV2FeatureBackfill, false);
  assert.equal(rows[0].diagnosticStatus, 'LEGACY_READ_ONLY_NOT_ELIGIBLE_FOR_V2_FEATURE_BACKFILL');
  assert.match(legacyManifestInventorySql(), /^SELECT/);
  assert.doesNotMatch(calls[0], /\b(?:INSERT|UPDATE|DELETE)\b/i);
});

test('legacy conflict diagnosis is deterministic and does not mutate rows', () => {
  const rows = [{ datasetVersion: 'b', logicalWindowHash: 'x' }, { datasetVersion: 'a', logicalWindowHash: 'x' }];
  assert.deepEqual(diagnoseLegacyWindowConflicts(rows), [{ logicalWindowIdentity: 'x', datasetVersions: ['a', 'b'] }]);
  assert.equal(rows.length, 2);
});
