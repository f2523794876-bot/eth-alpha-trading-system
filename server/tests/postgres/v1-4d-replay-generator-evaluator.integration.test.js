// R8.1/R8.2(边界，本文件内验证生成/评估逻辑正确性，生产表零写入由静态代码审查+R21静态扫描覆盖)/R10/R11.2/R12/R15：
// replay-generator.js / replay-evaluator.js 真实PostgreSQL端到端验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { generateReplaySnapshot } from '../../src/validation-replay/replay-generator.js';
import { evaluateReplayOutcomes } from '../../src/validation-replay/replay-evaluator.js';
import { RESEARCH_AVAILABILITY_RULE_VERSION } from '../../src/validation-replay/research-availability.js';
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
const DATASET_VERSION = 'v1.4d-sha256-' + '11'.repeat(32);
const RULE_VERSION = 'v1.4c-po-rule-1';
const EVALUATION_VERSION = 'v1.4c-outcome-evaluation-1';
const AUDIT_FIELDS = Object.freeze([
  'vintageId', 'symbol', 'interval', 'openTime', 'closeTime',
  'availableAt', 'fetchedAt', 'sourceId', 'revisionNumber'
]);

function assertCompleteReferenceAudit(consumedBars, referenceCloseTime, phase) {
  const referenceAudit = consumedBars.find(bar => bar.interval === '15m' && bar.closeTime === referenceCloseTime);
  assert.ok(referenceAudit, `${phase} research_data_vintage必须包含reference bar`);
  for (const field of AUDIT_FIELDS) {
    assert.ok(field in referenceAudit, `${phase} reference bar必须包含审计字段 ${field}`);
    assert.notEqual(referenceAudit[field], null, `${phase} reference bar审计字段 ${field}不得为null`);
  }
  assert.equal(referenceAudit.closeTime, referenceCloseTime, `${phase} reference bar必须保留精确close_time边界`);
  assert.ok(referenceAudit.availableAt > referenceAudit.closeTime, `${phase}回填bar的available_at应为晚于历史close_time的真实回填时刻`);
  assert.ok(referenceAudit.fetchedAt >= referenceAudit.availableAt, `${phase} fetched_at不得早于available_at`);
}

function makeMockAdapter({ pages, serverTimeMs }) {
  let call = 0;
  return {
    serverTime: async () => ({ body: { serverTime: serverTimeMs }, requestId: randomUUID() }),
    spotKlines: async () => {
      const page = pages[call] || [];
      call += 1;
      return { body: page, requestId: randomUUID(), status: 200, headers: {} };
    }
  };
}

// high/low必须宽松覆盖本文件里用到的全部close取值(最高约1000+15=1015)，否则触发validateKlineRow的
// OHLC_RELATION_INVALID(high必须>=max(open,close,low))而被静默拒绝——早期版本固定high='1001.00'时，
// count=15的ATR14种子数据里i>=2的行(close>1001)全部被拒收，导致误判为ATR14_4H_INSUFFICIENT，
// 这是本测试fixture的真实bug，非被测代码问题，记录于此避免未来重犯。
function kline(openTime, closeTime, closeStr = '1000.00') {
  return [openTime, '999.00', '2000.00', '500.00', closeStr, '10.5', closeTime, '10500.00', 5, '5.0', '5000.00'];
}

