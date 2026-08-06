// D7 完整主artifact字节确定性 —— T18（V8_FINAL_R3.md §4全节）。
//
// 实现§4.6冻结的12步发布顺序，唯一commit point固定为：正式sidecar从其临时文件原子rename至
// research-artifact.sha256.json并成功返回的瞬间（步骤8）。步骤7前必须已保证主文件完整+file
// fsync+Schema/canonical/身份PASS+主rename后directory fsync PASS；步骤8前必须已保证sidecar
// 完整+file fsync+Schema PASS+记录正确完整主SHA。
//
// 已知平台局限（如实记录，见artifact-fs-primitives.js顶部说明）：Node.js无法直接调用
// renameat2(RENAME_NOREPLACE)/openat等目录FD相对syscall，本实现用POSIX标准等价手法
// （link+unlink实现原子不覆盖rename、open目录fd做directory fsync、O_NOFOLLOW+lstat做symlink
// 防御）逐条翻译契约语义，不是简化或重新解释契约。未经过验证的部分：真实多进程并发竞争、
// kill -9硬中断、断电场景下的fsync持久性——这些需要专门的故障注入基础设施，单进程沙箱环境
// 无法真实复现，已在测试报告中如实区分"已验证"与"结构正确但未经硬件级故障注入验证"。
import path from 'node:path';
import fs from 'node:fs';
import { canonicalJson, canonicalSha256 } from '../formal-research/canonical-json.js';
import { SchemaValidationError } from '../formal-research/schema-registry.js';
import {
  newLockId, newOwnerToken, hostIdentitySha256, targetIdentitySha256, evaluationIdentity,
  assertRootDirectoryChainSafe, ensureDirectorySafe, fsyncDirectory, writeTempFileDurable,
  renameAllowCreate, renameNoReplace, lstatIfExists, readFileNoFollowSymlink, processStartIdentity
} from './artifact-fs-primitives.js';
import { readArtifactPair, MAIN_FILE_NAME, SIDECAR_FILE_NAME } from './artifact-reader.js';
import {
  artifactSchemaRegistry as registry, ARTIFACT_SCHEMA_ID, SIDECAR_SCHEMA_ID, LOCK_SCHEMA_ID, PUBLISH_RESULT_SCHEMA_ID
} from './artifact-schema-registry.js';

export { LOCK_SCHEMA_ID, PUBLISH_RESULT_SCHEMA_ID };

const LOCK_FILE_NAME = '.research-artifact.lock';
const LOCK_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_LOCK_BYTES = 4096;

function fail(reasonCode, message, extra) {
  return Object.assign(new Error(message || reasonCode), { code: reasonCode, ...(extra || {}) });
}

function publishResult({ operationStatus, reasonCode = 'NONE', postPublishStatus = 'NOT_APPLICABLE', postPublishCode = 'NONE', runtimeEvents }) {
  const result = { operationStatus, reasonCode, postPublishStatus, postPublishCode, runtimeEvents };
  registry.validate(PUBLISH_RESULT_SCHEMA_ID, result);
  return Object.freeze(result);
}

function tempName(baseName, pid, lockId) {
  return `.${baseName}.tmp.${pid}.${lockId}`;
}

function targetDirFor({ root, artifactMode, validationRunId, evaluationVersion }) {
  const mode = artifactMode === 'FORMAL' ? 'formal' : 'dry-run';
  return path.join(root, mode, validationRunId, evaluationIdentity(evaluationVersion));
}

