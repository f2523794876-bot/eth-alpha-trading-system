// 研究编排运行状态（orchestration run status）——冻结契约§4/§5之外的增补设计，见最终报告
// "冻结契约之外的增补点"一节。契约本身只规定"180天单次提交内部安全分批、checkpoint/resume、
// 幂等写入、失败恢复、可审计运行状态、DRY/FORMAL物理/逻辑隔离"这些行为性质，不定义这些状态
// 应该如何持久化——本文件是满足这些行为性质要求的最小、可测试实现，不是对D7 artifact/§4的
// 重新定义、扩展或弱化。
//
// 与D7的隔离（这一点不是可选的，是§4.1"运行wall-clock只写独立runtime记录，不进入主文件、
// sidecar或业务hash"原则在编排层的直接延伸）：
//   - 写入路径固定为 `{root}/run-status/{formal|dry-run}/{validationRunId}/{runIdentitySha256}.status.json`，
//     与D7的 `{root}/{formal|dry-run}/{validationRunId}/{evaluationIdentity}/` 完全独立的子树——
//     不同目录、不共用锁、不共用文件、不进入D7的Schema/hash链。
//   - 本文件描述的是"过程遥测"（是否在跑、跑到第几批、上次checkpoint时间），D7 artifact描述的
//     是"确定性业务结论"——混淆两者会让业务hash随wall-clock/运行进度变化，是契约明确禁止的
//     wall-clock泄漏，因此必须是两套独立文件、独立Schema语义。
//   - 与D7业务artifact的"只能创建一次、之后只读、唯一commit point"不同，运行状态语义上是可变的
//     进度快照。更新必须在run-identity级跨进程锁内重读最新revision并通过单调状态机，再走
//     temp写入+file fsync+原子rename+目录fsync，不允许过期内存覆盖终态，也不允许任何读者
//     观察到"写了一半"的状态文件。
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, canonicalSha256 } from '../formal-research/canonical-json.js';
import {
  writeTempFileDurable, renameAllowCreate, fsyncDirectory, ensureDirectorySafe,
  readFileNoFollowSymlink, lstatIfExists, newLockId, newOwnerToken, processStartIdentity, renameNoReplace,
  hostIdentitySha256
} from './artifact-fs-primitives.js';
import * as renameat2 from '../../native/renameat2/index.js';

const SCHEMA_VERSION = 'v1.4d-research-run-status/5';
const VALID_STATES = new Set(['RUNNING', 'BLOCKED', 'COMPLETED', 'FAILED']);
const MAX_STATUS_BYTES = 1_000_000;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_CORE_FIELDS = ['validationRunId', 'artifactMode', 'configSha256', 'thresholdsSha256', 'gitObjectFormat',
  'sourceIdentity', 'sourceVersion', 'sourceCommit', 'datasetVersion', 'featureEngineVersion', 'algorithmVersion', 'ruleVersion', 'evaluationVersion',
  'weightVersion', 'horizons', 'researchFrom', 'researchTo', 'fixedAsOf'];
const COMPLETE_IDENTITY_FIELDS = [...IDENTITY_CORE_FIELDS, 'runIdentitySha256'];

function fail(code, message) {
  return Object.assign(new Error(message || code), { code });
}

const sha256 = canonicalSha256;

function statusDir(root, artifactMode) {
  return path.join(root, 'run-status', artifactMode === 'FORMAL' ? 'formal' : 'dry-run');
}
function runStatusDir(root, artifactMode, validationRunId) {
  return path.join(statusDir(root, artifactMode), validationRunId);
}
function statusPath(root, runIdentity) {
  return path.join(runStatusDir(root, runIdentity.artifactMode, runIdentity.validationRunId), `${runIdentity.runIdentitySha256}.status.json`);
}

export function createResearchRunIdentity({ validationRunId, evaluationVersion, artifactMode, config }) {
  if (!RUN_ID_PATTERN.test(validationRunId || '') || typeof evaluationVersion !== 'string' || !evaluationVersion.trim() ||
      (artifactMode !== 'FORMAL' && artifactMode !== 'DRY_RUN') || !config || typeof config !== 'object' || Array.isArray(config)) {
    throw fail('RUN_STATUS_IDENTITY_INVALID', 'complete validation, evaluation, mode and config identity is required');
  }
  const configSha256 = sha256(config);
  const core = {
    validationRunId, artifactMode, configSha256, thresholdsSha256: sha256(config.thresholds),
    gitObjectFormat: config.gitObjectFormat,
    sourceIdentity: config.sourceIdentity ?? config.databaseIdentity ?? config.source,
    sourceVersion: config.sourceVersion ?? config.schemaVersion,
    sourceCommit: config.sourceCommit,
    datasetVersion: config.datasetVersion,
    featureEngineVersion: config.featureEngineVersion,
    algorithmVersion: config.algorithmVersion,
    ruleVersion: config.ruleVersion,
    evaluationVersion: config.evaluationVersion ?? evaluationVersion,
    weightVersion: config.weightVersion,
    horizons: config.horizons,
    researchFrom: config.researchFrom,
    researchTo: config.researchTo,
    fixedAsOf: config.fixedAsOf
  };
  if (core.evaluationVersion !== evaluationVersion) throw fail('RUN_STATUS_IDENTITY_MISMATCH', 'evaluationVersion conflicts with frozen config');
  assertIdentityCore(core);
  return Object.freeze({ ...core, runIdentitySha256: sha256(core) });
}

