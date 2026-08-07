// 研究编排运行状态（orchestration run status）——冻结契约§4/§5之外的增补设计，见最终报告
// "冻结契约之外的增补点"一节。契约本身只规定"180天单次提交内部安全分批、checkpoint/resume、
// 幂等写入、失败恢复、可审计运行状态、DRY/FORMAL物理/逻辑隔离"这些行为性质，不定义这些状态
// 应该如何持久化——本文件是满足这些行为性质要求的最小、可测试实现，不是对D7 artifact/§4的
// 重新定义、扩展或弱化。
//
// 与D7的隔离（这一点不是可选的，是§4.1"运行wall-clock只写独立runtime记录，不进入主文件、
// sidecar或业务hash"原则在编排层的直接延伸）：
//   - 写入路径固定为 `{root}/run-status/{formal|dry-run}/{validationRunId}.status.json`，
//     与D7的 `{root}/{formal|dry-run}/{validationRunId}/{evaluationIdentity}/` 完全独立的子树——
//     不同目录、不共用锁、不共用文件、不进入D7的Schema/hash链。
//   - 本文件描述的是"过程遥测"（是否在跑、跑到第几批、上次checkpoint时间），D7 artifact描述的
//     是"确定性业务结论"——混淆两者会让业务hash随wall-clock/运行进度变化，是契约明确禁止的
//     wall-clock泄漏，因此必须是两套独立文件、独立Schema语义。
//   - 与D7业务artifact的"只能创建一次、之后只读、唯一commit point"不同，运行状态语义上是可变的
//     进度快照，允许覆盖写——但覆盖本身仍必须走temp写入+file fsync+原子rename+目录fsync，不允许
//     任何读者观察到"写了一半"的状态文件（幂等写入、失败恢复的最低要求）。
import fs from 'node:fs';
import path from 'node:path';
import {
  writeTempFileDurable, renameAllowCreate, fsyncDirectory, ensureDirectorySafe,
  readFileNoFollowSymlink, lstatIfExists, newLockId
} from './artifact-fs-primitives.js';

const SCHEMA_VERSION = 'v1.4d-research-run-status/2';
const VALID_STATES = new Set(['RUNNING', 'BLOCKED', 'COMPLETED', 'FAILED']);
const MAX_STATUS_BYTES = 1_000_000;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function statusDir(root, artifactMode) {
  return path.join(root, 'run-status', artifactMode === 'FORMAL' ? 'formal' : 'dry-run');
}
function statusPath(root, artifactMode, validationRunId) {
  return path.join(statusDir(root, artifactMode), `${validationRunId}.status.json`);
}

function assertStatus(status) {
  if (!status || typeof status !== 'object') throw fail('RUN_STATUS_INVALID', 'status must be an object');
  if (status.schemaVersion !== SCHEMA_VERSION) throw fail('RUN_STATUS_INVALID', 'schemaVersion mismatch');
  if (!RUN_ID_PATTERN.test(status.validationRunId)) throw fail('RUN_STATUS_INVALID', 'validationRunId invalid');
  if (status.artifactMode !== 'FORMAL' && status.artifactMode !== 'DRY_RUN') throw fail('RUN_STATUS_INVALID', 'artifactMode invalid');
  if (!VALID_STATES.has(status.runState)) throw fail('RUN_STATUS_INVALID', 'runState invalid');
  if (!Number.isInteger(status.totalBatches) || status.totalBatches < 1) throw fail('RUN_STATUS_INVALID', 'totalBatches invalid');
  if (!Array.isArray(status.completedBatchIndices) || status.completedBatchIndices.some(i => !Number.isInteger(i) || i < 0 || i >= status.totalBatches)) {
    throw fail('RUN_STATUS_INVALID', 'completedBatchIndices invalid');
  }
  if (new Set(status.completedBatchIndices).size !== status.completedBatchIndices.length) {
    throw fail('RUN_STATUS_INVALID', 'completedBatchIndices must not contain duplicates');
  }
  if (status.completedBatchIndices.some((value, index) => value !== index)) {
    throw fail('RUN_STATUS_CHECKPOINT_INCONSISTENT', 'completed batch checkpoints must be one continuous prefix');
  }
  if (!Array.isArray(status.batchCheckpoints) || status.batchCheckpoints.length !== status.completedBatchIndices.length ||
      status.batchCheckpoints.some((checkpoint, index) => checkpoint?.batchIndex !== index ||
        !Number.isInteger(checkpoint.rowCount) || checkpoint.rowCount < 0 ||
        typeof checkpoint.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(checkpoint.sha256) ||
        !(checkpoint.cursor === null || (checkpoint.cursor && typeof checkpoint.cursor.horizon === 'string' &&
          Number.isSafeInteger(checkpoint.cursor.targetStartTime) && typeof checkpoint.cursor.predictionId === 'string')))) {
    throw fail('RUN_STATUS_CHECKPOINT_INCONSISTENT', 'batch checkpoint evidence is invalid');
  }
  if (status.blockedReasonCode !== null && typeof status.blockedReasonCode !== 'string') {
    throw fail('RUN_STATUS_INVALID', 'blockedReasonCode must be a string or null');
  }
  if (typeof status.updatedAt !== 'string' || !status.updatedAt.endsWith('Z') || !Number.isFinite(new Date(status.updatedAt).getTime())) {
    throw fail('RUN_STATUS_INVALID', 'updatedAt must be a canonical UTC ISO8601 string');
  }
  return status;
}

