import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchScorecard, classificationMetrics, renderResearchScorecardMarkdown } from './research-scorecard.js';

test('classificationMetrics calculates three-class macro-F1', () => {
  const rows = [
    { actualDirection: 'UP', predictedDirection: 'UP' },
    { actualDirection: 'DOWN', predictedDirection: 'DOWN' },
    { actualDirection: 'RANGE', predictedDirection: 'UP' }
  ];
  const result = classificationMetrics(rows);
  assert.equal(result.accuracy, 2 / 3);
  assert.ok(Math.abs(result.macroF1 - (2 / 3 + 1 + 0) / 3) < 1e-12);
});

function completeRows() {
  return [
    { actualDirection: 'UP', predictedDirection: 'UP', trend4hDirection: 'UP', actualReturn: .02, mfe: .03, mae: .01, horizon: '24h', split: 'TRAIN', marketRegime: 'BULL', proxyStateAtGeneration: 'PO_TREND_UP_STRUCTURE', actionPermission: 'DISPLAY_ONLY', endpointDataComplete: true, pathDataComplete: true },
    { actualDirection: 'DOWN', predictedDirection: 'UP', trend4hDirection: 'DOWN', actualReturn: -.01, mfe: .005, mae: .02, horizon: '24h', split: 'TRAIN', marketRegime: 'BEAR', proxyStateAtGeneration: 'PO_TREND_DOWN_STRUCTURE', actionPermission: 'AUDIT_ONLY', endpointDataComplete: true, pathDataComplete: true },
    { actualDirection: 'UP', predictedDirection: 'DOWN', trend4hDirection: 'UP', actualReturn: .01, mfe: null, mae: null, horizon: '24h', split: 'VALIDATION', marketRegime: 'BULL', actionPermission: 'DISPLAY_ONLY', endpointDataComplete: true, pathDataComplete: false, dataMissing: true },
    { actualDirection: 'RANGE', predictedDirection: 'RANGE', trend4hDirection: 'RANGE', actualReturn: .001, mfe: null, mae: null, horizon: '24h', split: 'TEST', marketRegime: 'RANGE', actionPermission: 'AUDIT_ONLY', endpointDataComplete: true, pathDataComplete: false },
    { actualDirection: 'RANGE', predictedDirection: 'RANGE', trend4hDirection: 'RANGE', actualReturn: .002, mfe: null, mae: null, horizon: '72h', split: 'TRAIN', marketRegime: 'RANGE', endpointDataComplete: true, pathDataComplete: false },
    { actualDirection: 'UP', predictedDirection: 'UP', trend4hDirection: 'UP', actualReturn: .015, mfe: .02, mae: .01, horizon: '72h', split: 'TRAIN', marketRegime: 'BULL', endpointDataComplete: true, pathDataComplete: true },
    { actualDirection: 'DOWN', predictedDirection: 'DOWN', trend4hDirection: 'DOWN', actualReturn: -.03, mfe: .04, mae: .015, horizon: '72h', split: 'VALIDATION', marketRegime: 'BEAR', endpointDataComplete: true, pathDataComplete: true },
    { actualDirection: 'UP', predictedDirection: 'UP', trend4hDirection: 'UP', actualReturn: .02, mfe: .025, mae: .012, horizon: '72h', split: 'TEST', marketRegime: 'BULL', degraded: true, endpointDataComplete: true, pathDataComplete: true }
  ];
}

test('scorecard is deterministic and reports separate 24H/72H, grouped, path and economic metrics', () => {
  const rows = completeRows();
  const first = buildResearchScorecard(rows, { feeBps: 6, slippageBps: 4, randomSeed: 7 });
  const second = buildResearchScorecard(rows, { feeBps: 6, slippageBps: 4, randomSeed: 7 });
  assert.deepEqual(first.baselines, second.baselines);
  assert.equal(first.status, 'EVALUATED');
  assert.equal(first.system.sampleCount, 8);
  assert.equal(first.horizons['24h'].sampleCount, 4);
  assert.equal(first.horizons['72h'].sampleCount, 4);
  assert.equal(first.system.path.mfeSampleCount, 5, 'null MFE must not be coerced to zero');
  assert.equal(first.system.path.maeSampleCount, 5, 'null MAE must not be coerced to zero');
  assert.equal(first.dataQuality.dataMissingCount, 1);
  assert.equal(first.dataQuality.degradedCount, 1);
  assert.equal(first.byMarketRegime.status, 'EVALUATED');
  assert.ok(first.byMarketRegime.groups.BULL);
  assert.equal(first.byProxyState.status, 'EVALUATED');
  assert.equal(first.byActionPermission.status, 'EVALUATED');
});

