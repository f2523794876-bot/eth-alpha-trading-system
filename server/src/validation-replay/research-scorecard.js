const DIRECTIONS = Object.freeze(['UP', 'DOWN', 'RANGE']);
const RESEARCH_ACTION_PERMISSIONS = Object.freeze(['DISPLAY_ONLY', 'AUDIT_ONLY']);

function safeMean(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeMedian(values) {
  const usable = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!usable.length) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

function notEvaluable(reason, extra = {}) {
  return { status: 'NOT_EVALUABLE', reason, ...extra };
}

function classificationMetrics(rows, predictionField = 'predictedDirection') {
  const eligible = rows.filter(row => DIRECTIONS.includes(row.actualDirection) && DIRECTIONS.includes(row[predictionField]));
  const confusion = Object.fromEntries(DIRECTIONS.map(actual => [actual, Object.fromEntries(DIRECTIONS.map(predicted => [predicted, 0]))]));
  let correct = 0;
  for (const row of eligible) {
    const actual = row.actualDirection;
    const predicted = row[predictionField];
    if (!DIRECTIONS.includes(actual) || !DIRECTIONS.includes(predicted)) continue;
    confusion[actual][predicted] += 1;
    if (actual === predicted) correct += 1;
  }
  const perClass = {};
  for (const label of DIRECTIONS) {
    const tp = confusion[label][label];
    const fp = DIRECTIONS.reduce((sum, actual) => sum + (actual === label ? 0 : confusion[actual][label]), 0);
    const fn = DIRECTIONS.reduce((sum, predicted) => sum + (predicted === label ? 0 : confusion[label][predicted]), 0);
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    perClass[label] = { precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0, support: tp + fn };
  }
  return {
    sampleCount: eligible.length,
    accuracy: eligible.length ? correct / eligible.length : null,
    macroF1: eligible.length ? safeMean(DIRECTIONS.map(label => perClass[label].f1)) : null,
    confusion,
    perClass
  };
}

function predictedReturn(row, predictionField) {
  const actualReturn = finiteNumber(row.actualReturn);
  if (actualReturn == null) return null;
  if (row[predictionField] === 'UP') return actualReturn;
  if (row[predictionField] === 'DOWN') return -actualReturn;
  if (row[predictionField] === 'RANGE') return 0;
  return null;
}

function drawdownAndLosingStreak(returns) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let currentLosses = 0;
  let maxConsecutiveLosses = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (value <= 0) currentLosses += 1;
    else currentLosses = 0;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
  }
  return { maxDrawdown, maxConsecutiveLosses };
}

