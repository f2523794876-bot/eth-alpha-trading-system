import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';
import { createGuardedResearchPgPool } from '../../src/db/research-database-guard.js';
import { loadFormalResearchContext, loadFormalResearchDataset, loadFormalResearchRows } from '../../src/validation-replay/formal-research-data-repository.js';
import { runFormalResearchFromDatabase } from '../../src/validation-replay/formal-research-orchestrator.js';
import { readRunStatus } from '../../src/validation-replay/research-run-status.js';
import { canonicalJson } from '../../src/formal-research/canonical-json.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(url);
const rule = 'v1.4d-research-availability/1';
const evaluationVersion = 'r3-batch4-real-postgres';
const datasetHash = 'd'.repeat(64);
const datasetVersion = `v1.4d-sha256-${datasetHash}`;
const targetRun = randomUUID();
const otherRun = randomUUID();
const runFrom = '2026-01-01T00:00:00.000Z';
const trainEnd = '2026-01-15T00:00:00.000Z';
const validationEnd = '2026-02-01T00:00:00.000Z';
const runTo = '2026-03-01T00:00:00.000Z';
const runStarted = '2026-04-01T00:00:00.000Z';
const runFinished = '2026-04-02T00:00:00.000Z';
let pool;
let fixtureRows = [];

const thresholds = {
  schemaVersion: 'v1.4d-go-no-go-thresholds/1', minEffectiveTest: { '24h': 1, '72h': 1 }, minClassEffectiveTest: { '24h': 0, '72h': 0 },
  minDirectionalCoverage: { '24h': 0, '72h': 0 }, minMarketRegimeCoverage: { '24h': 0, '72h': 0 },
  minWilsonLowerBound: { '24h': 0, '72h': 0 }, minPreCostLift: { '24h': -1, '72h': -1 }, minPostCostLift: { '24h': -1, '72h': -1 },
  requireAllBaselines: true, requireMarketRegime: true
};

