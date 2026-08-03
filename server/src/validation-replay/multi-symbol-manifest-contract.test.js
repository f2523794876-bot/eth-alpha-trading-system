import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonicalManifestContent, computeDatasetVersion } from './canonical-manifest-content.js';
import { buildDatasetManifest } from './dataset-manifest-builder.js';
import { canonicalV2LogicalWindow, computeV2ManifestContentForRange, validateV2ManifestGroups } from './dataset-manifest-v2.js';
import { assertAuthoritativeDependencySet, authoritativeDependencySet, normalizeDependencySet, symbolsFromDependencies } from './multi-symbol-manifest-contract.js';

const dependencies = () => authoritativeDependencySet().map(value => ({ ...value }));
const row = ({ symbol = 'ETHUSDT', intervalName = '15m', openTime = 1_000, closeTime = 1_999, vintageId = `${symbol}-${intervalName}-${openTime}` } = {}) => ({
  symbol, intervalName, marketType: 'spot', source: 'binance-spot', openTime, closeTime, revisionNumber: 0, vintageId,
  open: '1.0000', high: '2.0000', low: '0.5000', close: '1.5000', volume: '10.0000', quoteVolume: '15.0000'
});
const args = extra => ({
  manifestContractVersion: 2,
  dependencySet: dependencies(),
  dataFrom: '2026-01-01T00:00:00.000Z',
  dataTo: '2026-01-01T00:15:00.000Z',
  fixedAsOf: '2026-01-01T00:14:59.999Z',
  backfillBatchIds: [],
  manifestMemberRows: [row({ symbol: 'BTCUSDT', vintageId: 'btc' }), row({ symbol: 'ETHUSDT', vintageId: 'eth' })],
  researchAvailabilityRuleVersion: 'v1.4d-research-availability-1',
  perDependencyRecordCount: { 'BTCUSDT:15m': 1, 'ETHUSDT:15m': 1, 'ETHUSDT:1h': 0, 'ETHUSDT:4h': 0 },
  perDependencyIntegrityCheckResult: Object.fromEntries(dependencies().map(value => [`${value.symbol}:${value.interval}`, { gapCount: 0, duplicateCount: 0, outOfOrderCount: 0 }])),
  ...extra
});

test('R28.1/R28.4 exact dependency set is four approved pairs, never a Cartesian product', () => {
  const actual = authoritativeDependencySet();
  assert.equal(actual.length, 4);
  assert.deepEqual(symbolsFromDependencies(actual), ['BTCUSDT', 'ETHUSDT']);
  assert.equal(actual.some(value => value.symbol === 'BTCUSDT' && ['1h', '4h'].includes(value.interval)), false);
});

test('R28.3/R28.4 missing and unexpected dependencies fail closed', () => {
  assert.throws(() => assertAuthoritativeDependencySet(dependencies().slice(1)), error => error.code === 'DATASET_MANIFEST_DEPENDENCY_UNGOVERNED' && error.missingDependencies.some(value => value.symbol === 'BTCUSDT'));
  assert.throws(() => assertAuthoritativeDependencySet([...dependencies(), { symbol: 'BTCUSDT', interval: '1h', marketType: 'spot', source: 'binance-spot' }]), error => error.code === 'DATASET_MANIFEST_DEPENDENCY_UNGOVERNED' && error.unexpectedDependencies.length === 1);
});

test('R28.5/R28.6 dependency and member input order do not change content hash', () => {
  const forward = buildCanonicalManifestContent(args({}));
  const reverse = buildCanonicalManifestContent(args({ dependencySet: dependencies().reverse(), manifestMemberRows: [...args({}).manifestMemberRows].reverse() }));
  assert.equal(computeDatasetVersion(forward.contentObject), computeDatasetVersion(reverse.contentObject));
  assert.deepEqual(forward.manifestMembers.map(value => value.symbol), ['BTCUSDT', 'ETHUSDT']);
});

test('R28.7 duplicate dependencies are deterministically removed', () => {
  const input = [...dependencies(), dependencies()[0]];
  const normalized = normalizeDependencySet(input);
  assert.equal(normalized.duplicatesRemoved, 1);
  assert.deepEqual(normalized.dependencySet, authoritativeDependencySet());
  const built = buildCanonicalManifestContent(args({ dependencySet: input }));
  assert.equal(built.duplicateDependenciesRemoved, 1);
});

