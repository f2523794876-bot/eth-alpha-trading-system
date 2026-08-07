// D7 artifact-publisher.js / artifact-reader.js 测试——T18/T19核心覆盖（V8_FINAL_R3.md §4）。
// 使用真实文件系统（os.tmpdir()下的隔离临时目录，每个用例独立mkdtemp+测试结束rmSync），
// 不mock fs，直接驱动生产发布/读取协议本身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { publishArtifact } from './artifact-publisher.js';
import { readArtifactPair } from './artifact-reader.js';
import { canonicalJson } from '../formal-research/canonical-json.js';
import { evaluateGoNoGo } from '../formal-research/go-no-go-evaluator.js';
import { createResearchRunIdentity } from './research-run-status.js';

const CONTRACT_TEXT = readFileSync(new URL('../../../V1_4D_FORMAL_RESEARCH_EXECUTION_CONTRACT_V8_FINAL_R3.md', import.meta.url), 'utf8');
function frozenVector(id) {
  const pattern = /#### (非法)?向量 `([^`]+)`\n\n([^\n]+)\n\n```json\n([\s\S]*?)\n```/g;
  const vectors = [...CONTRACT_TEXT.matchAll(pattern)].map(([, invalid, vid, summary, source]) => ({ id: vid, value: JSON.parse(source) }));
  return vectors.find(v => v.id === id).value;
}
const GO_INPUT = frozenVector('GO').input;
const GO_DECISION = evaluateGoNoGo(GO_INPUT);

