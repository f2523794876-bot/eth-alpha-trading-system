// V1_4C_SCOPE_SPEC.md §7 — OutcomeEvaluator：与ForecastGenerator完全独立的第二调度器实例，独立lease('forecast-outcome-evaluator')、
// 独立定时器/运行状态/审计表(forecast_evaluation_runs)，只对forecast_outcome_events/forecast_quality_events(回填相关)写入生效。
// assertLease()本地实现，理由同generator-service.js头部注释（postgres.js未导出、不在本轮允许修改范围）。
import { randomUUID } from 'node:crypto';
import { locatePathForEvaluation } from '../forecast/bar-path-locator.js';
import { computeForecastOutcome } from './outcome-engine.js';
import { EVALUATION_VERSION } from '../forecast/forecast-version.js';
import { canonicalJsonHash } from '../domain/hash.js';

export const LEASE_NAME = 'forecast-outcome-evaluator';

async function assertLease(client, lease) {
  const result = await client.query(
    `SELECT fencing_token FROM collector_leases WHERE lease_name=$1 AND holder_id=$2 AND fencing_token=$3 AND expires_at>clock_timestamp() FOR SHARE`,
    [lease.leaseName, lease.holderId, lease.fencingToken]
  );
  if (!result.rowCount) throw Object.assign(new Error('Stale or expired outcome evaluator fencing token'), { code: 'FENCING_TOKEN_REJECTED' });
}

function rowToSnapshot(row) {
  return {
    predictionId: row.prediction_id, instrument: row.instrument, horizon: row.horizon,
    referencePrice: Number(row.reference_price), referenceBarRef: row.reference_bar_ref,
    expectedDirection: row.expected_direction, directionThreshold: Number(row.direction_threshold),
    expectedBarCount: row.expected_bar_count, expectedPriceZones: row.expected_price_zones
  };
}

export class OutcomeEvaluator {
  constructor({ pool, holderId, now = Date.now, serverTimeProvider, leaseTtlMs = 60000, evaluationVersion = EVALUATION_VERSION }) {
    if (!pool || !holderId || typeof serverTimeProvider !== 'function') throw new Error('OutcomeEvaluator requires pool/holderId/serverTimeProvider');
    this.pool = pool; this.holderId = holderId; this.now = now; this.serverTimeProvider = serverTimeProvider; this.leaseTtlMs = leaseTtlMs; this.evaluationVersion = evaluationVersion;
    this.timers = []; this.running = false; this.leaseLost = false; this.lease = null;
  }