function assertStatus(status) {
  if (!status || typeof status !== 'object') throw fail('RUN_STATUS_INVALID', 'status must be an object');
  if (status.schemaVersion !== SCHEMA_VERSION) throw fail('RUN_STATUS_INVALID', 'schemaVersion mismatch');
  if (COMPLETE_IDENTITY_FIELDS.some(field => !Object.hasOwn(status, field))) {
    throw fail('RUN_STATUS_IDENTITY_MISMATCH', 'persisted status lacks complete run identity fields');
  }
  if (!RUN_ID_PATTERN.test(status.validationRunId)) throw fail('RUN_STATUS_INVALID', 'validationRunId invalid');
  if (typeof status.evaluationVersion !== 'string' || !status.evaluationVersion.trim()) throw fail('RUN_STATUS_INVALID', 'evaluationVersion invalid');
  if (status.artifactMode !== 'FORMAL' && status.artifactMode !== 'DRY_RUN') throw fail('RUN_STATUS_INVALID', 'artifactMode invalid');
  if (!SHA256_PATTERN.test(status.configSha256 || '') || !SHA256_PATTERN.test(status.runIdentitySha256 || '')) {
    throw fail('RUN_STATUS_INVALID', 'run identity hashes are invalid');
  }
  if (!Number.isSafeInteger(status.revision) || status.revision < 0) throw fail('RUN_STATUS_INVALID', 'revision invalid');
  const expectedIdentity = sha256(identityCore(status));
  if (status.runIdentitySha256 !== expectedIdentity) throw fail('RUN_STATUS_IDENTITY_MISMATCH', 'persisted run identity hash mismatch');
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
  if (!(status.publishedArtifactSha256 === null || SHA256_PATTERN.test(status.publishedArtifactSha256 || ''))) {
    throw fail('RUN_STATUS_INVALID', 'publishedArtifactSha256 must be null or SHA-256');
  }
  if (status.runState === 'COMPLETED' && (status.completedBatchIndices.length !== status.totalBatches || status.publishedArtifactSha256 === null)) {
    throw fail('RUN_STATUS_INVALID', 'COMPLETED requires all checkpoints and a published artifact hash');
  }
  if (typeof status.updatedAt !== 'string' || !status.updatedAt.endsWith('Z') || !Number.isFinite(new Date(status.updatedAt).getTime())) {
    throw fail('RUN_STATUS_INVALID', 'updatedAt must be a canonical UTC ISO8601 string');
  }
  return status;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function assertResearchRunIdentity(runIdentity) {
  if (!runIdentity || COMPLETE_IDENTITY_FIELDS.some(field => !Object.hasOwn(runIdentity, field))) {
    throw fail('RUN_STATUS_IDENTITY_INVALID', 'complete hashed run identity is required');
  }
  assertIdentityCore(runIdentity);
  if (!SHA256_PATTERN.test(runIdentity.runIdentitySha256 || '')) throw fail('RUN_STATUS_IDENTITY_INVALID', 'complete hashed run identity is required');
  const expectedHash = sha256(identityCore(runIdentity));
  if (runIdentity.runIdentitySha256 !== expectedHash) throw fail('RUN_STATUS_IDENTITY_MISMATCH', 'run identity hash mismatch');
  return Object.freeze({ ...identityCore(runIdentity), runIdentitySha256: runIdentity.runIdentitySha256 });
}

function assertIdentityCore(value) {
  const versions = ['sourceIdentity', 'sourceVersion', 'featureEngineVersion', 'algorithmVersion', 'ruleVersion', 'evaluationVersion', 'weightVersion'];
  const canonicalUtc = field => {
    try { return typeof value[field] === 'string' && new Date(value[field]).toISOString() === value[field]; }
    catch { return false; }
  };
  const sourcePattern = value.gitObjectFormat === 'SHA1' ? /^[0-9a-f]{40}$/ : value.gitObjectFormat === 'SHA256' ? /^[0-9a-f]{64}$/ : null;
  if (!RUN_ID_PATTERN.test(value.validationRunId || '') || !['FORMAL', 'DRY_RUN'].includes(value.artifactMode) ||
      !SHA256_PATTERN.test(value.configSha256 || '') || !SHA256_PATTERN.test(value.thresholdsSha256 || '') ||
      !sourcePattern?.test(value.sourceCommit || '') || !/^v1\.4d-sha256-[0-9a-f]{64}$/.test(value.datasetVersion || '') ||
      versions.some(field => typeof value[field] !== 'string' || !value[field].trim()) ||
      !Array.isArray(value.horizons) || value.horizons.length === 0 || value.horizons.some(horizon => !['24h', '72h'].includes(horizon)) ||
      !canonicalUtc('researchFrom') || !canonicalUtc('researchTo') || !canonicalUtc('fixedAsOf')) {
    throw fail('RUN_STATUS_IDENTITY_INVALID', 'complete canonical run identity fields are required');
  }
  return value;
}

function identityCore(value) {
  return Object.fromEntries(IDENTITY_CORE_FIELDS.map(field => [field, value[field]]));
}

export function researchRunIdentityCore(value) {
  return identityCore(assertResearchRunIdentity(value));
}

export function readRunStatus(root, runIdentity) {
  const identity = assertResearchRunIdentity(runIdentity);
  const target = statusPath(root, identity);
  const st = lstatIfExists(target);
  if (!st) {
    if (lstatIfExists(path.join(statusDir(root, identity.artifactMode), `${identity.validationRunId}.status.json`))) {
      throw fail('RUN_STATUS_LEGACY_REJECTED', 'legacy status lacks complete run identity and cannot be resumed');
    }
    let siblings = [];
    try { siblings = fs.readdirSync(runStatusDir(root, identity.artifactMode, identity.validationRunId)).filter(name => name.endsWith('.status.json')); } catch { /* absent */ }
    if (siblings.length) throw fail('RUN_STATUS_IDENTITY_MISMATCH', 'another persisted identity exists for this validation run');
    return null;
  }
  if (st.isSymbolicLink()) throw fail('RUN_STATUS_INVALID', 'status path is a symlink');
  const { bytes } = readFileNoFollowSymlink(target, MAX_STATUS_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw fail('RUN_STATUS_INVALID', 'status content is not valid JSON');
  }
  const status = assertStatus(parsed);
  if (status.runIdentitySha256 !== identity.runIdentitySha256 || status.configSha256 !== identity.configSha256 ||
      status.evaluationVersion !== identity.evaluationVersion || status.artifactMode !== identity.artifactMode) {
    throw fail('RUN_STATUS_IDENTITY_MISMATCH', 'persisted status does not match requested run identity');
  }
  return status;
}

// 独立于D7 artifact目录扫描run-status本身——一次从未发布过任何artifact的运行（比如第一批
// 还没跑完）必须仍然能被发现为RUNNING，不能依赖"先有已发布artifact才能定位validationRunId"
// （那样会漏掉"首次运行、尚无任何已发布产物"的场景）。只返回updatedAt最新的一条，与
// d8-artifact-discovery.js"只信任文件系统可观察的时间戳排序，不做内容层面的猜测排序"同一原则。
export function findMostRecentRunStatus(root, artifactMode) {
  const dir = statusDir(root, artifactMode);
  let runDirs;
  try { runDirs = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()); } catch { return null; }
  let best = null;
  for (const runDir of runDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    let files = [];
    try { files = fs.readdirSync(path.join(dir, runDir.name)).filter(name => name.endsWith('.status.json')).sort(); }
    catch { throw fail('RUN_STATUS_CORRUPT_CANDIDATE', 'run status directory cannot be read safely'); }
    for (const file of files) {
      let status;
      try {
        const { bytes } = readFileNoFollowSymlink(path.join(dir, runDir.name, file), MAX_STATUS_BYTES);
        status = assertStatus(JSON.parse(bytes.toString('utf8')));
        if (status.validationRunId !== runDir.name || file !== `${status.runIdentitySha256}.status.json` ||
            status.artifactMode !== artifactMode) throw fail('RUN_STATUS_CORRUPT_CANDIDATE', 'run status path identity mismatch');
      } catch (error) {
        if (error?.code === 'RUN_STATUS_CORRUPT_CANDIDATE') throw error;
        throw fail('RUN_STATUS_CORRUPT_CANDIDATE', 'run status candidate failed validation');
      }
      if (!best || new Date(status.updatedAt).getTime() > new Date(best.updatedAt).getTime()) best = status;
    }
  }
  return best;
}