function sha256(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function vintage(asOfTime) {
  return { researchAvailabilityRuleVersion: rule, asOfTime, consumedBars: [], backfillBatchIds: [],
    disclosure: 'FROZEN_POLICY: researchAvailability(bar)=bar.close_time' };
}

async function insertValidationRun(validationRunId, { status = 'SUCCEEDED', horizons = ['24h', '72h'] } = {}) {
  await pool.query(`INSERT INTO historical_validation.validation_runs
    (validation_run_id,dataset_version,symbol,horizons,from_utc,to_utc,algorithm_version,rule_version,train_end_utc,validation_end_utc,dry_run,status,started_at,finished_at)
    VALUES ($1,$2,'ETHUSDT',$3::jsonb,$4,$5,'algorithm-v1','rule-v1',$6,$7,false,$8,$9,$10)`,
  [validationRunId, datasetVersion, JSON.stringify(horizons), runFrom, runTo, trainEnd, validationEnd, status, runStarted, runFinished]);
}

async function insertReport(validationRunId, horizon, expectedCount) {
  const proof = { rerunAuthenticity: { gate_status: 'PASSED', expected_count: expectedCount, attempted_count: expectedCount,
    inserted_count: expectedCount, reused_identical_count: 0, conflict_count: 0, blocked_count: 0, evaluated_count: expectedCount } };
  await pool.query(`INSERT INTO historical_validation.validation_reports
    (report_id,validation_run_id,dataset_version,horizon,report_scope,direction_raw_sample_count,direction_effective_sample_count,
     path_raw_sample_count,path_effective_sample_count,sample_sufficient,formal_proxy_disclosure,algorithm_version,rule_version,
     research_availability_rule_version,content_hash)
    VALUES ($1,$2,$3,$4,'ALL',$5,$5,$5,$5,true,$6::jsonb,'algorithm-v1','rule-v1',$7,$8)`,
  [randomUUID(), validationRunId, datasetVersion, horizon, expectedCount, JSON.stringify(proof), rule, 'e'.repeat(64)]);
}

async function insertReplayRow(validationRunId, { horizon, start, direction, suffix, outcomeAsOf = null, numeric = null, nullDirection = false,
  generationStatus = 'SUCCEEDED', evaluationStatus = 'SUCCEEDED' }) {
  const hours = horizon === '24h' ? 24 : 72;
  const end = new Date(Date.parse(start) + hours * 3_600_000).toISOString();
  const predictionId = `${validationRunId}-${horizon}-${suffix}`;
  const generationRunId = randomUUID();
  const evaluationRunId = randomUUID();
  await pool.query(`INSERT INTO historical_validation.replay_generation_runs
    (generation_run_id,validation_run_id,instrument,horizon,historical_as_of_time,status,generated_count,started_at,finished_at)
    VALUES ($1,$2,'ETHUSDT',$3,$4,$5,1,'2026-04-01T01:00:00Z','2026-04-01T02:00:00Z')`,
  [generationRunId, validationRunId, horizon, start, generationStatus]);
  const featureIds = JSON.stringify([randomUUID()]);
  await pool.query(`INSERT INTO historical_validation.replay_snapshots
    (prediction_id,generation_run_id,dataset_version,instrument,horizon,generated_at,data_cutoff_time,target_start_time,target_end_time,
     reference_price,reference_bar_ref,expected_bar_count,expected_direction,direction_threshold,raw_threshold,threshold_floor,threshold_ceiling,
     threshold_formula_version,atr14_four_hour_at_generation,target_state_at_generation,proxy_state_at_generation,fusion_state_at_generation,
     candidate_trajectories,scenario_weight_baseline,scenario_weight_upside,scenario_weight_downside,probability_status,expected_price_zones,
     trigger_conditions,invalidation_conditions,algorithm_version,weight_version,rule_version,data_vintage_refs,feature_values_used,feature_record_ids,
     feature_engine_version,content_hash,auxiliary_evidence,historical_as_of_time,research_data_vintage,research_availability_rule_version,source_origin)
    VALUES ($1,$2,$3,'ETHUSDT',$4,$5,$5,$5,$6,2000,'{}'::jsonb,$7,$8,0.02,0.02,$9,$10,'threshold-v1',1,
      'UNKNOWN','PO','UNKNOWN','[]'::jsonb,34,33,33,'rule_based','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
      'algorithm-v1','weight-v1','rule-v1','[]'::jsonb,jsonb_build_object('trend4h',$8::text),$11::jsonb,'feature-v1',$12,'{}'::jsonb,$5,$13::jsonb,$14,'HISTORICAL_REPLAY')`,
  [predictionId, generationRunId, datasetVersion, horizon, start, end, horizon === '24h' ? 96 : 288, direction,
    horizon === '24h' ? 0.008 : 0.015, horizon === '24h' ? 0.05 : 0.08, featureIds, 'a'.repeat(64), JSON.stringify(vintage(start)), rule]);
  const maturity = outcomeAsOf || end;
  await pool.query(`INSERT INTO historical_validation.replay_evaluation_runs
    (evaluation_run_id,validation_run_id,historical_as_of_time,status,evaluated_count,started_at,finished_at)
    VALUES ($1,$2,$3,$4,1,'2026-04-01T03:00:00Z','2026-04-01T04:00:00Z')`,
  [evaluationRunId, validationRunId, maturity, evaluationStatus]);
  const actualReturn = numeric ?? (direction === 'DOWN' ? '-0.02' : direction === 'UP' ? '0.02' : '0.001');
  await pool.query(`INSERT INTO historical_validation.replay_outcome_events
    (prediction_id,evaluation_version,evaluation_run_id,research_availability_rule_version,evaluated_at,historical_as_of_time,as_of_time,
     endpoint_data_complete,path_data_complete,direction_eligible_for_statistics,path_eligible_for_statistics,actual_return,actual_direction,
     direction_correct,actual_high,actual_low,mfe,mae,coverage_metrics,missing_bar_refs,research_data_vintage,secondary_causes,
     attribution_evidence,not_evaluable_causes,source_origin,content_hash)
    VALUES ($1,$2,$3,$4,'2026-04-01T03:30:00Z',$5,$5,true,true,true,true,$6,$7,true,1,1,0.03,0.01,'{}'::jsonb,
      '[]'::jsonb,$8::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'HISTORICAL_REPLAY',$9)`,
  [predictionId, evaluationVersion, evaluationRunId, rule, maturity, nullDirection ? null : actualReturn, nullDirection ? null : direction,
    JSON.stringify(vintage(maturity)), 'b'.repeat(64)]);
  return { predictionId, horizon, start, end };
}

async function seedFullRun(validationRunId) {
  await insertValidationRun(validationRunId);
  const plan = {
    '24h': [
      ['2026-01-02T00:00:00Z', 'UP', 'train-up'], ['2026-01-05T00:00:00Z', 'DOWN', 'train-down'], ['2026-01-08T00:00:00Z', 'RANGE', 'train-range'],
      ['2026-01-16T00:00:00Z', 'UP', 'validation'], ['2026-01-31T00:00:00Z', 'RANGE', 'test-boundary'],
      ['2026-02-02T00:00:00Z', 'UP', 'test-up'], ['2026-02-04T00:00:00Z', 'DOWN', 'test-down']],
    '72h': [
      ['2026-01-02T00:00:00Z', 'UP', 'train-up'], ['2026-01-06T00:00:00Z', 'DOWN', 'train-down'], ['2026-01-10T00:00:00Z', 'RANGE', 'train-range'],
      ['2026-01-16T00:00:00Z', 'UP', 'validation'], ['2026-01-29T00:00:00Z', 'RANGE', 'test-boundary'],
      ['2026-02-03T00:00:00Z', 'UP', 'test-up'], ['2026-02-08T00:00:00Z', 'DOWN', 'test-down']]
  };
  const inserted = [];
  for (const [horizon, rows] of Object.entries(plan)) {
    for (const index of [5, 0, 6, 2, 4, 1, 3]) {
      const [start, direction, suffix] = rows[index];
      inserted.push(await insertReplayRow(validationRunId, { horizon, start, direction, suffix }));
    }
    await insertReport(validationRunId, horizon, rows.length);
  }
  return inserted;
}

function artifactCore({ decision, governanceRef, d8Input, validationRunId, evaluationVersion: version }) {
  return { validationRunId, evaluationVersion: version, gitObjectFormat: 'SHA1', sourceCommit: 'a'.repeat(40),
    d8InputSha256: sha256(canonicalJson(d8Input)), researchFrom: runFrom, researchTo: runTo, fixedAsOf: runTo,
    thresholds: d8Input.thresholds, scorecard: d8Input.scorecard, auditTrail: d8Input.auditTrail,
    decision, governanceAuthorizationRef: governanceRef };
}

before(async () => {
  if (skip) return;
  pool = await createGuardedResearchPgPool({ databaseUrl: url, connectionString: url, max: 1 }, {
    env: process.env, createPgPool: async config => {
      const owner = new Pool({ connectionString: config.connectionString, max: config.max });
      const client = await owner.connect();
      return { query: (...args) => client.query(...args), end: async () => { client.release(); await owner.end(); } };
    }
  });
  const identity = await pool.query('SELECT current_database() AS database');
  assert.equal(identity.rows[0].database, 'eth_alpha_v14d_authenticity_ci');
  await pool.query('BEGIN');
  await pool.query(`INSERT INTO historical_validation.dataset_manifests
    (dataset_version,manifest_schema_version,manifest_hash_algorithm_version,symbol,intervals,data_from,data_to,backfill_batch_ids,
     source_formal_semantics,research_availability_rule_version,record_count,per_interval_record_count,integrity_check_result,manifest_members,
     manifest_contract_version,dataset_type)
    VALUES ($1,'manifest-v1','sha256','ETHUSDT','["15m"]'::jsonb,$2,$3,'[]'::jsonb,'market_bars:formal:spot',$4,1,
      '{"15m":1}'::jsonb,'{"ETHUSDT":{"gapCount":0,"duplicateCount":0,"outOfOrderCount":0}}'::jsonb,'[{"symbol":"ETHUSDT"}]'::jsonb,1,'MARKET_BARS')`,
  [datasetVersion, runFrom, runTo, rule]);
  fixtureRows = (await seedFullRun(targetRun)).sort((a, b) => a.horizon.localeCompare(b.horizon) || Date.parse(a.start) - Date.parse(b.start) || a.predictionId.localeCompare(b.predictionId));
  await insertValidationRun(otherRun, { horizons: ['24h'] });
  await insertReplayRow(otherRun, { horizon: '24h', start: fixtureRows[0].start, direction: 'DOWN', suffix: 'same-timestamp-other-run' });
  await insertReport(otherRun, '24h', 1);
});

after(async () => {
  if (!pool) return;
  try { await pool.query('ROLLBACK'); } finally { await pool.end(); }
});

test('真实PostgreSQL：完整链路、双run同算法/数据集/horizon/timestamp严格隔离且分页顺序确定', { skip }, async () => {
  const first = await loadFormalResearchDataset(pool, { validationRunId: targetRun, evaluationVersion, pageSize: 3 });
  const second = await loadFormalResearchDataset(pool, { validationRunId: targetRun, evaluationVersion, pageSize: 2 });
  assert.equal(first.rows.length, 14);
  assert.equal(first.rows.some(row => row.predictionId.includes('same-timestamp-other-run')), false);
  assert.equal(first.rows.filter(row => row.targetEndTime === Date.parse(validationEnd)).length, 2, '24h/72h精确targetEnd边界必须保留');
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first.rows.map(row => [row.horizon, row.targetStartTime, row.predictionId]),
    [...first.rows].sort((a, b) => a.horizon.localeCompare(b.horizon) || a.targetStartTime - b.targetStartTime || a.predictionId.localeCompare(b.predictionId))
      .map(row => [row.horizon, row.targetStartTime, row.predictionId]));
  assert.equal(first.auditTrail.generationSummary.expected, 14);
});

