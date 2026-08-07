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
import { assembleD8InputFromResearchRows } from './d8-input-assembler.js';
import {
  loadFormalResearchContext, loadFormalResearchPage, countFormalResearchRows, deriveFormalResearchAuditTrail
} from './formal-research-data-repository.js';
import { assertGuardedResearchPgPool } from '../db/research-database-guard.js';
import {
  readRunStatus, writeRunStatus, initialRunStatus, withBatchPlan, withBatchCompleted, withBlocked, withCompleted, withFailed
} from './research-run-status.js';
import {
  ensureDirectorySafe, writeTempFileDurable, renameNoReplace, fsyncDirectory,
  readFileNoFollowSymlink, lstatIfExists, newLockId
} from './artifact-fs-primitives.js';

function fail(code, message = code) { return Object.assign(new Error(message), { code }); }
function safeCode(error, fallback) { return /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : fallback; }
function sha256(value) { return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }

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
  writeRunStatus(statusRoot, next);
  return next;
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

  let status = readRunStatus(statusRoot, artifactMode, validationRunId);
  if (status?.runState === 'COMPLETED') return { runStatus: status, published: true, resumed: true, skippedRecompute: true };
  if (!status) {
    status = initialRunStatus({ validationRunId, artifactMode, totalBatches: batches.length });
    writeRunStatus(statusRoot, status);
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
      writeRunStatus(statusRoot, status);
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
  } catch (error) {
    const code = safeCode(error, 'ORCHESTRATOR_EVALUATION_FAILED');
    status = persistFailure(statusRoot, status, 'BLOCKED', code);
    return { runStatus: status, published: false, error: { code, message: code } };
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
  status = withCompleted(status);
  writeRunStatus(statusRoot, status);
  return { runStatus: status, published: true, publishResult, decision, statistics, scorecardResult };
}

function checkpointDirectory(statusRoot, artifactMode, validationRunId) {
  return path.join(statusRoot, 'database-page-checkpoints', artifactMode === 'FORMAL' ? 'formal' : 'dry-run', validationRunId);
}

function checkpointPath(statusRoot, artifactMode, validationRunId, batchIndex) {
  return path.join(checkpointDirectory(statusRoot, artifactMode, validationRunId), `${batchIndex}.json`);
}

function readDatabasePageCheckpoint(statusRoot, artifactMode, validationRunId, checkpoint) {
  const target = checkpointPath(statusRoot, artifactMode, validationRunId, checkpoint.batchIndex);
  const stat = lstatIfExists(target);
  if (!stat || stat.isSymbolicLink()) throw fail('ORCHESTRATOR_CHECKPOINT_MISSING', 'database page checkpoint is missing');
  const { bytes } = readFileNoFollowSymlink(target, 50_000_000);
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw fail('ORCHESTRATOR_CHECKPOINT_CONFLICT', 'database page checkpoint is not valid JSON'); }
  const batch = { batchIndex: payload.batchIndex, governanceRows: payload.rows, scorecardRows: payload.rows, cursor: payload.nextCursor };
  if (checkpoint.sha256 !== sha256(batch) || checkpoint.rowCount !== payload.rows?.length) {
    throw fail('ORCHESTRATOR_CHECKPOINT_CONFLICT', 'database page checkpoint hash mismatch');
  }
  return batch;
}

