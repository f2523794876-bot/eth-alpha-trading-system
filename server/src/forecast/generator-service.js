// V1_4C_SCOPE_SPEC.md §7/§10 — ForecastGenerator：独立调度器、独立lease('forecast-generator')、单事务生成ForecastSnapshot。
// 复用V1.4A/B已验证的schedule()/clearSchedulers()/loseLease()模式与collector_leases表结构（同表不同lease_name行），
// 但独立类实例、独立定时器数组、独立运行状态，不与OutcomeEvaluator共享任何调度状态（§7.1红线）。
// assertLease()在本文件本地实现（与server/src/db/postgres.js内部同名函数逻辑完全一致，但postgres.js未导出该函数，
// 且不在本轮允许修改的文件范围内，故本地复制这一份，不改动postgres.js本身）。
import { randomUUID } from 'node:crypto';
import { computeFourHourAtr14, computeConsecutiveBreakoutBars, locateReferenceBarAndPath } from './bar-path-locator.js';
import { computeDirectionThreshold } from './threshold-formula.js';
import { evaluatePoState } from './po-state-engine.js';
import { finalizeForecastSnapshot, computeExpectedPriceZones, deriveExpectedDirection, computeRawScenarioScore, buildTriggerConditions, buildInvalidationConditions } from './forecast-contract.js';
import { canonicalJsonHash } from '../domain/hash.js';
import { FEATURE_ALGORITHM_VERSION, FEATURE_SET_VERSION, SOURCE_DATASET_VERSION } from '../features/feature-version.js';

export const LEASE_NAME = 'forecast-generator';
const AUXILIARY_EVIDENCE_FIELDS = ['fundingRate', 'fundingRateZScore', 'openInterest', 'openInterestChange', 'openInterestChangeRatio', 'longShortRatio', 'longShortRatioZScore', 'takerBuySellRatio', 'derivativesAvailability'];
const UP_ISH = new Set(['PO_BREAKOUT_UP_STRUCTURE', 'PO_TREND_UP_STRUCTURE']);
const DOWN_ISH = new Set(['PO_BREAKDOWN_STRUCTURE', 'PO_TREND_DOWN_STRUCTURE', 'PO_SHARP_DROP_STRUCTURE']);

async function assertLease(client, lease) {
  const result = await client.query(
    `SELECT fencing_token FROM collector_leases WHERE lease_name=$1 AND holder_id=$2 AND fencing_token=$3 AND expires_at>clock_timestamp() FOR SHARE`,
    [lease.leaseName, lease.holderId, lease.fencingToken]
  );
  if (!result.rowCount) throw Object.assign(new Error('Stale or expired forecast generator fencing token'), { code: 'FENCING_TOKEN_REJECTED' });
}

// 生成时刻targetBar尚未发生（horizon在未来），§4字段表barKey格式冻结为`${symbol}-15m-${closeTime}`（不得使用ad-hoc占位后缀）；
// openTime按15m timeframeMs推算，不得为null（BarRef形状红线，同locateReferenceBarAndPath/locatePathForEvaluation构造方式一致）
function buildProjectedTargetBarRef(symbol, referenceCloseTime, expectedBarCount) {
  const closeTime = referenceCloseTime + expectedBarCount * 900000;
  const openTime = closeTime - 900000 + 1;
  return Object.freeze({ symbol, timeframe: '15m', openTime, closeTime, timeframeMs: 900000, sequenceIndex: expectedBarCount, barKey: `${symbol}-15m-${closeTime}` });
}

// §9.3：auxiliaryEvidence与proxyState方向性矛盾时只记录，不改变proxyState（不参与判定输入）
function buildAuxiliaryConflictNotes(proxyState, auxiliaryEvidence) {
  const notes = [];
  const fz = auxiliaryEvidence.fundingRateZScore;
  if (UP_ISH.has(proxyState) && Number.isFinite(fz) && fz <= -2) notes.push('资金费率Z分数显示极端负值，与当前价格结构判定的上行倾向存在方向性矛盾（仅记录，不改变proxyState）');
  if (DOWN_ISH.has(proxyState) && Number.isFinite(fz) && fz >= 2) notes.push('资金费率Z分数显示极端正值，与当前价格结构判定的下行倾向存在方向性矛盾（仅记录，不改变proxyState）');
  return notes;
}

