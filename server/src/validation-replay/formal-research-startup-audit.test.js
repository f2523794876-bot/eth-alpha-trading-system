import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createGuardedResearchPgPool } from '../db/research-database-guard.js';
import { runFormalResearchFromDatabase } from './formal-research-orchestrator.js';
import { findMostRecentRejectedResearchAttempt, findMostRecentRunStatus } from './research-run-status.js';
import { readD8DisplayStatus } from './d8-status-reader.js';

function thresholds() {
  const both = value => ({ '24h': value, '72h': value });
  return { schemaVersion: 'v1.4d-go-no-go-thresholds/1', minEffectiveTest: both(1), minClassEffectiveTest: both(0),
    minDirectionalCoverage: both(0), minMarketRegimeCoverage: both(0), minWilsonLowerBound: both(0),
    minPreCostLift: both(-1), minPostCostLift: both(-1), requireAllBaselines: true, requireMarketRegime: true };
}
function config(validationRunId, artifactRoot) {
  return { schemaVersion: 'v1.4d-formal-run-config/1', validationRunId, artifactMode: 'DRY_RUN', artifactRoot,
    lockTimeoutMs: 1000, staleLockRecovery: 'ENABLED', maxArtifactBytes: 10_000_000, databaseIdentity: 'test',
    researchFrom: '2025-01-01T00:00:00.000Z', researchTo: '2025-07-01T00:00:00.000Z', fixedAsOf: '2025-07-04T00:00:00.000Z',
    symbols: ['ETHUSDT', 'BTCUSDT'], intervals: ['15m', '1h', '4h'], horizons: ['24h', '72h'],
    datasetVersion: `v1.4d-sha256-${'a'.repeat(64)}`, featureEngineVersion: 'v1.4b-feature-engine-1',
    algorithmVersion: 'v1.4c-server-po-rule-1', ruleVersion: 'rule-1',
    weightVersion: 'weight-1', evaluationVersion: 'evaluation-1', costs: { feeBps: 5, slippageBps: 3 }, thresholds: thresholds() };
}
async function guardedFailingPool(message = 'postgresql://user:password@production.invalid/db') {
  let calls = 0;
  return createGuardedResearchPgPool({ databaseUrl: 'postgresql://localhost/eth_alpha_v14d_authenticity_ci' }, {
    env: { NODE_ENV: 'test', ALLOW_POSTGRES_INTEGRATION_TESTS: '1', V14D_DATABASE_IDENTITY: 'test' },
    createPgPool: async () => ({ end: async () => {}, query: async () => {
      calls += 1;
      if (calls === 1) return { rows: [{ database: 'eth_alpha_v14d_authenticity_ci' }] };
      throw new Error(message);
    } })
  });
}

async function guardedMissingRunPool() {
  let calls = 0;
  return createGuardedResearchPgPool({ databaseUrl: 'postgresql://localhost/eth_alpha_v14d_authenticity_ci' }, {
    env: { NODE_ENV: 'test', ALLOW_POSTGRES_INTEGRATION_TESTS: '1', V14D_DATABASE_IDENTITY: 'test' },
    createPgPool: async () => ({ end: async () => {}, query: async () => {
      calls += 1;
      return calls === 1 ? { rows: [{ database: 'eth_alpha_v14d_authenticity_ci' }] } : { rowCount: 0, rows: [] };
    } })
  });
}