test('真实PostgreSQL：manifest/authenticity数据库证据缺失或冲突时阻断', { skip }, async () => {
  await pool.query('SAVEPOINT authenticity_conflict');
  await pool.query(`UPDATE historical_validation.validation_reports
    SET formal_proxy_disclosure=jsonb_set(formal_proxy_disclosure,'{rerunAuthenticity,gate_status}','"FAILED"'::jsonb)
    WHERE validation_run_id=$1 AND horizon='24h' AND report_scope='ALL'`, [targetRun]);
  await assert.rejects(loadFormalResearchContext(pool, { validationRunId: targetRun }),
    error => error.code === 'FORMAL_RESEARCH_DATABASE_AUTHENTICITY_NOT_PROVEN');
  await pool.query('ROLLBACK TO SAVEPOINT authenticity_conflict');
});

test('真实PostgreSQL：空run、非SUCCEEDED validation/generation/evaluation均阻断', { skip }, async () => {
  await assert.rejects(loadFormalResearchRows(pool, { validationRunId: randomUUID(), evaluationVersion }), error => error.code === 'FORMAL_RESEARCH_VALIDATION_RUN_NOT_FOUND');
  for (const [kind, validationStatus, generationStatus, evaluationStatus] of [
    ['validation', 'FAILED', 'SUCCEEDED', 'SUCCEEDED'], ['generation', 'SUCCEEDED', 'FAILED', 'SUCCEEDED'], ['evaluation', 'SUCCEEDED', 'SUCCEEDED', 'BLOCKED']
  ]) {
    await pool.query(`SAVEPOINT ${kind}`);
    const id = randomUUID();
    await insertValidationRun(id, { status: validationStatus, horizons: ['24h'] });
    await insertReplayRow(id, { horizon: '24h', start: '2026-02-10T00:00:00Z', direction: 'UP', suffix: kind, generationStatus, evaluationStatus });
    await insertReport(id, '24h', 1);
    await assert.rejects(loadFormalResearchRows(pool, { validationRunId: id, evaluationVersion }), error =>
      validationStatus !== 'SUCCEEDED' ? error.code === 'FORMAL_RESEARCH_VALIDATION_RUN_NOT_ELIGIBLE' : error.code === 'FORMAL_RESEARCH_NO_ELIGIBLE_ROWS');
    await pool.query(`ROLLBACK TO SAVEPOINT ${kind}`);
  }
});