function sha256Hex(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function evalIdentity(evaluationVersion) { return sha256Hex(evaluationVersion); }

function makeRoot() { return mkdtempSync(path.join(os.tmpdir(), 'd7-artifact-root-')); }

function baseCore({ validationRunId, evaluationVersion, artifactMode = 'DRY_RUN', researchTo = '2026-01-08T00:00:00.000Z', governanceAuthorizationRef = null, auditOverrides = {} }) {
  const runIdentity = createResearchRunIdentity({ validationRunId, evaluationVersion, artifactMode, config: {
    gitObjectFormat: 'SHA1', sourceIdentity: 'MODULE_TEST', sourceVersion: 'v1.4d-test-config/1', sourceCommit: 'a'.repeat(40), datasetVersion: GO_INPUT.auditTrail.datasetVersion,
    featureEngineVersion: 'feature-1', algorithmVersion: 'algorithm-1', ruleVersion: 'rule-1',
    evaluationVersion, weightVersion: 'weight-1', horizons: ['24h', '72h'],
    researchFrom: '2026-01-01T00:00:00.000Z', researchTo, fixedAsOf: '2026-01-08T00:00:00.000Z',
    thresholds: GO_INPUT.thresholds
  } });
  return {
    validationRunId, evaluationVersion, gitObjectFormat: 'SHA1', sourceCommit: 'a'.repeat(40),
    runIdentity,
    d8InputSha256: 'b'.repeat(64), researchFrom: '2026-01-01T00:00:00.000Z', researchTo, fixedAsOf: '2026-01-08T00:00:00.000Z',
    thresholds: GO_INPUT.thresholds, scorecard: GO_INPUT.scorecard,
    auditTrail: { ...GO_INPUT.auditTrail, authenticityGateStatus: 'PASSED', manifestCoverage: 1, featureCoverage: 1, validationRunStatus: 'SUCCEEDED', ...auditOverrides },
    decision: GO_DECISION,
    governanceAuthorizationRef
  };
}
function governanceRef(validationRunId) {
  const thresholdsSha256 = sha256Hex(canonicalJson(GO_INPUT.thresholds));
  return {
    authorizationSchemaVersion: 'v1.4d-governance-authorization/1', recordSha256: 'd'.repeat(64), hashAlgorithm: 'SHA-256',
    validationRunId, thresholdsSha256, authorizationScope: 'FORMAL_RESEARCH_EXECUTION', decision: 'APPROVE'
  };
}
function targetDirFor(root, mode, validationRunId, evaluationVersion) {
  return path.join(root, mode, validationRunId, evalIdentity(evaluationVersion));
}
function publishOpts(overrides = {}) {
  return { manifestContentHash: 'c'.repeat(64), validationRunFinishedAt: '2026-01-08T00:05:00.000Z', ...overrides };
}

function rewritePairWithMutatedIdentity(targetDir, mutate) {
  const mainPath = path.join(targetDir, 'research-artifact.json');
  const sidecarPath = path.join(targetDir, 'research-artifact.sha256.json');
  const main = JSON.parse(readFileSync(mainPath, 'utf8'));
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  mutate(main.core.runIdentity);
  const bytes = canonicalJson(main);
  sidecar.fullMainArtifactSha256 = sha256Hex(bytes);
  rmSync(mainPath); rmSync(sidecarPath);
  writeFileSync(mainPath, bytes);
  writeFileSync(sidecarPath, canonicalJson(sidecar));
}

test('D7成功路径：DRY_RUN发布产生合法PUBLISHED，事件序列包含唯一commit point', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-t1';
    const core = baseCore({ validationRunId, evaluationVersion, governanceAuthorizationRef: null });
    const result = publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts() });
    assert.equal(result.operationStatus, 'PUBLISHED');
    assert.equal(result.reasonCode, 'NONE');
    assert.equal(result.postPublishStatus, 'COMPLETE');
    assert.equal(result.postPublishCode, 'NONE');
    assert.ok(result.runtimeEvents.includes('ARTIFACT_SIDECAR_RENAME_COMMIT_POINT'));
    assert.ok(result.runtimeEvents.includes('ARTIFACT_PUBLISH_COMPLETED'));
    const idxMain = result.runtimeEvents.indexOf('ARTIFACT_MAIN_RENAMED');
    const idxCommit = result.runtimeEvents.indexOf('ARTIFACT_SIDECAR_RENAME_COMMIT_POINT');
    assert.ok(idxMain < idxCommit, '主文件rename必须先于sidecar commit point');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7成功路径：FORMAL模式要求governanceAuthorizationRef非null，且auditTrail满足强制值', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-t2';
    const core = baseCore({ validationRunId, evaluationVersion, artifactMode: 'FORMAL', governanceAuthorizationRef: governanceRef(validationRunId) });
    const result = publishArtifact({ root, artifactMode: 'FORMAL', validationRunId, evaluationVersion, core, ...publishOpts() });
    assert.equal(result.operationStatus, 'PUBLISHED');
    assert.equal(result.postPublishStatus, 'COMPLETE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7红线：FORMAL模式下governanceAuthorizationRef为null必须Schema拒绝，0文件写入', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-t3';
    const core = baseCore({ validationRunId, evaluationVersion, artifactMode: 'FORMAL', governanceAuthorizationRef: null });
    const result = publishArtifact({ root, artifactMode: 'FORMAL', validationRunId, evaluationVersion, core, ...publishOpts() });
    assert.equal(result.operationStatus, 'FAILED');
    assert.equal(result.reasonCode, 'ARTIFACT_SCHEMA_INVALID');
    const targetDir = targetDirFor(root, 'formal', validationRunId, evaluationVersion);
    assert.equal(existsAny(targetDir), false, 'Schema拒绝时目标目录不应有任何文件');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7红线：DRY_RUN模式下governanceAuthorizationRef非null必须Schema拒绝', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-t4';
    const core = baseCore({ validationRunId, evaluationVersion, governanceAuthorizationRef: governanceRef(validationRunId) });
    const result = publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts() });
    assert.equal(result.operationStatus, 'FAILED');
    assert.equal(result.reasonCode, 'ARTIFACT_SCHEMA_INVALID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7幂等：同一身份+同bytes重复发布返回REUSED_IDENTICAL，不产生第二次rename', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-t5';
    const core = baseCore({ validationRunId, evaluationVersion });
    const first = publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts() });
    assert.equal(first.operationStatus, 'PUBLISHED');
    const targetDir = targetDirFor(root, 'dry-run', validationRunId, evaluationVersion);
    const mainBytesBefore = readFileSync(path.join(targetDir, 'research-artifact.json'));
    const second = publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts() });
    assert.equal(second.operationStatus, 'REUSED_IDENTICAL');
    assert.deepEqual(second.runtimeEvents, ['ARTIFACT_PREFLIGHT_PASSED', 'ARTIFACT_REUSED_IDENTICAL']);
    const mainBytesAfter = readFileSync(path.join(targetDir, 'research-artifact.json'));
    assert.ok(mainBytesBefore.equals(mainBytesAfter), '复用不得改写已发布文件的字节');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7红线：同一身份、不同bytes的第二次发布必须FAILED/ARTIFACT_CONTENT_CONFLICT，不得覆盖', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-t6';
    const core1 = baseCore({ validationRunId, evaluationVersion, researchTo: '2026-01-08T00:00:00.000Z' });
    const first = publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core: core1, ...publishOpts() });
    assert.equal(first.operationStatus, 'PUBLISHED');
    const targetDir = targetDirFor(root, 'dry-run', validationRunId, evaluationVersion);
    const before = readFileSync(path.join(targetDir, 'research-artifact.json'));
    const core2 = baseCore({ validationRunId, evaluationVersion, researchTo: '2026-01-09T00:00:00.000Z' });
    const second = publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core: core2, ...publishOpts() });
    assert.equal(second.operationStatus, 'FAILED');
    assert.equal(second.reasonCode, 'ARTIFACT_CONTENT_CONFLICT');
    const after = readFileSync(path.join(targetDir, 'research-artifact.json'));
    assert.ok(before.equals(after), '内容冲突时绝不覆盖已发布的合法pair');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7确定性：两次独立构造相同core（不同JS对象、不同键插入顺序）产生逐字节相同的主artifact与sidecar', () => {
  const root1 = makeRoot();
  const root2 = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-t7';
    const coreA = baseCore({ validationRunId, evaluationVersion });
    const coreB = JSON.parse(JSON.stringify({ // 反转顶层键插入顺序，模拟"独立构造"
      governanceAuthorizationRef: coreA.governanceAuthorizationRef, decision: coreA.decision, auditTrail: coreA.auditTrail,
      scorecard: coreA.scorecard, thresholds: coreA.thresholds, fixedAsOf: coreA.fixedAsOf, researchTo: coreA.researchTo,
      researchFrom: coreA.researchFrom, d8InputSha256: coreA.d8InputSha256, sourceCommit: coreA.sourceCommit,
      gitObjectFormat: coreA.gitObjectFormat, runIdentity: coreA.runIdentity,
      evaluationVersion: coreA.evaluationVersion, validationRunId: coreA.validationRunId
    }));
    const r1 = publishArtifact({ root: root1, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core: coreA, ...publishOpts() });
    const r2 = publishArtifact({ root: root2, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core: coreB, ...publishOpts() });
    assert.equal(r1.operationStatus, 'PUBLISHED'); assert.equal(r2.operationStatus, 'PUBLISHED');
    const dir1 = targetDirFor(root1, 'dry-run', validationRunId, evaluationVersion);
    const dir2 = targetDirFor(root2, 'dry-run', validationRunId, evaluationVersion);
    const main1 = readFileSync(path.join(dir1, 'research-artifact.json'));
    const main2 = readFileSync(path.join(dir2, 'research-artifact.json'));
    assert.ok(main1.equals(main2), '独立构造必须产生逐字节相同的主artifact bytes');
    const side1 = readFileSync(path.join(dir1, 'research-artifact.sha256.json'));
    const side2 = readFileSync(path.join(dir2, 'research-artifact.sha256.json'));
    assert.ok(side1.equals(side2), '独立构造必须产生逐字节相同的sidecar bytes');
  } finally { rmSync(root1, { recursive: true, force: true }); rmSync(root2, { recursive: true, force: true }); }
});