// P0-1修复：正式启动使用的默认生成目标——V1.4B FeatureEngine只对ETHUSDT产出feature_records（BTC仅作为联动输入信号，
// 不是独立预测标的，同po-state-engine.js btcTrendState/ethBtcRollingCorrelation的输入定位），故只生成ETH的24H/72H两条。
export const DEFAULT_GENERATION_TARGETS = Object.freeze([
  Object.freeze({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' }),
  Object.freeze({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '72h' })
]);

export class ForecastGenerator {
  constructor({ pool, holderId, now = Date.now, serverTimeProvider, leaseTtlMs = 60000, featureWaitMs = 2000, featureWaitAttempts = 4, logger = console }) {
    if (!pool || !holderId || typeof serverTimeProvider !== 'function') throw new Error('ForecastGenerator requires pool/holderId/serverTimeProvider');
    this.pool = pool; this.holderId = holderId; this.now = now; this.serverTimeProvider = serverTimeProvider; this.leaseTtlMs = leaseTtlMs; this.featureWaitMs = featureWaitMs; this.featureWaitAttempts = featureWaitAttempts; this.logger = logger;
    this.timers = []; this.heartbeatTimer = null; this.running = false; this.leaseLost = false; this.lease = null;
    // 独立abortController（P0-1/P1-1要求）：不与CollectorService共享，仅表达本调度器自身的生命周期终止信号
    this.abortController = new AbortController();
  }

  // P0-1修复：正式生产启动入口。独立于CollectorService（不同类实例、不同timers数组、不同running/lease状态、
  // 不同abortController），只复用同一套已验证的collector_leases表结构与SQL模式（同表不同lease_name行）。
  async start({ targets = DEFAULT_GENERATION_TARGETS, intervalMs = 5 * 60000, heartbeatIntervalMs = Math.floor(this.leaseTtlMs / 3) } = {}) {
    if (this.running) throw Object.assign(new Error('Forecast generator already running'), { code: 'FORECAST_GENERATOR_ALREADY_RUNNING' });
    this.abortController = new AbortController();
    const lease = await this.acquireLease();
    if (!lease) throw Object.assign(new Error('Forecast generator lease held by another holder'), { code: 'FORECAST_GENERATOR_LEASE_HELD' });
    this.running = true; this.leaseLost = false;
    this.schedule(intervalMs, targets);
    this.scheduleHeartbeat(heartbeatIntervalMs);
    return this.status();
  }

  schedule(intervalMs, targets) {
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      for (const target of targets) { try { await this.runOnce(target); } catch { /* 失败已记录于forecast_generation_runs/forecast_quality_events，调度循环本身不中止 */ } }
      if (this.running) this.timers.push(setTimeout(tick, intervalMs));
    };
    this.timers.push(setTimeout(tick, intervalMs));
  }

  // P1-1修复（Codex复审）：60秒默认lease若无人续约，下一轮transaction()内assertLease()必然因token过期抛
  // FENCING_TOKEN_REJECTED，永久停止调度——此前遗漏心跳环节。复用CollectorService（server/src/collector/service.js
  // heartbeat()/schedule()）已验证的心跳模式：独立定时器链、续约失败立即loseLease()自行停止，不影响OutcomeEvaluator。
  scheduleHeartbeat(intervalMs = Math.floor(this.leaseTtlMs / 3)) {
    const tick = async () => {
      if (!this.running) return;
      try { await this.heartbeat(); }
      catch (error) { this.logger?.error?.('forecast generator heartbeat failed', { code: error.code || error.message }); }
      if (this.running) this.heartbeatTimer = setTimeout(tick, intervalMs);
    };
    this.heartbeatTimer = setTimeout(tick, intervalMs);
  }

  async heartbeat() {
    if (!this.lease) throw Object.assign(new Error('No active forecast generator lease to heartbeat'), { code: 'LEASE_LOST' });
    const result = await this.pool.query(
      `UPDATE collector_leases SET heartbeat_at=clock_timestamp(),expires_at=clock_timestamp()+($4||' milliseconds')::interval
       WHERE lease_name=$1 AND holder_id=$2 AND fencing_token=$3 AND expires_at>clock_timestamp()
       RETURNING lease_name AS "leaseName",holder_id AS "holderId",fencing_token::bigint AS "fencingToken",expires_at AS "expiresAt"`,
      [LEASE_NAME, this.holderId, this.lease.fencingToken, this.leaseTtlMs]
    );
    const renewed = result.rows[0] || null;
    if (!renewed) { this.loseLease('LEASE_LOST'); throw Object.assign(new Error('Forecast generator lease lost'), { code: 'LEASE_LOST' }); }
    this.lease = renewed;
    return renewed;
  }

  clearSchedulers() {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
  }
  loseLease(reason = 'LEASE_LOST') {
    if (this.leaseLost) return;
    this.leaseLost = true; this.lease = null;
    this.clearSchedulers();
    this.abortController.abort(reason);
  }

  // P0-1修复：graceful shutdown——停止调度、终止abortController、不额外关闭pool（pool由bootstrap统一生命周期管理，
  // 与CollectorService.stop()的closeRepository参数模式一致，但ForecastGenerator本身不持有repository实例）。
  async stop() {
    this.running = false;
    this.clearSchedulers();
    this.abortController.abort('shutdown');
  }

  status() {
    return {
      running: this.running, holderId: this.holderId, leaseLost: this.leaseLost,
      lease: this.lease ? { leaseName: this.lease.leaseName, holderId: this.lease.holderId, fencingToken: this.lease.fencingToken, expiresAt: this.lease.expiresAt } : null
    };
  }

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

  async waitForExactFeature(client, { instrument, targetBarCloseTime, asOfTime }) {
    const attempts = Math.max(1, Number(this.featureWaitAttempts) || 1);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (this.abortController.signal.aborted) throw Object.assign(new Error('Forecast generator stopping'), { code: 'FORECAST_GENERATOR_STOPPING' });
      const result = await client.query(
        `SELECT feature_record_id, feature_values, quality_state, completeness FROM feature_records
         WHERE symbol=$1 AND target_interval='15m' AND target_bar_close_time=to_timestamp($2/1000.0)
           AND as_of_time<=to_timestamp($3/1000.0) AND feature_set_version=$4
         ORDER BY revision_number DESC LIMIT 1`,
        [instrument, targetBarCloseTime, asOfTime, FEATURE_SET_VERSION]
      );
      if (result.rows[0]) return { row: result.rows[0], attempts: attempt };
      if (attempt < attempts) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, this.featureWaitMs);
          this.abortController.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('Forecast generator stopping'), { code: 'FORECAST_GENERATOR_STOPPING' }));
          }, { once: true });
        });
      }
    }
    return { row: null, attempts };
  }

  // forecast_snapshots.generation_run_id有NOT NULL外键指向本表，本方法必须先以INSERT在generateSnapshot开头"预占"该行
  // （status='RUNNING'），再由后续blocked()/成功路径用ON CONFLICT DO UPDATE原地更新最终状态——不得先插入forecast_snapshots
  // 再补记录run，否则违反外键约束（同一事务内，被引用行必须先于引用行存在）。
  async recordRun(client, { runId, instrument, horizon, status, generatedCount = 0, dedupedCount = 0, blockedCount = 0, errorCode = null, startedAt, finishedAt }) {
    await client.query(
      `INSERT INTO forecast_generation_runs(generation_run_id,lease_name,status,instrument,horizon,generated_count,deduped_count,blocked_count,error_code,fencing_token,started_at,finished_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11/1000.0),$12)
       ON CONFLICT(generation_run_id) DO UPDATE SET status=EXCLUDED.status,generated_count=EXCLUDED.generated_count,deduped_count=EXCLUDED.deduped_count,blocked_count=EXCLUDED.blocked_count,error_code=EXCLUDED.error_code,finished_at=EXCLUDED.finished_at`,
      [runId, LEASE_NAME, status, instrument, horizon, generatedCount, dedupedCount, blockedCount, errorCode, this.lease.fencingToken, startedAt, finishedAt ? new Date(finishedAt) : null]
    );
  }

  async recordQualityEvent(client, { forecastSnapshotId = null, predictionId = null, eventType, severity, reasons, occurredAt }) {
    const id = randomUUID();
    const contentHash = canonicalJsonHash({ eventType, reasons, predictionId, occurredAt });
    await client.query(
      `INSERT INTO forecast_quality_events(forecast_quality_event_id,forecast_snapshot_id,prediction_id,lease_name,event_type,severity,reasons,occurred_at,content_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,to_timestamp($8/1000.0),$9)`,
      [id, forecastSnapshotId, predictionId, LEASE_NAME, eventType, severity, JSON.stringify(reasons), occurredAt, contentHash]
    );
  }

  async runOnce({ instrument = 'ETHUSDT', symbol = 'ETH', horizon }) {
    if (!this.lease) await this.acquireLease();
    if (!this.lease) return { status: 'BLOCKED', reason: 'LEASE_UNAVAILABLE' };
    const runId = randomUUID();
    const startedAt = this.now();

    // §7.5：服务器时间前置门禁，fail closed，不猜测referenceBar
    const serverTime = await this.serverTimeProvider();
    if (!serverTime.ok) {
      await this.transaction(async client => this.recordRun(client, { runId, instrument, horizon, status: 'BLOCKED', blockedCount: 1, errorCode: 'SERVER_TIME_UNAVAILABLE', startedAt, finishedAt: this.now() }));
      return { status: 'BLOCKED', reason: 'SERVER_TIME_UNAVAILABLE' };
    }
    const asOfTime = serverTime.sourceServerTime;

    try {
      return await this.transaction(client => this.generateSnapshot(client, { runId, instrument, symbol, horizon, asOfTime, startedAt }));
    } catch (error) {
      if (error.code === 'FENCING_TOKEN_REJECTED') throw error;
      return { status: 'BLOCKED', reason: error.code || 'GENERATION_FAILED', error: error.message };
    }
  }

  async generateSnapshot(client, { runId, instrument, symbol, horizon, asOfTime, startedAt }) {
    // 预占forecast_generation_runs行（status='RUNNING'），满足forecast_snapshots.generation_run_id外键的"被引用行先存在"要求
    await this.recordRun(client, { runId, instrument, horizon, status: 'RUNNING', startedAt, finishedAt: null });
    const blocked = async (errorCode, reasons) => {
      await this.recordRun(client, { runId, instrument, horizon, status: 'BLOCKED', blockedCount: 1, errorCode, startedAt, finishedAt: this.now() });
      await this.recordQualityEvent(client, { eventType: errorCode, severity: 'BLOCKED', reasons, occurredAt: this.now() });
      return { status: 'BLOCKED', reason: errorCode };
    };

    const located = await locateReferenceBarAndPath(client, { instrument, horizon, asOfTime, symbol });
    // P1-2修复：referenceBar未命中horizon节奏边界（24H=4小时/72H=UTC自然日）也会走到这里，属于正常的"本轮尚未到生成
    // 时刻"，不是数据缺陷——高频轮询在两次节奏边界之间反复命中此分支正是"不得凑样本量"红线的预期行为。
    if (!located.referenceBarRef) return blocked('REFERENCE_BAR_NOT_DUE_OR_MISSING', located.exclusionReasons);

    const atr = await computeFourHourAtr14(client, { instrument, asOfTime });
    if (!atr.ok) return blocked('ATR14_4H_INSUFFICIENT', [atr.reason]);

    let threshold;
    try { threshold = computeDirectionThreshold({ atr14FourHourAtGeneration: atr.atr14FourHourAtGeneration, referencePrice: located.referencePrice, horizon }); }
    catch (error) { return blocked(error.code || 'THRESHOLD_COMPUTATION_FAILED', [error.message]); }

    // 预测必须消费与referenceBar完全相同时间键的特征。旧实现按“<= asOfTime取最近一条”会在新特征尚未生成时
    // 静默复用上一根K线特征。这里做有限次、可中止等待；超过上限仍未就绪就fail closed，交由下一调度周期重试。
    const featureResult = await this.waitForExactFeature(client, {
      instrument,
      targetBarCloseTime: located.referenceBarRef.closeTime,
      asOfTime
    });
    const featureRow = featureResult.row;
    if (!featureRow) return blocked('FEATURE_RECORD_MISSING', [
      `exact feature not ready: ${instrument}/15m/${located.referenceBarRef.closeTime}`,
      `bounded attempts exhausted: ${featureResult.attempts}`
    ]);
    const fv = featureRow.feature_values;

    const [breakoutCount, breakdownCount] = await Promise.all([
      computeConsecutiveBreakoutBars(client, { instrument, asOfTime, direction: 'up' }),
      computeConsecutiveBreakoutBars(client, { instrument, asOfTime, direction: 'down' })
    ]);

    const poResult = evaluatePoState({
      close: located.referencePrice, closeToEma5: fv.closeToEma5, trend4h: fv.trend4h, trend1h: fv.trend1h, volumeRatio20: fv.volumeRatio20,
      swingHigh: fv.swingHigh, swingLow: fv.swingLow, breakoutState: fv.breakoutState, upperWickRatio: fv.upperWickRatio, lowerWickRatio: fv.lowerWickRatio,
      distanceToSupportAtr: fv.distanceToSupportAtr, distanceToResistanceAtr: fv.distanceToResistanceAtr, falseBreakoutRisk: fv.falseBreakoutRisk,
      atr14FourHour: atr.atr14FourHourAtGeneration, qualityState: featureRow.quality_state, completeness: Number(featureRow.completeness),
      breakoutCount: breakoutCount.count, breakdownCount: breakdownCount.count, btcTrendState: fv.btcTrendState, ethBtcRollingCorrelation: fv.ethBtcRollingCorrelation,
      logReturn1: fv.logReturn1
    });

    const auxiliaryEvidence = Object.fromEntries(AUXILIARY_EVIDENCE_FIELDS.map(key => [key, fv[key] ?? null]));
    const auxiliaryConflictNotes = buildAuxiliaryConflictNotes(poResult.proxyState, auxiliaryEvidence);
    const expectedDirection = deriveExpectedDirection(poResult.proxyState);
    const expectedPriceZones = computeExpectedPriceZones(located.referencePrice, threshold.directionThreshold);
    const rawScore = computeRawScenarioScore(poResult.proxyState, poResult.stateConfidence);

    let snapshotInput;
    try {
      snapshotInput = finalizeForecastSnapshot({
        instrument: symbol, horizon, generatedAt: asOfTime, dataCutoffTime: asOfTime,
        targetStartTime: located.referenceBarRef.closeTime, targetEndTime: located.referenceBarRef.closeTime + located.expectedBarCount * 900000,
        referencePrice: located.referencePrice, referenceBarRef: located.referenceBarRef, targetBarRef: located.observedBars.find(b => b.sequenceIndex === located.expectedBarCount) ?? buildProjectedTargetBarRef(symbol, located.referenceBarRef.closeTime, located.expectedBarCount),
        expectedBarCount: located.expectedBarCount, expectedDirection, directionThreshold: threshold.directionThreshold, rawThreshold: threshold.rawThreshold,
        thresholdFloor: threshold.thresholdFloor, thresholdCeiling: threshold.thresholdCeiling, thresholdFormulaVersion: threshold.thresholdFormulaVersion,
        atr14FourHourAtGeneration: atr.atr14FourHourAtGeneration, proxyStateAtGeneration: poResult.proxyState,
        candidateTrajectories: { stateEvidence: poResult.stateEvidence, opposingEvidence: poResult.opposingEvidence, stateConfidence: poResult.stateConfidence, poRuleVersion: poResult.poRuleVersion },
        scenarioWeights: rawScore, expectedPriceZones,
        triggerConditions: buildTriggerConditions(horizon), invalidationConditions: buildInvalidationConditions(horizon),
        dataVintageRefs: [], featureValuesUsed: fv, featureRecordIds: [featureRow.feature_record_id],
        featureEngineVersion: FEATURE_ALGORITHM_VERSION, datasetVersion: SOURCE_DATASET_VERSION,
        auxiliaryEvidence: { ...auxiliaryEvidence, auxiliaryConflictNotes }
      });
    } catch (error) { return blocked(error.code || 'FORECAST_CONTRACT_REJECTED', error.reasons || [error.message]); }

    const insertResult = await client.query(
      `INSERT INTO forecast_snapshots(
        prediction_id,instrument,horizon,generated_at,data_cutoff_time,target_start_time,target_end_time,reference_price,reference_bar_ref,target_bar_ref,
        expected_bar_count,expected_direction,direction_threshold,raw_threshold,threshold_floor,threshold_ceiling,threshold_formula_version,
        atr14_four_hour_at_generation,target_state_at_generation,proxy_state_at_generation,fusion_state_at_generation,candidate_trajectories,
        scenario_weight_baseline,scenario_weight_upside,scenario_weight_downside,probability_status,calibrated_probabilities,expected_price_zones,
        trigger_conditions,invalidation_conditions,algorithm_version,weight_version,dataset_version,data_vintage_refs,feature_values_used,
        feature_record_ids,feature_engine_version,content_hash,auxiliary_evidence,source_origin,generation_run_id,lease_name,fencing_token
      ) VALUES($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),to_timestamp($6/1000.0),to_timestamp($7/1000.0),$8,$9::jsonb,$10::jsonb,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,
        $23,$24,$25,$26,$27::jsonb,$28::jsonb,$29::jsonb,$30::jsonb,
        $31,$32,$33,$34::jsonb,$35::jsonb,$36::jsonb,
        $37,$38,$39::jsonb,$40,$41,$42,$43
      ) ON CONFLICT(prediction_id) DO NOTHING RETURNING forecast_snapshot_id`,
      [
        snapshotInput.predictionId, symbol, horizon, snapshotInput.generatedAt, snapshotInput.dataCutoffTime, snapshotInput.targetStartTime, snapshotInput.targetEndTime,
        snapshotInput.referencePrice, JSON.stringify(snapshotInput.referenceBarRef), JSON.stringify(snapshotInput.targetBarRef),
        snapshotInput.expectedBarCount, snapshotInput.expectedDirection, snapshotInput.directionThreshold, snapshotInput.rawThreshold, snapshotInput.thresholdFloor,
        snapshotInput.thresholdCeiling, snapshotInput.thresholdFormulaVersion, snapshotInput.atr14FourHourAtGeneration, 'UNKNOWN', snapshotInput.proxyStateAtGeneration,
        'UNKNOWN', JSON.stringify(snapshotInput.candidateTrajectories), snapshotInput.scenarioWeights.baseline, snapshotInput.scenarioWeights.upside, snapshotInput.scenarioWeights.downside,
        'rule_based', null, JSON.stringify(snapshotInput.expectedPriceZones), JSON.stringify(snapshotInput.triggerConditions), JSON.stringify(snapshotInput.invalidationConditions),
        snapshotInput.algorithmVersion, snapshotInput.weightVersion, snapshotInput.datasetVersion, JSON.stringify(snapshotInput.dataVintageRefs),
        JSON.stringify(snapshotInput.featureValuesUsed), JSON.stringify(snapshotInput.featureRecordIds), snapshotInput.featureEngineVersion, snapshotInput.contentHash,
        JSON.stringify(snapshotInput.auxiliaryEvidence), 'SERVER', runId, LEASE_NAME, this.lease.fencingToken
      ]
    );

    if (!insertResult.rowCount) {
      const existing = await client.query('SELECT * FROM forecast_snapshots WHERE prediction_id=$1', [snapshotInput.predictionId]);
      await this.recordRun(client, { runId, instrument, horizon, status: 'SUCCEEDED', dedupedCount: 1, startedAt, finishedAt: this.now() });
      return { status: 'DEDUPED', record: existing.rows[0] };
    }
    const forecastSnapshotId = insertResult.rows[0].forecast_snapshot_id;
    await client.query(
      `INSERT INTO forecast_snapshot_sources(forecast_snapshot_id,feature_record_id,role,vintage_id) VALUES($1,$2,$3,$4)`,
      [forecastSnapshotId, featureRow.feature_record_id, 'primary_15m_feature_record', `feature_record:${featureRow.feature_record_id}`]
    );
    if (auxiliaryConflictNotes.length) {
      await this.recordQualityEvent(client, { forecastSnapshotId, predictionId: snapshotInput.predictionId, eventType: 'AUXILIARY_EVIDENCE_CONFLICT', severity: 'INFO', reasons: auxiliaryConflictNotes, occurredAt: this.now() });
    }
    await this.recordRun(client, { runId, instrument, horizon, status: 'SUCCEEDED', generatedCount: 1, startedAt, finishedAt: this.now() });
    return { status: 'INSERTED', record: snapshotInput };
  }
}
