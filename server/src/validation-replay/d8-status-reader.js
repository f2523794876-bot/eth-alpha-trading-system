// D8已发布结果的受控只读读取层——供API使用（V1_4D contract §4/§5之外的增补设计，见最终报告
// "冻结契约之外的增补点"）。
//
// 红线（本文件必须始终满足，任何修改都不得违反）：
//   1. 不直接查询/暴露业务原始评估记录数据表——本文件只读取D7已发布的两个最终文件
//      （main+sidecar），复用artifact-reader.js的§4.8读取协议，不自行解析、不绕过Schema/hash验证。
//   2. 不调用D8求值函数本身——D8决策只能来自T18已发布产物里已经算好的core.decision，本文件
//      不重新评估、不重新计算、不触发任何新的研究/D8/D7/交易动作。
//   3. 只读——本文件不包含任何写入路径。
//   4. 只投影白名单字段——见下方PROJECTED字段清单；不返回绝对路径、不返回featureValues/
//      candidateTrajectories等内部字段、不返回validationRunFinishedAt之外的任何文件系统细节。
import { findLatestFormalArtifactDir } from './d8-artifact-discovery.js';
import { readArtifactPair } from './artifact-reader.js';
import { findMostRecentRejectedResearchAttempt, findMostRecentRunStatus } from './research-run-status.js';

const DISPLAY_ONLY_DISCLOSURE =
  'DISPLAY_ONLY：本字段/本次读取结果仅用于只读展示，不是、也不影响任何交易执行许可判断；' +
  '交易执行许可与行情方向预测是两套独立机制（不能入场 ≠ 没有方向预测；交易许可 ≠ 行情方向预测）。';

function projectHorizon(horizonResult) {
  if (!horizonResult) return null;
  return {
    status: horizonResult.status,
    primaryReasonCode: horizonResult.primaryReasonCode,
    reasonCodes: horizonResult.reasonCodes,
    effectiveTest: horizonResult.effectiveTest,
    directionalCoverage: horizonResult.directionalCoverage,
    marketRegimeCoverage: horizonResult.marketRegimeCoverage,
    preCostLift: horizonResult.preCostLift,
    postCostLift: horizonResult.postCostLift,
    wilson95: horizonResult.wilson95 ? {
      lower: horizonResult.wilson95.lower, upper: horizonResult.wilson95.upper,
      successes: horizonResult.wilson95.successes, trials: horizonResult.wilson95.trials,
      confidenceLevel: horizonResult.wilson95.confidenceLevel
    } : null
  };
}

// 只从ACCEPTED的D7 artifact投影这个白名单——绝不透传artifact.core的其余字段（尤其不透传
// 任何路径、任何未列出的内部字段）。
function projectAcceptedResult(artifact, runStatus) {
  const decision = artifact.core.decision;
  return {
    state: decision.overall.status, // GO | CONDITIONAL_GO | NO_GO | DATA_GATE_FAILED | BASELINE_NOT_EVALUABLE
    runId: decision.validationRunId,
    algorithmVersion: decision.evaluationVersion,
    datasetVersion: artifact.core.auditTrail?.datasetVersion ?? null,
    generatedAt: decision.evaluatedAt,
    publishedAt: artifact.deterministicProvenance.validationRunFinishedAt,
    overall: { primaryReasonCode: decision.overall.primaryReasonCode, reasonCodes: decision.overall.reasonCodes },
    horizonResults: { '24h': projectHorizon(decision.horizonResults['24h']), '72h': projectHorizon(decision.horizonResults['72h']) },
    progress: runStatus ? { currentBatch: runStatus.completedBatchIndices.length, totalBatches: runStatus.totalBatches } : null,
    actionPermission: 'DISPLAY_ONLY',
    disclosure: DISPLAY_ONLY_DISCLOSURE
  };
}

// 顶层入口：给定D7 artifact root与run-status root，返回API可以直接JSON序列化的白名单投影。
// status: 'NOT_RUN' | 'RUNNING' | 'BLOCKED' | 'GO' | 'CONDITIONAL_GO' | 'NO_GO' | 'DATA_GATE_FAILED' |
//         'BASELINE_NOT_EVALUABLE' | 'FAILED'
export function readD8DisplayStatus({ artifactRoot, statusRoot }) {
  // run-status的发现独立于"是否已经有已发布artifact"——第一次运行、尚未产出任何已发布结果时
  // 也必须能被观察到RUNNING，不能依赖"先有已发布artifact才能定位validationRunId"这个错误假设。
  let runStatus = null, rejectedAttempt = null;
  try {
    runStatus = findMostRecentRunStatus(statusRoot, 'FORMAL');
    rejectedAttempt = findMostRecentRejectedResearchAttempt(statusRoot);
  }
  catch (error) {
    const code = error?.code === 'RUN_STATUS_CORRUPT_CANDIDATE' ? error.code : 'RUN_STATUS_READ_FAILED';
    return {
      state: 'FAILED', message: '正式研究状态记录损坏或无法安全读取，拒绝降级为未运行。',
      readerReasonCode: code, actionPermission: 'DISPLAY_ONLY', disclosure: DISPLAY_ONLY_DISCLOSURE
    };
  }

  if (rejectedAttempt && (!runStatus || rejectedAttempt.createdAt > runStatus.updatedAt)) {
    return {
      state: 'FAILED', message: '正式研究尝试在完整运行身份形成前被拒绝，未执行数据库查询。',
      readerReasonCode: rejectedAttempt.reasonCode,
      actionPermission: 'DISPLAY_ONLY', disclosure: DISPLAY_ONLY_DISCLOSURE
    };
  }

  if (runStatus && runStatus.runState === 'RUNNING') {
    return {
      state: 'RUNNING', message: '正式研究运行中，暂无最终GO/NO-GO结论。',
      progress: { currentBatch: runStatus.completedBatchIndices.length, totalBatches: runStatus.totalBatches },
      actionPermission: 'DISPLAY_ONLY', disclosure: DISPLAY_ONLY_DISCLOSURE
    };
  }
  if (runStatus && runStatus.runState === 'BLOCKED') {
    return {
      state: 'BLOCKED', message: '正式研究被阻塞，暂无最终GO/NO-GO结论。',
      blockedReasonCode: runStatus.blockedReasonCode,
      progress: { currentBatch: runStatus.completedBatchIndices.length, totalBatches: runStatus.totalBatches },
      actionPermission: 'DISPLAY_ONLY', disclosure: DISPLAY_ONLY_DISCLOSURE
    };
  }
  if (runStatus && runStatus.runState === 'FAILED') {
    return {
      state: 'FAILED', message: '正式研究编排过程失败，暂无可信的GO/NO-GO结论。',
      readerReasonCode: runStatus.blockedReasonCode,
      actionPermission: 'DISPLAY_ONLY', disclosure: DISPLAY_ONLY_DISCLOSURE
    };
  }

  const dir = findLatestFormalArtifactDir(artifactRoot);
  if (!dir) {
    return { state: 'NOT_RUN', message: '暂无正式研究结果', actionPermission: 'DISPLAY_ONLY', disclosure: DISPLAY_ONLY_DISCLOSURE };
  }

  const result = readArtifactPair(dir);
  if (result.readerStatus !== 'ACCEPTED') {
    return {
      state: 'FAILED', message: '已发布结果读取失败（Schema/hash/路径校验未通过），拒绝展示任何可能被污染的数据。',
      readerReasonCode: result.readerReasonCode, actionPermission: 'DISPLAY_ONLY', disclosure: DISPLAY_ONLY_DISCLOSURE
    };
  }
  return projectAcceptedResult(result.artifact, runStatus);
}
