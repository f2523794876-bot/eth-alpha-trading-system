import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireResearchRunStatusLock, createResearchRunIdentity, initialRunStatus, readRunStatus,
  releaseResearchRunStatusLock, releaseResearchRunStatusLockForTest, quarantinePublishedLockForTest,
  writeRunStatus, withBatchCompleted, withFailed
} from './research-run-status.js';
import { canonicalJson } from '../formal-research/canonical-json.js';
import { hostIdentitySha256, processStartIdentity } from './artifact-fs-primitives.js';

const childPath = fileURLToPath(new URL('./fixtures/run-status-writer-child.mjs', import.meta.url));
function root() { return mkdtempSync(path.join(os.tmpdir(), 'run-status-cas-')); }
function identity(validationRunId = randomUUID(), evaluationVersion = 'eval-1') {
  return createResearchRunIdentity({ validationRunId, evaluationVersion, artifactMode: 'DRY_RUN', config: {
    gitObjectFormat: 'SHA1', sourceIdentity: 'MODULE_TEST', sourceVersion: 'v1.4d-test-config/1', sourceCommit: '1'.repeat(40), datasetVersion: `v1.4d-sha256-${'2'.repeat(64)}`,
    featureEngineVersion: 'feature-1', thresholds: { test: true },
    algorithmVersion: 'v1.4c-server-po-rule-1', ruleVersion: 'rule-1', weightVersion: 'weight-1', evaluationVersion,
    horizons: ['24h', '72h'], researchFrom: '2025-01-01T00:00:00.000Z', researchTo: '2025-07-01T00:00:00.000Z',
    fixedAsOf: '2025-07-04T00:00:00.000Z'
  } });
}
function seeded(rootPath, runIdentity) {
  let status = initialRunStatus({ runIdentity, totalBatches: 1 });
  status = withBatchCompleted(status, 0, { checkpoint: { batchIndex: 0, rowCount: 0, cursor: null, sha256: '3'.repeat(64) } });
  writeRunStatus(rootPath, status);
  return status;
}
function child(rootPath, identityPath, action, startAt) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [childPath, rootPath, identityPath, action, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', value => { stdout += value; });
    proc.stderr.on('data', value => { stderr += value; });
    proc.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function lockChild(rootPath, identityPath, action) {
  const proc = spawn(process.execPath, [childPath, rootPath, identityPath, action, String(Date.now())],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const ready = new Promise((resolve, reject) => {
    proc.stdout.on('data', value => {
      stdout += value;
      const line = stdout.split('\n').find(Boolean);
      if (line) { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } }
    });
    proc.stderr.on('data', value => { stderr += value; });
    proc.once('error', reject);
  });
  const closed = new Promise(resolve => proc.on('close', code => resolve({ code, stdout, stderr })));
  return { proc, ready, closed };
}

for (const loser of ['FAILED', 'BLOCKED']) test(`真实双Node进程：COMPLETED与${loser}竞争时COMPLETED单调胜出`, async () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    seeded(rootPath, runIdentity);
    const identityPath = path.join(rootPath, 'identity.json');
    writeFileSync(identityPath, JSON.stringify(runIdentity));
    const startAt = Date.now() + 250;
    const results = await Promise.all([child(rootPath, identityPath, 'COMPLETED', startAt), child(rootPath, identityPath, loser, startAt)]);
    assert.deepEqual(results.map(value => value.code), [0, 0], JSON.stringify(results));
    assert.equal(readRunStatus(rootPath, runIdentity).runState, 'COMPLETED');
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

// 本测试的期望结果在本轮(P1-02第二次修复)被有意改变：legacy目录式锁格式现在必须fail
// closed（见四.9），不再被仅凭mtime自动隔离/接管。旧版本这里断言RUNNING(自愈成功)，
// 现在断言抛出RUN_STATUS_LOCK_INVALID——这是本轮授权明确要求的行为变更，不是回归。
test('legacy目录式锁(修复前格式)必须fail closed，不得被mtime自动隔离/接管', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const status = initialRunStatus({ runIdentity, totalBatches: 1 });
    const dir = path.join(rootPath, 'run-status', 'dry-run', runIdentity.validationRunId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = path.join(dir, `.${runIdentity.runIdentitySha256}.status.lock`);
    mkdirSync(lock, { mode: 0o700 }); // legacy directory-based lock shape
    const ownerToken = randomBytes(32).toString('hex');
    writeFileSync(path.join(lock, `owner.${ownerToken}.json`), JSON.stringify({
      ownerToken, pid: 99999999, processStartIdentity: processStartIdentity(99999999), createdAt: new Date(0).toISOString()
    }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    assert.throws(() => writeRunStatus(rootPath, status, { lockTimeoutMs: 1_000, staleLockMs: 10 }),
      error => error.code === 'RUN_STATUS_LOCK_INVALID');
    assert.equal(existsSync(lock), true, 'legacy格式不得被自动删除/迁移，需人工治理');
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

test('不同run identity锁隔离，终态禁止FAILED回退RUNNING', () => {
  const rootPath = root();
  try {
    const first = identity(), second = identity();
    const firstDir = path.join(rootPath, 'run-status', 'dry-run', first.validationRunId);
    mkdirSync(path.join(firstDir, `.${first.runIdentitySha256}.status.lock`), { recursive: true, mode: 0o700 });
    writeRunStatus(rootPath, initialRunStatus({ runIdentity: second, totalBatches: 1 }));
    let failed = initialRunStatus({ runIdentity: identity(), totalBatches: 1 });
    writeRunStatus(rootPath, failed);
    failed = withFailed(failed, 'EXPECTED_FAILURE');
    writeRunStatus(rootPath, failed);
    assert.throws(() => writeRunStatus(rootPath, { ...failed, revision: failed.revision + 1, runState: 'RUNNING', blockedReasonCode: null }),
      error => error.code === 'RUN_STATUS_ILLEGAL_TRANSITION');
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

test('真实独立Node子进程：活跃但超龄owner不可被接管', async () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const identityPath = path.join(rootPath, 'identity.json');
    writeFileSync(identityPath, JSON.stringify(runIdentity));
    const holder = lockChild(rootPath, identityPath, 'LOCK_HOLD');
    const ready = await holder.ready;
    const old = new Date(Date.now() - 60_000);
    utimesSync(ready.lockPath, old, old);
    assert.throws(() => writeRunStatus(rootPath, initialRunStatus({ runIdentity, totalBatches: 1 }),
      { lockTimeoutMs: 120, staleLockMs: 10 }), error => error.code === 'RUN_STATUS_LOCK_TIMEOUT');
    holder.proc.stdin.write('RELEASE\n');
    assert.equal((await holder.closed).code, 0);
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

test('真实独立Node子进程：崩溃持锁者超过阈值后可安全恢复', async () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const identityPath = path.join(rootPath, 'identity.json');
    writeFileSync(identityPath, JSON.stringify(runIdentity));
    const holder = lockChild(rootPath, identityPath, 'LOCK_CRASH');
    const ready = await holder.ready;
    assert.equal((await holder.closed).code, 77);
    const old = new Date(Date.now() - 60_000);
    utimesSync(ready.lockPath, old, old);
    const written = writeRunStatus(rootPath, initialRunStatus({ runIdentity, totalBatches: 1 }),
      { lockTimeoutMs: 1_000, staleLockMs: 10 });
    assert.equal(written.runState, 'RUNNING');
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

test('真实独立Node子进程：两个恢复者竞争最多一个状态更新成功', async () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    seeded(rootPath, runIdentity);
    const identityPath = path.join(rootPath, 'identity.json');
    writeFileSync(identityPath, JSON.stringify(runIdentity));
    const holder = lockChild(rootPath, identityPath, 'LOCK_CRASH');
    const ready = await holder.ready;
    await holder.closed;
    const old = new Date(Date.now() - 60_000);
    utimesSync(ready.lockPath, old, old);
    const startAt = Date.now() + 200;
    const results = await Promise.all([child(rootPath, identityPath, 'FAILED', startAt), child(rootPath, identityPath, 'BLOCKED', startAt)]);
    assert.deepEqual(results.map(value => value.code), [0, 0], JSON.stringify(results));
    const payloads = results.map(value => JSON.parse(value.stdout));
    assert.equal(payloads.filter(value => value.state).length, 1);
    assert.equal(payloads.filter(value => value.rejected).length, 1);
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

test('真实独立Node子进程：旧owner迟到release不得删除新owner锁', async () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const identityPath = path.join(rootPath, 'identity.json');
    writeFileSync(identityPath, JSON.stringify(runIdentity));
    const holder = lockChild(rootPath, identityPath, 'LOCK_HOLD');
    const ready = await holder.ready;
    const displaced = `${ready.lockPath}.displaced`;
    renameSync(ready.lockPath, displaced);
    const replacement = acquireResearchRunStatusLock(rootPath, runIdentity);
    holder.proc.stdin.write('RELEASE\n');
    const result = await holder.closed;
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).released, false);
    assert.equal(existsSync(replacement.lockPath), true, '迟到release不得删除replacement lock');
    assert.equal(releaseResearchRunStatusLock(replacement), true);
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// P1-01 / P1-02 第二轮修复回归测试：原子hardlink-claim发布协议
// （董事长/CEO授权的范围受控修复，见交付报告）
//
// 锁的磁盘形态已从"mkdir目录+目录内单独owner文件"改为"单个常规文件，通过
// writeTempFileDurable(临时文件)+renameNoReplace(linkSync原子claim)一次性
// 发布"。lockPath 现在要么完全不存在，要么已经是完整、通过Schema校验的内容
// ——不再存在"目录已可见但内容未形成"的中间态。以下测试直接构造这个新形态。
// ---------------------------------------------------------------------------

function lockPathFor(rootPath, runIdentity) {
  const dir = path.join(rootPath, 'run-status', 'dry-run', runIdentity.validationRunId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, lockPath: path.join(dir, `.${runIdentity.runIdentitySha256}.status.lock`) };
}
function age(targetPath, ms) {
  const old = new Date(Date.now() - ms);
  utimesSync(targetPath, old, old);
}
// 直接构造一个"已发布"的正式锁文件（不经过acquire，用于精确控制owner内容/mtime）。
function publishRawLock(lockPath, content) {
  writeFileSync(lockPath, content);
}
function validOwnerJson(overrides = {}) {
  return canonicalJson({
    ownerToken: 'a'.repeat(64), pid: 99999999, processStartIdentity: 'linux-starttime-1',
    hostIdentitySha256: hostIdentitySha256(), createdAt: new Date().toISOString(), ...overrides
  });
}
function slowPublishChild(rootPath, identityPath, delayMs) {
  const proc = spawn(process.execPath, [childPath, rootPath, identityPath, 'SLOW_PUBLISH', String(Date.now()), String(delayMs)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const tempReady = new Promise((resolve, reject) => {
    proc.stdout.on('data', value => {
      stdout += value;
      const line = stdout.split('\n').find(Boolean);
      if (line) { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } }
    });
    proc.stderr.on('data', value => { stderr += value; });
    proc.once('error', reject);
  });
  const closed = new Promise(resolve => proc.on('close', code => resolve({ code, stdout, stderr })));
  return { proc, tempReady, closed, stdoutLines: () => stdout.split('\n').filter(Boolean) };
}

// ===== CEO六.16 + 六.1: 用原P0-02复现场景证明生产实现已经阻止它 =====
test('P0-02回归(原独立复审复现场景)：活进程延迟2秒发布，超过staleLockMs——第二进程不得窃取，未发布前可合法竞争，原进程迟到发布不得污染新锁', async () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const identityPath = path.join(rootPath, 'identity.json');
    writeFileSync(identityPath, JSON.stringify(runIdentity));

    const slow = slowPublishChild(rootPath, identityPath, 2000);
    const tempInfo = await slow.tempReady;
    assert.equal(existsSync(tempInfo.lockPath), false, '临时文件写完后，正式lockPath在原子发布前必须仍不可见');

    // t≈300ms：正式锁尚未发布(lockPath不存在)，第二进程应能合法、正常地竞争到它——
    // 这不是"接管"，是lockPath本就还没有主人。用acquireResearchRunStatusLock直接持有
    // (而非writeRunStatus的"获取即写入即释放")，以便下面验证原进程迟到发布时，第二
    // 进程的锁"仍然在场"，这样"不得污染"才是一个有真实对象可验证的断言。
    await new Promise(resolve => setTimeout(resolve, 300));
    const secondLock = acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 500, staleLockMs: 200 });
    assert.equal(secondLock.lockPath, tempInfo.lockPath, '正式锁尚未发布时，第二进程合法竞争应当成功');
    const secondOwnerBeforeLatePublish = JSON.parse(readFileSync(secondLock.lockPath, 'utf8'));

    // 原（第一个）慢进程最终在t≈2000ms尝试原子发布——此时lockPath已经属于第二进程且
    // 第二进程仍持有中，必须遇到EEXIST而失败，绝不能覆盖/污染第二进程的正式锁。
    const slowResult = JSON.parse((await slow.closed).stdout.trim().split('\n').at(-1));
    assert.equal(slowResult.published, false, '原进程的迟到发布必须失败，不得覆盖仍被持有的新owner正式锁');
    assert.equal(slowResult.publishError, 'ARTIFACT_RENAME_FAILED');

    // 正式锁内容必须仍然只是第二进程自己的owner——未被原进程的迟到写入污染。
    const finalOwner = JSON.parse(readFileSync(secondLock.lockPath, 'utf8'));
    assert.deepEqual(finalOwner, secondOwnerBeforeLatePublish, '正式锁内容不得被原(迟到)进程的写入改变');
    assert.notEqual(finalOwner.pid, slow.proc.pid, '正式锁不得包含原(迟到)进程的身份');
    assert.equal(releaseResearchRunStatusLock(secondLock), true);
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

// ===== CEO六.2: 临时owner文件只写入一半时暂停 =====
test('临时owner文件只写入一半(截断)：不得出现不完整正式锁，其他进程正常竞争不受影响', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const { dir, lockPath } = lockPathFor(rootPath, runIdentity);
    const tempPath = `${lockPath}.tmp.${'b'.repeat(64)}`;
    writeFileSync(tempPath, '{"ownerToken":"' + 'b'.repeat(64)); // 截断，从未完成，也从未link到lockPath
    assert.equal(existsSync(lockPath), false, '截断的临时文件不构成正式锁');
    const written = writeRunStatus(rootPath, initialRunStatus({ runIdentity, totalBatches: 1 }), { lockTimeoutMs: 1_000, staleLockMs: 50 });
    assert.equal(written.runState, 'RUNNING', '残留截断临时文件不得阻塞正常获取');
    assert.equal(existsSync(tempPath), true, '不得清理/误判其他(此处为遗留的)临时文件');
    void dir;
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

// ===== CEO六.3: 完成临时写入但在原子发布前崩溃 =====
test('临时owner文件完整写入但在原子发布(linkSync)前崩溃：不留阻塞性正式锁，遗留临时文件不被误判为正式owner', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const { lockPath } = lockPathFor(rootPath, runIdentity);
    const tempPath = `${lockPath}.tmp.${'c'.repeat(64)}`;
    writeFileSync(tempPath, validOwnerJson({ ownerToken: 'c'.repeat(64) })); // 完整、合法，但从未link
    assert.equal(existsSync(lockPath), false);
    const written = writeRunStatus(rootPath, initialRunStatus({ runIdentity, totalBatches: 1 }), { lockTimeoutMs: 1_000, staleLockMs: 50 });
    assert.equal(written.runState, 'RUNNING');
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

// ===== CEO六.4: 完成原子发布后立即崩溃 =====
test('原子发布完成后立即崩溃：正式锁包含完整owner，达到安全恢复条件后可被回收', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const { lockPath } = lockPathFor(rootPath, runIdentity);
    publishRawLock(lockPath, validOwnerJson({ pid: 99999999 })); // 内容完整、Schema合法，模拟发布后立即崩溃
    age(lockPath, 60_000);
    const written = writeRunStatus(rootPath, initialRunStatus({ runIdentity, totalBatches: 1 }), { lockTimeoutMs: 1_000, staleLockMs: 10 });
    assert.equal(written.runState, 'RUNNING');
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

// ===== CEO六.5: 两个独立进程同时执行原子发布 =====
test('两个独立Node子进程同时对同一(全新)身份执行原子发布：只有一个成功，正式锁只包含一个owner', async () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    seeded(rootPath, runIdentity); // 需要先有一次成功写入以释放锁，再让二者竞争后续更新
    const identityPath = path.join(rootPath, 'identity.json');
    writeFileSync(identityPath, JSON.stringify(runIdentity));
    const startAt = Date.now() + 200;
    const results = await Promise.all([
      child(rootPath, identityPath, 'FAILED', startAt),
      child(rootPath, identityPath, 'BLOCKED', startAt)
    ]);
    assert.deepEqual(results.map(value => value.code), [0, 0], JSON.stringify(results));
    const payloads = results.map(value => JSON.parse(value.stdout));
    assert.equal(payloads.filter(value => value.ok && value.state).length, 1, '只能有一方真正写入');
    assert.equal(payloads.filter(value => value.rejected).length, 1, '另一方必须被拒绝，不得覆盖');
    const { lockPath } = lockPathFor(rootPath, runIdentity);
    // release不再unlink lockPath——干净release在原路径留下一个tombstone(见P0-04修复)，
    // 而不是让路径变为不存在。"不留残留"在新协议下的正确含义是：lockPath内容是一个
    // 合法的released tombstone，目录里没有任何其他杂散的.tmp./.exchange.文件。
    assert.equal(existsSync(lockPath), true, '竞争结束后锁应保留为tombstone(新协议不再unlink lockPath)');
    const finalContent = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(finalContent.released, true, '正常竞争后应以tombstone收尾，不是遗留的活跃/损坏内容');
    const dir = path.dirname(lockPath);
    const stray = readdirSync(dir).filter(name => name.includes('.tmp.') || name.includes('.exchange.'));
    assert.deepEqual(stray, [], `不得残留任何临时/exchange候选文件: ${JSON.stringify(stray)}`);
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

// ===== CEO六.7: 迟到release不得删除新owner的正式锁（复用既有真实子进程测试） =====
// 见上方"真实独立Node子进程：旧owner迟到release不得删除新owner锁"，已对新的文件形态
// 重新验证通过(该测试仅使用lock.lockPath与renameSync，对文件与目录语义一致，无需改写)。

// ===== CEO六.8: 正式锁内容截断/JSON损坏/Schema错误 =====
for (const [label, content] of [
  ['截断JSON', '{"ownerToken":"' + 'd'.repeat(64)],
  ['JSON损坏', 'not json at all'],
  ['Schema错误(缺hostIdentitySha256)', JSON.stringify({ ownerToken: 'd'.repeat(64), pid: 99999999, processStartIdentity: 'linux-starttime-1', createdAt: new Date().toISOString() })],
  ['Schema错误(ownerToken格式非法)', validOwnerJson({ ownerToken: 'not-hex' })]
]) test(`正式锁内容${label}：不得仅凭mtime自动接管，必须返回稳定fail-closed错误`, () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const { lockPath } = lockPathFor(rootPath, runIdentity);
    publishRawLock(lockPath, content);
    age(lockPath, 60_000); // 即使年龄很老，也不得被当作可自动隔离的证据
    assert.throws(() => writeRunStatus(rootPath, initialRunStatus({ runIdentity, totalBatches: 1 }), { lockTimeoutMs: 300, staleLockMs: 10 }),
      error => error.code === 'RUN_STATUS_LOCK_INVALID');
    assert.equal(existsSync(lockPath), true, '不得被自动删除/隔离，需人工治理');
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

// ===== CEO六.9: lockPath是目录、符号链接或异常类型 =====
test('lockPath是符号链接：不得跟随，必须fail closed', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const { lockPath } = lockPathFor(rootPath, runIdentity);
    const outside = mkdtempSync(path.join(os.tmpdir(), 'symlink-target-'));
    writeFileSync(path.join(outside, 'evil.json'), validOwnerJson());
    symlinkSync(path.join(outside, 'evil.json'), lockPath);
    age(lockPath, 60_000);
    assert.throws(() => writeRunStatus(rootPath, initialRunStatus({ runIdentity, totalBatches: 1 }), { lockTimeoutMs: 300, staleLockMs: 10 }),
      error => error.code === 'RUN_STATUS_LOCK_INVALID');
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});
// (目录类型的lockPath见上方"legacy目录式锁(修复前格式)必须fail closed"测试)

// ===== CEO六.10 / 六.11: 同host正常死亡owner恢复 / 同host PID复用恢复 =====
// 六.10见上方真实子进程"崩溃持锁者超过阈值后可安全恢复"(已对新形态重新验证通过)。
//
// 六.11要求：不得错误声称"所有平台均能回收PID复用锁"。先探测本机processStartIdentity()
// 是否真的提供了可靠的(非pid-only-)启动身份；只有在这个前提成立时，"PID复用陈旧锁可被
// 回收"才是本模块设计要保证的行为。不成立(如macOS无/proc)时，跳过"可回收"这一断言，
// 改为断言相反方向的安全性质——即fail closed(绝不错误接管)，而不是对两种平台都断言同一个
// "总能回收"的结论。
{
  const hasReliableLocalStartIdentity = !/^pid-only-/.test(processStartIdentity(process.pid));
  test('同host PID复用(start identity不符)的陈旧正式锁可被正确回收',
    hasReliableLocalStartIdentity ? undefined : { skip: '本平台processStartIdentity()退化为pid-only-，无法提供可靠启动身份，见下方fail-closed对照测试' },
    () => {
      const rootPath = root();
      try {
        const runIdentity = identity();
        const { lockPath } = lockPathFor(rootPath, runIdentity);
        publishRawLock(lockPath, validOwnerJson({
          ownerToken: 'e'.repeat(64), pid: process.pid /* 真实存活 -- 就是我们自己 */,
          processStartIdentity: 'linux-starttime-0000000000' /* 刻意错误：与我们真实start identity不符 */
        }));
        age(lockPath, 60_000);
        const written = writeRunStatus(rootPath, initialRunStatus({ runIdentity, totalBatches: 1 }), { lockTimeoutMs: 1_000, staleLockMs: 10 });
        assert.equal(written.runState, 'RUNNING');
      } finally { rmSync(rootPath, { recursive: true, force: true }); }
    });

  test('平台无可靠启动身份时，PID复用场景必须fail closed而不是静默接管',
    hasReliableLocalStartIdentity ? { skip: '本平台(Linux /proc可用)提供可靠启动身份，见上方"可被正确回收"测试覆盖该分支' } : undefined,
    () => {
      const rootPath = root();
      try {
        const runIdentity = identity();
        const { lockPath } = lockPathFor(rootPath, runIdentity);
        publishRawLock(lockPath, validOwnerJson({
          ownerToken: 'e2'.padEnd(64, '0'), pid: process.pid,
          processStartIdentity: 'pid-only-999999999' /* 陈旧记录本身也是不可靠格式 */
        }));
        age(lockPath, 60_000);
        assert.throws(() => writeRunStatus(rootPath, initialRunStatus({ runIdentity, totalBatches: 1 }), { lockTimeoutMs: 150, staleLockMs: 10 }),
          error => error.code === 'RUN_STATUS_LOCK_TIMEOUT');
      } finally { rmSync(rootPath, { recursive: true, force: true }); }
    });
}

// ===== CEO六.12: 不同host相同PID不得自动接管 =====
test('不同hostIdentity声明的正式锁，即使本机判断该PID不存在也绝不自动接管(跨主机fail closed)', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const { lockPath } = lockPathFor(rootPath, runIdentity);
    publishRawLock(lockPath, validOwnerJson({
      ownerToken: 'f'.repeat(64), pid: 99999999, hostIdentitySha256: '9'.repeat(64) // 保证与本机不同(合法hex但非真实host)
    }));
    age(lockPath, 60_000);
    assert.notEqual('9'.repeat(64), hostIdentitySha256(), 'sanity: 伪造host必须确实与真实host不同');
    assert.throws(() => writeRunStatus(rootPath, initialRunStatus({ runIdentity, totalBatches: 1 }), { lockTimeoutMs: 150, staleLockMs: 10 }),
      error => error.code === 'RUN_STATUS_LOCK_TIMEOUT');
    assert.equal(existsSync(lockPath), true, '跨主机声明的锁不得被本机自动隔离');
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

// ===== CEO六.13 / 六.14: 正常单进程/双进程 =====
// 六.13由本文件其余测试(如writeRunStatus基本用法)及d8-status-reader.test.js等隐含覆盖；
// 六.14见上方"真实双Node进程：COMPLETED与FAILED/BLOCKED竞争时COMPLETED单调胜出"。
test('正常单进程：获取锁、写状态、release全流程无残留', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const { lockPath } = lockPathFor(rootPath, runIdentity);
    const written = writeRunStatus(rootPath, initialRunStatus({ runIdentity, totalBatches: 1 }));
    assert.equal(written.runState, 'RUNNING');
    // 新协议下release以tombstone收尾(见P0-04)，lockPath本身不再变为不存在——
    // "已释放"改为断言内容是released tombstone，且没有任何临时文件残留。
    assert.equal(existsSync(lockPath), true, '正常写入结束后锁应保留为tombstone(新协议不再unlink lockPath)');
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).released, true);
    const dir = path.dirname(lockPath);
    const stray = readdirSync(dir).filter(name => name.includes('.tmp.') || name.includes('.exchange.'));
    assert.deepEqual(stray, [], `不得残留任何临时/exchange候选文件: ${JSON.stringify(stray)}`);
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

// ===== CEO六.15: 连续多轮获取释放后不得残留阻塞性正式锁或错误owner文件 =====
test('连续20轮获取与释放后，目标目录不residual任何锁或临时文件', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    let status = initialRunStatus({ runIdentity, totalBatches: 20 });
    status = writeRunStatus(rootPath, status);
    for (let batchIndex = 0; batchIndex < 20; batchIndex += 1) {
      status = withBatchCompleted(status, batchIndex, { checkpoint: { batchIndex, rowCount: 1, cursor: null, sha256: 'a'.repeat(64) } });
      status = writeRunStatus(rootPath, status);
    }
    const dir = path.join(rootPath, 'run-status', 'dry-run', runIdentity.validationRunId);
    // 20轮全部是同一次COMPLETED流程内的withBatchCompleted续写(未曾release中途)，
    // 所以此处只需确认没有任何临时/exchange候选文件残留——lockPath本身(可能是
    // 活跃锁，因为writeRunStatus尚未返回)不应被当作"残留"。
    const stray = readdirSync(dir).filter(name => name.includes('.tmp.') || name.includes('.exchange.'));
    assert.deepEqual(stray, [], `连续多轮获取/释放后不得残留临时/exchange候选文件，实际残留: ${JSON.stringify(stray)}`);
    assert.equal(existsSync(path.join(dir, `.${runIdentity.runIdentitySha256}.status.lock`)), true, 'lockPath应以tombstone形式留存(新协议不再unlink)');
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// P0-03 / P0-04 修复：quarantine与release的TOCTOU（董事长/CEO独立复审授权的
// 范围受控修复，父提交032bae4）。
//
// 两个测试都使用同进程同步hook在生产实现内部的精确临界点(验证完成之后、
// 破坏性操作之前)注入"锁已被替换为新owner"这一竞态，而不是依赖wall-clock
// 延迟或进程调度——JS单线程语义保证hook触发的时刻是确定的，不是概率性的。
// 替换本身通过真实的acquireResearchRunStatusLock()完成，是生产实现而非
// 手工重演的相似原语。
// ---------------------------------------------------------------------------

// 本轮(方案B第二次修复)后，quarantine/release都是两段式：reserve(第一次exchange，
// 换入的是一个与正常活跃claim完全同形的reservation，因而对任何正确的竞争者都不可
// 抢占) -> finalize(第二次exchange，把reservation转成真正的tombstone)。hook形状
// 从扁平的{beforeExchange}改为{reserve:{beforeExchange,afterExchange},
// finalize:{beforeExchange,afterExchange}}，分别独立注入到两次exchangeAndVerify
// 调用。以下三个测试复现的都是"reserve阶段的renameat2执行前，锁已被替换"这一幕，
// 因此hook挂在reserve.beforeExchange上，语义与修复前完全对应，预期结果不变。
test('P0-03修复：quarantine在reserve阶段renameat2执行前发现目标已被替换为新owner时，绝不能移动/覆盖新锁(确定性同步点)', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const { dir, lockPath } = lockPathFor(rootPath, runIdentity);
    // 构造一把真实的、已确认死亡、已超过staleLockMs的旧锁A。
    publishRawLock(lockPath, validOwnerJson({ ownerToken: 'a'.repeat(64), pid: 99999999 }));
    age(lockPath, 60_000);

    let newOwnerLock = null;
    const hooks = {
      reserve: {
        beforeExchange: () => {
          // 场景：1.已验证A为stale(已发生，见上) 2.在我方reserve的renameat2调用
          // 前，A已被其他真实恢复者(经由真实acquireResearchRunStatusLock，内部
          // 同样走reserve+finalize协议)合法替换为新owner B。
          newOwnerLock = acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 500, staleLockMs: 50 });
        }
      }
    };

    const quarantined = quarantinePublishedLockForTest(lockPath, dir, 10, hooks);
    assert.equal(quarantined, false, '原恢复者不得把B的锁换入reservation——必须放弃，不得声称成功');
    assert.equal(existsSync(lockPath), true, 'B的正式锁必须仍然存在于原路径');
    const stillB = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(stillB.ownerToken, newOwnerLock.ownerToken, 'lockPath内容必须仍是B，未被换出/覆盖');
    const dirEntries = readdirSync(dir).filter(name => name.includes('.exchange.'));
    assert.deepEqual(dirEntries, [], `不得残留任何私有exchange候选文件: ${JSON.stringify(dirEntries)}`);
    assert.equal(releaseResearchRunStatusLock(newOwnerLock), true);
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

test('P0-04修复：release在reserve阶段renameat2执行前发现锁已被替换为新owner时，绝不能覆盖/删除新锁(确定性同步点，非概率stress)', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const oldLock = acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 500, staleLockMs: 50 });

    let newOwnerLock = null;
    const hooks = {
      reserve: {
        beforeExchange: () => {
          // 旧owner仍合法持有中，正常协议下任何人都无法"合法"抢占它(这正是修复
          // 要保证的)——此处模拟的是外部/异常干预直接删除了lockPath目录项(不经过
          // 本协议)，随后一个全新进程合法bootstrap到这个(意外)空出的位置，即
          // "旧owner的release在reserve的renameat2执行前发现目标已经不是自己"。
          unlinkSync(oldLock.lockPath);
          newOwnerLock = acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 500, staleLockMs: 50 });
        }
      }
    };

    const released = releaseResearchRunStatusLockForTest(oldLock, hooks);
    assert.equal(released, false, '旧owner不得把新owner的锁换出/覆盖——必须放弃，不得声称release成功');
    assert.equal(existsSync(oldLock.lockPath), true, '新owner的正式锁必须仍然存在');
    const stillNew = JSON.parse(readFileSync(oldLock.lockPath, 'utf8'));
    assert.equal(stillNew.ownerToken, newOwnerLock.ownerToken, 'lockPath内容必须仍是新owner，未被旧owner误删/覆盖');
    assert.equal(releaseResearchRunStatusLock(newOwnerLock), true);
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

test('第三owner(reserve阶段前)：hook内先由B替换A、B又合法释放为tombstone、C再合法接管，我方仍不得覆盖/删除C', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const { dir, lockPath } = lockPathFor(rootPath, runIdentity);
    publishRawLock(lockPath, validOwnerJson({ ownerToken: 'a'.repeat(64), pid: 99999999 }));
    age(lockPath, 60_000);

    let cLock = null;
    const hooks = {
      reserve: {
        beforeExchange: () => {
          // A(stale) -> B(真实acquire，合法替换A) -> B真实release(合法留下
          // tombstone) -> C(真实acquire，合法接管B留下的tombstone)。三方链路
          // 全部经过真实生产函数，我方对A的quarantine尝试直到此刻才真正执行
          // 它自己reserve阶段的renameat2调用。
          const bLock = acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 500, staleLockMs: 50 });
          assert.equal(releaseResearchRunStatusLock(bLock), true);
          cLock = acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 500, staleLockMs: 50 });
        }
      }
    };

    const quarantined = quarantinePublishedLockForTest(lockPath, dir, 10, hooks);
    assert.equal(quarantined, false, '经过B、C两次合法交接后，我方针对A的陈旧尝试必须放弃，不得触碰C');
    assert.equal(existsSync(lockPath), true, 'C的正式锁必须仍然存在');
    const stillC = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(stillC.ownerToken, cLock.ownerToken, 'lockPath内容必须仍是C，未被覆盖/删除');
    assert.equal(releaseResearchRunStatusLock(cLock), true);
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 独立复审第二轮(本轮)新增：reserve阶段本身自己的renameat2完成之后、finalize
// 尚未开始之间的窗口——即round2被指出的确切缺陷所在的窗口。用生产实现内部新增的
// afterExchange钩子(位于exchangeAndVerify的renameat2调用之后、读回/裁决displaced
// 对象之前)在此刻注入一个真实第三方acquire尝试，证明reservation存活期间它必须
// 被拒绝(超时，而不是窃取成功)；随后再用同一afterExchange钩子挂在finalize阶段，
// 证明只有tombstone真正落地(finalize的exchange已提交)之后，第三方才可以合法接管，
// 且我方finalize自身的裁决(依据私有candidatePath读回，不受第三方后续动作影响)
// 仍然正确报告成功，不破坏第三方刚接管的锁。quarantine与release两条路径都覆盖。
// ---------------------------------------------------------------------------

test('reservation阶段(quarantine)：afterExchange窗口内第三方无法抢占非tombstone的reservation，必须等待超时', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const { dir, lockPath } = lockPathFor(rootPath, runIdentity);
    publishRawLock(lockPath, validOwnerJson({ ownerToken: 'a'.repeat(64), pid: 99999999 }));
    age(lockPath, 60_000);

    let thirdPartyTimedOut = false;
    const hooks = {
      reserve: {
        afterExchange: () => {
          // reserve的renameat2已经提交：lockPath现在持有我方reservation(与
          // 普通活跃claim同形，非released:true)。我方尚未读回/裁决displaced内容。
          // 此刻一个真实第三方尝试acquire——正确实现下它必须判定该锁为'active'
          // 并等待/超时，绝不能把它当作可抢占对象换出。
          try {
            acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 120, staleLockMs: 10 });
          } catch (error) {
            thirdPartyTimedOut = error.code === 'RUN_STATUS_LOCK_TIMEOUT';
          }
        }
      }
    };

    const quarantined = quarantinePublishedLockForTest(lockPath, dir, 10, hooks);
    assert.equal(thirdPartyTimedOut, true, 'reservation存在期间第三方必须超时失败，不得抢占成功');
    assert.equal(quarantined, true, '第三方未能抢占，我方自己的reserve+finalize应正常完成');
    assert.equal(existsSync(lockPath), true, 'lockPath必须仍然存在');
    const finalContent = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(finalContent.released, true, '正常完成后lockPath应是我方发布的tombstone');
    const stray = readdirSync(dir).filter(name => name.includes('.tmp.') || name.includes('.exchange.'));
    assert.deepEqual(stray, [], `不得残留任何临时/exchange候选文件: ${JSON.stringify(stray)}`);
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

test('reservation阶段(release)：afterExchange窗口内第三方无法抢占非tombstone的reservation，必须等待超时', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const oldLock = acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 500, staleLockMs: 50 });

    let thirdPartyTimedOut = false;
    const hooks = {
      reserve: {
        afterExchange: () => {
          try {
            acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 120, staleLockMs: 10 });
          } catch (error) {
            thirdPartyTimedOut = error.code === 'RUN_STATUS_LOCK_TIMEOUT';
          }
        }
      }
    };

    const released = releaseResearchRunStatusLockForTest(oldLock, hooks);
    assert.equal(thirdPartyTimedOut, true, 'reservation存在期间第三方必须超时失败，不得抢占成功');
    assert.equal(released, true, '第三方未能抢占，我方自己的release应正常完成');
    const finalContent = JSON.parse(readFileSync(oldLock.lockPath, 'utf8'));
    assert.equal(finalContent.released, true, '正常完成后lockPath应是我方发布的tombstone');
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

test('finalize发布后(quarantine)：tombstone一旦落地，第三方才可合法接管，且我方finalize自身裁决不受影响、不覆盖第三方新锁', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const { dir, lockPath } = lockPathFor(rootPath, runIdentity);
    publishRawLock(lockPath, validOwnerJson({ ownerToken: 'a'.repeat(64), pid: 99999999 }));
    age(lockPath, 60_000);

    let cLock = null;
    const hooks = {
      finalize: {
        afterExchange: () => {
          // finalize的renameat2已经提交：lockPath现在真正是tombstone(released:
          // true)，这是一个合法、已完成的"已释放"状态——第三方此刻legitimately
          // 接管它，不是竞态，是协议允许的正常后续。
          cLock = acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 500, staleLockMs: 10 });
        }
      }
    };

    const quarantined = quarantinePublishedLockForTest(lockPath, dir, 10, hooks);
    assert.notEqual(cLock, null, '第三方在tombstone落地后必须能合法接管');
    assert.equal(quarantined, true, '我方自身对已私有捕获的displaced内容的裁决不受第三方后续动作影响，仍应正确报告完成');
    const stillC = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(stillC.ownerToken, cLock.ownerToken, 'lockPath必须仍是第三方C的活跃claim，未被我方事后动作覆盖/删除');
    const stray = readdirSync(dir).filter(name => name.includes('.tmp.') || name.includes('.exchange.'));
    assert.deepEqual(stray, [], `不得残留任何临时/exchange候选文件: ${JSON.stringify(stray)}`);
    assert.equal(releaseResearchRunStatusLock(cLock), true);
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

test('finalize发布后(release)：tombstone一旦落地，第三方才可合法接管，且我方release自身裁决不受影响、不覆盖第三方新锁', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const oldLock = acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 500, staleLockMs: 50 });

    let cLock = null;
    const hooks = {
      finalize: {
        afterExchange: () => {
          cLock = acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 500, staleLockMs: 10 });
        }
      }
    };

    const released = releaseResearchRunStatusLockForTest(oldLock, hooks);
    assert.notEqual(cLock, null, '第三方在tombstone落地后必须能合法接管');
    assert.equal(released, true, '我方自身release裁决不受第三方后续动作影响，仍应正确报告完成');
    const stillC = JSON.parse(readFileSync(oldLock.lockPath, 'utf8'));
    assert.equal(stillC.ownerToken, cLock.ownerToken, 'lockPath必须仍是第三方C的活跃claim，未被我方release事后动作覆盖/删除');
    assert.equal(releaseResearchRunStatusLock(cLock), true);
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

test('finalize自身核验(release)：若reservation在finalize执行前被非法替换(协议不应允许的伪造场景)，finalize必须检测到并安全放弃，不得盲目声称转换成功', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const oldLock = acquireResearchRunStatusLock(rootPath, runIdentity, { lockTimeoutMs: 500, staleLockMs: 50 });

    const hooks = {
      finalize: {
        beforeExchange: () => {
          // reserve已经成功、reservation正合法持有lockPath。这里模拟一个不应该
          // 发生的场景(非法/带外篡改，绕开整个协议直接改写目录项)：finalize自己的
          // renameat2执行前，lockPath的内容被替换成一个与我方reservation完全无关
          // 的伪造owner。finalize必须凭自己对"被换出对象是否是我方reservation"的
          // 独立核验发现这一点，而不是盲目相信"reserve成功了所以finalize也一定对"。
          unlinkSync(oldLock.lockPath);
          publishRawLock(oldLock.lockPath, validOwnerJson({ ownerToken: 'f'.repeat(64), pid: 99999999 }));
        }
      }
    };

    const released = releaseResearchRunStatusLockForTest(oldLock, hooks);
    assert.equal(released, false, '被替换成非我方reservation的对象时，finalize必须安全放弃，不得声称release成功');
    const stillForged = JSON.parse(readFileSync(oldLock.lockPath, 'utf8'));
    assert.equal(stillForged.ownerToken, 'f'.repeat(64), '带外伪造内容必须原样保留，未被我方进一步破坏');
  } finally { rmSync(rootPath, { recursive: true, force: true }); }
});

