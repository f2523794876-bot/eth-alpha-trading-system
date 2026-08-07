import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildDeterministicScorecard } from './deterministic-scorecard.js';
import { assembleD8InputFromResearchRows } from './d8-input-assembler.js';
import { evaluateGoNoGo } from '../formal-research/go-no-go-evaluator.js';
import { canonicalJson } from '../formal-research/canonical-json.js';

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
    databaseAuditTrail: { schemaVersion: 'v1.4d-audit-trail/1', validationRunId: run, evaluationVersion: 'eval-real', evaluatedAt: finished, validationRunStatus: 'SUCCEEDED', authenticityGateStatus: 'PASSED', manifestCoverage: 1, featureCoverage: 1,
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
  const validationRunId = randomUUID();
  const input = assembleD8InputFromResearchRows({ rows, scorecardResult: result, validationRunId, evaluationVersion: 'eval', evaluatedAt: finished,
    trainEnd, validationEnd, thresholds, databaseAuditTrail: { schemaVersion: 'v1.4d-audit-trail/1', validationRunId, evaluationVersion: 'eval', evaluatedAt: finished } });
  assert.equal(input.baselineAvailabilityInput['24h'].historicalProportionRandom.reasonCode, 'NO_TRAIN_SAMPLES');
  assert.equal(input.preCostLift['24h'], null);
});

function assemble(rows, { feeBps = 5, slippageBps = 3, evaluationVersion = 'eval-consistency' } = {}) {
  const validationRunId = randomUUID();
  const scorecardResult = buildDeterministicScorecard(rows, { feeBps, slippageBps, trainEnd, validationEnd }, { validationRunFinishedAt: finished });
  const input = assembleD8InputFromResearchRows({ scorecardResult, validationRunId, evaluationVersion, evaluatedAt: finished,
    thresholds, databaseAuditTrail: { schemaVersion: 'v1.4d-audit-trail/1', validationRunId, evaluationVersion, evaluatedAt: finished } });
  return { input, scorecardResult };
}

test('scorecard↔D8逐字段一致；targetEnd边界、UP/DOWN/RANGE及成本均沿用唯一权威结果', () => {
  const boundary = { ...row('24h', 99, 'VALIDATION', 'RANGE', 'RANGE', 'RANGE'),
    predictionId: '24h-boundary', targetStartTime: validationEnd - 86_400_000, targetEndTime: validationEnd };
  const { input, scorecardResult } = assemble([...fixtureRows(), boundary]);
  for (const horizon of ['24h', '72h']) {
    const authoritative = scorecardResult.scorecard.horizons[horizon].authoritativeD8;
    assert.deepEqual(input.sampleAccounting[horizon], authoritative.sampleAccounting);
    assert.deepEqual(input.rangeAttribution[horizon], authoritative.rangeAttribution);
    assert.deepEqual(input.marketRegimeAtGeneration[horizon], authoritative.marketRegimeAtGeneration);
    assert.deepEqual(input.scorecard.horizons[horizon].model, authoritative.model);
    for (const name of ['alwaysRange', 'follow4hTrend', 'historicalProportionRandom']) {
      const mapped = input.baselineAvailabilityInput[horizon][name];
      const source = authoritative.baselines[name];
      assert.deepEqual(mapped, source);
    }
  }
  assert.equal(input.sampleAccounting['24h'].rawTest, 4, 'targetEndTime === validationEnd必须进入TEST raw bucket');
  assert.ok(input.sampleAccounting['24h'].classEffectiveTest.RANGE >= 1, 'canonical RANGE不得被排除');
});

test('重复执行、输入行顺序和对象插入顺序不改变canonical D8；成本开关精确透传权威值', () => {
  const rows = fixtureRows();
  const a = assemble(rows, { evaluationVersion: 'stable' });
  const reordered = [...rows].reverse().map(value => Object.fromEntries(Object.entries(value).reverse()));
  const b = assemble(reordered, { evaluationVersion: 'stable' });
  // Run identity is evidence, not a statistical input; normalize it before byte comparison.
  const normalizedRun = '11111111-1111-4111-8111-111111111111';
  for (const value of [a.input, b.input]) {
    value.validationRunId = normalizedRun;
    value.scorecard.validationRunId = normalizedRun;
    value.auditTrail.validationRunId = normalizedRun;
  }
  assert.equal(canonicalJson(a.input), canonicalJson(b.input));
  const noCost = assemble(rows, { feeBps: 0, slippageBps: 0 }).input;
  assert.equal(noCost.scorecard.horizons['24h'].model.postCostExpectedReturn, noCost.scorecard.horizons['24h'].model.preCostExpectedReturn);
  assert.notEqual(a.input.scorecard.horizons['24h'].model.postCostExpectedReturn, a.input.scorecard.horizons['24h'].model.preCostExpectedReturn);
});

test('空数据与权威model NOT_EVALUABLE必须fail-closed，不得默认零或自行变为可评估', () => {
  const scorecardResult = buildDeterministicScorecard([], { feeBps: 0, slippageBps: 0, trainEnd, validationEnd }, { validationRunFinishedAt: finished });
  const validationRunId = randomUUID();
  assert.throws(() => assembleD8InputFromResearchRows({ scorecardResult, validationRunId, evaluationVersion: 'empty', evaluatedAt: finished,
    thresholds, databaseAuditTrail: { validationRunId, evaluationVersion: 'empty', evaluatedAt: finished } }),
  error => error.code === 'D8_AUTHORITATIVE_NOT_EVALUABLE');
});

test('单类别输入保持权威可评估性/不可评估性，不生成未授权补类统计', () => {
  const rows = fixtureRows().filter(value => value.actualDirection === 'UP');
  const { input, scorecardResult } = assemble(rows);
  for (const horizon of ['24h', '72h']) {
    const source = scorecardResult.scorecard.horizons[horizon].authoritativeD8;
    assert.equal(input.sampleAccounting[horizon].effectiveTest, source.sampleAccounting.effectiveTest);
    assert.equal(input.scorecard.horizons[horizon].model.macroF1, source.model.macroF1);
  }
});
