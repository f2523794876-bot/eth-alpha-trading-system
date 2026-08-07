import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createResearchRunIdentity, initialRunStatus, readRunStatus, writeRunStatus, withBatchCompleted, withFailed
} from './research-run-status.js';

const childPath = fileURLToPath(new URL('./fixtures/run-status-writer-child.mjs', import.meta.url));
function root() { return mkdtempSync(path.join(os.tmpdir(), 'run-status-cas-')); }
function identity(validationRunId = randomUUID(), evaluationVersion = 'eval-1') {
  return createResearchRunIdentity({ validationRunId, evaluationVersion, artifactMode: 'DRY_RUN', config: {
    sourceCommit: '1'.repeat(40), datasetVersion: `v1.4d-sha256-${'2'.repeat(64)}`,
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
    writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 99999999, createdAt: new Date(0).toISOString() }));
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
