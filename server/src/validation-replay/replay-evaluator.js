// V1_4D_HISTORICAL_REPLAY_SPEC.md §2.5/§2.6/§4.7：历史ForecastOutcomeEvent回放评估。
// 镜像 server/src/outcome/evaluator-service.js `evaluatePending()` 的计算顺序与写入模式，
// 复用 outcome-engine.js computeForecastOutcome()（纯函数，不修改），只写
// historical_validation.replay_outcome_events/replay_evaluation_runs 两张表，schema-qualified，
// 不获取/续租/释放任何生产collector_leases。

import { randomUUID } from 'node:crypto';
import { locatePathForEvaluation } from '../forecast/bar-path-locator.js';
import { computeForecastOutcome } from '../outcome/outcome-engine.js';
import { canonicalJsonHash } from '../domain/hash.js';
import { createResearchAvailabilityQueryable, buildResearchDataVintage, RESEARCH_AVAILABILITY_RULE_VERSION } from './research-availability.js';

function rowToSnapshot(row) {
  return {
    predictionId: row.prediction_id, instrument: row.instrument, horizon: row.horizon,
    referencePrice: Number(row.reference_price), referenceBarRef: row.reference_bar_ref,
    expectedDirection: row.expected_direction, directionThreshold: Number(row.direction_threshold),
    expectedBarCount: row.expected_bar_count, expectedPriceZones: row.expected_price_zones
  };
}

// 找出targetEndTime（以历史模拟时钟衡量）已到达、且本evaluationVersion+research_availability_rule_version
// 组合尚未评估过的replay_snapshots——复合JOIN键镜像§2.3/§2.5冻结的复合唯一约束关系，不得只按prediction_id去重
// （否则researchAvailability规则版本升级后的重跑会被旧版本记录静默挡住）。
async function findPendingReplaySnapshots(pool, { evaluationVersion, historicalAsOfTime, limit }) {
  const result = await pool.query(
    `SELECT s.* FROM historical_validation.replay_snapshots s
     LEFT JOIN historical_validation.replay_outcome_events e
       ON e.prediction_id=s.prediction_id AND e.evaluation_version=$1 AND e.research_availability_rule_version=s.research_availability_rule_version
     WHERE s.target_end_time<=to_timestamp($2/1000.0) AND e.replay_outcome_event_id IS NULL
     ORDER BY s.target_end_time ASC LIMIT $3`,
    [evaluationVersion, historicalAsOfTime, limit]
  );
  return result.rows;
}

async function recordEvaluationRun(pool, { evaluationRunId, validationRunId, historicalAsOfTime, status, evaluatedCount = 0, dedupedCount = 0, blockedCount = 0, errorCode = null, startedAt, finishedAt }) {
  await pool.query(
    `INSERT INTO historical_validation.replay_evaluation_runs(
       evaluation_run_id,validation_run_id,historical_as_of_time,status,evaluated_count,deduped_count,blocked_count,error_code,started_at,finished_at
     ) VALUES($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,$8,to_timestamp($9/1000.0),$10)
     ON CONFLICT(evaluation_run_id) DO UPDATE SET status=EXCLUDED.status,evaluated_count=EXCLUDED.evaluated_count,
       deduped_count=EXCLUDED.deduped_count,blocked_count=EXCLUDED.blocked_count,error_code=EXCLUDED.error_code,finished_at=EXCLUDED.finished_at`,
    [evaluationRunId, validationRunId, historicalAsOfTime, status, evaluatedCount, dedupedCount, blockedCount, errorCode, startedAt, finishedAt == null ? null : new Date(finishedAt)]
  );
}

