// T19 FORMAL research orchestration.
// Production database wiring is present and accepts only a capability-bearing
// pool returned by createGuardedResearchPgPool(). T13 rows are read with
// deterministic keyset pagination, validated pages are durably checkpointed,
// and D8 is projected only from the authoritative research-scorecard pipeline.
// This module exposes no HTTP/CLI trigger and never authorizes a 180-day run.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { computeMarketRegimeStatistics } from './governance-statistics.js';
import { buildDeterministicScorecard } from './deterministic-scorecard.js';
import { evaluateGoNoGo } from '../formal-research/go-no-go-evaluator.js';
import { canonicalJson } from '../formal-research/canonical-json.js';
import { resolveGovernanceAuthorizationRef } from './governance-authorization.js';
import { publishArtifact } from './artifact-publisher.js';
import { readArtifactPair } from './artifact-reader.js';
import { assembleD8InputFromResearchRows } from './d8-input-assembler.js';
import {
  loadFormalResearchContext, loadFormalResearchPage, countFormalResearchRows, deriveFormalResearchAuditTrail
} from './formal-research-data-repository.js';
import { assertGuardedResearchPgPool } from '../db/research-database-guard.js';
import { freezeFormalRunConfig } from './formal-run-config.js';
import {
  createResearchRunIdentity, readRunStatus, writeRunStatus, initialRunStatus, withBatchPlan, withBatchCompleted, withBlocked, withCompleted, withFailed
} from './research-run-status.js';
import {
  ensureDirectorySafe, writeTempFileDurable, renameNoReplace, fsyncDirectory,
  readFileNoFollowSymlink, lstatIfExists, newLockId, evaluationIdentity
} from './artifact-fs-primitives.js';

function fail(code, message = code) { return Object.assign(new Error(message), { code }); }
const DATABASE_RUN_IDENTITY = Symbol('databaseRunIdentity');
function safeCode(error, fallback) { return /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : fallback; }
function sha256(value) { return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }

function runConfig(options, source, extra = {}) {
  return {
    source,
    scorecardOptions: options.scorecardOptions ?? null,
    validationRunFinishedAt: options.validationRunFinishedAt ?? null,
    thresholds: options.thresholds ?? null,
    expectedThresholdsSha256: options.expectedThresholdsSha256 ?? null,
    governanceRecordSha256: options.governanceRecord == null ? null : sha256(options.governanceRecord),
    manifestContentHash: options.manifestContentHash ?? null,
    batchSize: source === 'DATABASE' ? (options.batchSize ?? 1000) : null,
    batchPlanSha256: source === 'MEMORY' ? sha256(options.batches) : null,
    ...extra
  };
}

function artifactTargetDir(root, artifactMode, validationRunId, evaluationVersion) {
  return path.join(root, artifactMode === 'FORMAL' ? 'formal' : 'dry-run', validationRunId, evaluationIdentity(evaluationVersion));
}

function verifyCompletedArtifact(artifactRoot, status) {
  const pair = readArtifactPair(artifactTargetDir(artifactRoot, status.artifactMode, status.validationRunId, status.evaluationVersion));
  if (pair.readerStatus !== 'ACCEPTED' || pair.sidecar.fullMainArtifactSha256 !== status.publishedArtifactSha256 ||
      pair.artifact.core.validationRunId !== status.validationRunId || pair.artifact.core.evaluationVersion !== status.evaluationVersion ||
      pair.artifact.artifactMode !== status.artifactMode ||
      (status.sourceCommit !== null && pair.artifact.core.sourceCommit !== status.sourceCommit) ||
      (status.datasetVersion !== null && pair.artifact.core.auditTrail?.datasetVersion !== status.datasetVersion) ||
      (status.researchFrom !== null && pair.artifact.core.researchFrom !== status.researchFrom) ||
      (status.researchTo !== null && pair.artifact.core.researchTo !== status.researchTo) ||
      (status.fixedAsOf !== null && pair.artifact.core.fixedAsOf !== status.fixedAsOf)) {
    throw fail('ORCHESTRATOR_COMPLETED_ARTIFACT_INVALID', 'COMPLETED status is not backed by the exact published artifact pair');
  }
  return pair;
}

