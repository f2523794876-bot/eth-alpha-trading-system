// V1_4D_HISTORICAL_REPLAY_SPEC.md §四：`npm run validation:walk-forward` 统一CLI入口。
// 编排（不重新实现业务逻辑）：dataset-manifest-verifier.js（§4.1a八步校验，先于一切推进/写入）→
// bar-path-locator.js的computeAlignedReferenceCloseTime/rhythmBoundaryMs（asOfTime推进节奏）→
// replay-generator.js/replay-evaluator.js（逐点生成/评估）→ report-builder.js（最终统计报告）。
// 全部数据库写入面向historical_validation schema，不获取/续租/释放任何生产collector_leases，
// 不调用ForecastGenerator/OutcomeEvaluator的executeRunOnce()等生产入口（§4.6红线）。

import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createPgPool } from '../db/postgres.js';
import { parseUtc } from '../backfill/backfill-cli-entry.js';
import { rhythmBoundaryMs, computeAlignedReferenceCloseTime } from '../forecast/bar-path-locator.js';
import { verifyDatasetManifest } from './dataset-manifest-verifier.js';
import { generateReplaySnapshot } from './replay-generator.js';
import { evaluateReplayOutcomes } from './replay-evaluator.js';
import { buildValidationReports } from './report-builder.js';
import { RESEARCH_AVAILABILITY_RULE_VERSION } from './research-availability.js';

const DAY_MS = 86400000;
const HORIZONS = Object.freeze(['24h', '72h']);

export const STARTUP_BANNER = `================================================================
  HISTORICAL RESEARCH ONLY — 本次运行为历史研究回放
  写入目标：historical_validation schema（与生产数据完全隔离）
  不产出交易信号、不代表当前市场状态、不得用于实盘决策
================================================================`;

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      args[key] = value;
      if (value !== true) i += 1;
    }
  }
  return args;
}

// --split <train%/validation%/test%>，三者必须为正整数且和恰好100（§1.0冻结默认值50/25/25即以此格式传入）。
export function parseSplitRatio(value) {
  const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(String(value ?? ''));
  if (!match) throw Object.assign(new Error(`--split must be in the form train%/validation%/test%, got: ${value}`), { code: 'INVALID_SPLIT_FORMAT' });
  const [, trainPct, validationPct, testPct] = match.map(Number);
  if (trainPct + validationPct + testPct !== 100) {
    throw Object.assign(new Error(`--split percentages must sum to 100, got: ${trainPct}+${validationPct}+${testPct}`), { code: 'INVALID_SPLIT_FORMAT' });
  }
  return { trainPct, validationPct, testPct };
}

// §1.0：按--from~--to总日历天数比例计算，四舍五入到整数天。
export function computeSplitBoundaries({ from, to, splitRatio }) {
  const totalDays = Math.round((to - from) / DAY_MS);
  const trainDays = Math.round(totalDays * (splitRatio.trainPct / 100));
  const validationDays = Math.round(totalDays * (splitRatio.validationPct / 100));
  const trainEnd = from + trainDays * DAY_MS;
  const validationEnd = trainEnd + validationDays * DAY_MS;
  return { trainEnd, validationEnd };
}

// §4.1参数顺序校验：from < trainEnd < validationEnd < to，严格小于，不允许相等或颠倒。
export function validateSplitOrder({ from, to, trainEnd, validationEnd }) {
  if (trainEnd == null && validationEnd == null) return;
  if (!(from < trainEnd && trainEnd < validationEnd && validationEnd < to)) {
    throw Object.assign(new Error('Split boundaries must satisfy from < trainEnd < validationEnd < to'), { code: 'INVALID_SPLIT_ORDER' });
  }
}

// §4.3红线：--to必须早于"现在减去最长horizon窗口长度(72h)"，否则会对未成熟数据做"未来路径"评估。
export function validateReplayRange({ to, nowMs }) {
  const maxHorizonMs = 3 * DAY_MS; // 72h
  if (!(to <= nowMs - maxHorizonMs)) {
    throw Object.assign(new Error('--to must be earlier than (current real UTC time - max horizon window)'), { code: 'INVALID_REPLAY_RANGE' });
  }
}

// §4.4红线：--resume时，命令行显式传入且与原run记录不一致的参数一律拒绝；省略的参数视为沿用原run。
const RESUMABLE_PARAM_KEYS = Object.freeze(['symbol', 'algorithmVersion', 'datasetVersion', 'ruleVersion', 'fromUtc', 'toUtc', 'trainEndUtc', 'validationEndUtc']);
export function checkResumeParamConsistency({ explicitParams, originalRun }) {
  const mismatches = [];
  for (const key of RESUMABLE_PARAM_KEYS) {
    if (!(key in explicitParams)) continue;
    if (explicitParams[key] !== originalRun[key]) mismatches.push({ key, explicit: explicitParams[key], original: originalRun[key] });
  }
  if (mismatches.length) throw Object.assign(new Error(`Resume parameter mismatch: ${JSON.stringify(mismatches)}`), { code: 'RESUME_PARAM_MISMATCH', mismatches });
}

