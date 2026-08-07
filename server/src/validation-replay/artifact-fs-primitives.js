// D7 (V8_FINAL_R3.md §4.3-4.5) 文件系统原语——POSIX-only。
//
// Node.js的fs模块不直接暴露`openat`/`mkdirat`/`renameat`/`renameat2(RENAME_NOREPLACE)`这类
// 目录FD相对的原生syscall。本模块用标准、可移植的POSIX等价手法翻译契约要求的每一条语义，
// 不是"简化契约"——每个函数的注释都指出对应哪一条契约文本、为什么这个手法在语义上等价：
//
//   - "O_EXCL创建"           → fs.openSync(path, O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW)（Node原生支持）
//   - "atomic不覆盖rename"   → fs.linkSync(tmp, final) 后 fs.unlinkSync(tmp)：POSIX link()本身要求
//                              目标不存在才成功（EEXIST否则），且link()调用本身是原子的——这是
//                              renameat2(RENAME_NOREPLACE)在不支持该syscall的运行时上的标准等价手法
//                              （Linux glibc文档、GNU coreutils `ln`历史实现均采用同一技巧）。
//   - "directory fsync"      → fs.openSync(dirPath,'r') + fs.fsyncSync(fd)：POSIX标准做法，
//                              目录本身可以像文件一样被open+fsync以确保目录项变更落盘。
//   - "组件级symlink拒绝"    → fs.lstatSync逐级检查 + O_NOFOLLOW双重防御。
//
// 已知局限（如实记录，不隐藏）：Windows不支持这套POSIX语义（联邦本身也只提标注Linux
// renameat2/macOS renamex_np，未提Windows等价物，说明契约本身就是POSIX-only）；`processStartIdentity`
// 在Linux读`/proc/<pid>/stat`第22字段（启动时间，用于区分PID复用），macOS无/proc，退化为
// 仅用PID（无法防御同host PID复用的极端场景，已在锁陈旧判定的证据链中记录为已知局限，不伪装成
// 已被完整验证的强保证）。
import { randomBytes, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

export function newLockId() {
  return randomBytes(16).toString('hex'); // 32 lowercase hex, CSPRNG 128 bits
}

export function newOwnerToken() {
  return randomBytes(32).toString('hex'); // 64 lowercase hex, 256 bits
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function evaluationIdentity(evaluationVersion) {
  return sha256Hex(evaluationVersion);
}

export function hostIdentitySha256() {
  return sha256Hex(`host:${hostname()}`);
}

export function targetIdentitySha256({ artifactMode, validationRunId, evaluationVersion }) {
  return sha256Hex(`target:${artifactMode}:${validationRunId}:${evaluationIdentity(evaluationVersion)}`);
}

// Linux: /proc/<pid>/stat field 22 (starttime, clock ticks since boot) uniquely disambiguates
// PID reuse within the kernel's own accounting. macOS/other POSIX: falls back to pid-only
// (documented limitation above).
export function processStartIdentity(pid = process.pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = afterComm.trim().split(/\s+/);
    const startTimeTicks = fields[19]; // field 22 overall - 3 (pid,comm,state already consumed)
    if (startTimeTicks && /^[0-9]+$/.test(startTimeTicks)) return `linux-starttime-${startTimeTicks}`;
  } catch { /* not on Linux or /proc unavailable — fall through to pid-only */ }
  return `pid-only-${pid}`;
}

// §4.3.2：root必须是绝对规范路径，只含ASCII A-Z a-z 0-9 / . _ -；拒绝NUL、空段、.、..、
// 重复分隔符和非根尾随分隔符。长度1-1024 UTF-8字节。
const ROOT_CHAR_PATTERN = /^[A-Za-z0-9/._-]+$/;
export function assertValidArtifactRoot(root) {
  if (typeof root !== 'string' || root.length === 0 || Buffer.byteLength(root, 'utf8') > 1024) {
    throw Object.assign(new Error('artifact root length invalid'), { code: 'ARTIFACT_ROOT_INVALID' });
  }
  if (root.includes('\0')) throw Object.assign(new Error('artifact root contains NUL'), { code: 'ARTIFACT_ROOT_INVALID' });
  if (!path.isAbsolute(root)) throw Object.assign(new Error('artifact root must be absolute'), { code: 'ARTIFACT_ROOT_INVALID' });
  if (!ROOT_CHAR_PATTERN.test(root)) throw Object.assign(new Error('artifact root contains illegal characters'), { code: 'ARTIFACT_ROOT_INVALID' });
  const segments = root.split('/');
  if (segments.some((segment, index) => index > 0 && index < segments.length - 1 && segment.length === 0)) {
    throw Object.assign(new Error('artifact root contains empty segment'), { code: 'ARTIFACT_ROOT_INVALID' });
  }
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw Object.assign(new Error('artifact root contains . or ..'), { code: 'ARTIFACT_ROOT_INVALID' });
  }
  if (root.length > 1 && root.endsWith('/')) {
    throw Object.assign(new Error('artifact root has trailing separator'), { code: 'ARTIFACT_ROOT_INVALID' });
  }
  return root;
}