function validateBatchPlan(batches) {
  if (!Array.isArray(batches) || !batches.length || batches.some((batch, index) =>
    batch?.batchIndex !== index || !Array.isArray(batch.governanceRows) || !Array.isArray(batch.scorecardRows))) {
    throw fail('ORCHESTRATOR_BATCH_PLAN_INVALID', 'batches must be one contiguous, ordered non-empty plan');
  }
}

function checkpointForBatch(batch, cursor = null) {
  return { batchIndex: batch.batchIndex, rowCount: batch.scorecardRows.length, cursor, sha256: sha256(batch) };
}

function verifyCompletedPrefix(status, batches) {
  for (const checkpoint of status.batchCheckpoints) {
    const batch = batches[checkpoint.batchIndex];
    if (!batch || checkpoint.rowCount !== batch.scorecardRows.length || checkpoint.sha256 !== sha256(batch)) {
      throw fail('ORCHESTRATOR_CHECKPOINT_CONFLICT', 'persisted checkpoint does not match the current deterministic batch');
    }
  }
}

function persistFailure(statusRoot, status, state, code) {
  const next = state === 'BLOCKED' ? withBlocked(status, code) : withFailed(status, code);
  try { return writeRunStatus(statusRoot, next); }
  catch (error) {
    if (error?.code === 'RUN_STATUS_STALE_UPDATE' || error?.code === 'RUN_STATUS_ILLEGAL_TRANSITION') {
      const latest = readRunStatus(statusRoot, status);
      if (latest) return latest;
    }
    throw error;
  }
}

