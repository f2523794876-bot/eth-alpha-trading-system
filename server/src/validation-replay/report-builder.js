// V1_4D_HISTORICAL_REPLAY_SPEC.md §五/§2.7/§六：Walk-forward统计与报告，唯一写入 historical_validation.validation_reports
// （分类C，唯一允许覆盖写）的模块。复用 server/src/validation/walk-forward.js（computeEffectiveSampleCount/
// checkSampleSufficiency）与本schema内的 purge.js/po-diagnostic.js，不重新实现任何统计公式。
// 不计算 ActionPermission（结构性排除，见§2.3行内说明与R20.2静态扫描红线）。

import { checkSampleSufficiency } from '../validation/walk-forward.js';
import { computeSplitEffectiveSamples } from './purge.js';
import { buildPoDiagnosticReport } from './po-diagnostic.js';
import { canonicalJsonHash } from '../domain/hash.js';

// V1_4_HISTORICAL_VALIDATION_SPEC.md §5.1：4个"可评估/部分可评估"primaryCause取值 + 5个NOT_EVALUABLE项
// （V1.4D范围内这5项对应的模块从未真实运行，是结构性无法评估，不是"排除了它们"）。
const NOT_EVALUABLE_CAUSES = Object.freeze([
  'environment_misread', 'formal_transition_misread', 'fusion_weight_error', 'action_permission_error', 'exogenous_shock'
]);

// §5.1归因规则（仅在directionCorrect===false即预测确实出错时才归因；否则primaryCause恒为null）：
// 1. 数据缺失优先（data_missing_or_delayed）——因为若数据本就不全，其余归因都建立在不完整信息上，不应假装能判断更细的原因；
// 2. 代理状态与实际路径方向相反（target_state_misread，"部分可评估"，confidence必须<=50，见migration CHECK红线）；
// 3. 预测区间系统性偏离实际路径（price_zone_error）；
// 4. 以上都不成立：不勉强归因，标记requiresHumanReview=true，primaryCause留null。
// proxy_transition_misread未实现：该归因需要ProxyTransitionRecord（迁移候选权重记录），V1.4D范围未产出此结构，
// 强行用candidateTrajectories.stateEvidence/opposingEvidence冒充会引入未经验证的归因逻辑，本轮不实现，如实留空。
function attributeError({ snapshot, outcome }) {
  if (outcome.directionCorrect !== false) return { primaryCause: null, attributionConfidence: null, requiresHumanReview: false };
  if (!outcome.endpointDataComplete || !outcome.pathDataComplete) {
    return { primaryCause: 'data_missing_or_delayed', attributionConfidence: 70, requiresHumanReview: false };
  }
  if (outcome.pathEligibleForStatistics && outcome.actualDirection && outcome.actualDirection !== snapshot.expectedDirection) {
    return { primaryCause: 'target_state_misread', attributionConfidence: 50, requiresHumanReview: true };
  }
  if (outcome.pathEligibleForStatistics && (outcome.realizedRangeInsideExpectedEnvelope === false || outcome.expectedEnvelopeTouched === false)) {
    return { primaryCause: 'price_zone_error', attributionConfidence: 60, requiresHumanReview: false };
  }
  return { primaryCause: null, attributionConfidence: null, requiresHumanReview: true };
}

export function buildErrorAttributionSummary(pairs) {
  const counts = {};
  let requiresHumanReviewCount = 0;
  for (const { snapshot, outcome } of pairs) {
    const attribution = attributeError({ snapshot, outcome });
    const key = attribution.primaryCause ?? 'UNDETERMINED';
    counts[key] = (counts[key] || 0) + 1;
    if (attribution.requiresHumanReview) requiresHumanReviewCount += 1;
  }
  return {
    primaryCauseCounts: counts,
    requiresHumanReviewCount,
    notEvaluableCauses: NOT_EVALUABLE_CAUSES,
    disclosure: 'V1.4D范围内以下类别为NOT_EVALUABLE（对应模块从未真实运行，是结构性无法评估，不是排除了它们）：' + NOT_EVALUABLE_CAUSES.join(', ')
  };
}

