// R9.2：同一数据集与运行参数下，路径A（一次性完整跑完两个历史节奏点）与路径B（第一个节奏点完成后
// 模拟进程中断，--resume接续完成第二个节奏点）最终产出的replay_snapshots内容必须完全一致——用
// 各自的content_hash（业务内容寻址，独立于generation_run_id/时间戳等审计字段）逐条比对，并对整个
// 有序集合计算一次汇总SHA-256，证明不是只比较行数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest } from '../../src/validation-replay/dataset-manifest-builder.js';
import { runWalkForward } from '../../src/validation-replay/cli-entry.js';
import { generateReplaySnapshot } from '../../src/validation-replay/replay-generator.js';
import { rhythmBoundaryMs, computeAlignedReferenceCloseTime } from '../../src/forecast/bar-path-locator.js';
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
async function seedFeatureRecord(client, { referenceCloseTime }) {
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
async function fillContiguousCoverage(client, { from, to, replayNowMs }) {
  for (const [interval, stepMs] of [['15m', FIFTEEN_MIN_MS], ['4h', FOUR_HOUR_MS]]) {
    const bars = [];
    for (let openTime = from; openTime < to; openTime += stepMs) bars.push(kline(openTime, openTime + stepMs - 1, '1000.00'));
    if (!bars.length) continue;
    const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval, startTime: from, endTime: to - stepMs, now: () => replayNowMs });
  }
}
function stableRow(row) {
  const normalized = {};
  for (const key of Object.keys(row).sort()) {
    const value = row[key];
    normalized[key] = value instanceof Date ? value.toISOString() : value;
  }
  return JSON.stringify(normalized);
}
// 路径A与路径B使用完全相同的symbol/horizon/algorithmVersion/datasetVersion/weightVersion/
// referenceCloseTime——这正是R9.2"使用完全相同的数据集和运行参数"这一要求的字面含义，其直接推论是
// 两条路径对同一节奏点会算出完全相同的prediction_id/content_hash（内容寻址，不掺入validation_run_id）。
// 因此两条路径不能共存于同一张replay_snapshots表中比较（第二条路径会直接DEDUPED在第一条路径已插入
// 的行上，无法判断"路径B自己是否独立算出了相同结果"）——路径A验证完成后清空其全部业务表行（不触碰
// market_bars/dataset_manifests等共享的"数据集"本身），让路径B在相同的底层数据上从零独立产出结果，
// 才能称得上是两次真正独立的计算过程后再比较。
async function purgeValidationRun(client, validationRunId) {
  await client.query(`DELETE FROM historical_validation.replay_outcome_events WHERE evaluation_run_id IN (SELECT evaluation_run_id FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1)`, [validationRunId]);
  await client.query(`DELETE FROM historical_validation.replay_snapshots WHERE generation_run_id IN (SELECT generation_run_id FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1)`, [validationRunId]);
  await client.query(`DELETE FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1`, [validationRunId]);
  await client.query(`DELETE FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1`, [validationRunId]);
  await client.query(`DELETE FROM historical_validation.validation_reports WHERE validation_run_id=$1`, [validationRunId]);
  await client.query(`DELETE FROM historical_validation.validation_runs WHERE validation_run_id=$1`, [validationRunId]);
}
async function snapshotContentSet(client, validationRunId) {
  const rows = (await client.query(
    `SELECT s.prediction_id, s.content_hash FROM historical_validation.replay_snapshots s
     JOIN historical_validation.replay_generation_runs g ON g.generation_run_id = s.generation_run_id
     WHERE g.validation_run_id=$1 ORDER BY s.prediction_id ASC`,
    [validationRunId]
  )).rows;
  const combinedHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  return { rows, combinedHash };
}

