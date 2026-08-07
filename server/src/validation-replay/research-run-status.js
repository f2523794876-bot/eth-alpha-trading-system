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

function isValidOwnerShape(owner) {
  return !!owner && typeof owner === 'object' &&
    /^[0-9a-f]{64}$/.test(owner.ownerToken || '') &&
    Number.isInteger(owner.pid) && owner.pid >= 1 &&
    typeof owner.processStartIdentity === 'string' &&
    /^[0-9a-f]{64}$/.test(owner.hostIdentitySha256 || '') &&
    typeof owner.createdAt === 'string' && Number.isFinite(new Date(owner.createdAt).getTime());
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
function evaluateLockDisposition(lockPath, staleLockMs) {
  let evidence;
  try { evidence = readPublishedLockOwner(lockPath); }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'gone' };
    throw error;
  }
  const { stat, owner } = evidence;
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

// Moves a confirmed-stale *published* lock file out of the way using plain
// POSIX rename(), not link+unlink: for this direction (one known existing
// source, racing reclaimers) rename() is the correct exclusive primitive --
// the first rename to execute atomically detaches the source, so a second
// reclaimer's rename on the same (now-gone) source cleanly fails ENOENT.
// (link+unlink would be wrong here: multiple processes could each
// successfully link the same still-existing source to their own distinct
// destination name before either unlinks it, defeating exclusivity -- that
// primitive is only exclusive on its shared *destination*, which publish
// uses lockPath for, not quarantine.)
function quarantinePublishedLock(lockPath, dir, staleLockMs) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    // TOCTOU guard: re-evaluate immediately before touching the lock. If a
    // legitimate owner has since (re)appeared and is no longer stale by the
    // same rule, abort without renaming anything.
    let recheck;
    try { recheck = evaluateLockDisposition(lockPath, staleLockMs); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (recheck.status !== 'stale-with-owner') return false;
    const quarantinePath = `${lockPath}.stale.${newLockId()}`;
    try {
      fs.renameSync(lockPath, quarantinePath);
    } catch (error) {
      if (error.code === 'ENOENT') return false; // another reclaimer already won
      if (error.code === 'EEXIST') continue; // quarantine name collision (negligible with 128-bit ids); retry with a new one
      throw error;
    }
    fsyncDirectory(dir);
    try { fs.unlinkSync(quarantinePath); } catch { /* best effort; leftover quarantine file blocks nothing */ }
    fsyncDirectory(dir);
    return true;
  }
  throw fail('RUN_STATUS_LOCK_QUARANTINE_COLLISION', 'status lock quarantine retries exhausted');
}

function acquireStatusLock(dir, identity, { lockTimeoutMs = 5_000, staleLockMs = 30_000 } = {}) {
  const lockPath = path.join(dir, `.${identity.runIdentitySha256}.status.lock`);
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
    const ownerToken = newOwnerToken();
    const tempPath = path.join(dir, `.${identity.runIdentitySha256}.status.lock.tmp.${ownerToken}`);
    const owner = ownerContentFor(ownerToken);
    const bytes = Buffer.from(canonicalJson(owner), 'utf8');
    writeTempFileDurable(tempPath, bytes); // O_CREAT|O_EXCL|O_NOFOLLOW + write + fsync, see artifact-fs-primitives.js
    // Re-read and re-validate the prepared evidence before it can ever become
    // visible at lockPath -- defense against a corrupted write reaching a
    // position where any other process could observe it as "the" lock.
    let readBack;
    try { readBack = JSON.parse(fs.readFileSync(tempPath, 'utf8')); } catch { readBack = null; }
    if (!isValidOwnerShape(readBack) || canonicalJson(readBack) !== canonicalJson(owner)) {
      try { fs.unlinkSync(tempPath); } catch { /* best effort cleanup of our own temp file only */ }
      throw fail('RUN_STATUS_LOCK_PUBLISH_FAILED', 'prepared owner evidence failed self-verification before publish');
    }

    try {
      renameNoReplace(tempPath, lockPath); // atomic hardlink-claim: the ONE step that makes the lock visible, already fully formed
      fsyncDirectory(dir);
      return { lockPath, ownerToken, dir };
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch { /* best effort cleanup of our own temp file only */ }
      if (!(error.code === 'ARTIFACT_RENAME_FAILED' && error.cause === 'EEXIST')) throw error; // unexpected failure: fail closed, do not fall back to a weaker protocol
      // lockPath already exists -- fall through to evaluate it below.
    }

    let disposition;
    try { disposition = evaluateLockDisposition(lockPath, staleLockMs); }
    catch (error) {
      if (error.code === 'ENOENT') continue; // raced away between our EEXIST and now
      // Unreadable/corrupt/legacy-format published lock: never auto-recovered
      // by mtime alone (§四.6). Propagate immediately as a stable,
      // diagnosable, non-timeout error rather than retry-looping toward one.
      throw error;
    }
    if (disposition.status === 'gone') continue; // another contender already reclaimed and cleared it
    if (disposition.status === 'stale-with-owner') {
      quarantinePublishedLock(lockPath, dir, staleLockMs);
      continue; // whether we won the race or lost it, re-evaluate from scratch
    }
    // 'active' | 'active-cross-host': cannot prove this lock is safe to
    // reclaim right now -- wait for it, never steal it.
    if (Date.now() >= deadline) throw fail('RUN_STATUS_LOCK_TIMEOUT', 'timed out acquiring run status lock');
    sleepSync(Math.min(10, Math.max(1, deadline - Date.now())));
  }
}

function releaseStatusLock(dir, lock) {
  let owner;
  try { owner = JSON.parse(readFileNoFollowSymlink(lock.lockPath, 4096).bytes.toString('utf8')); }
  catch { return false; }
  if (owner.ownerToken !== lock.ownerToken) return false;
  try {
    fs.unlinkSync(lock.lockPath);
    fsyncDirectory(dir);
    return true;
  } catch {
    return false;
  }
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
