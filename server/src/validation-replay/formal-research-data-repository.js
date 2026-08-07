// T13 FORMAL research repository. Every row is selected through one immutable
// validation -> generation -> snapshot -> outcome -> evaluation identity chain.
// Database evidence is authoritative; caller-supplied audit claims are never
// accepted as a substitute for persisted manifest, lineage, vintage or status.

const HORIZONS = new Set(['24h', '72h']);
const DIRECTIONS = new Set(['UP', 'DOWN', 'RANGE']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const DATASET_VERSION = /^v1\.4d-sha256-([0-9a-f]{64})$/;
const DISCLOSURE = 'FROZEN_POLICY: researchAvailability(bar)=bar.close_time';

function fail(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function repositoryFailure(error) {
  if (String(error?.code || '').startsWith('FORMAL_RESEARCH_')) return error;
  return fail('FORMAL_RESEARCH_DATABASE_QUERY_FAILED', 'formal research database query failed');
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('FORMAL_RESEARCH_DATABASE_EVIDENCE_INVALID', `${field} must be a database JSON object`);
  }
  return value;
}

function array(value, field, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw fail('FORMAL_RESEARCH_DATABASE_EVIDENCE_INVALID', `${field} must be a database JSON array`);
  }
  return value;
}

function epoch(value, field) {
  const number = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(number)) throw fail('FORMAL_RESEARCH_DATABASE_ROW_INVALID', `${field} must be a finite safe epoch`);
  return number;
}

function bool(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'boolean') throw fail('FORMAL_RESEARCH_DATABASE_ROW_INVALID', `${field} must be boolean${nullable ? ' or null' : ''}`);
  return value;
}