export function runFormalResearchOrchestrator(options) {
  const {
    statusRoot, artifactRoot, validationRunId, evaluationVersion, artifactMode,
    batches, scorecardOptions, validationRunFinishedAt,
    assembleD8Input = null, buildArtifactCore,
    thresholds, databaseAuditTrail,
    governanceRecord = null, expectedThresholdsSha256 = null,
    manifestContentHash, lockTimeoutMs
  } = options;

  validateBatchPlan(batches);
  if (artifactMode !== 'FORMAL' && artifactMode !== 'DRY_RUN') throw fail('ORCHESTRATOR_INVALID_INPUT', 'artifactMode must be FORMAL or DRY_RUN');
  if (assembleD8Input !== null && typeof assembleD8Input !== 'function') throw fail('ORCHESTRATOR_INVALID_INPUT', 'assembleD8Input must be a function');
  if (typeof buildArtifactCore !== 'function') throw fail('ORCHESTRATOR_INVALID_INPUT', 'buildArtifactCore hook is required');

  const runIdentity = options[DATABASE_RUN_IDENTITY] ||
    createResearchRunIdentity({ validationRunId, evaluationVersion, artifactMode, config: runConfig(options, 'MEMORY') });
  let status = readRunStatus(statusRoot, runIdentity);
  if (status?.runState === 'COMPLETED') {
    try { verifyCompletedArtifact(artifactRoot, status); }
    catch (error) {
      const code = safeCode(error, 'ORCHESTRATOR_COMPLETED_ARTIFACT_INVALID');
      return { runStatus: status, published: false, error: { code, message: code } };
    }
    return { runStatus: status, published: true, resumed: true, skippedRecompute: true };
  }
  if (!status) {
    status = initialRunStatus({ runIdentity, totalBatches: batches.length });
    status = writeRunStatus(statusRoot, status);
  } else if (status.totalBatches !== batches.length) {
    throw fail('ORCHESTRATOR_BATCH_PLAN_MISMATCH', 'resumed run batch plan differs from the persisted plan');
  }

  try {
    verifyCompletedPrefix(status, batches);
  } catch (error) {
    status = persistFailure(statusRoot, status, 'BLOCKED', safeCode(error, 'ORCHESTRATOR_CHECKPOINT_CONFLICT'));
    return { runStatus: status, published: false, error: { code: status.blockedReasonCode, message: status.blockedReasonCode } };
  }

  const accumulatedGovernanceRows = [];
  const accumulatedScorecardRows = [];
  let statistics;
  let scorecardResult;
  for (const batch of batches) {
    accumulatedGovernanceRows.push(...batch.governanceRows);
    accumulatedScorecardRows.push(...batch.scorecardRows);
    if (status.completedBatchIndices.includes(batch.batchIndex)) continue;
    try {
      // A checkpoint represents an actually validated prefix, never merely a
      // page that was observed or scheduled.
      statistics = computeMarketRegimeStatistics(accumulatedGovernanceRows);
      scorecardResult = buildDeterministicScorecard(accumulatedScorecardRows, scorecardOptions, { validationRunFinishedAt });
      status = withBatchCompleted(status, batch.batchIndex, { checkpoint: checkpointForBatch(batch, batch.cursor ?? null) });
      status = writeRunStatus(statusRoot, status);
    } catch (error) {
      const code = safeCode(error, 'ORCHESTRATOR_BATCH_VALIDATION_FAILED');
      status = persistFailure(statusRoot, status, 'BLOCKED', code);
      return { runStatus: status, published: false, error: { code, message: code } };
    }
  }

  let d8Input, decision, governanceRef, core;
  try {
    statistics = statistics || computeMarketRegimeStatistics(accumulatedGovernanceRows);
    scorecardResult = scorecardResult || buildDeterministicScorecard(accumulatedScorecardRows, scorecardOptions, { validationRunFinishedAt });
    d8Input = assembleD8Input
      ? assembleD8Input({ statistics, scorecardResult, validationRunId, evaluationVersion, validationRunFinishedAt })
      : assembleD8InputFromResearchRows({
          scorecardResult, validationRunId, evaluationVersion, evaluatedAt: validationRunFinishedAt,
          thresholds, databaseAuditTrail
        });
    decision = evaluateGoNoGo(d8Input);
    governanceRef = resolveGovernanceAuthorizationRef({
      artifactMode, record: governanceRecord, expectedValidationRunId: validationRunId, expectedThresholdsSha256
    });
    if (artifactMode === 'FORMAL' && decision.overall.status === 'DATA_GATE_FAILED') {
      throw fail('ORCHESTRATOR_FORMAL_DATA_GATE_FAILED', 'FORMAL publication is forbidden when D8 data gates fail');
    }
  } catch (error) {
    const code = safeCode(error, 'ORCHESTRATOR_EVALUATION_FAILED');
    status = persistFailure(statusRoot, status, 'BLOCKED', code);
    return { runStatus: status, published: false, decision, error: { code, message: code } };
  }

  try {
    core = buildArtifactCore({ decision, governanceRef, statistics, scorecardResult, validationRunId, evaluationVersion, d8Input });
  } catch (error) {
    const code = safeCode(error, 'ORCHESTRATOR_ARTIFACT_CORE_FAILED');
    status = persistFailure(statusRoot, status, 'FAILED', code);
    return { runStatus: status, published: false, error: { code, message: code } };
  }

  let publishResult;
  try {
    publishResult = publishArtifact({
      root: artifactRoot, artifactMode, validationRunId, evaluationVersion, core,
      manifestContentHash, validationRunFinishedAt, lockTimeoutMs
    });
  } catch (error) {
    const code = safeCode(error, 'ORCHESTRATOR_PUBLISH_THREW');
    persistFailure(statusRoot, status, 'FAILED', code);
    throw fail(code, code);
  }
  if (publishResult.operationStatus === 'FAILED') {
    const code = safeCode({ code: publishResult.reasonCode }, 'ORCHESTRATOR_PUBLICATION_FAILED');
    status = persistFailure(statusRoot, status, 'FAILED', code);
    return { runStatus: status, published: false, publishResult };
  }
  const publishedPair = verifyCompletedArtifact(artifactRoot, { ...status, evaluationVersion, artifactMode,
    publishedArtifactSha256: readArtifactPair(artifactTargetDir(artifactRoot, artifactMode, validationRunId, evaluationVersion)).sidecar?.fullMainArtifactSha256 });
  status = withCompleted(status, { publishedArtifactSha256: publishedPair.sidecar.fullMainArtifactSha256 });
  status = writeRunStatus(statusRoot, status);
  return { runStatus: status, published: true, publishResult, decision, statistics, scorecardResult };
}