test('真实PostgreSQL：首条/中间/末条缺失与真实性计数冲突均fail-closed', { skip }, async () => {
  for (const [index, label] of [[0, 'first_missing'], [7, 'middle_gap'], [13, 'last_missing']]) {
    await pool.query(`SAVEPOINT ${label}`);
    await pool.query('DELETE FROM historical_validation.replay_outcome_events WHERE prediction_id=$1', [fixtureRows[index].predictionId]);
    await assert.rejects(loadFormalResearchDataset(pool, { validationRunId: targetRun, evaluationVersion, pageSize: 4 }),
      error => error.code === 'FORMAL_RESEARCH_DATABASE_AUTHENTICITY_NOT_PROVEN');
    await pool.query(`ROLLBACK TO SAVEPOINT ${label}`);
  }
});

test('真实PostgreSQL：duplicate约束失败可回滚，乱序插入/同timestamp不改变确定性', { skip }, async () => {
  const beforeResult = await loadFormalResearchDataset(pool, { validationRunId: targetRun, evaluationVersion });
  await pool.query('SAVEPOINT duplicate_attempt');
  await assert.rejects(pool.query(`INSERT INTO historical_validation.replay_outcome_events
    (prediction_id,evaluation_version,evaluation_run_id,research_availability_rule_version,evaluated_at,historical_as_of_time,as_of_time,
     endpoint_data_complete,path_data_complete,direction_eligible_for_statistics,path_eligible_for_statistics,research_data_vintage,source_origin,content_hash)
     SELECT prediction_id,evaluation_version,evaluation_run_id,research_availability_rule_version,evaluated_at,historical_as_of_time,as_of_time,
       endpoint_data_complete,path_data_complete,false,false,research_data_vintage,source_origin,content_hash
       FROM historical_validation.replay_outcome_events WHERE prediction_id=$1`, [fixtureRows[0].predictionId]), error => error.code === '23505');
  await pool.query('ROLLBACK TO SAVEPOINT duplicate_attempt');
  const afterResult = await loadFormalResearchDataset(pool, { validationRunId: targetRun, evaluationVersion });
  assert.equal(canonicalJson(beforeResult), canonicalJson(afterResult));
});

