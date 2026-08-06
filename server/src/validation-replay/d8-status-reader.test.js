// d8-status-reader.js / d8-artifact-discovery.js 测试——NOT_RUN/RUNNING/BLOCKED/GO/FAILED
// 全状态覆盖，白名单字段投影，且验证historical_validation从不出现在本文件的任何导入/调用中
// （结构性红线自检，见下方最后一个测试）。真实文件系统，不mock。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readD8DisplayStatus } from './d8-status-reader.js';
import { findLatestFormalArtifactDir } from './d8-artifact-discovery.js';
import { publishArtifact } from './artifact-publisher.js';
import { writeRunStatus, initialRunStatus, withBlocked, withFailed } from './research-run-status.js';
import { evaluateGoNoGo } from '../formal-research/go-no-go-evaluator.js';
import { canonicalJson } from '../formal-research/canonical-json.js';

const CONTRACT_TEXT = readFileSync(new URL('../../../V1_4D_FORMAL_RESEARCH_EXECUTION_CONTRACT_V8_FINAL_R3.md', import.meta.url), 'utf8');
function frozenVector(id) {
  const pattern = /#### (非法)?向量 `([^`]+)`\n\n([^\n]+)\n\n```json\n([\s\S]*?)\n```/g;
  const vectors = [...CONTRACT_TEXT.matchAll(pattern)].map(([, invalid, vid, summary, source]) => ({ id: vid, value: JSON.parse(source) }));
  return vectors.find(v => v.id === id).value;
}
const GO_INPUT = frozenVector('GO').input;
const GO_DECISION = evaluateGoNoGo(GO_INPUT);

function sha256Hex(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function makeRoot() { return mkdtempSync(path.join(os.tmpdir(), 'd8-status-reader-')); }

function governanceRef(validationRunId) {
  const thresholdsSha256 = sha256Hex(canonicalJson(GO_INPUT.thresholds));
  return {
    authorizationSchemaVersion: 'v1.4d-governance-authorization/1', recordSha256: 'd'.repeat(64), hashAlgorithm: 'SHA-256',
    validationRunId, thresholdsSha256, authorizationScope: 'FORMAL_RESEARCH_EXECUTION', decision: 'APPROVE'
  };
}

function publishGo(root, validationRunId, evaluationVersion = 'v1.4d-eval-d8-display') {
  const core = {
    validationRunId, evaluationVersion, gitObjectFormat: 'SHA1', sourceCommit: 'a'.repeat(40),
    d8InputSha256: 'b'.repeat(64), researchFrom: '2026-01-01T00:00:00.000Z', researchTo: '2026-01-08T00:00:00.000Z',
    fixedAsOf: '2026-01-08T00:00:00.000Z', thresholds: GO_INPUT.thresholds, scorecard: GO_INPUT.scorecard,
    auditTrail: { ...GO_INPUT.auditTrail, authenticityGateStatus: 'PASSED', manifestCoverage: 1, featureCoverage: 1, validationRunStatus: 'SUCCEEDED' },
    decision: { ...GO_DECISION, validationRunId, evaluatedAt: '2026-01-08T00:04:00.000Z' },
    governanceAuthorizationRef: governanceRef(validationRunId)
  };
  return publishArtifact({
    root, artifactMode: 'FORMAL', validationRunId, evaluationVersion, core,
    manifestContentHash: 'c'.repeat(64), validationRunFinishedAt: '2026-01-08T00:05:00.000Z'
  });
}

test('NOT_RUN：root下无任何FORMAL发布', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'NOT_RUN');
    assert.equal(result.message, '暂无正式研究结果');
    assert.equal(result.actionPermission, 'DISPLAY_ONLY');
    assert.equal('progress' in result, false, 'NOT_RUN不得包含任何进度/数值字段');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('GO：已发布合法FORMAL artifact，白名单字段投影正确，且不透传路径/内部字段', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    const publishResult = publishGo(root, validationRunId);
    assert.equal(publishResult.operationStatus, 'PUBLISHED');
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, GO_DECISION.overall.status);
    assert.equal(result.runId, validationRunId);
    assert.equal(result.actionPermission, 'DISPLAY_ONLY');
    assert.ok(result.horizonResults['24h']);
    assert.ok(result.horizonResults['72h']);
    assert.equal(result.horizonResults['24h'].wilson95.confidenceLevel, 0.95);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(root), '不得泄漏文件系统绝对路径');
    assert.ok(!/featureValues|candidateTrajectories/.test(serialized), '不得泄漏D8内部字段');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('RUNNING：首次运行、尚无任何已发布artifact时也必须能观察到RUNNING+进度（不依赖已发布产物定位run-status）', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    writeRunStatus(statusRoot, initialRunStatus({ validationRunId, artifactMode: 'FORMAL', totalBatches: 5 }));
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'RUNNING');
    assert.equal(result.progress.totalBatches, 5);
    assert.equal(result.progress.currentBatch, 0);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('RUNNING：已有一次GO发布之后，同一validationRunId的run-status变为RUNNING（新一轮）：优先展示RUNNING+进度', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    publishGo(root, validationRunId);
    let status = initialRunStatus({ validationRunId, artifactMode: 'FORMAL', totalBatches: 4 });
    writeRunStatus(statusRoot, status);
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'RUNNING');
    assert.equal(result.progress.totalBatches, 4);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('BLOCKED：run-status为BLOCKED时展示阻塞原因，不展示任何虚构结论', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    publishGo(root, validationRunId);
    let status = initialRunStatus({ validationRunId, artifactMode: 'FORMAL', totalBatches: 4 });
    status = withBlocked(status, 'GOVERNANCE_AUTHORIZATION_MISSING');
    writeRunStatus(statusRoot, status);
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'BLOCKED');
    assert.equal(result.blockedReasonCode, 'GOVERNANCE_AUTHORIZATION_MISSING');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('FAILED：sidecar被篡改（hash不再匹配）时报告FAILED，不静默回退成功态', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    publishGo(root, validationRunId);
    const dir = findLatestFormalArtifactDir(root);
    const sidecarPath = path.join(dir, 'research-artifact.sha256.json');
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    sidecar.fullMainArtifactSha256 = 'f'.repeat(64);
    writeFileSync(sidecarPath, JSON.stringify(sidecar));
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'FAILED');
    assert.equal(result.readerReasonCode, 'ARTIFACT_HASH_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('FAILED（编排失败，非artifact读取失败）：runState为FAILED时展示FAILED而不是回退成功态或NOT_RUN', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    let status = initialRunStatus({ validationRunId, artifactMode: 'FORMAL', totalBatches: 2 });
    status = withFailed(status, 'ORCHESTRATOR_PUBLISH_THREW');
    writeRunStatus(statusRoot, status);
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'FAILED');
    assert.equal(result.readerReasonCode, 'ORCHESTRATOR_PUBLISH_THREW');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('findMostRecentRunStatus：多个run-status文件并存时只取updatedAt最新的一条', () => {
  const statusRoot = makeRoot();
  try {
    const older = initialRunStatus({ validationRunId: randomUUID(), artifactMode: 'FORMAL', totalBatches: 3, now: '2026-01-01T00:00:00.000Z' });
    const newer = initialRunStatus({ validationRunId: randomUUID(), artifactMode: 'FORMAL', totalBatches: 7, now: '2026-01-08T00:00:00.000Z' });
    writeRunStatus(statusRoot, older);
    writeRunStatus(statusRoot, newer);
    const root = makeRoot();
    try {
      const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
      assert.equal(result.state, 'RUNNING');
      assert.equal(result.progress.totalBatches, 7, '必须选中updatedAt更晚的那一条，不是文件系统枚举顺序里先出现的');
    } finally { rmSync(root, { recursive: true, force: true }); }
  } finally { rmSync(statusRoot, { recursive: true, force: true }); }
});

