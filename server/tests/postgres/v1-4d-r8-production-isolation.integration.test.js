// R8.1/R8.2：回放执行（正常/dry-run/BLOCKED/失败拒绝）前后，生产public.forecast_snapshots/
// forecast_outcome_events/forecast_generation_runs/forecast_evaluation_runs/collector_leases五张表
// 必须逐行、逐字节不变——不仅行数不变，内容也不变（基于稳定排序的SHA-256哈希比对，而不仅仅是
// rowCount/COUNT(*)）。此前的验收只有"静态代码审查确认这些表从未被引用"，未对真实回放执行前后
// 做过运行时的内容级比对。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest } from '../../src/validation-replay/dataset-manifest-builder.js';
import { runWalkForward } from '../../src/validation-replay/cli-entry.js';
import { FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION } from '../../src/features/feature-version.js';
import { sha256 } from '../../src/domain/hash.js';

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(TEST_DATABASE_URL);
const FOUR_HOUR_MS = 14400000;
const FIFTEEN_MIN_MS = 900000;
const DAY_MS = 86400000;

const ALGORITHM_VERSION = 'v1.4c-server-po-rule-1';
const WEIGHT_VERSION = 'v1.4c-server-weight-1';
const RULE_VERSION = 'v1.4c-po-rule-1';
const EVALUATION_VERSION = 'v1.4c-outcome-evaluation-1';

// 五张生产表 + 各自主键（用于ORDER BY，消除物理存储顺序对哈希结果的影响）。
const PRODUCTION_TABLES = Object.freeze([
  { table: 'forecast_snapshots', pk: 'forecast_snapshot_id' },
  { table: 'forecast_outcome_events', pk: 'forecast_outcome_event_id' },
  { table: 'forecast_generation_runs', pk: 'generation_run_id' },
  { table: 'forecast_evaluation_runs', pk: 'evaluation_run_id' },
  { table: 'collector_leases', pk: 'lease_name' }
]);

function stableRow(row) {
  const normalized = {};
  for (const key of Object.keys(row).sort()) {
    const value = row[key];
    normalized[key] = value instanceof Date ? value.toISOString() : value;
  }
  return JSON.stringify(normalized);
}

async function snapshotProductionTables(client) {
  const snapshot = {};
  for (const { table, pk } of PRODUCTION_TABLES) {
    const result = await client.query(`SELECT * FROM ${table} ORDER BY ${pk} ASC`);
    const rowCount = result.rowCount;
    const contentHash = createHash('sha256').update(result.rows.map(stableRow).join('\n')).digest('hex');
    snapshot[table] = { rowCount, contentHash };
  }
  return snapshot;
}

function assertProductionTablesUnchanged(before, after, label) {
  for (const { table } of PRODUCTION_TABLES) {
    assert.equal(after[table].rowCount, before[table].rowCount, `${label}: ${table}行数必须不变`);
    assert.equal(after[table].contentHash, before[table].contentHash, `${label}: ${table}内容哈希必须不变（基于稳定排序，行数相同不代表内容未变）`);
  }
}

function makeMockAdapter({ pages, serverTimeMs }) {
  let call = 0;
  return {
    serverTime: async () => ({ body: { serverTime: serverTimeMs }, requestId: randomUUID() }),
    spotKlines: async () => { const page = pages[call] || []; call += 1; return { body: page, requestId: randomUUID(), status: 200, headers: {} }; }
  };
}
function kline(openTime, closeTime, closeStr = '1000.00') {
  return [openTime, '999.00', '2000.00', '500.00', closeStr, '10.5', closeTime, '10500.00', 5, '5.0', '5000.00'];
}
async function withTxClient(fn) {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const client = await pool.connect();
  try { await client.query('BEGIN'); await fn(client); }
  finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
}

