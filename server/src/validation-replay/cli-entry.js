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
// horizons为数组，其余为标量——比较逻辑不同，故不能对所有key一律用!==。
const RESUMABLE_SCALAR_KEYS = Object.freeze(['symbol', 'algorithmVersion', 'datasetVersion', 'ruleVersion', 'fromUtc', 'toUtc', 'trainEndUtc', 'validationEndUtc']);

function horizonsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function checkResumeParamConsistency({ explicitParams, originalRun }) {
  const mismatches = [];
  for (const key of RESUMABLE_SCALAR_KEYS) {
    if (!(key in explicitParams)) continue;
    if (explicitParams[key] !== originalRun[key]) mismatches.push({ key, explicit: explicitParams[key], original: originalRun[key] });
  }
  if ('horizons' in explicitParams && !horizonsEqual(explicitParams.horizons, originalRun.horizons)) {
    mismatches.push({ key: 'horizons', explicit: explicitParams.horizons, original: originalRun.horizons });
  }
  if (mismatches.length) throw Object.assign(new Error(`Resume parameter mismatch: ${JSON.stringify(mismatches)}`), { code: 'RESUME_PARAM_MISMATCH', mismatches });
}

// §4.1/§4.4冻结CLI契约要求的必填参数（resume模式下改为「必须能从原run合并得到」，见buildEffectiveOptions）。
// weightVersion/evaluationVersion不出现在validation_runs表结构（§2.1）也不出现在§4.4resume比对清单中——
// 二者不是可恢复的run身份字段，本模块因此要求二者在new-task与resume两种模式下都必须显式提供，
// 不做任何形式的"从原run继承"（既无处继承，也不属于frozen §4.4定义的resume契约范围）。
const REQUIRED_EFFECTIVE_FIELDS = Object.freeze([
  ['symbol', 'symbol'], ['from', 'from'], ['to', 'to'], ['horizons', 'horizons'],
  ['algorithmVersion', 'algorithmVersion'], ['datasetVersion', 'datasetVersion'], ['ruleVersion', 'ruleVersion'],
  ['weightVersion', 'weightVersion'], ['evaluationVersion', 'evaluationVersion']
]);

