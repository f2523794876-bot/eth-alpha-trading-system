import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchScorecard, classificationMetrics, renderResearchScorecardMarkdown } from './research-scorecard.js';
import { buildValidationReports } from './report-builder.js';
import { assertReplayAuthenticity, createReplayAuthenticitySummary, recordGenerationAuthenticity } from './replay-authenticity.js';

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
  ].map((row, index) => ({
    ...row,
    predictionId: `complete-${index}`,
    targetStartTime: index * 1000,
    targetEndTime: index * 1000 + 500,
    directionEligibleForStatistics: true,
    pathEligibleForStatistics: row.mfe != null || row.mae != null
  }));
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
    { predictionId: 'fee-up', actualDirection: 'UP', predictedDirection: 'UP', actualReturn: .01, horizon: '24h', targetStartTime: 0, targetEndTime: 100, directionEligibleForStatistics: true },
    { predictionId: 'fee-range', actualDirection: 'RANGE', predictedDirection: 'RANGE', actualReturn: .5, horizon: '24h', targetStartTime: 100, targetEndTime: 200, directionEligibleForStatistics: true }
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
    { predictionId: 'risk-1', actualDirection: 'DOWN', predictedDirection: 'UP', actualReturn: -.01, horizon: '24h', targetStartTime: 0, targetEndTime: 100, directionEligibleForStatistics: true },
    { predictionId: 'risk-2', actualDirection: 'DOWN', predictedDirection: 'UP', actualReturn: -.02, horizon: '24h', targetStartTime: 100, targetEndTime: 200, directionEligibleForStatistics: true },
    { predictionId: 'risk-3', actualDirection: 'UP', predictedDirection: 'UP', actualReturn: .005, horizon: '24h', targetStartTime: 200, targetEndTime: 300, directionEligibleForStatistics: true }
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

function statisticalRow({ id, horizon = '24h', start, end, split = 'TEST' }) {
  return {
    predictionId: id,
    horizon,
    targetStartTime: start,
    targetEndTime: end,
    split,
    actualDirection: 'UP',
    predictedDirection: 'UP',
    trend4hDirection: 'UP',
    actualReturn: .01,
    directionEligibleForStatistics: true,
    pathEligibleForStatistics: false
  };
}

test('scorecard uses frozen boundary semantics and purges samples ending exactly on split boundaries', () => {
  const rows = [
    statisticalRow({ id: 'train', start: 0, end: 50 }),
    statisticalRow({ id: 'at-train-end', start: 50, end: 100 }),
    statisticalRow({ id: 'validation', start: 100, end: 150 }),
    statisticalRow({ id: 'at-validation-end', start: 150, end: 200 }),
    statisticalRow({ id: 'test', start: 200, end: 250 })
  ];
  const horizon = buildResearchScorecard(rows, { trainEnd: 100, validationEnd: 200 }).horizons['24h'];
  assert.equal(horizon.rawSampleCount, 5);
  assert.equal(horizon.prePurgeEffectiveSampleCount, 5);
  assert.equal(horizon.purgedStraddlingCount, 2);
  assert.equal(horizon.effectiveSampleCount, 3);
  assert.deepEqual(horizon.segments, {
    TRAIN: { rawSampleCount: 1, effectiveSampleCount: 1 },
    VALIDATION: { rawSampleCount: 2, effectiveSampleCount: 1 },
    TEST: { rawSampleCount: 2, effectiveSampleCount: 1 }
  });
});

test('TRAIN→VALIDATION and VALIDATION→TEST straddlers are removed before segment aggregation', () => {
  const rows = [
    statisticalRow({ id: 'train-validation', start: 90, end: 110 }),
    statisticalRow({ id: 'validation-test', start: 190, end: 210 })
  ];
  const horizon = buildResearchScorecard(rows, { trainEnd: 100, validationEnd: 200 }).horizons['24h'];
  assert.equal(horizon.rawSampleCount, 2);
  assert.equal(horizon.prePurgeEffectiveSampleCount, 2);
  assert.equal(horizon.purgedStraddlingCount, 2);
  assert.equal(horizon.effectiveSampleCount, 0);
  assert.equal(horizon.segments.TRAIN.effectiveSampleCount, 0);
  assert.equal(horizon.segments.VALIDATION.effectiveSampleCount, 0);
  assert.equal(horizon.segments.TEST.effectiveSampleCount, 0);
});

test('overlap removal reports independent raw/effective counts for 24H and 72H', () => {
  const rows = [
    statisticalRow({ id: '24-a', horizon: '24h', start: 0, end: 100 }),
    statisticalRow({ id: '24-b', horizon: '24h', start: 10, end: 110 }),
    statisticalRow({ id: '72-a', horizon: '72h', start: 1000, end: 1300 }),
    statisticalRow({ id: '72-b', horizon: '72h', start: 1010, end: 1310 })
  ];
  const scorecard = buildResearchScorecard(rows);
  assert.equal(scorecard.horizons['24h'].rawSampleCount, 2);
  assert.equal(scorecard.horizons['24h'].effectiveSampleCount, 1);
  assert.equal(scorecard.horizons['72h'].rawSampleCount, 2);
  assert.equal(scorecard.horizons['72h'].effectiveSampleCount, 1);
  assert.equal(scorecard.dataQuality.rawSampleCount, 4);
  assert.equal(scorecard.dataQuality.effectiveSampleCount, 2);
});