export function readRunStatus(root, artifactMode, validationRunId) {
  const target = statusPath(root, artifactMode, validationRunId);
  const st = lstatIfExists(target);
  if (!st) return null;
  if (st.isSymbolicLink()) throw fail('RUN_STATUS_INVALID', 'status path is a symlink');
  const { bytes } = readFileNoFollowSymlink(target, MAX_STATUS_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw fail('RUN_STATUS_INVALID', 'status content is not valid JSON');
  }
  return assertStatus(parsed);
}

// 独立于D7 artifact目录扫描run-status本身——一次从未发布过任何artifact的运行（比如第一批
// 还没跑完）必须仍然能被发现为RUNNING，不能依赖"先有已发布artifact才能定位validationRunId"
// （那样会漏掉"首次运行、尚无任何已发布产物"的场景）。只返回updatedAt最新的一条，与
// d8-artifact-discovery.js"只信任文件系统可观察的时间戳排序，不做内容层面的猜测排序"同一原则。
export function findMostRecentRunStatus(root, artifactMode) {
  const dir = statusDir(root, artifactMode);
  let entries;
  try {
    entries = fs.readdirSync(dir).filter(name => name.endsWith('.status.json') && !name.startsWith('.'));
  } catch {
    return null;
  }
  let best = null;
  for (const name of entries) {
    const validationRunId = name.slice(0, -'.status.json'.length);
    let status;
    try {
      status = readRunStatus(root, artifactMode, validationRunId);
    } catch {
      continue; // 单条损坏的run-status文件不得让整个发现过程失败——跳过，不是本文件的读取目标
    }
    if (!status) continue;
    if (!best || new Date(status.updatedAt).getTime() > new Date(best.updatedAt).getTime()) best = status;
  }
  return best;
}

export function writeRunStatus(root, status) {
  assertStatus(status);
  const dir = statusDir(root, status.artifactMode);
  ensureDirectorySafe(dir, root);
  const bytes = Buffer.from(JSON.stringify(status), 'utf8');
  const tempPath = path.join(dir, `.${status.validationRunId}.status.json.tmp.${process.pid}.${newLockId()}`);
  writeTempFileDurable(tempPath, bytes);
  renameAllowCreate(tempPath, statusPath(root, status.artifactMode, status.validationRunId));
  fsyncDirectory(dir);
  return status;
}

export function initialRunStatus({ validationRunId, artifactMode, totalBatches, now = new Date().toISOString() }) {
  return assertStatus({
    schemaVersion: SCHEMA_VERSION, validationRunId, artifactMode, runState: 'RUNNING',
    totalBatches, completedBatchIndices: [], batchCheckpoints: [], blockedReasonCode: null, updatedAt: now
  });
}

export function withBatchPlan(status, totalBatches, { now = new Date().toISOString() } = {}) {
  if (status.completedBatchIndices.length || !Number.isInteger(totalBatches) || totalBatches < 1) {
    throw fail('RUN_STATUS_CHECKPOINT_INCONSISTENT', 'batch plan can only be established before the first checkpoint');
  }
  return assertStatus({ ...status, totalBatches, updatedAt: now });
}

export function withBatchCompleted(status, batchIndex, { now = new Date().toISOString(), checkpoint = null } = {}) {
  if (batchIndex !== status.completedBatchIndices.length) {
    throw fail('RUN_STATUS_CHECKPOINT_INCONSISTENT', 'checkpoint must extend the continuous completed prefix');
  }
  const completedBatchIndices = [...new Set([...status.completedBatchIndices, batchIndex])].sort((a, b) => a - b);
  if (!checkpoint) throw fail('RUN_STATUS_CHECKPOINT_INCONSISTENT', 'validated checkpoint evidence is required');
  const normalizedCheckpoint = checkpoint;
  if (normalizedCheckpoint.batchIndex !== batchIndex) throw fail('RUN_STATUS_CHECKPOINT_INCONSISTENT', 'checkpoint batch index mismatch');
  const batchCheckpoints = [...status.batchCheckpoints, normalizedCheckpoint];
  const allDone = completedBatchIndices.length === status.totalBatches;
  return assertStatus({ ...status, completedBatchIndices, batchCheckpoints, runState: allDone ? status.runState : 'RUNNING', updatedAt: now });
}

export function withBlocked(status, blockedReasonCode, { now = new Date().toISOString() } = {}) {
  return assertStatus({ ...status, runState: 'BLOCKED', blockedReasonCode, updatedAt: now });
}

export function withCompleted(status, { now = new Date().toISOString() } = {}) {
  return assertStatus({ ...status, runState: 'COMPLETED', blockedReasonCode: null, updatedAt: now });
}

export function withFailed(status, blockedReasonCode, { now = new Date().toISOString() } = {}) {
  return assertStatus({ ...status, runState: 'FAILED', blockedReasonCode, updatedAt: now });
}

export const RUN_STATUS_SCHEMA_VERSION = SCHEMA_VERSION;