function checkpointDirectory(statusRoot, runIdentity) {
  return path.join(statusRoot, 'database-page-checkpoints', runIdentity.artifactMode === 'FORMAL' ? 'formal' : 'dry-run',
    runIdentity.validationRunId, runIdentity.runIdentitySha256);
}

function checkpointPath(statusRoot, runIdentity, batchIndex) {
  return path.join(checkpointDirectory(statusRoot, runIdentity), `${batchIndex}.json`);
}

function checkpointIdentity(runIdentity) {
  const { validationRunId, artifactMode, configSha256, sourceCommit, datasetVersion, algorithmVersion, ruleVersion,
    evaluationVersion, weightVersion, horizons, researchFrom, researchTo, fixedAsOf, runIdentitySha256 } = runIdentity;
  return { validationRunId, artifactMode, configSha256, sourceCommit, datasetVersion, algorithmVersion, ruleVersion,
    evaluationVersion, weightVersion, horizons, researchFrom, researchTo, fixedAsOf, runIdentitySha256 };
}

function readDatabasePageCheckpoint(statusRoot, runIdentity, checkpoint) {
  const target = checkpointPath(statusRoot, runIdentity, checkpoint.batchIndex);
  const stat = lstatIfExists(target);
  if (!stat || stat.isSymbolicLink()) throw fail('ORCHESTRATOR_CHECKPOINT_MISSING', 'database page checkpoint is missing');
  const { bytes } = readFileNoFollowSymlink(target, 50_000_000);
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw fail('ORCHESTRATOR_CHECKPOINT_CONFLICT', 'database page checkpoint is not valid JSON'); }
  if (canonicalJson(payload.runIdentity) !== canonicalJson(checkpointIdentity(runIdentity))) {
    throw fail('ORCHESTRATOR_CHECKPOINT_IDENTITY_MISMATCH', 'database checkpoint belongs to another run identity');
  }
  const batch = { batchIndex: payload.batchIndex, governanceRows: payload.rows, scorecardRows: payload.rows, cursor: payload.nextCursor };
  if (checkpoint.sha256 !== sha256(batch) || checkpoint.rowCount !== payload.rows?.length) {
    throw fail('ORCHESTRATOR_CHECKPOINT_CONFLICT', 'database page checkpoint hash mismatch');
  }
  return batch;
}

function writeDatabasePageCheckpoint(statusRoot, runIdentity, batch) {
  const dir = checkpointDirectory(statusRoot, runIdentity);
  ensureDirectorySafe(dir, statusRoot);
  const target = checkpointPath(statusRoot, runIdentity, batch.batchIndex);
  const payload = { schemaVersion: 'v1.4d-formal-db-page-checkpoint/3', runIdentity: checkpointIdentity(runIdentity),
    batchIndex: batch.batchIndex, rows: batch.scorecardRows, nextCursor: batch.cursor };
  const bytes = Buffer.from(canonicalJson(payload), 'utf8');
  if (lstatIfExists(target)) {
    const existing = readDatabasePageCheckpoint(statusRoot, runIdentity, checkpointForBatch(batch, batch.cursor));
    if (existing.batchIndex === batch.batchIndex) return;
  }
  const temp = path.join(dir, `.${batch.batchIndex}.tmp.${process.pid}.${newLockId()}`);
  writeTempFileDurable(temp, bytes);
  try { renameNoReplace(temp, target); } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best-effort orphan cleanup */ }
    if (!lstatIfExists(target)) throw error;
    readDatabasePageCheckpoint(statusRoot, runIdentity, checkpointForBatch(batch, batch.cursor));
  }
  fsyncDirectory(dir);
}