test('non-overlapping samples preserve raw=effective and empty TRAIN remains explicit', () => {
  const rows = [
    statisticalRow({ id: 'validation', start: 100, end: 150 }),
    statisticalRow({ id: 'test', start: 200, end: 250 })
  ];
  const horizon = buildResearchScorecard(rows, { trainEnd: 100, validationEnd: 200 }).horizons['24h'];
  assert.equal(horizon.rawSampleCount, 2);
  assert.equal(horizon.effectiveSampleCount, 2);
  assert.deepEqual(horizon.segments.TRAIN, { rawSampleCount: 0, effectiveSampleCount: 0 });
  assert.equal(horizon.baselines.historicalProportionRandom.status, 'NOT_EVALUABLE');
});

test('purge can leave a segment empty without fabricating segment performance', () => {
  const rows = [
    statisticalRow({ id: 'crossing-only', start: 90, end: 110 }),
    statisticalRow({ id: 'test', start: 200, end: 250 })
  ];
  const horizon = buildResearchScorecard(rows, { trainEnd: 100, validationEnd: 200 }).horizons['24h'];
  assert.equal(horizon.purgedStraddlingCount, 1);
  assert.deepEqual(horizon.segments.VALIDATION, { rawSampleCount: 1, effectiveSampleCount: 0 });
});

function independentEligibilityRows() {
  return [
    {
      predictionId: 'both', horizon: '24h', targetStartTime: 0, targetEndTime: 100, split: 'TRAIN',
      actualDirection: 'UP', predictedDirection: 'UP', expectedDirection: 'UP', actualReturn: .01,
      directionEligibleForStatistics: true, pathEligibleForStatistics: true, mfe: .05, mae: .01
    },
    {
      predictionId: 'path-only', horizon: '24h', targetStartTime: 100, targetEndTime: 200, split: 'TEST',
      actualDirection: null, predictedDirection: 'UP', expectedDirection: 'UP', actualReturn: null,
      directionEligibleForStatistics: false, pathEligibleForStatistics: true, mfe: .99, mae: .02
    },
    {
      predictionId: 'direction-only', horizon: '24h', targetStartTime: 200, targetEndTime: 300, split: 'TEST',
      actualDirection: 'DOWN', predictedDirection: 'DOWN', expectedDirection: 'DOWN', actualReturn: -.01,
      directionEligibleForStatistics: true, pathEligibleForStatistics: false, mfe: .77, mae: .77
    }
  ];
}

test('direction and path pipelines retain opposite eligibility cases with independent denominators', () => {
  const scorecard = buildResearchScorecard(independentEligibilityRows());
  const horizon = scorecard.horizons['24h'];
  assert.equal(horizon.directionSampleCounts.rawSampleCount, 2);
  assert.equal(horizon.directionSampleCounts.effectiveSampleCount, 2);
  assert.equal(horizon.pathSampleCounts.rawSampleCount, 2);
  assert.equal(horizon.pathSampleCounts.effectiveSampleCount, 2);
  assert.equal(horizon.system.sampleCount, 2);
  assert.equal(horizon.system.path.mfeSampleCount, 2);
  assert.equal(horizon.system.path.averageMfe, .52, 'path-only mfe=0.99 must be included; direction-only mfe=0.77 must be excluded');
});

test('research scorecard and report-builder expose the same independent direction/path denominators', async () => {
  const rows = independentEligibilityRows();
  const inserted = [];
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('SELECT status FROM historical_validation.validation_runs')) return { rowCount: 1, rows: [{ status: 'RUNNING' }] };
      if (sql.includes('SELECT s.prediction_id')) {
        const horizon = params[1];
        return { rows: horizon === '24h' ? rows.map(row => ({
          predictionId: row.predictionId,
          horizon: row.horizon,
          targetStartTimeRaw: new Date(row.targetStartTime),
          targetEndTimeRaw: new Date(row.targetEndTime),
          proxyStateAtGeneration: 'PO_UNKNOWN',
          expectedDirection: row.expectedDirection,
          featureValuesUsed: {},
          directionEligibleForStatistics: row.directionEligibleForStatistics,
          pathEligibleForStatistics: row.pathEligibleForStatistics,
          directionCorrect: row.directionEligibleForStatistics ? row.actualDirection === row.expectedDirection : null,
          actualDirection: row.actualDirection,
          endpointDataComplete: true,
          pathDataComplete: row.pathEligibleForStatistics,
          mfe: row.mfe,
          mae: row.mae,
          realizedRangeInsideExpectedEnvelope: null,
          expectedEnvelopeTouched: null
        })) : [] };
      }
      if (sql.includes('INSERT INTO historical_validation.validation_reports')) {
        inserted.push(params);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in report-builder parity test: ${sql}`);
    }
  };
  const authenticitySummary = createReplayAuthenticitySummary({ mode: 'resume', expectedCount: 1 });
  recordGenerationAuthenticity(authenticitySummary, 'INSERTED');
  assertReplayAuthenticity(authenticitySummary);
  const reports = await buildValidationReports({
    pool,
    validationRunId: '00000000-0000-0000-0000-000000000001',
    datasetVersion: 'v1.4d-sha256-' + 'a'.repeat(64),
    algorithmVersion: 'test-algorithm',
    ruleVersion: 'test-rule',
    researchAvailabilityRuleVersion: 'test-availability',
    evaluationVersion: 'test-evaluation', authenticitySummary
  });
  assert.equal(inserted.length, 2);
  const report = reports.find(value => value.horizon === '24h' && value.reportScope === 'ALL');
  const horizon = buildResearchScorecard(rows).horizons['24h'];
  assert.equal(horizon.directionSampleCounts.rawSampleCount, report.directionRawSampleCount);
  assert.equal(horizon.directionSampleCounts.effectiveSampleCount, report.directionEffectiveSampleCount);
  assert.equal(horizon.pathSampleCounts.rawSampleCount, report.pathRawSampleCount);
  assert.equal(horizon.pathSampleCounts.effectiveSampleCount, report.pathEffectiveSampleCount);
});
