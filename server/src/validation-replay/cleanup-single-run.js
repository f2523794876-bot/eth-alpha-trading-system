// V1_4D_HISTORICAL_REPLAY_SPEC.md §三.1：单个validation_run清理，冻结删除顺序（按外键依赖，先删子表再删父表）。
// 红线：
//  - 只触碰historical_validation schema内部，不涉及、不级联到public.market_bars/public.feature_records；
//  - backfill_batches不在删除范围内——一个backfill_batch_id可能被多个validation_run引用；
//  - dataset_manifests同样不在删除范围内——一个dataset_version可能被多个validation_run引用，且manifest的
//    存在本身独立于任何具体run是否还活着，即使所有引用它的run都被清理，manifest仍应永久保留。
// 本模块只对 replay_outcome_events/replay_snapshots/replay_evaluation_runs/replay_generation_runs/
// validation_reports/validation_runs 六张表执行DELETE，全部SQL语句schema-qualified。

export async function cleanupSingleRun(pool, { validationRunId }) {
  await pool.query(
    `DELETE FROM historical_validation.replay_outcome_events
     WHERE evaluation_run_id IN (SELECT evaluation_run_id FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1)`,
    [validationRunId]
  );
  await pool.query(
    `DELETE FROM historical_validation.replay_snapshots
     WHERE generation_run_id IN (SELECT generation_run_id FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1)`,
    [validationRunId]
  );
  await pool.query(`DELETE FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1`, [validationRunId]);
  await pool.query(`DELETE FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1`, [validationRunId]);
  await pool.query(`DELETE FROM historical_validation.validation_reports WHERE validation_run_id=$1`, [validationRunId]);
  const result = await pool.query(`DELETE FROM historical_validation.validation_runs WHERE validation_run_id=$1`, [validationRunId]);
  return { validationRunId, status: 'DELETED', validationRunDeleted: result.rowCount > 0 };
}
