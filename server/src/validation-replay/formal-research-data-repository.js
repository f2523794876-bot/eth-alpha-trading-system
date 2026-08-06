// T13 data boundary: load only rows belonging to one validation run and one
// evaluation version.  The 4H regime is read from feature_values_used, which
// was frozen at generation time; it is never reconstructed at outcome time.
export async function loadFormalResearchRows(pool, { validationRunId, evaluationVersion }) {
  if (!pool?.query) throw Object.assign(new TypeError('pool.query is required'), { code: 'FORMAL_RESEARCH_REPOSITORY_INVALID_INPUT' });
  const result = await pool.query(
    `SELECT s.prediction_id AS "predictionId", s.horizon,
            s.target_start_time AS "targetStartTime", s.target_end_time AS "targetEndTime",
            s.expected_direction AS "predictedDirection",
            s.proxy_state_at_generation AS "proxyStateAtGeneration",
            s.feature_values_used->>'trend4h' AS "trend4hAtGeneration",
            e.actual_direction AS "actualDirection", e.actual_return AS "actualReturn",
            e.direction_correct AS "directionCorrect",
            e.direction_eligible_for_statistics AS "directionEligibleForStatistics",
            e.path_eligible_for_statistics AS "pathEligibleForStatistics",
            e.endpoint_data_complete AS "endpointDataComplete",
            e.path_data_complete AS "pathDataComplete", e.mfe, e.mae
       FROM historical_validation.replay_snapshots s
       JOIN historical_validation.validation_runs vr
         ON vr.validation_run_id=$1
        AND vr.algorithm_version=s.algorithm_version
        AND vr.dataset_version=s.dataset_version
       JOIN historical_validation.replay_outcome_events e
         ON e.prediction_id=s.prediction_id
        AND e.research_availability_rule_version=s.research_availability_rule_version
        AND e.evaluation_version=$2
      WHERE EXISTS (
        SELECT 1 FROM historical_validation.replay_generation_runs g
         WHERE g.validation_run_id=$1 AND g.horizon=s.horizon
           AND g.historical_as_of_time=s.target_start_time AND g.status='SUCCEEDED'
      )
      ORDER BY s.horizon, s.target_start_time, s.prediction_id`,
    [validationRunId, evaluationVersion]
  );
  return result.rows.map(row => ({
    predictionId: row.predictionId,
    horizon: row.horizon,
    targetStartTime: row.targetStartTime instanceof Date ? row.targetStartTime.getTime() : Date.parse(row.targetStartTime),
    targetEndTime: row.targetEndTime instanceof Date ? row.targetEndTime.getTime() : Date.parse(row.targetEndTime),
    predictedDirection: row.predictedDirection,
    expectedDirection: row.predictedDirection,
    trend4hAtGeneration: row.trend4hAtGeneration,
    trend4hDirection: row.trend4hAtGeneration,
    marketRegime: row.trend4hAtGeneration,
    proxyStateAtGeneration: row.proxyStateAtGeneration,
    actualDirection: row.actualDirection,
    actualReturn: row.actualReturn == null ? null : Number(row.actualReturn),
    directionCorrect: row.directionCorrect,
    directionEligibleForStatistics: row.directionEligibleForStatistics === true,
    pathEligibleForStatistics: row.pathEligibleForStatistics === true,
    isDirectionSample: row.directionEligibleForStatistics === true,
    isMarketRegimeSample: row.directionEligibleForStatistics === true,
    endpointDataComplete: row.endpointDataComplete === true,
    pathDataComplete: row.pathDataComplete === true,
    mfe: row.mfe == null ? null : Number(row.mfe),
    mae: row.mae == null ? null : Number(row.mae)
  }));
}