async function seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime }) {
  await client.query(
    `INSERT INTO feature_sets(feature_set_version, algorithm_version, schema_version, definition, definition_hash)
     VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(feature_set_version) DO NOTHING`,
    [FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, 'v1.4b-schema-1', JSON.stringify({}), sha256({})]
  );
  const featureValues = {
    closeToEma5: 0, trend4h: 'DOWN', trend1h: 'DOWN', volumeRatio20: 1,
    swingHigh: 1100, swingLow: 900, breakoutState: null, upperWickRatio: 0.1, lowerWickRatio: 0.1,
    distanceToSupportAtr: 5, distanceToResistanceAtr: 5, falseBreakoutRisk: 'NONE',
    btcTrendState: 'RANGE', ethBtcRollingCorrelation: 0, logReturn1: 0
  };
  await client.query(
    `INSERT INTO feature_records(
       feature_id, symbol, target_interval, target_bar_open_time, target_bar_close_time, as_of_time, generated_at,
       feature_set_version, algorithm_version, source_dataset_version, completeness, quality_state, feature_values, availability, content_hash
     ) VALUES($1,'ETHUSDT','15m',to_timestamp($2/1000.0),to_timestamp($3/1000.0),to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6,$7,$8,1,'HEALTHY',$9::jsonb,'{}'::jsonb,$10)
     ON CONFLICT DO NOTHING`,
    [
      `feature-${referenceCloseTime}`, referenceCloseTime - FIFTEEN_MIN_MS + 1, referenceCloseTime, historicalAsOfTime, historicalAsOfTime,
      FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION, JSON.stringify(featureValues), sha256(featureValues)
    ]
  );
}
async function seedRhythmPoint(client, { referenceCloseTime, replayNowMs, withFeature = true }) {
  const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
  const refAdapter = makeMockAdapter({ pages: [[kline(referenceOpenTime, referenceCloseTime, '1000.00')]], serverTimeMs: replayNowMs });
  await backfillInterval({ pool: client, adapter: refAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: referenceOpenTime, endTime: referenceOpenTime, now: () => replayNowMs });

  const count = 15;
  const bars = [];
  for (let i = count - 1; i >= 0; i--) {
    const closeTime = referenceCloseTime - i * FOUR_HOUR_MS;
    bars.push(kline(closeTime - FOUR_HOUR_MS + 1, closeTime, (1000 + i).toFixed(2)));
  }
  const start = referenceCloseTime - (count - 1) * FOUR_HOUR_MS - FOUR_HOUR_MS + 1;
  const atrAdapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
  await backfillInterval({ pool: client, adapter: atrAdapter, symbol: 'ETHUSDT', interval: '4h', startTime: start, endTime: referenceCloseTime, now: () => replayNowMs });

  if (withFeature) await seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime: referenceCloseTime });
}
async function fillContiguousCoverage(client, { from, to, replayNowMs }) {
  for (const [interval, stepMs] of [['15m', FIFTEEN_MIN_MS], ['4h', FOUR_HOUR_MS]]) {
    const bars = [];
    for (let openTime = from; openTime < to; openTime += stepMs) bars.push(kline(openTime, openTime + stepMs - 1, '1000.00'));
    if (!bars.length) continue;
    const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval, startTime: from, endTime: to - stepMs, now: () => replayNowMs });
  }
}
async function buildVerifiedManifest(client, { from, to, replayNowMs = Date.now() }) {
  await fillContiguousCoverage(client, { from, to, replayNowMs });
  const result = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m', '4h'], from, to });
  assert.equal(result.status, 'SUCCEEDED', 'manifest构建必须成功（前置bar数据必须无缺口）');
  return result.datasetVersion;
}

test('R8.1/R8.2-正常回放：真实生成+评估一个完整节点，前后五张生产表逐行内容哈希不变', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 6, 5, 0, 0, 0);
    const referenceCloseTime = base - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });
    const pathStart = referenceCloseTime + 1;
    const bars = [];
    for (let i = 0; i < 96; i++) { const o = pathStart + i * FIFTEEN_MIN_MS; bars.push(kline(o, o + FIFTEEN_MIN_MS - 1, '1000.00')); }
    const pathAdapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter: pathAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: pathStart, endTime: pathStart + 96 * FIFTEEN_MIN_MS, now: () => replayNowMs });

    const from = referenceCloseTime - DAY_MS + 1;
    const to = referenceCloseTime + 2 * DAY_MS + 1;
    const datasetVersion = await buildVerifiedManifest(client, { from, to, replayNowMs });

    const before = await snapshotProductionTables(client);

    const plan = await runWalkForward({
      pool: client, dryRun: false, resumeValidationRunId: null,
      explicitParams: { symbol: 'ETHUSDT', horizons: ['24h'], fromUtc: from, toUtc: to, algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION },
      weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, nowMs: Date.now(), replayNowMs
    });
    const runRow = (await client.query('SELECT status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [plan.validationRunId])).rows[0];
    assert.equal(runRow.status, 'SUCCEEDED', '前提确认：回放本身必须真实成功完成（含实际生成+评估），而不是提前失败的空转');
    const snapshotCount = (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots')).rows[0].n;
    assert.ok(snapshotCount > 0, '前提确认：必须真实产出至少一条replay_snapshot');

    const after = await snapshotProductionTables(client);
    assertProductionTablesUnchanged(before, after, '正常回放');
  });
});