// A malformed config cannot truthfully own a formal run identity.  Record it
// in a physically separate namespace with no caller content, database detail,
// or invented identity fields.  This is the fail-closed §2.5 boundary for
// attempts rejected before complete canonical identity construction.
export function writeRejectedResearchAttempt(root, reasonCode, { now = new Date().toISOString() } = {}) {
  if (!/^[A-Z0-9_]+$/.test(reasonCode || '') || new Date(now).toISOString() !== now) {
    throw fail('RUN_STATUS_REJECTED_ATTEMPT_INVALID', 'rejected attempt audit fields are invalid');
  }
  const dir = path.join(root, 'run-status', 'rejected-attempts');
  ensureDirectorySafe(dir, root);
  const attemptId = newLockId();
  const payload = {
    schemaVersion: 'v1.4d-rejected-research-attempt/1', attemptId, runState: 'FAILED',
    identityConstructed: false, reasonCode, createdAt: now
  };
  const target = path.join(dir, `${Date.parse(now)}.${attemptId}.rejected.json`);
  const temp = path.join(dir, `.${attemptId}.tmp`);
  writeTempFileDurable(temp, Buffer.from(canonicalJson(payload), 'utf8'));
  try { renameNoReplace(temp, target); }
  catch (error) { try { fs.unlinkSync(temp); } catch { /* best effort */ } throw error; }
  fsyncDirectory(dir);
  return Object.freeze(payload);
}

export function findMostRecentRejectedResearchAttempt(root) {
  const dir = path.join(root, 'run-status', 'rejected-attempts');
  let files;
  try { files = fs.readdirSync(dir).filter(name => name.endsWith('.rejected.json')).sort(); } catch { return null; }
  let latest = null;
  for (const file of files) {
    try {
      const payload = JSON.parse(readFileNoFollowSymlink(path.join(dir, file), 4096).bytes.toString('utf8'));
      if (payload?.schemaVersion !== 'v1.4d-rejected-research-attempt/1' || !/^[0-9a-f]{32}$/.test(payload.attemptId || '') ||
          payload.runState !== 'FAILED' || payload.identityConstructed !== false || !/^[A-Z0-9_]+$/.test(payload.reasonCode || '') ||
          new Date(payload.createdAt).toISOString() !== payload.createdAt || file !== `${Date.parse(payload.createdAt)}.${payload.attemptId}.rejected.json`) {
        throw new Error('invalid');
      }
      if (!latest || payload.createdAt > latest.createdAt) latest = payload;
    } catch { throw fail('RUN_STATUS_CORRUPT_CANDIDATE', 'rejected attempt audit failed validation'); }
  }
  return latest;
}