function toEpochMs(value) {
  return value == null ? null : (value instanceof Date ? value.getTime() : new Date(value).getTime());
}

async function loadValidationRun(pool, validationRunId) {
  const result = await pool.query('SELECT * FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId]);
  return result.rows[0] || null;
}

// 生成该horizon在[from,to)范围内、按节奏边界推进的全部候选historicalAsOfTime（=alignedCloseTime本身）。
export function enumerateRhythmPoints({ from, to, horizon }) {
  const boundary = rhythmBoundaryMs(horizon);
  const points = [];
  let candidate = computeAlignedReferenceCloseTime(from, horizon);
  if (candidate < from) candidate += boundary;
  for (; candidate < to; candidate += boundary) points.push(candidate);
  return points;
}

// §4.1a八步强制校验入口——供main()调用，resume/dry-run场景下必须【重新完整执行】，不得跳过（第7/8步）。
async function runManifestGate({ pool, datasetVersion }) {
  const verification = await verifyDatasetManifest({ pool, datasetVersion, currentResearchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION });
  if (!verification.ok) {
    throw Object.assign(new Error(`Dataset manifest verification failed: ${verification.errorCode}`), { code: verification.errorCode, details: verification });
  }
  return verification;
}

export async function runWalkForward(options) {
  const {
    pool, symbol, from, to, horizons, algorithmVersion, datasetVersion, ruleVersion,
    trainEnd = null, validationEnd = null, dryRun = false, resumeValidationRunId = null,
    evaluationVersion, nowMs = Date.now(), replayNowMs = nowMs
  } = options;

  console.info(STARTUP_BANNER);

  validateReplayRange({ to, nowMs });
  validateSplitOrder({ from, to, trainEnd, validationEnd });

  let validationRunId;
  let originalRun = null;
  if (resumeValidationRunId) {
    originalRun = await loadValidationRun(pool, resumeValidationRunId);
    if (!originalRun) throw Object.assign(new Error(`validation_run not found: ${resumeValidationRunId}`), { code: 'VALIDATION_RUN_NOT_FOUND' });
    checkResumeParamConsistency({
      explicitParams: options.explicitParams || {},
      originalRun: {
        symbol: originalRun.symbol, algorithmVersion: originalRun.algorithm_version, datasetVersion: originalRun.dataset_version,
        ruleVersion: originalRun.rule_version, fromUtc: toEpochMs(originalRun.from_utc), toUtc: toEpochMs(originalRun.to_utc),
        trainEndUtc: toEpochMs(originalRun.train_end_utc), validationEndUtc: toEpochMs(originalRun.validation_end_utc)
      }
    });
    validationRunId = resumeValidationRunId;
  } else {
    validationRunId = randomUUID();
  }

  // §4.1a：无论dry-run/resume与否，必须先完整校验通过才允许进入推进循环。
  // resume场景：validation_runs行已存在（源自首次尝试），校验失败必须把该行标记FAILED（§4.1a红线："不得把
  // validation_runs本次尝试标记为除FAILED外的任何终态"）——不能让它停留在RUNNING或旧状态不动。
  // 新建场景：validation_runs.dataset_version有外键约束指向dataset_manifests(dataset_version)，若
  // dataset_version根本不存在（DATASET_MANIFEST_NOT_FOUND），物理上不可能插入引用它的行——这是比"插入后
  // 标记FAILED"更强的保证（数据库结构层面直接排除了该情形），故新建场景下manifest gate失败时不创建任何行。
  try {
    await runManifestGate({ pool, datasetVersion });
  } catch (error) {
    if (resumeValidationRunId) {
      await pool.query(
        `UPDATE historical_validation.validation_runs SET status='FAILED', error_code=$2, finished_at=now() WHERE validation_run_id=$1`,
        [resumeValidationRunId, error.code || 'MANIFEST_VERIFICATION_FAILED']
      );
    }
    throw error;
  }

  if (!resumeValidationRunId && !dryRun) {
    await pool.query(
      `INSERT INTO historical_validation.validation_runs(
         validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version,
         train_end_utc, validation_end_utc, dry_run, status, started_at
       ) VALUES($1,$2,$3,$4::jsonb,to_timestamp($5/1000.0),to_timestamp($6/1000.0),$7,$8,
         ${trainEnd != null ? 'to_timestamp($9/1000.0)' : 'null'},${validationEnd != null ? 'to_timestamp($10/1000.0)' : 'null'},false,'RUNNING',now())`,
      trainEnd != null
        ? [validationRunId, datasetVersion, symbol, JSON.stringify(horizons), from, to, algorithmVersion, ruleVersion, trainEnd, validationEnd]
        : [validationRunId, datasetVersion, symbol, JSON.stringify(horizons), from, to, algorithmVersion, ruleVersion]
    );
  } else if (!resumeValidationRunId && dryRun) {
    // §4.2：validation_runs本身允许dry-run写入一行审计记录（不是业务数据，是"跑过一次dry-run"的事实）。
    await pool.query(
      `INSERT INTO historical_validation.validation_runs(
         validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, dry_run, status, started_at, finished_at
       ) VALUES($1,$2,$3,$4::jsonb,to_timestamp($5/1000.0),to_timestamp($6/1000.0),$7,$8,true,'SUCCEEDED',now(),now())`,
      [validationRunId, datasetVersion, symbol, JSON.stringify(horizons), from, to, algorithmVersion, ruleVersion]
    );
  }

  const instrument = symbol === 'ETH' ? 'ETHUSDT' : symbol;
  const plan = { validationRunId, dryRun, generationAttempts: 0, evaluationSweeps: 0, results: [] };

  for (const horizon of horizons) {
    const points = enumerateRhythmPoints({ from, to, horizon });
    plan.generationAttempts += points.length;
    if (dryRun) continue; // §4.2：dry-run只输出执行计划(节奏点数量)，不实际调用生成/评估逻辑对业务表产生任何写入意图

    for (const historicalAsOfTime of points) {
      const generation = await generateReplaySnapshot({
        pool, validationRunId, instrument, symbol, horizon, historicalAsOfTime, replayNowMs,
        algorithmVersion, weightVersion: options.weightVersion, datasetVersion, ruleVersion,
        backfillBatchIds: options.backfillBatchIds || []
      });
      plan.results.push({ horizon, historicalAsOfTime, phase: 'generation', status: generation.status });

      const evaluation = await evaluateReplayOutcomes({ pool, validationRunId, evaluationVersion, historicalAsOfTime, replayNowMs });
      plan.evaluationSweeps += 1;
      plan.results.push({ horizon, historicalAsOfTime, phase: 'evaluation', evaluated: evaluation.evaluated, deduped: evaluation.deduped });
    }
  }

  if (!dryRun) {
    plan.reports = await buildValidationReports({
      pool, validationRunId, datasetVersion, algorithmVersion, ruleVersion,
      researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion, trainEnd, validationEnd
    });
    await pool.query(`UPDATE historical_validation.validation_runs SET status='SUCCEEDED', finished_at=now() WHERE validation_run_id=$1`, [validationRunId]);
  }

  return plan;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const from = parseUtc(args.from, '--from');
  const to = parseUtc(args.to, '--to');
  const horizons = String(args.horizons || '24h,72h').split(',').map(s => s.trim()).filter(Boolean);
  for (const h of horizons) if (!HORIZONS.includes(h)) throw Object.assign(new Error(`Invalid horizon: ${h}`), { code: 'INVALID_HORIZON' });

  if (args.split && (args['train-end'] || args['validation-end'])) {
    throw Object.assign(new Error('--split and --train-end/--validation-end are mutually exclusive'), { code: 'CONFLICTING_SPLIT_PARAMS' });
  }
  let trainEnd = null, validationEnd = null;
  if (args.split) {
    ({ trainEnd, validationEnd } = computeSplitBoundaries({ from, to, splitRatio: parseSplitRatio(args.split) }));
  } else if (args['train-end'] || args['validation-end']) {
    trainEnd = parseUtc(args['train-end'], '--train-end');
    validationEnd = parseUtc(args['validation-end'], '--validation-end');
  }

  const explicitParams = {};
  if (args.symbol) explicitParams.symbol = args.symbol;
  if (args['algorithm-version']) explicitParams.algorithmVersion = args['algorithm-version'];
  if (args['dataset-version']) explicitParams.datasetVersion = args['dataset-version'];
  if (args['rule-version']) explicitParams.ruleVersion = args['rule-version'];
  if (args.from) explicitParams.fromUtc = from;
  if (args.to) explicitParams.toUtc = to;
  if (args['train-end']) explicitParams.trainEndUtc = trainEnd;
  if (args['validation-end']) explicitParams.validationEndUtc = validationEnd;

  const config = loadConfig();
  const pool = await createPgPool(config);
  try {
    const plan = await runWalkForward({
      pool, symbol: args.symbol || 'ETHUSDT', from, to, horizons,
      algorithmVersion: args['algorithm-version'], datasetVersion: args['dataset-version'], ruleVersion: args['rule-version'],
      weightVersion: args['weight-version'], evaluationVersion: args['evaluation-version'],
      trainEnd, validationEnd, dryRun: Boolean(args['dry-run']), resumeValidationRunId: args.resume || null,
      explicitParams
    });
    console.info('validation_run_id', plan.validationRunId);
    return plan;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error('validation:walk-forward failed', { code: error.code || error.message }); process.exitCode = 1; });
}