// 任何生成/写入/长任务开始前的最终fail-closed校验入口——无论new-task还是resume（resume先经
// buildEffectiveOptions合并原run参数得到effective，再送入本函数），都必须先完整通过本函数才允许继续。
// 不得依赖DB NOT NULL/FK报错来发现同类问题（那样意味着已经尝试了写入/查询，不是"生成前"校验）。
export function validateEffectiveOptions(effective) {
  const missing = [];
  for (const [key, label] of REQUIRED_EFFECTIVE_FIELDS) {
    const value = effective[key];
    if (key === 'horizons') {
      if (!Array.isArray(value) || value.length === 0) missing.push(label);
      continue;
    }
    if (key === 'from' || key === 'to') {
      if (!Number.isFinite(value)) missing.push(label);
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') missing.push(label);
  }
  if (missing.length) {
    throw Object.assign(new Error(`Missing or invalid required parameter(s): ${missing.join(', ')}`), { code: 'MISSING_REQUIRED_PARAM', missing });
  }
  for (const h of effective.horizons) {
    if (!HORIZONS.includes(h)) throw Object.assign(new Error(`Invalid horizon: ${h}`), { code: 'INVALID_HORIZON' });
  }
  if (!(effective.from < effective.to)) {
    throw Object.assign(new Error('--from must be strictly earlier than --to'), { code: 'INVALID_TIME_ORDER' });
  }
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

// P2-6（独立复审）：validation_runs.resumed_from_run_id（迁移005，nullable自引用FK）核对结论——本实现
// 从不写入该列（永远保持NULL），这是刻意的，不是遗漏：
// - V1_4D_HISTORICAL_REPLAY_SPEC.md §4.4冻结红线明确规定"resume后仍使用原validation_run_id"（本模块
//   buildEffectiveOptions下方对resume分支的`validationRunId = resumeValidationRunId`即是该红线的实现）——
//   resume从不创建一条指向"原run"的新validation_runs行，从头到尾只有【同一个】validation_run_id、
//   【同一条】validation_runs行被反复UPDATE(status/error_code/finished_at)，不存在"新行需要通过
//   resumed_from_run_id指回旧行"这个场景，该列因此结构性没有可写入的时机。
// - 该列本身的引入依据（§2.1"外键"一栏："resumed_from_run_id→validation_runs.validation_run_id
//   （nullable，自引用，记录resume链）"）与§三.0建表顺序说明（"自引用resumed_from_run_id可延后加约束"）
//   合读，说明规范作者本身也是把它当作【面向未来、尚未定案】的预留字段处理，并未在§4.4定稿的"同ID复用"
//   resume模型之上给出一套"何时产生新行、新行如何回指旧行"的具体规则——即规范正文里两处对该列的表述
//   本身就存在"是否应该有新行"的语义张力，本轮不擅自解决这个张力（不属于P1-3/P1-4明确要求的范围），
//   也不采用"总之写点什么"的权宜做法。
// - 因此本轮维持现状：resumed_from_run_id列结构性保留（迁移005已建表，不属于本轮可修改的边界），
//   语义上"尚未被任何写路径使用"，如未来规范修订为resume产生新validation_run_id，才需要在此处补写。
//   不擅自改变现有"resume复用同一run_id"的run身份模型去凑这一列的用途。
//
// P1-3修复（独立复审）：--resume时构造"effective options"——显式提供的参数经checkResumeParamConsistency
// 校验必须与原run一致，省略的参数【实际从原run继承其值】（此前的实现只做一致性检查，从未把originalRun的值
// 真正回填进后续使用的options，导致最小形式`--resume <id>`单独使用时symbol/from/to/algorithmVersion/
// datasetVersion/ruleVersion/horizons/trainEnd/validationEnd全部退回调用方默认值而非原run实际值）。
// splitRatio（--split）特殊处理：它本身不是可比较的标量——先用effective.from/effective.to（可能同样来自
// 继承）算出对应的trainEnd/validationEnd，再并入下面的一致性比对，等价于"显式传入了计算后的--train-end/
// --validation-end"，与原run存储的train_end_utc/validation_end_utc比对/继承逻辑完全复用，不需要另一套判据。
async function buildEffectiveOptions({ pool, resumeValidationRunId, explicitParams, splitRatio, weightVersion, evaluationVersion }) {
  if (!resumeValidationRunId) {
    const effective = {
      symbol: explicitParams.symbol, from: explicitParams.fromUtc, to: explicitParams.toUtc, horizons: explicitParams.horizons,
      algorithmVersion: explicitParams.algorithmVersion, datasetVersion: explicitParams.datasetVersion, ruleVersion: explicitParams.ruleVersion,
      trainEnd: explicitParams.trainEndUtc ?? null, validationEnd: explicitParams.validationEndUtc ?? null,
      weightVersion, evaluationVersion
    };
    if (splitRatio && Number.isFinite(effective.from) && Number.isFinite(effective.to)) {
      const boundaries = computeSplitBoundaries({ from: effective.from, to: effective.to, splitRatio });
      effective.trainEnd = boundaries.trainEnd;
      effective.validationEnd = boundaries.validationEnd;
    }
    return { effective, originalRun: null, validationRunId: randomUUID() };
  }

  const originalRun = await loadValidationRun(pool, resumeValidationRunId);
  if (!originalRun) throw Object.assign(new Error(`validation_run not found: ${resumeValidationRunId}`), { code: 'VALIDATION_RUN_NOT_FOUND' });

  const originalEffective = {
    symbol: originalRun.symbol, horizons: originalRun.horizons,
    fromUtc: toEpochMs(originalRun.from_utc), toUtc: toEpochMs(originalRun.to_utc),
    algorithmVersion: originalRun.algorithm_version, datasetVersion: originalRun.dataset_version, ruleVersion: originalRun.rule_version,
    trainEndUtc: toEpochMs(originalRun.train_end_utc), validationEndUtc: toEpochMs(originalRun.validation_end_utc)
  };

  const mergedFrom = 'fromUtc' in explicitParams ? explicitParams.fromUtc : originalEffective.fromUtc;
  const mergedTo = 'toUtc' in explicitParams ? explicitParams.toUtc : originalEffective.toUtc;

  const fullExplicitParams = { ...explicitParams };
  if (splitRatio && Number.isFinite(mergedFrom) && Number.isFinite(mergedTo)) {
    const boundaries = computeSplitBoundaries({ from: mergedFrom, to: mergedTo, splitRatio });
    fullExplicitParams.trainEndUtc = boundaries.trainEnd;
    fullExplicitParams.validationEndUtc = boundaries.validationEnd;
  }

  checkResumeParamConsistency({ explicitParams: fullExplicitParams, originalRun: originalEffective });

  const effective = {
    symbol: 'symbol' in fullExplicitParams ? fullExplicitParams.symbol : originalEffective.symbol,
    horizons: 'horizons' in fullExplicitParams ? fullExplicitParams.horizons : originalEffective.horizons,
    from: mergedFrom, to: mergedTo,
    algorithmVersion: 'algorithmVersion' in fullExplicitParams ? fullExplicitParams.algorithmVersion : originalEffective.algorithmVersion,
    datasetVersion: 'datasetVersion' in fullExplicitParams ? fullExplicitParams.datasetVersion : originalEffective.datasetVersion,
    ruleVersion: 'ruleVersion' in fullExplicitParams ? fullExplicitParams.ruleVersion : originalEffective.ruleVersion,
    trainEnd: 'trainEndUtc' in fullExplicitParams ? fullExplicitParams.trainEndUtc : originalEffective.trainEndUtc,
    validationEnd: 'validationEndUtc' in fullExplicitParams ? fullExplicitParams.validationEndUtc : originalEffective.validationEndUtc,
    weightVersion, evaluationVersion
  };
  return { effective, originalRun, validationRunId: resumeValidationRunId };
}

export async function runWalkForward(options) {
  const {
    pool, dryRun = false, resumeValidationRunId = null, explicitParams = {}, splitRatio = null,
    weightVersion, evaluationVersion, nowMs = Date.now(), replayNowMs = nowMs
  } = options;

  // 向后兼容直接调用runWalkForward()（不经main()）的既有调用方/测试：若未传explicitParams，
  // 从顶层options字段合成——顶层字段本身即视为"本次显式提供"（因为直接调用方就是在明确声明这些值）。
  const effectiveExplicitParams = Object.keys(explicitParams).length
    ? explicitParams
    : {
        ...(options.symbol !== undefined ? { symbol: options.symbol } : {}),
        ...(options.horizons !== undefined ? { horizons: options.horizons } : {}),
        ...(options.from !== undefined ? { fromUtc: options.from } : {}),
        ...(options.to !== undefined ? { toUtc: options.to } : {}),
        ...(options.algorithmVersion !== undefined ? { algorithmVersion: options.algorithmVersion } : {}),
        ...(options.datasetVersion !== undefined ? { datasetVersion: options.datasetVersion } : {}),
        ...(options.ruleVersion !== undefined ? { ruleVersion: options.ruleVersion } : {}),
        ...(options.trainEnd !== undefined && options.trainEnd !== null ? { trainEndUtc: options.trainEnd } : {}),
        ...(options.validationEnd !== undefined && options.validationEnd !== null ? { validationEndUtc: options.validationEnd } : {})
      };

  const { effective, validationRunId } = await buildEffectiveOptions({
    pool, resumeValidationRunId, explicitParams: effectiveExplicitParams, splitRatio, weightVersion, evaluationVersion
  });

  // P1-4修复（独立复审）：resume模式下effective options已完成"加载并合并原run参数"，此处对合并后的
  // 最终值做完整fail-closed校验；new-task模式下effective options即为本次显式传入的原值。
  // 无论哪种模式，本校验都严格发生在§4.1a manifest gate、任何INSERT、historical_as_of_time推进循环之前。
  validateEffectiveOptions(effective);
  validateReplayRange({ to: effective.to, nowMs });
  validateSplitOrder({ from: effective.from, to: effective.to, trainEnd: effective.trainEnd, validationEnd: effective.validationEnd });

  // §4.1a：无论dry-run/resume与否，必须先完整校验通过才允许进入推进循环。
  // resume场景：validation_runs行已存在（源自首次尝试），校验失败必须把该行标记FAILED（§4.1a红线："不得把
  // validation_runs本次尝试标记为除FAILED外的任何终态"）——不能让它停留在RUNNING或旧状态不动。
  // 新建场景：validation_runs.dataset_version有外键约束指向dataset_manifests(dataset_version)，若
  // dataset_version根本不存在（DATASET_MANIFEST_NOT_FOUND），物理上不可能插入引用它的行——这是比"插入后
  // 标记FAILED"更强的保证（数据库结构层面直接排除了该情形），故新建场景下manifest gate失败时不创建任何行。
  try {
    await runManifestGate({ pool, datasetVersion: effective.datasetVersion });
  } catch (error) {
    if (resumeValidationRunId) {
      await pool.query(
        `UPDATE historical_validation.validation_runs SET status='FAILED', error_code=$2, finished_at=now() WHERE validation_run_id=$1`,
        [resumeValidationRunId, error.code || 'MANIFEST_VERIFICATION_FAILED']
      );
    }
    throw error;
  }

  const { symbol, from, to, horizons, algorithmVersion, datasetVersion, ruleVersion, trainEnd, validationEnd } = effective;

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
        algorithmVersion, weightVersion: effective.weightVersion, datasetVersion, ruleVersion,
        backfillBatchIds: options.backfillBatchIds || []
      });
      plan.results.push({ horizon, historicalAsOfTime, phase: 'generation', status: generation.status });

      const evaluation = await evaluateReplayOutcomes({ pool, validationRunId, evaluationVersion: effective.evaluationVersion, historicalAsOfTime, replayNowMs });
      plan.evaluationSweeps += 1;
      plan.results.push({ horizon, historicalAsOfTime, phase: 'evaluation', evaluated: evaluation.evaluated, deduped: evaluation.deduped });
    }
  }

  if (!dryRun) {
    plan.reports = await buildValidationReports({
      pool, validationRunId, datasetVersion, algorithmVersion, ruleVersion,
      researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion: effective.evaluationVersion, trainEnd, validationEnd
    });
    await pool.query(`UPDATE historical_validation.validation_runs SET status='SUCCEEDED', finished_at=now() WHERE validation_run_id=$1`, [validationRunId]);
  }

  return plan;
}