test('R8.1/R8.2-dry-run回放：五张生产表逐行内容哈希不变', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 6, 8, 0, 0, 0);
    const referenceCloseTime = base - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - DAY_MS + 1;
    const to = referenceCloseTime + DAY_MS + 1;
    const datasetVersion = await buildVerifiedManifest(client, { from, to, replayNowMs });

    const before = await snapshotProductionTables(client);

    const plan = await runWalkForward({
      pool: client, dryRun: true, resumeValidationRunId: null,
      explicitParams: { symbol: 'ETHUSDT', horizons: ['24h'], fromUtc: from, toUtc: to, algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION },
      weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, nowMs: Date.now(), replayNowMs
    });
    assert.equal(plan.dryRun, true);

    const after = await snapshotProductionTables(client);
    assertProductionTablesUnchanged(before, after, 'dry-run回放');
  });
});

test('R8.1/R8.2-BLOCKED路径：缺少精确匹配的feature_record导致生成被BLOCKED，五张生产表逐行内容哈希仍不变', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 6, 12, 0, 0, 0);
    const referenceCloseTime = base - 1;
    const replayNowMs = Date.now();
    // withFeature:false——故意不写入feature_records，触发generateReplaySnapshot()的
    // FEATURE_RECORD_MISSING BLOCKED分支（历史回放对缺失特征一次性fail closed，不重试等待）。
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs, withFeature: false });
    const from = referenceCloseTime - DAY_MS + 1;
    const to = referenceCloseTime + DAY_MS + 1;
    const datasetVersion = await buildVerifiedManifest(client, { from, to, replayNowMs });

    const before = await snapshotProductionTables(client);

    const plan = await runWalkForward({
      pool: client, dryRun: false, resumeValidationRunId: null,
      explicitParams: { symbol: 'ETHUSDT', horizons: ['24h'], fromUtc: from, toUtc: to, algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION },
      weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, nowMs: Date.now(), replayNowMs
    });
    const generationResult = plan.results.find(r => r.phase === 'generation');
    assert.equal(generationResult.status, 'BLOCKED', '前提确认：本场景必须真实触发BLOCKED，而不是意外SUCCEEDED');

    const after = await snapshotProductionTables(client);
    assertProductionTablesUnchanged(before, after, 'BLOCKED路径');
  });
});

test('R8.1/R8.2-失败/前置校验拒绝路径：dataset_version不存在导致manifest gate在任何推进前fail closed，五张生产表逐行内容哈希仍不变', { skip }, async () => {
  await withTxClient(async (client) => {
    const from = Date.UTC(2026, 6, 15), to = Date.UTC(2026, 6, 16);
    const before = await snapshotProductionTables(client);

    await assert.rejects(
      runWalkForward({
        pool: client, dryRun: false, resumeValidationRunId: null,
        explicitParams: { symbol: 'ETHUSDT', horizons: ['24h'], fromUtc: from, toUtc: to, algorithmVersion: ALGORITHM_VERSION, datasetVersion: 'v1.4d-sha256-' + '0'.repeat(64), ruleVersion: RULE_VERSION },
        weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, nowMs: Date.now()
      }),
      (e) => e.code === 'DATASET_MANIFEST_NOT_FOUND'
    );

    const after = await snapshotProductionTables(client);
    assertProductionTablesUnchanged(before, after, '失败/前置校验拒绝路径');
  });
});
