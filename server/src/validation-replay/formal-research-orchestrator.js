// T19编排（正式研究单次提交的内部安全分批/checkpoint/resume/幂等/失败恢复/可审计运行状态）
// ——把T13(governance-statistics)、T14(deterministic-scorecard)、T16(evaluateGoNoGo，既有)、
// T17(governance-authorization)、T18(artifact-publisher)串成一条管线（V8_FINAL_R3.md §5）。
//
// 明确披露的范围边界（完整版见本轮最终报告"已完成 vs 有意推迟"）：本编排器真实调用上述五个
// 模块——它们各自都有独立单测覆盖，产出是真实计算结果，不是占位符。但从"原始逐行评估数据"
// 组装出D8完整输入所需的sampleAccounting/rangeAttribution/baselineAvailabilityInput/
// preCostLift/postCostLift这一层业务聚合与基线参照选择逻辑，是独立的、统计正确性高度敏感的
// 新工作，本轮未实现——不允许在正式180天研究启动前把这类判断仓促补上而未经独立复审。因此本
// 编排器把"给定累积统计结果，组装出完整合法D8输入"这一步设计为调用方注入的`assembleD8Input`
// 钩子，而不是自己臆造；真实生产接入前必须先补齐并独立测试这一层。
//
// 安全边界（本文件不做，也不能被误用为做）：不包含任何HTTP路由或CLI默认入口——没有任何"前端/
// API/临时请求"可以触达这个函数；唯一的调用方式是调用方显式import并传入artifactMode。是否
// 允许FORMAL执行完全由调用方决定，本文件本身不提供、不暴露任何触发正式研究的默认通路。
import { computeMarketRegimeStatistics } from './governance-statistics.js';
import { buildDeterministicScorecard } from './deterministic-scorecard.js';
import { evaluateGoNoGo } from '../formal-research/go-no-go-evaluator.js';
import { resolveGovernanceAuthorizationRef } from './governance-authorization.js';
import { publishArtifact } from './artifact-publisher.js';
import { assembleD8InputFromResearchRows } from './d8-input-assembler.js';
import { loadFormalResearchRows } from './formal-research-data-repository.js';
import {
  readRunStatus, writeRunStatus, initialRunStatus, withBatchCompleted, withBlocked, withCompleted, withFailed
} from './research-run-status.js';

function fail(code, message) {
  return Object.assign(new Error(message || code), { code });
}

