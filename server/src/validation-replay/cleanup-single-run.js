// V1_4D_HISTORICAL_REPLAY_SPEC.md §三.1：单个validation_run清理，冻结删除顺序（按外键依赖，先删子表再删父表）。
// 红线：
//  - 只触碰historical_validation schema内部，不涉及、不级联到public.market_bars/public.feature_records；
//  - backfill_batches不在删除范围内——一个backfill_batch_id可能被多个validation_run引用；
//  - dataset_manifests同样不在删除范围内——一个dataset_version可能被多个validation_run引用，且manifest的
//    存在本身独立于任何具体run是否还活着，即使所有引用它的run都被清理，manifest仍应永久保留。
// 本模块只对 replay_outcome_events/replay_snapshots/replay_evaluation_runs/replay_generation_runs/
// validation_reports/validation_runs 六张表执行DELETE，全部SQL语句schema-qualified。
//
// P1-1修复（独立复审）：六步删除必须在同一个数据库client上、同一个事务内执行——显式BEGIN/COMMIT，
// 任一步失败必须ROLLBACK，不得留下部分删除状态；client必须安全释放（finally块，无论成功/失败）。
// 调用方传入的第一个参数是一个具备 .connect() 的连接池（pg Pool 或等价duck-type），本函数自行获取、
// 使用、释放同一个client——不复用调用方已持有的client（那样会与调用方自身的事务/连接生命周期耦合，
// 无法独立保证"六步在同一事务"这一约束，也无法在此处安全释放一个自己并不拥有的连接）。
// 跨run共享/FK限制导致的失败（例如另一个validation_run的replay_outcome_events仍引用本run"拥有"的
// 某条被ON CONFLICT DO NOTHING去重复用的replay_snapshots行，触发FOREIGN KEY RESTRICT）：整个事务
// 完整ROLLBACK（不留半清理状态），并抛出明确、可诊断的错误（区分FK限制 vs 其他失败原因）。

const DELETE_OUTCOME_EVENTS_SQL = `DELETE FROM historical_validation.replay_outcome_events
     WHERE evaluation_run_id IN (SELECT evaluation_run_id FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1)`;
const DELETE_SNAPSHOTS_SQL = `DELETE FROM historical_validation.replay_snapshots
     WHERE generation_run_id IN (SELECT generation_run_id FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1)`;
const DELETE_EVALUATION_RUNS_SQL = `DELETE FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1`;
const DELETE_GENERATION_RUNS_SQL = `DELETE FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1`;
const DELETE_REPORTS_SQL = `DELETE FROM historical_validation.validation_reports WHERE validation_run_id=$1`;
const DELETE_VALIDATION_RUN_SQL = `DELETE FROM historical_validation.validation_runs WHERE validation_run_id=$1`;

const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';

export async function cleanupSingleRun(pool, { validationRunId }) {
  if (!validationRunId) throw Object.assign(new Error('cleanupSingleRun requires validationRunId'), { code: 'VALIDATION_RUN_ID_REQUIRED' });
  if (typeof pool?.connect !== 'function') {
    throw Object.assign(new Error('cleanupSingleRun requires a pool-like object exposing .connect() so it can own a single dedicated client for the whole transaction'), { code: 'CLEANUP_POOL_REQUIRED' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 六步删除顺序冻结（§三.1），全部在同一client/同一事务内执行，保持先删子表再删父表：
    await client.query(DELETE_OUTCOME_EVENTS_SQL, [validationRunId]);
    await client.query(DELETE_SNAPSHOTS_SQL, [validationRunId]);
    await client.query(DELETE_EVALUATION_RUNS_SQL, [validationRunId]);
    await client.query(DELETE_GENERATION_RUNS_SQL, [validationRunId]);
    await client.query(DELETE_REPORTS_SQL, [validationRunId]);
    const result = await client.query(DELETE_VALIDATION_RUN_SQL, [validationRunId]);
    await client.query('COMMIT');
    return { validationRunId, status: 'DELETED', validationRunDeleted: result.rowCount > 0 };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw Object.assign(
        new Error(`cleanupSingleRun: ROLLBACK itself failed after an earlier error (validationRunId=${validationRunId}); original error: ${error.message}; rollback error: ${rollbackError.message}`),
        { code: 'CLEANUP_ROLLBACK_FAILED', validationRunId, originalError: error, rollbackError }
      );
    }
    const blockedByForeignKey = error.code === POSTGRES_FOREIGN_KEY_VIOLATION;
    throw Object.assign(
      new Error(
        blockedByForeignKey
          ? `cleanupSingleRun: cleanup fully rolled back (no partial deletion) — validationRunId=${validationRunId} is blocked by a foreign-key reference (likely a shared replay_snapshots row still referenced by another validation_run's replay_outcome_events): ${error.message}`
          : `cleanupSingleRun: cleanup fully rolled back (no partial deletion) — validationRunId=${validationRunId} failed: ${error.message}`
      ),
      {
        code: blockedByForeignKey ? 'CLEANUP_BLOCKED_BY_SHARED_REFERENCE' : 'CLEANUP_FAILED',
        validationRunId,
        pgErrorCode: error.code,
        pgDetail: error.detail,
        cause: error
      }
    );
  } finally {
    client.release();
  }
}