test('renameat2(RENAME_EXCHANGE)不可用时，reclaim与release必须fail closed，绝不静默退回存在竞态的旧实现', async () => {
  const FIXDIR_SERVER = path.resolve(path.dirname(childPath), '..', '..', '..');
  const buildDir = path.join(FIXDIR_SERVER, 'native', 'renameat2', 'build');
  const disabledDir = `${buildDir}.disabled-for-test`;
  const rootPath = root();
  const runIdentity = identity();
  const { lockPath } = lockPathFor(rootPath, runIdentity);
  publishRawLock(lockPath, validOwnerJson({ ownerToken: 'a'.repeat(64), pid: 99999999 }));
  age(lockPath, 60_000);
  // 直接写入run-status数据文件本身(与锁文件是完全不同的两个文件)，绕开锁获取，
  // 只是为了让子进程的readRunStatus()能读到一个合法current，从而真正走到
  // writeRunStatus->acquireStatusLock这条我们要测试的路径，而不是在更早的
  // "current为null"处提前抛出一个无关错误。
  const seedStatus = initialRunStatus({ runIdentity, totalBatches: 1 });
  const statusDirPath = path.join(rootPath, 'run-status', 'dry-run', runIdentity.validationRunId);
  mkdirSync(statusDirPath, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(statusDirPath, `${runIdentity.runIdentitySha256}.status.json`), canonicalJson(seedStatus));
  const identityPath = path.join(rootPath, 'identity.json');
  writeFileSync(identityPath, JSON.stringify(runIdentity));

  const hadBuild = existsSync(buildDir);
  try {
    if (hadBuild) renameSync(buildDir, disabledDir);
    // 真实全新子进程(独立ESM模块缓存，addon.available在其内必然重新计算为false)，
    // 尝试对一把已确认stale的锁执行reclaim(经由writeRunStatus->acquireStatusLock)。
    const proc = spawn(process.execPath, [childPath, rootPath, identityPath, 'FAILED', String(Date.now())], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', v => { stdout += v; });
    proc.stderr.on('data', v => { stderr += v; });
    const { code } = await new Promise(resolve => proc.on('close', c => resolve({ code: c })));
    assert.notEqual(code, 0, 'addon不可用时reclaim不得静默成功');
    const errorPayload = JSON.parse(stderr || '{}');
    assert.equal(errorPayload.code, 'RUN_STATUS_ATOMIC_EXCHANGE_UNAVAILABLE', `必须fail closed为稳定错误码，不得回退旧实现；实际: ${stderr}`);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).ownerToken, 'a'.repeat(64), 'lockPath内容必须完全未被触碰(既未被接管也未损坏)');
    assert.equal(stdout.trim(), '', '不得输出任何"成功"结果');
  } finally {
    if (hadBuild && existsSync(disabledDir)) renameSync(disabledDir, buildDir);
    rmSync(rootPath, { recursive: true, force: true });
  }
});
