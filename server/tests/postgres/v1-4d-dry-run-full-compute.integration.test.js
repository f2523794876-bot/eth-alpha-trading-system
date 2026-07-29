// P0-2（独立复审）：dry-run必须执行完整计算链路——真实PostgreSQL验证。
// 此前的问题：cli-entry.js的历史as_of_time推进循环在dryRun=true时对每个节奏点直接continue，只统计
// 数量，从未真正调用generateReplaySnapshot/evaluateReplayOutcomes，dry-run因此无法在真正写入前发现
// 实际数据可用性问题。本文件证明修复后：①数据充分时，生成/评估的全部只读计算路径真实执行并产出
// 'PLANNED'结果；②数据不足时，dry-run同样能发现并报告BLOCKED（gap/可用性检查真实生效，不是形式上的空跑）；
// ③无论哪种情况，五张业务表在dry-run前后行数不变；④执行计划(executionPlan)包含批次范围/purge边界/
// 计算摘要。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest } from '../../src/validation-replay/dataset-manifest-builder.js';
import { generateReplaySnapshot } from '../../src/validation-replay/replay-generator.js';
import { runWalkForward, enumerateRhythmPoints } from '../../src/validation-replay/cli-entry.js';
import { FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION } from '../../src/features/feature-version.js';
import { sha256 } from '../../src/domain/hash.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;
const FOUR_HOUR_MS = 14400000;
const FIFTEEN_MIN_MS = 900000;
const DAY_MS = 86400000;
const BUSINESS_TABLES = ['replay_snapshots', 'replay_generation_runs', 'replay_outcome_events', 'replay_evaluation_runs', 'validation_reports'];

