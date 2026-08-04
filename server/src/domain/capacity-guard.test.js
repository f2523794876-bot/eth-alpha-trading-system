import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { checkDiskCapacity, checkDatabaseCapacity } from './capacity-guard.js';

test('checkDiskCapacity：拒绝非法minFreeBytes配置（fail closed而非静默跳过）', () => {
  assert.throws(() => checkDiskCapacity({ path: os.tmpdir(), minFreeBytes: 0 }), e => e.code === 'CAPACITY_CHECK_MISCONFIGURED');
  assert.throws(() => checkDiskCapacity({ path: os.tmpdir(), minFreeBytes: -1 }), e => e.code === 'CAPACITY_CHECK_MISCONFIGURED');
  assert.throws(() => checkDiskCapacity({ path: os.tmpdir(), minFreeBytes: NaN }), e => e.code === 'CAPACITY_CHECK_MISCONFIGURED');
});

test('checkDiskCapacity：对当前系统真实磁盘执行一次真实statfs只读查询，返回结构化结果', () => {
  const result = checkDiskCapacity({ path: os.tmpdir(), minFreeBytes: 1 });
  assert.equal(result.ok, true);
  assert.ok(result.freeBytes > 0);
  assert.equal(result.minFreeBytes, 1);
});

test('checkDiskCapacity：要求的空间远大于实际可用空间时显式抛出DISK_CAPACITY_INSUFFICIENT，不静默返回ok', () => {
  const absurdlyLarge = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () => checkDiskCapacity({ path: os.tmpdir(), minFreeBytes: absurdlyLarge }),
    e => e.code === 'DISK_CAPACITY_INSUFFICIENT' && e.freeBytes < e.minFreeBytes
  );
});

function fakePool(sizeBytes) {
  return { async query() { return { rows: [{ size_bytes: String(sizeBytes) }] }; } };
}

test('checkDatabaseCapacity：拒绝非法estimatedGrowthBytes配置', async () => {
  await assert.rejects(checkDatabaseCapacity({ pool: fakePool(1000), estimatedGrowthBytes: 0 }), e => e.code === 'CAPACITY_CHECK_MISCONFIGURED');
});

test('checkDatabaseCapacity：返回当前库大小与所需headroom（默认2倍预计增长量），只执行一次只读SELECT', async () => {
  const queries = [];
  const pool = { async query(sql) { queries.push(sql); return { rows: [{ size_bytes: '104857600' }] }; } };
  const result = await checkDatabaseCapacity({ pool, estimatedGrowthBytes: 1000 });
  assert.equal(result.currentSizeBytes, 104857600);
  assert.equal(result.requiredHeadroomBytes, 2000);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^SELECT pg_database_size/);
  assert.doesNotMatch(queries[0], /INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|VACUUM/i);
});
