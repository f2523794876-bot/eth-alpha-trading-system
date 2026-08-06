import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import {
  D8_INPUT_SCHEMA_ID,
  D8_OUTPUT_SCHEMA_ID,
  evaluateGoNoGo,
  roundHalfEven12
} from './go-no-go-evaluator.js';

const CONTRACT_URL = new URL('../../../V1_4D_FORMAL_RESEARCH_EXECUTION_CONTRACT_V8_FINAL_R3.md', import.meta.url);
const INPUT_SCHEMA_URL = new URL('./schemas/v1-4d-go-no-go-input.schema.json', import.meta.url);
const OUTPUT_SCHEMA_URL = new URL('./schemas/v1-4d-go-no-go-output.schema.json', import.meta.url);
const CONTRACT_TEXT = readFileSync(CONTRACT_URL, 'utf8');

function jsonBlocks() {
  return [...CONTRACT_TEXT.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => {
    try {
      return JSON.parse(match[1]);
    } catch (error) {
      throw new Error(`Frozen contract contains an invalid JSON block: ${error.message}`);
    }
  });
}

function contractSchema(schemaId) {
  const matches = jsonBlocks().filter(value => !Array.isArray(value) && value?.$id === schemaId);
  assert.equal(matches.length, 1, `expected exactly one frozen Schema block for ${schemaId}`);
  return matches[0];
}

function contractVectors() {
  const pattern = /#### (非法)?向量 `([^`]+)`\n\n([^\n]+)\n\n```json\n([\s\S]*?)\n```/g;
  const vectors = [...CONTRACT_TEXT.matchAll(pattern)].map(([, invalid, id, summary, source]) => ({
    id,
    invalid: invalid === '非法',
    summary,
    value: JSON.parse(source)
  }));
  const ids = new Set(vectors.map(vector => vector.id));
  assert.equal(ids.size, vectors.length, 'frozen D8 vector ids must be unique');
  assert.equal(vectors.filter(vector => !vector.invalid).length, 20, 'frozen contract must contain 20 legal D8 vectors');
  assert.equal(vectors.filter(vector => vector.invalid).length, 3, 'frozen contract must contain 3 illegal D8 vectors');
  return vectors;
}

const VECTORS = contractVectors();
const LEGAL_VECTORS = VECTORS.filter(vector => !vector.invalid);
const ILLEGAL_VECTORS = VECTORS.filter(vector => vector.invalid);
const GO_INPUT = structuredClone(LEGAL_VECTORS.find(vector => vector.id === 'GO').value.input);

function reverseObjectKeyOrder(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseObjectKeyOrder(value[key])]));
}

function assertSchemaRejected(input) {
  assert.throws(
    () => evaluateGoNoGo(input),
    error => error?.code === 'SCHEMA_VALIDATION_FAILED'
  );
}

test('D8 input and output Schema files are canonical-semantic copies of the frozen R3 blocks', () => {
  const inputFile = JSON.parse(readFileSync(INPUT_SCHEMA_URL, 'utf8'));
  const outputFile = JSON.parse(readFileSync(OUTPUT_SCHEMA_URL, 'utf8'));
  assert.equal(canonicalJson(inputFile), canonicalJson(contractSchema(D8_INPUT_SCHEMA_ID)));
  assert.equal(canonicalJson(outputFile), canonicalJson(contractSchema(D8_OUTPUT_SCHEMA_ID)));
});

for (const vector of LEGAL_VECTORS) {
  test(`frozen legal D8 vector ${vector.id} matches the complete expected output`, () => {
    assert.match(vector.summary, /输入Schema：`PASS`/);
    assert.deepEqual(evaluateGoNoGo(vector.value.input), vector.value.output);
  });
}

for (const vector of ILLEGAL_VECTORS) {
  test(`frozen illegal D8 vector ${vector.id} is rejected before output`, () => {
    assert.match(vector.summary, /输入Schema：`REJECT`/);
    assertSchemaRejected(vector.value);
  });
}

