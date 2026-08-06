import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildDeterministicScorecard } from './deterministic-scorecard.js';
import { assembleD8InputFromResearchRows } from './d8-input-assembler.js';
import { evaluateGoNoGo } from '../formal-research/go-no-go-evaluator.js';

const finished = '2026-01-10T00:00:00.000Z';
const trainEnd = Date.parse('2026-01-04T00:00:00Z');
const validationEnd = Date.parse('2026-01-07T00:00:00Z');
function row(horizon, index, split, actual, predicted, trend = actual) {
  const bases = { TRAIN: Date.parse('2026-01-01T00:00:00Z'), VALIDATION: Date.parse('2026-01-04T00:00:00Z'), TEST: Date.parse('2026-01-07T00:00:00Z') };
  const start = bases[split] + index * (horizon === '24h' ? 86400000 : 259200000);
  return {
    predictionId: `${horizon}-${split}-${index}`, horizon, targetStartTime: start, targetEndTime: start + (horizon === '24h' ? 86400000 : 259200000),
    actualDirection: actual, predictedDirection: predicted, trend4hDirection: trend, trend4hAtGeneration: trend,
    directionCorrect: actual === predicted, directionEligibleForStatistics: true, pathEligibleForStatistics: true,
    actualReturn: actual === 'DOWN' ? -0.02 : actual === 'UP' ? 0.02 : 0.001, mfe: 0.02, mae: 0.01,
    endpointDataComplete: true, pathDataComplete: true
  };
}
function fixtureRows() {
  const rows = [];
  for (const h of ['24h', '72h']) {
    rows.push(row(h, 0, 'TRAIN', 'UP', 'UP'), row(h, 1, 'TRAIN', 'DOWN', 'DOWN'), row(h, 2, 'TRAIN', 'RANGE', 'RANGE'));
    rows.push(row(h, 0, 'VALIDATION', 'UP', 'UP'), row(h, 0, 'TEST', 'UP', 'UP'));
    rows.push(row(h, 1, 'TEST', 'DOWN', 'DOWN'), row(h, 2, 'TEST', 'RANGE', 'RANGE'));
  }
  return rows;
}
const thresholds = {
  schemaVersion: 'v1.4d-go-no-go-thresholds/1', minEffectiveTest: { '24h': 1, '72h': 1 }, minClassEffectiveTest: { '24h': 0, '72h': 0 },
  minDirectionalCoverage: { '24h': 0, '72h': 0 }, minMarketRegimeCoverage: { '24h': 0, '72h': 0 },
  minWilsonLowerBound: { '24h': 0, '72h': 0 }, minPreCostLift: { '24h': -1, '72h': -1 }, minPostCostLift: { '24h': -1, '72h': -1 },
  requireAllBaselines: true, requireMarketRegime: true
};

test('T19 assembles all D8 fields from rows and scorecard without a frozen vector', () => {
  const rows = fixtureRows();
  const run = randomUUID();
  const scorecardResult = buildDeterministicScorecard(rows, { feeBps: 5, slippageBps: 3, trainEnd, validationEnd }, { validationRunFinishedAt: finished });
  const input = assembleD8InputFromResearchRows({
    rows, scorecardResult, validationRunId: run, evaluationVersion: 'eval-real', evaluatedAt: finished,
    trainEnd, validationEnd, thresholds,
    auditTrail: { schemaVersion: 'v1.4d-audit-trail/1', validationRunStatus: 'SUCCEEDED', authenticityGateStatus: 'PASSED', manifestCoverage: 1, featureCoverage: 1,
      datasetVersion: `v1.4d-sha256-${'a'.repeat(64)}`, manifestContentHash: 'b'.repeat(64), backfillBatchIds: [], vintageIds: [],
      generationSummary: { expected: 6, attempted: 6, inserted: 6, reusedIdentical: 0, conflicts: 0, blocked: 0, evaluated: 6 } }
  });
  assert.equal(input.sampleAccounting['24h'].rawTest, 3);
  assert.deepEqual(input.sampleAccounting['24h'].classEffectiveTest, { UP: 1, DOWN: 1, RANGE: 1 });
  assert.equal(input.rangeAttribution['24h'].correctlyPredictedRangeCount, 1);
  assert.equal(input.scorecard.schemaVersion, 'v1.4d-research-scorecard/4-deterministic');
  assert.doesNotThrow(() => evaluateGoNoGo(input));
});

test('baseline mapping fails closed with enum reason and null lift when TRAIN is absent', () => {
  const rows = fixtureRows().filter(r => r.targetStartTime >= trainEnd);
  const result = buildDeterministicScorecard(rows, { feeBps: 5, slippageBps: 3, trainEnd, validationEnd }, { validationRunFinishedAt: finished });
  const input = assembleD8InputFromResearchRows({ rows, scorecardResult: result, validationRunId: randomUUID(), evaluationVersion: 'eval', evaluatedAt: finished,
    trainEnd, validationEnd, thresholds, auditTrail: {} });
  assert.equal(input.baselineAvailabilityInput['24h'].historicalProportionRandom.reasonCode, 'NO_TRAIN_SAMPLES');
  assert.equal(input.preCostLift['24h'], null);
});
