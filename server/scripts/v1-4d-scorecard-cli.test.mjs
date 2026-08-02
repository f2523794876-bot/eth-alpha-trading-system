import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeReplayWindow, parseReplayDays } from './v1-4d-verification-arguments.mjs';
import {
  classifyReplayFailure, deriveVerificationStatus, exitCodeForStatus,
  extractChildErrorCode, redactSensitiveText
} from './v1-4d-verification-contract.mjs';

const script = new URL('./v1-4d-scorecard-cli.mjs', import.meta.url);
const cleanEnv = () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.V14D_REPLAY_DATABASE_URL;
  return env;
};

test('verification arguments accept individual and combined 7/90-day replay plans', () => {
  assert.deepEqual(parseReplayDays('7'), [7]);
  assert.deepEqual(parseReplayDays('90'), [90]);
  assert.deepEqual(parseReplayDays('7,90'), [7, 90]);
  assert.deepEqual(parseReplayDays('both'), [7, 90]);
  assert.throws(() => parseReplayDays('30'), error => error.code === 'INVALID_REPLAY_DAYS');
});

test('replay windows end at the explicit cutoff and span exactly 7 or 90 days', () => {
  const replayTo = '2026-07-01T00:00:00.000Z';
  for (const days of [7, 90]) {
    const window = computeReplayWindow({ days, replayTo });
    assert.equal(window.toMs - window.fromMs, days * 86400000);
    assert.equal(window.toMs, Date.parse(replayTo));
  }
  assert.throws(() => computeReplayWindow({ days: 7, replayTo: 'invalid' }), error => error.code === 'INVALID_REPLAY_TO');
});

function fixtureRows() {
  return [
    { horizon: '24h', split: 'TRAIN', actualDirection: 'UP', predictedDirection: 'UP', trend4hDirection: 'UP', actualReturn: 0.01, mfe: 0.02, mae: 0.01 },
    { horizon: '24h', split: 'TEST', actualDirection: 'DOWN', predictedDirection: 'DOWN', trend4hDirection: 'DOWN', actualReturn: -0.02, mfe: 0.03, mae: 0.01 },
    { horizon: '72h', split: 'TRAIN', actualDirection: 'RANGE', predictedDirection: 'RANGE', trend4hDirection: 'RANGE', actualReturn: 0.001 },
    { horizon: '72h', split: 'TEST', actualDirection: 'UP', predictedDirection: 'UP', trend4hDirection: 'UP', actualReturn: 0.03, mfe: 0.04, mae: 0.01 }
  ].map((row, index) => ({
    ...row,
    predictionId: `fixture-${index}`,
    targetStartTime: index * 1000,
    targetEndTime: index * 1000 + 500,
    directionEligibleForStatistics: true,
    pathEligibleForStatistics: row.mfe != null || row.mae != null
  }));
}

test('scorecard CLI writes evaluable JSON and Markdown without a database', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'v1-4d-scorecard-'));
  const input = path.join(dir, 'input.json');
  const json = path.join(dir, 'scorecard.json');
  const markdown = path.join(dir, 'scorecard.md');
  await writeFile(input, JSON.stringify(fixtureRows()));
  const result = spawnSync(process.execPath, [
    script.pathname, `--input=${input}`, `--output=${json}`, `--markdown-output=${markdown}`,
    '--fee-bps=8', '--slippage-bps=4', '--seed=17'
  ], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(await readFile(json, 'utf8'));
  assert.equal(parsed.status, 'EVALUATED');
  assert.equal(parsed.horizons['24h'].status, 'EVALUATED');
  assert.equal(parsed.horizons['72h'].status, 'EVALUATED');
  assert.equal(parsed.horizons['24h'].rawSampleCount, 2);
  assert.equal(parsed.horizons['24h'].effectiveSampleCount, 2);
  assert.match(await readFile(markdown, 'utf8'), /Leakage-safe baselines/);
});

test('scorecard CLI writes NOT_EVALUABLE reports and exits non-zero for empty history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'v1-4d-scorecard-empty-'));
  const input = path.join(dir, 'input.json');
  const json = path.join(dir, 'scorecard.json');
  const markdown = path.join(dir, 'scorecard.md');
  await writeFile(input, '[]');
  const result = spawnSync(process.execPath, [
    script.pathname, `--input=${input}`, `--output=${json}`, `--markdown-output=${markdown}`
  ], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(await readFile(json, 'utf8')).status, 'NOT_EVALUABLE');
  assert.match(await readFile(markdown, 'utf8'), /NOT_EVALUABLE/);
});