test('strict input Schema rejects missing, unknown, wrong-type and illegal-enum data', () => {
  const missing = structuredClone(GO_INPUT);
  delete missing.auditTrail;
  assertSchemaRejected(missing);

  const unknown = structuredClone(GO_INPUT);
  unknown.secretExtra = true;
  assertSchemaRejected(unknown);

  const wrongType = structuredClone(GO_INPUT);
  wrongType.sampleAccounting['24h'].effectiveTest = '45';
  assertSchemaRejected(wrongType);

  const illegalEnum = structuredClone(GO_INPUT);
  illegalEnum.auditTrail.validationRunStatus = 'COMPLETE';
  assertSchemaRejected(illegalEnum);

  const unknownGroup = structuredClone(GO_INPUT);
  unknownGroup.marketRegimeAtGeneration['24h'].UNKNOWN = { sampleCount: 0, directionCorrectCount: 0 };
  assertSchemaRejected(unknownGroup);
});

test('conditional baseline branches retain strict sample-count and null contracts', () => {
  const availableZero = structuredClone(GO_INPUT);
  availableZero.scorecard.horizons['24h'].baselines.alwaysRange.sampleCount = 0;
  availableZero.baselineAvailabilityInput['24h'].alwaysRange.sampleCount = 0;
  assertSchemaRejected(availableZero);

  const unavailableNumber = structuredClone(GO_INPUT);
  for (const location of [
    unavailableNumber.scorecard.horizons['24h'].baselines.follow4hTrend,
    unavailableNumber.baselineAvailabilityInput['24h'].follow4hTrend
  ]) {
    location.status = 'NOT_EVALUABLE';
    location.reasonCode = 'NO_VALID_TREND';
    location.sampleCount = 0;
    location.macroF1 = 0;
    location.preCostExpectedReturn = null;
    location.postCostExpectedReturn = null;
  }
  assertSchemaRejected(unavailableNumber);
});

test('half-even output rounding handles exact binary ties in both parity directions', () => {
  assert.equal(roundHalfEven12(1 / 8192), 0.000122070312);
  assert.equal(roundHalfEven12(3 / 8192), 0.000366210938);
  assert.equal(roundHalfEven12(-1 / 8192), -0.000122070312);
});

test('Wilson threshold gates use the unrounded binary64 lower bound', () => {
  const input = structuredClone(GO_INPUT);
  const successes = input.scorecard.horizons['24h'].model.directionCorrectCount;
  const trials = input.sampleAccounting['24h'].effectiveTest;
  const z = 1.959963984540054;
  const z2 = z * z;
  const p = successes / trials;
  const denominator = 1 + z2 / trials;
  const rawLower = Math.max(0,
    (p + z2 / (2 * trials)) / denominator -
    z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials) / denominator);
  const displayedLower = roundHalfEven12(rawLower);
  assert.notEqual(rawLower, displayedLower);
  input.thresholds.minWilsonLowerBound['24h'] = (rawLower + displayedLower) / 2;
  const output = evaluateGoNoGo(input);
  assert.equal(output.horizonResults['24h'].wilson95.lower, displayedLower);
  const rawPasses = rawLower >= input.thresholds.minWilsonLowerBound['24h'];
  assert.equal(output.horizonResults['24h'].status, rawPasses ? 'GO' : 'NO_GO');
  assert.equal(
    output.horizonResults['24h'].reasonCodes.includes('WILSON_BELOW_THRESHOLD'),
    !rawPasses
  );
});

