import { canonicalJson } from './canonical-json.js';
import {
  Draft202012SchemaRegistry,
  loadJsonSchema,
  SchemaValidationError
} from './schema-registry.js';

const THRESHOLDS_SCHEMA_URL = new URL('./schemas/v1-4d-thresholds.schema.json', import.meta.url);
const INPUT_SCHEMA_URL = new URL('./schemas/v1-4d-go-no-go-input.schema.json', import.meta.url);
const OUTPUT_SCHEMA_URL = new URL('./schemas/v1-4d-go-no-go-output.schema.json', import.meta.url);

export const D8_INPUT_SCHEMA_ID = 'https://eth-alpha.invalid/schema/v1.4d-go-no-go-input-2.json';
export const D8_OUTPUT_SCHEMA_ID = 'https://eth-alpha.invalid/schema/v1.4d-go-no-go-output-2.json';

const HORIZONS = Object.freeze(['24h', '72h']);
const DIRECTIONS = Object.freeze(['UP', 'DOWN', 'RANGE']);
const BASELINES = Object.freeze(['alwaysRange', 'follow4hTrend', 'historicalProportionRandom']);
const ABSOLUTE_TOLERANCE = 1e-12;
const WILSON_Z = 1.959963984540054;

const REASON_PRIORITY = Object.freeze([
  'INPUT_CONSISTENCY_FAILED',
  'AUDIT_RUN_NOT_SUCCEEDED',
  'AUDIT_AUTHENTICITY_NOT_PASSED',
  'MANIFEST_COVERAGE_INCOMPLETE',
  'FEATURE_COVERAGE_INCOMPLETE',
  'EFFECTIVE_TEST_ZERO',
  'COVERAGE_NULL',
  'LIFT_NULL',
  'ALWAYS_RANGE_NOT_EVALUABLE',
  'BASELINE_NOT_EVALUABLE',
  'EFFECTIVE_TEST_BELOW_THRESHOLD',
  'CLASS_SAMPLE_BELOW_THRESHOLD',
  'RANGE_CLASS_ABSENT',
  'RANGE_PREDICTION_DEGENERATE',
  'WILSON_BELOW_THRESHOLD',
  'PRE_COST_LIFT_BELOW_THRESHOLD',
  'POST_COST_LIFT_BELOW_THRESHOLD',
  'DIRECTIONAL_COVERAGE_BELOW_THRESHOLD',
  'MARKET_REGIME_COVERAGE_BELOW_THRESHOLD'
]);

const DATA_REASONS = new Set(REASON_PRIORITY.slice(0, 8));
const BASELINE_REASONS = new Set(['ALWAYS_RANGE_NOT_EVALUABLE', 'BASELINE_NOT_EVALUABLE']);
const NO_GO_REASONS = new Set([
  'WILSON_BELOW_THRESHOLD',
  'PRE_COST_LIFT_BELOW_THRESHOLD',
  'POST_COST_LIFT_BELOW_THRESHOLD'
]);

const thresholdsSchema = loadJsonSchema(THRESHOLDS_SCHEMA_URL);
const inputSchema = loadJsonSchema(INPUT_SCHEMA_URL);
const outputSchema = loadJsonSchema(OUTPUT_SCHEMA_URL);
// The frozen input Schema relies on the enclosing sampleCount integer declaration
// inside a conditional `then`. Ajv strictTypes requires that inherited type to be
// restated locally. Add the semantically redundant annotation only to the private
// compilation snapshot; the delivered Schema file remains byte-for-byte equivalent
// to the normative contract block and tests prove the transformation is a no-op.
const compilableInputSchema = structuredClone(inputSchema);
compilableInputSchema.$defs.baseline.allOf[0].then.properties.sampleCount.type = 'integer';
const registry = new Draft202012SchemaRegistry({ schemas: [thresholdsSchema, compilableInputSchema, outputSchema] });

function safeSnapshot(input) {
  try {
    return JSON.parse(canonicalJson(input));
  } catch {
    throw Object.assign(new SchemaValidationError([]), {
      message: 'D8 input must be safe JSON data'
    });
  }
}

function equalNumberOrNull(left, right) {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= ABSOLUTE_TOLERANCE;
}

function sameBaseline(left, right) {
  return left.status === right.status &&
    left.reasonCode === right.reasonCode &&
    left.sampleCount === right.sampleCount &&
    equalNumberOrNull(left.macroF1, right.macroF1) &&
    equalNumberOrNull(left.preCostExpectedReturn, right.preCostExpectedReturn) &&
    equalNumberOrNull(left.postCostExpectedReturn, right.postCostExpectedReturn);
}

function sortedReasons(reasons) {
  const unique = new Set(reasons);
  return REASON_PRIORITY.filter(reason => unique.has(reason));
}