function readExactStatus(root, identity) {
  const target = statusPath(root, identity);
  const st = lstatIfExists(target);
  if (!st) return null;
  if (st.isSymbolicLink()) throw fail('RUN_STATUS_INVALID', 'status path is a symlink');
  const { bytes } = readFileNoFollowSymlink(target, MAX_STATUS_BYTES);
  try { return assertStatus(JSON.parse(bytes.toString('utf8'))); }
  catch (error) { if (error?.code) throw error; throw fail('RUN_STATUS_INVALID', 'status content is not valid JSON'); }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// P1-02 (round 2): the lock is published via an atomic hardlink-claim, not
// "mkdir a directory, then separately write a file inside it". A brand-new,
// uniquely-named temp file bound to a fresh ownerToken is written and fsynced
// to completion *first*; only then is it atomically linked onto `lockPath`
// (via renameNoReplace = linkSync+unlink, the same no-replace primitive the
// D7 artifact lock's own sidecar commit point uses). Because link() only
// ever attaches a *complete, already-durable* inode to the lockPath name,
// there is no filesystem state in which `lockPath` exists but is
// incomplete/mid-write -- it is always either fully absent or fully valid.
// This removes the observable "lock visible, owner evidence not yet formed"
// window that P0-02 exploited; it does not merely shrink it.
//
// P1-01: owner evidence must be bound to the host that wrote it, not just to
// a PID number. PID numbers have zero cross-host meaning, so any activeness
// judgement for a lock declared on a *different* host than the observer is
// fail-closed by construction (see isSameHostOwner/evaluateLockDisposition
// below): it is never auto-reclaimed no matter how old it looks locally.
function ownerContentFor(ownerToken) {
  return {
    ownerToken, pid: process.pid, processStartIdentity: processStartIdentity(),
    hostIdentitySha256: hostIdentitySha256(), createdAt: new Date().toISOString()
  };
}

// A "tombstone" is what a clean release() leaves behind: a schema-valid,
// self-describing marker that unambiguously means "vacated on purpose",
// distinct from a crashed/dead owner (which requires the age+liveness
// heuristics in classifyOwnerDisposition to become reclaimable). Written by
// the SAME safe verified-exchange primitive as everything else -- there is
// no separate "just unlink it" path anymore (see P0-04 fix rationale below).
function tombstoneContentFor(precedingOwnerToken) {
  return {
    ownerToken: newOwnerToken(), pid: process.pid, processStartIdentity: processStartIdentity(),
    hostIdentitySha256: hostIdentitySha256(), createdAt: new Date().toISOString(),
    released: true, precedingOwnerToken
  };
}

function isValidOwnerShape(owner) {
  return !!owner && typeof owner === 'object' &&
    /^[0-9a-f]{64}$/.test(owner.ownerToken || '') &&
    Number.isInteger(owner.pid) && owner.pid >= 1 &&
    typeof owner.processStartIdentity === 'string' &&
    /^[0-9a-f]{64}$/.test(owner.hostIdentitySha256 || '') &&
    typeof owner.createdAt === 'string' && Number.isFinite(new Date(owner.createdAt).getTime()) &&
    (owner.released === undefined || (owner.released === true &&
      (owner.precedingOwnerToken === null || typeof owner.precedingOwnerToken === 'string')));
}

// Reads the *published* lock (a regular file at lockPath -- never a
// directory: a directory at this path can only be a pre-fix legacy lock or
// an unknown/corrupted object, both handled by the isFile() check below).
function readPublishedLockOwner(lockPath) {
  const stat = fs.lstatSync(lockPath); // throws ENOENT if absent -- caller distinguishes
  if (stat.isSymbolicLink()) throw fail('RUN_STATUS_LOCK_INVALID', 'lock path is a symlink');
  if (!stat.isFile()) {
    // Covers the pre-fix directory-based lock format and any other unknown
    // object type. §四.9: legacy/unknown formats must fail closed and are
    // never auto-migrated, auto-quarantined, or auto-interpreted here.
    throw fail('RUN_STATUS_LOCK_INVALID', 'lock path is not a regular file (legacy or unknown format)');
  }
  let owner;
  try { owner = JSON.parse(readFileNoFollowSymlink(lockPath, 4096).bytes.toString('utf8')); }
  catch { throw fail('RUN_STATUS_LOCK_INVALID', 'lock content is not valid JSON'); }
  if (!isValidOwnerShape(owner)) throw fail('RUN_STATUS_LOCK_INVALID', 'lock content failed schema validation');
  return { stat, owner };
}

// P0-03/P0-04: reads owner content through an *already-open* file descriptor
// rather than re-opening by path. The fd stays pinned to the exact inode it
// was opened against regardless of what happens to the directory entry at
// that path afterwards (rename, unlink, replacement by an unrelated file all
// leave an already-open fd referring to the original inode) -- this is what
// lets destructive callers (quarantine, release) prove, right before they
// act, that the path still points at the *same object* they verified, and
// detect it immediately after if it does not.
function readOwnerFromFd(fd) {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) throw fail('RUN_STATUS_LOCK_INVALID', 'lock path is not a regular file (legacy or unknown format)');
  const buffer = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  let owner;
  try { owner = JSON.parse(buffer.subarray(0, offset).toString('utf8')); }
  catch { throw fail('RUN_STATUS_LOCK_INVALID', 'lock content is not valid JSON'); }
  if (!isValidOwnerShape(owner)) throw fail('RUN_STATUS_LOCK_INVALID', 'lock content failed schema validation');
  return { stat, owner };
}

function sameInode(a, b) {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino;
}

// A process-start identity string of the form `pid-only-<pid>` means the
// platform (documented in artifact-fs-primitives.js: anything without /proc,
// e.g. macOS) could not provide a real start-time disambiguator and silently
// degraded to a bare PID. Matching such a value proves nothing about PID
// reuse. This function makes that degradation an explicit, checked condition
// here rather than letting a coincidental string match imply a verified
// identity.
function hasReliableStartIdentity(value) {
  return typeof value === 'string' && !/^pid-only-/.test(value);
}

function isSameHostOwner(owner) {
  return owner.hostIdentitySha256 === hostIdentitySha256();
}

// Single source of truth for "what is this lock right now", used both to
// decide whether to attempt quarantine and, immediately before the rename
// itself, to re-confirm nothing has changed (TOCTOU requirement). Returns
// one of:
//   'gone'               - lock path no longer exists (raced away)
//   'active'              - same-host owner verified alive, or platform
//                            cannot reliably disambiguate PID reuse
//                            (fail closed: never auto-reclaim)
//   'active-cross-host'   - owner declared on a different host; cannot be
//                            disproven from here (fail closed)
//   'stale-with-owner'    - same-host owner, reliable start identity,
//                            confirmed not alive, past staleLockMs
// Any other outcome (lock content unreadable/corrupt/schema-invalid/legacy
// format/symlink) is *not* modeled as a disposition at all -- it throws.
// Under the atomic-publish protocol a published lockPath is always either
// fully absent or fully valid, so reaching an unreadable-but-present state
// means genuine corruption, tampering, or a pre-fix legacy leftover, none of
// which self-resolve by waiting. §四.6: never auto-quarantine on mtime alone
// for this case; return a stable, diagnosable, non-retryable error instead
// and require manual/governance intervention.
// Pure decision function: given owner content + the fstat it was read
// alongside, classify it. Deliberately takes no path -- callers that need to
// *act* destructively on the result (quarantine, release) must independently
// re-verify identity by inode immediately before acting (see below); this
// function only ever informs a decision, never anchors one.
function classifyOwnerDisposition(owner, stat, staleLockMs) {
  // A clean release leaves an explicit, unambiguous "vacated" marker --
  // unlike a crashed/dead owner, there is no liveness question to resolve
  // (no staleLockMs wait, no host/PID heuristics needed), so it is always
  // immediately reclaimable regardless of which host released it.
  if (owner.released === true) return { status: 'stale-with-owner', owner };
  const age = Date.now() - stat.mtimeMs;
  if (!isSameHostOwner(owner)) return { status: 'active-cross-host', owner };

  // A PID the OS confirms is not running at all is conclusively dead --
  // start-identity ambiguity (PID reuse) only matters for disambiguating a
  // *currently alive* PID from an unrelated process that happens to reuse
  // it. Checking processAlive() first avoids the trap where
  // processStartIdentity() itself degrades to the unreliable `pid-only-`
  // form for an already-exited PID (its /proc entry is gone), which would
  // otherwise be misread as "cannot determine" instead of "definitely dead".
  if (!processAlive(owner.pid)) {
    return { status: age >= staleLockMs ? 'stale-with-owner' : 'active', owner };
  }
  const localStartIdentity = processStartIdentity(owner.pid);
  const reliableStartIdentity = hasReliableStartIdentity(owner.processStartIdentity) && hasReliableStartIdentity(localStartIdentity);
  if (!reliableStartIdentity) {
    // Same host, PID currently alive, but this platform cannot reliably
    // distinguish the original owner from an unrelated process that later
    // reused the same PID. Explicit fail-closed: never treat as stale on
    // this evidence alone.
    return { status: 'active', owner };
  }
  // PID alive under a *different* start identity than recorded: the original
  // owner is gone and this PID number was reused by an unrelated process.
  const sameProcess = localStartIdentity === owner.processStartIdentity;
  if (age >= staleLockMs && !sameProcess) return { status: 'stale-with-owner', owner };
  return { status: 'active', owner };
}