// batches: [{ batchIndex: 0-based连续整数, governanceRows: T13行, scorecardRows: T14行 }]
// 调用方已经从各自数据源按180天窗口内部安全分批取好的数据（真实DB读取属于调用方职责，
// 见文件头范围边界）。同一validationRunId重复调用：COMPLETED直接短路，不重算不重发布；
// 中途中断后重新调用（携带完整batches数组，checkpoint决定从哪继续）安全resume。
export function runFormalResearchOrchestrator(options) {
  const {
    statusRoot, artifactRoot, validationRunId, evaluationVersion, artifactMode,
    batches, scorecardOptions, validationRunFinishedAt,
    assembleD8Input = null, buildArtifactCore,
    trainEnd, validationEnd, thresholds, auditTrail,
    governanceRecord = null, expectedThresholdsSha256 = null,
    manifestContentHash, lockTimeoutMs
  } = options;

  if (!Array.isArray(batches) || batches.length === 0) throw fail('ORCHESTRATOR_INVALID_INPUT', 'batches must be a non-empty array');
  if (artifactMode !== 'FORMAL' && artifactMode !== 'DRY_RUN') throw fail('ORCHESTRATOR_INVALID_INPUT', 'artifactMode must be FORMAL or DRY_RUN');
  if (assembleD8Input !== null && typeof assembleD8Input !== 'function') throw fail('ORCHESTRATOR_INVALID_INPUT', 'assembleD8Input must be a function');
  if (typeof buildArtifactCore !== 'function') {
    throw fail('ORCHESTRATOR_INVALID_INPUT', 'buildArtifactCore hook is required');
  }

  let status = readRunStatus(statusRoot, artifactMode, validationRunId);
  if (status && status.runState === 'COMPLETED') {
    return { runStatus: status, published: true, resumed: true, skippedRecompute: true };
  }
  if (!status) {
    status = initialRunStatus({ validationRunId, artifactMode, totalBatches: batches.length });
    writeRunStatus(statusRoot, status);
  } else if (status.totalBatches !== batches.length) {
    throw fail('ORCHESTRATOR_BATCH_PLAN_MISMATCH', 'resumed run batch plan does not match totalBatches recorded in run-status');
  }

  const accumulatedGovernanceRows = [];
  const accumulatedScorecardRows = [];
  for (const batch of batches) {
    accumulatedGovernanceRows.push(...batch.governanceRows);
    accumulatedScorecardRows.push(...batch.scorecardRows);
    if (status.completedBatchIndices.includes(batch.batchIndex)) continue; // 已checkpoint：数据重新纳入累积，但不重复计入进度
    status = withBatchCompleted(status, batch.batchIndex);
    writeRunStatus(statusRoot, status); // 逐批落盘checkpoint：中断后可从这里resume
  }

  let statistics, scorecardResult, d8Input, decision, governanceRef, core, publishResult;
  try {
    statistics = computeMarketRegimeStatistics(accumulatedGovernanceRows);
    scorecardResult = buildDeterministicScorecard(accumulatedScorecardRows, scorecardOptions, { validationRunFinishedAt });
    d8Input = assembleD8Input
      ? assembleD8Input({ statistics, scorecardResult, validationRunId, evaluationVersion, validationRunFinishedAt })
      : assembleD8InputFromResearchRows({
          rows: accumulatedScorecardRows, scorecardResult, validationRunId, evaluationVersion,
          evaluatedAt: validationRunFinishedAt, trainEnd, validationEnd, thresholds, auditTrail
        });
    decision = evaluateGoNoGo(d8Input);
    governanceRef = resolveGovernanceAuthorizationRef({
      artifactMode, record: governanceRecord,
      expectedValidationRunId: validationRunId, expectedThresholdsSha256
    });
  } catch (error) {
    status = withBlocked(status, error.code || 'ORCHESTRATOR_EVALUATION_FAILED');
    writeRunStatus(statusRoot, status);
    return { runStatus: status, published: false, error: { code: error.code || 'ORCHESTRATOR_EVALUATION_FAILED', message: error.message } };
  }

  core = buildArtifactCore({ decision, governanceRef, statistics, scorecardResult, validationRunId, evaluationVersion, d8Input });

  try {
    publishResult = publishArtifact({
      root: artifactRoot, artifactMode, validationRunId, evaluationVersion, core,
      manifestContentHash, validationRunFinishedAt, lockTimeoutMs
    });
  } catch (error) {
    status = withFailed(status, error.code || 'ORCHESTRATOR_PUBLISH_THREW');
    writeRunStatus(statusRoot, status);
    throw error;
  }

  if (publishResult.operationStatus === 'FAILED') {
    status = withBlocked(status, publishResult.reasonCode);
    writeRunStatus(statusRoot, status);
    return { runStatus: status, published: false, publishResult };
  }

  status = withCompleted(status);
  writeRunStatus(statusRoot, status);
  return { runStatus: status, published: true, publishResult, decision, statistics, scorecardResult };
}

// Production wiring for T13/T19.  The caller still supplies all governance,
// thresholds and publishing identity inputs; this function only replaces the
// former external DB/read/assembly hooks with the reviewed repository path.
export async function runFormalResearchFromDatabase(options) {
  const { pool, validationRunId, evaluationVersion, batchSize = 1000 } = options;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw fail('ORCHESTRATOR_INVALID_INPUT', 'batchSize must be a positive integer');
  const rows = await loadFormalResearchRows(pool, { validationRunId, evaluationVersion });
  if (!rows.length) throw fail('ORCHESTRATOR_NO_RESEARCH_ROWS', 'no evaluated research rows found for validation run');
  const batches = [];
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const slice = rows.slice(offset, offset + batchSize);
    batches.push({ batchIndex: batches.length, governanceRows: slice, scorecardRows: slice });
  }
  return runFormalResearchOrchestrator({ ...options, batches, assembleD8Input: null });
}