// §4.5：读取现有固定锁（若有），判断是否"活跃"。返回null表示无锁或已被证明陈旧且已隔离。
function inspectExistingLock(lockPath, { targetIdentity, staleLockRecovery }) {
  const st = lstatIfExists(lockPath);
  if (!st) return { state: 'ABSENT' };
  if (st.isSymbolicLink()) throw fail('ARTIFACT_LOCK_INVALID', 'lock path is a symlink');
  if (!st.isFile() || st.size > MAX_LOCK_BYTES) throw fail('ARTIFACT_LOCK_INVALID', 'lock is not a bounded regular file');
  let lockObj;
  try {
    const { bytes } = readFileNoFollowSymlink(lockPath, MAX_LOCK_BYTES);
    lockObj = JSON.parse(bytes.toString('utf8'));
    registry.validate(LOCK_SCHEMA_ID, lockObj);
  } catch (error) {
    if (error instanceof SchemaValidationError || error instanceof SyntaxError) throw fail('ARTIFACT_LOCK_INVALID', 'lock content invalid');
    throw error;
  }
  const now = Date.now();
  const leaseExpired = new Date(lockObj.leaseExpiresAt).getTime() <= now;
  const sameHost = lockObj.hostIdentitySha256 === hostIdentitySha256();
  const currentStartIdentity = processStartIdentity(lockObj.pid);
  const pidAlive = sameHost && processIsAlive(lockObj.pid) && currentStartIdentity === lockObj.processStartIdentity;
  if (!leaseExpired || pidAlive) return { state: 'ACTIVE', lock: lockObj };
  if (!staleLockRecovery) return { state: 'ACTIVE', lock: lockObj }; // 证据不全/未授权时按活跃对待，fail closed
  if (!sameHost || lockObj.ownerUid !== process.getuid?.()) return { state: 'ACTIVE', lock: lockObj };
  return { state: 'STALE', lock: lockObj, evidence: { bytesSha256: canonicalSha256_raw(lockObj), inode: st.ino, device: st.dev, size: st.size, mtimeMs: st.mtimeMs } };
}

function canonicalSha256_raw(obj) {
  return canonicalSha256(obj);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists but owned by another user — still "alive" for our purposes
  }
}

function quarantineStaleLock(lockPath, dirPath, existing) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const quarantineId = newLockId();
    const quarantinePath = path.join(dirPath, `.research-artifact.lock.stale.${quarantineId}`);
    try {
      renameNoReplace(lockPath, quarantinePath);
      fsyncDirectory(dirPath);
      return { quarantinePath, quarantineId };
    } catch (error) {
      if (error.code !== 'ARTIFACT_RENAME_FAILED') throw error;
      if (attempt === 15) throw fail('ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION', 'quarantine retries exhausted');
    }
  }
  throw fail('ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION', 'unreachable');
}

function acquireLock({ root, targetDir, artifactMode, validationRunId, evaluationVersion, lockTimeoutMs, staleLockRecovery }) {
  const lockPath = path.join(targetDir, LOCK_FILE_NAME);
  const targetIdentity = targetIdentitySha256({ artifactMode, validationRunId, evaluationVersion });
  const deadline = Date.now() + lockTimeoutMs;
  let backoffMs = 10;
  const events = [];
  for (;;) {
    const inspection = inspectExistingLock(lockPath, { targetIdentity, staleLockRecovery });
    if (inspection.state === 'STALE') {
      const { quarantineId } = quarantineStaleLock(lockPath, targetDir, inspection);
      events.push('ARTIFACT_STALE_LOCK_QUARANTINED');
      void quarantineId;
      continue; // 隔离后重新尝试
    }
    if (inspection.state === 'ACTIVE') {
      if (Date.now() >= deadline) throw fail('ARTIFACT_LOCK_TIMEOUT', 'timed out waiting for active lock', { events });
      events.push('ARTIFACT_LOCK_WAITING');
      busyWaitMs(Math.min(backoffMs, Math.max(0, deadline - Date.now())));
      backoffMs = Math.min(backoffMs * 2, 2000);
      continue;
    }
    // ABSENT：尝试O_EXCL创建
    const lockId = newLockId();
    const ownerToken = newOwnerToken();
    const acquiredAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + lockTimeoutMs).toISOString();
    const lockObj = {
      schemaVersion: 'v1.4d-artifact-lock/2', lockId, ownerToken, targetIdentitySha256: targetIdentity,
      hostIdentitySha256: hostIdentitySha256(), pid: process.pid, processStartIdentity: processStartIdentity(),
      ownerUid: process.getuid?.() ?? 0, acquiredAt, leaseExpiresAt
    };
    registry.validate(LOCK_SCHEMA_ID, lockObj);
    try {
      writeTempFileDurable(lockPath, Buffer.from(canonicalJson(lockObj), 'utf8'));
    } catch (error) {
      if (error.code === 'EEXIST') continue; // 竞态：别的进程刚创建，重新走一轮inspect
      throw fail('ARTIFACT_LOCK_ACQUIRE_FAILED', 'failed to create lock file', { cause: error.code });
    }
    fsyncDirectory(targetDir);
    events.push('ARTIFACT_LOCK_ACQUIRED');
    return { lockPath, lockId, ownerToken, events };
  }
}
function busyWaitMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* deliberately synchronous: publish() itself is sync end-to-end per fsync ordering requirements */ }
}