test('Wilson uses the frozen formula for a non-vector small sample', () => {
  const input = structuredClone(GO_INPUT);
  const horizon = '24h';
  input.sampleAccounting[horizon] = {
    rawTest: 3,
    effectiveTest: 3,
    classEffectiveTest: { UP: 1, DOWN: 1, RANGE: 1 },
    predictedUpCount: 1,
    predictedDownCount: 1,
    predictedRangeCount: 1
  };
  input.predictedUpCount[horizon] = 1;
  input.predictedDownCount[horizon] = 1;
  input.directionalCoverage[horizon] = 2 / 3;
  input.marketRegimeCoverage[horizon] = 1;
  input.rangeAttribution[horizon] = {
    rangeTotal: 1,
    correctlyPredictedRangeCount: 1,
    predictedRangeCount: 1,
    allPredictionsRange: false
  };
  input.marketRegimeAtGeneration[horizon] = {
    UP: { sampleCount: 1, directionCorrectCount: 1 },
    DOWN: { sampleCount: 1, directionCorrectCount: 1 },
    RANGE: { sampleCount: 1, directionCorrectCount: 0 }
  };
  input.scorecard.horizons[horizon].model.directionCorrectCount = 2;
  input.thresholds.minEffectiveTest[horizon] = 1;
  input.thresholds.minClassEffectiveTest[horizon] = 1;
  input.thresholds.minWilsonLowerBound[horizon] = 0;
  input.thresholds.minDirectionalCoverage[horizon] = 0;
  input.thresholds.minMarketRegimeCoverage[horizon] = 0;

  const output = evaluateGoNoGo(input);
  const z = 1.959963984540054;
  const z2 = z * z;
  const p = 2 / 3;
  const denominator = 1 + z2 / 3;
  const center = (p + z2 / 6) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / 12) / 3) / denominator;
  assert.deepEqual(output.horizonResults[horizon].wilson95, {
    confidenceLevel: 0.95,
    z,
    successes: 2,
    trials: 3,
    lower: roundHalfEven12(Math.max(0, center - margin)),
    upper: roundHalfEven12(Math.min(1, center + margin))
  });
});

test('non-vector structural mutations use fixed reason priority, deduplicate reasons and aggregate horizons', () => {
  const input = structuredClone(GO_INPUT);
  input.auditTrail.validationRunStatus = 'FAILED';
  input.auditTrail.authenticityGateStatus = 'FAILED';
  input.auditTrail.featureCoverage = 0.5;
  input.sampleAccounting['72h'].predictedUpCount = 0;
  input.sampleAccounting['72h'].predictedDownCount = 0;
  input.sampleAccounting['72h'].predictedRangeCount = 15;
  input.predictedUpCount['72h'] = 0;
  input.predictedDownCount['72h'] = 0;
  input.directionalCoverage['72h'] = 0;
  input.rangeAttribution['72h'].predictedRangeCount = 15;
  input.rangeAttribution['72h'].allPredictionsRange = true;
  const output = evaluateGoNoGo(input);
  assert.deepEqual(output.reasonCodes, [
    'AUDIT_RUN_NOT_SUCCEEDED',
    'AUDIT_AUTHENTICITY_NOT_PASSED',
    'FEATURE_COVERAGE_INCOMPLETE',
    'RANGE_PREDICTION_DEGENERATE',
    'DIRECTIONAL_COVERAGE_BELOW_THRESHOLD'
  ]);
  assert.equal(new Set(output.reasonCodes).size, output.reasonCodes.length);
  assert.equal(output.primaryReasonCode, 'AUDIT_RUN_NOT_SUCCEEDED');
  assert.equal(output.overall.status, 'DATA_GATE_FAILED');
});

test('the evaluator does not mutate input and is deterministic across insertion order', () => {
  const input = structuredClone(GO_INPUT);
  const before = canonicalJson(input);
  const first = evaluateGoNoGo(input);
  const second = evaluateGoNoGo(input);
  const reordered = evaluateGoNoGo(reverseObjectKeyOrder(input));
  assert.equal(canonicalJson(input), before);
  assert.deepEqual(first, second);
  assert.deepEqual(first, reordered);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(canonicalSha256(first), canonicalSha256(second));
  assert.match(canonicalSha256(first), /^[0-9a-f]{64}$/);
});

test('D8 output contains only frozen deterministic fields', () => {
  const output = evaluateGoNoGo(GO_INPUT);
  assert.deepEqual(Object.keys(output).sort(), [
    'baselineAvailability', 'evaluatedAt', 'evaluationVersion', 'horizonResults',
    'overall', 'primaryReasonCode', 'reasonCodes', 'schemaVersion', 'validationRunId'
  ]);
  const serialized = canonicalJson(output);
  for (const forbidden of ['generatedAt', 'artifactPath', 'databaseUrl', 'environment', 'randomSeed', 'runtime']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
