// V1_4D_HISTORICAL_REPLAY_SPEC.md §一/§2.3/§2.4/§4.7：历史ForecastSnapshot回放生成。
// 复用生产纯函数（bar-path-locator.js/threshold-formula.js/po-state-engine.js/forecast-contract.js），
// 镜像 server/src/forecast/generator-service.js `generateSnapshot()` 的计算顺序与写入模式，
// 但不复用其lease/serverTimeProvider/事务包装——本模块只写 historical_validation.replay_snapshots/replay_generation_runs
// 两张表，全部SQL语句schema-qualified，不获取/续租/释放任何生产collector_leases。
//
// 契约（调用方cli-entry.js必须遵守，本模块内部不重复校验）：
// 调用本模块前，调用方必须已经对本次validation_run整体调用过一次 dataset-manifest-verifier.js 的
// verifyDatasetManifest() 并确认 ok:true——manifest校验是"每次validation_run一次"的CLI级门禁，不是
// "每次生成一个快照重新算一遍"（后者会让每一步都重新查询+哈希整个数据集范围，性能不可接受，
// 也不是§4.1a的设计意图：八步流程写的是"在做任何historical_as_of_time推进或写入之前"执行一次）。
// 本模块因此不导入也不调用 dataset-manifest-builder.js/dataset-manifest-verifier.js，只信任调用方传入的
// datasetVersion 已经过校验（V1_4D_CODEX_IMPLEMENTATION_TASK.md §3.4："不得直接调用dataset-manifest-builder.js，
// 只允许调用verifier"这一红线约束的是"不得隐式建manifest"，未要求逐快照重复校验）。

import { randomUUID } from 'node:crypto';
import { computeFourHourAtr14, computeConsecutiveBreakoutBars, locateReferenceBarAndPath } from '../forecast/bar-path-locator.js';
import { computeDirectionThreshold } from '../forecast/threshold-formula.js';
import { evaluatePoState } from '../forecast/po-state-engine.js';
import {
  finalizeForecastSnapshot, computeExpectedPriceZones, deriveExpectedDirection,
  computeRawScenarioScore, buildTriggerConditions, buildInvalidationConditions, computeForecastContentHash
} from '../forecast/forecast-contract.js';
import { FEATURE_ALGORITHM_VERSION, FEATURE_SET_VERSION } from '../features/feature-version.js';
import { createResearchAvailabilityQueryable, buildResearchDataVintage, RESEARCH_AVAILABILITY_RULE_VERSION } from './research-availability.js';

const AUXILIARY_EVIDENCE_FIELDS = ['fundingRate', 'fundingRateZScore', 'openInterest', 'openInterestChange', 'openInterestChangeRatio', 'longShortRatio', 'longShortRatioZScore', 'takerBuySellRatio', 'derivativesAvailability'];
// generator-service.js 同名常量/函数是模块私有（未导出），本模块独立复制这两个纯辅助——不改变任何判定逻辑，
// 只是"用哪些辅助字段做展示"与"生成时目标bar尚未发生时的占位BarRef构造"，与PO_状态判定本身无关。
const UP_ISH = new Set(['PO_BREAKOUT_UP_STRUCTURE', 'PO_TREND_UP_STRUCTURE']);
const DOWN_ISH = new Set(['PO_BREAKDOWN_STRUCTURE', 'PO_TREND_DOWN_STRUCTURE', 'PO_SHARP_DROP_STRUCTURE']);

function buildProjectedTargetBarRef(symbol, referenceCloseTime, expectedBarCount) {
  const closeTime = referenceCloseTime + expectedBarCount * 900000;
  const openTime = closeTime - 900000 + 1;
  return Object.freeze({ symbol, timeframe: '15m', openTime, closeTime, timeframeMs: 900000, sequenceIndex: expectedBarCount, barKey: `${symbol}-15m-${closeTime}` });
}

function buildAuxiliaryConflictNotes(proxyState, auxiliaryEvidence) {
  const notes = [];
  const fz = auxiliaryEvidence.fundingRateZScore;
  if (UP_ISH.has(proxyState) && Number.isFinite(fz) && fz <= -2) notes.push('资金费率Z分数显示极端负值，与当前价格结构判定的上行倾向存在方向性矛盾（仅记录，不改变proxyState）');
  if (DOWN_ISH.has(proxyState) && Number.isFinite(fz) && fz >= 2) notes.push('资金费率Z分数显示极端正值，与当前价格结构判定的下行倾向存在方向性矛盾（仅记录，不改变proxyState）');
  return notes;
}