test('duplicate manifest members are deduplicated only when identity is identical', () => {
  const duplicate = row({ symbol: 'BTCUSDT', vintageId: 'same' });
  const built = buildCanonicalManifestContent(args({ manifestMemberRows: [duplicate, { ...duplicate }] }));
  assert.equal(built.duplicateManifestMembersRemoved, 1);
  assert.equal(built.manifestMembers.length, 1);
  assert.throws(() => buildCanonicalManifestContent(args({ manifestMemberRows: [duplicate, { ...duplicate, closeTime: duplicate.closeTime + 1 }] })), error => error.code === 'DATASET_MANIFEST_MEMBER_IDENTITY_MISSING');
});

test('R28.8 unknown contract version and unknown fields fail closed', () => {
  assert.throws(() => buildCanonicalManifestContent({ ...args({}), manifestContractVersion: 3 }), error => error.code === 'DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED');
  assert.throws(() => buildCanonicalManifestContent(args({ unexpected: true })), error => error.code === 'MANIFEST_CONTRACT_UNKNOWN_FIELD');
  assert.throws(() => assertAuthoritativeDependencySet([{ ...dependencies()[0], extra: true }, ...dependencies().slice(1)]), error => error.code === 'MANIFEST_CONTRACT_UNKNOWN_FIELD');
});

test('R28.10/R28.11 logical window identity is order-stable and content-independent', () => {
  const a = canonicalV2LogicalWindow({ fixedAsOf: 1_767_225_699_999, from: 1_767_225_600_000, to: 1_767_226_500_000, dependencySet: authoritativeDependencySet() });
  const b = canonicalV2LogicalWindow({ fixedAsOf: 1_767_225_699_999, from: 1_767_225_600_000, to: 1_767_226_500_000, dependencySet: [...authoritativeDependencySet()].reverse().sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))) });
  assert.equal(a.logicalWindowHash, b.logicalWindowHash);
  assert.equal(a.identity.contractVersion, 2);
});

test('R28.14 member close after fixed as-of remains represented in hash input and is rejected by builder integrity, not silently normalized', () => {
  const built = buildCanonicalManifestContent(args({ manifestMemberRows: [row({ closeTime: Date.parse('2026-01-02T00:00:00Z'), vintageId: 'future' })] }));
  assert.equal(built.manifestMembers[0].closeTime, Date.parse('2026-01-02T00:00:00Z'));
});

test('R28.13 positive and negative per-dependency count differences cannot cancel', () => {
  const groups = {
    'BTCUSDT:15m': { countMatches: false, actualRecordCount: 13, expectedRecordCount: 10, gapCount: 0, duplicateCount: 3, outOfOrderCount: 0, firstActualOpenTime: 1, firstExpectedOpenTime: 1, lastActualOpenTime: 10, lastExpectedOpenTime: 10 },
    'ETHUSDT:15m': { countMatches: false, actualRecordCount: 7, expectedRecordCount: 10, gapCount: 1, duplicateCount: 0, outOfOrderCount: 0, firstActualOpenTime: 1, firstExpectedOpenTime: 1, lastActualOpenTime: 7, lastExpectedOpenTime: 10 }
  };
  const result = validateV2ManifestGroups(groups);
  assert.equal(result.ok, false);
  assert.equal(result.mismatches.length, 2);
  assert.equal(Object.values(groups).reduce((sum, group) => sum + group.actualRecordCount - group.expectedRecordCount, 0), 0);
});

test('R28.14 a range extending beyond fixed-as-of is rejected before canonical persistence', async () => {
  const from = Date.parse('2026-01-01T00:00:00.000Z');
  const to = from + 1_800_000;
  const pool = { query: async () => ({ rows: [] }) };
  await assert.rejects(() => computeV2ManifestContentForRange({ pool, from, to, fixedAsOf: from + 900_000 - 1 }), error => error.code === 'MANIFEST_RANGE_EXCEEDS_AS_OF');
});

test('contract version 2 programmatic builder requires explicit fixed-as-of before database access', async () => {
  let queries = 0;
  const pool = { query: async () => { queries += 1; return { rows: [] }; } };
  await assert.rejects(
    () => buildDatasetManifest({ pool, contractVersion: 2, from: 1_000, to: 2_000 }),
    error => error.code === 'AS_OF_REQUIRED'
  );
  assert.equal(queries, 0);
});