function releaseLock(lockPath, { lockId, ownerToken }, targetDir) {
  const st = lstatIfExists(lockPath);
  if (!st || st.isSymbolicLink()) return { released: false, reason: 'ARTIFACT_LOCK_INVALID' };
  try {
    const { bytes } = readFileNoFollowSymlink(lockPath, MAX_LOCK_BYTES);
    const current = JSON.parse(bytes.toString('utf8'));
    if (current.lockId !== lockId || current.ownerToken !== ownerToken) return { released: false, reason: 'ARTIFACT_LOCK_OWNERSHIP_LOST' };
    fs.unlinkSync(lockPath);
    fsyncDirectory(targetDir);
    return { released: true };
  } catch {
    return { released: false, reason: 'POST_PUBLISH_LOCK_RELEASE_FAILED' };
  }
}

// 主入口。同步执行（fsync排序要求严格串行，不引入伪并发）。
export function publishArtifact(options) {
  const {
    root, artifactMode, validationRunId, evaluationVersion, core, manifestContentHash, validationRunFinishedAt,
    lockTimeoutMs = 60000, staleLockRecovery = false
  } = options;
  const events = [];
  assertRootDirectoryChainSafe(root);
  const targetDir = targetDirFor({ root, artifactMode, validationRunId, evaluationVersion });

  // 步骤0：候选构造+Schema/一致性预验证（只读，未commit，0发布写入）。
  const artifactObj = {
    schemaVersion: 'v1.4d-formal-research-artifact/2',
    artifactMode,
    core,
    deterministicProvenance: {
      canonicalization: 'RFC8785', encoding: 'UTF-8', trailingNewline: false,
      timeSource: 'VALIDATION_RUN_FINISHED_AT', validationRunFinishedAt, manifestContentHash
    }
  };
  let mainBytesText;
  try {
    mainBytesText = canonicalJson(artifactObj);
    registry.validate(ARTIFACT_SCHEMA_ID, artifactObj);
  } catch (error) {
    events.push('ARTIFACT_PUBLISH_FAILED');
    return publishResult({ operationStatus: 'FAILED', reasonCode: error instanceof SchemaValidationError ? 'ARTIFACT_SCHEMA_INVALID' : 'ARTIFACT_CANONICALIZATION_FAILED', runtimeEvents: events });
  }
  const fullMainArtifactSha256 = canonicalSha256(artifactObj);
  const sidecarObj = {
    schemaVersion: 'v1.4d-artifact-sidecar/1', mainFileName: MAIN_FILE_NAME, canonicalization: 'RFC8785',
    encoding: 'UTF-8', trailingNewline: false, fullMainArtifactSha256, mainArtifactSchemaVersion: artifactObj.schemaVersion,
    artifactMode, validationRunId, evaluationVersion
  };
  let sidecarBytesText;
  try {
    sidecarBytesText = canonicalJson(sidecarObj);
    registry.validate(SIDECAR_SCHEMA_ID, sidecarObj);
  } catch {
    events.push('ARTIFACT_PUBLISH_FAILED');
    return publishResult({ operationStatus: 'FAILED', reasonCode: 'ARTIFACT_SCHEMA_INVALID', runtimeEvents: events });
  }
  events.push('ARTIFACT_PREFLIGHT_PASSED');

  ensureDirectorySafe(targetDir, root);

  // 步骤3：只读检查现有正式pair。
  const existing = readArtifactPair(targetDir);
  if (existing.readerStatus === 'ACCEPTED') {
    if (existing.sidecar.fullMainArtifactSha256 === fullMainArtifactSha256) {
      events.push('ARTIFACT_REUSED_IDENTICAL');
      return publishResult({ operationStatus: 'REUSED_IDENTICAL', postPublishStatus: 'COMPLETE', runtimeEvents: events });
    }
    events.push('ARTIFACT_PUBLISH_FAILED');
    return publishResult({ operationStatus: 'FAILED', reasonCode: 'ARTIFACT_CONTENT_CONFLICT', runtimeEvents: events });
  }
  if (existing.readerReasonCode === 'ARTIFACT_PAIR_INCOMPLETE') {
    events.push('ARTIFACT_PUBLISH_FAILED');
    return publishResult({ operationStatus: 'FAILED', reasonCode: 'ARTIFACT_RECOVERY_REQUIRED', runtimeEvents: events });
  }
  // ARTIFACT_NOT_FOUND：正常路径，继续发布。

  // 步骤4：获取固定锁。
  let lockHandle;
  try {
    lockHandle = acquireLock({ root, targetDir, artifactMode, validationRunId, evaluationVersion, lockTimeoutMs, staleLockRecovery });
    events.push(...lockHandle.events);
  } catch (error) {
    events.push('ARTIFACT_PUBLISH_FAILED');
    return publishResult({ operationStatus: 'FAILED', reasonCode: error.code || 'ARTIFACT_LOCK_ACQUIRE_FAILED', runtimeEvents: events });
  }

  try {
    // 步骤5：O_EXCL写主temp→file fsync→回读逐byte重验。
    const mainTempPath = path.join(targetDir, tempName(MAIN_FILE_NAME, process.pid, lockHandle.lockId));
    const mainBytes = Buffer.from(mainBytesText, 'utf8');
    writeTempFileDurable(mainTempPath, mainBytes);
    const mainReread = readFileNoFollowSymlink(mainTempPath, mainBytes.length + 1);
    if (!mainReread.bytes.equals(mainBytes)) {
      events.push('ARTIFACT_PUBLISH_FAILED');
      return publishResult({ operationStatus: 'FAILED', reasonCode: 'ARTIFACT_TEMP_VERIFY_FAILED', runtimeEvents: events });
    }
    events.push('ARTIFACT_TEMP_MAIN_DURABLE');

    // 步骤6：O_EXCL写sidecar temp→file fsync→回读并重验。
    const sidecarTempPath = path.join(targetDir, tempName(SIDECAR_FILE_NAME, process.pid, lockHandle.lockId));
    const sidecarBytes = Buffer.from(sidecarBytesText, 'utf8');
    writeTempFileDurable(sidecarTempPath, sidecarBytes);
    const sidecarReread = readFileNoFollowSymlink(sidecarTempPath, sidecarBytes.length + 1);
    if (!sidecarReread.bytes.equals(sidecarBytes)) {
      events.push('ARTIFACT_PUBLISH_FAILED');
      return publishResult({ operationStatus: 'FAILED', reasonCode: 'ARTIFACT_TEMP_VERIFY_FAILED', runtimeEvents: events });
    }
    events.push('ARTIFACT_TEMP_SIDECAR_DURABLE');

    // 步骤7：主文件atomic rename（允许创建，目标此刻已确认不存在）+ directory fsync。
    const mainFinalPath = path.join(targetDir, MAIN_FILE_NAME);
    try {
      renameAllowCreate(mainTempPath, mainFinalPath);
    } catch {
      events.push('ARTIFACT_PUBLISH_FAILED');
      return publishResult({ operationStatus: 'FAILED', reasonCode: 'ARTIFACT_RENAME_FAILED', runtimeEvents: events });
    }
    fsyncDirectory(targetDir);
    events.push('ARTIFACT_MAIN_RENAMED', 'ARTIFACT_MAIN_DIRECTORY_SYNCED');

    // 步骤8：sidecar原子不覆盖rename——唯一commit point。
    const sidecarFinalPath = path.join(targetDir, SIDECAR_FILE_NAME);
    try {
      renameNoReplace(sidecarTempPath, sidecarFinalPath);
    } catch {
      // rename失败：main-only，未commit。
      events.push('ARTIFACT_PUBLISH_FAILED');
      return publishResult({ operationStatus: 'FAILED', reasonCode: 'ARTIFACT_RENAME_FAILED', runtimeEvents: events });
    }
    events.push('ARTIFACT_SIDECAR_RENAMED', 'ARTIFACT_SIDECAR_RENAME_COMMIT_POINT', 'ARTIFACT_COMMIT_POINT_REACHED');
    // === COMMIT POINT 已越过：此后任何失败都不得改判FAILED，只能是PUBLISHED + post-publish ERROR/WARNING。===

    let postPublishStatus = 'COMPLETE';
    let postPublishCode = 'NONE';

    // 步骤9：对目标目录directory fsync。
    try {
      fsyncDirectory(targetDir);
      events.push('ARTIFACT_PAIR_DIRECTORY_SYNCED');
    } catch {
      postPublishStatus = 'ERROR'; postPublishCode = 'POST_PUBLISH_DIRECTORY_FSYNC_FAILED';
      events.push('ARTIFACT_POST_PUBLISH_DIRECTORY_FSYNC_FAILED');
    }

    // 步骤10：发布器独立重新回读正式路径（不复用候选内存）。
    if (postPublishStatus === 'COMPLETE') {
      events.push('ARTIFACT_POST_PUBLISH_REREAD_STARTED');
      const reread = readArtifactPair(targetDir);
      if (reread.readerStatus !== 'ACCEPTED') {
        postPublishStatus = 'ERROR';
        postPublishCode = {
          ARTIFACT_READER_IO_FAILED: 'POST_PUBLISH_REREAD_IO_FAILED',
          ARTIFACT_SCHEMA_INVALID: 'POST_PUBLISH_REREAD_SCHEMA_FAILED',
          ARTIFACT_CANONICALIZATION_FAILED: 'POST_PUBLISH_REREAD_CANONICAL_FAILED',
          ARTIFACT_HASH_MISMATCH: 'POST_PUBLISH_REREAD_HASH_MISMATCH',
          ARTIFACT_IDENTITY_MISMATCH: 'POST_PUBLISH_REREAD_IDENTITY_MISMATCH',
          ARTIFACT_PAIR_INCOMPLETE: 'POST_PUBLISH_REREAD_IO_FAILED',
          ARTIFACT_NOT_FOUND: 'POST_PUBLISH_REREAD_IO_FAILED'
        }[reread.readerReasonCode] || 'POST_PUBLISH_REREAD_IO_FAILED';
        events.push(`ARTIFACT_${postPublishCode.slice('POST_PUBLISH_'.length)}`);
      } else {
        events.push('ARTIFACT_POST_PUBLISH_REREAD_COMPLETED', 'ARTIFACT_READER_VALIDATED');
      }
    }

    // 步骤11/12：完成审计（仅runtime events，无独立持久化审计存储——本实现审计即PublishResult本身
    // 与调用方负责持久化的runtimeEvents数组，见governance-statistics.js/orchestrator落盘方式）+ 释放锁。
    const releaseResult = releaseLock(lockHandle.lockPath, lockHandle, targetDir);
    if (!releaseResult.released) {
      if (postPublishStatus === 'COMPLETE') { postPublishStatus = 'WARNING'; postPublishCode = 'POST_PUBLISH_LOCK_RELEASE_FAILED'; }
      events.push('ARTIFACT_LOCK_RELEASE_FAILED');
    } else {
      events.push('ARTIFACT_LOCK_RELEASED');
    }

    events.push('ARTIFACT_PUBLISH_COMPLETED');
    return publishResult({ operationStatus: 'PUBLISHED', postPublishStatus, postPublishCode, runtimeEvents: events });
  } catch (error) {
    // 任何在commit point(步骤8成功)之前抛出的未预期异常都是FAILED；commit之后的异常理论上已被
    // 上面的try/catch各自捕获为post-publish ERROR/WARNING，不应再落到这里——保留作为最后防线，
    // 但必须先检查sidecar是否已经存在，避免把"commit之后的未知错误"误判为FAILED。
    const alreadyCommitted = lstatIfExists(path.join(targetDir, SIDECAR_FILE_NAME)) !== null;
    if (alreadyCommitted) {
      events.push('ARTIFACT_POST_PUBLISH_WARNING');
      return publishResult({ operationStatus: 'PUBLISHED', postPublishStatus: 'WARNING', postPublishCode: 'POST_PUBLISH_AUDIT_COMPLETION_FAILED', runtimeEvents: events });
    }
    events.push('ARTIFACT_PUBLISH_FAILED');
    return publishResult({ operationStatus: 'FAILED', reasonCode: error.code || 'ARTIFACT_RECOVERY_REQUIRED', runtimeEvents: events });
  }
}
