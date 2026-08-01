// R19.4：V1_4D_DATA_BACKFILL_SPEC.md §2.1要求4h/1h回填延伸至"15m窗口起点-4天"，为train段最早几天的
// 候选点预留完整60小时(15根4H bar)ATR14回看窗口。此前唯一的ATR14_4H_INSUFFICIENT测试
// （v1-4d-replay-generator-evaluator.integration.test.js"4H ATR14历史深度不足"）只是任意seed 5根bar，
// 与"回放起点前4天缓冲缺失"这一具体场景没有任何构造关系（即使§2.1的4天缓冲要求被完整满足，那条
// 通用测试依然会通过/失败，无法区分"预热损耗"是否真的是有条件的）。本文件专门构造：主回放窗口
// [from,to)自身的15m referenceBar数据完整存在，但4h bar只覆盖到窗口起点为止，起点前４天缓冲完全
// 缺失——直接对应窗口最早的候选点会真实触发ATR14_4H_INSUFFICIENT；对照组额外补齐4天缓冲后，同一
// 候选点必须变为可生成，证明这一BLOCKED确实是"缓冲缺失"这个条件本身导致的，不是巧合或其他原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { generateReplaySnapshot } from '../../src/validation-replay/replay-generator.js';
import { RESEARCH_AVAILABILITY_RULE_VERSION } from '../../src/validation-replay/research-availability.js';
import { FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION } from '../../src/features/feature-version.js';
import { sha256 } from '../../src/domain/hash.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;
const FOUR_HOUR_MS = 14400000;
const FIFTEEN_MIN_MS = 900000;
const DAY_MS = 86400000;

const ALGORITHM_VERSION = 'v1.4c-server-po-rule-1';
const WEIGHT_VERSION = 'v1.4c-server-weight-1';
const RULE_VERSION = 'v1.4c-po-rule-1';
const DATASET_VERSION = 'v1.4d-sha256-' + 'b'.repeat(64);

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