// Path-based wrapper used by non-destructive callers (acquireStatusLock's
// "should I wait or attempt quarantine" decision). Fine to be path-based
// here because nothing is mutated on this result alone -- the destructive
// act (quarantinePublishedLock) independently re-verifies by inode.
function evaluateLockDisposition(lockPath, staleLockMs) {
  let evidence;
  try { evidence = readPublishedLockOwner(lockPath); }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'gone' };
    throw error;
  }
  return classifyOwnerDisposition(evidence.owner, evidence.stat, staleLockMs);
}

// P0-03/P0-04 (round 3, CEO-authorized "方案B", refined after independent
// review found the round-2 single-exchange design insufficient): displacing
// an existing lock object is now always done in two independently-verified
// atomic steps, never one.
//
// Round 2's flaw, exactly as independent review identified it: quarantine
// and release both published an immediately-reclaimable object (a
// `released:true` tombstone) as the very first exchange's candidate. The
// instant that exchange committed, lockPath held that tombstone --
// classifyOwnerDisposition() correctly treats any `released:true` object as
// unconditionally reclaimable (right for a genuinely completed release, but
// wrong as a transient intermediate state) -- so a legitimate third owner
// could win a real RENAME_EXCHANGE against that tombstone before our own
// post-exchange verification/undo ever ran. Our "undo" (a second exchange
// assuming lockPath still held what we had just put there) would then rip
// that third owner's brand-new claim back out. "lockPath was never
// observably absent" was true and is *not* the relevant safety property --
// the bug was never about absence, it was about publishing a *reclaimable*
// object during a window where we had not yet committed to the outcome. We
// do not rely on that "never absent" framing as a safety argument anywhere
// below; it is necessary (an exchange primitive gives it for free) but not
// sufficient.
//
// The fix: the *first* exchange's candidate is never reclaimable by a
// correct competitor. It is a `reservation` -- an object with exactly the
// same shape as a genuine freshly-claimed lock (ownerContentFor(), the same
// content acquireStatusLock's own direct-claim uses below), bound to this
// process's real, live, current identity, with its own distinct ownerToken.
// classifyOwnerDisposition() has no special case for it and needs none: to
// every other caller it is indistinguishable from an entirely ordinary
// active lock, so the existing "active | active-cross-host -> wait, never
// steal" rule already in acquireStatusLock refuses to touch it, for the same
// reason it refuses to touch any other live lock. *That* -- "the object
// sitting at lockPath during the vulnerable window is never one a correct
// competitor is willing to exchange against" -- is the actual safety
// argument this fix rests on.
//
// Only after the reservation's own displaced-object verification has passed
// (proving we really did displace what we intended to: a confirmed-stale
// owner for quarantine, or our own still-current lock for release) does a
// *second*, separately-verified exchange convert that reservation into the
// true final tombstone. That second exchange's own post-exchange check
// proves what it displaced really was our own reservation (identified by its
// own distinct ownerToken) before treating the conversion as complete --
// never assumed just because the first exchange succeeded.
//
// If the process crashes between the two exchanges, no special recovery
// logic is needed or written: the abandoned reservation is a completely
// ordinary owner record and is reclaimed by the exact same age/host/PID/
// start-identity staleness rules any other dead lock is, via the normal
// acquireStatusLock path -- it cannot deadlock the run identity.
//
// acquireStatusLock's own direct-claim exchange (below) needs no
// reserve/finalize split at all: its single exchange's candidate *is already*
// the final active claim, never a reclaimable object, so it was already safe
// under the same "never reclaimable" argument even in round 2.
//
// Both exchanges go through the same exchangeAndVerify primitive:
// renameat2(RENAME_EXCHANGE) so lockPath is never observably absent, and the
// displaced object is read back through our own private, CSPRNG-named path
// that no other process has ever heard of. `hooks` here is always
// `{ reserve, finalize }`, each independently accepting
// `{ beforeExchange, afterExchange }` -- test-only, same-process synchronous
// injection points; production callers never pass them. `afterExchange`
// fires immediately after the atomic syscall commits, before this function
// reads back or judges what it displaced -- the precise post-exchange,
// pre-verification window independent review required be directly testable.
function exchangeCandidatePathFor(lockPath) {
  return `${lockPath}.exchange.${newOwnerToken()}`;
}

function prepareCandidate(candidatePath, content) {
  const bytes = Buffer.from(canonicalJson(content), 'utf8');
  writeTempFileDurable(candidatePath, bytes); // O_CREAT|O_EXCL|O_NOFOLLOW + write + fsync
  let readBack;
  try { readBack = fs.readFileSync(candidatePath); } catch { readBack = null; }
  if (!readBack || !readBack.equals(bytes)) {
    try { fs.unlinkSync(candidatePath); } catch { /* best effort cleanup of our own file only */ }
    throw fail('RUN_STATUS_LOCK_PUBLISH_FAILED', 'prepared lock evidence failed self-verification before use');
  }
}

function discardCandidate(candidatePath) {
  // Always our own private, never-shared path -- safe to remove
  // unconditionally; nothing else can ever have a reason to reference it.
  try { fs.unlinkSync(candidatePath); } catch { /* best effort */ }
}

