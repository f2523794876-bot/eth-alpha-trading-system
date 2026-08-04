import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { TREND, TREND_VALUES, canonicalTrendOrNull, isCanonicalTrend } from '../../src/domain/trend.js';

test('Canonical Trend Enum is exactly UP/DOWN/RANGE and rejects legacy lowercase values', () => {
  assert.deepEqual(TREND_VALUES, ['UP', 'DOWN', 'RANGE']);
  assert.deepEqual(TREND, { UP: 'UP', DOWN: 'DOWN', RANGE: 'RANGE' });
  for (const value of TREND_VALUES) {
    assert.equal(isCanonicalTrend(value), true);
    assert.equal(canonicalTrendOrNull(value), value);
  }
  for (const value of ['up', 'down', 'flat', 'UNKNOWN', null, undefined]) {
    assert.equal(isCanonicalTrend(value), false);
    assert.equal(canonicalTrendOrNull(value), null);
  }
});

test('trend producer and all frozen consumers import the shared Canonical Trend contract', async () => {
  const files = [
    '../../src/features/feature-engine.js',
    '../../src/forecast/po-state-engine.js',
    '../../src/forecast/po-feature-mapping.js',
    '../../src/validation-replay/po-diagnostic.js',
    '../../scripts/v1-4d-scorecard-cli.mjs'
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /domain\/trend\.js/, `${file} must use the shared trend contract`);
    assert.doesNotMatch(source, /['"](?:up|down|flat)['"]/, `${file} must not hand-write legacy trend values`);
  }
});

test('PostgreSQL V1.4D fixtures do not reintroduce legacy lowercase trend fields', async () => {
  const root = new URL('../postgres/', import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.integration.test.js'));
  const legacyTrendField = /(?:trend15m|trend1h|trend4h|btcTrendState)\s*:\s*['"](?:up|down|flat)['"]/;
  for (const file of files) {
    const source = await readFile(new URL(file, root), 'utf8');
    assert.doesNotMatch(source, legacyTrendField, `${file} contains a non-Canonical trend fixture`);
  }
});