  schedule(intervalMs) {
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try { await this.runOnce(); } catch { /* 失败已记录于forecast_evaluation_runs/forecast_quality_events */ }
      if (this.running) this.timers.push(setTimeout(tick, intervalMs));
    };
    this.timers.push(setTimeout(tick, intervalMs));
  }
  clearSchedulers() { this.running = false; for (const t of this.timers) clearTimeout(t); this.timers = []; }
  loseLease() { this.leaseLost = true; this.lease = null; this.clearSchedulers(); }

  async acquireLease() {
    const result = await this.pool.query(
      `INSERT INTO collector_leases(lease_name,holder_id,acquired_at,heartbeat_at,expires_at,fencing_token) VALUES($1,$2,clock_timestamp(),clock_timestamp(),clock_timestamp()+($3||' milliseconds')::interval,1)
       ON CONFLICT(lease_name) DO UPDATE SET holder_id=EXCLUDED.holder_id,acquired_at=clock_timestamp(),heartbeat_at=clock_timestamp(),expires_at=EXCLUDED.expires_at,fencing_token=collector_leases.fencing_token+1
       WHERE collector_leases.expires_at<=clock_timestamp() OR collector_leases.holder_id=EXCLUDED.holder_id
       RETURNING lease_name AS "leaseName",holder_id AS "holderId",fencing_token::bigint AS "fencingToken",expires_at AS "expiresAt"`,
      [LEASE_NAME, this.holderId, this.leaseTtlMs]
    );
    this.lease = result.rows[0] || null;
    if (!this.lease) this.loseLease();
    return this.lease;
  }

  async transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await assertLease(client, this.lease);
      const result = await work(client);
      await assertLease(client, this.lease);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === 'FENCING_TOKEN_REJECTED') this.loseLease();
      throw error;
    } finally { client.release(); }
  }

  // forecast_outcome_events.evaluation_run_id有NOT NULL外键指向本表，必须先在evaluatePending()开头以INSERT"预占"该行
  // （status='RUNNING'），再用ON CONFLICT DO UPDATE原地更新最终状态，理由同generator-service.js同名方法头部注释。
  async recordRun(client, { runId, status, evaluatedCount = 0, dedupedCount = 0, blockedCount = 0, errorCode = null, startedAt, finishedAt }) {
    await client.query(
      `INSERT INTO forecast_evaluation_runs(evaluation_run_id,lease_name,status,evaluated_count,deduped_count,blocked_count,error_code,fencing_token,started_at,finished_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0),$10)
       ON CONFLICT(evaluation_run_id) DO UPDATE SET status=EXCLUDED.status,evaluated_count=EXCLUDED.evaluated_count,deduped_count=EXCLUDED.deduped_count,blocked_count=EXCLUDED.blocked_count,error_code=EXCLUDED.error_code,finished_at=EXCLUDED.finished_at`,
      [runId, LEASE_NAME, status, evaluatedCount, dedupedCount, blockedCount, errorCode, this.lease.fencingToken, startedAt, finishedAt ? new Date(finishedAt) : null]
    );
  }

  async recordQualityEvent(client, { predictionId = null, eventType, severity, reasons, occurredAt }) {
    const id = randomUUID();
    const contentHash = canonicalJsonHash({ eventType, reasons, predictionId, occurredAt });
    await client.query(
      `INSERT INTO forecast_quality_events(forecast_quality_event_id,forecast_snapshot_id,prediction_id,lease_name,event_type,severity,reasons,occurred_at,content_hash)
       VALUES($1,NULL,$2,$3,$4,$5,$6::jsonb,to_timestamp($7/1000.0),$8)`,
      [id, predictionId, LEASE_NAME, eventType, severity, JSON.stringify(reasons), occurredAt, contentHash]
    );
  }

  // 找出targetEndTime已到达、且本evaluationVersion尚未回填过的快照（§9.2/§16红线：只评估到期的预测）
  async findPendingSnapshots(client, { asOfTime, limit = 50 }) {
    const result = await client.query(
      `SELECT s.* FROM forecast_snapshots s
       LEFT JOIN forecast_outcome_events e ON e.prediction_id=s.prediction_id AND e.evaluation_version=$1
       WHERE s.target_end_time<=to_timestamp($2/1000.0) AND e.forecast_outcome_event_id IS NULL
       ORDER BY s.target_end_time ASC LIMIT $3`,
      [this.evaluationVersion, asOfTime, limit]
    );
    return result.rows;
  }

  async runOnce({ limit = 50 } = {}) {
    if (!this.lease) await this.acquireLease();
    if (!this.lease) return { status: 'BLOCKED', reason: 'LEASE_UNAVAILABLE' };
    const runId = randomUUID();
    const startedAt = this.now();

    const serverTime = await this.serverTimeProvider();
    if (!serverTime.ok) {
      await this.transaction(async client => this.recordRun(client, { runId, status: 'BLOCKED', blockedCount: 1, errorCode: 'SERVER_TIME_UNAVAILABLE', startedAt, finishedAt: this.now() }));
      return { status: 'BLOCKED', reason: 'SERVER_TIME_UNAVAILABLE' };
    }
    const asOfTime = serverTime.sourceServerTime;

    try {
      return await this.transaction(client => this.evaluatePending(client, { runId, asOfTime, startedAt, limit }));
    } catch (error) {
      if (error.code === 'FENCING_TOKEN_REJECTED') throw error;
      return { status: 'BLOCKED', reason: error.code || 'EVALUATION_FAILED', error: error.message };
    }
  }

  async evaluatePending(client, { runId, asOfTime, startedAt, limit }) {
    // 预占forecast_evaluation_runs行，满足forecast_outcome_events.evaluation_run_id外键的"被引用行先存在"要求
    await this.recordRun(client, { runId, status: 'RUNNING', startedAt, finishedAt: null });
    const pending = await this.findPendingSnapshots(client, { asOfTime, limit });
    let evaluated = 0, deduped = 0;
    const results = [];
    for (const row of pending) {
      const snapshot = rowToSnapshot(row);
      const located = await locatePathForEvaluation(client, { instrument: row.instrument === 'ETH' ? 'ETHUSDT' : row.instrument, referenceBarRef: snapshot.referenceBarRef, expectedBarCount: snapshot.expectedBarCount, asOfTime });
      const outcome = computeForecastOutcome({ snapshot, located });
      const contentHash = canonicalJsonHash({ predictionId: outcome.predictionId, evaluationVersion: this.evaluationVersion, actualReturn: outcome.actualReturn, actualDirection: outcome.actualDirection, mfe: outcome.mfe, mae: outcome.mae });
      // forecast_outcome_event_id是bigserial（自增主键，同forecast_snapshot_id模式），不得显式插入UUID——由数据库自动生成，
      // 通过RETURNING取回，此前误将randomUUID()写入该列触发"invalid input syntax for type bigint"真实bug，已修正
      const insertResult = await client.query(
        `INSERT INTO forecast_outcome_events(
          prediction_id,evaluation_version,evaluation_run_id,evaluated_at,as_of_time,endpoint_data_complete,path_data_complete,
          direction_eligible_for_statistics,path_eligible_for_statistics,actual_return,actual_direction,direction_correct,actual_high,actual_low,mfe,mae,
          range_specific_metrics,invalidation_triggered,invalidation_reason,coverage_metrics,missing_bar_refs,source_origin,lease_name,fencing_token,content_hash
        ) VALUES($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20::jsonb,$21::jsonb,$22,$23,$24,$25)
        ON CONFLICT(prediction_id,evaluation_version) DO NOTHING RETURNING forecast_outcome_event_id`,
        [
          outcome.predictionId, this.evaluationVersion, runId, this.now(), asOfTime, outcome.endpointDataComplete, outcome.pathDataComplete,
          outcome.directionEligibleForStatistics, outcome.pathEligibleForStatistics, outcome.actualReturn, outcome.actualDirection, outcome.directionCorrect,
          outcome.actualHigh, outcome.actualLow, outcome.mfe, outcome.mae,
          // range_specific_metrics是路径类指标集合，pathEligibleForStatistics=false时必须整体为SQL NULL（非"值为null的对象"），
          // 对应forecast_outcome_events表CHECK(path_eligible_for_statistics OR range_specific_metrics IS NULL)
          outcome.pathEligibleForStatistics
            ? JSON.stringify({ upperExcursion: outcome.upperExcursion, lowerExcursion: outcome.lowerExcursion, maxAbsoluteExcursion: outcome.maxAbsoluteExcursion, rangeBreachExcursion: outcome.rangeBreachExcursion })
            : null,
          outcome.invalidationTriggered, null,
          // coverage_metrics捆绑endpoint类(需direction_eligible)与path类(需path_eligible)两组字段；
          // 只有endpoint本身不完整(directionEligibleForStatistics=false)时才整体为SQL NULL，
          // 对应CHECK(direction_eligible_for_statistics OR coverage_metrics IS NULL)；
          // endpoint完整但path不完整时仍需非NULL对象，内部path类子字段(realizedRangeInsideExpectedEnvelope/expectedEnvelopeTouched)已由outcome-engine.js置null
          outcome.directionEligibleForStatistics
            ? JSON.stringify({ endpointInBaselineZone: outcome.endpointInBaselineZone, endpointInAnyScenarioZone: outcome.endpointInAnyScenarioZone, realizedRangeInsideExpectedEnvelope: outcome.realizedRangeInsideExpectedEnvelope, expectedEnvelopeTouched: outcome.expectedEnvelopeTouched })
            : null,
          JSON.stringify(outcome.missingBarRefs), 'SERVER', LEASE_NAME, this.lease.fencingToken, contentHash
        ]
      );
      if (insertResult.rowCount) { evaluated++; results.push({ status: 'INSERTED', predictionId: outcome.predictionId }); }
      else { deduped++; results.push({ status: 'DEDUPED', predictionId: outcome.predictionId }); }
    }
    await this.recordRun(client, { runId, status: 'SUCCEEDED', evaluatedCount: evaluated, dedupedCount: deduped, startedAt, finishedAt: this.now() });
    return { status: 'SUCCEEDED', evaluated, deduped, results };
  }
}