test('真实PostgreSQL：NULL、NaN与future/as-of越界行阻断整个FORMAL输入', { skip }, async () => {
  for (const [label, options, expectedCode] of [
    ['bad_null', { nullDirection: true }, 'FORMAL_RESEARCH_DATABASE_ROW_INVALID'],
    ['bad_nan', { numeric: 'NaN' }, 'FORMAL_RESEARCH_DATABASE_ROW_INVALID'],
    ['bad_future', { outcomeAsOf: '2026-02-09T00:00:00Z' }, 'FORMAL_RESEARCH_DATABASE_AUTHENTICITY_NOT_PROVEN']
  ]) {
    await pool.query(`SAVEPOINT ${label}`);
    await insertReplayRow(targetRun, { horizon: '24h', start: '2026-02-10T00:00:00Z', direction: 'UP', suffix: label, ...options });
    await pool.query(`UPDATE historical_validation.validation_reports SET formal_proxy_disclosure=jsonb_set(formal_proxy_disclosure,
      '{rerunAuthenticity}', (formal_proxy_disclosure->'rerunAuthenticity') || '{"expected_count":8,"attempted_count":8,"inserted_count":8,"evaluated_count":8}'::jsonb)
      WHERE validation_run_id=$1 AND horizon='24h' AND report_scope='ALL'`, [targetRun]);
    await assert.rejects(loadFormalResearchDataset(pool, { validationRunId: targetRun, evaluationVersion }), error => error.code === expectedCode);
    await pool.query(`ROLLBACK TO SAVEPOINT ${label}`);
  }
});

