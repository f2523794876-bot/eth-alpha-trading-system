import test from 'node:test';
import assert from 'node:assert/strict';
import { findMarketBarContentConflicts, findFeatureRecordContentConflicts, buildIdempotencyAuditReport } from './idempotency-audit.js';

function fakePool(rowsByQuery) {
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      if (/FROM public\.market_bars/.test(sql)) return { rows: rowsByQuery.marketBars || [] };
      if (/FROM public\.feature_records/.test(sql)) return { rows: rowsByQuery.featureRecords || [] };
      throw new Error(`Unexpected query in fakePool: ${sql}`);
    }
  };
}

test('findMarketBarContentConflicts：无冲突时返回空数组，且只执行只读SELECT', async () => {
  const pool = fakePool({ marketBars: [] });
  const conflicts = await findMarketBarContentConflicts(pool);
  assert.deepEqual(conflicts, []);
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /^\s*SELECT/i);
  assert.doesNotMatch(pool.calls[0].sql, /INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE/i);
});

test('findMarketBarContentConflicts：同一逻辑bar出现多个distinct content_hash时如实上报', async () => {
  const pool = fakePool({
    marketBars: [{
      instrument: 'ETHUSDT', market_type: 'spot', interval_name: '15m',
      open_time: '2026-02-01T00:00:00Z', close_time: '2026-02-01T00:14:59.999Z',
      row_count: '2', distinct_hashes: '2',
      vintage_ids: ['ETHUSDT-spot-15m-t-rev0', 'ETHUSDT-spot-15m-t-rev0-dup'],
      content_hashes: ['hashA', 'hashB']
    }]
  });
  const conflicts = await findMarketBarContentConflicts(pool);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].distinctContentHashes, 2);
  assert.equal(conflicts[0].rowCount, 2);
});

test('findMarketBarContentConflicts：可选scope过滤条件正确拼接为参数化SQL（不做字符串拼接注入）', async () => {
  const pool = fakePool({ marketBars: [] });
  await findMarketBarContentConflicts(pool, { instrument: 'ETHUSDT', marketType: 'spot', intervalName: '15m' });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /WHERE instrument=\$1 AND market_type=\$2 AND interval_name=\$3/);
  assert.deepEqual(params, ['ETHUSDT', 'spot', '15m']);
});

test('findFeatureRecordContentConflicts：无冲突返回空数组', async () => {
  const pool = fakePool({ featureRecords: [] });
  const conflicts = await findFeatureRecordContentConflicts(pool);
  assert.deepEqual(conflicts, []);
});

test('findFeatureRecordContentConflicts：同一(symbol,interval,close_time,feature_set_version)多个content_hash时上报', async () => {
  const pool = fakePool({
    featureRecords: [{
      symbol: 'ETHUSDT', target_interval: '15m', target_bar_close_time: '2026-02-01T00:14:59.999Z',
      feature_set_version: 'v1.4b-unified-1', row_count: '2', distinct_hashes: '2',
      feature_record_ids: [1, 2], content_hashes: ['hashA', 'hashB']
    }]
  });
  const conflicts = await findFeatureRecordContentConflicts(pool);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].distinctContentHashes, 2);
});

test('buildIdempotencyAuditReport：聚合两类冲突并计算sameIdDifferentContentCount', async () => {
  const pool = fakePool({
    marketBars: [{
      instrument: 'ETHUSDT', market_type: 'spot', interval_name: '15m',
      open_time: 't1', close_time: 't2', row_count: '2', distinct_hashes: '2',
      vintage_ids: ['a', 'b'], content_hashes: ['h1', 'h2']
    }],
    featureRecords: [{
      symbol: 'ETHUSDT', target_interval: '15m', target_bar_close_time: 't3',
      feature_set_version: 'v1.4b-unified-1', row_count: '3', distinct_hashes: '2',
      feature_record_ids: [1, 2, 3], content_hashes: ['h1', 'h2']
    }]
  });
  const report = await buildIdempotencyAuditReport(pool);
  assert.equal(report.marketBarConflictGroupCount, 1);
  assert.equal(report.marketBarConflictRecordCount, 2);
  assert.equal(report.featureRecordConflictGroupCount, 1);
  assert.equal(report.featureRecordConflictRecordCount, 3);
  assert.equal(report.sameIdDifferentContentCount, 5);
  assert.ok(report.generatedAt);
});

test('buildIdempotencyAuditReport：全零冲突时sameIdDifferentContentCount=0（研究库GO门禁所需的形状）', async () => {
  const pool = fakePool({ marketBars: [], featureRecords: [] });
  const report = await buildIdempotencyAuditReport(pool);
  assert.equal(report.sameIdDifferentContentCount, 0);
});