function economicMetrics(rows, predictionField, costs) {
  const fee = costs.feeBps / 10000;
  const slippage = costs.slippageBps / 10000;
  const observations = rows.map(row => {
    const gross = predictedReturn(row, predictionField);
    if (!Number.isFinite(gross)) return null;
    const traded = row[predictionField] === 'UP' || row[predictionField] === 'DOWN';
    return {
      gross,
      afterFees: gross - (traded ? fee : 0),
      afterFeesAndSlippage: gross - (traded ? fee + slippage : 0),
      traded
    };
  }).filter(Boolean);
  const grossReturns = observations.map(value => value.gross);
  const feeAdjustedReturns = observations.map(value => value.afterFees);
  const costAdjustedReturns = observations.map(value => value.afterFeesAndSlippage);
  const risk = drawdownAndLosingStreak(costAdjustedReturns);
  return {
    sampleCount: observations.length,
    tradeCount: observations.filter(value => value.traded).length,
    tradeCoverage: observations.length ? observations.filter(value => value.traded).length / observations.length : null,
    feeBps: costs.feeBps,
    slippageBps: costs.slippageBps,
    roundTripCostBps: costs.totalBps,
    grossExpectedReturn: safeMean(grossReturns),
    feeAdjustedExpectedReturn: safeMean(feeAdjustedReturns),
    costAdjustedExpectedReturn: safeMean(costAdjustedReturns),
    cumulativeGrossReturn: grossReturns.length ? grossReturns.reduce((sum, value) => sum + value, 0) : null,
    cumulativeFeeAdjustedReturn: feeAdjustedReturns.length ? feeAdjustedReturns.reduce((sum, value) => sum + value, 0) : null,
    cumulativeCostAdjustedReturn: costAdjustedReturns.length ? costAdjustedReturns.reduce((sum, value) => sum + value, 0) : null,
    maxDrawdown: costAdjustedReturns.length ? risk.maxDrawdown : null,
    maxConsecutiveLosses: costAdjustedReturns.length ? risk.maxConsecutiveLosses : null
  };
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function randomProportionPredictions(rows, seed, proportions) {
  const cut1 = proportions.UP;
  const cut2 = cut1 + proportions.DOWN;
  const random = mulberry32(seed);
  return rows.map(row => ({ ...row, baselinePrediction: (value => value < cut1 ? 'UP' : value < cut2 ? 'DOWN' : 'RANGE')(random()) }));
}

function pathMetrics(rows) {
  const mfe = rows.map(row => finiteNumber(row.mfe)).filter(Number.isFinite);
  const mae = rows.map(row => finiteNumber(row.mae)).filter(Number.isFinite);
  return {
    mfeSampleCount: mfe.length,
    maeSampleCount: mae.length,
    averageMfe: safeMean(mfe),
    medianMfe: safeMedian(mfe),
    averageMae: safeMean(mae),
    medianMae: safeMedian(mae)
  };
}

function summarize(rows, predictionField, costs) {
  const eligible = rows.filter(row => DIRECTIONS.includes(row.actualDirection) && DIRECTIONS.includes(row[predictionField]));
  if (!eligible.length) return notEvaluable('No rows contain both an eligible actual direction and prediction.', { sampleCount: 0 });
  let currentWrong = 0;
  let maxConsecutiveWrong = 0;
  for (const row of eligible) {
    currentWrong = row[predictionField] === row.actualDirection ? 0 : currentWrong + 1;
    maxConsecutiveWrong = Math.max(maxConsecutiveWrong, currentWrong);
  }
  const path = pathMetrics(eligible);
  return {
    status: 'EVALUATED',
    ...classificationMetrics(eligible, predictionField),
    maxConsecutiveWrong,
    ...path,
    path,
    economics: economicMetrics(eligible, predictionField, costs)
  };
}

function groupSummaries(rows, field, predictionField, costs) {
  const values = [...new Set(rows.map(row => row[field]).filter(value => typeof value === 'string' && value.trim()))].sort();
  return Object.fromEntries(values.map(value => [value, summarize(rows.filter(row => row[field] === value), predictionField, costs)]));
}

function actionPermissionSummaries(rows, predictionField, costs) {
  const values = [...new Set(rows.map(row => row.actionPermission).filter(value => RESEARCH_ACTION_PERMISSIONS.includes(value)))].sort();
  return Object.fromEntries(values.map(value => [value, summarize(rows.filter(row => row.actionPermission === value), predictionField, costs)]));
}

function normalizeCosts(options) {
  const hasCombined = options.roundTripCostBps != null;
  const explicitFee = Object.hasOwn(options, 'feeBps');
  const explicitSlippage = Object.hasOwn(options, 'slippageBps');
  const feeBps = explicitFee ? finiteNumber(options.feeBps) : hasCombined ? finiteNumber(options.roundTripCostBps) : 8;
  const slippageBps = explicitSlippage ? finiteNumber(options.slippageBps) : hasCombined ? 0 : 4;
  if (feeBps == null || slippageBps == null || feeBps < 0 || slippageBps < 0) {
    throw new TypeError('feeBps and slippageBps must be finite non-negative numbers');
  }
  return { feeBps, slippageBps, totalBps: feeBps + slippageBps };
}

function evaluationRows(rows) {
  const hasSplitLabels = rows.some(row => ['TRAIN', 'VALIDATION', 'TEST'].includes(row.split));
  return {
    rows: hasSplitLabels ? rows.filter(row => row.split === 'VALIDATION' || row.split === 'TEST') : rows,
    scope: hasSplitLabels ? 'VALIDATION_AND_TEST' : 'ALL_ROWS_NO_SPLIT_LABELS'
  };
}

function buildBaselines(rows, costs, randomSeed) {
  const evaluation = evaluationRows(rows);
  if (!evaluation.rows.length) {
    const blocked = notEvaluable('No VALIDATION or TEST rows are available for leakage-safe baseline evaluation.', { evaluationScope: evaluation.scope });
    return { alwaysRange: blocked, follow4hTrend: blocked, historicalProportionRandom: blocked };
  }
  const rangeRows = evaluation.rows.map(row => ({ ...row, baselinePrediction: 'RANGE' }));
  const trendRows = evaluation.rows.filter(row => DIRECTIONS.includes(row.trend4hDirection)).map(row => ({ ...row, baselinePrediction: row.trend4hDirection }));
  const trainingRows = rows.filter(row => row.split === 'TRAIN');
  const trainingCounts = Object.fromEntries(DIRECTIONS.map(label => [label, trainingRows.filter(row => row.actualDirection === label).length]));
  const proportions = trainingRows.length
    ? Object.fromEntries(DIRECTIONS.map(label => [label, trainingCounts[label] / trainingRows.length]))
    : null;
  const randomRows = proportions ? randomProportionPredictions(evaluation.rows, randomSeed, proportions) : [];
  return {
    alwaysRange: { ...summarize(rangeRows, 'baselinePrediction', costs), evaluationScope: evaluation.scope },
    follow4hTrend: trendRows.length
      ? { ...summarize(trendRows, 'baselinePrediction', costs), evaluationScope: evaluation.scope, coverage: trendRows.length / evaluation.rows.length }
      : notEvaluable('No evaluation rows contain a valid 4H trend direction.', { evaluationScope: evaluation.scope, coverage: 0 }),
    historicalProportionRandom: proportions
      ? {
          ...summarize(randomRows, 'baselinePrediction', costs), evaluationScope: evaluation.scope,
          trainingSampleCount: trainingRows.length, trainingClassCounts: trainingCounts,
          trainingClassProportions: proportions, randomSeed
        }
      : notEvaluable('No TRAIN-labelled rows; refusing to derive class proportions from validation/test outcomes.', { evaluationScope: evaluation.scope })
  };
}

function buildScope(rows, costs, randomSeed) {
  if (!rows.length) return notEvaluable('No eligible rows are available for this scope.', {
    system: notEvaluable('No eligible rows are available for this scope.', { sampleCount: 0 }),
    baselines: buildBaselines([], costs, randomSeed)
  });
  const evaluation = evaluationRows(rows);
  const outOfSampleSystem = evaluation.rows.length
    ? { ...summarize(evaluation.rows, 'predictedDirection', costs), evaluationScope: evaluation.scope }
    : notEvaluable('No VALIDATION or TEST rows are available for out-of-sample system evaluation.', { evaluationScope: evaluation.scope });
  const baselines = buildBaselines(rows, costs, randomSeed);
  const fullyEvaluable = outOfSampleSystem.status === 'EVALUATED' && Object.values(baselines).every(value => value.status === 'EVALUATED');
  return {
    status: fullyEvaluable ? 'EVALUATED' : 'PARTIAL',
    sampleCount: rows.length,
    system: summarize(rows, 'predictedDirection', costs),
    outOfSampleSystem,
    baselines
  };
}

function buildDataQuality(inputRows, eligibleRows) {
  const count = predicate => inputRows.filter(predicate).length;
  const byHorizon = Object.fromEntries(['24h', '72h'].map(horizon => {
    const rows = inputRows.filter(row => row.horizon === horizon);
    return [horizon, {
      inputCount: rows.length,
      eligibleDirectionCount: rows.filter(row => DIRECTIONS.includes(row.actualDirection) && DIRECTIONS.includes(row.predictedDirection)).length,
      endpointIncompleteCount: rows.filter(row => row.endpointDataComplete === false).length,
      pathIncompleteCount: rows.filter(row => row.pathDataComplete === false).length
    }];
  }));
  return {
    status: inputRows.length && eligibleRows.length ? 'EVALUATED' : 'NOT_EVALUABLE',
    inputCount: inputRows.length,
    eligibleDirectionCount: eligibleRows.length,
    excludedDirectionCount: inputRows.length - eligibleRows.length,
    economicEligibleCount: eligibleRows.filter(row => finiteNumber(row.actualReturn) != null).length,
    pathEligibleCount: eligibleRows.filter(row => finiteNumber(row.mfe) != null || finiteNumber(row.mae) != null).length,
    endpointIncompleteCount: count(row => row.endpointDataComplete === false),
    pathIncompleteCount: count(row => row.pathDataComplete === false),
    dataMissingCount: count(row => row.dataMissing === true),
    degradedCount: count(row => row.degraded === true),
    blockedCount: count(row => row.blocked === true),
    invalidActionPermissionCount: count(row => row.actionPermission != null && !RESEARCH_ACTION_PERMISSIONS.includes(row.actionPermission)),
    byHorizon
  };
}

export function buildResearchScorecard(inputRows, options = {}) {
  if (!Array.isArray(inputRows)) throw new TypeError('inputRows must be an array');
  const randomSeed = finiteNumber(options.randomSeed) ?? 1404;
  const costs = normalizeCosts(options);
  const rows = inputRows.filter(row => DIRECTIONS.includes(row.actualDirection) && DIRECTIONS.includes(row.predictedDirection));
  const horizons = Object.fromEntries(['24h', '72h'].map((horizon, index) => [
    horizon,
    buildScope(rows.filter(row => row.horizon === horizon), costs, randomSeed + index)
  ]));
  const evaluatedHorizons = Object.values(horizons).filter(value => value.status === 'EVALUATED').length;
  const populatedHorizons = Object.values(horizons).filter(value => value.sampleCount > 0).length;
  const marketRegimeGroups = groupSummaries(rows, 'marketRegime', 'predictedDirection', costs);
  const proxyStateGroups = groupSummaries(rows, 'proxyStateAtGeneration', 'predictedDirection', costs);
  const actionPermissionGroups = actionPermissionSummaries(rows, 'predictedDirection', costs);
  return {
    schemaVersion: 'v1.4d-research-scorecard/2',
    status: evaluatedHorizons === 2 ? 'EVALUATED' : populatedHorizons === 0 ? 'NOT_EVALUABLE' : 'PARTIAL',
    generatedAt: new Date().toISOString(),
    assumptions: {
      feeBps: costs.feeBps, slippageBps: costs.slippageBps, roundTripCostBps: costs.totalBps,
      randomSeed, rangeEconomicRule: 'RANGE means no directional position: gross return and transaction costs are both zero.',
      randomBaselineRule: 'Class proportions are estimated only from TRAIN rows; predictions are scored only on VALIDATION/TEST rows.'
    },
    system: summarize(rows, 'predictedDirection', costs),
    outOfSampleSystem: buildScope(rows, costs, randomSeed).outOfSampleSystem,
    baselines: buildBaselines(rows, costs, randomSeed),
    horizons,
    byHorizon: Object.fromEntries(Object.entries(horizons).map(([horizon, value]) => [horizon, value.system])),
    bySplit: groupSummaries(rows, 'split', 'predictedDirection', costs),
    byMarketRegime: Object.keys(marketRegimeGroups).length
      ? { status: 'EVALUATED', groups: marketRegimeGroups }
      : notEvaluable('No explicit marketRegime labels were supplied.', { groups: {} }),
    byProxyState: Object.keys(proxyStateGroups).length
      ? { status: 'EVALUATED', groups: proxyStateGroups }
      : notEvaluable('No proxyStateAtGeneration labels were supplied.', { groups: {} }),
    byActionPermission: Object.keys(actionPermissionGroups).length
      ? { status: 'EVALUATED', groups: actionPermissionGroups }
      : notEvaluable('V1.4D replay snapshots structurally exclude ActionPermission; no caller-supplied audit labels were available.', { groups: {} }),
    dataQuality: buildDataQuality(inputRows, rows),
    disclosures: {
      actionPermission: Object.keys(actionPermissionGroups).length
        ? 'Computed only from caller-supplied DISPLAY_ONLY/AUDIT_ONLY research labels; V1.4D replay schema does not generate ActionPermission.'
        : 'NOT_EVALUABLE: V1.4D replay schema intentionally excludes ActionPermission.',
      marketRegime: Object.keys(marketRegimeGroups).length
        ? 'Computed from caller-supplied explicit marketRegime labels.'
        : 'NOT_EVALUABLE: no explicit marketRegime labels; proxy-state grouping is reported separately and is not relabelled as market regime.',
      significance: 'Descriptive statistics only; statistical significance and confidence intervals are not inferred.'
    }
  };
}

function printable(value, digits = 6) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'NOT_EVALUABLE';
}

