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

function toEpochMsFromTimestamptz(value) {
  return value == null ? null : (value instanceof Date ? value.getTime() : new Date(value).getTime());
}

// P1-3修复（独立复审）：generation/evaluation/report任一阶段出现未处理异常时，把validation_runs从
// RUNNING转为FAILED，并保存结构化的失败原因（阶段/节奏点/错误信息），供事后诊断与--resume前的人工判断。
// 只在status仍为'RUNNING'时更新——终态（SUCCEEDED/FAILED）行不可变（分类A，§2.0），本函数不会、
// 也不应该覆盖一个已经处于终态的行。blocked_reasons是jsonb数组，用`||`追加而不是覆盖，保留完整历史
// （理论上同一行不应该被追加多次——一旦转为FAILED就是终态——但用追加而非覆盖仍然是更安全的写法，
// 防止未来任何调用路径变化导致多次调用时静默丢失早期的失败原因）。
async function markValidationRunFailed({ pool, validationRunId, error, failureContext }) {
  const reason = {
    phase: failureContext.phase || 'UNKNOWN',
    horizon: failureContext.horizon,
    historicalAsOfTime: failureContext.historicalAsOfTime,
    message: error.message,
    code: error.code || null,
    at: new Date().toISOString()
  };
  await pool.query(
    `UPDATE historical_validation.validation_runs
     SET status='FAILED', error_code=$2, blocked_reasons=blocked_reasons || $3::jsonb, finished_at=now()
     WHERE validation_run_id=$1 AND status='RUNNING'`,
    [validationRunId, error.code || reason.phase || 'UNHANDLED_EXCEPTION', JSON.stringify([reason])]
  );
}