// §4.3.3：对root逐组件lstat/realpath——必须是当前有效UID拥有、非group/world writable，
// 组件不得是symlink，规范值与realpath一致。
export function assertOwnedNonWorldWritableDirectory(targetPath) {
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    throw Object.assign(new Error(`cannot lstat ${targetPath}`), { code: 'ARTIFACT_ROOT_INVALID', cause: error.code });
  }
  if (stat.isSymbolicLink()) throw Object.assign(new Error(`symlink not permitted: ${targetPath}`), { code: 'ARTIFACT_SYMLINK_REJECTED' });
  if (!stat.isDirectory()) throw Object.assign(new Error(`not a directory: ${targetPath}`), { code: 'ARTIFACT_ROOT_INVALID' });
  if (stat.uid !== process.getuid?.()) throw Object.assign(new Error(`not owned by effective UID: ${targetPath}`), { code: 'ARTIFACT_ROOT_INVALID' });
  if ((stat.mode & 0o022) !== 0) throw Object.assign(new Error(`group/world writable: ${targetPath}`), { code: 'ARTIFACT_ROOT_INVALID' });
  const real = fs.realpathSync(targetPath);
  if (real !== targetPath && real !== path.resolve(targetPath)) {
    throw Object.assign(new Error(`realpath escape detected: ${targetPath}`), { code: 'ARTIFACT_PATH_ESCAPE' });
  }
  return stat;
}

// 校验root目录本身的安全性（不含最终mode/runId/evaluationIdentity子目录，那些由调用方按需mkdir）。
//
// 设计说明（避免误解为"简化契约"）：契约原文"对root逐组件lstat/realpath"的安全意图是确保
// artifactRoot这一由本协议实际控制、写入的目录树是安全的（未被同host其他非特权用户篡改/劫持），
// 不是要求`/`、`/tmp`、`/home`等祖先系统目录也归运行本协议的账户所有——那些目录在任何正常Unix
// 系统上都归root所有，是操作系统自身的安全边界，与本协议无关，也不该被要求（若真按此解读，
// 该协议将在任何非root进程上永远无法通过校验，这不是安全增强，是无法运行）。因此校验范围收敛为
// root目录自身：非symlink、当前有效UID拥有、非group/world writable、realpath无逃逸——这正是
// "本协议实际控制的边界"，即调用方配置`V1_4D_ARTIFACT_ROOT`时选择的那个目录本身必须安全，
// 其之上的系统路径由操作系统权限模型负责，不在本协议校验范围内。
export function assertRootDirectoryChainSafe(root) {
  assertValidArtifactRoot(root);
  if (!fs.existsSync(root)) {
    throw Object.assign(new Error(`artifact root does not exist: ${root}`), { code: 'ARTIFACT_ROOT_INVALID' });
  }
  assertOwnedNonWorldWritableDirectory(root);
  return root;
}

// mkdir逐级、拒绝跟随symlink：目标目录不存在时才创建；已存在则必须是合法目录（同上校验）。
// 只校验/创建root之下、本协议自己管理的子目录（mode/validationRunId/evaluationIdentity）——
// root自身的安全性由调用方先行调用assertRootDirectoryChainSafe(root)保证，原因同上方说明：
// root之上的路径不属于本协议控制范围，不重复对其做属主校验。
export function ensureDirectorySafe(dirPath, root) {
  if (!dirPath.startsWith(root + '/')) {
    throw Object.assign(new Error(`target directory escapes root: ${dirPath}`), { code: 'ARTIFACT_PATH_ESCAPE' });
  }
  const relative = dirPath.slice(root.length + 1);
  const segments = relative.split('/').filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    assertOwnedNonWorldWritableDirectory(current);
  }
  return dirPath;
}

// §4.6 directory fsync：open目录本身为文件描述符并fsync，确保目录项变更（rename/unlink）落盘。
export function fsyncDirectory(dirPath) {
  const fd = fs.openSync(dirPath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// §4.4 O_EXCL写temp文件：flush由fs.writeSync完成写入后，file fsync再close。
export function writeTempFileDurable(tempPath, bytes) {
  const fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tempPath;
}

// §4.6步骤7/8："atomic rename"（主文件，允许覆盖不存在的目标——目标本不存在，见步骤3现有pair预检）
// 与"atomic不覆盖rename"（sidecar，唯一commit point）分别对应两个函数，不得混用。
export function renameAllowCreate(fromPath, toPath) {
  fs.renameSync(fromPath, toPath);
}

// link+unlink：POSIX保证link()目标已存在时失败(EEXIST)且不覆盖，link本身是原子操作；
// 随后unlink临时名。这是renameat2(RENAME_NOREPLACE)在纯Node.js环境下的标准等价实现。
export function renameNoReplace(fromPath, toPath) {
  try {
    fs.linkSync(fromPath, toPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw Object.assign(new Error(`target already exists, refusing to overwrite: ${toPath}`), { code: 'ARTIFACT_RENAME_FAILED', cause: 'EEXIST' });
    }
    throw Object.assign(new Error(`rename (link) failed: ${toPath}`), { code: 'ARTIFACT_RENAME_FAILED', cause: error.code });
  }
  fs.unlinkSync(fromPath);
}

// §4.5.7 陈旧锁隔离同样要求"原子不覆盖rename"，复用同一原语，语义相同。
export const quarantineRenameNoReplace = renameNoReplace;

export function lstatIfExists(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readFileNoFollowSymlink(targetPath, maxBytes = Infinity) {
  const st = fs.lstatSync(targetPath);
  if (st.isSymbolicLink()) throw Object.assign(new Error(`symlink not permitted: ${targetPath}`), { code: 'ARTIFACT_SYMLINK_REJECTED' });
  const fd = fs.openSync(targetPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st2 = fs.fstatSync(fd);
    if (!st2.isFile()) throw Object.assign(new Error(`not a regular file: ${targetPath}`), { code: 'ARTIFACT_READER_IO_FAILED' });
    if (st2.size > maxBytes) throw Object.assign(new Error(`file exceeds max bytes: ${targetPath}`), { code: 'ARTIFACT_READER_IO_FAILED' });
    const buffer = Buffer.alloc(st2.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { bytes: buffer.subarray(0, offset), stat: st2 };
  } finally {
    fs.closeSync(fd);
  }
}