function primaryReason(reasons) {
  return reasons[0] ?? 'NONE';
}

function numericReference(baselines, field) {
  let selected = null;
  for (const name of BASELINES) {
    const candidate = baselines[name];
    if (candidate.status !== 'AVAILABLE') continue;
    if (selected === null || candidate[field] > baselines[selected][field]) selected = name;
  }
  return selected;
}

function baselineAvailability(baselines) {
  const usableBaselines = BASELINES.filter(name => baselines[name].status === 'AVAILABLE');
  const preCostReferenceBaseline = numericReference(baselines, 'preCostExpectedReturn');
  const postCostReferenceBaseline = numericReference(baselines, 'postCostExpectedReturn');
  const reasons = [];
  if (baselines.alwaysRange.status !== 'AVAILABLE') reasons.push('ALWAYS_RANGE_NOT_EVALUABLE');
  if (usableBaselines.length !== BASELINES.length) reasons.push('BASELINE_NOT_EVALUABLE');
  const reasonCodes = sortedReasons(reasons);
  if (reasonCodes.length > 0) {
    return {
      status: 'NOT_EVALUABLE',
      primaryReasonCode: primaryReason(reasonCodes),
      reasonCodes,
      usableBaselines,
      preCostReferenceBaseline,
      postCostReferenceBaseline
    };
  }
  return {
    status: 'AVAILABLE',
    primaryReasonCode: 'NONE',
    reasonCodes: [],
    usableBaselines,
    preCostReferenceBaseline,
    postCostReferenceBaseline
  };
}

function exactBinaryParts(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const high = view.getUint32(0, false);
  const low = view.getUint32(4, false);
  const negative = (high >>> 31) === 1;
  const exponentBits = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  if (exponentBits === 0) {
    return { negative, significand: fraction, exponent: -1074 };
  }
  return {
    negative,
    significand: (1n << 52n) | fraction,
    exponent: exponentBits - 1023 - 52
  };
}

// Round the exact IEEE-754 binary64 value to twelve decimal places using ties-to-even.
export function roundHalfEven12(value) {
  if (!Number.isFinite(value)) throw new TypeError('value must be finite');
  if (Object.is(value, -0) || value === 0) return 0;
  const { negative, significand, exponent } = exactBinaryParts(value);
  let numerator = significand * (5n ** 12n);
  const binaryExponent = exponent + 12;
  let rounded;
  if (binaryExponent >= 0) {
    rounded = numerator << BigInt(binaryExponent);
  } else {
    const denominator = 1n << BigInt(-binaryExponent);
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const doubled = remainder * 2n;
    rounded = quotient + (doubled > denominator || (doubled === denominator && quotient % 2n === 1n) ? 1n : 0n);
  }
  const signed = negative ? -rounded : rounded;
  return Number(signed) / 1e12;
}

function wilson95(successes, trials) {
  if (trials === 0) {
    return {
      confidenceLevel: 0.95,
      z: WILSON_Z,
      successes,
      trials,
      lower: null,
      upper: null
    };
  }
  const z2 = WILSON_Z * WILSON_Z;
  const p = successes / trials;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin = WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials) / denominator;
  const lowerRaw = Math.max(0, center - margin);
  const upperRaw = Math.min(1, center + margin);
  return {
    rawLower: lowerRaw,
    output: {
      confidenceLevel: 0.95,
      z: WILSON_Z,
      successes,
      trials,
      lower: roundHalfEven12(lowerRaw),
      upper: roundHalfEven12(upperRaw)
    }
  };
}

function auditReasons(auditTrail) {
  const reasons = [];
  if (auditTrail.validationRunStatus !== 'SUCCEEDED') reasons.push('AUDIT_RUN_NOT_SUCCEEDED');
  if (auditTrail.authenticityGateStatus !== 'PASSED') reasons.push('AUDIT_AUTHENTICITY_NOT_PASSED');
  if (auditTrail.manifestCoverage !== 1) reasons.push('MANIFEST_COVERAGE_INCOMPLETE');
  if (auditTrail.featureCoverage !== 1) reasons.push('FEATURE_COVERAGE_INCOMPLETE');
  return reasons;
}

function globalIdentityConsistent(input) {
  return input.validationRunId === input.scorecard.validationRunId &&
    input.validationRunId === input.auditTrail.validationRunId &&
    input.evaluationVersion === input.scorecard.evaluationVersion &&
    input.evaluationVersion === input.auditTrail.evaluationVersion &&
    input.evaluatedAt === input.scorecard.evaluatedAt &&
    input.evaluatedAt === input.auditTrail.evaluatedAt;
}