function writeDatabasePageCheckpoint(statusRoot, artifactMode, validationRunId, batch) {
  const dir = checkpointDirectory(statusRoot, artifactMode, validationRunId);
  ensureDirectorySafe(dir, statusRoot);
  const target = checkpointPath(statusRoot, artifactMode, validationRunId, batch.batchIndex);
  const payload = { schemaVersion: 'v1.4d-formal-db-page-checkpoint/1', batchIndex: batch.batchIndex, rows: batch.scorecardRows, nextCursor: batch.cursor };
  const bytes = Buffer.from(canonicalJson(payload), 'utf8');
  if (lstatIfExists(target)) {
    const existing = readDatabasePageCheckpoint(statusRoot, artifactMode, validationRunId, checkpointForBatch(batch, batch.cursor));
    if (existing.batchIndex === batch.batchIndex) return;
  }
  const temp = path.join(dir, `.${batch.batchIndex}.tmp.${process.pid}.${newLockId()}`);
  writeTempFileDurable(temp, bytes);
  try { renameNoReplace(temp, target); } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best-effort orphan cleanup */ }
    if (!lstatIfExists(target)) throw error;
    readDatabasePageCheckpoint(statusRoot, artifactMode, validationRunId, checkpointForBatch(batch, batch.cursor));
  }
  fsyncDirectory(dir);
}

// The only production database entry point.  Its first durable action is a
// RUNNING status write; repository, mapping, artifact-core and publication
// failures therefore always leave an auditable terminal state.
export async function runFormalResearchFromDatabase(options) {
  const { pool, validationRunId, evaluationVersion, batchSize = 1000, artifactMode, statusRoot } = options;
  assertGuardedResearchPgPool(pool);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw fail('ORCHESTRATOR_INVALID_INPUT', 'batchSize must be 1..10000');

  let status = readRunStatus(statusRoot, artifactMode, validationRunId);
  if (status?.runState === 'COMPLETED') return { runStatus: status, published: true, resumed: true, skippedRecompute: true };
  if (!status) {
    status = initialRunStatus({ validationRunId, artifactMode, totalBatches: 1 });
    writeRunStatus(statusRoot, status);
  }

  let context, count;
  try {
    context = await loadFormalResearchContext(pool, { validationRunId });
    count = await countFormalResearchRows(pool, { validationRunId, evaluationVersion });
    if (count === 0) throw fail('ORCHESTRATOR_NO_RESEARCH_ROWS', 'no evaluated research rows found for validation run');
  } catch (error) {
    const code = safeCode(error, 'ORCHESTRATOR_REPOSITORY_FAILED');
    status = persistFailure(statusRoot, status, 'FAILED', code);
    return { runStatus: status, published: false, error: { code, message: code } };
  }
  const totalBatches = Math.ceil(count / batchSize);
  const databaseScorecardOptions = { ...options.scorecardOptions, trainEnd: context.trainEnd, validationEnd: context.validationEnd };
  if (status.completedBatchIndices.length === 0 && status.totalBatches !== totalBatches) {
    status = withBatchPlan(status, totalBatches);
    writeRunStatus(statusRoot, status);
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
        batch = readDatabasePageCheckpoint(statusRoot, artifactMode, validationRunId, status.batchCheckpoints[batchIndex]);
      } else {
        const page = await loadFormalResearchPage(pool, { validationRunId, evaluationVersion, context, limit: batchSize, cursor });
        if (!page.rows.length) throw fail('ORCHESTRATOR_PARTIAL_REPOSITORY_RESULT', 'repository ended before the declared count');
        batch = { batchIndex, governanceRows: page.rows, scorecardRows: page.rows, cursor: page.nextCursor };
        const prefixRows = [...batches.flatMap(value => value.scorecardRows), ...page.rows];
        computeMarketRegimeStatistics(prefixRows);
        buildDeterministicScorecard(prefixRows, databaseScorecardOptions, { validationRunFinishedAt: context.validationRunFinishedAt });
        writeDatabasePageCheckpoint(statusRoot, artifactMode, validationRunId, batch);
        status = withBatchCompleted(status, batchIndex, { checkpoint: checkpointForBatch(batch, page.nextCursor) });
        writeRunStatus(statusRoot, status);
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
    ...options, batches, assembleD8Input: null, databaseAuditTrail,
    validationRunFinishedAt: context.validationRunFinishedAt,
    scorecardOptions: databaseScorecardOptions,
    manifestContentHash: context.manifestContentHash
  });
}
