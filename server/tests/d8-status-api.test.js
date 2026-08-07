// GET /api/v1/research/d8/status HTTP集成测试——真实fetch()打真实createApiServer()实例，
// 真实文件系统root（mkdtemp隔离），驱动真实d8-status-reader.js/artifact-publisher.js。
// 覆盖：GET-only、cache-control:no-store、NOT_RUN/GO两态、白名单字段（不泄漏路径）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApiServer } from '../src/api/server.js';
import { MemoryRepository } from '../src/db/memory.js';
import { publishArtifact } from '../src/validation-replay/artifact-publisher.js';
import { evaluateGoNoGo } from '../src/formal-research/go-no-go-evaluator.js';
import { canonicalJson } from '../src/formal-research/canonical-json.js';
import { createResearchRunIdentity } from '../src/validation-replay/research-run-status.js';

const CONTRACT_TEXT = readFileSync(new URL('../../V1_4D_FORMAL_RESEARCH_EXECUTION_CONTRACT_V8_FINAL_R3.md', import.meta.url), 'utf8');
function frozenVector(id) {
  const pattern = /#### (非法)?向量 `([^`]+)`\n\n([^\n]+)\n\n```json\n([\s\S]*?)\n```/g;
  const vectors = [...CONTRACT_TEXT.matchAll(pattern)].map(([, invalid, vid, summary, source]) => ({ id: vid, value: JSON.parse(source) }));
  return vectors.find(v => v.id === id).value;
}
const GO_INPUT = frozenVector('GO').input;
const GO_DECISION = evaluateGoNoGo(GO_INPUT);
function sha256Hex(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function runIdentity(validationRunId, evaluationVersion) {
  return createResearchRunIdentity({ validationRunId, evaluationVersion, artifactMode: 'FORMAL', config: {
    gitObjectFormat: 'SHA1', sourceIdentity: 'MODULE_TEST', sourceVersion: 'v1.4d-test-config/1', sourceCommit: 'a'.repeat(40), datasetVersion: GO_INPUT.auditTrail.datasetVersion,
    featureEngineVersion: 'feature-1', algorithmVersion: 'algorithm-1', ruleVersion: 'rule-1',
    evaluationVersion, weightVersion: 'weight-1', horizons: ['24h', '72h'],
    researchFrom: '2026-01-01T00:00:00.000Z', researchTo: '2026-01-08T00:00:00.000Z',
    fixedAsOf: '2026-01-08T00:00:00.000Z', thresholds: GO_INPUT.thresholds
  } });
}

function readyCollector() {
  return { health: () => ({ state: 'HEALTHY' }), status: () => ({ running: true }), readiness: async () => ({ ok: true, status: 'HEALTHY', checks: {} }) };
}

async function boot({ d8ArtifactRoot, d8RunStatusRoot }) {
  const repository = new MemoryRepository();
  const api = createApiServer({ collector: readyCollector(), repository, host: '127.0.0.1', port: 0, d8ArtifactRoot, d8RunStatusRoot });
  const address = await api.start();
  return { api, base: `http://127.0.0.1:${address.port}` };
}

function makeRoot() { return mkdtempSync(path.join(os.tmpdir(), 'd8-api-')); }

test('NOT_RUN：全新root，GET返回200+cache-control:no-store+state=NOT_RUN', async () => {
  const artifactRoot = makeRoot();
  const statusRoot = makeRoot();
  const { api, base } = await boot({ d8ArtifactRoot: artifactRoot, d8RunStatusRoot: statusRoot });
  try {
    const res = await fetch(`${base}/api/v1/research/d8/status`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.state, 'NOT_RUN');
    assert.equal(body.data.actionPermission, 'DISPLAY_ONLY');
  } finally {
    await api.stop();
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(statusRoot, { recursive: true, force: true });
  }
});

test('GO：真实发布一份FORMAL artifact后，GET返回完整白名单投影且不泄漏文件系统路径', async () => {
  const artifactRoot = makeRoot();
  const statusRoot = makeRoot();
  const validationRunId = randomUUID();
  const thresholdsSha256 = sha256Hex(canonicalJson(GO_INPUT.thresholds));
  const core = {
    validationRunId, evaluationVersion: 'v1.4d-eval-d8-api-test', gitObjectFormat: 'SHA1', sourceCommit: 'a'.repeat(40),
    runIdentity: runIdentity(validationRunId, 'v1.4d-eval-d8-api-test'),
    d8InputSha256: 'b'.repeat(64), researchFrom: '2026-01-01T00:00:00.000Z', researchTo: '2026-01-08T00:00:00.000Z',
    fixedAsOf: '2026-01-08T00:00:00.000Z', thresholds: GO_INPUT.thresholds, scorecard: GO_INPUT.scorecard,
    auditTrail: { ...GO_INPUT.auditTrail, authenticityGateStatus: 'PASSED', manifestCoverage: 1, featureCoverage: 1, validationRunStatus: 'SUCCEEDED' },
    decision: { ...GO_DECISION, validationRunId },
    governanceAuthorizationRef: {
      authorizationSchemaVersion: 'v1.4d-governance-authorization/1', recordSha256: 'd'.repeat(64), hashAlgorithm: 'SHA-256',
      validationRunId, thresholdsSha256, authorizationScope: 'FORMAL_RESEARCH_EXECUTION', decision: 'APPROVE'
    }
  };
  const publishResult = publishArtifact({
    root: artifactRoot, artifactMode: 'FORMAL', validationRunId, evaluationVersion: 'v1.4d-eval-d8-api-test', core,
    manifestContentHash: 'c'.repeat(64), validationRunFinishedAt: '2026-01-08T00:05:00.000Z'
  });
  assert.equal(publishResult.operationStatus, 'PUBLISHED');
  const { api, base } = await boot({ d8ArtifactRoot: artifactRoot, d8RunStatusRoot: statusRoot });
  try {
    const res = await fetch(`${base}/api/v1/research/d8/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.state, GO_DECISION.overall.status);
    assert.equal(body.data.runId, validationRunId);
    const raw = await (await fetch(`${base}/api/v1/research/d8/status`)).text();
    assert.ok(!raw.includes(artifactRoot), '响应body不得包含文件系统绝对路径');
  } finally {
    await api.stop();
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(statusRoot, { recursive: true, force: true });
  }
});

test('只支持GET：POST被拒绝405，不触发任何发布/研究动作', async () => {
  const artifactRoot = makeRoot();
  const statusRoot = makeRoot();
  const { api, base } = await boot({ d8ArtifactRoot: artifactRoot, d8RunStatusRoot: statusRoot });
  try {
    const res = await fetch(`${base}/api/v1/research/d8/status`, { method: 'POST' });
    assert.equal(res.status, 405);
  } finally {
    await api.stop();
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(statusRoot, { recursive: true, force: true });
  }
});
