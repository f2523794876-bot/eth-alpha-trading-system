import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeReplayWindow, parseReplayDays } from './v1-4d-verification-arguments.mjs';

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
  ];
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