async function loadSamplesForHorizon(pool, { validationRunId, horizon, evaluationVersion }) {
  const result = await pool.query(
    `SELECT s.prediction_id AS "predictionId", s.horizon, s.target_start_time AS "targetStartTimeRaw",
            s.target_end_time AS "targetEndTimeRaw", s.proxy_state_at_generation AS "proxyStateAtGeneration",
            s.expected_direction AS "expectedDirection", s.feature_values_used AS "featureValuesUsed",
            e.direction_eligible_for_statistics AS "directionEligibleForStatistics",
            e.path_eligible_for_statistics AS "pathEligibleForStatistics",
            e.direction_correct AS "directionCorrect", e.actual_direction AS "actualDirection",
            e.endpoint_data_complete AS "endpointDataComplete", e.path_data_complete AS "pathDataComplete",
            e.mfe, e.mae,
            (e.range_specific_metrics->>'realizedRangeInsideExpectedEnvelope')::boolean AS "realizedRangeInsideExpectedEnvelope",
            (e.range_specific_metrics->>'expectedEnvelopeTouched')::boolean AS "expectedEnvelopeTouched"
     FROM historical_validation.replay_snapshots s
     JOIN historical_validation.replay_generation_runs g ON g.generation_run_id = s.generation_run_id
     LEFT JOIN historical_validation.replay_outcome_events e
       ON e.prediction_id = s.prediction_id AND e.research_availability_rule_version = s.research_availability_rule_version
          AND e.evaluation_version = $3
     WHERE g.validation_run_id = $1 AND s.horizon = $2`,
    [validationRunId, horizon, evaluationVersion]
  );
  return result.rows.map(row => ({
    predictionId: row.predictionId, horizon: row.horizon,
    targetStartTime: row.targetStartTimeRaw instanceof Date ? row.targetStartTimeRaw.getTime() : new Date(row.targetStartTimeRaw).getTime(),
    targetEndTime: row.targetEndTimeRaw instanceof Date ? row.targetEndTimeRaw.getTime() : new Date(row.targetEndTimeRaw).getTime(),
    proxyStateAtGeneration: row.proxyStateAtGeneration, expectedDirection: row.expectedDirection, featureValuesUsed: row.featureValuesUsed,
    directionEligibleForStatistics: row.directionEligibleForStatistics === true,
    pathEligibleForStatistics: row.pathEligibleForStatistics === true,
    directionCorrect: row.directionCorrect, actualDirection: row.actualDirection,
    endpointDataComplete: row.endpointDataComplete, pathDataComplete: row.pathDataComplete,
    mfe: row.mfe == null ? null : Number(row.mfe), mae: row.mae == null ? null : Number(row.mae),
    realizedRangeInsideExpectedEnvelope: row.realizedRangeInsideExpectedEnvelope,
    expectedEnvelopeTouched: row.expectedEnvelopeTouched
  }));
}

function buildUpDownRangeBreakdown(samples) {
  const groups = { UP: [], DOWN: [], RANGE: [] };
  for (const s of samples) {
    if (s.directionEligibleForStatistics && groups[s.expectedDirection]) groups[s.expectedDirection].push(s);
  }
  const breakdown = {};
  for (const key of ['UP', 'DOWN', 'RANGE']) {
    const group = groups[key];
    const correct = group.filter(s => s.directionCorrect === true).length;
    breakdown[key] = { effectiveCount: group.length, directionCorrectCount: correct, directionAccuracy: group.length > 0 ? correct / group.length : null };
  }
  return breakdown;
}

function buildFormalProxyDisclosure() {
  return {
    pathDataSource: 'market_bars:formal:spot',
    disclosure: 'path evaluation 100% 来自 formal（public.market_bars），回放从不读取 provisional_market_bars（V1_4D_DATA_BACKFILL_SPEC.md §2.13）'
  };
}

function buildPoStateBreakdownWithDisclosure(poStateDistribution) {
  const withDisclosure = {};
  for (const [state, stats] of Object.entries(poStateDistribution)) {
    withDisclosure[state] = { ...stats, disclosure: 'MIN_SAMPLE_THRESHOLD_NOT_FROZEN（仅horizon级别30/10已冻结，按PO_状态细分的最低门槛本规范未定义，不得凭空推断充分性）' };
  }
  return withDisclosure;
}