test('repository首查询失败会从RUNNING原子转为可读取FAILED，错误分类脱敏且结果一致', async () => {
  const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-artifact-'));
  const statusRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-status-'));
  try {
    const validationRunId = randomUUID();
    const result = await runFormalResearchFromDatabase({ pool: await guardedFailingPool(), statusRoot,
      formalRunConfig: config(validationRunId, artifactRoot) });
    assert.equal(result.error.code, 'FORMAL_RESEARCH_DATABASE_QUERY_FAILED');
    assert.equal(result.runStatus.runState, 'FAILED');
    const persisted = findMostRecentRunStatus(statusRoot, 'DRY_RUN');
    assert.equal(persisted.runState, 'FAILED');
    assert.equal(persisted.blockedReasonCode, result.error.code);
    assert.doesNotMatch(JSON.stringify(persisted), /password|production\.invalid/);
  } finally { rmSync(artifactRoot, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('guard capability缺失同样留下FAILED而不是NOT_RUN/null', async () => {
  const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-artifact-'));
  const statusRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-status-'));
  try {
    const result = await runFormalResearchFromDatabase({ pool: { query: async () => {} }, statusRoot,
      formalRunConfig: config(randomUUID(), artifactRoot) });
    assert.equal(result.error.code, 'DATABASE_POOL_NOT_GUARDED');
    assert.equal(result.runStatus.runState, 'FAILED');
    assert.equal(findMostRecentRunStatus(statusRoot, 'DRY_RUN').blockedReasonCode, 'DATABASE_POOL_NOT_GUARDED');
  } finally { rmSync(artifactRoot, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('validationRunId不存在使用受限启动失败审计，不伪造有效validation run', async () => {
  const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-artifact-'));
  const statusRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-status-'));
  try {
    const result = await runFormalResearchFromDatabase({ pool: await guardedMissingRunPool(), statusRoot,
      formalRunConfig: config(randomUUID(), artifactRoot) });
    assert.equal(result.error.code, 'FORMAL_RESEARCH_VALIDATION_RUN_NOT_FOUND');
    assert.equal(result.runStatus.runState, 'FAILED');
    assert.equal(findMostRecentRunStatus(statusRoot, 'DRY_RUN').blockedReasonCode, result.error.code);
  } finally { rmSync(artifactRoot, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('启动状态持久化失败使用稳定分类，且不会进入repository查询', async () => {
  const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-artifact-'));
  const statusRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-status-'));
  const target = mkdtempSync(path.join(os.tmpdir(), 'startup-status-target-'));
  let queried = false;
  try {
    symlinkSync(target, path.join(statusRoot, 'run-status'));
    await assert.rejects(runFormalResearchFromDatabase({ pool: { query: async () => { queried = true; } }, statusRoot,
      formalRunConfig: config(randomUUID(), artifactRoot) }), error => error.code === 'ORCHESTRATOR_STATUS_PERSIST_FAILED');
    assert.equal(queried, false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('batchSize=0在首次数据库操作前留下可读取FAILED审计', async () => {
  const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-artifact-'));
  const statusRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-status-'));
  let queries = 0;
  try {
    const result = await runFormalResearchFromDatabase({ pool: { query: async () => { queries += 1; } }, batchSize: 0,
      statusRoot, formalRunConfig: config(randomUUID(), artifactRoot) });
    assert.equal(queries, 0);
    assert.equal(result.runStatus.runState, 'FAILED');
    assert.equal(result.error.code, 'ORCHESTRATOR_INVALID_INPUT');
    assert.equal(findMostRecentRunStatus(statusRoot, 'DRY_RUN').blockedReasonCode, 'ORCHESTRATOR_INVALID_INPUT');
  } finally { rmSync(artifactRoot, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('runtime配置冲突在首次数据库操作前留下可读取FAILED审计', async () => {
  const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-artifact-'));
  const statusRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-status-'));
  let queries = 0;
  try {
    const formalRunConfig = config(randomUUID(), artifactRoot);
    const result = await runFormalResearchFromDatabase({ pool: { query: async () => { queries += 1; } },
      evaluationVersion: 'conflicting-version', statusRoot, formalRunConfig });
    assert.equal(queries, 0);
    assert.equal(result.runStatus.runState, 'FAILED');
    assert.equal(result.error.code, 'ORCHESTRATOR_RUN_CONFIG_MISMATCH');
    assert.equal(findMostRecentRunStatus(statusRoot, 'DRY_RUN').blockedReasonCode, 'ORCHESTRATOR_RUN_CONFIG_MISMATCH');
  } finally { rmSync(artifactRoot, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('无法安全形成完整身份的非法config进入隔离rejected-attempt审计，不伪造正式身份', async () => {
  const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-artifact-'));
  const statusRoot = mkdtempSync(path.join(os.tmpdir(), 'startup-status-'));
  let queries = 0;
  try {
    const result = await runFormalResearchFromDatabase({ pool: { query: async () => { queries += 1; } }, statusRoot, formalRunConfig: {} });
    assert.equal(queries, 0);
    assert.equal(result.runStatus.runState, 'FAILED');
    assert.equal(result.runStatus.identityConstructed, false);
    assert.equal('runIdentitySha256' in result.runStatus, false);
    const audit = findMostRecentRejectedResearchAttempt(statusRoot);
    assert.equal(audit.reasonCode, 'RUN_CONFIG_INVALID');
    assert.equal(readD8DisplayStatus({ artifactRoot, statusRoot }).readerReasonCode, 'RUN_CONFIG_INVALID');
  } finally { rmSync(artifactRoot, { recursive: true, force: true }); rmSync(statusRoot, { recursive: true, force: true }); }
});

test('契约边界：正式database orchestrator保持模块调用，不新增HTTP/CLI或package启动入口', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.values(packageJson.scripts).some(command => /formal-research-orchestrator|runFormalResearchFromDatabase/.test(command)), false);
  const srcRoot = path.resolve(new URL('../', import.meta.url).pathname);
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(target);
    }
  };
  walk(srcRoot);
  const callers = files.filter(file => /runFormalResearchFromDatabase/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(callers, [path.join(srcRoot, 'validation-replay', 'formal-research-orchestrator.js')]);
  for (const file of files.filter(file => /(?:cli|server|service|bootstrap|entry|index)/i.test(path.basename(file)))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /runFormalResearchFromDatabase|formal-research-orchestrator/,
      `正式入口边界泄漏: ${path.relative(srcRoot, file)}`);
  }
});