function text(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw fail('FORMAL_RESEARCH_DATABASE_ROW_INVALID', `${field} must be non-empty text`);
  return value;
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function numeric(value, field, { nullable = false } = {}) {
  if (value === null) {
    if (nullable) return null;
    throw fail('FORMAL_RESEARCH_DATABASE_ROW_INVALID', `${field} must not be null`);
  }
  const source = typeof value === 'string' ? value.trim() : String(value);
  if (!DECIMAL.test(source)) throw fail('FORMAL_RESEARCH_DATABASE_ROW_INVALID', `${field} is not a finite decimal`);
  const number = Number(source);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) {
    throw fail('FORMAL_RESEARCH_DATABASE_ROW_INVALID', `${field} is outside the safe numeric range`);
  }
  const coefficient = source.toLowerCase().split('e')[0].replace(/^[+-]/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  if (coefficient.length > 15) {
    throw fail('FORMAL_RESEARCH_DATABASE_NUMERIC_PRECISION_UNSAFE', `${field} exceeds the audited JavaScript precision boundary`);
  }
  return number;
}

function assertVintage(value, field, expectedAsOf, expectedRule) {
  const vintage = object(value, field);
  if (vintage.researchAvailabilityRuleVersion !== expectedRule || !Array.isArray(vintage.consumedBars) ||
      !Array.isArray(vintage.backfillBatchIds) || typeof vintage.disclosure !== 'string' || !vintage.disclosure.includes(DISCLOSURE)) {
    throw fail('FORMAL_RESEARCH_DATABASE_EVIDENCE_INVALID', `${field} authenticity evidence is incomplete`);
  }
  if (epoch(vintage.asOfTime, `${field}.asOfTime`) !== expectedAsOf) {
    throw fail('FORMAL_RESEARCH_DATABASE_TIME_BARRIER_FAILED', `${field} as-of time conflicts with the persisted run`);
  }
  for (const bar of vintage.consumedBars) {
    object(bar, `${field}.consumedBars[]`);
    text(bar.vintageId, `${field}.vintageId`);
    const close = epoch(bar.closeTime, `${field}.closeTime`);
    const available = epoch(bar.availableAt, `${field}.availableAt`);
    epoch(bar.fetchedAt, `${field}.fetchedAt`);
    if (close > expectedAsOf || available > expectedAsOf) {
      throw fail('FORMAL_RESEARCH_DATABASE_TIME_BARRIER_FAILED', `${field} contains future data`);
    }
  }
  return vintage;
}

function validateContextRow(row, validationRunId) {
  if (!row) throw fail('FORMAL_RESEARCH_VALIDATION_RUN_NOT_FOUND', 'validation run not found');
  if (row.validationRunId !== validationRunId || row.validationRunStatus !== 'SUCCEEDED' || row.dryRun !== false) {
    throw fail('FORMAL_RESEARCH_VALIDATION_RUN_NOT_ELIGIBLE', 'validation run must be a persisted SUCCEEDED non-dry-run run');
  }
  const from = epoch(row.fromUtc, 'validation.fromUtc');
  const to = epoch(row.toUtc, 'validation.toUtc');
  const trainEnd = epoch(row.trainEndUtc, 'validation.trainEndUtc');
  const validationEnd = epoch(row.validationEndUtc, 'validation.validationEndUtc');
  const startedAt = epoch(row.validationStartedAt, 'validation.startedAt');
  const finishedAt = epoch(row.validationFinishedAt, 'validation.finishedAt');
  if (!(from < trainEnd && trainEnd < validationEnd && validationEnd < to && startedAt <= finishedAt)) {
    throw fail('FORMAL_RESEARCH_DATABASE_TIME_BARRIER_FAILED', 'validation run boundaries are invalid');
  }
  const match = DATASET_VERSION.exec(row.datasetVersion || '');
  if (!match || row.manifestContentHash !== match[1] || !SHA256.test(row.manifestContentHash || '')) {
    throw fail('FORMAL_RESEARCH_DATABASE_EVIDENCE_INVALID', 'manifest content identity is invalid');
  }
  if (epoch(row.manifestDataFrom, 'manifest.dataFrom') > from || epoch(row.manifestDataTo, 'manifest.dataTo') < to ||
      row.sourceFormalSemantics !== 'market_bars:formal:spot') {
    throw fail('FORMAL_RESEARCH_DATABASE_EVIDENCE_INVALID', 'manifest does not cover the validation window');
  }
  array(row.manifestMembers, 'manifest.manifestMembers', { nonEmpty: true });
  array(row.manifestBackfillBatchIds, 'manifest.backfillBatchIds');
  const integrity = object(row.integrityCheckResult, 'manifest.integrityCheckResult');
  if (!Object.keys(integrity).length || Object.values(integrity).some(entry => !entry || Number(entry.gapCount) !== 0 || Number(entry.duplicateCount) !== 0 || Number(entry.outOfOrderCount) !== 0)) {
    throw fail('FORMAL_RESEARCH_DATABASE_EVIDENCE_INVALID', 'manifest integrity proof is missing or failed');
  }
  const reports = array(row.authenticityReports, 'validation.authenticityReports', { nonEmpty: true });
  const runHorizons = array(row.runHorizons, 'validation.horizons', { nonEmpty: true });
  for (const horizon of runHorizons) {
    if (!HORIZONS.has(horizon)) throw fail('FORMAL_RESEARCH_DATABASE_EVIDENCE_INVALID', 'validation run contains an invalid horizon');
    const report = reports.find(candidate => candidate.horizon === horizon);
    const authenticity = report?.formalProxyDisclosure?.rerunAuthenticity;
    if (!authenticity || authenticity.gate_status !== 'PASSED' || authenticity.conflict_count !== 0 || authenticity.blocked_count !== 0 ||
        authenticity.attempted_count !== authenticity.expected_count || authenticity.evaluated_count !== authenticity.expected_count) {
      throw fail('FORMAL_RESEARCH_DATABASE_AUTHENTICITY_NOT_PROVEN', `authenticity is not proven for ${horizon}`);
    }
  }
  return {
    validationRunId,
    validationRunStatus: 'SUCCEEDED',
    validationRunFinishedAt: new Date(finishedAt).toISOString(),
    from, to, trainEnd, validationEnd, startedAt, finishedAt,
    datasetVersion: row.datasetVersion,
    manifestContentHash: row.manifestContentHash,
    manifestBackfillBatchIds: [...new Set(row.manifestBackfillBatchIds)].sort(),
    manifestMembers: row.manifestMembers,
    researchAvailabilityRuleVersion: row.manifestAvailabilityRuleVersion,
    authenticityReports: reports,
    algorithmVersion: text(row.algorithmVersion, 'validation.algorithmVersion')
  };
}

export async function loadFormalResearchContext(pool, { validationRunId }) {
  if (!pool?.query || !UUID.test(validationRunId || '')) throw fail('FORMAL_RESEARCH_REPOSITORY_INVALID_INPUT', 'a pool and canonical validationRunId are required');
  try {
    const result = await pool.query(
      `SELECT vr.validation_run_id AS "validationRunId", vr.status AS "validationRunStatus", vr.dry_run AS "dryRun",
              vr.dataset_version AS "datasetVersion", vr.algorithm_version AS "algorithmVersion", vr.horizons AS "runHorizons",
              vr.from_utc AS "fromUtc", vr.to_utc AS "toUtc", vr.train_end_utc AS "trainEndUtc",
              vr.validation_end_utc AS "validationEndUtc", vr.started_at AS "validationStartedAt", vr.finished_at AS "validationFinishedAt",
              dm.content_hash AS "manifestContentHash", dm.data_from AS "manifestDataFrom", dm.data_to AS "manifestDataTo",
              dm.source_formal_semantics AS "sourceFormalSemantics", dm.research_availability_rule_version AS "manifestAvailabilityRuleVersion",
              dm.backfill_batch_ids AS "manifestBackfillBatchIds", dm.integrity_check_result AS "integrityCheckResult", dm.manifest_members AS "manifestMembers",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('horizon',r.horizon,'formalProxyDisclosure',r.formal_proxy_disclosure) ORDER BY r.horizon)
                          FROM historical_validation.validation_reports r
                         WHERE r.validation_run_id=vr.validation_run_id AND r.report_scope='ALL'),'[]'::jsonb) AS "authenticityReports"
         FROM historical_validation.validation_runs vr
         JOIN historical_validation.dataset_manifests dm ON dm.dataset_version=vr.dataset_version
        WHERE vr.validation_run_id=$1`,
      [validationRunId]
    );
    if (result.rowCount !== 1) throw fail('FORMAL_RESEARCH_VALIDATION_RUN_NOT_FOUND', 'validation run not found');
    return validateContextRow(result.rows[0], validationRunId);
  } catch (error) {
    throw repositoryFailure(error);
  }
}

function mapRow(row, context) {
  try {
    const horizon = text(row.horizon, 'horizon');
    if (!HORIZONS.has(horizon)) throw fail('FORMAL_RESEARCH_DATABASE_ROW_INVALID', 'horizon is outside the frozen enum');
    const targetStartTime = epoch(row.targetStartTime, 'targetStartTime');
    const targetEndTime = epoch(row.targetEndTime, 'targetEndTime');
    const historicalAsOfTime = epoch(row.snapshotHistoricalAsOfTime, 'snapshotHistoricalAsOfTime');
    const evaluationAsOfTime = epoch(row.evaluationHistoricalAsOfTime, 'evaluationHistoricalAsOfTime');
    const evaluatedAt = epoch(row.evaluatedAt, 'evaluatedAt');
    const generationStartedAt = epoch(row.generationStartedAt, 'generationStartedAt');
    const generationFinishedAt = epoch(row.generationFinishedAt, 'generationFinishedAt');
    const evaluationStartedAt = epoch(row.evaluationStartedAt, 'evaluationStartedAt');
    const evaluationFinishedAt = epoch(row.evaluationFinishedAt, 'evaluationFinishedAt');
    const width = horizon === '24h' ? 86_400_000 : 259_200_000;
    if (targetEndTime - targetStartTime !== width || targetStartTime < context.from || targetEndTime > context.to ||
        historicalAsOfTime !== targetStartTime || evaluationAsOfTime < targetEndTime || evaluationAsOfTime > context.to ||
        epoch(row.outcomeAsOfTime, 'outcomeAsOfTime') !== evaluationAsOfTime ||
        generationStartedAt < context.startedAt || generationFinishedAt > context.finishedAt || generationStartedAt > generationFinishedAt ||
        evaluationStartedAt < context.startedAt || evaluationFinishedAt > context.finishedAt || evaluationStartedAt > evaluatedAt || evaluatedAt > evaluationFinishedAt) {
      throw fail('FORMAL_RESEARCH_DATABASE_TIME_BARRIER_FAILED', 'row violates run, maturity or as-of boundaries');
    }
    if (row.generationStatus !== 'SUCCEEDED' || row.evaluationStatus !== 'SUCCEEDED' || row.sourceOrigin !== 'HISTORICAL_REPLAY' ||
        row.outcomeSourceOrigin !== 'HISTORICAL_REPLAY' || row.datasetVersion !== context.datasetVersion ||
        row.researchAvailabilityRuleVersion !== context.researchAvailabilityRuleVersion) {
      throw fail('FORMAL_RESEARCH_DATABASE_IDENTITY_CHAIN_INVALID', 'row identity/status chain conflicts with the validation run');
    }
    text(row.generationRunId, 'generationRunId');
    text(row.evaluationRunId, 'evaluationRunId');
    const predictedDirection = text(row.predictedDirection, 'predictedDirection');
    const trend = text(row.trend4hAtGeneration, 'trend4hAtGeneration');
    if (!DIRECTIONS.has(predictedDirection) || !DIRECTIONS.has(trend)) throw fail('FORMAL_RESEARCH_DATABASE_ROW_INVALID', 'prediction/trend is outside the frozen enum');
    const directionEligible = bool(row.directionEligibleForStatistics, 'directionEligibleForStatistics');
    const pathEligible = bool(row.pathEligibleForStatistics, 'pathEligibleForStatistics');
    const endpointDataComplete = bool(row.endpointDataComplete, 'endpointDataComplete');
    const pathDataComplete = bool(row.pathDataComplete, 'pathDataComplete');
    const actualDirection = row.actualDirection === null ? null : text(row.actualDirection, 'actualDirection');
    const directionCorrect = bool(row.directionCorrect, 'directionCorrect', { nullable: true });
    const actualReturn = numeric(row.actualReturn, 'actualReturn', { nullable: true });
    if ((directionEligible && (!DIRECTIONS.has(actualDirection) || actualReturn === null || directionCorrect === null)) ||
        (!directionEligible && (actualDirection !== null || actualReturn !== null || directionCorrect !== null))) {
      throw fail('FORMAL_RESEARCH_DATABASE_ROW_INVALID', 'direction nullable contract is violated');
    }
    const mfe = numeric(row.mfe, 'mfe', { nullable: true });
    const mae = numeric(row.mae, 'mae', { nullable: true });
    if ((pathEligible && (mfe === null || mae === null)) || (!pathEligible && (mfe !== null || mae !== null))) {
      throw fail('FORMAL_RESEARCH_DATABASE_ROW_INVALID', 'path nullable contract is violated');
    }
    const featureRecordIds = array(row.featureRecordIds, 'featureRecordIds', { nonEmpty: true });
    const snapshotVintage = assertVintage(row.snapshotResearchDataVintage, 'snapshotResearchDataVintage', historicalAsOfTime, context.researchAvailabilityRuleVersion);
    const outcomeVintage = assertVintage(row.outcomeResearchDataVintage, 'outcomeResearchDataVintage', evaluationAsOfTime, context.researchAvailabilityRuleVersion);
    object(row.featureValuesUsed, 'featureValuesUsed');
    return {
      predictionId: text(row.predictionId, 'predictionId'), horizon, targetStartTime, targetEndTime,
      predictedDirection, expectedDirection: predictedDirection,
      trend4hAtGeneration: trend, trend4hDirection: trend, marketRegime: trend,
      proxyStateAtGeneration: text(row.proxyStateAtGeneration, 'proxyStateAtGeneration'),
      actualDirection, actualReturn, directionCorrect, directionEligibleForStatistics: directionEligible,
      pathEligibleForStatistics: pathEligible, isDirectionSample: directionEligible, isMarketRegimeSample: directionEligible,
      endpointDataComplete, pathDataComplete, mfe, mae,
      generationRunId: row.generationRunId, evaluationRunId: row.evaluationRunId,
      featureRecordIds, snapshotVintage, outcomeVintage
    };
  } catch (error) {
    throw repositoryFailure(error);
  }
}

export async function loadFormalResearchPage(pool, { validationRunId, evaluationVersion, context, limit = 1000, cursor = null }) {
  if (!context || context.validationRunId !== validationRunId || typeof evaluationVersion !== 'string' || !evaluationVersion ||
      !Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw fail('FORMAL_RESEARCH_REPOSITORY_INVALID_INPUT', 'valid context, evaluationVersion and page limit are required');
  }
  const cursorValues = cursor ? [cursor.horizon, new Date(cursor.targetStartTime), cursor.predictionId] : [null, null, null];
  try {
    const result = await pool.query(
      `SELECT s.prediction_id AS "predictionId", s.generation_run_id AS "generationRunId", e.evaluation_run_id AS "evaluationRunId",
              s.dataset_version AS "datasetVersion", s.horizon, s.target_start_time AS "targetStartTime", s.target_end_time AS "targetEndTime",
              s.expected_direction AS "predictedDirection", s.proxy_state_at_generation AS "proxyStateAtGeneration",
              s.feature_values_used->>'trend4h' AS "trend4hAtGeneration", s.feature_values_used AS "featureValuesUsed", s.feature_record_ids AS "featureRecordIds",
              s.historical_as_of_time AS "snapshotHistoricalAsOfTime", s.research_data_vintage AS "snapshotResearchDataVintage",
              s.research_availability_rule_version AS "researchAvailabilityRuleVersion", s.source_origin AS "sourceOrigin",
              g.status AS "generationStatus", g.started_at AS "generationStartedAt", g.finished_at AS "generationFinishedAt",
              er.status AS "evaluationStatus", er.historical_as_of_time AS "evaluationHistoricalAsOfTime",
              er.started_at AS "evaluationStartedAt", er.finished_at AS "evaluationFinishedAt",
              e.evaluated_at AS "evaluatedAt", e.as_of_time AS "outcomeAsOfTime", e.source_origin AS "outcomeSourceOrigin",
              e.actual_direction AS "actualDirection", e.actual_return AS "actualReturn", e.direction_correct AS "directionCorrect",
              e.direction_eligible_for_statistics AS "directionEligibleForStatistics", e.path_eligible_for_statistics AS "pathEligibleForStatistics",
              e.endpoint_data_complete AS "endpointDataComplete", e.path_data_complete AS "pathDataComplete", e.mfe, e.mae,
              e.research_data_vintage AS "outcomeResearchDataVintage"
         FROM historical_validation.validation_runs vr
         JOIN historical_validation.replay_generation_runs g
           ON g.validation_run_id=vr.validation_run_id AND g.status='SUCCEEDED'
         JOIN historical_validation.replay_snapshots s
           ON s.generation_run_id=g.generation_run_id AND s.dataset_version=vr.dataset_version
          AND s.algorithm_version=vr.algorithm_version AND s.historical_as_of_time=g.historical_as_of_time
         JOIN historical_validation.replay_outcome_events e
           ON e.prediction_id=s.prediction_id AND e.research_availability_rule_version=s.research_availability_rule_version
          AND e.evaluation_version=$2
         JOIN historical_validation.replay_evaluation_runs er
           ON er.evaluation_run_id=e.evaluation_run_id AND er.validation_run_id=vr.validation_run_id AND er.status='SUCCEEDED'
          AND er.historical_as_of_time=e.historical_as_of_time
        WHERE vr.validation_run_id=$1 AND vr.status='SUCCEEDED' AND vr.dry_run=false
          AND s.target_start_time>=vr.from_utc AND s.target_end_time<=vr.to_utc
          AND s.historical_as_of_time=s.target_start_time AND s.data_cutoff_time<=s.historical_as_of_time
          AND e.historical_as_of_time>=s.target_end_time AND e.historical_as_of_time<=vr.to_utc
          AND e.as_of_time=e.historical_as_of_time AND e.evaluated_at BETWEEN er.started_at AND er.finished_at
          AND g.started_at>=vr.started_at AND g.finished_at<=vr.finished_at
          AND er.started_at>=vr.started_at AND er.finished_at<=vr.finished_at
          AND ($3::text IS NULL OR (s.horizon,s.target_start_time,s.prediction_id)>($3::text,$4::timestamptz,$5::text))
        ORDER BY s.horizon,s.target_start_time,s.prediction_id
        LIMIT $6`,
      [validationRunId, evaluationVersion, ...cursorValues, limit]
    );
    const rows = result.rows.map(row => mapRow(row, context));
    const last = rows.at(-1);
    return { rows, nextCursor: rows.length === limit ? { horizon: last.horizon, targetStartTime: last.targetStartTime, predictionId: last.predictionId } : null };
  } catch (error) {
    throw repositoryFailure(error);
  }
}

export async function countFormalResearchRows(pool, { validationRunId, evaluationVersion }) {
  if (!pool?.query || !UUID.test(validationRunId || '') || typeof evaluationVersion !== 'string' || !evaluationVersion) {
    throw fail('FORMAL_RESEARCH_REPOSITORY_INVALID_INPUT', 'pool, validationRunId and evaluationVersion are required');
  }
  try {
    const result = await pool.query(
      `SELECT count(*)::text AS count
         FROM historical_validation.validation_runs vr
         JOIN historical_validation.replay_generation_runs g ON g.validation_run_id=vr.validation_run_id AND g.status='SUCCEEDED'
         JOIN historical_validation.replay_snapshots s ON s.generation_run_id=g.generation_run_id AND s.dataset_version=vr.dataset_version
          AND s.algorithm_version=vr.algorithm_version AND s.historical_as_of_time=g.historical_as_of_time
         JOIN historical_validation.replay_outcome_events e ON e.prediction_id=s.prediction_id
          AND e.research_availability_rule_version=s.research_availability_rule_version AND e.evaluation_version=$2
         JOIN historical_validation.replay_evaluation_runs er ON er.evaluation_run_id=e.evaluation_run_id
          AND er.validation_run_id=vr.validation_run_id AND er.status='SUCCEEDED' AND er.historical_as_of_time=e.historical_as_of_time
        WHERE vr.validation_run_id=$1 AND vr.status='SUCCEEDED' AND vr.dry_run=false
          AND s.target_start_time>=vr.from_utc AND s.target_end_time<=vr.to_utc
          AND s.historical_as_of_time=s.target_start_time AND s.data_cutoff_time<=s.historical_as_of_time
          AND e.historical_as_of_time>=s.target_end_time AND e.historical_as_of_time<=vr.to_utc
          AND e.as_of_time=e.historical_as_of_time AND e.evaluated_at BETWEEN er.started_at AND er.finished_at
          AND g.started_at>=vr.started_at AND g.finished_at<=vr.finished_at
          AND er.started_at>=vr.started_at AND er.finished_at<=vr.finished_at`,
      [validationRunId, evaluationVersion]
    );
    const count = Number(result.rows?.[0]?.count);
    if (!Number.isSafeInteger(count) || count < 0) throw fail('FORMAL_RESEARCH_DATABASE_ROW_INVALID', 'row count is invalid');
    return count;
  } catch (error) {
    throw repositoryFailure(error);
  }
}

export function deriveFormalResearchAuditTrail({ context, rows, validationRunId, evaluationVersion }) {
  if (!context || !Array.isArray(rows) || !rows.length) throw fail('FORMAL_RESEARCH_NO_ELIGIBLE_ROWS', 'validation run contains no eligible persisted FORMAL rows');
  const vintageIds = [...new Set(rows.flatMap(row => [...row.snapshotVintage.consumedBars, ...row.outcomeVintage.consumedBars].map(bar => bar.vintageId)))].sort();
  const featureIds = new Set(rows.flatMap(row => row.featureRecordIds.map(String)));
  const generationRuns = new Set(rows.map(row => row.generationRunId));
  const evaluationRuns = new Set(rows.map(row => row.evaluationRunId));
  const authenticityRows = context.authenticityReports.map(report => ({
    horizon: report.horizon, proof: report.formalProxyDisclosure.rerunAuthenticity
  }));
  for (const { horizon, proof } of authenticityRows) {
    if (rows.filter(row => row.horizon === horizon).length !== proof.expected_count) {
      throw fail('FORMAL_RESEARCH_DATABASE_AUTHENTICITY_NOT_PROVEN', 'persisted row count conflicts with authenticity evidence');
    }
  }
  const authenticity = authenticityRows.reduce((sum, { proof }) => ({
    expected_count: sum.expected_count + proof.expected_count,
    attempted_count: sum.attempted_count + proof.attempted_count,
    inserted_count: sum.inserted_count + proof.inserted_count,
    reused_identical_count: sum.reused_identical_count + proof.reused_identical_count,
    conflict_count: sum.conflict_count + proof.conflict_count,
    blocked_count: sum.blocked_count + proof.blocked_count,
    evaluated_count: sum.evaluated_count + proof.evaluated_count
  }), { expected_count: 0, attempted_count: 0, inserted_count: 0, reused_identical_count: 0, conflict_count: 0, blocked_count: 0, evaluated_count: 0 });
  const auditTrail = {
    schemaVersion: 'v1.4d-audit-trail/1', validationRunId, evaluationVersion,
    evaluatedAt: context.validationRunFinishedAt, validationRunStatus: 'SUCCEEDED', authenticityGateStatus: 'PASSED',
    manifestCoverage: 1, featureCoverage: featureIds.size > 0 && rows.every(row => row.featureRecordIds.length > 0) ? 1 : 0,
    datasetVersion: context.datasetVersion, manifestContentHash: context.manifestContentHash,
    backfillBatchIds: context.manifestBackfillBatchIds, vintageIds,
    generationSummary: {
      expected: authenticity.expected_count, attempted: authenticity.attempted_count,
      inserted: authenticity.inserted_count, reusedIdentical: authenticity.reused_identical_count,
      conflicts: authenticity.conflict_count, blocked: authenticity.blocked_count, evaluated: authenticity.evaluated_count
    }
  };
  if (auditTrail.featureCoverage !== 1 || generationRuns.size === 0 || evaluationRuns.size === 0) {
    throw fail('FORMAL_RESEARCH_DATABASE_AUTHENTICITY_NOT_PROVEN', 'feature/run lineage is incomplete');
  }
  return auditTrail;
}

export async function loadFormalResearchDataset(pool, { validationRunId, evaluationVersion, pageSize = 1000 }) {
  const context = await loadFormalResearchContext(pool, { validationRunId });
  const rows = [];
  let cursor = null;
  do {
    const page = await loadFormalResearchPage(pool, { validationRunId, evaluationVersion, context, limit: pageSize, cursor });
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor);
  const auditTrail = deriveFormalResearchAuditTrail({ context, rows, validationRunId, evaluationVersion });
  return { context, rows, auditTrail };
}

export async function loadFormalResearchRows(pool, options) {
  return (await loadFormalResearchDataset(pool, options)).rows;
}