// The single primitive every exchange (reserve or finalize, in either
// quarantine or release, or acquireStatusLock's own direct claim) is built
// from. `candidatePath` must already hold fully-formed, self-verified
// content (see prepareCandidate). `acceptDisplaced(owner, stat)` decides,
// from what was *actually* displaced (read back through our own private
// path, immune to further tampering), whether the exchange should stand.
// Returns `{ exchanged: true }` on success (lockPath now holds our
// candidate; candidatePath now holds the displaced object, not yet
// discarded -- caller inspects/discards it).
//
// On rejection (the read-back failed, or acceptDisplaced returned false),
// this function does *not* decide what to do -- it calls
// `onRejected({ displacedOwner, displacedStat, readError })` and returns (or
// throws) whatever that callback does. This split exists because "is it safe
// to swap back?" depends entirely on whether the *candidate we just
// exchanged in* was reclaimable by a correct competitor during the window
// between the syscall and this verification -- and that differs by caller:
//   - A reservation or a direct active claim (acquireStatusLock's own
//     candidate) is *not* reclaimable: nothing else could have touched
//     lockPath in the interim, so undoing is unconditionally safe and
//     restores exactly what was there. Callers with this property pass an
//     `onRejected` that calls undoExchange.
//   - A tombstone (the finalize step) *is* reclaimable by design -- the
//     moment it lands at lockPath, a legitimate third owner may already have
//     exchanged it away for their own claim before this function ever gets
//     here. Blindly swapping lockPath's *current* contents back in that case
//     would tear that legitimate claim back out -- this is the exact defect
//     independent review found in round 2 (there, applied to the reserve
//     step publishing a tombstone directly; here it is the same trap
//     reachable through finalize's own rejection path if it naively reused
//     the same undo). Callers with this property (see
//     finalizeReservationAsTombstone) must *not* call undoExchange -- they
//     may only leave lockPath alone and surface a loud diagnostic.
function exchangeAndVerify(lockPath, dir, candidatePath, acceptDisplaced, onRejected, hooks = {}) {
  if (!renameat2.available) {
    throw fail('RUN_STATUS_ATOMIC_EXCHANGE_UNAVAILABLE',
      `renameat2(RENAME_EXCHANGE) is required to safely displace an existing lock and is not available: ${renameat2.getUnavailableReason()}`);
  }
  hooks.beforeExchange?.();
  try {
    renameat2.renameExchangeSync(candidatePath, lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { exchanged: false, reason: 'gone' };
    throw error;
  }
  hooks.afterExchange?.();

  // candidatePath now holds whatever was previously at lockPath. Nothing
  // else can have touched candidatePath, ever -- its name is derived from a
  // CSPRNG token nobody else has seen -- so this read is definitive, not
  // advisory.
  let displacedStat, displacedOwner, readError = null;
  try {
    const fd = fs.openSync(candidatePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { ({ stat: displacedStat, owner: displacedOwner } = readOwnerFromFd(fd)); }
    finally { fs.closeSync(fd); }
  } catch (error) {
    readError = error;
  }

  if (readError || !acceptDisplaced(displacedOwner, displacedStat)) {
    return onRejected({ displacedOwner, displacedStat, readError });
  }

  fsyncDirectory(dir);
  return { exchanged: true, displacedOwner, displacedStat };
}

// Only ever safe to call when the exchanged-in candidate was itself
// non-reclaimable across the whole window since the exchange committed (see
// exchangeAndVerify's doc comment) -- reserve and acquireStatusLock's direct
// claim, never finalize. If the undo itself fails (e.g. the addon becomes
// unavailable mid-sequence, which should not happen but is not assumed
// away), that is surfaced loudly rather than silently leaving the displaced
// object stranded and unlogged.
function undoExchange(candidatePath, lockPath, dir) {
  try {
    renameat2.renameExchangeSync(candidatePath, lockPath);
    fsyncDirectory(dir);
  } catch (error) {
    throw fail('RUN_STATUS_LOCK_EXCHANGE_UNDO_FAILED',
      `failed to restore displaced lock object after a failed verification (it remains intact, un-deleted, at ${candidatePath}): ${error.message}`);
  }
}

// Shared rejection handler for exchanges whose candidate is provably
// non-reclaimable (reserve; acquireStatusLock's direct claim): swap back
// (unconditionally safe here) and report failure without silently
// swallowing a corrupt/unreadable displaced object.
function undoAndReportRejected(candidatePath, lockPath, dir, { readError }) {
  undoExchange(candidatePath, lockPath, dir);
  if (readError) throw fail('RUN_STATUS_LOCK_QUARANTINE_IDENTITY_CHANGED', `displaced lock object failed verification: ${readError.message}`);
  return { exchanged: false, reason: 'identity-mismatch' };
}

// Phase 1 of quarantine/release: install a reservation (ownerContentFor() --
// indistinguishable from an ordinary fresh claim, hence non-reclaimable by
// any correct competitor) and verify, via the exchange's own private-path
// readback, that what it displaced was really what the caller expected.
// `acceptDisplaced` is the caller-specific check (confirmed-stale owner for
// quarantine; our own still-current lock for release). Returns the
// exchangeAndVerify result plus the reservation's own ownerToken, which
// finalizeReservationAsTombstone needs to verify its own displaced object.
function reserveOverLock(lockPath, dir, acceptDisplaced, hooks = {}) {
  const reservationToken = newOwnerToken();
  const reservePath = exchangeCandidatePathFor(lockPath);
  prepareCandidate(reservePath, ownerContentFor(reservationToken));
  const result = exchangeAndVerify(lockPath, dir, reservePath, acceptDisplaced,
    rejection => undoAndReportRejected(reservePath, lockPath, dir, rejection), hooks);
  discardCandidate(reservePath);
  return { ...result, reservationToken };
}

// Phase 2: convert our own just-installed, currently-live (therefore
// non-reclaimable by any correct competitor) reservation into the true final
// tombstone. Independently verifies what this second exchange displaced was
// really our own reservation, by its distinct ownerToken -- never assumed
// just because phase 1 succeeded.
//
// Unlike reserveOverLock, rejection here does *not* undo (see
// exchangeAndVerify's doc comment for why: the tombstone this step just
// published is, by design, immediately reclaimable, so lockPath's current
// contents may already belong to a legitimate third owner by the time this
// runs). If what we displaced was not our own reservation, that is an
// invariant violation -- something outside this operation's own two
// exchanges touched our supposedly-untouchable reservation before we could
// finalize it, which should be impossible under the protocol -- and it is
// surfaced as a loud, distinct, thrown error rather than papered over as an
// ordinary "operation returned false" outcome (the tombstone's publication
// itself is not, and cannot safely be, retracted).
function finalizeReservationAsTombstone(lockPath, dir, reservationToken, precedingOwnerToken, hooks = {}) {
  const tombstonePath = exchangeCandidatePathFor(lockPath);
  prepareCandidate(tombstonePath, tombstoneContentFor(precedingOwnerToken));
  const onRejected = ({ displacedOwner, readError }) => {
    discardCandidate(tombstonePath);
    throw fail('RUN_STATUS_LOCK_FINALIZE_IDENTITY_VIOLATION', readError
      ? `reservation finalize displaced an unreadable/invalid object instead of its own reservation (protocol invariant violated): ${readError.message}`
      : `reservation finalize displaced ownerToken=${displacedOwner?.ownerToken} instead of its own reservation ${reservationToken} ` +
        '(protocol invariant violated) -- lockPath left untouched and not rolled back, because by this point it may already hold a legitimately reclaimed owner');
  };
  const result = exchangeAndVerify(lockPath, dir, tombstonePath, owner => owner.ownerToken === reservationToken, onRejected, hooks);
  discardCandidate(tombstonePath);
  return result;
}

// P0-03: displaces a confirmed-stale published lock with a clean tombstone
// (does not claim ownership for the caller -- see acquireStatusLock below
// for the more efficient direct-claim variant used on the normal acquire
// path). Exposed directly (via quarantinePublishedLockForTest) so this
// exact operation is independently testable. `hooks` = `{ reserve, finalize }`.
function quarantinePublishedLock(lockPath, dir, staleLockMs, hooks = {}) {
  let disposition;
  try { disposition = evaluateLockDisposition(lockPath, staleLockMs); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (disposition.status !== 'stale-with-owner') return false; // advisory only; the reserve exchange's post-check is the real gate

  const reserved = reserveOverLock(lockPath, dir,
    (owner, stat) => classifyOwnerDisposition(owner, stat, staleLockMs).status === 'stale-with-owner',
    hooks.reserve);
  if (!reserved.exchanged) return false;

  const finalized = finalizeReservationAsTombstone(lockPath, dir, reserved.reservationToken, null, hooks.finalize);
  return finalized.exchanged;
}

function acquireStatusLock(dir, identity, { lockTimeoutMs = 5_000, staleLockMs = 30_000 } = {}) {
  const lockPath = path.join(dir, `.${identity.runIdentitySha256}.status.lock`);
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
    const ownerToken = newOwnerToken();
    const claimPath = path.join(dir, `.${identity.runIdentitySha256}.status.lock.tmp.${ownerToken}`);
    prepareCandidate(claimPath, ownerContentFor(ownerToken));

    // Bootstrap: only ever succeeds the very first time this identity's
    // lockPath is claimed (link()-no-replace requires the target to be
    // absent). Every subsequent claim -- including immediately after a
    // clean release, which leaves a tombstone rather than removing
    // lockPath -- goes through the exchange path below instead.
    try {
      renameNoReplace(claimPath, lockPath);
      fsyncDirectory(dir);
      return { lockPath, ownerToken, dir };
    } catch (error) {
      if (!(error.code === 'ARTIFACT_RENAME_FAILED' && error.cause === 'EEXIST')) {
        discardCandidate(claimPath);
        throw error; // unexpected failure: fail closed, do not fall back to a weaker protocol
      }
      // lockPath already exists (live lock, dead lock, or tombstone) -- fall
      // through and reuse this already-prepared, already-verified claim for
      // an exchange-based attempt below.
    }

    let disposition;
    try { disposition = evaluateLockDisposition(lockPath, staleLockMs); }
    catch (error) {
      discardCandidate(claimPath);
      if (error.code === 'ENOENT') continue; // raced away between our EEXIST and now
      // Unreadable/corrupt/legacy-format published lock: never auto-recovered
      // by mtime alone (§四.6). Propagate immediately as a stable,
      // diagnosable, non-timeout error rather than retry-looping toward one.
      throw error;
    }
    if (disposition.status === 'gone') { discardCandidate(claimPath); continue; }
    if (disposition.status !== 'stale-with-owner') {
      // 'active' | 'active-cross-host': cannot prove this lock is safe to
      // reclaim right now -- wait for it, never steal it.
      discardCandidate(claimPath);
      if (Date.now() >= deadline) throw fail('RUN_STATUS_LOCK_TIMEOUT', 'timed out acquiring run status lock');
      sleepSync(Math.min(10, Math.max(1, deadline - Date.now())));
      continue;
    }

    const result = exchangeAndVerify(lockPath, dir, claimPath,
      (owner, stat) => classifyOwnerDisposition(owner, stat, staleLockMs).status === 'stale-with-owner',
      rejection => undoAndReportRejected(claimPath, lockPath, dir, rejection));
    if (!result.exchanged) {
      discardCandidate(claimPath);
      if (Date.now() >= deadline) throw fail('RUN_STATUS_LOCK_TIMEOUT', 'timed out acquiring run status lock');
      sleepSync(Math.min(10, Math.max(1, deadline - Date.now())));
      continue;
    }
    // Success: lockPath now holds OUR claim (installed atomically by the
    // exchange, already fully formed before the exchange ever ran);
    // claimPath now holds the confirmed-stale object we displaced.
    discardCandidate(claimPath);
    return { lockPath, ownerToken, dir };
  }
}

// P0-04: release no longer unlinks lockPath at all, and no longer publishes
// a reclaimable object as its first move either (see the design-rationale
// comment above quarantinePublishedLock). It reserves over its own current
// lock first -- verifying, through the reservation exchange's own private-
// path readback, that what it displaced really was still our own lock --
// and only then finalizes that reservation into a tombstone, independently
// verified as displacing our own reservation and nothing else. `hooks` =
// `{ reserve, finalize }`.
function releaseStatusLock(dir, lock, hooks = {}) {
  if (!renameat2.available) {
    // Deliberately do not fall back to a path-based unlink here -- that is
    // exactly the TOCTOU this fix closes. Fail closed with a stable,
    // diagnosable error instead; the lock remains held (from every other
    // observer's perspective) until a human resolves the missing addon.
    throw fail('RUN_STATUS_ATOMIC_EXCHANGE_UNAVAILABLE',
      `renameat2(RENAME_EXCHANGE) is required to safely release a lock and is not available: ${renameat2.getUnavailableReason()}`);
  }
  const reserved = reserveOverLock(lock.lockPath, dir, owner => owner.ownerToken === lock.ownerToken, hooks.reserve);
  if (!reserved.exchanged) return false;

  const finalized = finalizeReservationAsTombstone(lock.lockPath, dir, reserved.reservationToken, lock.ownerToken, hooks.finalize);
  return finalized.exchanged;
}

export function acquireResearchRunStatusLock(root, runIdentity, options = {}) {
  const identity = assertResearchRunIdentity(runIdentity);
  const dir = runStatusDir(root, identity.artifactMode, identity.validationRunId);
  ensureDirectorySafe(dir, root);
  return acquireStatusLock(dir, identity, options);
}

export function releaseResearchRunStatusLock(lock) {
  return releaseStatusLock(lock.dir, lock);
}

// Test-only seams (see research-run-status-concurrency.test.js): identical
// to the exported functions above, but allow passing a synchronous `hooks`
// object to deterministically inject an adversarial filesystem change at the
// last possible moment before the actual atomic renameat2(RENAME_EXCHANGE)
// syscall, without relying on wall-clock timing or process scheduling. No
// production call path constructs or passes `hooks`.
export function quarantinePublishedLockForTest(lockPath, dir, staleLockMs, hooks) {
  return quarantinePublishedLock(lockPath, dir, staleLockMs, hooks);
}
export function releaseResearchRunStatusLockForTest(lock, hooks) {
  return releaseStatusLock(lock.dir, lock, hooks);
}

function assertMonotonicTransition(current, next) {
  if (!current) {
    // Recovery/import tools may persist an already-derived terminal snapshot,
    // but an identity can only be created once and subsequent updates are
    // governed by the monotonic transition rules below.
    return;
  }
  if (current.runIdentitySha256 !== next.runIdentitySha256) throw fail('RUN_STATUS_IDENTITY_MISMATCH', 'status identity changed');
  if (canonicalJson(current) === canonicalJson(next)) return;
  if (next.revision !== current.revision + 1) throw fail('RUN_STATUS_STALE_UPDATE', 'status update was built from a stale revision');
  const allowed = current.runState === 'RUNNING' && ['RUNNING', 'BLOCKED', 'FAILED', 'COMPLETED'].includes(next.runState) ||
    ['BLOCKED', 'FAILED'].includes(current.runState) && next.runState === 'COMPLETED';
  if (!allowed) throw fail('RUN_STATUS_ILLEGAL_TRANSITION', `${current.runState} cannot transition to ${next.runState}`);
  if (next.completedBatchIndices.length < current.completedBatchIndices.length ||
      canonicalJson(next.completedBatchIndices.slice(0, current.completedBatchIndices.length)) !== canonicalJson(current.completedBatchIndices) ||
      canonicalJson(next.batchCheckpoints.slice(0, current.batchCheckpoints.length)) !== canonicalJson(current.batchCheckpoints)) {
    throw fail('RUN_STATUS_ILLEGAL_TRANSITION', 'checkpoint progress cannot move backwards');
  }
}

export function writeRunStatus(root, status, lockOptions = {}) {
  assertStatus(status);
  const dir = runStatusDir(root, status.artifactMode, status.validationRunId);
  ensureDirectorySafe(dir, root);
  const identity = assertResearchRunIdentity(status);
  const lock = acquireStatusLock(dir, identity, lockOptions);
  let tempPath = null;
  try {
    const current = readExactStatus(root, identity);
    // Publication is the irreversible commit point.  If a concurrent failure
    // snapshot won the status lock during the narrow artifact->COMPLETED gap,
    // promote the verified COMPLETED candidate to the latest revision instead
    // of leaving a safely published artifact labelled FAILED/BLOCKED.
    const candidate = current && status.runState === 'COMPLETED' && current.runState !== 'COMPLETED'
      ? assertStatus({ ...status, revision: current.revision + 1 }) : status;
    assertMonotonicTransition(current, candidate);
    if (current && canonicalJson(current) === canonicalJson(candidate)) return current;
    const bytes = Buffer.from(canonicalJson(candidate), 'utf8');
    tempPath = path.join(dir, `.${status.validationRunId}.status.json.tmp.${process.pid}.${newLockId()}`);
    writeTempFileDurable(tempPath, bytes);
    renameAllowCreate(tempPath, statusPath(root, status));
    tempPath = null;
    fsyncDirectory(dir);
    return candidate;
  } finally {
    if (tempPath) try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    releaseStatusLock(dir, lock);
  }
}

export function initialRunStatus({ runIdentity, totalBatches, now = new Date().toISOString() }) {
  const identity = assertResearchRunIdentity(runIdentity);
  return assertStatus({
    schemaVersion: SCHEMA_VERSION, ...identity, revision: 0, runState: 'RUNNING',
    totalBatches, completedBatchIndices: [], batchCheckpoints: [], blockedReasonCode: null,
    publishedArtifactSha256: null, updatedAt: now
  });
}

export function withBatchPlan(status, totalBatches, { now = new Date().toISOString() } = {}) {
  if (status.completedBatchIndices.length || !Number.isInteger(totalBatches) || totalBatches < 1) {
    throw fail('RUN_STATUS_CHECKPOINT_INCONSISTENT', 'batch plan can only be established before the first checkpoint');
  }
  return assertStatus({ ...status, revision: status.revision + 1, totalBatches, updatedAt: now });
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
  return assertStatus({ ...status, revision: status.revision + 1, completedBatchIndices, batchCheckpoints, runState: allDone ? status.runState : 'RUNNING', updatedAt: now });
}

export function withBlocked(status, blockedReasonCode, { now = new Date().toISOString() } = {}) {
  return assertStatus({ ...status, revision: status.revision + 1, runState: 'BLOCKED', blockedReasonCode, updatedAt: now });
}

export function withCompleted(status, { publishedArtifactSha256, now = new Date().toISOString() } = {}) {
  return assertStatus({ ...status, revision: status.revision + 1, runState: 'COMPLETED', blockedReasonCode: null, publishedArtifactSha256, updatedAt: now });
}

export function withFailed(status, blockedReasonCode, { now = new Date().toISOString() } = {}) {
  return assertStatus({ ...status, revision: status.revision + 1, runState: 'FAILED', blockedReasonCode, updatedAt: now });
}

export const RUN_STATUS_SCHEMA_VERSION = SCHEMA_VERSION;