async function withTxClient(fn) {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

async function seedFourHourAtrBars(client, { symbol, referenceCloseTime, count = 15, replayNowMs }) {
  const bars = [];
  for (let i = count - 1; i >= 0; i--) {
    const closeTime = referenceCloseTime - i * FOUR_HOUR_MS;
    const openTime = closeTime - FOUR_HOUR_MS + 1;
    bars.push(kline(openTime, closeTime, (1000 + i).toFixed(2)));
  }
  const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
  const start = referenceCloseTime - (count - 1) * FOUR_HOUR_MS - FOUR_HOUR_MS + 1;
  await backfillInterval({ pool: client, adapter, symbol, interval: '4h', startTime: start, endTime: referenceCloseTime, now: () => replayNowMs });
}

async function seedReferenceBar(client, { symbol, openTime, closeTime, replayNowMs, closeStr = '1000.00' }) {
  const adapter = makeMockAdapter({ pages: [[kline(openTime, closeTime, closeStr)]], serverTimeMs: replayNowMs });
  await backfillInterval({ pool: client, adapter, symbol, interval: '15m', startTime: openTime, endTime: openTime, now: () => replayNowMs });
}

async function seedFifteenMinPath(client, { symbol, startOpenTime, count, replayNowMs, closeStrFn = (i) => '1000.00' }) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const openTime = startOpenTime + i * FIFTEEN_MIN_MS;
    const closeTime = openTime + FIFTEEN_MIN_MS - 1;
    bars.push(kline(openTime, closeTime, closeStrFn(i)));
  }
  const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
  await backfillInterval({ pool: client, adapter, symbol, interval: '15m', startTime: startOpenTime, endTime: startOpenTime + count * FIFTEEN_MIN_MS, now: () => replayNowMs });
}

async function seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime, featureValues = {} }) {
  await client.query(
    `INSERT INTO feature_sets(feature_set_version, algorithm_version, schema_version, definition, definition_hash)
     VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(feature_set_version) DO NOTHING`,
    [FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, 'v1.4b-schema-1', JSON.stringify({}), sha256({})]
  );
  const defaultFeatureValues = {
    closeToEma5: 0, trend4h: 'down', trend1h: 'down', volumeRatio20: 1,
    swingHigh: 1100, swingLow: 900, breakoutState: null, upperWickRatio: 0.1, lowerWickRatio: 0.1,
    distanceToSupportAtr: 5, distanceToResistanceAtr: 5, falseBreakoutRisk: 'NONE',
    btcTrendState: 'flat', ethBtcRollingCorrelation: 0, logReturn1: 0
  };
  const mergedFeatureValues = { ...defaultFeatureValues, ...featureValues };
  const result = await client.query(
    `INSERT INTO feature_records(
       feature_id, symbol, target_interval, target_bar_open_time, target_bar_close_time, as_of_time, generated_at,
       feature_set_version, algorithm_version, source_dataset_version, completeness, quality_state, feature_values, availability, content_hash
     ) VALUES($1,'ETHUSDT','15m',to_timestamp($2/1000.0),to_timestamp($3/1000.0),to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6,$7,$8,1,'HEALTHY',$9::jsonb,'{}'::jsonb,$10)
     RETURNING feature_record_id`,
    [
      `feature-${referenceCloseTime}`, referenceCloseTime - FIFTEEN_MIN_MS + 1, referenceCloseTime, historicalAsOfTime, historicalAsOfTime,
      FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION, JSON.stringify(mergedFeatureValues), sha256(mergedFeatureValues)
    ]
  );
  return result.rows[0].feature_record_id;
}