function horizonConsistency(input, horizon, availability, computedPreLift, computedPostLift) {
  const sample = input.sampleAccounting[horizon];
  const range = input.rangeAttribution[horizon];
  const groups = input.marketRegimeAtGeneration[horizon];
  const model = input.scorecard.horizons[horizon].model;
  const baselines = input.scorecard.horizons[horizon].baselines;
  const classTotal = DIRECTIONS.reduce((sum, direction) => sum + sample.classEffectiveTest[direction], 0);
  const predictionTotal = sample.predictedUpCount + sample.predictedDownCount + sample.predictedRangeCount;
  const groupTotal = DIRECTIONS.reduce((sum, direction) => sum + groups[direction].sampleCount, 0);
  const expectedDirectionalCoverage = sample.effectiveTest === 0
    ? null
    : (sample.predictedUpCount + sample.predictedDownCount) / sample.effectiveTest;
  const expectedMarketCoverage = sample.effectiveTest === 0 ? null : groupTotal / sample.effectiveTest;
  const expectedAllRange = sample.effectiveTest > 0 && sample.predictedRangeCount === sample.effectiveTest;

  if (sample.rawTest < sample.effectiveTest || classTotal !== sample.effectiveTest || predictionTotal !== sample.effectiveTest) return false;
  if (input.predictedUpCount[horizon] !== sample.predictedUpCount || input.predictedDownCount[horizon] !== sample.predictedDownCount) return false;
  if (input.directionalCoverage[horizon] !== null && !equalNumberOrNull(input.directionalCoverage[horizon], expectedDirectionalCoverage)) return false;
  if (input.marketRegimeCoverage[horizon] !== null && !equalNumberOrNull(input.marketRegimeCoverage[horizon], expectedMarketCoverage)) return false;
  if (range.rangeTotal !== sample.classEffectiveTest.RANGE || range.predictedRangeCount !== sample.predictedRangeCount) return false;
  if (range.allPredictionsRange !== expectedAllRange) return false;
  if (range.correctlyPredictedRangeCount > range.rangeTotal || range.correctlyPredictedRangeCount > range.predictedRangeCount) return false;
  if (model.directionCorrectCount > sample.effectiveTest || groupTotal > sample.effectiveTest) return false;
  if (DIRECTIONS.some(direction => groups[direction].directionCorrectCount > groups[direction].sampleCount)) return false;
  if (BASELINES.some(name => !sameBaseline(input.baselineAvailabilityInput[horizon][name], baselines[name]))) return false;
  if (availability.status === 'AVAILABLE') {
    return equalNumberOrNull(input.preCostLift[horizon], computedPreLift) &&
      equalNumberOrNull(input.postCostLift[horizon], computedPostLift);
  }
  return input.preCostLift[horizon] === null && input.postCostLift[horizon] === null;
}

function horizonStatus(reasons) {
  if (reasons.some(reason => DATA_REASONS.has(reason))) return 'DATA_GATE_FAILED';
  if (reasons.some(reason => BASELINE_REASONS.has(reason))) return 'BASELINE_NOT_EVALUABLE';
  if (reasons.some(reason => NO_GO_REASONS.has(reason))) return 'NO_GO';
  if (reasons.length > 0) return 'CONDITIONAL_GO';
  return 'GO';
}

