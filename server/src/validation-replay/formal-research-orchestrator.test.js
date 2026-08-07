// T19编排 runFormalResearchOrchestrator() 测试——多批次/resume/幂等重放/失败恢复/DRY-FORMAL隔离。
// 真实文件系统（mkdtemp隔离临时目录），真实驱动T13/T14/T16/T17/T18，不mock任何一层。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runFormalResearchOrchestrator } from './formal-research-orchestrator.js';
import { readArtifactPair, SIDECAR_FILE_NAME } from './artifact-reader.js';
import { createResearchRunIdentity, writeRunStatus, initialRunStatus, withBatchCompleted } from './research-run-status.js';
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
    gitObjectFormat: 'SHA1', sourceCommit: 'a'.repeat(40), datasetVersion: GO_INPUT.auditTrail.datasetVersion,
    featureEngineVersion: 'v1.4b-feature-engine-1', algorithmVersion: 'v1.4c-server-po-rule-1',
    ruleVersion: 'rule-1', weightVersion: 'weight-1', horizons: ['24h', '72h'],
    researchFrom: '2026-01-01T00:00:00.000Z', researchTo: '2026-01-08T00:00:00.000Z',
    fixedAsOf: '2026-01-08T00:00:00.000Z', thresholds: GO_INPUT.thresholds,
    scorecardOptions: { feeBps: 5, slippageBps: 3 }, validationRunFinishedAt: '2026-01-08T00:05:00.000Z',
    assembleD8Input, buildArtifactCore,
    manifestContentHash: 'c'.repeat(64),
    ...overrides
  };
}

function identityForOptions(options) {
  return createResearchRunIdentity({ validationRunId: options.validationRunId, evaluationVersion: options.evaluationVersion,
    artifactMode: options.artifactMode, config: { source: 'MEMORY', sourceIdentity: 'MEMORY', sourceVersion: 'v1.4d-memory-run-config/1', scorecardOptions: options.scorecardOptions,
      gitObjectFormat: options.gitObjectFormat, sourceCommit: options.sourceCommit, datasetVersion: options.datasetVersion,
      featureEngineVersion: options.featureEngineVersion, algorithmVersion: options.algorithmVersion,
      ruleVersion: options.ruleVersion, evaluationVersion: options.evaluationVersion, weightVersion: options.weightVersion,
      horizons: options.horizons, researchFrom: options.researchFrom, researchTo: options.researchTo,
      fixedAsOf: options.fixedAsOf,
      validationRunFinishedAt: options.validationRunFinishedAt, thresholds: options.thresholds ?? null,
      expectedThresholdsSha256: options.expectedThresholdsSha256 ?? null,
      governanceRecordSha256: options.governanceRecord == null ? null : sha256Hex(canonicalJson(options.governanceRecord)),
      manifestContentHash: options.manifestContentHash ?? null,
      batchSize: null, batchPlanSha256: sha256Hex(canonicalJson(options.batches)) } });
}

