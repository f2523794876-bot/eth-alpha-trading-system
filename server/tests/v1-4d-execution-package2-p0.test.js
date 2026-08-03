import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillInterval } from '../src/backfill/binance-kline-backfill.js';
import { computeIntegrityBoundary } from '../src/backfill/integrity-check.js';
import { readFile } from 'node:fs/promises';
import { assertResumeBatchCompatible, main as backfillMain, parseUtc, runBackfillForInterval } from '../src/backfill/backfill-cli-entry.js';
import { main as manifestMain } from '../src/validation-replay/dataset-manifest-cli-entry.js';
import { canonicalManifestLogicalWindow, resolveManifestLogicalWindow, validateManifestGroupStatistics } from '../src/validation-replay/dataset-manifest-builder.js';

const M15 = 900_000;
const H1 = 3_600_000;
const AS_OF = Date.parse('2026-08-01T08:00:00.000Z');

function kline(openTime, step) {
  return [openTime, '1', '2', '0.5', '1.5', '10', openTime + step - 1, '15', 1, '5', '7.5'];
}

function adapter(rows, serverTime = AS_OF + 86_400_000) {
  return {
    serverTime: async () => ({ body: { serverTime }, requestId: 'time' }),
    spotKlines: async () => ({ body: rows, requestId: 'bars', status: 200, headers: {} })
  };
}

test('fixed 08:00Z as-of excludes 15m candle closing 08:14:59.999 even when server time is later', async () => {
  const from = AS_OF - M15;
  const out = await backfillInterval({ pool: { query: async () => { throw new Error('dry-run must not write'); } }, adapter: adapter([kline(from, M15), kline(AS_OF, M15)]), symbol: 'ETHUSDT', interval: '15m', startTime: from, endTime: AS_OF, requestedTo: AS_OF + 2 * M15, fixedAsOf: AS_OF, dryRun: true, now: () => AS_OF + 86_400_000 });
  assert.equal(out.rowsInserted, 1);
  assert.equal(out.boundary.lastAllowedCloseTime, AS_OF - 1);
  assert.equal(out.fixedAsOf, AS_OF);
});

test('fixed 08:00Z as-of excludes 1h candle closing 08:59:59.999', async () => {
  const from = AS_OF - H1;
  const out = await backfillInterval({ pool: { query: async () => { throw new Error('dry-run must not write'); } }, adapter: adapter([kline(from, H1), kline(AS_OF, H1)]), symbol: 'ETHUSDT', interval: '1h', startTime: from, endTime: AS_OF, requestedTo: AS_OF + 2 * H1, fixedAsOf: AS_OF, dryRun: true, now: () => AS_OF + 86_400_000 });
  assert.equal(out.rowsInserted, 1);
  assert.equal(out.boundary.lastExpectedOpenTime, from);
});

test('to/as-of safe intersection and UTC alignment are deterministic', () => {
  const earlierTo = computeIntegrityBoundary({ from: AS_OF - 2 * M15, to: AS_OF - M15, asOf: AS_OF, interval: '15m' });
  assert.equal(earlierTo.effectiveTo, AS_OF - M15);
  const laterTo = computeIntegrityBoundary({ from: AS_OF - M15, to: AS_OF + M15, asOf: AS_OF, interval: '15m' });
  assert.equal(laterTo.effectiveTo, AS_OF);
  assert.throws(() => computeIntegrityBoundary({ from: AS_OF + 1, to: AS_OF + M15, asOf: AS_OF + M15, interval: '15m' }), e => e.code === 'UNALIGNED_INTEGRITY_RANGE');
  assert.throws(() => parseUtc('2026-08-01T08:00:00+00:00', '--as-of'), e => e.code === 'INVALID_TIME_FORMAT');
});

test('formal Backfill and Manifest CLIs require explicit as-of before database access', async () => {
  let connected=false;const createPgPool=async()=>{connected=true;throw new Error('must not connect');};
  const argv=['--symbol','ETHUSDT','--intervals','15m','--from','2026-08-01T00:00:00Z','--to','2026-08-02T00:00:00Z'];
  await assert.rejects(()=>backfillMain(argv,{createPgPool}),e=>e.code==='AS_OF_REQUIRED');
  await assert.rejects(()=>manifestMain(['--contract-version','2','--from','2026-08-01T00:00:00Z','--to','2026-08-02T00:00:00Z'],{createPgPool}),e=>e.code==='AS_OF_REQUIRED');
  assert.equal(connected,false);
});