// P1-4修复（独立复审）：main()级别的快速fail-closed前置校验——只处理"格式/结构层面、不需要DB即可判定"的部分：
// new-task模式下全部必填参数是否至少被显式提供（缺失时甚至不应该尝试连接数据库，见下方main()中的调用时机，
// 在loadConfig()/createPgPool()之前执行）；resume模式下无法在此阶段判断"省略的参数"是否合法（需要先读DB），
// 那部分校验推迟到runWalkForward()内部的validateEffectiveOptions（对合并后的effective options做最终校验）。
export function validateCliArgsBeforeDbAccess({ args, resumeId }) {
  if (resumeId != null && (typeof resumeId !== 'string' || resumeId.trim() === '')) {
    throw Object.assign(new Error('--resume requires a non-empty validation_run_id'), { code: 'INVALID_RESUME_ID' });
  }
  if (!resumeId) {
    const requiredFlags = [
      ['symbol', '--symbol'], ['from', '--from'], ['to', '--to'], ['horizons', '--horizons'],
      ['algorithm-version', '--algorithm-version'], ['dataset-version', '--dataset-version'], ['rule-version', '--rule-version'],
      ['weight-version', '--weight-version'], ['evaluation-version', '--evaluation-version']
    ];
    const missing = requiredFlags.filter(([key]) => args[key] === undefined || args[key] === true || String(args[key]).trim() === '').map(([, flag]) => flag);
    if (missing.length) {
      throw Object.assign(new Error(`Missing required argument(s): ${missing.join(', ')}`), { code: 'MISSING_REQUIRED_ARG', missing });
    }
  } else {
    // §4.4：weight-version/evaluation-version不是可恢复的run身份字段（不存在于validation_runs表结构，
    // 也不在frozen §4.4的resume比对清单内），resume模式下同样必须显式提供，不做任何"从原run继承"的假装。
    for (const [key, flag] of [['weight-version', '--weight-version'], ['evaluation-version', '--evaluation-version']]) {
      if (args[key] === undefined || args[key] === true || String(args[key]).trim() === '') {
        throw Object.assign(new Error(`Missing required argument: ${flag} (not resumable — must be supplied on every invocation)`), { code: 'MISSING_REQUIRED_ARG', missing: [flag] });
      }
    }
  }
  if (args.split && (args['train-end'] || args['validation-end'])) {
    throw Object.assign(new Error('--split and --train-end/--validation-end are mutually exclusive'), { code: 'CONFLICTING_SPLIT_PARAMS' });
  }
}