test('scorecard CLI ignores generic DATABASE_URL and requires explicit V14D_REPLAY_DATABASE_URL', () => {
  const env = cleanEnv();
  env.DATABASE_URL = 'postgresql://production.example.invalid/never-connect';
  const result = spawnSync(process.execPath, [
    script.pathname, '--validation-run-id=00000000-0000-0000-0000-000000000000', '--evaluation-version=test'
  ], { encoding: 'utf8', env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /V14D_REPLAY_DATABASE_URL is required/);
  assert.match(result.stderr, /generic DATABASE_URL is intentionally ignored/);
});

test('verification exit-code matrix is strict for PASS/NOT_EVALUABLE/BLOCKED/FAIL', () => {
  assert.equal(exitCodeForStatus('PASS'), 0);
  assert.notEqual(exitCodeForStatus('NOT_EVALUABLE'), 0);
  assert.notEqual(exitCodeForStatus('BLOCKED'), 0);
  assert.notEqual(exitCodeForStatus('FAIL'), 0);
  assert.equal(deriveVerificationStatus({ mode: 'FULL', gates: [{ required: true, status: 'NOT_EVALUABLE' }] }), 'NOT_EVALUABLE');
  assert.equal(deriveVerificationStatus({ mode: 'OFFLINE_LIGHTWEIGHT', gates: [{ required: true, status: 'PASS' }], replays: { 7: { status: 'OUT_OF_SCOPE' } } }), 'PASS');
  const contractUrl = new URL('./v1-4d-verification-contract.mjs', import.meta.url).href;
  for (const [status, expected] of [['PASS', 0], ['NOT_EVALUABLE', 2], ['BLOCKED', 3], ['FAIL', 1]]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `import { exitCodeForStatus } from ${JSON.stringify(contractUrl)}; process.exitCode=exitCodeForStatus(${JSON.stringify(status)});`]);
    assert.equal(child.status, expected, `${status} subprocess exit code`);
  }
});

test('FULL completion treats six PASS gates plus 7/90 EVALUATED as PASS and exits zero', () => {
  const gates = Array.from({ length: 6 }, (_, index) => ({ label: `gate-${index}`, required: true, status: 'PASS' }));
  const replays = { 7: { status: 'EVALUATED' }, 90: { status: 'EVALUATED' } };
  assert.equal(deriveVerificationStatus({ mode: 'FULL', gates, replays }), 'PASS');
  const contractUrl = new URL('./v1-4d-verification-contract.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { deriveVerificationStatus, exitCodeForStatus } from ${JSON.stringify(contractUrl)};
    const status = deriveVerificationStatus(${JSON.stringify({ mode: 'FULL', gates, replays })});
    process.exitCode = exitCodeForStatus(status);
  `]);
  assert.equal(child.status, 0, child.stderr?.toString());
});

test('FULL mixed replay statuses remain non-zero with FAIL/BLOCKED/NOT_EVALUABLE precedence', () => {
  const gates = Array.from({ length: 6 }, () => ({ required: true, status: 'PASS' }));
  for (const [replayStatus, expectedStatus, expectedExit] of [
    ['FAIL', 'FAIL', 1],
    ['BLOCKED', 'BLOCKED', 3],
    ['NOT_EVALUABLE', 'NOT_EVALUABLE', 2]
  ]) {
    const status = deriveVerificationStatus({ mode: 'FULL', gates, replays: { 7: { status: 'EVALUATED' }, 90: { status: replayStatus } } });
    assert.equal(status, expectedStatus);
    assert.equal(exitCodeForStatus(status), expectedExit);
  }
});

test('replay failures preserve DATASET_MANIFEST_NOT_FOUND as DATA_NOT_READY', () => {
  const stderr = "validation:walk-forward failed { code: 'DATASET_MANIFEST_NOT_FOUND' }";
  const code = extractChildErrorCode('', stderr);
  assert.equal(code, 'DATASET_MANIFEST_NOT_FOUND');
  assert.deepEqual(classifyReplayFailure({ code, stderr }), { classification: 'DATA_NOT_READY', status: 'BLOCKED' });
});

test('configuration, database connection and unknown child failures remain distinguishable', () => {
  assert.deepEqual(classifyReplayFailure({ code: 'REPLAY_CONFIG_MISSING' }), { classification: 'CONFIG_MISSING', status: 'BLOCKED' });
  assert.deepEqual(classifyReplayFailure({ code: 'ECONNREFUSED', stderr: 'connect ECONNREFUSED 127.0.0.1:5432' }), {
    classification: 'EXECUTION_FAILURE', failureType: 'DATABASE_CONNECTION_FAILURE', status: 'FAIL'
  });
  assert.deepEqual(classifyReplayFailure({ code: null, stderr: 'unexpected crash' }), {
    classification: 'EXECUTION_FAILURE', failureType: 'CHILD_PROCESS_FAILURE', status: 'FAIL'
  });
});

test('PostgreSQL connection/auth SQLSTATE matrix is classified without swallowing unknown crashes', () => {
  for (const code of ['3D000', '08006', '08001', '28000', '28P01', 'ECONNREFUSED', 'ENOTFOUND']) {
    assert.deepEqual(classifyReplayFailure({ code }), {
      classification: 'EXECUTION_FAILURE', failureType: 'DATABASE_CONNECTION_FAILURE', status: 'FAIL'
    }, code);
  }
  assert.equal(extractChildErrorCode('', "database failed { code: '3D000' }"), '3D000');
  assert.deepEqual(classifyReplayFailure({ code: 'XX999', stderr: 'unknown child crash' }), {
    classification: 'EXECUTION_FAILURE', failureType: 'CHILD_PROCESS_FAILURE', status: 'FAIL'
  });
});

test('replay stderr summaries redact database URLs, usernames, passwords and tokens', () => {
  const redacted = redactSensitiveText('postgresql://user:secret@example/db username=alice password=hunter2 token=abc123 TEST_DATABASE_URL=postgres://u:p@host/db');
  assert.doesNotMatch(redacted, /secret|alice|hunter2|abc123|u:p@host/);
  assert.match(redacted, /\[REDACTED\]/);
});