test('D7读取者：D8 decision经发布+独立回读后canonical内容与原始evaluateGoNoGo()输出完全一致', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-t8';
    const core = baseCore({ validationRunId, evaluationVersion });
    publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts() });
    const targetDir = targetDirFor(root, 'dry-run', validationRunId, evaluationVersion);
    const read = readArtifactPair(targetDir);
    assert.equal(read.readerStatus, 'ACCEPTED');
    assert.equal(canonicalJson(read.artifact.core.decision), canonicalJson(GO_DECISION));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7读取者红线：只有主文件、sidecar缺失 → REJECTED/ARTIFACT_PAIR_INCOMPLETE', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-t9';
    const core = baseCore({ validationRunId, evaluationVersion });
    publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts() });
    const targetDir = targetDirFor(root, 'dry-run', validationRunId, evaluationVersion);
    rmSync(path.join(targetDir, 'research-artifact.sha256.json'));
    const read = readArtifactPair(targetDir);
    assert.equal(read.readerStatus, 'REJECTED');
    assert.equal(read.readerReasonCode, 'ARTIFACT_PAIR_INCOMPLETE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7读取者红线：两者皆缺失 → REJECTED/ARTIFACT_NOT_FOUND', () => {
  const root = makeRoot();
  try {
    const targetDir = path.join(root, 'dry-run', randomUUID(), 'a'.repeat(64));
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const read = readArtifactPair(targetDir);
    assert.equal(read.readerStatus, 'REJECTED');
    assert.equal(read.readerReasonCode, 'ARTIFACT_NOT_FOUND');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7读取者红线：sidecar记录的hash被篡改 → REJECTED/ARTIFACT_HASH_MISMATCH', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-t10';
    const core = baseCore({ validationRunId, evaluationVersion });
    publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts() });
    const targetDir = targetDirFor(root, 'dry-run', validationRunId, evaluationVersion);
    const sidecarPath = path.join(targetDir, 'research-artifact.sha256.json');
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    sidecar.fullMainArtifactSha256 = 'f'.repeat(64);
    // 直接篡改磁盘文件模拟"发布后被破坏"（测试环境构造，不经过发布协议本身）。
    rmSync(sidecarPath);
    writeFileSync(sidecarPath, canonicalJson(sidecar));
    const read = readArtifactPair(targetDir);
    assert.equal(read.readerStatus, 'REJECTED');
    assert.equal(read.readerReasonCode, 'ARTIFACT_HASH_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7读取者红线：主文件被symlink替换 → 拒绝跟随，REJECTED', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-t11';
    const core = baseCore({ validationRunId, evaluationVersion });
    publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts() });
    const targetDir = targetDirFor(root, 'dry-run', validationRunId, evaluationVersion);
    const mainPath = path.join(targetDir, 'research-artifact.json');
    const decoyPath = path.join(targetDir, 'decoy.json');
    writeFileSync(decoyPath, readFileSync(mainPath));
    rmSync(mainPath);
    symlinkSync(decoyPath, mainPath);
    const read = readArtifactPair(targetDir);
    assert.equal(read.readerStatus, 'REJECTED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P0完整身份：legacy artifact缺runIdentity必须fail-closed', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID(), evaluationVersion = 'v1.4d-eval-legacy-reject';
    const core = baseCore({ validationRunId, evaluationVersion });
    assert.equal(publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts() }).operationStatus, 'PUBLISHED');
    const targetDir = targetDirFor(root, 'dry-run', validationRunId, evaluationVersion);
    rewritePairWithMutatedIdentity(targetDir, identity => { for (const key of Object.keys(identity)) delete identity[key]; });
    const read = readArtifactPair(targetDir);
    assert.equal(read.readerStatus, 'REJECTED');
    assert.equal(read.readerReasonCode, 'ARTIFACT_SCHEMA_INVALID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const identityTamperCases = {
  validationRunId: () => randomUUID(), artifactMode: () => 'FORMAL', configSha256: () => 'f'.repeat(64),
  thresholdsSha256: () => 'f'.repeat(64), gitObjectFormat: () => 'SHA256', sourceIdentity: () => 'TAMPERED_SOURCE',
  sourceVersion: () => 'tampered-source-version', sourceCommit: () => 'b'.repeat(40),
  datasetVersion: () => `v1.4d-sha256-${'f'.repeat(64)}`, featureEngineVersion: () => 'feature-tampered',
  algorithmVersion: () => 'algorithm-tampered', ruleVersion: () => 'rule-tampered',
  evaluationVersion: () => 'evaluation-tampered', weightVersion: () => 'weight-tampered',
  horizons: () => ['72h', '24h'], researchFrom: () => '2026-01-02T00:00:00.000Z',
  researchTo: () => '2026-01-09T00:00:00.000Z', fixedAsOf: () => '2026-01-09T00:00:00.000Z',
  runIdentitySha256: () => 'f'.repeat(64)
};
for (const [field, replacement] of Object.entries(identityTamperCases)) test(`P0完整身份逐字段篡改拒绝：${field}`, () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID(), evaluationVersion = `v1.4d-eval-tamper-${field}`;
    const core = baseCore({ validationRunId, evaluationVersion });
    assert.equal(publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts() }).operationStatus, 'PUBLISHED');
    const targetDir = targetDirFor(root, 'dry-run', validationRunId, evaluationVersion);
    rewritePairWithMutatedIdentity(targetDir, identity => { identity[field] = replacement(); });
    const read = readArtifactPair(targetDir);
    assert.equal(read.readerStatus, 'REJECTED');
    assert.ok(['ARTIFACT_SCHEMA_INVALID', 'ARTIFACT_IDENTITY_MISMATCH'].includes(read.readerReasonCode), read.readerReasonCode);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7路径校验红线：非绝对路径/含..的root必须ARTIFACT_ROOT_INVALID', () => {
  const validationRunId = randomUUID();
  const evaluationVersion = 'v1.4d-eval-t12';
  const core = baseCore({ validationRunId, evaluationVersion });
  for (const badRoot of ['relative/path', '/tmp/../etc', '/tmp//double']) {
    assert.throws(
      () => publishArtifact({ root: badRoot, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts() }),
      error => error.code === 'ARTIFACT_ROOT_INVALID',
      `expected ARTIFACT_ROOT_INVALID for ${badRoot}`
    );
  }
});