test('dry-run performs fetch/validation but issues zero database writes and reports as-of audit', async () => {
  const from = AS_OF - M15;
  let queries = 0;
  const result = await runBackfillForInterval({ pool: { query: async () => { queries += 1; throw new Error('unexpected query'); } }, adapter: adapter([kline(from, M15)]), symbol: 'ETHUSDT', interval: '15m', startTime: from, endTime: AS_OF, fixedAsOf: AS_OF, dryRun: true, now: () => AS_OF + 86_400_000 });
  assert.equal(queries, 0);
  assert.equal(result.status, 'DRY_RUN');
  assert.deepEqual(result.audit, { persisted: false, fixedAsOf: new Date(AS_OF).toISOString() });
});

test('resume accepts the persisted fixed as-of and rejects drift before source access', async () => {
  const batch = { symbol: 'ETHUSDT', interval_name: '15m', requested_start_utc: new Date(AS_OF - M15), requested_end_utc: new Date(AS_OF), fixed_as_of: new Date(AS_OF), status: 'RUNNING', last_completed_open_time: null };
  let sourceCalled = false;
  const pool = { query: async sql => sql.startsWith('SELECT *') ? { rowCount: 1, rows: [batch] } : { rowCount: 1, rows: [] } };
  await assert.rejects(() => runBackfillForInterval({ pool, adapter: { serverTime: async () => { sourceCalled = true; } }, symbol: 'ETHUSDT', interval: '15m', startTime: AS_OF - M15, endTime: AS_OF, fixedAsOf: AS_OF + 1, resumeBatchId: 'batch' }), e => e.code === 'BACKFILL_RESUME_AS_OF_MISMATCH');
  assert.equal(sourceCalled, false);
  assert.doesNotThrow(()=>assertResumeBatchCompatible(batch,{symbol:'ETHUSDT',interval:'15m',startTime:AS_OF-M15,endTime:AS_OF,fixedAsOf:AS_OF,backfillBatchId:'batch'}));
});

test('logical-window governance is idempotent for the same checksum and fail-closed for different content', async () => {
  const versionA=`v1.4d-sha256-${'a'.repeat(64)}`,versionB=`v1.4d-sha256-${'b'.repeat(64)}`;
  assert.equal(resolveManifestLogicalWindow([],versionA),'INSERT');
  assert.equal(resolveManifestLogicalWindow([versionA,versionA],versionA),'IDEMPOTENT');
  assert.throws(()=>resolveManifestLogicalWindow([versionA],versionB),e=>e.code==='DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT');
  const migration=await readFile(new URL('../migrations/006_v1_4d_execution_package2_governance.up.sql',import.meta.url),'utf8');
  assert.match(migration,/UNIQUE INDEX[\s\S]*logical_window_hash/i);
  assert.match(migration,/fixed_as_of timestamptz/i);
});

test('manifest logical identity ignores symbol/timeframe ordering and JSON insertion order', () => {
  const a = canonicalManifestLogicalWindow({ fixedAsOf: AS_OF, from: AS_OF - H1, to: AS_OF, symbols: ['ETHUSDT', 'BTCUSDT'], intervals: ['1h', '15m'] });
  const b = canonicalManifestLogicalWindow({ intervals: ['15m', '1h'], symbols: ['BTCUSDT', 'ETHUSDT'], to: AS_OF, from: AS_OF - H1, fixedAsOf: AS_OF });
  assert.equal(a.logicalWindowHash, b.logicalWindowHash);
  assert.deepEqual(a.identity, b.identity);
});

test('per-group counts cannot cancel across timeframes or symbols', () => {
  const stats = {
    'ETHUSDT:15m': { expectedRecordCount: 100, actualRecordCount: 172, countMatches: false, firstExpectedOpenTime: 1, firstActualOpenTime: 1, lastExpectedOpenTime: 2, lastActualOpenTime: 2 },
    'ETHUSDT:1h': { expectedRecordCount: 100, actualRecordCount: 28, countMatches: false, firstExpectedOpenTime: 1, firstActualOpenTime: 1, lastExpectedOpenTime: 2, lastActualOpenTime: 2 },
    'BTCUSDT:15m': { expectedRecordCount: 50, actualRecordCount: 50, countMatches: true, firstExpectedOpenTime: 1, firstActualOpenTime: 1, lastExpectedOpenTime: 2, lastActualOpenTime: 2 }
  };
  assert.equal(Object.values(stats).reduce((sum, x) => sum + x.expectedRecordCount, 0), Object.values(stats).reduce((sum, x) => sum + x.actualRecordCount, 0));
  const validation = validateManifestGroupStatistics(stats);
  assert.equal(validation.ok, false);
  assert.equal(validation.mismatches.length, 2);
});