function summaryRow(label, summary) {
  if (!summary || summary.status !== 'EVALUATED') return `| ${label} | NOT_EVALUABLE | — | — | — | — |`;
  return `| ${label} | ${summary.sampleCount} | ${printable(summary.accuracy)} | ${printable(summary.macroF1)} | ${printable(summary.economics.costAdjustedExpectedReturn)} | ${printable(summary.economics.maxDrawdown)} |`;
}

function horizonSummaryRow(label, summary) {
  if (!summary || summary.status !== 'EVALUATED') return `| ${label} | NOT_EVALUABLE | — | — | — | — | — | — | — |`;
  return `| ${label} | ${summary.sampleCount} | ${printable(summary.accuracy)} | ${printable(summary.macroF1)} | ${printable(summary.averageMfe)} | ${printable(summary.averageMae)} | ${printable(summary.economics.costAdjustedExpectedReturn)} | ${printable(summary.economics.maxDrawdown)} | ${summary.maxConsecutiveWrong} |`;
}

function horizonBaselineRows(scorecard) {
  const labels = { alwaysRange: 'Always RANGE', follow4hTrend: 'Follow 4H trend', historicalProportionRandom: 'TRAIN-proportion random' };
  const rows = [];
  for (const horizon of ['24h', '72h']) {
    for (const [key, label] of Object.entries(labels)) {
      const summary = scorecard.horizons[horizon]?.baselines?.[key];
      rows.push(summary?.status === 'EVALUATED'
        ? `| ${horizon.toUpperCase()} | ${label} | ${summary.sampleCount} | ${printable(summary.macroF1)} | ${printable(summary.economics.costAdjustedExpectedReturn)} |`
        : `| ${horizon.toUpperCase()} | ${label} | NOT_EVALUABLE | — | — |`);
    }
  }
  return rows;
}