// report_scope: 'ALL' | 'TRAIN' | 'VALIDATION' | 'TEST'。trainEnd/validationEnd为undefined时只产出'ALL'一份报告。
export async function buildValidationReports({ pool, validationRunId, datasetVersion, algorithmVersion, ruleVersion, researchAvailabilityRuleVersion, evaluationVersion, trainEnd, validationEnd }) {
  const reports = [];
  for (const horizon of ['24h', '72h']) {
    const samples = await loadSamplesForHorizon(pool, { validationRunId, horizon, evaluationVersion });

    const direction = computeSplitEffectiveSamples(samples, { eligibilityField: 'directionEligibleForStatistics', trainEnd, validationEnd });
    const path = computeSplitEffectiveSamples(samples, { eligibilityField: 'pathEligibleForStatistics', trainEnd, validationEnd });

    const scopes = trainEnd != null && validationEnd != null
      ? [['ALL', direction.all, path.all, 0], ['TRAIN', direction.training, path.training, direction.purgedStraddlingCount], ['VALIDATION', direction.validation, path.validation, direction.purgedStraddlingCount], ['TEST', direction.test, path.test, direction.purgedStraddlingCount]]
      : [['ALL', direction.all, path.all, 0]];

    // 按report_scope各自统计rawSampleCount——与splitTimeOrdered同一套targetEndTime边界判据(§2)，
    // 但不做区间调度去重叠(那是effectiveSampleCount的职责)：rawSampleCount反映"落在该分段边界内的
    // 全部eligible样本"，effectiveSampleCount反映"去重叠+purge后的样本"，二者对比才有意义(§五)。
    const scopeMatchesBoundary = (targetEndTime, scope) => {
      if (scope === 'ALL') return true;
      if (trainEnd == null || validationEnd == null) return false;
      if (scope === 'TRAIN') return targetEndTime < trainEnd;
      if (scope === 'VALIDATION') return targetEndTime >= trainEnd && targetEndTime < validationEnd;
      return targetEndTime >= validationEnd;
    };

    for (const [reportScope, directionSamples, pathSamples, purgedStraddlingCount] of scopes) {
      const directionRawCount = samples.filter(s => s.directionEligibleForStatistics && scopeMatchesBoundary(s.targetEndTime, reportScope)).length;
      const pathRawCount = samples.filter(s => s.pathEligibleForStatistics && scopeMatchesBoundary(s.targetEndTime, reportScope)).length;
      const sufficiency = checkSampleSufficiency(directionSamples.length, horizon);
      const poDiagnostic = buildPoDiagnosticReport({
        samples: directionSamples,
        featureValuesList: directionSamples.map(s => s.featureValuesUsed).filter(Boolean)
      });
      const pairsForAttribution = directionSamples
        .filter(s => s.directionCorrect != null)
        .map(s => ({ snapshot: { expectedDirection: s.expectedDirection }, outcome: s }));

      const content = {
        validationRunId, horizon, reportScope,
        directionRawSampleCount: directionRawCount,
        directionEffectiveSampleCount: directionSamples.length,
        pathRawSampleCount: pathRawCount,
        pathEffectiveSampleCount: pathSamples.length,
        sampleSufficient: sufficiency.sufficient,
        purgedStraddlingCount,
        poStateBreakdown: buildPoStateBreakdownWithDisclosure(poDiagnostic.poStateDistribution),
        upDownRangeBreakdown: buildUpDownRangeBreakdown(directionSamples),
        formalProxyDisclosure: buildFormalProxyDisclosure(),
        calibratedProbabilitiesStatus: 'null (V1.4D not eligible)',
        errorAttributionSummary: buildErrorAttributionSummary(pairsForAttribution),
        algorithmVersion, ruleVersion, researchAvailabilityRuleVersion
      };
      const contentHash = canonicalJsonHash(content);

      await pool.query(
        `INSERT INTO historical_validation.validation_reports(
           report_id, validation_run_id, dataset_version, horizon, report_scope,
           direction_raw_sample_count, direction_effective_sample_count, path_raw_sample_count, path_effective_sample_count,
           sample_sufficient, purged_straddling_count, po_state_breakdown, up_down_range_breakdown, formal_proxy_disclosure,
           calibrated_probabilities_status, brier_score_component, error_attribution_summary,
           algorithm_version, rule_version, research_availability_rule_version, content_hash, updated_at
         ) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,null,$15::jsonb,$16,$17,$18,$19,now())
         ON CONFLICT(validation_run_id, horizon, report_scope) DO UPDATE SET
           direction_raw_sample_count=EXCLUDED.direction_raw_sample_count,
           direction_effective_sample_count=EXCLUDED.direction_effective_sample_count,
           path_raw_sample_count=EXCLUDED.path_raw_sample_count,
           path_effective_sample_count=EXCLUDED.path_effective_sample_count,
           sample_sufficient=EXCLUDED.sample_sufficient,
           purged_straddling_count=EXCLUDED.purged_straddling_count,
           po_state_breakdown=EXCLUDED.po_state_breakdown,
           up_down_range_breakdown=EXCLUDED.up_down_range_breakdown,
           formal_proxy_disclosure=EXCLUDED.formal_proxy_disclosure,
           error_attribution_summary=EXCLUDED.error_attribution_summary,
           content_hash=EXCLUDED.content_hash,
           updated_at=now()`,
        [
          validationRunId, datasetVersion, horizon, reportScope,
          directionRawCount, directionSamples.length, pathRawCount, pathSamples.length,
          sufficiency.sufficient, purgedStraddlingCount,
          JSON.stringify(content.poStateBreakdown), JSON.stringify(content.upDownRangeBreakdown), JSON.stringify(content.formalProxyDisclosure),
          content.calibratedProbabilitiesStatus, JSON.stringify(content.errorAttributionSummary),
          algorithmVersion, ruleVersion, researchAvailabilityRuleVersion, contentHash
        ]
      );
      reports.push({ horizon, reportScope, ...content });
    }
  }
  return reports;
}