async function seedValidationRun(client, { validationRunId, from, to }) {
  await client.query(
    `INSERT INTO historical_validation.dataset_manifests(
       dataset_version, manifest_schema_version, manifest_hash_algorithm_version, symbol, intervals, data_from, data_to,
       backfill_batch_ids, source_formal_semantics, research_availability_rule_version, record_count, per_interval_record_count,
       integrity_check_result, manifest_members
     ) VALUES($1,'v1.4d-manifest-schema-1','v1.4d-manifest-hash-1','ETHUSDT','["15m","4h"]'::jsonb,to_timestamp($2/1000.0),to_timestamp($3/1000.0),
       '[]'::jsonb,'market_bars:formal:spot',$4,0,'{}'::jsonb,'{"gapCount":0,"duplicateCount":0,"outOfOrderCount":0}'::jsonb,'[]'::jsonb)
     ON CONFLICT(dataset_version) DO NOTHING`,
    [DATASET_VERSION, from, to, RESEARCH_AVAILABILITY_RULE_VERSION]
  );
  await client.query(
    `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
     VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
    [validationRunId, DATASET_VERSION, from, to, ALGORITHM_VERSION, RULE_VERSION]
  );
}
async function seedFeatureRecord(client, { referenceCloseTime, replayNowMs }) {
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
      `feature-${referenceCloseTime}`, referenceCloseTime - FIFTEEN_MIN_MS + 1, referenceCloseTime, referenceCloseTime, referenceCloseTime,
      FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION, JSON.stringify(featureValues), sha256(featureValues)
    ]
  );
}

const PRODUCTION_TABLES = ['forecast_snapshots', 'forecast_outcome_events', 'forecast_generation_runs', 'forecast_evaluation_runs', 'collector_leases'];
async function countProductionTables(client) {
  const counts = {};
  for (const table of PRODUCTION_TABLES) counts[table] = (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  return counts;
}

test('R19.4：主回放窗口起点前4天ATR缓冲缺失——窗口最早候选点真实触发ATR14_4H_INSUFFICIENT（不是通用样例）', { skip }, async () => {
  await withTxClient(async (client) => {
    const windowStart = Date.UTC(2026, 5, 1, 0, 0, 0); // "15m窗口起点"，§2.1要求4h/1h回填应延伸至此前4天
    const referenceCloseTime = windowStart + FOUR_HOUR_MS - 1; // 窗口内第一个4h节奏边界，紧贴窗口起点
    const replayNowMs = referenceCloseTime + DAY_MS;
    const validationRunId = randomUUID();
    await seedValidationRun(client, { validationRunId, from: windowStart, to: windowStart + 2 * DAY_MS });

    const productionBefore = await countProductionTables(client);

    // 主回放区间数据本身完整存在：15m referenceBar精确落在referenceCloseTime。
    const refOpen = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    const refAdapter = makeMockAdapter({ pages: [[kline(refOpen, referenceCloseTime)]], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter: refAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: refOpen, endTime: refOpen, now: () => replayNowMs });

    // 4h回填故意只覆盖到windowStart为止（模拟§2.1"延伸至窗口起点-4天"这一步骤被跳过）——
    // windowStart到referenceCloseTime之间只有恰好1根4h bar，ATR14需要15根，远远不够。
    const bufferMissingAdapter = makeMockAdapter({ pages: [[kline(windowStart, referenceCloseTime)]], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter: bufferMissingAdapter, symbol: 'ETHUSDT', interval: '4h', startTime: windowStart, endTime: referenceCloseTime, now: () => replayNowMs });

    await seedFeatureRecord(client, { referenceCloseTime, replayNowMs });

    const result = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, 'ATR14_4H_INSUFFICIENT', '窗口起点前4天缓冲缺失时，窗口最早候选点必须真实触发ATR14_4H_INSUFFICIENT');

    const run = (await client.query('SELECT status, error_code FROM historical_validation.replay_generation_runs WHERE generation_run_id=$1', [result.generationRunId])).rows[0];
    assert.equal(run.status, 'BLOCKED');
    assert.equal(run.error_code, 'ATR14_4H_INSUFFICIENT');

    const reportCount = (await client.query('SELECT count(*)::int AS n FROM historical_validation.validation_reports WHERE validation_run_id=$1', [validationRunId])).rows[0].n;
    assert.equal(reportCount, 0, '本测试只直接调用generateReplaySnapshot()（不经过完整runWalkForward()的报告构建阶段），结构性地不会产生任何validation_reports行');

    const productionAfter = await countProductionTables(client);
    assert.deepEqual(productionAfter, productionBefore, '五张生产表行数必须保持不变——本场景从头到尾都不在public schema下写入任何东西');
  });
});

test('R19.4对照组：补齐窗口起点前4天ATR缓冲后，同一候选点必须能正常生成——证明预热损耗确实是有条件的，不是文档空谈', { skip }, async () => {
  await withTxClient(async (client) => {
    const windowStart = Date.UTC(2026, 5, 8, 0, 0, 0);
    const referenceCloseTime = windowStart + FOUR_HOUR_MS - 1;
    const replayNowMs = referenceCloseTime + DAY_MS;
    const validationRunId = randomUUID();
    await seedValidationRun(client, { validationRunId, from: windowStart, to: windowStart + 2 * DAY_MS });

    const refOpen = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    const refAdapter = makeMockAdapter({ pages: [[kline(refOpen, referenceCloseTime)]], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter: refAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: refOpen, endTime: refOpen, now: () => replayNowMs });

    // 与上一个测试的唯一区别：4h回填按§2.1要求延伸至"窗口起点-4天"（此处用15根4h bar=60小时，
    // 覆盖windowStart前的完整ATR14回看窗口），窗口起点本身的候选点因此能凑齐15根bar。
    const count = 15;
    const bars = [];
    for (let i = count - 1; i >= 0; i--) {
      const closeTime = referenceCloseTime - i * FOUR_HOUR_MS;
      bars.push(kline(closeTime - FOUR_HOUR_MS + 1, closeTime, (1000 + i).toFixed(2)));
    }
    const start = referenceCloseTime - (count - 1) * FOUR_HOUR_MS - FOUR_HOUR_MS + 1;
    assert.ok(start < windowStart, '前提确认：本对照组的4h缓冲必须真实延伸到窗口起点之前，否则不构成"补齐缓冲"这一变量');
    const bufferedAdapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter: bufferedAdapter, symbol: 'ETHUSDT', interval: '4h', startTime: start, endTime: referenceCloseTime, now: () => replayNowMs });

    await seedFeatureRecord(client, { referenceCloseTime, replayNowMs });

    const result = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.notEqual(result.status, 'BLOCKED', '补齐4天缓冲后，同一个候选点不得再被ATR14_4H_INSUFFICIENT阻断');
    assert.equal(result.status, 'INSERTED');
  });
});
