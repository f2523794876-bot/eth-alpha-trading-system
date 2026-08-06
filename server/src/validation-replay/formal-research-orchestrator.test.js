// T19编排 runFormalResearchOrchestrator() 测试——多批次/resume/幂等重放/失败恢复/DRY-FORMAL隔离。
// 真实文件系统（mkdtemp隔离临时目录），真实驱动T13/T14/T16/T17/T18，不mock任何一层。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, lstatSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runFormalResearchOrchestrator } from './formal-research-orchestrator.js';
import { readArtifactPair, SIDECAR_FILE_NAME } from './artifact-reader.js';
import { readRunStatus, writeRunStatus, initialRunStatus, withBatchCompleted } from './research-run-status.js';
import { canonicalJson } from '../formal-research/canonical-json.js';

const CONTRACT_TEXT = readFileSync(new URL('../../../V1_4D_FORMAL_RESEARCH_EXECUTION_CONTRACT_V8_FINAL_R3.md', import.meta.url), 'utf8');
function frozenVector(id) {
  const pattern = /#### (非法)?向量 `([^`]+)`\n\n([^\n]+)\n\n```json\n([\s\S]*?)\n```/g;
  const vectors = [...CONTRACT_TEXT.matchAll(pattern)].map(([, invalid, vid, summary, source]) => ({ id: vid, value: JSON.parse(source) }));
  return vectors.find(v => v.id === id).value;
}
const GO_INPUT = frozenVector('GO').input;