test('R9.2：一次性完整跑完两个节奏点(路径A) vs 第一点完成后中断+resume接续第二点(路径B)——最终replay_snapshots内容SHA-256完全一致，无重复无遗漏', { skip }, async () => {
  await withTxClient(async (client) => {
    const horizon = '24h';
    const boundary = rhythmBoundaryMs(horizon); // 4h
    const anchor = Date.UTC(2026, 5, 15, 0, 0, 0);
    const pointA = computeAlignedReferenceCloseTime(anchor, horizon);
    const pointB = pointA + boundary;

    // ATR14 4H回看15根4H bar（60小时）+15m referenceBar本身，两个节奏点共用同一段连续4h/15m覆盖。
    // +1对齐open_time相位——bar的close_time=open_time+stepMs-1，要让某根bar的close_time精确落在
    // pointA（close-time相位）上，起点open_time必须相应偏移+1（呼应本代码库其余测试文件同款注释）。
    const manifestFrom = pointA - 3 * DAY_MS + 1;
    const manifestTo = pointB + DAY_MS;
    // replayNowMs必须晚于manifestTo——否则backfillInterval()"仅接受已收盘K线"的过滤器会把
    // manifestTo之前尚未到达replayNowMs的bar静默丢弃，在manifest覆盖范围内制造缺口导致REJECTED。
    const replayNowMs = manifestTo + DAY_MS;
    await fillContiguousCoverage(client, { from: manifestFrom, to: manifestTo, replayNowMs });
    // 15m referenceBar本身精确落在pointA/pointB（fillContiguousCoverage已经按15m步长逐位覆盖了整个
    // 区间，天然包含这两个精确时刻的15m bar），特征记录仍需单独构造（generateReplaySnapshot要求
    // exact-match的feature_records行）。
    await seedFeatureRecord(client, { referenceCloseTime: pointA });
    await seedFeatureRecord(client, { referenceCloseTime: pointB });

    const manifest = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m', '4h'], from: manifestFrom, to: manifestTo });
    assert.equal(manifest.status, 'SUCCEEDED');
    const datasetVersion = manifest.datasetVersion;

    const commonExplicitParams = {
      symbol: 'ETHUSDT', horizons: [horizon], fromUtc: pointA, toUtc: pointB + 1,
      algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION
    };

    // 路径A：一次性完整跑完（new-task，非dry-run，非resume）。
    const validationRunIdA = randomUUID();
    const planA = await runWalkForward({
      pool: client, dryRun: false, resumeValidationRunId: null,
      explicitParams: { ...commonExplicitParams },
      weightVersion: WEIGHT_VERSION, evaluationVersion: 'v1.4c-outcome-evaluation-pathA', nowMs: Date.now(), replayNowMs
    });
    assert.notEqual(planA.validationRunId, undefined);
    const runRowA = (await client.query('SELECT status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [planA.validationRunId])).rows[0];
    assert.equal(runRowA.status, 'SUCCEEDED');
    const setA = await snapshotContentSet(client, planA.validationRunId);
    assert.equal(setA.rows.length, 2, '前提确认：路径A必须恰好产出两条快照（pointA与pointB各一条），不多不少');
    assert.equal(new Set(setA.rows.map(r => r.prediction_id)).size, 2, '路径A不得有重复prediction_id');

    // 清空路径A的全部业务表行（不触碰market_bars/dataset_manifests），让路径B在完全相同的底层数据集
    // 上独立重新计算——否则路径B会直接DEDUPED在路径A已插入的行上，无法证明两条路径各自独立算出了
    // 相同结果。
    await purgeValidationRun(client, planA.validationRunId);
    const residualAfterPurge = (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots')).rows[0].n;
    assert.equal(residualAfterPurge, 0, '前提确认：路径A的快照已完全清空，路径B将在干净状态下独立计算');

    // 路径B：直接INSERT一条RUNNING行 + 手工调用generateReplaySnapshot()完成pointA（精确模拟"进程在
    // 处理完第一个节奏点、finalize之前被杀死"），再通过真正的--resume接续，让computeResumeCheckpoint
    // 识别pointA已完成、只重新推进pointB——验证的正是R9.2"不重复计算已完成部分"这一红线。
    const validationRunIdB = randomUUID();
    await client.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [validationRunIdB, datasetVersion, pointA, pointB + 1, ALGORITHM_VERSION, RULE_VERSION]
    );
    const interruptedGeneration = await generateReplaySnapshot({
      pool: client, validationRunId: validationRunIdB, instrument: 'ETHUSDT', symbol: 'ETHUSDT', horizon, historicalAsOfTime: pointA, replayNowMs,
      algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION, datasetVersion, ruleVersion: RULE_VERSION, backfillBatchIds: []
    });
    assert.equal(interruptedGeneration.status, 'INSERTED');
    // pointA的evaluation也必须在"中断前"已完成，否则computeResumeCheckpoint不会把pointA视为已完成
    // （见cli-entry.js isDone()要求generation与evaluation均达到终态），resume会重新处理pointA，
    // 那就无法验证"不重复计算已完成部分"这一核心红线。
    const { evaluateReplayOutcomes } = await import('../../src/validation-replay/replay-evaluator.js');
    await evaluateReplayOutcomes({ pool: client, validationRunId: validationRunIdB, evaluationVersion: 'v1.4c-outcome-evaluation-pathB', historicalAsOfTime: pointA, replayNowMs });

    const checkpointBefore = (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1', [validationRunIdB])).rows[0].n;
    assert.equal(checkpointBefore, 1, '前提确认：resume前必须恰好只有pointA一条生成记录，模拟真实的"跑到一半"状态');

    const planB = await runWalkForward({
      pool: client, resumeValidationRunId: validationRunIdB, explicitParams: {},
      weightVersion: WEIGHT_VERSION, evaluationVersion: 'v1.4c-outcome-evaluation-pathB', nowMs: Date.now(), replayNowMs
    });
    const runRowB = (await client.query('SELECT status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunIdB])).rows[0];
    assert.equal(runRowB.status, 'SUCCEEDED');

    const genRowsB = (await client.query('SELECT historical_as_of_time, status FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1 ORDER BY historical_as_of_time', [validationRunIdB])).rows;
    assert.equal(genRowsB.length, 2, '路径B必须恰好两条生成记录（不重复处理pointA，只新增pointB）——不多不少');
    assert.ok(genRowsB.every(r => r.status === 'SUCCEEDED'));

    const setB = await snapshotContentSet(client, validationRunIdB);
    assert.equal(setB.rows.length, 2);
    assert.equal(new Set(setB.rows.map(r => r.prediction_id)).size, 2, '路径B不得有重复prediction_id');

    // 核心断言：两条完全独立的路径（不同validation_run_id，其中一条经历了真实的中断+resume），
    // 最终产出的{prediction_id, content_hash}有序集合的SHA-256完全一致。
    assert.deepEqual(setA.rows, setB.rows, '路径A与路径B的{prediction_id, content_hash}有序集合必须逐条完全一致');
    assert.equal(setA.combinedHash, setB.combinedHash, '路径A与路径B最终结果的汇总SHA-256必须完全一致');
  });
});
