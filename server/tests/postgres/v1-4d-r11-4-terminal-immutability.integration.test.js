// R11.4：四张状态机表（validation_runs/backfill_batches/replay_generation_runs/replay_evaluation_runs）
// 终态不可变——真实PostgreSQL验证。覆盖两个已修复的真实生产缺陷（backfill_batches/validation_runs
// 的--resume此前会静默复活终态行）以及replay_generation_runs/replay_evaluation_runs的结构性证明
// （新鲜UUID每次尝试重新生成，不存在"沿用旧ID二次写入"的调用路径）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { runBackfillForInterval } from '../../src/backfill/backfill-cli-entry.js';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { runWalkForward } from '../../src/validation-replay/cli-entry.js';
import { generateReplaySnapshot } from '../../src/validation-replay/replay-generator.js';
import { evaluateReplayOutcomes } from '../../src/validation-replay/replay-evaluator.js';
import { buildDatasetManifest, computeManifestContentForRange } from '../../src/validation-replay/dataset-manifest-builder.js';
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

// R11.4验收要求"整行稳定序列化结果完全一致"——键排序 + Date归一化为ISO字符串，避免JS Date对象
// 引用不同但代表同一时刻时被误判为"变化"，也避免JSON.stringify因插入顺序不同产生假阳性差异。
function stableRow(row) {
  const normalized = {};
  for (const key of Object.keys(row).sort()) {
    const value = row[key];
    normalized[key] = value instanceof Date ? value.toISOString() : value;
  }
  return JSON.stringify(normalized);
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

const BUSINESS_TABLES = Object.freeze([
  'replay_snapshots', 'replay_generation_runs', 'replay_outcome_events', 'replay_evaluation_runs', 'validation_reports'
]);
async function countBusinessTables(client) {
  const counts = {};
  for (const table of BUSINESS_TABLES) {
    counts[table] = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.${table}`)).rows[0].n;
  }
  return counts;
}

async function seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime }) {
  await client.query(
    `INSERT INTO feature_sets(feature_set_version, algorithm_version, schema_version, definition, definition_hash)
     VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(feature_set_version) DO NOTHING`,
    [FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, 'v1.4b-schema-1', JSON.stringify({}), sha256({})]
  );
  const featureValues = {
    closeToEma5: 0, trend4h: 'down', trend1h: 'down', volumeRatio20: 1,
    swingHigh: 1100, swingLow: 900, breakoutState: null, upperWickRatio: 0.1, lowerWickRatio: 0.1,
    distanceToSupportAtr: 5, distanceToResistanceAtr: 5, falseBreakoutRisk: 'NONE',
    btcTrendState: 'flat', ethBtcRollingCorrelation: 0, logReturn1: 0
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
async function seedRhythmPoint(client, { referenceCloseTime, replayNowMs }) {
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

  await seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime: referenceCloseTime });
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

async function insertTerminalValidationRun(client, { validationRunId, datasetVersion, from, to, status, errorCode = null }) {
  await client.query(
    `INSERT INTO historical_validation.validation_runs(
       validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version,
       dry_run, status, error_code, created_at, started_at, finished_at
     ) VALUES($1,$2,'ETH','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,false,$7,$8,now(),now(),now())`,
    [validationRunId, datasetVersion, from, to, ALGORITHM_VERSION, RULE_VERSION, status, errorCode]
  );
}

// ===========================================================================
// A. backfill_batches — 三个终态（SUCCEEDED/FAILED/ATTENTION_REQUIRED）均须对--resume fail-closed，
//    RUNNING仍可正常resume。对应server/src/backfill/backfill-cli-entry.js的REAL_IMPLEMENTATION_DEFECT_FOUND修复。
// ===========================================================================

test('R11.4-backfill-SUCCEEDED：终态行二次--resume必须fail-closed且逐字段不变', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 6, 1, 0, 0, 0);
    const bar0Open = base, bar0Close = base + FIFTEEN_MIN_MS - 1;
    const nowMs = bar0Close + 60000;
    const adapter = makeMockAdapter({ pages: [[kline(bar0Open, bar0Close)]], serverTimeMs: nowMs });
    const first = await runBackfillForInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar0Open + FIFTEEN_MIN_MS, now: () => nowMs });
    assert.equal(first.status, 'SUCCEEDED');

    const before = (await client.query('SELECT * FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [first.backfillBatchId])).rows[0];
    const marketBarsBefore = (await client.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n;

    let resumeAdapterCalled = false;
    const resumeAdapter = { serverTime: async () => { resumeAdapterCalled = true; throw new Error('must not be called — rejection must happen before backfillInterval()'); } };
    await assert.rejects(
      runBackfillForInterval({ pool: client, adapter: resumeAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar0Open + FIFTEEN_MIN_MS, resumeBatchId: first.backfillBatchId, now: () => nowMs }),
      (e) => e.code === 'BACKFILL_RESUME_ALREADY_TERMINAL' && e.currentStatus === 'SUCCEEDED'
    );
    assert.equal(resumeAdapterCalled, false, 'backfillInterval()（及其内部adapter.serverTime()）不得被调用');

    const after = (await client.query('SELECT * FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [first.backfillBatchId])).rows[0];
    assert.equal(stableRow(after), stableRow(before), '终态行必须逐字段不变（含status/finished_at/rows_inserted等全部列）');
    const marketBarsAfter = (await client.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n;
    assert.equal(marketBarsAfter, marketBarsBefore, 'market_bars不得被拒绝的resume尝试改变');
  });
});

test('R11.4-backfill-FAILED：终态行二次--resume必须fail-closed且逐字段不变', { skip }, async () => {
  await withTxClient(async (client) => {
    const firstAdapter = { serverTime: async () => { throw Object.assign(new Error('down'), { code: 'NETWORK_ERROR' }); }, spotKlines: async () => { throw new Error('must not be called'); } };
    const first = await runBackfillForInterval({ pool: client, adapter: firstAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: 0, endTime: FIFTEEN_MIN_MS });
    assert.equal(first.status, 'FAILED');

    const before = (await client.query('SELECT * FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [first.backfillBatchId])).rows[0];

    let resumeAdapterCalled = false;
    const resumeAdapter = { serverTime: async () => { resumeAdapterCalled = true; throw new Error('must not be called'); } };
    await assert.rejects(
      runBackfillForInterval({ pool: client, adapter: resumeAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: 0, endTime: FIFTEEN_MIN_MS, resumeBatchId: first.backfillBatchId }),
      (e) => e.code === 'BACKFILL_RESUME_ALREADY_TERMINAL' && e.currentStatus === 'FAILED'
    );
    assert.equal(resumeAdapterCalled, false);

    const after = (await client.query('SELECT * FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [first.backfillBatchId])).rows[0];
    assert.equal(stableRow(after), stableRow(before));
  });
});

test('R11.4-backfill-ATTENTION_REQUIRED：终态行二次--resume必须fail-closed且逐字段不变（呼应R3.1"不自动重试覆盖"红线）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 6, 2, 0, 0, 0);
    const bar0Open = base, bar0Close = base + FIFTEEN_MIN_MS - 1;
    const bar2Open = base + 2 * FIFTEEN_MIN_MS, bar2Close = bar2Open + FIFTEEN_MIN_MS - 1; // 跳过bar1，制造缺口
    const nowMs = bar2Close + 60000;
    const adapter = makeMockAdapter({ pages: [[kline(bar0Open, bar0Close), kline(bar2Open, bar2Close)]], serverTimeMs: nowMs });
    const first = await runBackfillForInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar2Close, now: () => nowMs });
    assert.equal(first.status, 'ATTENTION_REQUIRED');

    const before = (await client.query('SELECT * FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [first.backfillBatchId])).rows[0];

    let resumeAdapterCalled = false;
    const resumeAdapter = { serverTime: async () => { resumeAdapterCalled = true; throw new Error('must not be called'); } };
    await assert.rejects(
      runBackfillForInterval({ pool: client, adapter: resumeAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar2Close, resumeBatchId: first.backfillBatchId, now: () => nowMs }),
      (e) => e.code === 'BACKFILL_RESUME_ALREADY_TERMINAL' && e.currentStatus === 'ATTENTION_REQUIRED'
    );
    assert.equal(resumeAdapterCalled, false);

    const after = (await client.query('SELECT * FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [first.backfillBatchId])).rows[0];
    assert.equal(stableRow(after), stableRow(before));
  });
});

test('R11.4-backfill-RUNNING：真正中断的批次仍可正常--resume（阳性对照，证明修复没有误伤合法用法）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 6, 3, 0, 0, 0);
    const bar0Open = base, bar0Close = base + FIFTEEN_MIN_MS - 1;
    const bar1Open = base + FIFTEEN_MIN_MS, bar1Close = bar1Open + FIFTEEN_MIN_MS - 1;
    const nowMs1 = bar0Close + 60000;

    // 直接创建RUNNING行 + 调用底层backfillInterval()（不经过finalize包装），精确模拟"进程在
    // finalize之前被杀死"，与R11.4-backfill-*三个终态测试形成正/反对照。
    const backfillBatchId = randomUUID();
    await client.query(
      `INSERT INTO historical_validation.backfill_batches(backfill_batch_id,symbol,interval_name,requested_start_utc,requested_end_utc,status,started_at)
       VALUES($1,'ETHUSDT','15m',to_timestamp($2/1000.0),to_timestamp($3/1000.0),'RUNNING',now())`,
      [backfillBatchId, bar0Open, bar1Close]
    );
    const adapter1 = makeMockAdapter({ pages: [[kline(bar0Open, bar0Close)]], serverTimeMs: nowMs1 });
    await backfillInterval({ pool: client, adapter: adapter1, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar1Close, backfillBatchId, now: () => nowMs1 });

    const running = (await client.query('SELECT status FROM historical_validation.backfill_batches WHERE backfill_batch_id=$1', [backfillBatchId])).rows[0];
    assert.equal(running.status, 'RUNNING');

    const nowMs2 = bar1Close + 60000;
    const adapter2 = makeMockAdapter({ pages: [[kline(bar1Open, bar1Close)]], serverTimeMs: nowMs2 });
    const second = await runBackfillForInterval({ pool: client, adapter: adapter2, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar1Close, resumeBatchId: backfillBatchId, now: () => nowMs2 });
    assert.equal(second.status, 'SUCCEEDED', '真正处于RUNNING的批次必须仍可正常resume并完成');
  });
});

// ===========================================================================
// B. validation_runs — SUCCEEDED/FAILED/PARTIAL三个终态均须对--resume fail-closed，即使manifest
//    验证会以不同原因失败也不得被后续manifest gate的错误码覆盖。对应server/src/validation-replay/
//    cli-entry.js的REAL_IMPLEMENTATION_DEFECT_FOUND修复。RUNNING阳性对照已由既有
//    v1-4d-cli-entry.integration.test.js/v1-4d-cli-main.integration.test.js多个用例覆盖，此处不重复。
// ===========================================================================

for (const status of ['SUCCEEDED', 'FAILED', 'PARTIAL']) {
  test(`R11.4-validation_runs-${status}：终态行二次--resume必须fail-closed(RESUME_VALIDATION_RUN_ALREADY_TERMINAL)且逐字段不变`, { skip }, async () => {
    await withTxClient(async (client) => {
      const base = Date.UTC(2026, 6, 10, 0, 0, 0) + ['SUCCEEDED', 'FAILED', 'PARTIAL'].indexOf(status) * 5 * DAY_MS;
      const from = base, to = base + DAY_MS;
      const datasetVersion = await buildVerifiedManifest(client, { from, to });

      const validationRunId = randomUUID();
      await insertTerminalValidationRun(client, { validationRunId, datasetVersion, from, to, status, errorCode: status === 'SUCCEEDED' ? null : 'SOME_ERROR' });

      const before = (await client.query('SELECT * FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
      const businessBefore = await countBusinessTables(client);

      await assert.rejects(
        runWalkForward({ pool: client, resumeValidationRunId: validationRunId, explicitParams: {}, weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, nowMs: Date.now() }),
        (e) => e.code === 'RESUME_VALIDATION_RUN_ALREADY_TERMINAL' && e.currentStatus === status
      );

      const after = (await client.query('SELECT * FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
      assert.equal(stableRow(after), stableRow(before), '终态行必须逐字段不变（含status/error_code/finished_at等全部列）');
      const businessAfter = await countBusinessTables(client);
      assert.deepEqual(businessAfter, businessBefore, '五张业务表行数不得因被拒绝的resume尝试而变化——manifest gate/生成/评估/报告均不得被执行');
    });
  });
}

test('R11.4-validation_runs-SUCCEEDED：即使manifest会以DATASET_CONTENT_HASH_MISMATCH失败，终态行仍受早于manifest gate的检查保护', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 5, 1, 0, 0, 0);
    const from = base, to = base + DAY_MS;
    const datasetVersion = await buildVerifiedManifest(client, { from, to });

    const validationRunId = randomUUID();
    await insertTerminalValidationRun(client, { validationRunId, datasetVersion, from, to, status: 'SUCCEEDED' });

    // R26.9同款手法：冻结后在manifest覆盖范围内追加一条revision，使content_hash重算必然不一致——
    // 证明"resume rejected"不是manifest gate本身失败后才补上的行为，而是发生在manifest gate
    // 之前就已经拦截（见下方assert断言的是RESUME_VALIDATION_RUN_ALREADY_TERMINAL，不是
        // DATASET_CONTENT_HASH_MISMATCH）。
    await client.query(
      `INSERT INTO market_bars(
         source_id, endpoint_id, instrument, market_type, interval_name, open_time, close_time,
         open, high, low, close, volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume,
         observation_start, observation_end, published_at, available_at, first_available_at, fetched_at,
         revision_number, vintage_id, raw_payload_id, request_id, schema_version, normalizer_version, quality_state, content_hash
       )
       SELECT source_id, endpoint_id, instrument, market_type, interval_name, open_time, close_time,
              '9999.99', '9999.99', '9999.99', '9999.99', volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume,
              observation_start, observation_end, published_at, available_at, first_available_at, fetched_at,
              1, vintage_id || '-rev1', raw_payload_id, request_id, schema_version, normalizer_version, quality_state, 'deadbeef'
       FROM market_bars WHERE instrument='ETHUSDT' AND open_time=to_timestamp($1/1000.0) LIMIT 1`,
      [from]
    );

    const before = (await client.query('SELECT * FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    const businessBefore = await countBusinessTables(client);

    await assert.rejects(
      runWalkForward({ pool: client, resumeValidationRunId: validationRunId, explicitParams: {}, weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, nowMs: Date.now() }),
      (e) => e.code === 'RESUME_VALIDATION_RUN_ALREADY_TERMINAL'
    );

    const after = (await client.query('SELECT * FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(stableRow(after), stableRow(before));
    const businessAfter = await countBusinessTables(client);
    assert.deepEqual(businessAfter, businessBefore);
  });
});

test('R11.4-validation_runs-SUCCEEDED：即使manifest的research_availability_rule_version已漂移，终态行仍受保护', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 5, 6, 0, 0, 0);
    const from = base, to = base + DAY_MS;
    await fillContiguousCoverage(client, { from, to, replayNowMs: Date.now() });
    const computed = await computeManifestContentForRange({ pool: client, symbol: 'ETHUSDT', intervals: ['15m', '4h'], from, to });

    // 直接INSERT一份research_availability_rule_version与当前代码内置版本不一致、但content_hash/
    // record_count等其余字段全部自洽正确的manifest（同R26.8手法：模拟规则版本升级后的历史run）。
    await client.query(
      `INSERT INTO historical_validation.dataset_manifests(
         dataset_version, manifest_schema_version, manifest_hash_algorithm_version, symbol, intervals,
         data_from, data_to, backfill_batch_ids, source_formal_semantics, research_availability_rule_version,
         record_count, per_interval_record_count, integrity_check_result, manifest_members
       ) VALUES ($1,$2,$3,'ETHUSDT',$4::jsonb,to_timestamp($5/1000.0),to_timestamp($6/1000.0),$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb)`,
      [
        computed.datasetVersion, computed.contentObject.manifestSchemaVersion, computed.contentObject.manifestHashAlgorithmVersion,
        JSON.stringify(computed.intervals), from, to, JSON.stringify(computed.backfillBatchIds), computed.contentObject.sourceFormalSemantics,
        'v1.4d-research-availability-OLD-DRIFTED', computed.recordCount, JSON.stringify(computed.perIntervalRecordCount),
        JSON.stringify(computed.contentObject.integrityCheckResult), JSON.stringify(computed.manifestMembers)
      ]
    );

    const validationRunId = randomUUID();
    await insertTerminalValidationRun(client, { validationRunId, datasetVersion: computed.datasetVersion, from, to, status: 'SUCCEEDED' });

    const before = (await client.query('SELECT * FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    const businessBefore = await countBusinessTables(client);

    await assert.rejects(
      runWalkForward({ pool: client, resumeValidationRunId: validationRunId, explicitParams: {}, weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, nowMs: Date.now() }),
      (e) => e.code === 'RESUME_VALIDATION_RUN_ALREADY_TERMINAL'
    );

    const after = (await client.query('SELECT * FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(stableRow(after), stableRow(before));
    const businessAfter = await countBusinessTables(client);
    assert.deepEqual(businessAfter, businessBefore);
  });
});

test('R11.4-validation_runs-SUCCEEDED：即使manifest行本身record_count与其content_hash内在不一致（数据损坏），终态行仍受保护', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 5, 11, 0, 0, 0);
    const from = base, to = base + DAY_MS;
    await fillContiguousCoverage(client, { from, to, replayNowMs: Date.now() });
    const computed = await computeManifestContentForRange({ pool: client, symbol: 'ETHUSDT', intervals: ['15m', '4h'], from, to });

    // R26.6同款手法：record_count列独立于content_hash被错误写入，模拟manifest数据损坏或
    // manifest-builder实现bug产生的"行内自相矛盾"场景。
    await client.query(
      `INSERT INTO historical_validation.dataset_manifests(
         dataset_version, manifest_schema_version, manifest_hash_algorithm_version, symbol, intervals,
         data_from, data_to, backfill_batch_ids, source_formal_semantics, research_availability_rule_version,
         record_count, per_interval_record_count, integrity_check_result, manifest_members
       ) VALUES ($1,$2,$3,'ETHUSDT',$4::jsonb,to_timestamp($5/1000.0),to_timestamp($6/1000.0),$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb)`,
      [
        computed.datasetVersion, computed.contentObject.manifestSchemaVersion, computed.contentObject.manifestHashAlgorithmVersion,
        JSON.stringify(computed.intervals), from, to, JSON.stringify(computed.backfillBatchIds), computed.contentObject.sourceFormalSemantics,
        computed.contentObject.researchAvailabilityRuleVersion, computed.recordCount + 1, JSON.stringify(computed.perIntervalRecordCount),
        JSON.stringify(computed.contentObject.integrityCheckResult), JSON.stringify(computed.manifestMembers)
      ]
    );

    const validationRunId = randomUUID();
    await insertTerminalValidationRun(client, { validationRunId, datasetVersion: computed.datasetVersion, from, to, status: 'SUCCEEDED' });

    const before = (await client.query('SELECT * FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    const businessBefore = await countBusinessTables(client);

    await assert.rejects(
      runWalkForward({ pool: client, resumeValidationRunId: validationRunId, explicitParams: {}, weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, nowMs: Date.now() }),
      (e) => e.code === 'RESUME_VALIDATION_RUN_ALREADY_TERMINAL'
    );

    const after = (await client.query('SELECT * FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(stableRow(after), stableRow(before));
    const businessAfter = await countBusinessTables(client);
    assert.deepEqual(businessAfter, businessBefore);
  });
});

// ===========================================================================
// C. replay_generation_runs / replay_evaluation_runs — 结构性证明：generation_run_id/evaluation_run_id
//    在每次尝试（generateReplaySnapshot()/evaluateReplayOutcomes()调用）内部用randomUUID()重新生成，
//    从不作为参数传入、从不被调用方复用——因此"对同一逻辑节点重复处理"（无论是正常重跑还是checkpoint
//    逻辑出现假设之外的bug）结构性地产生一条【新】行，而不是对旧的终态行发起二次UPDATE。
//    这与backfill_batches/validation_runs的"同一行反复UPDATE，需要显式状态守卫"的模式不同，但同样
//    满足R11.4"终态行内容不因后续处理而改变"这一核心不变量，本测试直接验证这一结论而非停留在推断。
// ===========================================================================

test('R11.4-replay_generation_runs：对同一逻辑节点重复调用generateReplaySnapshot()不会更新旧终态行，只产生独立新行', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 5, 20, 0, 0, 0);
    const referenceCloseTime = base - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - DAY_MS + 1;
    const to = referenceCloseTime + DAY_MS + 1;
    const datasetVersion = await buildVerifiedManifest(client, { from, to });

    const validationRunId = randomUUID();
    await client.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [validationRunId, datasetVersion, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );

    const commonArgs = {
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETHUSDT', horizon: '24h', historicalAsOfTime: referenceCloseTime, replayNowMs,
      algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION, datasetVersion, ruleVersion: RULE_VERSION, backfillBatchIds: []
    };
    const first = await generateReplaySnapshot(commonArgs);
    assert.equal(first.status, 'INSERTED');
    const firstRowBefore = (await client.query('SELECT * FROM historical_validation.replay_generation_runs WHERE generation_run_id=$1', [first.generationRunId])).rows[0];
    assert.equal(firstRowBefore.status, 'SUCCEEDED');

    // 重复调用同一(validationRunId,horizon,historicalAsOfTime)——模拟checkpoint逻辑假设之外被
    // 重新处理同一节奏点的场景（正常resume会被computeResumeCheckpoint跳过，这里绕过该守卫直接
        // 调用底层函数，专门验证generateReplaySnapshot()自身对"重复处理"的免疫机制）。
    const second = await generateReplaySnapshot(commonArgs);
    assert.equal(second.status, 'DEDUPED', 'replay_snapshots的UNIQUE(prediction_id,research_availability_rule_version)约束使第二次尝试产生DEDUPED而非二次INSERTED');
    assert.notEqual(second.generationRunId, first.generationRunId, '两次调用必须产生两个不同的generation_run_id——第二次不得复用/覆盖第一次的ID');

    const firstRowAfter = (await client.query('SELECT * FROM historical_validation.replay_generation_runs WHERE generation_run_id=$1', [first.generationRunId])).rows[0];
    assert.equal(stableRow(firstRowAfter), stableRow(firstRowBefore), '第一次尝试的终态行必须逐字段不变——第二次调用只应写入一条新行，不得回写旧行');

    const totalRows = (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0].n;
    assert.equal(totalRows, 2, '必须存在两条独立的generation_run行（一次SUCCEEDED一次DEDUPED-SUCCEEDED），而不是一条被更新了两次的行');

    const snapshotCount = (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE generation_run_id=ANY($1::uuid[])', [[first.generationRunId, second.generationRunId]])).rows[0].n;
    assert.equal(snapshotCount, 1, 'replay_snapshots本身必须恰好一条（第二次因UNIQUE约束被DO NOTHING去重，不产生第二条快照）');
  });
});

test('R11.4-replay_evaluation_runs：对同一历史as-of-time重复调用evaluateReplayOutcomes()不会更新旧终态行，只产生独立新行', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 5, 25, 0, 0, 0);
    const referenceCloseTime = base - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });
    const pathStart = referenceCloseTime + 1;
    const bars = [];
    for (let i = 0; i < 96; i++) { const o = pathStart + i * FIFTEEN_MIN_MS; bars.push(kline(o, o + FIFTEEN_MIN_MS - 1, '1000.00')); }
    const pathAdapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter: pathAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: pathStart, endTime: pathStart + 96 * FIFTEEN_MIN_MS, now: () => replayNowMs });

    const from = referenceCloseTime - DAY_MS + 1;
    const to = referenceCloseTime + 2 * DAY_MS;
    const datasetVersion = await buildVerifiedManifest(client, { from, to });

    const validationRunId = randomUUID();
    await client.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [validationRunId, datasetVersion, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );
    const generation = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETHUSDT', horizon: '24h', historicalAsOfTime: referenceCloseTime, replayNowMs,
      algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION, datasetVersion, ruleVersion: RULE_VERSION, backfillBatchIds: []
    });
    assert.equal(generation.status, 'INSERTED');

    const evalArgs = { pool: client, validationRunId, evaluationVersion: EVALUATION_VERSION, historicalAsOfTime: referenceCloseTime + DAY_MS, replayNowMs };
    const first = await evaluateReplayOutcomes(evalArgs);
    assert.equal(first.evaluated, 1);
    const firstRowBefore = (await client.query('SELECT * FROM historical_validation.replay_evaluation_runs WHERE evaluation_run_id=$1', [first.evaluationRunId])).rows[0];
    assert.equal(firstRowBefore.status, 'SUCCEEDED');

    // findPendingReplaySnapshots()的LEFT JOIN...WHERE e.replay_outcome_event_id IS NULL条件本身就已经
    // 把"已产出outcome的prediction"排除在候选集合之外——第二次调用连"尝试写入后被DB层UNIQUE约束
    // 挡下"这一步都不会发生，pending集合直接为空（evaluated=0且deduped=0），比生成侧更强的一层
    // 查询级幂等防护。仍然会创建一条新的（空转的）replay_evaluation_runs审计行，用于证明"重复调用"
    // 本身产生的是独立新行而非回写旧行。
    const second = await evaluateReplayOutcomes(evalArgs);
    assert.equal(second.evaluated, 0, '已产出outcome的prediction不再出现在pending候选集合中，第二次调用不会重新评估');
    assert.equal(second.deduped, 0, '该prediction从未进入本次pending集合，连DEDUPED计数都不会产生');
    assert.notEqual(second.evaluationRunId, first.evaluationRunId, '两次调用必须产生两个不同的evaluation_run_id');

    const firstRowAfter = (await client.query('SELECT * FROM historical_validation.replay_evaluation_runs WHERE evaluation_run_id=$1', [first.evaluationRunId])).rows[0];
    assert.equal(stableRow(firstRowAfter), stableRow(firstRowBefore), '第一次尝试的终态行必须逐字段不变');

    const totalRows = (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0].n;
    assert.equal(totalRows, 2);

    const outcomeCount = (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_outcome_events WHERE evaluation_run_id=ANY($1::uuid[])', [[first.evaluationRunId, second.evaluationRunId]])).rows[0].n;
    assert.equal(outcomeCount, 1, 'replay_outcome_events本身必须恰好一条');
  });
});