test('TRAIN-proportion random baseline derives proportions only from same-horizon TRAIN rows and scores non-TRAIN rows', () => {
  const scorecard = buildResearchScorecard(completeRows(), { randomSeed: 11 });
  const random24 = scorecard.horizons['24h'].baselines.historicalProportionRandom;
  assert.equal(random24.status, 'EVALUATED');
  assert.equal(random24.trainingSampleCount, 2);
  assert.deepEqual(random24.trainingClassProportions, { UP: .5, DOWN: .5, RANGE: 0 });
  assert.equal(random24.sampleCount, 2, 'only VALIDATION and TEST rows are scored');
  const random72 = scorecard.horizons['72h'].baselines.historicalProportionRandom;
  assert.deepEqual(random72.trainingClassProportions, { UP: .5, DOWN: 0, RANGE: .5 });
});

test('fees and slippage are reported separately and RANGE carries no directional position or transaction cost', () => {
  const rows = [
    { actualDirection: 'UP', predictedDirection: 'UP', actualReturn: .01, horizon: '24h' },
    { actualDirection: 'RANGE', predictedDirection: 'RANGE', actualReturn: .5, horizon: '24h' }
  ];
  const economics = buildResearchScorecard(rows, { feeBps: 8, slippageBps: 4 }).system.economics;
  assert.equal(economics.tradeCount, 1);
  assert.equal(economics.grossExpectedReturn, .005);
  assert.ok(Math.abs(economics.feeAdjustedExpectedReturn - .0046) < 1e-12);
  assert.ok(Math.abs(economics.costAdjustedExpectedReturn - .0044) < 1e-12);
  assert.equal(economics.roundTripCostBps, 12);
});

test('maximum drawdown, consecutive classification errors and consecutive net losses are computed in row order', () => {
  const rows = [
    { actualDirection: 'DOWN', predictedDirection: 'UP', actualReturn: -.01, horizon: '24h' },
    { actualDirection: 'DOWN', predictedDirection: 'UP', actualReturn: -.02, horizon: '24h' },
    { actualDirection: 'UP', predictedDirection: 'UP', actualReturn: .005, horizon: '24h' }
  ];
  const system = buildResearchScorecard(rows, { feeBps: 0, slippageBps: 0 }).system;
  assert.equal(system.maxConsecutiveWrong, 2);
  assert.equal(system.economics.maxConsecutiveLosses, 2);
  assert.equal(system.economics.maxDrawdown, .03);
});

test('scorecard does not invent ActionPermission when absent', () => {
  const scorecard = buildResearchScorecard([{ actualDirection: 'UP', predictedDirection: 'UP', actualReturn: .01 }]);
  assert.equal(scorecard.byActionPermission.status, 'NOT_EVALUABLE');
  assert.deepEqual(scorecard.byActionPermission.groups, {});
  assert.match(scorecard.disclosures.actionPermission, /NOT_EVALUABLE/);
  assert.equal(scorecard.baselines.historicalProportionRandom.status, 'NOT_EVALUABLE');
});

test('ActionPermission grouping accepts only DISPLAY_ONLY/AUDIT_ONLY research labels', () => {
  const rows = completeRows();
  rows.push({ actualDirection: 'UP', predictedDirection: 'UP', actualReturn: .01, horizon: '24h', actionPermission: 'ALLOW' });
  const scorecard = buildResearchScorecard(rows);
  assert.deepEqual(Object.keys(scorecard.byActionPermission.groups).sort(), ['AUDIT_ONLY', 'DISPLAY_ONLY']);
  assert.equal(scorecard.dataQuality.invalidActionPermissionCount, 1);
});

test('empty or unusable history is explicitly NOT_EVALUABLE and never emits fabricated zero performance', () => {
  const empty = buildResearchScorecard([]);
  assert.equal(empty.status, 'NOT_EVALUABLE');
  assert.equal(empty.system.status, 'NOT_EVALUABLE');
  assert.equal(empty.horizons['24h'].status, 'NOT_EVALUABLE');
  assert.equal(empty.horizons['72h'].status, 'NOT_EVALUABLE');
  assert.equal(empty.system.accuracy, undefined);
});

test('Markdown report contains horizon, baseline, data-quality and explicit NOT_EVALUABLE disclosures', () => {
  const markdown = renderResearchScorecardMarkdown(buildResearchScorecard(completeRows()));
  assert.match(markdown, /24H \/ 72H system results/);
  assert.match(markdown, /Always RANGE/);
  assert.match(markdown, /TRAIN-proportion random/);
  assert.match(markdown, /Data quality/);
  assert.match(markdown, /ActionPermission grouping/);
  assert.doesNotMatch(markdown, /undefined/);
});

test('invalid costs fail closed instead of producing NaN scorecard values', () => {
  assert.throws(() => buildResearchScorecard(completeRows(), { feeBps: -1 }), /finite non-negative/);
  assert.throws(() => buildResearchScorecard(completeRows(), { slippageBps: Number.NaN }), /finite non-negative/);
});