// feature_records.as_of_time 对已经真实运行过的历史时段而言就是当时的真实系统时间（生产FeatureGeneratorService
// 实时写入，不是回填产物），不存在market_bars.available_at那种"回填执行时间"悖论，故直接用真实pool查询，
// 不经research-availability queryable包装；不做重试等待（生产waitForExactFeature的重试是为应对实时竞态，
// 回放数据是静态历史，一次未命中即fail closed，见V1_4D_CODEX_IMPLEMENTATION_TASK.md任务边界）。
async function findExactFeatureForReplay(pool, { instrument, targetBarCloseTime, historicalAsOfTime }) {
  const result = await pool.query(
    `SELECT feature_record_id, feature_values, quality_state, completeness FROM feature_records
     WHERE symbol=$1 AND target_interval='15m' AND target_bar_close_time=to_timestamp($2/1000.0)
       AND as_of_time<=to_timestamp($3/1000.0) AND feature_set_version=$4
     ORDER BY revision_number DESC LIMIT 1`,
    [instrument, targetBarCloseTime, historicalAsOfTime, FEATURE_SET_VERSION]
  );
  return result.rows[0] || null;
}

async function recordGenerationRun(pool, { generationRunId, validationRunId, instrument, horizon, historicalAsOfTime, status, generatedCount = 0, dedupedCount = 0, blockedCount = 0, errorCode = null, startedAt, finishedAt }) {
  await pool.query(
    `INSERT INTO historical_validation.replay_generation_runs(
       generation_run_id,validation_run_id,instrument,horizon,historical_as_of_time,status,generated_count,deduped_count,blocked_count,error_code,started_at,finished_at
     ) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0),$6,$7,$8,$9,$10,to_timestamp($11/1000.0),$12)
     ON CONFLICT(generation_run_id) DO UPDATE SET status=EXCLUDED.status,generated_count=EXCLUDED.generated_count,
       deduped_count=EXCLUDED.deduped_count,blocked_count=EXCLUDED.blocked_count,error_code=EXCLUDED.error_code,finished_at=EXCLUDED.finished_at`,
    [generationRunId, validationRunId, instrument, horizon, historicalAsOfTime, status, generatedCount, dedupedCount, blockedCount, errorCode, startedAt, finishedAt == null ? null : new Date(finishedAt)]
  );
}