function evaluateHorizon(input, horizon, globalReasons) {
  const sample = input.sampleAccounting[horizon];
  const model = input.scorecard.horizons[horizon].model;
  const baselines = input.scorecard.horizons[horizon].baselines;
  const availability = baselineAvailability(baselines);
  const preReference = availability.preCostReferenceBaseline;
  const postReference = availability.postCostReferenceBaseline;
  const preCostLift = availability.status !== 'AVAILABLE' || preReference === null
    ? null
    : model.preCostExpectedReturn - baselines[preReference].preCostExpectedReturn;
  const postCostLift = availability.status !== 'AVAILABLE' || postReference === null
    ? null
    : model.postCostExpectedReturn - baselines[postReference].postCostExpectedReturn;
  const wilson = wilson95(model.directionCorrectCount, sample.effectiveTest);
  const wilsonOutput = wilson.output ?? wilson;
  const reasons = [...globalReasons];

  if (!horizonConsistency(input, horizon, availability, preCostLift, postCostLift)) reasons.push('INPUT_CONSISTENCY_FAILED');
  if (sample.effectiveTest === 0) reasons.push('EFFECTIVE_TEST_ZERO');
  if (input.directionalCoverage[horizon] === null || input.marketRegimeCoverage[horizon] === null) reasons.push('COVERAGE_NULL');
  if (availability.status === 'AVAILABLE' && (preCostLift === null || postCostLift === null ||
      input.preCostLift[horizon] === null || input.postCostLift[horizon] === null)) reasons.push('LIFT_NULL');
  reasons.push(...availability.reasonCodes);

  const thresholds = input.thresholds;
  if (input.rangeAttribution[horizon].rangeTotal === 0) reasons.push('RANGE_CLASS_ABSENT');
  if (input.rangeAttribution[horizon].allPredictionsRange) reasons.push('RANGE_PREDICTION_DEGENERATE');
  // The zero-denominator matrix is auditable but does not run threshold success
  // judgments. RANGE absence remains independently disclosed by the frozen matrix.
  if (sample.effectiveTest > 0) {
    if (sample.effectiveTest < thresholds.minEffectiveTest[horizon]) reasons.push('EFFECTIVE_TEST_BELOW_THRESHOLD');
    if (DIRECTIONS.some(direction => sample.classEffectiveTest[direction] < thresholds.minClassEffectiveTest[horizon])) {
      reasons.push('CLASS_SAMPLE_BELOW_THRESHOLD');
    }
    if (wilson.rawLower != null && wilson.rawLower < thresholds.minWilsonLowerBound[horizon]) reasons.push('WILSON_BELOW_THRESHOLD');
    if (preCostLift != null && preCostLift < thresholds.minPreCostLift[horizon]) reasons.push('PRE_COST_LIFT_BELOW_THRESHOLD');
    if (postCostLift != null && postCostLift < thresholds.minPostCostLift[horizon]) reasons.push('POST_COST_LIFT_BELOW_THRESHOLD');
    if (input.directionalCoverage[horizon] != null && input.directionalCoverage[horizon] < thresholds.minDirectionalCoverage[horizon]) {
      reasons.push('DIRECTIONAL_COVERAGE_BELOW_THRESHOLD');
    }
    if (input.marketRegimeCoverage[horizon] != null && input.marketRegimeCoverage[horizon] < thresholds.minMarketRegimeCoverage[horizon]) {
      reasons.push('MARKET_REGIME_COVERAGE_BELOW_THRESHOLD');
    }
  }

  const reasonCodes = sortedReasons(reasons);
  return {
    availability,
    result: {
      status: horizonStatus(reasonCodes),
      primaryReasonCode: primaryReason(reasonCodes),
      reasonCodes,
      effectiveTest: sample.effectiveTest,
      directionalCoverage: input.directionalCoverage[horizon],
      marketRegimeCoverage: input.marketRegimeCoverage[horizon],
      preCostLift,
      postCostLift,
      wilson95: wilsonOutput
    }
  };
}

function overallStatus(horizonResults) {
  const statuses = HORIZONS.map(horizon => horizonResults[horizon].status);
  if (statuses.includes('DATA_GATE_FAILED')) return 'DATA_GATE_FAILED';
  if (statuses.includes('BASELINE_NOT_EVALUABLE')) return 'BASELINE_NOT_EVALUABLE';
  if (statuses.every(status => status === 'GO')) return 'GO';
  if (statuses.includes('GO')) return 'CONDITIONAL_GO';
  if (statuses.includes('NO_GO')) return 'NO_GO';
  return 'CONDITIONAL_GO';
}

export function evaluateGoNoGo(input) {
  const snapshot = safeSnapshot(input);
  registry.validate(D8_INPUT_SCHEMA_ID, snapshot);

  const globalReasons = auditReasons(snapshot.auditTrail);
  if (!globalIdentityConsistent(snapshot)) globalReasons.push('INPUT_CONSISTENCY_FAILED');

  const evaluated = Object.fromEntries(HORIZONS.map(horizon => [horizon, evaluateHorizon(snapshot, horizon, globalReasons)]));
  const baselineAvailabilityOutput = Object.fromEntries(HORIZONS.map(horizon => [horizon, evaluated[horizon].availability]));
  const horizonResults = Object.fromEntries(HORIZONS.map(horizon => [horizon, evaluated[horizon].result]));
  const overallReasonCodes = sortedReasons(HORIZONS.flatMap(horizon => horizonResults[horizon].reasonCodes));
  const overall = {
    status: overallStatus(horizonResults),
    primaryReasonCode: primaryReason(overallReasonCodes),
    reasonCodes: overallReasonCodes
  };
  const output = {
    schemaVersion: 'v1.4d-go-no-go-output/2',
    validationRunId: snapshot.validationRunId,
    evaluationVersion: snapshot.evaluationVersion,
    evaluatedAt: snapshot.evaluatedAt,
    baselineAvailability: baselineAvailabilityOutput,
    horizonResults,
    overall,
    primaryReasonCode: overall.primaryReasonCode,
    reasonCodes: overall.reasonCodes
  };
  registry.validate(D8_OUTPUT_SCHEMA_ID, output);
  return output;
}