export function renderResearchScorecardMarkdown(scorecard) {
  const lines = [
    '# V1.4D research scorecard', '',
    `- Status: **${scorecard.status}**`,
    `- Generated at: ${scorecard.generatedAt}`,
    `- Fee/slippage/total cost (bps): ${scorecard.assumptions.feeBps}/${scorecard.assumptions.slippageBps}/${scorecard.assumptions.roundTripCostBps}`,
    `- Input/eligible/economic/path samples: ${scorecard.dataQuality.inputCount}/${scorecard.dataQuality.eligibleDirectionCount}/${scorecard.dataQuality.economicEligibleCount}/${scorecard.dataQuality.pathEligibleCount}`,
    '', '## 24H / 72H system results', '',
    '| Horizon | Samples | Accuracy | Macro-F1 | Avg MFE | Avg MAE | Cost-adjusted expected return | Max drawdown | Max consecutive errors |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    horizonSummaryRow('24H', scorecard.horizons['24h']?.system),
    horizonSummaryRow('72H', scorecard.horizons['72h']?.system),
    '', '## Leakage-safe baselines', '',
    '| Baseline | Samples | Accuracy | Macro-F1 | Cost-adjusted expected return | Max drawdown |',
    '|---|---:|---:|---:|---:|---:|',
    summaryRow('Always RANGE', scorecard.baselines.alwaysRange),
    summaryRow('Follow 4H trend', scorecard.baselines.follow4hTrend),
    summaryRow('TRAIN-proportion random', scorecard.baselines.historicalProportionRandom),
    '', '## Per-horizon baselines', '',
    '| Horizon | Baseline | Samples | Macro-F1 | Cost-adjusted expected return |',
    '|---|---|---:|---:|---:|',
    ...horizonBaselineRows(scorecard),
    '', '## Data quality', '',
    `- Endpoint incomplete: ${scorecard.dataQuality.endpointIncompleteCount}`,
    `- Path incomplete: ${scorecard.dataQuality.pathIncompleteCount}`,
    `- Missing/degraded/blocked: ${scorecard.dataQuality.dataMissingCount}/${scorecard.dataQuality.degradedCount}/${scorecard.dataQuality.blockedCount}`,
    `- Invalid ActionPermission labels excluded: ${scorecard.dataQuality.invalidActionPermissionCount}`,
    `- ActionPermission grouping: **${scorecard.byActionPermission.status}**`,
    `- Market-regime grouping: **${scorecard.byMarketRegime.status}**`,
    `- Proxy-state grouping: **${scorecard.byProxyState.status}**`,
    '', '## Disclosures', '',
    `- ${scorecard.disclosures.actionPermission}`,
    `- ${scorecard.disclosures.marketRegime}`,
    `- ${scorecard.disclosures.significance}`
  ];
  return `${lines.join('\n')}\n`;
}

export { classificationMetrics };
