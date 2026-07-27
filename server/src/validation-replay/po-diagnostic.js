// V1_4D_HISTORICAL_REPLAY_SPEC.md §六：PO_UNKNOWN专项诊断——仅设计诊断结构，不修改po-state-engine.js任何阈值/判定条件（红线1）。
// 本模块是纯统计/描述性输出，不产出"建议调整为XX阈值"的具体数值建议（红线3），供report-builder.js落库
// validation_reports.po_state_breakdown 或独立po_diagnostic_summary子结构。

import { PO_STATES } from '../forecast/po-state-engine.js';

// samples: 来自replay_snapshots的{proxyStateAtGeneration, targetStartTime, directionEligibleForStatistics}集合（单一horizon）。
export function computePoStateDistribution(samples) {
  const rawCounts = Object.fromEntries(PO_STATES.map(s => [s, 0]));
  const effectiveCounts = Object.fromEntries(PO_STATES.map(s => [s, 0]));
  let effectiveTotal = 0;
  for (const sample of samples) {
    const state = sample.proxyStateAtGeneration;
    if (state && Object.hasOwn(rawCounts, state)) rawCounts[state] += 1;
    if (sample.directionEligibleForStatistics && state && Object.hasOwn(effectiveCounts, state)) {
      effectiveCounts[state] += 1;
      effectiveTotal += 1;
    }
  }
  const poStateDistribution = {};
  for (const state of PO_STATES) {
    poStateDistribution[state] = {
      rawCount: rawCounts[state],
      effectiveCount: effectiveCounts[state],
      shareOfTotal: effectiveTotal > 0 ? effectiveCounts[state] / effectiveTotal : 0
    };
  }
  const poUnknownShare = effectiveTotal > 0 ? effectiveCounts.PO_UNKNOWN / effectiveTotal : 0;
  return { poStateDistribution, poUnknownShare, effectiveTotal };
}

// §6.1：相邻回放样本（按targetStartTime排序）之间proxyState的转移计数。
export function computeStateTransitionMatrix(samples) {
  const sorted = [...samples].sort((a, b) => a.targetStartTime - b.targetStartTime);
  const matrix = {};
  for (let i = 1; i < sorted.length; i += 1) {
    const from = sorted[i - 1].proxyStateAtGeneration;
    const to = sorted[i].proxyStateAtGeneration;
    if (!from || !to) continue;
    matrix[from] = matrix[from] || {};
    matrix[from][to] = (matrix[from][to] || 0) + 1;
  }
  return matrix;
}

// §6.1：evaluatePoState()各判定分支关键输入字段的命中率，纯统计，不涉及修改判定逻辑；
// 具体字段清单对照po-state-engine.js当前分支条件枚举（本实现覆盖主要分支输入，非详尽穷举）。
export function computeInputConditionHitRates(featureValuesList) {
  const total = featureValuesList.length;
  if (total === 0) return {};
  const share = predicate => featureValuesList.filter(predicate).length / total;
  return {
    trend4hUp: share(fv => fv.trend4h === 'up'),
    trend4hDown: share(fv => fv.trend4h === 'down'),
    trend4hFlat: share(fv => fv.trend4h === 'flat'),
    breakoutStateUp: share(fv => fv.breakoutState === 'BREAKOUT_UP'),
    breakoutStateDown: share(fv => fv.breakoutState === 'BREAKOUT_DOWN'),
    falseBreakoutVetoed: share(fv => fv.falseBreakoutRisk != null && fv.falseBreakoutRisk !== 'NONE'),
    swingHighOrLowMissing: share(fv => fv.swingHigh == null || fv.swingLow == null)
  };
}

// §6.1/§6.2红线2/3：只收集四类候选原因各自的证据，不预设结论、不给数值建议——分析者结合
// inputConditionHitRates/stateTransitionMatrix人工研判，本函数只做证据的机械汇总。
export function buildPersistentUnknownDiagnosis({ missingFeatureShare = 0 } = {}) {
  return {
    marketTrulyStructureless: { evidence: [] },
    thresholdTooStrict: { evidence: [] },
    inputFieldsLongTermMissing: {
      evidence: missingFeatureShare > 0 ? [`degraded/missing feature share among evaluated samples: ${missingFeatureShare}`] : []
    },
    stateEngineImplementationError: { evidence: [] }
  };
}

export function buildPoDiagnosticReport({ samples, featureValuesList = [], missingFeatureShare = 0 }) {
  const { poStateDistribution, poUnknownShare } = computePoStateDistribution(samples);
  return {
    poStateDistribution,
    poUnknownShare,
    inputConditionHitRates: computeInputConditionHitRates(featureValuesList),
    stateTransitionMatrix: computeStateTransitionMatrix(samples),
    persistentUnknownDiagnosis: buildPersistentUnknownDiagnosis({ missingFeatureShare })
  };
}