// 单次调用 = 一次(instrument,horizon,historicalAsOfTime)尝试，镜像生产generateSnapshot()的"一次尝试一行审计"模型；
// 对historical_as_of_time区间的推进循环由调用方(cli-entry.js)负责，本函数不做循环。
// dryRun=true：§4.2冻结要求——完整执行读取+计算逻辑，但replay_snapshots/replay_generation_runs
// 两张表（属于§4.2"五张业务表"零写入范围）一律不落库，返回值形状与正常路径一致，供cli-entry.js
// 输出"执行计划"使用；generationRunId在dry-run下仍会生成（仅用于返回值标识，不写入任何行）。
export async function generateReplaySnapshot({
  pool, validationRunId, instrument, symbol, horizon, historicalAsOfTime, replayNowMs,
  algorithmVersion, weightVersion, datasetVersion, ruleVersion, backfillBatchIds = [], now = Date.now, dryRun = false
}) {
  const generationRunId = randomUUID();
  const startedAt = now();
  if (!dryRun) await recordGenerationRun(pool, { generationRunId, validationRunId, instrument, horizon, historicalAsOfTime, status: 'RUNNING', startedAt, finishedAt: null });

  const blocked = async (errorCode, reasons) => {
    if (!dryRun) await recordGenerationRun(pool, { generationRunId, validationRunId, instrument, horizon, historicalAsOfTime, status: 'BLOCKED', blockedCount: 1, errorCode, startedAt, finishedAt: now() });
    return { status: 'BLOCKED', reason: errorCode, reasons, generationRunId };
  };

  const researchQueryable = createResearchAvailabilityQueryable(pool, { replayNowMs });

  const located = await locateReferenceBarAndPath(researchQueryable, { instrument, horizon, asOfTime: historicalAsOfTime, symbol });
  if (!located.referenceBarRef) return blocked('REFERENCE_BAR_NOT_DUE_OR_MISSING', located.exclusionReasons);

  const atr = await computeFourHourAtr14(researchQueryable, { instrument, asOfTime: historicalAsOfTime });
  if (!atr.ok) return blocked('ATR14_4H_INSUFFICIENT', [atr.reason]);

  let threshold;
  try { threshold = computeDirectionThreshold({ atr14FourHourAtGeneration: atr.atr14FourHourAtGeneration, referencePrice: located.referencePrice, horizon }); }
  catch (error) { return blocked(error.code || 'THRESHOLD_COMPUTATION_FAILED', [error.message]); }

  const featureRow = await findExactFeatureForReplay(pool, { instrument, targetBarCloseTime: located.referenceBarRef.closeTime, historicalAsOfTime });
  if (!featureRow) return blocked('FEATURE_RECORD_MISSING', [`exact feature not ready: ${instrument}/15m/${located.referenceBarRef.closeTime}`]);
  const fv = featureRow.feature_values;

  const [breakoutCount, breakdownCount] = await Promise.all([
    computeConsecutiveBreakoutBars(researchQueryable, { instrument, asOfTime: historicalAsOfTime, direction: 'up' }),
    computeConsecutiveBreakoutBars(researchQueryable, { instrument, asOfTime: historicalAsOfTime, direction: 'down' })
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
  const targetBarRef = located.observedBars.find(b => b.sequenceIndex === located.expectedBarCount) ?? buildProjectedTargetBarRef(symbol, located.referenceBarRef.closeTime, located.expectedBarCount);

  let snapshotInput;
  try {
    snapshotInput = finalizeForecastSnapshot({
      instrument: symbol, horizon, generatedAt: historicalAsOfTime, dataCutoffTime: historicalAsOfTime,
      targetStartTime: located.referenceBarRef.closeTime, targetEndTime: located.referenceBarRef.closeTime + located.expectedBarCount * 900000,
      referencePrice: located.referencePrice, referenceBarRef: located.referenceBarRef, targetBarRef,
      expectedBarCount: located.expectedBarCount, expectedDirection, directionThreshold: threshold.directionThreshold, rawThreshold: threshold.rawThreshold,
      thresholdFloor: threshold.thresholdFloor, thresholdCeiling: threshold.thresholdCeiling, thresholdFormulaVersion: threshold.thresholdFormulaVersion,
      atr14FourHourAtGeneration: atr.atr14FourHourAtGeneration, proxyStateAtGeneration: poResult.proxyState,
      candidateTrajectories: { stateEvidence: poResult.stateEvidence, opposingEvidence: poResult.opposingEvidence, stateConfidence: poResult.stateConfidence, poRuleVersion: poResult.poRuleVersion },
      scenarioWeights: rawScore, expectedPriceZones,
      triggerConditions: buildTriggerConditions(horizon), invalidationConditions: buildInvalidationConditions(horizon),
      dataVintageRefs: [], featureValuesUsed: fv, featureRecordIds: [featureRow.feature_record_id],
      featureEngineVersion: FEATURE_ALGORITHM_VERSION, datasetVersion,
      auxiliaryEvidence: { ...auxiliaryEvidence, auxiliaryConflictNotes },
      algorithmVersion, weightVersion
    });
  } catch (error) { return blocked(error.code || 'FORECAST_CONTRACT_REJECTED', error.reasons || [error.message]); }

  // §一冻结规则1/2：finalizeForecastSnapshot()内部buildPredictionId()硬编码`GMKG-SRV-`前缀（生产格式，不得修改该文件），
  // 回放必须是`GMKG-REPLAY-...-datasetVersion`——此处复用其余全部已校验字段，只重新计算predictionId与
  // 依赖predictionId的contentHash这两项身份字段（computeForecastContentHash同样是直接复用的既有纯函数，非新实现）。
  const predictionId = `GMKG-REPLAY-${symbol}-${horizon}-${located.referenceBarRef.closeTime}-${snapshotInput.algorithmVersion}-${snapshotInput.datasetVersion}`;
  const contentHash = computeForecastContentHash({
    predictionId, featureValuesUsed: snapshotInput.featureValuesUsed, algorithmVersion: snapshotInput.algorithmVersion,
    weightVersion: snapshotInput.weightVersion, datasetVersion: snapshotInput.datasetVersion,
    featureEngineVersion: snapshotInput.featureEngineVersion, scenarioWeights: snapshotInput.scenarioWeights
  });

  const consumedBarRefs = [located.referenceBarRef, targetBarRef, ...located.observedBars];
  const researchDataVintage = buildResearchDataVintage({ barRefs: consumedBarRefs, backfillBatchIds, asOfTime: historicalAsOfTime });
  const primaryBackfillBatchId = backfillBatchIds[0] ?? null;

  if (dryRun) {
    return { status: 'PLANNED', record: { ...snapshotInput, predictionId, contentHash }, generationRunId };
  }

  const insertResult = await pool.query(
    `INSERT INTO historical_validation.replay_snapshots(
       prediction_id,generation_run_id,backfill_batch_id,dataset_version,instrument,horizon,generated_at,data_cutoff_time,
       target_start_time,target_end_time,reference_price,reference_bar_ref,target_bar_ref,expected_bar_count,expected_direction,
       direction_threshold,raw_threshold,threshold_floor,threshold_ceiling,threshold_formula_version,atr14_four_hour_at_generation,
       target_state_at_generation,proxy_state_at_generation,fusion_state_at_generation,candidate_trajectories,
       scenario_weight_baseline,scenario_weight_upside,scenario_weight_downside,probability_status,calibrated_probabilities,
       expected_price_zones,trigger_conditions,invalidation_conditions,algorithm_version,weight_version,rule_version,
       data_vintage_refs,feature_values_used,feature_record_ids,feature_engine_version,content_hash,auxiliary_evidence,
       historical_as_of_time,research_data_vintage,research_availability_rule_version,source_origin
     ) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),to_timestamp($8/1000.0),to_timestamp($9/1000.0),to_timestamp($10/1000.0),
       $11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,'UNKNOWN',$22,'UNKNOWN',$23::jsonb,$24,$25,$26,'rule_based',null,
       $27::jsonb,$28::jsonb,$29::jsonb,$30,$31,$32,$33::jsonb,$34::jsonb,$35::jsonb,$36,$37,$38::jsonb,
       to_timestamp($39/1000.0),$40::jsonb,$41,'HISTORICAL_REPLAY'
     ) ON CONFLICT(prediction_id, research_availability_rule_version) DO NOTHING RETURNING replay_snapshot_id`,
    [
      predictionId, generationRunId, primaryBackfillBatchId, snapshotInput.datasetVersion, symbol, horizon,
      snapshotInput.generatedAt, snapshotInput.dataCutoffTime, snapshotInput.targetStartTime, snapshotInput.targetEndTime,
      snapshotInput.referencePrice, JSON.stringify(snapshotInput.referenceBarRef), JSON.stringify(snapshotInput.targetBarRef),
      snapshotInput.expectedBarCount, snapshotInput.expectedDirection, snapshotInput.directionThreshold, snapshotInput.rawThreshold,
      snapshotInput.thresholdFloor, snapshotInput.thresholdCeiling, snapshotInput.thresholdFormulaVersion, snapshotInput.atr14FourHourAtGeneration,
      snapshotInput.proxyStateAtGeneration, JSON.stringify(snapshotInput.candidateTrajectories),
      snapshotInput.scenarioWeights.baseline, snapshotInput.scenarioWeights.upside, snapshotInput.scenarioWeights.downside,
      JSON.stringify(snapshotInput.expectedPriceZones), JSON.stringify(snapshotInput.triggerConditions), JSON.stringify(snapshotInput.invalidationConditions),
      snapshotInput.algorithmVersion, snapshotInput.weightVersion, ruleVersion, JSON.stringify(snapshotInput.dataVintageRefs),
      JSON.stringify(snapshotInput.featureValuesUsed), JSON.stringify(snapshotInput.featureRecordIds), snapshotInput.featureEngineVersion, contentHash,
      JSON.stringify(snapshotInput.auxiliaryEvidence), historicalAsOfTime, JSON.stringify(researchDataVintage), RESEARCH_AVAILABILITY_RULE_VERSION
    ]
  );

  if (!insertResult.rowCount) {
    const existing = await pool.query(
      'SELECT * FROM historical_validation.replay_snapshots WHERE prediction_id=$1 AND research_availability_rule_version=$2',
      [predictionId, RESEARCH_AVAILABILITY_RULE_VERSION]
    );
    await recordGenerationRun(pool, { generationRunId, validationRunId, instrument, horizon, historicalAsOfTime, status: 'SUCCEEDED', dedupedCount: 1, startedAt, finishedAt: now() });
    return { status: 'DEDUPED', record: existing.rows[0], generationRunId };
  }

  await recordGenerationRun(pool, { generationRunId, validationRunId, instrument, horizon, historicalAsOfTime, status: 'SUCCEEDED', generatedCount: 1, startedAt, finishedAt: now() });
  return { status: 'INSERTED', record: { ...snapshotInput, predictionId, contentHash }, generationRunId };
}
