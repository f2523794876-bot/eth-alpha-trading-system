import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { freezeFormalRunConfig, readGitIdentity, validateFormalRunConfig } from './formal-run-config.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sha1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();

test('batch-1 thresholds schema is semantically identical to the frozen R3 block', () => {
  const contract = readFileSync(new URL('../../../V1_4D_FORMAL_RESEARCH_EXECUTION_CONTRACT_V8_FINAL_R3.md', import.meta.url), 'utf8');
  const marker = '#### Thresholds Schema\n\n```json\n';
  const start = contract.indexOf(marker);
  assert.notEqual(start, -1);
  const jsonStart = start + marker.length;
  const jsonEnd = contract.indexOf('\n```', jsonStart);
  const frozenSchema = JSON.parse(contract.slice(jsonStart, jsonEnd));
  const implementedSchema = JSON.parse(readFileSync(new URL('../formal-research/schemas/v1-4d-thresholds.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(implementedSchema, frozenSchema);
});

function thresholds() {
  const byHorizon = (value24, value72 = value24) => ({ '24h': value24, '72h': value72 });
  return {
    schemaVersion: 'v1.4d-go-no-go-thresholds/1',
    minEffectiveTest: byHorizon(1),
    minClassEffectiveTest: byHorizon(0),
    minDirectionalCoverage: byHorizon(0.5),
    minMarketRegimeCoverage: byHorizon(0.5),
    minWilsonLowerBound: byHorizon(0.5),
    minPreCostLift: byHorizon(0),
    minPostCostLift: byHorizon(0),
    requireAllBaselines: true,
    requireMarketRegime: true
  };
}

function input(overrides = {}) {
  return {
    schemaVersion: 'v1.4d-formal-run-config/1',
    validationRunId: '123e4567-e89b-42d3-a456-426614174000',
    artifactMode: 'DRY_RUN',
    databaseIdentity: 'test',
    researchFrom: '2025-01-01T00:00:00.000Z',
    researchTo: '2025-07-01T00:00:00.000Z',
    fixedAsOf: '2025-07-04T00:00:00.000Z',
    symbols: ['ETHUSDT', 'BTCUSDT'],
    intervals: ['15m', '1h', '4h'],
    horizons: ['24h', '72h'],
    datasetVersion: `v1.4d-sha256-${'a'.repeat(64)}`,
    algorithmVersion: 'algorithm-1',
    ruleVersion: 'rule-1',
    weightVersion: 'weight-1',
    evaluationVersion: 'evaluation-1',
    costs: { feeBps: 5, slippageBps: 3 },
    thresholds: thresholds(),
    ...overrides
  };
}

test('T1 freezes a complete config against the real SHA-1 repository identity', () => {
  const result = freezeFormalRunConfig(input());
  assert.equal(result.config.gitObjectFormat, 'SHA1');
  assert.equal(result.config.sourceCommit, sha1);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.canonicalBytes, Buffer.from(result.canonicalJson, 'utf8'));
  assert.equal(Object.isFrozen(result.config), true);
  assert.equal(Object.isFrozen(result.config.thresholds), true);
  assert.equal(Object.isFrozen(result.config.thresholds.minEffectiveTest), true);
  assert.equal(Object.isFrozen(result.config.symbols), true);
  assert.equal(Object.isFrozen(result.config.intervals), true);
  assert.equal(Object.isFrozen(result.config.horizons), true);
});

test('public freeze entry always uses real Git identity and ignores an attempted injection argument', () => {
  const actual = readGitIdentity({ repositoryRoot });
  assert.deepEqual(actual, { gitObjectFormat: 'SHA1', sourceCommit: sha1 });
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(), actual.sourceCommit);
  const forged = 'b'.repeat(40);
  const result = freezeFormalRunConfig(input(), {
    repositoryRoot: '/not/the/repository',
    gitIdentity: { gitObjectFormat: 'SHA1', sourceCommit: forged }
  });
  assert.equal(result.config.sourceCommit, sha1);
  assert.notEqual(result.config.sourceCommit, forged);
  assert.throws(() => freezeFormalRunConfig(input({ sourceCommit: forged })), { code: 'VERSION_MISMATCH' });
  assert.equal(freezeFormalRunConfig(input({ sourceCommit: sha1 })).config.sourceCommit, sha1);
});

test('T1 canonical hash is stable across caller object insertion order', () => {
  const first = input();
  const reverseEntries = Object.entries(first).reverse();
  const second = Object.fromEntries(reverseEntries);
  assert.equal(freezeFormalRunConfig(first).sha256, freezeFormalRunConfig(second).sha256);
  assert.equal(freezeFormalRunConfig(first).canonicalJson, freezeFormalRunConfig(second).canonicalJson);
});

test('T1 cross-schema thresholds validation rejects missing fields and extra business values', () => {
  const missing = thresholds();
  delete missing.minPostCostLift;
  assert.throws(() => freezeFormalRunConfig(input({ thresholds: missing })), { code: 'RUN_CONFIG_INVALID' });

  const extra = { ...thresholds(), unapprovedThreshold: 1 };
  assert.throws(() => freezeFormalRunConfig(input({ thresholds: extra })), { code: 'RUN_CONFIG_INVALID' });
});

test('T1 rejects missing, inferred, or unknown configuration fields', () => {
  const missing = input();
  delete missing.costs;
  assert.throws(() => freezeFormalRunConfig(missing), { code: 'RUN_CONFIG_INVALID' });
  assert.throws(() => freezeFormalRunConfig(input({ inferredFee: 5 })), { code: 'RUN_CONFIG_INVALID' });
});

test('T1 validation diagnostics do not echo rejected secret-like values', () => {
  const secret = 'postgres://admin:do-not-log@example.invalid/production';
  let caught;
  try {
    freezeFormalRunConfig(input({ databaseUrl: secret }));
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.code, 'RUN_CONFIG_INVALID');
  assert.doesNotMatch(JSON.stringify({ message: caught.message, details: caught.details }), /do-not-log|admin/);
});

test('T1 rejects non-canonical UTC and invalid window order', () => {
  for (const researchFrom of [
    '2025-01-01T08:00:00.000+08:00',
    '2025-01-01t00:00:00.000z',
    '2025-01-01T00:00:00Z',
    '2025-01-01T00:00:00.00Z',
    '2025-01-01T00:00:00.0000Z'
  ]) assert.throws(() => freezeFormalRunConfig(input({ researchFrom })), { code: 'RUN_CONFIG_INVALID' });
  assert.throws(() => freezeFormalRunConfig(input({ researchFrom: '2025-07-01T00:00:00.000Z' })), { code: 'RUN_CONFIG_INVALID' });
  assert.throws(() => freezeFormalRunConfig(input({ fixedAsOf: '2025-06-30T23:59:59.999Z' })), { code: 'RUN_CONFIG_INVALID' });
});

test('T1 enforces sourceCommit algorithm, length, lowercase, and character contract', () => {
  const base = { ...input(), gitObjectFormat: 'SHA1', sourceCommit: sha1 };
  validateFormalRunConfig(base);
  for (const sourceCommit of ['a'.repeat(7), 'a'.repeat(39), 'a'.repeat(64), 'A'.repeat(40), ` ${'a'.repeat(40)}`, `${'a'.repeat(40)} `, `${'a'.repeat(39)}g`]) {
    assert.throws(() => validateFormalRunConfig({ ...base, sourceCommit }), { code: 'RUN_CONFIG_INVALID' });
  }
  validateFormalRunConfig({ ...base, gitObjectFormat: 'SHA256', sourceCommit: 'b'.repeat(64) });
  assert.throws(() => validateFormalRunConfig({ ...base, gitObjectFormat: 'SHA256', sourceCommit: sha1 }), { code: 'RUN_CONFIG_INVALID' });
});

test('T1 rejects invalid symbols, horizons, costs, and dataset versions', () => {
  for (const overrides of [
    { symbols: ['BTCUSDT', 'ETHUSDT'] },
    { horizons: ['72h', '24h'] },
    { costs: { feeBps: -1, slippageBps: 3 } },
    { datasetVersion: 'v1.4d-sha256-short' }
  ]) {
    assert.throws(() => freezeFormalRunConfig(input(overrides)), { code: 'RUN_CONFIG_INVALID' });
  }
});

test('Git identity probing outside a repository fails with a stable redacted business error', () => {
  const nonGitDirectory = mkdtempSync(join(tmpdir(), 'v14d-non-git-'));
  let error;
  try { readGitIdentity({ repositoryRoot: nonGitDirectory }); } catch (caught) { error = caught; }
  assert.equal(error.code, 'CONFIG_MISSING');
  assert.equal(error.message, 'Unable to read the repository Git identity');
  assert.deepEqual(Object.keys(error.details).sort(), ['causeCode', 'causeName']);
  assert.doesNotMatch(JSON.stringify(error.details), /rev-parse|environment|token|password/i);
});