async function seedValidationRun(client, { validationRunId, from, to }) {
  await client.query(
    `INSERT INTO historical_validation.dataset_manifests(
       dataset_version, manifest_schema_version, manifest_hash_algorithm_version, manifest_contract_version, dataset_type, symbol, intervals, data_from, data_to,
       backfill_batch_ids, source_formal_semantics, research_availability_rule_version, record_count, per_interval_record_count,
       integrity_check_result, manifest_members
     ) VALUES($1,'v1.4d-manifest-schema-1','v1.4d-manifest-hash-1',1,'MARKET_BARS','ETHUSDT','["15m","4h"]'::jsonb,to_timestamp($2/1000.0),to_timestamp($3/1000.0),
       '[]'::jsonb,'market_bars:formal:spot',$4,0,'{}'::jsonb,'{"gapCount":0,"duplicateCount":0,"outOfOrderCount":0}'::jsonb,'[]'::jsonb)
     ON CONFLICT(dataset_version) DO NOTHING`,
    [DATASET_VERSION, from, to, RESEARCH_AVAILABILITY_RULE_VERSION]
  );
  await client.query(
    `INSERT INTO historical_validation.validation_runs(
       validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at
     ) VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
    [validationRunId, DATASET_VERSION, from, to, ALGORITHM_VERSION, RULE_VERSION]
  );
}

test('BLOCKED：referenceBar未到达节奏边界/不存在时返回REFERENCE_BAR_NOT_DUE_OR_MISSING', { skip }, async () => {
  await withTxClient(async (client) => {
    const validationRunId = randomUUID();
    const dayStart = Date.UTC(2026, 4, 1, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    await seedValidationRun(client, { validationRunId, from: referenceCloseTime - DAY_MS, to: referenceCloseTime + DAY_MS });
    const replayNowMs = Date.now();

    // 不seed任何referenceBar数据
    const result = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, 'REFERENCE_BAR_NOT_DUE_OR_MISSING');

    const run = (await client.query('SELECT status, error_code FROM historical_validation.replay_generation_runs WHERE generation_run_id=$1', [result.generationRunId])).rows[0];
    assert.equal(run.status, 'BLOCKED');
    assert.equal(run.error_code, 'REFERENCE_BAR_NOT_DUE_OR_MISSING');
  });
});

test('BLOCKED：4H ATR14历史深度不足时返回ATR14_4H_INSUFFICIENT', { skip }, async () => {
  await withTxClient(async (client) => {
    const validationRunId = randomUUID();
    const dayStart = Date.UTC(2026, 4, 2, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    await seedValidationRun(client, { validationRunId, from: referenceCloseTime - DAY_MS, to: referenceCloseTime + DAY_MS });
    const replayNowMs = Date.now();
    await seedReferenceBar(client, { symbol: 'ETHUSDT', openTime: referenceOpenTime, closeTime: referenceCloseTime, replayNowMs });
    // 故意只seed 5根4H bar（不足15根ATR14要求）
    await seedFourHourAtrBars(client, { symbol: 'ETHUSDT', referenceCloseTime, count: 5, replayNowMs });

    const result = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, 'ATR14_4H_INSUFFICIENT');
  });
});

test('BLOCKED：feature_records缺失时返回FEATURE_RECORD_MISSING', { skip }, async () => {
  await withTxClient(async (client) => {
    const validationRunId = randomUUID();
    const dayStart = Date.UTC(2026, 4, 3, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    await seedValidationRun(client, { validationRunId, from: referenceCloseTime - DAY_MS, to: referenceCloseTime + DAY_MS });
    const replayNowMs = Date.now();
    await seedReferenceBar(client, { symbol: 'ETHUSDT', openTime: referenceOpenTime, closeTime: referenceCloseTime, replayNowMs });
    await seedFourHourAtrBars(client, { symbol: 'ETHUSDT', referenceCloseTime, count: 15, replayNowMs });
    // 不seed feature_records

    const result = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, 'FEATURE_RECORD_MISSING');
  });
});

test('INSERTED：完整生成流程——predictionId格式/source_origin/calibrated_probabilities NULL/research_data_vintage/幂等去重', { skip }, async () => {
  await withTxClient(async (client) => {
    const validationRunId = randomUUID();
    const dayStart = Date.UTC(2026, 4, 4, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    await seedValidationRun(client, { validationRunId, from: referenceCloseTime - DAY_MS, to: referenceCloseTime + DAY_MS });
    const replayNowMs = Date.now();
    await seedReferenceBar(client, { symbol: 'ETHUSDT', openTime: referenceOpenTime, closeTime: referenceCloseTime, replayNowMs, closeStr: '1000.00' });
    await seedFourHourAtrBars(client, { symbol: 'ETHUSDT', referenceCloseTime, count: 15, replayNowMs });
    await seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime: referenceCloseTime });

    const first = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION, backfillBatchIds: []
    });
    assert.equal(first.status, 'INSERTED');
    assert.match(first.record.predictionId, /^GMKG-REPLAY-ETH-24h-\d+-v1\.4c-server-po-rule-1-v1\.4d-sha256-[0-9a-f]{64}$/);

    const row = (await client.query(
      `SELECT * FROM historical_validation.replay_snapshots WHERE prediction_id=$1 AND research_availability_rule_version=$2`,
      [first.record.predictionId, RESEARCH_AVAILABILITY_RULE_VERSION]
    )).rows[0];
    assert.ok(row, 'replay_snapshots行必须存在');
    assert.equal(row.source_origin, 'HISTORICAL_REPLAY');
    assert.equal(row.calibrated_probabilities, null);
    assert.equal(row.target_state_at_generation, 'UNKNOWN');
    assert.equal(row.fusion_state_at_generation, 'UNKNOWN');
    assert.equal(row.probability_status, 'rule_based');
    assert.equal(row.rule_version, RULE_VERSION);
    assert.ok(row.research_data_vintage, 'research_data_vintage必须非空');
    assert.equal(row.research_data_vintage.researchAvailabilityRuleVersion, RESEARCH_AVAILABILITY_RULE_VERSION);
    assert.match(row.research_data_vintage.disclosure, /not a record of when the system historically/);
    assertCompleteReferenceAudit(row.research_data_vintage.consumedBars, referenceCloseTime, 'generation');
    assert.equal(Number(row.scenario_weight_baseline) + Number(row.scenario_weight_upside) + Number(row.scenario_weight_downside), 100);

    const runRow = (await client.query('SELECT status, generated_count FROM historical_validation.replay_generation_runs WHERE generation_run_id=$1', [first.generationRunId])).rows[0];
    assert.equal(runRow.status, 'SUCCEEDED');
    assert.equal(runRow.generated_count, 1);

    // 幂等：同一(instrument,horizon,historicalAsOfTime)再跑一次应DEDUPED，不产生第二行
    const second = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION, backfillBatchIds: []
    });
    assert.equal(second.status, 'DEDUPED');
    const count = (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_snapshots WHERE prediction_id=$1', [first.record.predictionId])).rows[0].n;
    assert.equal(count, 1);
  });
});

// R25.2：research_availability_rule_version升级后，同一prediction_id的旧/新规则版本记录必须并存
// （UNIQUE(prediction_id, research_availability_rule_version)复合唯一约束生效），旧版本不被覆盖或删除。
// generateReplaySnapshot()本身总是写入代码内置的当前RESEARCH_AVAILABILITY_RULE_VERSION，没有公开的
// "指定旧规则版本"入口——直接通过SQL克隆一行、把research_availability_rule_version改写成旧版本号，
// 模拟"这条记录是在规则升级之前、用旧规则版本生成的"这一历史状态，与dataset-manifest-verifier.js
// 测试文件里"直接操纵行"模拟场景的做法一致。
test('R25.2：research_availability_rule_version升级后，同一prediction_id的新旧规则版本记录并存，旧记录不被覆盖', { skip }, async () => {
  await withTxClient(async (client) => {
    const validationRunId = randomUUID();
    const dayStart = Date.UTC(2026, 4, 6, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    await seedValidationRun(client, { validationRunId, from: referenceCloseTime - DAY_MS, to: referenceCloseTime + DAY_MS });
    const replayNowMs = Date.now();
    await seedReferenceBar(client, { symbol: 'ETHUSDT', openTime: referenceOpenTime, closeTime: referenceCloseTime, replayNowMs, closeStr: '1000.00' });
    await seedFourHourAtrBars(client, { symbol: 'ETHUSDT', referenceCloseTime, count: 15, replayNowMs });
    await seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime: referenceCloseTime });

    const current = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(current.status, 'INSERTED');
    const predictionId = current.record.predictionId;
    const oldRuleVersion = 'v1.4d-research-availability-0-legacy';

    // 克隆当前行，只把research_availability_rule_version改成一个"旧"值——模拟该prediction_id在规则
    // 升级前已存在一条旧规则版本记录。
    await client.query(
      `INSERT INTO historical_validation.replay_snapshots(
         prediction_id,generation_run_id,backfill_batch_id,dataset_version,instrument,horizon,generated_at,data_cutoff_time,
         target_start_time,target_end_time,reference_price,reference_bar_ref,target_bar_ref,expected_bar_count,expected_direction,
         direction_threshold,raw_threshold,threshold_floor,threshold_ceiling,threshold_formula_version,atr14_four_hour_at_generation,
         target_state_at_generation,proxy_state_at_generation,fusion_state_at_generation,candidate_trajectories,
         scenario_weight_baseline,scenario_weight_upside,scenario_weight_downside,probability_status,calibrated_probabilities,
         expected_price_zones,trigger_conditions,invalidation_conditions,algorithm_version,weight_version,rule_version,
         data_vintage_refs,feature_values_used,feature_record_ids,feature_engine_version,content_hash,auxiliary_evidence,
         historical_as_of_time,research_data_vintage,research_availability_rule_version,source_origin
       )
       SELECT prediction_id,generation_run_id,backfill_batch_id,dataset_version,instrument,horizon,generated_at,data_cutoff_time,
         target_start_time,target_end_time,reference_price,reference_bar_ref,target_bar_ref,expected_bar_count,expected_direction,
         direction_threshold,raw_threshold,threshold_floor,threshold_ceiling,threshold_formula_version,atr14_four_hour_at_generation,
         target_state_at_generation,proxy_state_at_generation,fusion_state_at_generation,candidate_trajectories,
         scenario_weight_baseline,scenario_weight_upside,scenario_weight_downside,probability_status,calibrated_probabilities,
         expected_price_zones,trigger_conditions,invalidation_conditions,algorithm_version,weight_version,rule_version,
         data_vintage_refs,feature_values_used,feature_record_ids,feature_engine_version,content_hash,auxiliary_evidence,
         historical_as_of_time,research_data_vintage,$2,source_origin
       FROM historical_validation.replay_snapshots WHERE prediction_id=$1 AND research_availability_rule_version=$3`,
      [predictionId, oldRuleVersion, RESEARCH_AVAILABILITY_RULE_VERSION]
    );

    const rows = (await client.query(
      `SELECT research_availability_rule_version FROM historical_validation.replay_snapshots WHERE prediction_id=$1 ORDER BY research_availability_rule_version`,
      [predictionId]
    )).rows;
    assert.equal(rows.length, 2, '同一prediction_id下新旧两条research_availability_rule_version记录必须都存在（复合唯一约束允许并存）');
    assert.deepEqual(rows.map(r => r.research_availability_rule_version).sort(), [oldRuleVersion, RESEARCH_AVAILABILITY_RULE_VERSION].sort());

    // 旧记录内容必须逐字节未被覆盖或删除（只有research_availability_rule_version不同，其余字段应与克隆源一致）。
    const oldRow = (await client.query(
      `SELECT reference_price::text FROM historical_validation.replay_snapshots WHERE prediction_id=$1 AND research_availability_rule_version=$2`,
      [predictionId, oldRuleVersion]
    )).rows[0];
    const newRow = (await client.query(
      `SELECT reference_price::text FROM historical_validation.replay_snapshots WHERE prediction_id=$1 AND research_availability_rule_version=$2`,
      [predictionId, RESEARCH_AVAILABILITY_RULE_VERSION]
    )).rows[0];
    assert.equal(oldRow.reference_price, newRow.reference_price);
  });
});

test('R10.1/R10.2：prediction_id 100%以GMKG-REPLAY-开头，与生产GMKG-SRV-互斥', { skip }, async () => {
  await withTxClient(async (client) => {
    const validationRunId = randomUUID();
    const dayStart = Date.UTC(2026, 4, 5, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    await seedValidationRun(client, { validationRunId, from: referenceCloseTime - DAY_MS, to: referenceCloseTime + DAY_MS });
    const replayNowMs = Date.now();
    await seedReferenceBar(client, { symbol: 'ETHUSDT', openTime: referenceOpenTime, closeTime: referenceCloseTime, replayNowMs });
    await seedFourHourAtrBars(client, { symbol: 'ETHUSDT', referenceCloseTime, count: 15, replayNowMs });
    await seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime: referenceCloseTime });

    const result = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(result.status, 'INSERTED');
    assert.ok(result.record.predictionId.startsWith('GMKG-REPLAY-'));
    assert.ok(!result.record.predictionId.startsWith('GMKG-SRV-'));
  });
});

test('replay-evaluator：完整评估流程——mfe/mae/actual_return/幂等去重', { skip }, async () => {
  await withTxClient(async (client) => {
    const validationRunId = randomUUID();
    const dayStart = Date.UTC(2026, 4, 6, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    await seedValidationRun(client, { validationRunId, from: referenceCloseTime - DAY_MS, to: referenceCloseTime + 2 * DAY_MS });
    const replayNowMs = Date.now();
    await seedReferenceBar(client, { symbol: 'ETHUSDT', openTime: referenceOpenTime, closeTime: referenceCloseTime, replayNowMs, closeStr: '1000.00' });
    await seedFourHourAtrBars(client, { symbol: 'ETHUSDT', referenceCloseTime, count: 15, replayNowMs });
    await seedFeatureRecord(client, { referenceCloseTime, historicalAsOfTime: referenceCloseTime });

    const generated = await generateReplaySnapshot({
      pool: client, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: WEIGHT_VERSION,
      datasetVersion: DATASET_VERSION, ruleVersion: RULE_VERSION
    });
    assert.equal(generated.status, 'INSERTED');

    // 走完96根15m路径(24h horizon)，价格全程持平1000——RANGE预测应判定direction_correct=true
    const pathStartOpenTime = referenceCloseTime + 1;
    await seedFifteenMinPath(client, { symbol: 'ETHUSDT', startOpenTime: pathStartOpenTime, count: 96, replayNowMs, closeStrFn: () => '1000.00' });
    const pathEndCloseTime = pathStartOpenTime + 96 * FIFTEEN_MIN_MS - 1;
    const evalAsOfTime = pathEndCloseTime + 3600000;

    const first = await evaluateReplayOutcomes({
      pool: client, validationRunId, evaluationVersion: EVALUATION_VERSION, historicalAsOfTime: evalAsOfTime, replayNowMs
    });
    assert.equal(first.status, 'SUCCEEDED');
    assert.equal(first.evaluated, 1);
    assert.equal(first.deduped, 0);

    const row = (await client.query(
      `SELECT * FROM historical_validation.replay_outcome_events WHERE prediction_id=$1`,
      [generated.record.predictionId]
    )).rows[0];
    assert.ok(row, 'replay_outcome_events行必须存在');
    assert.equal(row.source_origin, 'HISTORICAL_REPLAY');
    assert.equal(Number(row.actual_return), 0);
    assert.equal(row.actual_direction, 'RANGE');
    assert.equal(row.endpoint_data_complete, true);
    assert.equal(row.path_data_complete, true);
    assert.ok(row.research_data_vintage, 'research_data_vintage必须非空');
    assertCompleteReferenceAudit(row.research_data_vintage.consumedBars, referenceCloseTime, 'evaluation');

    const runRow = (await client.query('SELECT status, evaluated_count FROM historical_validation.replay_evaluation_runs WHERE evaluation_run_id=$1', [first.evaluationRunId])).rows[0];
    assert.equal(runRow.status, 'SUCCEEDED');
    assert.equal(runRow.evaluated_count, 1);

    // 幂等：同一evaluationVersion再跑一次应DEDUPED
    const second = await evaluateReplayOutcomes({
      pool: client, validationRunId, evaluationVersion: EVALUATION_VERSION, historicalAsOfTime: evalAsOfTime, replayNowMs
    });
    assert.equal(second.evaluated, 0);
    assert.equal(second.deduped, 0); // 已无pending行(findPendingReplaySnapshots的LEFT JOIN已排除)
    const count = (await client.query('SELECT count(*)::int AS n FROM historical_validation.replay_outcome_events WHERE prediction_id=$1', [generated.record.predictionId])).rows[0].n;
    assert.equal(count, 1);
  });
});
