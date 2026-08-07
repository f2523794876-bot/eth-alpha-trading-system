// d8-status-reader.js / d8-artifact-discovery.js 测试——NOT_RUN/RUNNING/BLOCKED/GO/FAILED
// 全状态覆盖，白名单字段投影，且验证historical_validation从不出现在本文件的任何导入/调用中
// （结构性红线自检，见下方最后一个测试）。真实文件系统，不mock。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, symlinkSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readD8DisplayStatus } from './d8-status-reader.js';
import { findLatestFormalArtifactDir } from './d8-artifact-discovery.js';
import { publishArtifact } from './artifact-publisher.js';
import { SIDECAR_FILE_NAME } from './artifact-reader.js';
import {
  createResearchRunIdentity, writeRunStatus, initialRunStatus, withBatchCompleted, withBlocked, withCompleted, withFailed
} from './research-run-status.js';
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
const NO_GO_INPUT = frozenVector('NO_GO').input;
const NO_GO_DECISION = evaluateGoNoGo(NO_GO_INPUT);

function sha256Hex(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function makeRoot() { return mkdtempSync(path.join(os.tmpdir(), 'd8-status-reader-')); }
function runIdentity(validationRunId, evaluationVersion, artifactMode) {
  return createResearchRunIdentity({ validationRunId, evaluationVersion, artifactMode, config: {
    gitObjectFormat: 'SHA1', sourceIdentity: 'MODULE_TEST', sourceVersion: 'v1.4d-test-config/1', sourceCommit: 'a'.repeat(40), datasetVersion: GO_INPUT.auditTrail.datasetVersion,
    featureEngineVersion: 'feature-1', algorithmVersion: 'algorithm-1', ruleVersion: 'rule-1',
    evaluationVersion, weightVersion: 'weight-1', horizons: ['24h', '72h'],
    researchFrom: '2026-01-01T00:00:00.000Z', researchTo: '2026-01-08T00:00:00.000Z',
    fixedAsOf: '2026-01-08T00:00:00.000Z', thresholds: GO_INPUT.thresholds
  } });
}
function initial(validationRunId, totalBatches, now) {
  return initialRunStatus({ runIdentity: runIdentity(validationRunId, 'display-status-test', 'FORMAL'), totalBatches, ...(now ? { now } : {}) });
}

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
    runIdentity: runIdentity(validationRunId, evaluationVersion, 'FORMAL'),
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

// 使用NO_GO_INPUT自己的thresholds/datasetVersion构造身份，不复用GO_INPUT的固定值
// （二者可能不同，混用会导致thresholdsSha256/datasetVersion与runIdentity不一致而被拒绝）。
function publishNoGo(root, validationRunId, evaluationVersion = 'v1.4d-eval-d8-display-nogo') {
  const identity = createResearchRunIdentity({ validationRunId, evaluationVersion, artifactMode: 'FORMAL', config: {
    gitObjectFormat: 'SHA1', sourceIdentity: 'MODULE_TEST', sourceVersion: 'v1.4d-test-config/1', sourceCommit: 'a'.repeat(40), datasetVersion: NO_GO_INPUT.auditTrail.datasetVersion,
    featureEngineVersion: 'feature-1', algorithmVersion: 'algorithm-1', ruleVersion: 'rule-1',
    evaluationVersion, weightVersion: 'weight-1', horizons: ['24h', '72h'],
    researchFrom: '2026-01-01T00:00:00.000Z', researchTo: '2026-01-08T00:00:00.000Z',
    fixedAsOf: '2026-01-08T00:00:00.000Z', thresholds: NO_GO_INPUT.thresholds
  } });
  const core = {
    validationRunId, evaluationVersion, gitObjectFormat: 'SHA1', sourceCommit: 'a'.repeat(40), runIdentity: identity,
    d8InputSha256: 'b'.repeat(64), researchFrom: '2026-01-01T00:00:00.000Z', researchTo: '2026-01-08T00:00:00.000Z',
    fixedAsOf: '2026-01-08T00:00:00.000Z', thresholds: NO_GO_INPUT.thresholds, scorecard: NO_GO_INPUT.scorecard,
    auditTrail: { ...NO_GO_INPUT.auditTrail, authenticityGateStatus: 'PASSED', manifestCoverage: 1, featureCoverage: 1, validationRunStatus: 'SUCCEEDED' },
    decision: { ...NO_GO_DECISION, validationRunId, evaluatedAt: '2026-01-08T00:04:00.000Z' },
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
    writeRunStatus(statusRoot, initial(validationRunId, 5));
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
    let status = initial(validationRunId, 4);
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
    let status = initial(validationRunId, 4);
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
    let status = initial(validationRunId, 2);
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
    const older = initial(randomUUID(), 3, '2026-01-01T00:00:00.000Z');
    const newer = initial(randomUUID(), 7, '2026-01-08T00:00:00.000Z');
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
      runIdentity: runIdentity(validationRunId, 'v1.4d-eval-dry-run-isolation', 'DRY_RUN'),
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

function candidatePath(statusRoot, identity) {
  const dir = path.join(statusRoot, 'run-status', 'formal', identity.validationRunId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${identity.runIdentitySha256}.status.json`);
}

for (const [label, mutate] of [
  ['截断JSON', () => '{"schemaVersion":'],
  ['非法schema', status => canonicalJson({ ...status, schemaVersion: 'legacy/0' })],
  ['未知state', status => canonicalJson({ ...status, runState: 'UNKNOWN' })],
  ['identity hash不匹配', status => canonicalJson({ ...status, runIdentitySha256: 'f'.repeat(64) })]
]) test(`损坏状态fail-closed：${label}不得降级为NOT_RUN`, () => {
  const root = makeRoot(), statusRoot = makeRoot();
  try {
    const identity = runIdentity(randomUUID(), 'display-status-test', 'FORMAL');
    const status = initialRunStatus({ runIdentity: identity, totalBatches: 1 });
    writeFileSync(candidatePath(statusRoot, identity), mutate(status));
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'FAILED');
    assert.equal(result.readerReasonCode, 'RUN_STATUS_CORRUPT_CANDIDATE');
    assert.ok(!JSON.stringify(result).includes('schemaVersion'), '不得泄漏损坏候选原文');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('确定排序：有效状态与任一损坏候选并存仍fail-closed', () => {
  const root = makeRoot(), statusRoot = makeRoot();
  try {
    writeRunStatus(statusRoot, initial(randomUUID(), 1, '2026-01-08T00:00:00.000Z'));
    const corruptIdentity = runIdentity(randomUUID(), 'display-status-test', 'FORMAL');
    writeFileSync(candidatePath(statusRoot, corruptIdentity), '{partial');
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'FAILED');
    assert.equal(result.readerReasonCode, 'RUN_STATUS_CORRUPT_CANDIDATE');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('临时文件残留不是状态候选；确无status文件时才返回NOT_RUN', () => {
  const root = makeRoot(), statusRoot = makeRoot();
  try {
    const identity = runIdentity(randomUUID(), 'display-status-test', 'FORMAL');
    const dir = path.dirname(candidatePath(statusRoot, identity));
    rmSync(candidatePath(statusRoot, identity), { force: true });
    writeFileSync(path.join(dir, '.interrupted.status.json.tmp.123.token'), '{partial');
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'NOT_RUN');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// P0-01 修复回归测试（董事长/CEO授权的范围受控修复，见交付报告）
// ---------------------------------------------------------------------------

function completeStatus(statusRoot, validationRunId, evaluationVersion) {
  let status = initialRunStatus({ runIdentity: runIdentity(validationRunId, evaluationVersion, 'FORMAL'), totalBatches: 1 });
  status = writeRunStatus(statusRoot, status);
  status = withBatchCompleted(status, 0, { checkpoint: { batchIndex: 0, rowCount: 1, cursor: null, sha256: 'a'.repeat(64) } });
  status = writeRunStatus(statusRoot, status);
  return writeRunStatus(statusRoot, withCompleted(status, { publishedArtifactSha256: 'a'.repeat(64) }));
}

test('P0-01修复：X状态(COMPLETED)+Y artifact——run-status与最新已发布artifact分属两个不同合法运行时必须FAILED，不得混合展示', () => {
  const root = makeRoot(), statusRoot = makeRoot();
  try {
    const validationRunIdX = randomUUID(), validationRunIdY = randomUUID();
    const evalX = 'v1.4d-eval-p0-01-x', evalY = 'v1.4d-eval-p0-01-y';
    assert.equal(publishGo(root, validationRunIdX, evalX).operationStatus, 'PUBLISHED');
    assert.equal(publishGo(root, validationRunIdY, evalY).operationStatus, 'PUBLISHED');
    // 确定性地让Y的sidecar mtime晚于X（而不是依赖两次发布之间的真实wall-clock间隔），
    // 复现findLatestFormalArtifactDir会选中Y的场景。
    const sidecarY = path.join(root, 'formal', validationRunIdY, sha256Hex(evalY), SIDECAR_FILE_NAME);
    const future = new Date(Date.now() + 10_000);
    utimesSync(sidecarY, future, future);
    assert.equal(findLatestFormalArtifactDir(root), path.join(root, 'formal', validationRunIdY, sha256Hex(evalY)));

    // 只为X写run-status并真实推进到COMPLETED（唯一会让展示层执行到"artifact discovery"
    // 分支的run-status终态）；Y完全没有run-status记录——对应契约§4.7承认的"sidecar
    // rename成功返回后立即中断"这一正常、可恢复的中断窗口，或等价地Y从未被本编排器追踪。
    const statusX = completeStatus(statusRoot, validationRunIdX, evalX);
    assert.equal(statusX.runState, 'COMPLETED');

    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'FAILED');
    assert.equal(result.readerReasonCode, 'D8_DISPLAY_STATUS_ARTIFACT_MISMATCH');
    assert.equal(result.actionPermission, 'DISPLAY_ONLY');
    assert.ok(!('overall' in result), '身份不一致时不得展示X或Y任一运行的正式decision');
    assert.ok(!('horizonResults' in result), '身份不一致时不得展示X或Y任一运行的正式decision');
    assert.ok(!('runId' in result), '身份不一致时不得展示X或Y任一运行的runId');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('P0-01修复：合法旧artifact被放在"最新"位置(mtime操纵)但run-status指向别的运行时同样拒绝展示', () => {
  // 覆盖"合法旧artifact替换当前artifact"与"两个合法运行的主/sidecar/status交叉组合"：
  // Y本身是完全合法、独立发布的artifact（不是篡改产物），只是恰好成为文件系统层面的
  // "最新"候选，而run-status指向的其实是X——根因与上一测试相同，用不同的时间关系再验证一次。
  const root = makeRoot(), statusRoot = makeRoot();
  try {
    const validationRunIdX = randomUUID(), validationRunIdY = randomUUID();
    const evalX = 'v1.4d-eval-p0-01-old-x', evalY = 'v1.4d-eval-p0-01-new-y';
    assert.equal(publishGo(root, validationRunIdX, evalX).operationStatus, 'PUBLISHED');
    assert.equal(publishGo(root, validationRunIdY, evalY).operationStatus, 'PUBLISHED');
    const sidecarY = path.join(root, 'formal', validationRunIdY, sha256Hex(evalY), SIDECAR_FILE_NAME);
    const future = new Date(Date.now() + 20_000);
    utimesSync(sidecarY, future, future);

    completeStatus(statusRoot, validationRunIdX, evalX);
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'FAILED');
    assert.equal(result.readerReasonCode, 'D8_DISPLAY_STATUS_ARTIFACT_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('P0-01回归：单一合法运行的run-status(COMPLETED)与其自身artifact身份一致时正常展示GO，不受影响', () => {
  const root = makeRoot(), statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID(), evaluationVersion = 'v1.4d-eval-p0-01-regress-go';
    assert.equal(publishGo(root, validationRunId, evaluationVersion).operationStatus, 'PUBLISHED');
    const status = completeStatus(statusRoot, validationRunId, evaluationVersion);
    assert.equal(status.runState, 'COMPLETED');

    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'GO');
    assert.equal(result.runId, validationRunId, 'runId现在来自已验证的core.validationRunId');
    assert.deepEqual(result.progress, { currentBatch: 1, totalBatches: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('P0-01回归：没有任何run-status记录时(已被清理/从未追踪)，合法artifact仍按原逻辑正常展示，不因新增校验而拒绝', () => {
  const root = makeRoot(), statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID(), evaluationVersion = 'v1.4d-eval-p0-01-no-status';
    assert.equal(publishGo(root, validationRunId, evaluationVersion).operationStatus, 'PUBLISHED');
    // 故意不写任何run-status——对应"run-status已被清理/从未追踪，但artifact本身仍合法保留"
    // 这一正常场景（见purge.js/cleanup-single-run.js），没有可交叉核对的身份声明时
    // 不应因新增校验而回归性拒绝。
    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'GO');
    assert.equal(result.runId, validationRunId);
    assert.equal(result.progress, null);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 补充第一轮独立复审标注的NOT_COVERED动态测试（董事长/CEO本轮七要求）
// ---------------------------------------------------------------------------

test('P0-01补充：FAILED status(编排失败) + 旧FORMAL artifact共存时，展示FAILED而不是旧artifact的decision', () => {
  const root = makeRoot(), statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID(), evaluationVersion = 'v1.4d-eval-failed-plus-old-artifact';
    // 先发布一份完全合法的旧artifact（属于同一validationRunId也好、不同也好，均不应被展示——
    // FAILED分支在到达任何artifact读取代码之前就已经return）。
    assert.equal(publishGo(root, validationRunId, evaluationVersion).operationStatus, 'PUBLISHED');
    let status = initial(validationRunId, 2);
    status = withFailed(status, 'ORCHESTRATOR_PUBLISH_THREW');
    writeRunStatus(statusRoot, status);

    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'FAILED');
    assert.equal(result.readerReasonCode, 'ORCHESTRATOR_PUBLISH_THREW');
    assert.ok(!('overall' in result), 'FAILED状态不得展示旧artifact的decision');
    assert.ok(!('horizonResults' in result), 'FAILED状态不得展示旧artifact的decision');
    assert.ok(!('runId' in result), 'FAILED状态不得泄露artifact的runId');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('P0-01补充：单一合法运行的NO_GO正常展示，与GO对称处理，不受身份校验影响', () => {
  const root = makeRoot(), statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID(), evaluationVersion = 'v1.4d-eval-nogo-display';
    assert.equal(publishNoGo(root, validationRunId, evaluationVersion).operationStatus, 'PUBLISHED');
    let status = initialRunStatus({ runIdentity: createResearchRunIdentity({ validationRunId, evaluationVersion, artifactMode: 'FORMAL', config: {
      gitObjectFormat: 'SHA1', sourceIdentity: 'MODULE_TEST', sourceVersion: 'v1.4d-test-config/1', sourceCommit: 'a'.repeat(40), datasetVersion: NO_GO_INPUT.auditTrail.datasetVersion,
      featureEngineVersion: 'feature-1', algorithmVersion: 'algorithm-1', ruleVersion: 'rule-1',
      evaluationVersion, weightVersion: 'weight-1', horizons: ['24h', '72h'],
      researchFrom: '2026-01-01T00:00:00.000Z', researchTo: '2026-01-08T00:00:00.000Z',
      fixedAsOf: '2026-01-08T00:00:00.000Z', thresholds: NO_GO_INPUT.thresholds
    } }), totalBatches: 1 });
    status = writeRunStatus(statusRoot, status);
    status = withBatchCompleted(status, 0, { checkpoint: { batchIndex: 0, rowCount: 1, cursor: null, sha256: 'a'.repeat(64) } });
    status = writeRunStatus(statusRoot, status);
    status = writeRunStatus(statusRoot, withCompleted(status, { publishedArtifactSha256: 'a'.repeat(64) }));
    assert.equal(status.runState, 'COMPLETED');

    const result = readD8DisplayStatus({ artifactRoot: root, statusRoot });
    assert.equal(result.state, 'NO_GO');
    assert.equal(result.runId, validationRunId);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});
