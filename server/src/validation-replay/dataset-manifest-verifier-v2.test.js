import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDatasetManifest } from './dataset-manifest-verifier.js';
import { compareCanonicalV2ManifestMembers } from './dataset-manifest-verifier-v2.js';
import { authoritativeDependencySet } from './multi-symbol-manifest-contract.js';
import { canonicalV2LogicalWindow } from './dataset-manifest-v2.js';

const VERSION = `v1.4d-sha256-${'a'.repeat(64)}`;
const FROM = 1_700_000_000_000, TO = 1_700_000_900_000, FIXED_AS_OF = TO - 1;
const WINDOW_HASH = canonicalV2LogicalWindow({ from: FROM, to: TO, fixedAsOf: FIXED_AS_OF }).logicalWindowHash;
const manifest = extra => ({
  dataset_version: VERSION,
  manifest_contract_version: 2,
  manifest_schema_version: 'v1.4d-manifest-schema-2',
  dataset_type: 'MARKET_BARS',
  symbols: ['BTCUSDT', 'ETHUSDT'],
  dependency_set: authoritativeDependencySet(),
  data_from: new Date(FROM),
  data_to: new Date(TO),
  fixed_as_of: new Date(FIXED_AS_OF),
  source_formal_semantics: 'market_bars:formal:spot',
  logical_window_hash: WINDOW_HASH,
  manifest_members: [],
  ...extra
});
const poolFor = row => ({ query: async () => ({ rowCount: row ? 1 : 0, rows: row ? [row] : [] }) });

const canonicalMembers = authoritativeDependencySet().map((dependency, index) => ({
  symbol: dependency.symbol,
  intervalName: dependency.interval,
  marketType: dependency.marketType,
  source: dependency.source,
  openTime: FROM + index * 10_000,
  closeTime: FROM + index * 10_000 + 9_999,
  revisionNumber: index,
  vintageId: `vintage-${index}`,
  rowContentHash: String(index + 1).repeat(64)
}));

function expectMemberMismatch(storedMembers) {
  const result = compareCanonicalV2ManifestMembers(storedMembers, canonicalMembers);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DATASET_MANIFEST_MEMBER_CONTENT_MISMATCH');
}

test('v2 member binding canonicalizes order and binds every frozen identity field', () => {
  assert.equal(compareCanonicalV2ManifestMembers([...canonicalMembers].reverse(), canonicalMembers).ok, true);

  const mutations = [
    ['vintageId', 'foreign-vintage'],
    ['rowContentHash', 'f'.repeat(64)],
    ['symbol', 'SOLUSDT'],
    ['intervalName', '5m'],
    ['marketType', 'futures'],
    ['source', 'foreign-source'],
    ['openTime', canonicalMembers[0].openTime + 1],
    ['closeTime', canonicalMembers[0].closeTime + 1],
    ['revisionNumber', canonicalMembers[0].revisionNumber + 1],
    ['unexpectedIdentityField', 'not-frozen']
  ];
  for (const [field, value] of mutations) {
    const stored = canonicalMembers.map(member => ({ ...member }));
    stored[0][field] = value;
    expectMemberMismatch(stored);
  }

  const crossPaired = canonicalMembers.map(member => ({ ...member }));
  [crossPaired[0].vintageId, crossPaired[1].vintageId] = [crossPaired[1].vintageId, crossPaired[0].vintageId];
  [crossPaired[0].rowContentHash, crossPaired[1].rowContentHash] = [crossPaired[1].rowContentHash, crossPaired[0].rowContentHash];
  expectMemberMismatch(crossPaired);
});

test('v2 member binding rejects duplicate, missing and extra members', () => {
  expectMemberMismatch([...canonicalMembers, { ...canonicalMembers[0] }]);
  expectMemberMismatch(canonicalMembers.slice(1));
  expectMemberMismatch([...canonicalMembers, {
    ...canonicalMembers[0],
    openTime: canonicalMembers[0].openTime + 20_000,
    closeTime: canonicalMembers[0].closeTime + 20_000,
    vintageId: 'extra-vintage',
    rowContentHash: 'e'.repeat(64)
  }]);
});

test('R28.2/R28.8/R28.9 unknown and legacy contracts fail closed before feature input queries', async () => {
  const unknown = await verifyDatasetManifest({ pool: poolFor(manifest({ manifest_contract_version: 3 })), datasetVersion: VERSION, requiredContractVersion: 2 });
  assert.equal(unknown.errorCode, 'DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED');
  const legacy = await verifyDatasetManifest({ pool: poolFor(manifest({ manifest_contract_version: 1 })), datasetVersion: VERSION, requiredContractVersion: 2 });
  assert.equal(legacy.errorCode, 'DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED');
});

test('R28.3 verifier rejects an ETH-only dependency set', async () => {
  const result = await verifyDatasetManifest({
    pool: poolFor(manifest({ dependency_set: authoritativeDependencySet().filter(value => value.symbol === 'ETHUSDT') })),
    datasetVersion: VERSION, requiredContractVersion: 2
  });
  assert.equal(result.errorCode, 'DATASET_MANIFEST_DEPENDENCY_UNGOVERNED');
});

test('v2 verifier distinguishes missing member identity from incomplete dependency integrity', async () => {
  const missing = await verifyDatasetManifest({ pool: poolFor(manifest({ manifest_members: [{}] })), datasetVersion: VERSION, requiredContractVersion: 2 });
  assert.equal(missing.errorCode, 'DATASET_MANIFEST_MEMBER_IDENTITY_MISSING');
  const member = {
    symbol: 'BTCUSDT', intervalName: '15m', marketType: 'spot', source: 'binance-spot',
    openTime: 1, closeTime: 2, revisionNumber: 0, vintageId: 'btc', rowContentHash: 'b'.repeat(64)
  };
  const counts = { 'BTCUSDT:15m': 1, 'ETHUSDT:15m': 1, 'ETHUSDT:1h': 1, 'ETHUSDT:4h': 1 };
  const members = authoritativeDependencySet().map((dependency, index) => ({
    ...member, symbol: dependency.symbol, intervalName: dependency.interval, openTime: index + 1,
    closeTime: index + 2, vintageId: `v${index}`
  }));
  const integrity = Object.fromEntries(Object.keys(counts).map(key => [key, { gapCount: key === 'BTCUSDT:15m' ? 1 : 0, duplicateCount: 0, outOfOrderCount: 0 }]));
  const incomplete = await verifyDatasetManifest({
    pool: poolFor(manifest({ manifest_members: members, per_interval_record_count: counts, integrity_check_result: integrity })),
    datasetVersion: VERSION, requiredContractVersion: 2
  });
  assert.equal(incomplete.errorCode, 'DATASET_MANIFEST_DEPENDENCY_INCOMPLETE');
});