test('DRY_RUN隔离：DRY_RUN artifact即使存在于artifactRoot下，也绝不会被展示层当作正式结果', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    const thresholdsSha256 = sha256Hex(canonicalJson(GO_INPUT.thresholds));
    void thresholdsSha256;
    const core = {
      validationRunId, evaluationVersion: 'v1.4d-eval-dry-run-isolation', gitObjectFormat: 'SHA1', sourceCommit: 'a'.repeat(40),
      d8InputSha256: 'b'.repeat(64), researchFrom: '2026-01-01T00:00:00.000Z', researchTo: '2026-01-08T00:00:00.000Z',
      fixedAsOf: '2026-01-08T00:00:00.000Z', thresholds: GO_INPUT.thresholds, scorecard: GO_INPUT.scorecard,
      auditTrail: { ...GO_INPUT.auditTrail, authenticityGateStatus: 'PASSED', manifestCoverage: 1, featureCoverage: 1, validationRunStatus: 'SUCCEEDED' },
      decision: { ...GO_DECISION, validationRunId }, governanceAuthorizationRef: null
    };
    const publishResult = publishArtifact({
      root, artifactMode: 'DRY_RUN', validationRunId, evaluationVersion: 'v1.4d-eval-dry-run-isolation', core,
      manifestContentHash: 'c'.repeat(64), validationRunFinishedAt: '2026-01-08T00:05:00.000Z'
    });
    assert.equal(publishResult.operationStatus, 'PUBLISHED');
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'NOT_RUN', 'DRY_RUN产物绝不能被正式展示层当作GO/CONDITIONAL_GO/NO_GO结果');
    assert.equal(result.message, '暂无正式研究结果');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('discovery：不追踪符号链接作为候选目录（防御符号链接攻击）', () => {
  const root = makeRoot();
  try {
    const validationRunId = randomUUID();
    publishGo(root, validationRunId);
    const realDir = findLatestFormalArtifactDir(root);
    const fakeRunDir = path.join(root, 'formal', randomUUID());
    mkdirSync(fakeRunDir, { recursive: true });
    const fakeLeaf = path.join(fakeRunDir, 'evil-eval-identity');
    mkdirSync(fakeLeaf);
    symlinkSync(path.join(realDir, 'research-artifact.sha256.json'), path.join(fakeLeaf, 'research-artifact.sha256.json'));
    const found = findLatestFormalArtifactDir(root);
    assert.equal(found, realDir, '符号链接不得被当作可能更"新"的候选');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('结构性红线自检：d8-status-reader.js源码不引用historical_validation，也不import evaluateGoNoGo', () => {
  const source = readFileSync(new URL('./d8-status-reader.js', import.meta.url), 'utf8');
  assert.ok(!/historical_validation/i.test(source), 'D8展示只读层不得直接引用historical_validation表');
  assert.ok(!/evaluateGoNoGo/.test(source), 'D8展示只读层不得调用evaluateGoNoGo()——决策只能来自D7已发布产物');
  assert.ok(!/INSERT INTO|UPDATE |DELETE FROM/i.test(source), 'D8展示只读层不得包含任何写入SQL');
});