// 单次调用 = 一次"扫描当前historicalAsOfTime下全部到期待评估快照"的尝试，镜像生产evaluatePending()的批量模型；
// historicalAsOfTime的推进循环由调用方(cli-entry.js)负责。
// dryRun=true：§4.2冻结要求——完整执行读取+计算逻辑，但replay_outcome_events/replay_evaluation_runs
// 两张表零写入，返回值形状与正常路径一致（status均报告为'PLANNED'而非'INSERTED'/'DEDUPED'，供执行计划展示）。
export async function evaluateReplayOutcomes({ pool, validationRunId, evaluationVersion, historicalAsOfTime, replayNowMs, limit = 50, now = Date.now, dryRun = false }) {
  const evaluationRunId = randomUUID();
  const startedAt = now();
  if (!dryRun) await recordEvaluationRun(pool, { evaluationRunId, validationRunId, historicalAsOfTime, status: 'RUNNING', startedAt, finishedAt: null });

  const researchQueryable = createResearchAvailabilityQueryable(pool, { replayNowMs });
  const pending = await findPendingReplaySnapshots(pool, { evaluationVersion, historicalAsOfTime, limit });

  let evaluatedCount = 0, dedupedCount = 0;
  const results = [];
  for (const row of pending) {
    const snapshot = rowToSnapshot(row);
    const located = await locatePathForEvaluation(researchQueryable, {
      instrument: row.instrument === 'ETH' ? 'ETHUSDT' : row.instrument,
      referenceBarRef: snapshot.referenceBarRef, expectedBarCount: snapshot.expectedBarCount, asOfTime: historicalAsOfTime
    });
    const outcome = computeForecastOutcome({ snapshot, located });
    const contentHash = canonicalJsonHash({ predictionId: outcome.predictionId, evaluationVersion, actualReturn: outcome.actualReturn, actualDirection: outcome.actualDirection, mfe: outcome.mfe, mae: outcome.mae });

    const researchDataVintage = buildResearchDataVintage({
      barRefs: [outcome.referenceBarRef, outcome.targetBarRef, ...located.observedBars],
      backfillBatchIds: row.backfill_batch_id ? [row.backfill_batch_id] : [],
      asOfTime: historicalAsOfTime
    });

    if (dryRun) { results.push({ status: 'PLANNED', predictionId: outcome.predictionId }); continue; }

    const insertResult = await pool.query(
      `INSERT INTO historical_validation.replay_outcome_events(
         prediction_id,evaluation_version,evaluation_run_id,research_availability_rule_version,evaluated_at,
         historical_as_of_time,as_of_time,endpoint_data_complete,path_data_complete,direction_eligible_for_statistics,
         path_eligible_for_statistics,actual_return,actual_direction,direction_correct,actual_high,actual_low,mfe,mae,
         range_specific_metrics,invalidation_triggered,invalidation_reason,coverage_metrics,missing_bar_refs,
         research_data_vintage,source_origin,content_hash
       ) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0),to_timestamp($6/1000.0),to_timestamp($7/1000.0),$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
         $19::jsonb,$20,$21,$22::jsonb,$23::jsonb,$24::jsonb,'HISTORICAL_REPLAY',$25
       ) ON CONFLICT(prediction_id,evaluation_version,research_availability_rule_version) DO NOTHING RETURNING replay_outcome_event_id`,
      [
        outcome.predictionId, evaluationVersion, evaluationRunId, row.research_availability_rule_version, now(),
        historicalAsOfTime, historicalAsOfTime, outcome.endpointDataComplete, outcome.pathDataComplete,
        outcome.directionEligibleForStatistics, outcome.pathEligibleForStatistics, outcome.actualReturn, outcome.actualDirection,
        outcome.directionCorrect, outcome.actualHigh, outcome.actualLow, outcome.mfe, outcome.mae,
        outcome.pathEligibleForStatistics
          ? JSON.stringify({ upperExcursion: outcome.upperExcursion, lowerExcursion: outcome.lowerExcursion, maxAbsoluteExcursion: outcome.maxAbsoluteExcursion, rangeBreachExcursion: outcome.rangeBreachExcursion })
          : null,
        outcome.invalidationTriggered, null,
        outcome.directionEligibleForStatistics
          ? JSON.stringify({ endpointInBaselineZone: outcome.endpointInBaselineZone, endpointInAnyScenarioZone: outcome.endpointInAnyScenarioZone, realizedRangeInsideExpectedEnvelope: outcome.realizedRangeInsideExpectedEnvelope, expectedEnvelopeTouched: outcome.expectedEnvelopeTouched })
          : null,
        JSON.stringify(outcome.missingBarRefs), JSON.stringify(researchDataVintage), contentHash
      ]
    );

    if (insertResult.rowCount) { evaluatedCount += 1; results.push({ status: 'INSERTED', predictionId: outcome.predictionId }); }
    else { dedupedCount += 1; results.push({ status: 'DEDUPED', predictionId: outcome.predictionId }); }
  }

  if (!dryRun) await recordEvaluationRun(pool, { evaluationRunId, validationRunId, historicalAsOfTime, status: 'SUCCEEDED', evaluatedCount, dedupedCount, startedAt, finishedAt: now() });
  return { status: 'SUCCEEDED', evaluated: evaluatedCount, deduped: dedupedCount, results, evaluationRunId };
}