// The only production database entry point.  Its first durable action is a
// RUNNING status write; repository, mapping, artifact-core and publication
// failures therefore always leave an auditable terminal state.
export async function runFormalResearchFromDatabase(options) {
  const frozen = freezeFormalRunConfig(options.formalRunConfig);
  const config = frozen.config;
  const { pool, batchSize = 1000, statusRoot } = options;
  const { validationRunId, evaluationVersion, artifactMode } = config;
  if (options.validationRunId !== undefined && options.validationRunId !== validationRunId ||
      options.evaluationVersion !== undefined && options.evaluationVersion !== evaluationVersion ||
      options.artifactMode !== undefined && options.artifactMode !== artifactMode ||
      options.artifactRoot !== undefined && options.artifactRoot !== config.artifactRoot) {
    throw fail('ORCHESTRATOR_RUN_CONFIG_MISMATCH', 'runtime options conflict with the frozen formal run config');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw fail('ORCHESTRATOR_INVALID_INPUT', 'batchSize must be 1..10000');

  const runIdentity = createResearchRunIdentity({ validationRunId, evaluationVersion, artifactMode, config });
  let status = readRunStatus(statusRoot, runIdentity);
  if (status?.runState === 'COMPLETED') {
    try { verifyCompletedArtifact(config.artifactRoot, status); }
    catch (error) {
      const code = safeCode(error, 'ORCHESTRATOR_COMPLETED_ARTIFACT_INVALID');
      return { runStatus: status, published: false, error: { code, message: code } };
    }
    return { runStatus: status, published: true, resumed: true, skippedRecompute: true };
  }
  if (status?.runState === 'FAILED' || status?.runState === 'BLOCKED') {
    const code = status.blockedReasonCode;
    return { runStatus: status, published: false, resumed: true, error: { code, message: code } };
  }
  if (!status) {
    status = initialRunStatus({ runIdentity, totalBatches: 1 });
    try { status = writeRunStatus(statusRoot, status); }
    catch { throw fail('ORCHESTRATOR_STATUS_PERSIST_FAILED', 'unable to persist startup audit status'); }
  }

  let context, count;
  try {
    assertGuardedResearchPgPool(pool);
    context = await loadFormalResearchContext(pool, { validationRunId });
    if (context.datasetVersion !== config.datasetVersion || context.algorithmVersion !== config.algorithmVersion ||
        context.ruleVersion !== config.ruleVersion || context.from !== Date.parse(config.researchFrom) ||
        context.to !== Date.parse(config.researchTo)) {
      throw fail('ORCHESTRATOR_RUN_CONFIG_DATABASE_MISMATCH', 'database validation identity conflicts with frozen config');
    }
    context = { ...context, weightVersion: config.weightVersion };
    count = await countFormalResearchRows(pool, { validationRunId, evaluationVersion });
  } catch (error) {
    const code = safeCode(error, 'ORCHESTRATOR_REPOSITORY_FAILED');
    try { status = persistFailure(statusRoot, status, 'FAILED', code); }
    catch { throw fail('ORCHESTRATOR_STATUS_PERSIST_FAILED', 'unable to persist repository failure status'); }
    return { runStatus: status, published: false, error: { code, message: code } };
  }
  const databaseScorecardOptions = { feeBps: config.costs.feeBps, slippageBps: config.costs.slippageBps,
    trainEnd: context.trainEnd, validationEnd: context.validationEnd };
  const resolvedOptions = { ...options, scorecardOptions: databaseScorecardOptions,
    validationRunFinishedAt: context.validationRunFinishedAt, manifestContentHash: context.manifestContentHash };
  const totalBatches = Math.max(1, Math.ceil(count / batchSize));
  if (status.completedBatchIndices.length === 0 && status.totalBatches !== totalBatches) {
    status = withBatchPlan(status, totalBatches);
    status = writeRunStatus(statusRoot, status);
  } else if (status.totalBatches !== totalBatches) {
    const code = 'ORCHESTRATOR_BATCH_PLAN_MISMATCH';
    status = persistFailure(statusRoot, status, 'BLOCKED', code);
    return { runStatus: status, published: false, error: { code, message: code } };
  }

  const batches = [];
  let cursor = null;
  try {
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
      let batch;
      if (status.completedBatchIndices.includes(batchIndex)) {
        batch = readDatabasePageCheckpoint(statusRoot, runIdentity, status.batchCheckpoints[batchIndex]);
      } else {
        const page = count === 0
          ? { rows: [], nextCursor: null }
          : await loadFormalResearchPage(pool, { validationRunId, evaluationVersion, context, limit: batchSize, cursor });
        if (count !== 0 && !page.rows.length) throw fail('ORCHESTRATOR_PARTIAL_REPOSITORY_RESULT', 'repository ended before the declared count');
        batch = { batchIndex, governanceRows: page.rows, scorecardRows: page.rows, cursor: page.nextCursor };
        const prefixRows = [...batches.flatMap(value => value.scorecardRows), ...page.rows];
        computeMarketRegimeStatistics(prefixRows);
        buildDeterministicScorecard(prefixRows, databaseScorecardOptions, { validationRunFinishedAt: context.validationRunFinishedAt });
        writeDatabasePageCheckpoint(statusRoot, runIdentity, batch);
        status = withBatchCompleted(status, batchIndex, { checkpoint: checkpointForBatch(batch, page.nextCursor) });
        status = writeRunStatus(statusRoot, status);
      }
      batches.push(batch);
      cursor = batch.cursor;
    }
    if (batches.reduce((sum, batch) => sum + batch.scorecardRows.length, 0) !== count) {
      throw fail('ORCHESTRATOR_PARTIAL_REPOSITORY_RESULT', 'repository count changed during deterministic paging');
    }
  } catch (error) {
    const code = safeCode(error, 'ORCHESTRATOR_REPOSITORY_FAILED');
    status = persistFailure(statusRoot, status, code.includes('CHECKPOINT') ? 'BLOCKED' : 'FAILED', code);
    return { runStatus: status, published: false, error: { code, message: code } };
  }

  const rows = batches.flatMap(batch => batch.scorecardRows);
  let databaseAuditTrail;
  try {
    databaseAuditTrail = deriveFormalResearchAuditTrail({ context, rows, validationRunId, evaluationVersion });
  } catch (error) {
    const code = safeCode(error, 'ORCHESTRATOR_DATABASE_EVIDENCE_FAILED');
    status = persistFailure(statusRoot, status, 'BLOCKED', code);
    return { runStatus: status, published: false, error: { code, message: code } };
  }
  return runFormalResearchOrchestrator({
    ...options, artifactRoot: config.artifactRoot, validationRunId, evaluationVersion, artifactMode,
    lockTimeoutMs: config.lockTimeoutMs, staleLockRecovery: config.staleLockRecovery === 'ENABLED',
    thresholds: config.thresholds, batches, assembleD8Input: null, databaseAuditTrail,
    buildArtifactCore: args => ({ ...options.buildArtifactCore(args), gitObjectFormat: config.gitObjectFormat,
      sourceCommit: config.sourceCommit, researchFrom: config.researchFrom, researchTo: config.researchTo, fixedAsOf: config.fixedAsOf }),
    validationRunFinishedAt: context.validationRunFinishedAt,
    scorecardOptions: databaseScorecardOptions,
    manifestContentHash: context.manifestContentHash,
    [DATABASE_RUN_IDENTITY]: runIdentity
  });
}