test('D7 24H/72H等无关字段之外：24H与72H结果各自独立体现在artifact.core.decision中，未被合并或丢弃', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-t13';
    const core = baseCore({ validationRunId, evaluationVersion });
    publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts() });
    const targetDir = targetDirFor(root, 'dry-run', validationRunId, evaluationVersion);
    const read = readArtifactPair(targetDir);
    assert.ok(read.artifact.core.decision.horizonResults['24h']);
    assert.ok(read.artifact.core.decision.horizonResults['72h']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7锁协议：已存在活跃固定锁时，短超时发布必须ARTIFACT_LOCK_TIMEOUT，不得抢占', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-lock1';
    const targetDir = targetDirFor(root, 'dry-run', validationRunId, evaluationVersion);
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const activeLock = {
      schemaVersion: 'v1.4d-artifact-lock/2', lockId: '1'.repeat(32), ownerToken: '2'.repeat(64),
      targetIdentitySha256: '3'.repeat(64), hostIdentitySha256: sha256Hex(`host:${os.hostname()}`),
      pid: process.pid, // 当前进程本身——必然"活跃"（PID存在且可验证）
      processStartIdentity: computeProcessStartIdentity(process.pid),
      ownerUid: process.getuid ? process.getuid() : 0,
      acquiredAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 3600000).toISOString()
    };
    writeFileSync(path.join(targetDir, '.research-artifact.lock'), canonicalJson(activeLock));
    const core = baseCore({ validationRunId, evaluationVersion });
    const result = publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts(), lockTimeoutMs: 150 });
    assert.equal(result.operationStatus, 'FAILED');
    assert.equal(result.reasonCode, 'ARTIFACT_LOCK_TIMEOUT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D7锁协议：陈旧锁（lease已过期+PID不存在）在staleLockRecovery=true时被隔离，随后发布成功', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    const evaluationVersion = 'v1.4d-eval-lock2';
    const targetDir = targetDirFor(root, 'dry-run', validationRunId, evaluationVersion);
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const deadPid = findLikelyDeadPid();
    const staleLock = {
      schemaVersion: 'v1.4d-artifact-lock/2', lockId: '4'.repeat(32), ownerToken: '5'.repeat(64),
      targetIdentitySha256: '6'.repeat(64), hostIdentitySha256: sha256Hex(`host:${os.hostname()}`),
      pid: deadPid, processStartIdentity: 'pid-only-nonexistent',
      ownerUid: process.getuid ? process.getuid() : 0,
      acquiredAt: new Date(Date.now() - 7200000).toISOString(), leaseExpiresAt: new Date(Date.now() - 3600000).toISOString()
    };
    writeFileSync(path.join(targetDir, '.research-artifact.lock'), canonicalJson(staleLock));
    const core = baseCore({ validationRunId, evaluationVersion });
    const result = publishArtifact({ root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion, core, ...publishOpts(), lockTimeoutMs: 5000, staleLockRecovery: true });
    assert.equal(result.operationStatus, 'PUBLISHED');
    assert.ok(result.runtimeEvents.includes('ARTIFACT_STALE_LOCK_QUARANTINED'));
    const entries = readdirSync(targetDir);
    assert.ok(entries.some(name => name.startsWith('.research-artifact.lock.stale.')), '陈旧锁必须被隔离改名，不得直接删除或覆盖');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function computeProcessStartIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = afterComm.trim().split(/\s+/);
    const startTimeTicks = fields[19];
    if (startTimeTicks && /^[0-9]+$/.test(startTimeTicks)) return `linux-starttime-${startTimeTicks}`;
  } catch { /* not linux */ }
  return `pid-only-${pid}`;
}
function findLikelyDeadPid() {
  // 选一个大概率不存在的PID（远超常见系统PID上限），用于模拟"进程已死"场景。
  return 2 ** 22 - 1;
}

function existsAny(dirPath) {
  if (!existsSync(dirPath)) return false;
  try {
    return readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}