test('真实PostgreSQL：guarded database orchestrator正常运行、重复执行确定，失败留下稳定状态且不发布', { skip }, async () => {
  const artifactRoot = mkdtempSync(path.join('/private/tmp', 'r3b4-pg-artifact-'));
  const statusRoot = mkdtempSync(path.join('/private/tmp', 'r3b4-pg-status-'));
  try {
    const options = { pool, validationRunId: targetRun, evaluationVersion, artifactMode: 'DRY_RUN', statusRoot, artifactRoot,
      batchSize: 3, scorecardOptions: { feeBps: 5, slippageBps: 3, trainEnd: 0, validationEnd: 1 },
      thresholds, buildArtifactCore: artifactCore, manifestContentHash: datasetHash };
    const first = await runFormalResearchFromDatabase(options);
    assert.equal(first.published, true, JSON.stringify(first.error));
    assert.equal(first.runStatus.runState, 'COMPLETED');
    const second = await runFormalResearchFromDatabase(options);
    assert.equal(second.resumed, true);
    assert.equal(second.skippedRecompute, true);

    const failedStatusRoot = mkdtempSync(path.join('/private/tmp', 'r3b4-pg-failed-status-'));
    try {
      const invalidRoot = path.join(artifactRoot, 'does-not-exist');
      await assert.rejects(runFormalResearchFromDatabase({ ...options, statusRoot: failedStatusRoot, artifactRoot: invalidRoot }),
        error => error.code === 'ARTIFACT_ROOT_INVALID');
      assert.equal(readRunStatus(failedStatusRoot, 'DRY_RUN', targetRun).runState, 'FAILED');
    } finally { rmSync(failedStatusRoot, { recursive: true, force: true }); }
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(statusRoot, { recursive: true, force: true });
  }
});

test('真实PostgreSQL：repository空结果在读取前已有状态，并以FAILED终止且不发布', { skip }, async () => {
  const unknownRun = randomUUID();
  const artifactRoot = mkdtempSync(path.join('/private/tmp', 'r3b4-empty-artifact-'));
  const statusRoot = mkdtempSync(path.join('/private/tmp', 'r3b4-empty-status-'));
  try {
    const result = await runFormalResearchFromDatabase({ pool, validationRunId: unknownRun, evaluationVersion, artifactMode: 'DRY_RUN',
      statusRoot, artifactRoot, batchSize: 2, scorecardOptions: {}, thresholds, buildArtifactCore: artifactCore });
    assert.equal(result.published, false);
    assert.equal(result.runStatus.runState, 'FAILED');
    assert.equal(result.runStatus.blockedReasonCode, 'FORMAL_RESEARCH_VALIDATION_RUN_NOT_FOUND');
    assert.equal(readRunStatus(statusRoot, 'DRY_RUN', unknownRun).runState, 'FAILED');
  } finally { rmSync(artifactRoot, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('真实PostgreSQL：checkpoint持久化失败留下FAILED，且不进入artifact发布', { skip }, async () => {
  const artifactRoot = mkdtempSync(path.join('/private/tmp', 'r3b4-checkpoint-artifact-'));
  const statusRoot = mkdtempSync(path.join('/private/tmp', 'r3b4-checkpoint-status-'));
  const symlinkTarget = mkdtempSync(path.join('/private/tmp', 'r3b4-checkpoint-target-'));
  try {
    symlinkSync(symlinkTarget, path.join(statusRoot, 'database-page-checkpoints'));
    const result = await runFormalResearchFromDatabase({ pool, validationRunId: targetRun, evaluationVersion, artifactMode: 'DRY_RUN',
      statusRoot, artifactRoot, batchSize: 2, scorecardOptions: { feeBps: 5, slippageBps: 3, trainEnd: Date.parse(trainEnd), validationEnd: Date.parse(validationEnd) },
      thresholds, buildArtifactCore: artifactCore });
    assert.equal(result.published, false);
    assert.equal(result.runStatus.runState, 'FAILED');
    assert.equal(result.runStatus.completedBatchIndices.length, 0);
    assert.equal(readRunStatus(statusRoot, 'DRY_RUN', targetRun).runState, 'FAILED');
  } finally {
    rmSync(statusRoot, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(symlinkTarget, { recursive: true, force: true });
  }
});

test('database orchestrator拒绝未经guard capability验证的pool，生产wiring不能绕过', { skip }, async () => {
  const statusRoot = mkdtempSync(path.join('/private/tmp', 'r3b4-unguarded-status-'));
  try {
    await assert.rejects(runFormalResearchFromDatabase({ pool: { query: pool.query.bind(pool) }, validationRunId: targetRun,
      evaluationVersion, artifactMode: 'DRY_RUN', statusRoot }), error => error.code === 'DATABASE_POOL_NOT_GUARDED');
  } finally { rmSync(statusRoot, { recursive: true, force: true }); }
});