// P0-1修复（独立复审）：真正的断点续跑——此前的实现在--resume时会把[from,to)整个区间重新枚举、重新调用
// generateReplaySnapshot/evaluateReplayOutcomes做完整计算，只靠下游ON CONFLICT DO NOTHING去重免于重复写入，
// 但既没有"从哪里继续"的持久化游标，也把已完成节奏点的计算重新做了一遍（违反"不重复...重新计算已完成部分"）。
//
// 本函数从该(validation_run_id, horizon)已持久化的审计表推导出一个可靠的checkpoint，不新增任何表/列：
// - 一个节奏点(historicalAsOfTime)被视为"已完成"，要求同时满足：
//   ① historical_validation.replay_generation_runs 中存在该(validation_run_id, horizon, historical_as_of_time)
//      的一行，status在('SUCCEEDED','BLOCKED')终态（这两个状态代表"确定性地跑完了一次尝试"，FAILED代表
//      未处理完的异常，必须重跑，不计入已完成——见P1-3）；
//   ② historical_validation.replay_evaluation_runs 中存在该(validation_run_id, historical_as_of_time)的一行，
//      status='SUCCEEDED'（评估sweep不区分horizon，见migration 005 §2.6结构，本函数按具体asOfTime值匹配）。
// - resumeFromIndex = 从points[0]开始，第一个不满足上述"已完成"条件的下标（即首个未完成节奏点）。
// - fail-closed一致性核验：resumeFromIndex之后不得再出现任何"已完成"的点——正常的单线程顺序执行不可能
//   产生这种情况（点是按顺序处理的），一旦出现即代表审计记录不连续/不一致，无法安全判定真正的续跑边界，
//   必须拒绝续跑而不是猜测性地选一个边界（见本任务书P0-1"如果恢复所需状态不完整或不一致，必须fail closed"）。
export async function computeResumeCheckpoint({ pool, validationRunId, horizon, points }) {
  if (!points.length) return { resumeFromIndex: 0, totalPoints: 0 };

  const genRows = await pool.query(
    `SELECT historical_as_of_time, status FROM historical_validation.replay_generation_runs
     WHERE validation_run_id=$1 AND horizon=$2`,
    [validationRunId, horizon]
  );
  const genTerminal = new Set();
  for (const row of genRows.rows) {
    if (row.status === 'SUCCEEDED' || row.status === 'BLOCKED') genTerminal.add(toEpochMsFromTimestamptz(row.historical_as_of_time));
  }

  const evalRows = await pool.query(
    `SELECT historical_as_of_time, status FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1`,
    [validationRunId]
  );
  const evalTerminal = new Set();
  for (const row of evalRows.rows) {
    if (row.status === 'SUCCEEDED') evalTerminal.add(toEpochMsFromTimestamptz(row.historical_as_of_time));
  }

  const isDone = point => genTerminal.has(point) && evalTerminal.has(point);

  let resumeFromIndex = 0;
  while (resumeFromIndex < points.length && isDone(points[resumeFromIndex])) resumeFromIndex += 1;

  for (let i = resumeFromIndex + 1; i < points.length; i++) {
    if (isDone(points[i])) {
      throw Object.assign(
        new Error(`Resume checkpoint inconsistency for horizon ${horizon}: point at index ${i} (historicalAsOfTime=${points[i]}) is already recorded as complete, but an earlier point at index ${resumeFromIndex} (historicalAsOfTime=${points[resumeFromIndex]}) is not — cannot safely determine a contiguous resume boundary`),
        { code: 'RESUME_CHECKPOINT_INCONSISTENT', horizon, gapIndex: resumeFromIndex, aheadIndex: i }
      );
    }
  }

  return { resumeFromIndex, totalPoints: points.length };
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

// P1-A修复（独立复审第二轮）：weight_version/evaluation_version不在validation_runs表结构中，也不在
// 冻结§4.4的resume比对清单内，第一轮因此判定为"每次必须显式提供，不做继承"——但这只解决了"未提供时不会
// 静默用默认值"的问题，没有解决"resume时提供了一个和本run之前实际使用值不同的版本会被静默接受"这一
// 更根本的风险（复现证据：round-1复审发现同一validation_run_id下可混入两个weight_version）。
// 本函数在resume时读取该validation_run【自己名下已产生的snapshot/outcome实际记录的】weight_version/
// evaluation_version集合，与本次显式提供值比对：
//   - 集合为空（该run至今尚无任何snapshot/outcome）：允许使用本次显式提供的版本（无历史可比对，见req#5）；
//   - 集合恰好一个值：必须与本次显式提供值一致，否则fail closed（RESUME_WEIGHT_VERSION_MISMATCH/
//     RESUME_EVALUATION_VERSION_MISMATCH）；
//   - 集合本身已有多个不同值（说明此run历史上已经被注入过混合版本——理论上第二轮修复上线后不应再新增此类
//     数据，但resume一个在本轮修复生效前就已经混入过多版本的历史run仍需拒绝，不得静默选择其中一个）：
//     fail closed（RESUME_MIXED_WEIGHT_VERSIONS/RESUME_MIXED_EVALUATION_VERSIONS）。
// 复用与P0-1同一套"这个snapshot是否真的属于本run"的判定口径（algorithm_version/dataset_version与本run
// 一致 + EXISTS本run在该horizon/historicalAsOfTime的SUCCEEDED生成尝试），不重新发明第二套归属逻辑。
// weight_version来自replay_snapshots.weight_version（本run名下的快照）；evaluation_version来自
// 这些快照关联的replay_outcome_events.evaluation_version（不苛求outcome_event本身的evaluation_run_id
// 归属哪个run——同一prediction_id的评估结果是全局唯一去重的canonical结果，见report-builder.js P2-5注释，
// 只要该结果依附于"本run拥有的snapshot"，就代表本run的数据已经在这个evaluation_version下被评估过）。
async function checkResumeVersionConsistency({ pool, validationRunId, weightVersion, evaluationVersion }) {
  const weightRows = await pool.query(
    `SELECT DISTINCT s.weight_version FROM historical_validation.replay_snapshots s
     JOIN historical_validation.validation_runs vr
       ON vr.validation_run_id=$1 AND vr.algorithm_version=s.algorithm_version AND vr.dataset_version=s.dataset_version
     WHERE EXISTS (
       SELECT 1 FROM historical_validation.replay_generation_runs g
       WHERE g.validation_run_id=$1 AND g.horizon=s.horizon AND g.historical_as_of_time=s.target_start_time AND g.status='SUCCEEDED'
     )`,
    [validationRunId]
  );
  const priorWeightVersions = weightRows.rows.map(r => r.weight_version);
  if (priorWeightVersions.length > 1) {
    throw Object.assign(
      new Error(`validation_run ${validationRunId} already has snapshots produced under multiple weight_version values: ${JSON.stringify(priorWeightVersions)}; refusing to resume`),
      { code: 'RESUME_MIXED_WEIGHT_VERSIONS', priorWeightVersions }
    );
  }
  if (priorWeightVersions.length === 1 && priorWeightVersions[0] !== weightVersion) {
    throw Object.assign(
      new Error(`--weight-version (${weightVersion}) does not match the weight_version already used by validation_run ${validationRunId} (${priorWeightVersions[0]})`),
      { code: 'RESUME_WEIGHT_VERSION_MISMATCH', explicit: weightVersion, original: priorWeightVersions[0] }
    );
  }

  const evaluationRows = await pool.query(
    `SELECT DISTINCT e.evaluation_version FROM historical_validation.replay_snapshots s
     JOIN historical_validation.validation_runs vr
       ON vr.validation_run_id=$1 AND vr.algorithm_version=s.algorithm_version AND vr.dataset_version=s.dataset_version
     JOIN historical_validation.replay_outcome_events e
       ON e.prediction_id=s.prediction_id AND e.research_availability_rule_version=s.research_availability_rule_version
     WHERE EXISTS (
       SELECT 1 FROM historical_validation.replay_generation_runs g
       WHERE g.validation_run_id=$1 AND g.horizon=s.horizon AND g.historical_as_of_time=s.target_start_time AND g.status='SUCCEEDED'
     )`,
    [validationRunId]
  );
  const priorEvaluationVersions = evaluationRows.rows.map(r => r.evaluation_version);
  if (priorEvaluationVersions.length > 1) {
    throw Object.assign(
      new Error(`validation_run ${validationRunId} already has outcomes produced under multiple evaluation_version values: ${JSON.stringify(priorEvaluationVersions)}; refusing to resume`),
      { code: 'RESUME_MIXED_EVALUATION_VERSIONS', priorEvaluationVersions }
    );
  }
  if (priorEvaluationVersions.length === 1 && priorEvaluationVersions[0] !== evaluationVersion) {
    throw Object.assign(
      new Error(`--evaluation-version (${evaluationVersion}) does not match the evaluation_version already used by validation_run ${validationRunId} (${priorEvaluationVersions[0]})`),
      { code: 'RESUME_EVALUATION_VERSION_MISMATCH', explicit: evaluationVersion, original: priorEvaluationVersions[0] }
    );
  }
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

  // P1-A修复（独立复审第二轮）：resume时weight_version/evaluation_version必须与本run已有snapshot/outcome
  // 实际记录的版本一致（若尚无历史数据则允许本次显式提供的值）——发生在manifest gate、任何INSERT、
  // historical_as_of_time推进循环之前，dry-run同样执行（不因dry-run跳过，见下方§4.2循环体本身也统一
  // 执行到这一步之后才分流dry-run/真实写入）。只读查询本身允许发生（req#12），冲突必须在此处fail closed。
  if (resumeValidationRunId) {
    await checkResumeVersionConsistency({
      pool, validationRunId: resumeValidationRunId, weightVersion: effective.weightVersion, evaluationVersion: effective.evaluationVersion
    });
  }

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
  let manifestVerification;
  try {
    manifestVerification = await runManifestGate({ pool, datasetVersion: effective.datasetVersion });
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
    // P1-3修复（独立复审）：此前这里直接以status='SUCCEEDED'插入——在P0-2修复之前dry-run只是一个立即
    // 返回的`continue`循环，从不会失败，"插入时即成功"尚可接受；但P0-2修复后dry-run真实执行生成/评估的
    // 全部只读计算，同样可能抛出未预期异常。若仍然"插入时就标记SUCCEEDED"，一旦下面的循环体在完成前抛出
    // 异常，这一行会永久错误地显示"SUCCEEDED"（数据与事实不符，违反"不得出现失败后仍标记COMPLETED"红线）。
    // 改为与真实执行路径同一模式：先插入RUNNING，循环成功完成后才更新为SUCCEEDED，失败则见下方
    // 统一异常处理器更新为FAILED——dry-run与真实执行共享同一套终态治理，不再有特殊例外。
    await pool.query(
      `INSERT INTO historical_validation.validation_runs(
         validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, dry_run, status, started_at
       ) VALUES($1,$2,$3,$4::jsonb,to_timestamp($5/1000.0),to_timestamp($6/1000.0),$7,$8,true,'RUNNING',now())`,
      [validationRunId, datasetVersion, symbol, JSON.stringify(horizons), from, to, algorithmVersion, ruleVersion]
    );
  }

  const instrument = symbol === 'ETH' ? 'ETHUSDT' : symbol;
  // req#10/G（P1-A）：main()必须能把resume继承/校验后的effective options（真实生效值，不是原始CLI空值）
  // 输出给使用者复核——尤其weight_version/evaluation_version这类"不可继承、每次必须显式提供"的字段，
  // 使用者需要能确认本次实际生效的值确实与自己预期一致。
  const effectiveOptionsSummary = {
    validationRunId, symbol, from, to, horizons, algorithmVersion, datasetVersion, ruleVersion,
    weightVersion: effective.weightVersion, evaluationVersion: effective.evaluationVersion, trainEnd, validationEnd, dryRun
  };
  const plan = { validationRunId, dryRun, effectiveOptions: effectiveOptionsSummary, generationAttempts: 0, evaluationSweeps: 0, results: [], resumeCheckpoints: {} };
  const pendingDryRunSnapshots = new Map();

  // P0-1/P0-2修复（独立复审）：
  // ①真正的断点续跑——resume时先算出每个horizon各自的checkpoint（见computeResumeCheckpoint），
  //   循环从resumeFromIndex开始，不重新处理已完成的节奏点（不重复计算，不只依赖下游ON CONFLICT去重）；
  //   new-task模式下resumeFromIndex恒为0，行为与此前一致。
  // ②dry-run不再对整个循环体`continue`——§4.2冻结要求dry-run执行完整的读取+计算链路（快照生成预演、
  //   数据可用性/缺口检查、ATR/PO/阈值计算、outcome/evaluation预演），只是把最终的数据库写入替换为
  //   空操作。generateReplaySnapshot/evaluateReplayOutcomes本身已经支持dryRun参数（返回'PLANNED'状态、
  //   跳过INSERT/UPDATE，见两个模块内部实现），此前的问题是本循环从未把dryRun传给它们、也从未调用它们——
  //   现在统一调用，只把dryRun标志向下传递，不再在循环层面短路。
  // P1-3修复（独立复审）：统一异常治理——manifest gate之后（本函数前段已单独处理manifest gate自身的
  // 异常，见上方）、直到report构建与终态更新完成之前的任何一步（生成/评估循环、报告构建）若抛出未预期异常，
  // 此前会直接从runWalkForward()冒泡出去，validation_runs行永远停留在RUNNING，不会被标记为FAILED——
  // 这既违反"不得出现失败后仍标记COMPLETED"（更准确地说，是"失败后必须转FAILED，不得停留在非终态"），
  // 也让下次--resume时无法通过checkResumeVersionConsistency等校验判断这是一次真实失败还是仍在进行中。
  // failureContext跟踪"异常发生在哪个阶段/哪个节奏点"，写入structured blocked_reasons，供事后诊断；
  // catch块本身只负责"打上FAILED标记"，不吞掉/替换原始异常——markValidationRunFailed若自身失败（终态
  // 更新语句本身出错），会抛出一个携带original error作为cause的新错误，而不是静默吞掉任何一方。
  let failureContext = { phase: null, horizon: null, historicalAsOfTime: null };
  try {
    for (const horizon of horizons) {
      const points = enumerateRhythmPoints({ from, to, horizon });
      plan.generationAttempts += points.length;

      const checkpoint = resumeValidationRunId
        ? await computeResumeCheckpoint({ pool, validationRunId, horizon, points })
        : { resumeFromIndex: 0, totalPoints: points.length };
      plan.resumeCheckpoints[horizon] = checkpoint;

      for (let i = checkpoint.resumeFromIndex; i < points.length; i++) {
        const historicalAsOfTime = points[i];
        failureContext = { phase: 'GENERATION', horizon, historicalAsOfTime };
        const generation = await generateReplaySnapshot({
          pool, validationRunId, instrument, symbol, horizon, historicalAsOfTime, replayNowMs,
          algorithmVersion, weightVersion: effective.weightVersion, datasetVersion, ruleVersion,
          backfillBatchIds: options.backfillBatchIds || [], dryRun
        });
        const generationResult = {
          horizon, historicalAsOfTime, phase: 'generation', status: generation.status,
          predictionId: generation.record?.predictionId ?? null,
          generationRunId: generation.generationRunId
        };
        plan.results.push(generationResult);
        if (dryRun && generation.status === 'PLANNED') {
          pendingDryRunSnapshots.set(generation.record.predictionId, {
            ...generation.record,
            generationRunId: generation.generationRunId,
            backfillBatchId: options.backfillBatchIds?.[0] ?? null
          });
        }

        failureContext = { phase: 'EVALUATION', horizon, historicalAsOfTime };
        const evaluation = await evaluateReplayOutcomes({
          pool, validationRunId, evaluationVersion: effective.evaluationVersion,
          historicalAsOfTime, replayNowMs, dryRun,
          inMemorySnapshots: dryRun ? [...pendingDryRunSnapshots.values()] : []
        });
        plan.evaluationSweeps += 1;
        // previewed：本次sweep实际处理过的pending快照数量（dry-run下evaluation.evaluated/deduped恒为0，
        // 因为INSERT本身被跳过；evaluation.results.length是dry-run场景下唯一能证明"确实扫描过pending快照
        // 并跑完了locatePathForEvaluationForReplay+computeForecastOutcome全部计算"的证据）。
        const inMemoryPreviewed = evaluation.results.filter(result => result.source === 'IN_MEMORY_PLANNED');
        for (const result of inMemoryPreviewed) pendingDryRunSnapshots.delete(result.predictionId);
        plan.results.push({
          horizon, historicalAsOfTime, phase: 'evaluation',
          evaluated: evaluation.evaluated, deduped: evaluation.deduped,
          previewed: evaluation.results.length,
          previewedPredictionIds: evaluation.results.map(result => result.predictionId),
          sameRunLinks: inMemoryPreviewed.map(result => ({
            predictionId: result.predictionId,
            generationRunId: result.generationRunId,
            evaluatedHistoricalAsOfTime: historicalAsOfTime
          }))
        });
      }
    }

    // §4.2冻结要求dry-run必须输出一份"执行计划"，列出预计推进的historical_as_of_time节奏点数量、预计涉及的
    // backfill_batch_id范围、预计的purge边界，以及（P0-2新增）本次dry-run实际完整执行的读取+计算链路产出的
    // 汇总摘要——证明dry-run不是"只统计数量"，而是真的跑过一遍全部只读计算：
    // - rhythmPointCount：等于plan.generationAttempts（各horizon节奏点数之和，total，不随resume跳过而减少，
    //   与既有测试断言"rhythmPointCount===generationAttempts"保持一致）。
    // - backfillBatchIds/purgeBoundary：同此前实现，来自manifest gate验证结果与effective切分点，未改变。
    // - generationStatusCounts/evaluationPlannedCount/evaluationDedupedCount：本次dry-run实际执行后，
    //   plan.results里各阶段状态的汇总计数（PLANNED/BLOCKED及其原因、evaluation的PLANNED/DEDUPED数），
    //   证明每个节奏点都被真实跑过一次完整计算，不是占位符。
    // - resumeCheckpoints：resume场景下dry-run同样应用checkpoint跳过已完成点（预览"剩余工作量"更贴近真实
    //   意图），故一并输出每个horizon的resumeFromIndex/totalPoints供复核。
    if (dryRun) {
      const generationStatusCounts = {};
      for (const r of plan.results) {
        if (r.phase !== 'generation') continue;
        const key = `${r.horizon}:${r.status}`;
        generationStatusCounts[key] = (generationStatusCounts[key] || 0) + 1;
      }
      let evaluationPreviewedCount = 0;
      const sameRunEvaluationLinks = [];
      for (const r of plan.results) {
        if (r.phase !== 'evaluation') continue;
        evaluationPreviewedCount += r.previewed || 0;
        sameRunEvaluationLinks.push(...(r.sameRunLinks || []));
      }
      plan.executionPlan = {
        rhythmPointCount: plan.generationAttempts,
        backfillBatchIds: manifestVerification.manifest.backfill_batch_ids,
        purgeBoundary: { trainEnd, validationEnd },
        generationStatusCounts,
        evaluationPreviewedCount,
        sameRunEvaluationPreviewedCount: sameRunEvaluationLinks.length,
        sameRunEvaluationLinks,
        pendingInMemorySnapshotCount: pendingDryRunSnapshots.size,
        resumeCheckpoints: plan.resumeCheckpoints
      };
    }

    if (!dryRun) {
      failureContext = { phase: 'REPORT', horizon: null, historicalAsOfTime: null };
      plan.reports = await buildValidationReports({
        pool, validationRunId, datasetVersion, algorithmVersion, ruleVersion,
        researchAvailabilityRuleVersion: RESEARCH_AVAILABILITY_RULE_VERSION, evaluationVersion: effective.evaluationVersion, trainEnd, validationEnd
      });
    }

    // dry-run resume：从不touch原run的持久化状态（zero business writes原则的延伸，见§4.2）；
    // 其余三种组合（new-task非dry-run/resume非dry-run/new-task dry-run）都需要在成功完成后转为SUCCEEDED——
    // AND status='RUNNING'是防御性写法，避免对已经处于终态的行做无意义的原地更新。
    if (!(resumeValidationRunId && dryRun)) {
      await pool.query(`UPDATE historical_validation.validation_runs SET status='SUCCEEDED', finished_at=now() WHERE validation_run_id=$1 AND status='RUNNING'`, [validationRunId]);
    }
  } catch (error) {
    try {
      await markValidationRunFailed({ pool, validationRunId, error, failureContext });
    } catch (updateError) {
      throw Object.assign(
        new Error(`validation_run ${validationRunId} failed (${error.message}), and marking it FAILED also failed (${updateError.message}); see .originalError/.updateError for both`),
        { code: 'VALIDATION_RUN_FAILURE_UPDATE_FAILED', originalError: error, updateError, cause: error }
      );
    }
    throw error;
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
    // P1-A req#10/G：输出resume继承/校验后真实生效的effective options（而非本次CLI原始传入的空值/占位），
    // 供使用者复核——尤其weight_version/evaluation_version本次实际生效值。
    console.info('effective_options', JSON.stringify(plan.effectiveOptions));
    // P2-h（独立复审第二轮）：§4.2冻结要求dry-run必须把"执行计划"（预计推进的节奏点数量、预计涉及的
    // backfill_batch_id范围、预计的purge边界）输出到stdout，供使用者在真正写入前复核——此前
    // runWalkForward()内部虽然算出了这些值，main()却从未把它们打印出来。
    if (plan.dryRun) {
      console.info('dry_run_execution_plan', JSON.stringify(plan.executionPlan));
    }
    return plan;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error('validation:walk-forward failed', { code: error.code || error.message }); process.exitCode = 1; });
}
