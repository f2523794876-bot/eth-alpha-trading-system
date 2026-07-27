// R9.1(dry-run零写入)/R9.2(resume)/§4.1a(manifest门禁先于一切推进)：cli-entry.js runWalkForward()真实PostgreSQL验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest } from '../../src/validation-replay/dataset-manifest-builder.js';
import { runWalkForward } from '../../src/validation-replay/cli-entry.js';
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

// 为一个24h horizon节奏点(referenceCloseTime)准备referenceBar+15根4H ATR bar+feature_record，
// 使generateReplaySnapshot在该点必然产出INSERTED（不模拟完整96根路径——评估阶段允许path不完整，
// 只影响path_eligible_for_statistics，不影响生成阶段本身）。
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

async function buildVerifiedManifest(client, { from, to }) {
  const result = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m', '4h'], from, to });
  assert.equal(result.status, 'SUCCEEDED', 'manifest构建必须成功（前置bar数据必须无缺口）');
  return result.datasetVersion;
}

test('§4.1a：dataset_version未经校验(不存在)时，runWalkForward在任何推进/写入前fail closed', { skip }, async () => {
  await withTxClient(async (client) => {
    const from = Date.UTC(2026, 3, 20) - DAY_MS;
    const to = Date.UTC(2026, 3, 20);
    await assert.rejects(
      runWalkForward({
        pool: client, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
        algorithmVersion: ALGORITHM_VERSION, datasetVersion: 'v1.4d-sha256-' + '0'.repeat(64), ruleVersion: RULE_VERSION,
        weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, nowMs: Date.now()
      }),
      (err) => err.code === 'DATASET_MANIFEST_NOT_FOUND'
    );
    const count = (await client.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs')).rows[0].n;
    assert.equal(count, 0, 'manifest校验失败时不得写入任何validation_runs行');
  });
});

test('R9.1：--dry-run对五张业务表零写入，validation_runs仅新增1行(dry_run=true)', { skip }, async () => {
  await withTxClient(async (client) => {
    const dayStart = Date.UTC(2026, 3, 21, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });

    const from = referenceCloseTime - DAY_MS;
    const to = referenceCloseTime + DAY_MS;
    const datasetVersion = await buildVerifiedManifest(client, { from, to });

    const plan = await runWalkForward({
      pool: client, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
      algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION,
      weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, dryRun: true,
      nowMs: Date.now(), replayNowMs
    });
    assert.equal(plan.dryRun, true);
    assert.ok(plan.generationAttempts > 0, '执行计划必须报告预计推进的节奏点数量');

    const counts = {};
    for (const table of ['replay_snapshots', 'replay_generation_runs', 'replay_outcome_events', 'replay_evaluation_runs', 'validation_reports']) {
      counts[table] = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.${table}`)).rows[0].n;
    }
    for (const [table, n] of Object.entries(counts)) assert.equal(n, 0, `dry-run模式下${table}必须零写入`);

    const runRow = (await client.query('SELECT dry_run, status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [plan.validationRunId])).rows[0];
    assert.equal(runRow.dry_run, true);
    assert.equal(runRow.status, 'SUCCEEDED');
    const runCount = (await client.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs')).rows[0].n;
    assert.equal(runCount, 1);
  });
});

test('完整非dry-run执行：单个24h节奏点产出replay_snapshots/replay_generation_runs/validation_reports，validation_runs终态SUCCEEDED', { skip }, async () => {
  await withTxClient(async (client) => {
    const dayStart = Date.UTC(2026, 3, 22, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });

    const from = referenceCloseTime - DAY_MS;
    const to = referenceCloseTime + DAY_MS;
    const datasetVersion = await buildVerifiedManifest(client, { from, to });

    const plan = await runWalkForward({
      pool: client, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
      algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION,
      weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION, dryRun: false,
      nowMs: Date.now(), replayNowMs
    });

    const runRow = (await client.query('SELECT status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [plan.validationRunId])).rows[0];
    assert.equal(runRow.status, 'SUCCEEDED');

    const snapshotCount = (await client.query(
      `SELECT count(*)::int AS n FROM historical_validation.replay_snapshots s
       JOIN historical_validation.replay_generation_runs g ON g.generation_run_id=s.generation_run_id
       WHERE g.validation_run_id=$1`, [plan.validationRunId]
    )).rows[0].n;
    assert.equal(snapshotCount, 1, '恰好一个节奏点，应产出恰好一条replay_snapshots');

    const reportCount = (await client.query('SELECT count(*)::int AS n FROM historical_validation.validation_reports WHERE validation_run_id=$1', [plan.validationRunId])).rows[0].n;
    assert.ok(reportCount > 0, 'runWalkForward必须调用report-builder产出报告');
  });
});

test('R9.2/§4.4：--resume时显式传入的参数与原run不一致必须拒绝(RESUME_PARAM_MISMATCH)', { skip }, async () => {
  await withTxClient(async (client) => {
    const from = Date.UTC(2026, 3, 23) - DAY_MS;
    const to = Date.UTC(2026, 3, 23);
    const datasetVersion = await buildVerifiedManifest(client, { from, to });

    const validationRunId = randomUUID();
    await client.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [validationRunId, datasetVersion, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );

    await assert.rejects(
      runWalkForward({
        pool: client, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
        algorithmVersion: 'v1.4c-server-po-rule-2', // 与原run记录的algorithm_version不一致
        datasetVersion, ruleVersion: RULE_VERSION, weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION,
        resumeValidationRunId: validationRunId, explicitParams: { algorithmVersion: 'v1.4c-server-po-rule-2' },
        nowMs: Date.now()
      }),
      (err) => err.code === 'RESUME_PARAM_MISMATCH'
    );
  });
});

test('R26.10/R26.13（resume分支）：resume时若manifest内容漂移，已存在的validation_runs行必须被标记FAILED（不得停留在RUNNING），业务表零写入', { skip }, async () => {
  await withTxClient(async (client) => {
    const dayStart = Date.UTC(2026, 3, 24, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(client, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - DAY_MS;
    const to = referenceCloseTime + DAY_MS;
    const datasetVersion = await buildVerifiedManifest(client, { from, to });

    const validationRunId = randomUUID();
    await client.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [validationRunId, datasetVersion, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );

    // manifest冻结后market_bars内容漂移（人为插入一条revision_number=1的行，模拟"resume前数据被追加修订"）。
    const anyBar = (await client.query(`SELECT * FROM market_bars WHERE instrument='ETHUSDT' LIMIT 1`)).rows[0];
    if (anyBar) {
      await client.query(
        `INSERT INTO market_bars(
           source_id, endpoint_id, instrument, market_type, interval_name, open_time, close_time,
           open, high, low, close, volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume,
           observation_start, observation_end, published_at, available_at, first_available_at, fetched_at,
           revision_number, vintage_id, raw_payload_id, request_id, schema_version, normalizer_version, quality_state, content_hash
         )
         SELECT source_id, endpoint_id, instrument, market_type, interval_name, open_time, close_time,
                '9999.99','9999.99','9999.99','9999.99', volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume,
                observation_start, observation_end, published_at, available_at, first_available_at, fetched_at,
                1, vintage_id || '-rev1', raw_payload_id, request_id, schema_version, normalizer_version, quality_state, 'deadbeef'
         FROM market_bars WHERE market_bar_id=$1`,
        [anyBar.market_bar_id]
      );
    }

    await assert.rejects(
      runWalkForward({
        pool: client, symbol: 'ETHUSDT', from, to, horizons: ['24h'],
        algorithmVersion: ALGORITHM_VERSION, datasetVersion, ruleVersion: RULE_VERSION,
        weightVersion: WEIGHT_VERSION, evaluationVersion: EVALUATION_VERSION,
        resumeValidationRunId: validationRunId, explicitParams: {}, nowMs: Date.now()
      }),
      (err) => err.code === 'DATASET_CONTENT_HASH_MISMATCH'
    );

    const runRow = (await client.query('SELECT status, error_code FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(runRow.status, 'FAILED', 'resume失败后已存在的validation_runs行必须被标记FAILED，不得停留在RUNNING');
    assert.equal(runRow.error_code, 'DATASET_CONTENT_HASH_MISMATCH');

    for (const table of ['replay_snapshots', 'replay_generation_runs', 'replay_outcome_events', 'replay_evaluation_runs', 'validation_reports']) {
      const n = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.${table}`)).rows[0].n;
      assert.equal(n, 0, `${table}必须零写入`);
    }
  });
});