test('DRY_RUN三批次首次运行：run-status COMPLETED，D7 artifact真实可独立回读，三批progress全部记录', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    const result = runFormalResearchOrchestrator(baseOptions(root, statusRoot, validationRunId));
    assert.equal(result.published, true, JSON.stringify(result));
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

test('P0完整run identity拒绝不同evaluation/config和旧状态，精确相同identity才允许resume', () => {
  const root = makeRoot(), statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    const opts = baseOptions(root, statusRoot, validationRunId);
    assert.equal(runFormalResearchOrchestrator(opts).published, true);
    assert.throws(() => runFormalResearchOrchestrator({ ...opts, evaluationVersion: 'other-evaluation' }),
      error => error.code === 'RUN_STATUS_IDENTITY_MISMATCH');
    assert.throws(() => runFormalResearchOrchestrator({ ...opts, scorecardOptions: { feeBps: 6, slippageBps: 3 } }),
      error => error.code === 'RUN_STATUS_IDENTITY_MISMATCH');
    const otherRoot = makeRoot();
    try {
      const legacyId = randomUUID();
      const legacyDir = path.join(otherRoot, 'run-status', 'dry-run');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(path.join(legacyDir, `${legacyId}.status.json`), '{}');
      assert.throws(() => runFormalResearchOrchestrator(baseOptions(root, otherRoot, legacyId)),
        error => error.code === 'RUN_STATUS_LEGACY_REJECTED');
    } finally { rmSync(otherRoot, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('P0 COMPLETED快捷路径必须回读artifact pair；损坏时拒绝复用且不得把COMPLETED回退为BLOCKED', () => {
  for (const damage of ['missing', 'mismatch']) {
    const root = makeRoot(), statusRoot = makeRoot();
    try {
      const validationRunId = randomUUID();
      const opts = baseOptions(root, statusRoot, validationRunId);
      assert.equal(runFormalResearchOrchestrator(opts).published, true);
      const dir = targetDirFor(root, 'dry-run', validationRunId, opts.evaluationVersion);
      if (damage === 'missing') rmSync(path.join(dir, SIDECAR_FILE_NAME));
      else {
        const sidecarPath = path.join(dir, SIDECAR_FILE_NAME);
        const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
        sidecar.fullMainArtifactSha256 = 'f'.repeat(64);
        writeFileSync(sidecarPath, canonicalJson(sidecar));
      }
      const resumed = runFormalResearchOrchestrator(opts);
      assert.equal(resumed.published, false);
      assert.equal(resumed.runStatus.runState, 'COMPLETED');
      assert.equal(resumed.error.code, 'ORCHESTRATOR_COMPLETED_ARTIFACT_INVALID');
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
  }
});

for (const field of ['algorithmVersion', 'ruleVersion', 'weightVersion']) test(`P0 COMPLETED回读拒绝自洽重哈希后的${field}跨配置复用`, () => {
  const root = makeRoot(), statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    const opts = baseOptions(root, statusRoot, validationRunId);
    assert.equal(runFormalResearchOrchestrator(opts).published, true);
    const dir = targetDirFor(root, 'dry-run', validationRunId, opts.evaluationVersion);
    const mainPath = path.join(dir, 'research-artifact.json'), sidecarPath = path.join(dir, SIDECAR_FILE_NAME);
    const main = JSON.parse(readFileSync(mainPath, 'utf8'));
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    main.core.runIdentity[field] = `${field}-tampered`;
    const { runIdentitySha256: ignored, ...identityCore } = main.core.runIdentity;
    void ignored;
    main.core.runIdentity.runIdentitySha256 = sha256Hex(canonicalJson(identityCore));
    const mainBytes = canonicalJson(main);
    sidecar.fullMainArtifactSha256 = sha256Hex(mainBytes);
    rmSync(mainPath); rmSync(sidecarPath);
    writeFileSync(mainPath, mainBytes); writeFileSync(sidecarPath, canonicalJson(sidecar));
    const resumed = runFormalResearchOrchestrator(opts);
    assert.equal(resumed.published, false);
    assert.equal(resumed.runStatus.runState, 'COMPLETED');
    assert.equal(resumed.error.code, 'ORCHESTRATOR_COMPLETED_ARTIFACT_INVALID');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('批次计划不一致的resume：totalBatches与已记录run-status不符时拒绝，不静默改写计划', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    // 手工模拟"中断于3批计划、只完成批次0"的checkpoint。
    const seededOptions = baseOptions(root, statusRoot, validationRunId);
    let seeded = initialRunStatus({ runIdentity: identityForOptions(seededOptions), totalBatches: 3 });
    const firstBatch = syntheticBatches()[0];
    const checkpointHash = createHash('sha256').update(canonicalJson(firstBatch), 'utf8').digest('hex');
    seeded = withBatchCompleted(seeded, 0, { checkpoint: { batchIndex: 0, rowCount: firstBatch.scorecardRows.length, cursor: null, sha256: checkpointHash } });
    writeRunStatus(statusRoot, seeded);
    // 用只有2批的计划重放：必须拒绝，不得静默按新的、更短的计划继续。
    const opts = baseOptions(root, statusRoot, validationRunId, { batches: syntheticBatches().slice(0, 2) });
    assert.throws(
      () => runFormalResearchOrchestrator(opts),
      error => error.code === 'RUN_STATUS_IDENTITY_MISMATCH'
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
      error => error.code === 'ORCHESTRATOR_BATCH_PLAN_INVALID'
    );
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('真实结构DRY_RUN：无GO模板/无assemble hook，逐行数据组装D8并完成D7发布回读', () => {
  const root = makeRoot();
  const statusRoot = makeRoot();
  try {
    const validationRunId = randomUUID();
    const trainEnd = Date.parse('2026-01-04T00:00:00Z');
    const validationEnd = Date.parse('2026-01-07T00:00:00Z');
    const make = (horizon, index, split, actual) => {
      const origin = { TRAIN: Date.parse('2026-01-01T00:00:00Z'), VALIDATION: trainEnd, TEST: validationEnd }[split];
      const width = horizon === '24h' ? 86400000 : 259200000;
      return { predictionId: `${horizon}-${split}-${index}`, horizon, targetStartTime: origin + index * width, targetEndTime: origin + (index + 1) * width,
        actualDirection: actual, predictedDirection: actual, trend4hDirection: actual, trend4hAtGeneration: actual,
        directionCorrect: true, directionEligibleForStatistics: true, pathEligibleForStatistics: true, isDirectionSample: true, isMarketRegimeSample: true,
        actualReturn: actual === 'UP' ? .02 : actual === 'DOWN' ? -.02 : .001, mfe: .02, mae: .01, endpointDataComplete: true, pathDataComplete: true };
    };
    const rows = [];
    for (const horizon of ['24h', '72h']) for (const split of ['TRAIN', 'VALIDATION', 'TEST']) {
      rows.push(make(horizon, 0, split, 'UP'), make(horizon, 1, split, 'DOWN'), make(horizon, 2, split, 'RANGE'));
    }
    const opts = baseOptions(root, statusRoot, validationRunId, {
      batches: [{ batchIndex: 0, governanceRows: rows, scorecardRows: rows }], assembleD8Input: null,
      trainEnd, validationEnd, scorecardOptions: { feeBps: 5, slippageBps: 3, trainEnd, validationEnd }, thresholds: GO_INPUT.thresholds,
      databaseAuditTrail: { ...GO_INPUT.auditTrail, validationRunId, evaluationVersion: 'v1.4d-eval-orchestrator-drill', evaluatedAt: '2026-01-08T00:05:00.000Z', manifestContentHash: 'c'.repeat(64), backfillBatchIds: [], vintageIds: [] }
    });
    const result = runFormalResearchOrchestrator(opts);
    assert.equal(result.published, true, JSON.stringify(result));
    assert.equal(result.runStatus.runState, 'COMPLETED');
    assert.equal(result.decision.validationRunId, validationRunId);
    assert.equal(result.decision.horizonResults['24h'].effectiveTest, 3);
    const dir = targetDirFor(root, 'dry-run', validationRunId, opts.evaluationVersion);
    assert.equal(readArtifactPair(dir).readerStatus, 'ACCEPTED');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('P1零有效TEST：DRY_RUN可审计地产生DATA_GATE_FAILED，FORMAL即使授权有效也不得发布成功artifact', () => {
  for (const artifactMode of ['DRY_RUN', 'FORMAL']) {
    const root = makeRoot(), statusRoot = makeRoot();
    try {
      const validationRunId = randomUUID();
      const thresholdHash = sha256Hex(canonicalJson(GO_INPUT.thresholds));
      const governanceRecord = artifactMode === 'FORMAL' ? {
        schemaVersion: 'v1.4d-governance-authorization/1', hashAlgorithm: 'SHA-256', validationRunId,
        thresholdsSha256: thresholdHash, authorizationScope: 'FORMAL_RESEARCH_EXECUTION', decision: 'APPROVE',
        authorizedByRole: 'CHAIRMAN', authorizedAt: '2026-01-08T00:05:00.000Z'
      } : null;
      const opts = baseOptions(root, statusRoot, validationRunId, {
        artifactMode, batches: [{ batchIndex: 0, governanceRows: [], scorecardRows: [] }], assembleD8Input: null,
        scorecardOptions: { feeBps: 5, slippageBps: 3, trainEnd: Date.parse('2026-01-04T00:00:00Z'), validationEnd: Date.parse('2026-01-07T00:00:00Z') },
        thresholds: GO_INPUT.thresholds, expectedThresholdsSha256: thresholdHash, governanceRecord,
        databaseAuditTrail: { schemaVersion: 'v1.4d-audit-trail/1', validationRunId,
          evaluationVersion: 'v1.4d-eval-orchestrator-drill', evaluatedAt: '2026-01-08T00:05:00.000Z',
          validationRunStatus: 'SUCCEEDED', authenticityGateStatus: 'PASSED', manifestCoverage: 0, featureCoverage: 0,
          datasetVersion: GO_INPUT.auditTrail.datasetVersion, manifestContentHash: 'c'.repeat(64), backfillBatchIds: [], vintageIds: [],
          generationSummary: { expected: 0, attempted: 0, inserted: 0, reusedIdentical: 0, conflicts: 0, blocked: 0, evaluated: 0 } }
      });
      const result = runFormalResearchOrchestrator(opts);
      assert.equal(result.decision.overall.status, 'DATA_GATE_FAILED');
      assert.ok(result.decision.horizonResults['24h'].reasonCodes.includes('EFFECTIVE_TEST_ZERO'));
      if (artifactMode === 'DRY_RUN') assert.equal(result.published, true);
      else {
        assert.equal(result.published, false);
        assert.equal(result.runStatus.runState, 'BLOCKED');
        assert.equal(result.error.code, 'ORCHESTRATOR_FORMAL_DATA_GATE_FAILED');
        assert.equal(readArtifactPair(targetDirFor(root, 'formal', validationRunId, opts.evaluationVersion)).readerStatus, 'REJECTED');
      }
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
  }
});

test('scorecard失败不提前写checkpoint，assembly失败为BLOCKED，buildArtifactCore失败为FAILED且均不发布', () => {
  for (const stage of ['scorecard', 'assembly', 'core']) {
    const root = makeRoot();
    const statusRoot = makeRoot();
    try {
      const validationRunId = randomUUID();
      const overrides = stage === 'scorecard'
        ? { scorecardOptions: {} }
        : stage === 'assembly'
          ? { assembleD8Input: () => { throw Object.assign(new Error('secret detail'), { code: 'ASSEMBLY_TEST_FAILURE' }); } }
          : { buildArtifactCore: () => { throw Object.assign(new Error('secret detail'), { code: 'CORE_TEST_FAILURE' }); } };
      const result = runFormalResearchOrchestrator(baseOptions(root, statusRoot, validationRunId, overrides));
      assert.equal(result.published, false);
      assert.equal(result.runStatus.runState, stage === 'core' ? 'FAILED' : 'BLOCKED');
      assert.equal(result.error.message, result.error.code, '失败返回只能暴露稳定错误码');
      if (stage === 'scorecard') assert.deepEqual(result.runStatus.completedBatchIndices, []);
      const dir = targetDirFor(root, 'dry-run', validationRunId, 'v1.4d-eval-orchestrator-drill');
      assert.equal(readArtifactPair(dir).readerStatus, 'REJECTED');
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
  }
});

test('不连续checkpoint在状态机边界立即拒绝', () => {
  const status = initialRunStatus({ runIdentity: createResearchRunIdentity({ validationRunId: randomUUID(), evaluationVersion: 'eval',
    artifactMode: 'DRY_RUN', config: {
      gitObjectFormat: 'SHA1', sourceIdentity: 'MODULE_TEST', sourceVersion: 'v1.4d-test-config/1', sourceCommit: 'a'.repeat(40), datasetVersion: GO_INPUT.auditTrail.datasetVersion,
      featureEngineVersion: 'feature-1', algorithmVersion: 'algorithm-1', ruleVersion: 'rule-1', evaluationVersion: 'eval',
      weightVersion: 'weight-1', horizons: ['24h', '72h'], researchFrom: '2026-01-01T00:00:00.000Z',
      researchTo: '2026-01-08T00:00:00.000Z', fixedAsOf: '2026-01-08T00:00:00.000Z', thresholds: GO_INPUT.thresholds
    } }), totalBatches: 2 });
  assert.throws(() => withBatchCompleted(status, 1, { checkpoint: { batchIndex: 1, rowCount: 0, cursor: null, sha256: 'a'.repeat(64) } }),
    error => error.code === 'RUN_STATUS_CHECKPOINT_INCONSISTENT');
});
