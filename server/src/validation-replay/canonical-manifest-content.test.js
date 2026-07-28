// R27.2/R27.3/R27.4/R27.5/R27.6/R27.8：canonical-manifest-content.js 确定性排序与类型纪律。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildCanonicalManifestContent, computeDatasetVersion, computeRowContentHash } from './canonical-manifest-content.js';

function baseArgs(overrides = {}) {
  const memberRow = (openTime, vintageId, revisionNumber = 0) => ({
    intervalName: '15m', openTime, vintageId, revisionNumber,
    open: '1845.6700', high: '1846.0000', low: '1845.0000', close: '1845.5000', volume: '10.5', quoteVolume: '19378.35'
  });
  return {
    symbol: 'ETHUSDT',
    intervals: ['15m'],
    dataFrom: '2026-01-01T00:00:00.000Z',
    dataTo: '2026-01-02T00:00:00.000Z',
    backfillBatchIds: [],
    manifestMemberRows: [
      memberRow(1000, '11111111-1111-1111-1111-111111111111'),
      memberRow(2000, '22222222-2222-2222-2222-222222222222')
    ],
    researchAvailabilityRuleVersion: 'v1.4d-research-availability-1',
    perIntervalRecordCount: { '15m': 2 },
    integrityCheckResult: { gapCount: 0, duplicateCount: 0, outOfOrderCount: 0 },
    ...overrides
  };
}

test('R27.2：backfillBatchIds不同输入顺序产生相同dataset_version', () => {
  const idA = randomUUID(), idB = randomUUID(), idC = randomUUID();
  const args1 = baseArgs({ backfillBatchIds: [idC, idA, idB] });
  const args2 = baseArgs({ backfillBatchIds: [idA, idB, idC] });
  const v1 = computeDatasetVersion(buildCanonicalManifestContent(args1).contentObject);
  const v2 = computeDatasetVersion(buildCanonicalManifestContent(args2).contentObject);
  assert.equal(v1, v2);
});

test('R27.3：manifestMemberRows不同输入顺序产生相同dataset_version', () => {
  const rows = baseArgs().manifestMemberRows;
  const forward = buildCanonicalManifestContent(baseArgs({ manifestMemberRows: rows })).contentObject;
  const reversed = buildCanonicalManifestContent(baseArgs({ manifestMemberRows: [...rows].reverse() })).contentObject;
  assert.equal(computeDatasetVersion(forward), computeDatasetVersion(reversed));
});

test('R27.4：intervalName/openTime/revisionNumber并列时，vintageId决胜排序不受输入顺序影响', () => {
  const vidLow = '00000000-0000-0000-0000-000000000001';
  const vidHigh = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const rowA = { intervalName: '15m', openTime: 1000, vintageId: vidLow, revisionNumber: 0, open: '1', high: '1', low: '1', close: '1', volume: '1', quoteVolume: '1' };
  const rowB = { intervalName: '15m', openTime: 1000, vintageId: vidHigh, revisionNumber: 0, open: '2', high: '2', low: '2', close: '2', volume: '2', quoteVolume: '2' };
  const order1 = buildCanonicalManifestContent(baseArgs({ manifestMemberRows: [rowA, rowB] }));
  const order2 = buildCanonicalManifestContent(baseArgs({ manifestMemberRows: [rowB, rowA] }));
  assert.equal(computeDatasetVersion(order1.contentObject), computeDatasetVersion(order2.contentObject));
  assert.deepEqual(order1.manifestMembers.map(m => m.vintageId), [vidLow, vidHigh]);
  assert.deepEqual(order2.manifestMembers.map(m => m.vintageId), [vidLow, vidHigh]);
});

test('R27.5：manifestHashAlgorithmVersion变化必须产生不同dataset_version', () => {
  const v1 = computeDatasetVersion(buildCanonicalManifestContent(baseArgs({ manifestHashAlgorithmVersion: 'v1.4d-manifest-hash-1' })).contentObject);
  const v2 = computeDatasetVersion(buildCanonicalManifestContent(baseArgs({ manifestHashAlgorithmVersion: 'v1.4d-manifest-hash-2' })).contentObject);
  assert.notEqual(v1, v2);
});

test('R27.6：manifestSchemaVersion变化必须产生不同dataset_version', () => {
  const v1 = computeDatasetVersion(buildCanonicalManifestContent(baseArgs({ manifestSchemaVersion: 'v1.4d-manifest-schema-1' })).contentObject);
  const v2 = computeDatasetVersion(buildCanonicalManifestContent(baseArgs({ manifestSchemaVersion: 'v1.4d-manifest-schema-2' })).contentObject);
  assert.notEqual(v1, v2);
});

test('R27.1：dataset_version前缀固定，摘要部分恰好64个十六进制字符（不截断）', () => {
  const version = computeDatasetVersion(buildCanonicalManifestContent(baseArgs()).contentObject);
  assert.match(version, /^v1\.4d-sha256-[0-9a-f]{64}$/);
});

test('R27.8：numeric字段以字符串形式传入manifestMembers/rowContentHash计算，dataFrom/dataTo为字符串', () => {
  const { contentObject } = buildCanonicalManifestContent(baseArgs());
  assert.equal(typeof contentObject.dataFrom, 'string');
  assert.equal(typeof contentObject.dataTo, 'string');
  for (const member of contentObject.manifestMembers) {
    assert.equal(typeof member.rowContentHash, 'string');
    assert.match(member.rowContentHash, /^[0-9a-f]{64}$/);
  }
});

test('R27.8：computeRowContentHash对非字符串numeric字段fail closed', () => {
  assert.throws(() => computeRowContentHash({ open: 1845.67, high: '1846', low: '1845', close: '1845.5', volume: '10.5', quoteVolume: '19378.35' }),
    (err) => err.code === 'MANIFEST_TYPE_DISCIPLINE_VIOLATION');
});

test('dataFrom/dataTo 传入 Date 对象时fail closed（不得静默toISOString）', () => {
  assert.throws(() => buildCanonicalManifestContent(baseArgs({ dataFrom: new Date() })),
    (err) => err.code === 'MANIFEST_TYPE_DISCIPLINE_VIOLATION');
});

test('内容完全不变时重复构建产生完全相同的dataset_version（幂等前提）', () => {
  const args = baseArgs();
  const v1 = computeDatasetVersion(buildCanonicalManifestContent(args).contentObject);
  const v2 = computeDatasetVersion(buildCanonicalManifestContent(args).contentObject);
  assert.equal(v1, v2);
});

test('intervals去重且按周期长度固定顺序排序，与输入顺序无关', () => {
  const a = buildCanonicalManifestContent(baseArgs({ intervals: ['4h', '15m', '1h', '15m'], perIntervalRecordCount: { '15m': 2, '1h': 0, '4h': 0 } }));
  assert.deepEqual(a.intervals, ['15m', '1h', '4h']);
});

// P2-2修复（独立复审）：未知interval必须fail closed，不得静默排到末尾后仍参与哈希计算。
test('P2-2红线：intervals含未知/拼写错误的interval（不在15m/1h/4h集合内）时fail closed（UNKNOWN_INTERVAL），不静默纳入哈希', () => {
  assert.throws(
    () => buildCanonicalManifestContent(baseArgs({ intervals: ['15m', '1d'] })),
    (err) => err.code === 'UNKNOWN_INTERVAL' && err.interval === '1d'
  );
  assert.throws(
    () => buildCanonicalManifestContent(baseArgs({ intervals: ['5m'] })),
    (err) => err.code === 'UNKNOWN_INTERVAL' && err.interval === '5m'
  );
});