export async function main(argv = process.argv.slice(2)) {
  // §4.1：启动横幅必须是本次CLI调用stdout的第一行，且无论后续参数校验是否通过都必须打印
  // （"每次启动"，不是"校验通过后才启动"）——因此place在main()最开头，先于parseArgs/任何校验/任何DB连接。
  console.info(STARTUP_BANNER);

  const args = parseArgs(argv);
  const resumeId = typeof args.resume === 'string' ? args.resume : (args.resume === true ? true : null);

  // P1-4：结构性校验发生在loadConfig()/createPgPool()之前——校验失败时完全不触碰数据库。
  validateCliArgsBeforeDbAccess({ args, resumeId });

  const horizons = args.horizons !== undefined ? String(args.horizons).split(',').map(s => s.trim()).filter(Boolean) : undefined;
  if (horizons) for (const h of horizons) if (!HORIZONS.includes(h)) throw Object.assign(new Error(`Invalid horizon: ${h}`), { code: 'INVALID_HORIZON' });

  let splitRatio = null;
  if (args.split) splitRatio = parseSplitRatio(args.split);

  const explicitParams = {};
  if (args.symbol !== undefined) explicitParams.symbol = args.symbol;
  if (horizons !== undefined) explicitParams.horizons = horizons;
  if (args.from !== undefined) explicitParams.fromUtc = parseUtc(args.from, '--from');
  if (args.to !== undefined) explicitParams.toUtc = parseUtc(args.to, '--to');
  if (args['algorithm-version'] !== undefined) explicitParams.algorithmVersion = args['algorithm-version'];
  if (args['dataset-version'] !== undefined) explicitParams.datasetVersion = args['dataset-version'];
  if (args['rule-version'] !== undefined) explicitParams.ruleVersion = args['rule-version'];
  if (args['train-end'] !== undefined) explicitParams.trainEndUtc = parseUtc(args['train-end'], '--train-end');
  if (args['validation-end'] !== undefined) explicitParams.validationEndUtc = parseUtc(args['validation-end'], '--validation-end');

  const config = loadConfig();
  const pool = await createPgPool(config);
  try {
    const plan = await runWalkForward({
      pool, dryRun: Boolean(args['dry-run']), resumeValidationRunId: typeof resumeId === 'string' ? resumeId : null,
      explicitParams, splitRatio,
      weightVersion: args['weight-version'], evaluationVersion: args['evaluation-version'],
      nowMs: Date.now()
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