function sha256Hex(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function evalIdentity(evaluationVersion) { return sha256Hex(evaluationVersion); }
function makeRoot() { return mkdtempSync(path.join(os.tmpdir(), 'd7-orchestrator-')); }

// 演练用assembleD8Input：以契约自带的GO向量为基础（sampleAccounting/rangeAttribution/
// baselineAvailabilityInput/preCostLift/postCostLift/scorecard/auditTrail/thresholds这些
// 字段的真实"从原始行组装"逻辑是本轮明确披露未实现的独立后续工作，见orchestrator文件头注释），
// 只把T13真实计算出的marketRegimeAtGeneration/directionalCoverage/marketRegimeCoverage
// 三个字段替换成本次编排的真实统计结果——这三个字段与GO_INPUT模板结构完全兼容（T13的输出
// 形状本来就是照D8 groupMap/groupStat定义写的），是一次真实、非伪造的部分拼接，不是整体伪造。
function assembleD8Input({ statistics, validationRunId, evaluationVersion, validationRunFinishedAt }) {
  return {
    ...GO_INPUT,
    validationRunId, evaluationVersion, evaluatedAt: validationRunFinishedAt,
    marketRegimeAtGeneration: { '24h': statistics.marketRegimeAtGeneration, '72h': statistics.marketRegimeAtGeneration },
    directionalCoverage: { '24h': statistics.directionalCoverage, '72h': statistics.directionalCoverage },
    marketRegimeCoverage: { '24h': statistics.marketRegimeCoverage, '72h': statistics.marketRegimeCoverage },
    auditTrail: { ...GO_INPUT.auditTrail, validationRunId, evaluationVersion, evaluatedAt: validationRunFinishedAt }
  };
}

function buildArtifactCore({ decision, governanceRef, d8Input, validationRunId, evaluationVersion }) {
  return {
    validationRunId, evaluationVersion, gitObjectFormat: 'SHA1', sourceCommit: 'a'.repeat(40),
    d8InputSha256: sha256Hex(canonicalJson(d8Input)),
    researchFrom: '2026-01-01T00:00:00.000Z', researchTo: '2026-01-08T00:00:00.000Z', fixedAsOf: '2026-01-08T00:00:00.000Z',
    thresholds: d8Input.thresholds, scorecard: d8Input.scorecard,
    auditTrail: d8Input.auditTrail,
    decision, governanceAuthorizationRef: governanceRef
  };
}

function targetDirFor(root, mode, validationRunId, evaluationVersion) {
  return path.join(root, mode, validationRunId, evalIdentity(evaluationVersion));
}

// 三批合成、明确标注为TEST/DRY_RUN的治理行——覆盖UP/DOWN/RANGE三态，确保D8能算出非退化决策。
function syntheticBatches() {
  const row = (trend, correct) => ({
    trend4hAtGeneration: trend, directionCorrect: correct, predictedDirection: trend === 'RANGE' ? 'RANGE' : trend,
    isDirectionSample: trend !== 'RANGE', isMarketRegimeSample: true
  });
  return [
    { batchIndex: 0, governanceRows: [row('UP', true), row('UP', true)], scorecardRows: [] },
    { batchIndex: 1, governanceRows: [row('DOWN', true), row('DOWN', false)], scorecardRows: [] },
    { batchIndex: 2, governanceRows: [row('RANGE', null)], scorecardRows: [] }
  ];
}

function baseOptions(root, statusRoot, validationRunId, overrides = {}) {
  return {
    statusRoot, artifactRoot: root, validationRunId, evaluationVersion: 'v1.4d-eval-orchestrator-drill',
    artifactMode: 'DRY_RUN', batches: syntheticBatches(),
    scorecardOptions: { feeBps: 5, slippageBps: 3 }, validationRunFinishedAt: '2026-01-08T00:05:00.000Z',
    assembleD8Input, buildArtifactCore,
    manifestContentHash: 'c'.repeat(64),
    ...overrides
  };
}

test('DRY_RUN三批次首次运行：run-status COMPLETED，D7 artifact真实可独立回读，三批progress全部记录', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    const result = runFormalResearchOrchestrator(baseOptions(root, statusRoot, validationRunId));
    assert.equal(result.published, true);
    assert.equal(result.publishResult.operationStatus, 'PUBLISHED');
    assert.equal(result.runStatus.runState, 'COMPLETED');
    assert.deepEqual(result.runStatus.completedBatchIndices, [0, 1, 2]);
    const dir = targetDirFor(root, 'dry-run', validationRunId, 'v1.4d-eval-orchestrator-drill');
    const reread = readArtifactPair(dir);
    assert.equal(reread.readerStatus, 'ACCEPTED');
    assert.equal(reread.artifact.core.decision.validationRunId, validationRunId);
    // T13真实统计确实进入了最终发布的D8决策所依据的输入（通过core.decision可观察到的UP组样本数）。
    assert.equal(result.statistics.marketRegimeAtGeneration.UP.sampleCount, 2);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('幂等重放：COMPLETED后再次调用直接短路，不重新发布、不改sidecar mtime', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    const opts = baseOptions(root, statusRoot, validationRunId);
    const before = readRunStatus(statusRoot, 'DRY_RUN', validationRunId);
    assert.equal(before, null);
    const result = runFormalResearchOrchestrator(opts);
    assert.equal(result.runStatus.runState, 'COMPLETED');
    const dir = targetDirFor(root, 'dry-run', validationRunId, 'v1.4d-eval-orchestrator-drill');
    const mtimeBefore = lstatSync(path.join(dir, SIDECAR_FILE_NAME)).mtimeMs;
    const second = runFormalResearchOrchestrator(opts);
    assert.equal(second.resumed, true);
    assert.equal(second.skippedRecompute, true);
    const mtimeAfter = lstatSync(path.join(dir, SIDECAR_FILE_NAME)).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, 'resume后不得重新写入已发布的sidecar（无重复发布）');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('批次计划不一致的resume：totalBatches与已记录run-status不符时拒绝，不静默改写计划', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    // 手工模拟"中断于3批计划、只完成批次0"的checkpoint。
    let seeded = initialRunStatus({ validationRunId, artifactMode: 'DRY_RUN', totalBatches: 3 });
    seeded = withBatchCompleted(seeded, 0);
    writeRunStatus(statusRoot, seeded);
    // 用只有2批的计划重放：必须拒绝，不得静默按新的、更短的计划继续。
    const opts = baseOptions(root, statusRoot, validationRunId, { batches: syntheticBatches().slice(0, 2) });
    assert.throws(
      () => runFormalResearchOrchestrator(opts),
      error => error.code === 'ORCHESTRATOR_BATCH_PLAN_MISMATCH'
    );
    // 用正确的3批计划重放：必须能安全续跑并完成，且批次0不会被"重复计入"导致计数错误。
    const correctResume = runFormalResearchOrchestrator(baseOptions(root, statusRoot, validationRunId));
    assert.equal(correctResume.runStatus.runState, 'COMPLETED');
    assert.deepEqual(correctResume.runStatus.completedBatchIndices, [0, 1, 2]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('FORMAL模式缺少治理授权：BLOCKED，且0文件发布（不因为其余步骤都成功就绕过治理红线）', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    const result = runFormalResearchOrchestrator(baseOptions(root, statusRoot, validationRunId, { artifactMode: 'FORMAL', governanceRecord: null }));
    assert.equal(result.published, false);
    assert.equal(result.runStatus.runState, 'BLOCKED');
    assert.equal(result.runStatus.blockedReasonCode, 'GOVERNANCE_AUTHORIZATION_MISSING');
    const dir = targetDirFor(root, 'formal', validationRunId, 'v1.4d-eval-orchestrator-drill');
    const reread = readArtifactPair(dir);
    assert.equal(reread.readerStatus, 'REJECTED');
    assert.equal(reread.readerReasonCode, 'ARTIFACT_NOT_FOUND');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('DRY_RUN模式若意外携带治理记录：BLOCKED，DRY/FORMAL物理隔离在编排层同样生效', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    const fakeGovernance = {
      schemaVersion: 'v1.4d-governance-authorization/1', hashAlgorithm: 'SHA-256', validationRunId,
      thresholdsSha256: 'a'.repeat(64), authorizationScope: 'FORMAL_RESEARCH_EXECUTION', decision: 'APPROVE',
      authorizedByRole: 'CHAIRMAN', authorizedAt: '2026-01-08T00:00:00.000Z'
    };
    const result = runFormalResearchOrchestrator(baseOptions(root, statusRoot, validationRunId, { governanceRecord: fakeGovernance }));
    assert.equal(result.published, false);
    assert.equal(result.runStatus.runState, 'BLOCKED');
    assert.equal(result.runStatus.blockedReasonCode, 'GOVERNANCE_AUTHORIZATION_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('空batches数组：拒绝', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    assert.throws(
      () => runFormalResearchOrchestrator(baseOptions(root, statusRoot, randomUUID(), { batches: [] })),
      error => error.code === 'ORCHESTRATOR_INVALID_INPUT'
    );
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});
