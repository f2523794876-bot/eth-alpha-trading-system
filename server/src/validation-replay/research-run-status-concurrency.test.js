import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireResearchRunStatusLock, createResearchRunIdentity, initialRunStatus, readRunStatus,
  releaseResearchRunStatusLock, writeRunStatus, withBatchCompleted, withFailed
} from './research-run-status.js';
import { processStartIdentity } from './artifact-fs-primitives.js';

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

test('崩溃持有者与stale lock均可恢复，且不产生损坏JSON', () => {
  const rootPath = root();
  try {
    const runIdentity = identity();
    const status = initialRunStatus({ runIdentity, totalBatches: 1 });
    const dir = path.join(rootPath, 'run-status', 'dry-run', runIdentity.validationRunId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = path.join(dir, `.${runIdentity.runIdentitySha256}.status.lock`);
    mkdirSync(lock, { mode: 0o700 });
    const ownerToken = randomBytes(32).toString('hex');
    writeFileSync(path.join(lock, `owner.${ownerToken}.json`), JSON.stringify({
      ownerToken, pid: 99999999, processStartIdentity: processStartIdentity(99999999), createdAt: new Date(0).toISOString()
    }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    writeRunStatus(rootPath, status, { lockTimeoutMs: 1_000, staleLockMs: 10 });
    writeFileSync(path.join(dir, '.interrupted.tmp'), '{partial');
    assert.equal(readRunStatus(rootPath, runIdentity).runState, 'RUNNING');
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