const ALGORITHM_VERSION = 'v1.4c-server-po-rule-1';
const WEIGHT_VERSION = 'v1.4c-server-weight-1';
const RULE_VERSION = 'v1.4c-po-rule-1';
const EVALUATION_VERSION = 'v1.4c-outcome-evaluation-1';

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
async function tableCounts(client) {
  const counts = {};
  for (const table of BUSINESS_TABLES) counts[table] = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.${table}`)).rows[0].n;
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
     ) VALUES($1,'ETHUSDT','15m',to_timestamp($2/1000.0),to_timestamp($3/1000.0),to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6,$7,$8,1,'HEALTHY',$9::jsonb,'{}'::jsonb,$10)`,
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
// P0-4修复联动：integrity-check.js现在要求[from,to)整个范围按interval步长逐位连续覆盖（含边界），
// 见 v1-4d-cli-entry.integration.test.js 同名辅助函数的详细说明。调用方(from/to)必须已对齐open_time相位
// （即from/to本身应能整除相应interval的步长——本文件所有调用点均满足，因为都带着"+1"从close_time换算得到）。
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

test('P0-2：数据充分时，dry-run真实执行生成阶段全部只读计算并产出PLANNED（不是被continue跳过的空跑）', { skip }, async () => {
  await withTxClient(async (client) => {
    const referenceCloseTime = Date.UTC(2026, 6, 1, 0, 0, 0) - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });

    const from = referenceCloseTime - FOUR_HOUR_MS + 1;
    const to = referenceCloseTime + 1;
    const datasetVersion = await buildVerifiedManifest(client, { from, to, replayNowMs });

    const before = await tableCounts(client);

    const plan = await runWalkForward({
      pool: client, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
      algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION,
      weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, dryRun: true,
      nowMs: Date.now(), replayNowMs
    });

    const generationResults = plan.results.filter(r => r.phase === 'generation');
    assert.equal(generationResults.length, 1);
    assert.equal(generationResults[0].status, 'PLANNED', '数据充分的节奏点，dry-run必须真实跑完全部计算并报告PLANNED，而不是被跳过');

    assert.deepEqual(plan.executionPlan.generationStatusCounts, { '24h:PLANNED': 1 }, 'executionPlan必须汇总真实计算后的状态分布');
    assert.ok(Array.isArray(plan.executionPlan.backfillBatchIds), 'executionPlan必须包含预计涉及的backfill_batch_id范围');
    assert.deepEqual(plan.executionPlan.purgeBoundary, { trainEnd: null, validationEnd: null });
    assert.equal(plan.executionPlan.rhythmPointCount, 1);

    const after = await tableCounts(client);
    assert.deepEqual(after, before, 'dry-run模式下五张业务表行数在执行前后必须完全一致（零写入）');

    const runRow = (await client.query('SELECT dry_run, status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [plan.validationRunId])).rows[0];
    assert.equal(runRow.dry_run, true);
    assert.equal(runRow.status, 'SUCCEEDED');
  });
});

test('P0-2：数据不足（feature_record缺失）时，dry-run真实执行数据可用性检查并报告BLOCKED及具体原因（证明gap/可用性检查真实生效，不是形式空跑）', { skip }, async () => {
  await withTxClient(async (client) => {
    // referenceBar+ATR14所需的15根4h历史bar照常真实seed（不受replay自身[from,to)范围限制——ATR查询本身
    // 不按manifest范围过滤，只按close_time<=asOfTime），但故意不seed任何feature_record——生成阶段应能
    // 顺利通过referenceBar定位+ATR14计算，最终在feature查询这一步被真实发现缺失并BLOCKED
    // (FEATURE_RECORD_MISSING)，而不是在manifest构建阶段就被挡住（那样只证明了manifest的完整性检查，
    // 没有真正触达生成阶段自己的可用性检查）。
    const referenceCloseTime = Date.UTC(2026, 6, 5, 0, 0, 0) - 1;
    const replayNowMs = Date.now();
    const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    const refAdapter = makeMockAdapter({ pages: [[kline(referenceOpenTime, referenceCloseTime, '1000.00')]], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter: refAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: referenceOpenTime, endTime: referenceOpenTime, now: () => replayNowMs });
    const atrBars = [];
    for (let i = 14; i >= 0; i--) {
      const closeTime = referenceCloseTime - i * FOUR_HOUR_MS;
      atrBars.push(kline(closeTime - FOUR_HOUR_MS + 1, closeTime, (1000 + i).toFixed(2)));
    }
    const atrStart = referenceCloseTime - 14 * FOUR_HOUR_MS - FOUR_HOUR_MS + 1;
    const atrAdapter = makeMockAdapter({ pages: [atrBars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter: atrAdapter, symbol: 'ETHUSDT', interval: '4h', startTime: atrStart, endTime: referenceCloseTime, now: () => replayNowMs });
    // 刻意不调用 seedFeatureRecord

    const from = referenceCloseTime - FOUR_HOUR_MS + 1;
    const to = referenceCloseTime + 1;
    const datasetVersion = await buildVerifiedManifest(client, { from, to, replayNowMs });

    const before = await tableCounts(client);
    const plan = await runWalkForward({
      pool: client, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
      algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION,
      weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, dryRun: true,
      nowMs: Date.now(), replayNowMs
    });

    const generationResults = plan.results.filter(r => r.phase === 'generation');
    assert.equal(generationResults.length, 1);
    assert.equal(generationResults[0].status, 'BLOCKED', 'feature_record缺失时dry-run必须真实发现并报告BLOCKED，而不是静默假装成功');
    assert.deepEqual(plan.executionPlan.generationStatusCounts, { '24h:BLOCKED': 1 });

    const after = await tableCounts(client);
    assert.deepEqual(after, before, 'BLOCKED场景下dry-run同样必须零写入');
  });
});

test('P0-2：evaluation预演——已存在的真实待评估快照在dry-run扫描中被完整计算(定位路径+计算outcome)但不写入replay_outcome_events', { skip }, async () => {
  await withTxClient(async (client) => {
    const referenceCloseTime = Date.UTC(2026, 6, 10, 0, 0, 0) - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });

    const manifestFrom = referenceCloseTime - FOUR_HOUR_MS + 1;
    const manifestTo = referenceCloseTime + 1;
    const datasetVersion = await buildVerifiedManifest(client, { from: manifestFrom, to: manifestTo, replayNowMs });

    // 真实（非dry-run）生成一条快照，制造"已存在、待评估"的历史状态——targetEndTime = referenceCloseTime + 24h。
    const validationRunId = randomUUID();
    await client.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, dry_run, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,false,'RUNNING',now())`,
      [validationRunId, datasetVersion, manifestFrom, manifestTo, ALGORITHM_VERSION, RULE_VERSION]
    );
    const generation = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h', historicalAsOfTime: referenceCloseTime, replayNowMs,
      algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION, datasetVersion, ruleVersion: RULE_VERSION, backfillBatchIds: []
    });
    assert.equal(generation.status, 'INSERTED');
    const targetEndTime = referenceCloseTime + 96 * FIFTEEN_MIN_MS;

    // 另开一个全新的dry-run validation_run，窗口位于targetEndTime之后——其自身的生成尝试大概率BLOCKED
    // （该窗口没有为它准备任何数据），但evaluation sweep是全局性的（不按validation_run_id过滤，见
    // replay-evaluator.js findPendingReplaySnapshots），必须能扫描到上面这条待评估快照并完整跑一遍
    // 定位+outcome计算，只是不写入。
    const dryRunFrom = targetEndTime + 1; // +1对齐open_time相位（targetEndTime本身按close_time+1天算出，含close_time相位偏移）
    const dryRunTo = targetEndTime + FOUR_HOUR_MS + 1;
    const dryRunDatasetVersion = await buildVerifiedManifest(client, { from: dryRunFrom, to: dryRunTo, replayNowMs });
    const points = enumerateRhythmPoints({ from: dryRunFrom, to: dryRunTo, horizon: '24h' });
    assert.ok(points.length >= 1 && points[0] >= targetEndTime, '前提核验：dry-run窗口必须至少枚举出一个>=targetEndTime的节奏点，才能触发对该快照的评估sweep');

    const before = await tableCounts(client);
    const plan = await runWalkForward({
      pool: client, symbol: 'ETHUSDT', from: dryRunFrom, to: dryRunTo, horizons: ['24h'],
      algorithmVersion: ALGORITHM_VERSION, datasetVersion: dryRunDatasetVersion, ruleVersion: RULE_VERSION,
      weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, dryRun: true,
      nowMs: Date.now(), replayNowMs
    });

    const evaluationResults = plan.results.filter(r => r.phase === 'evaluation');
    const totalPreviewed = evaluationResults.reduce((sum, r) => sum + (r.previewed || 0), 0);
    assert.ok(totalPreviewed >= 1, 'dry-run的evaluation sweep必须真实扫描到既有待评估快照并完整跑一遍计算（previewed>=1）');
    assert.ok(plan.executionPlan.evaluationPreviewedCount >= 1, 'executionPlan必须汇总evaluation预演数量');

    const after = await tableCounts(client);
    // replay_snapshots/replay_generation_runs因validationRunId的真实(非dry-run)前置生成而已经是1，
    // dry-run本身不得再新增——其余三张表(outcome_events/evaluation_runs/reports)必须保持0。
    assert.equal(after.replay_snapshots, before.replay_snapshots, 'dry-run不得新增replay_snapshots');
    assert.equal(after.replay_generation_runs, before.replay_generation_runs, 'dry-run不得新增replay_generation_runs');
    assert.equal(after.replay_outcome_events, 0, 'evaluation预演即便真实跑完计算，也绝不能写入replay_outcome_events');
    assert.equal(after.replay_evaluation_runs, 0, 'dry-run不得新增replay_evaluation_runs审计行');
    assert.equal(after.validation_reports, 0);
  });
});
