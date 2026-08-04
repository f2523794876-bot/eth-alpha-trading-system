import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { buildResearchScorecard, renderResearchScorecardMarkdown } from '../src/validation-replay/research-scorecard.js';
import { createGuardedResearchPgPool } from '../src/db/research-database-guard.js';
import { canonicalTrendOrNull } from '../src/domain/trend.js';

// V1.4D unified fix: this CLI previously connected with a bare `new Pool()`, bypassing the
// declared-name + post-connect current_database() protection every other Phase 2/4/4.5/5 CLI
// gets via createGuardedResearchPgPool(). It still reads only V14D_REPLAY_DATABASE_URL (generic
// DATABASE_URL remains intentionally ignored — unchanged, tested contract), but the connection
// itself now goes through the same fail-closed guard as the rest of the pipeline.

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[index]);
    if (!match) throw new Error(`Unexpected positional argument: ${argv[index]}`);
    const [, key, inline] = match;
    if (inline != null) parsed[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) parsed[key] = argv[++index];
    else parsed[key] = true;
  }
  return parsed;
}

function markdownPathFor(jsonPath) {
  return /\.json$/i.test(jsonPath) ? jsonPath.replace(/\.json$/i, '.md') : `${jsonPath}.md`;
}

const args = parseArgs(process.argv.slice(2));
const output = args.output || 'v1-4d-research-scorecard.json';
const markdownOutput = args['markdown-output'] || markdownPathFor(output);
let rows;
if (args.input) {
  const payload = JSON.parse(await readFile(args.input, 'utf8'));
  rows = Array.isArray(payload) ? payload : payload.rows;
  if (!Array.isArray(rows)) throw new Error('Input must be an array or an object with a rows array');
} else if (args['validation-run-id']) {
  const databaseUrl = process.env.V14D_REPLAY_DATABASE_URL;
  if (!databaseUrl) throw Object.assign(new Error('V14D_REPLAY_DATABASE_URL is required with --validation-run-id; generic DATABASE_URL is intentionally ignored'), { code: 'REPLAY_DATABASE_URL_MISSING' });
  if (!args['evaluation-version']) throw new Error('--evaluation-version is required with --validation-run-id');
  const pool = await createGuardedResearchPgPool(
    { databaseUrl, dbSsl: false },
    { createPgPool: async config => new Pool({ connectionString: config.databaseUrl, max: 2 }) }
  );
  try {
    const result = await pool.query(
      `SELECT s.prediction_id AS "predictionId", s.horizon, s.expected_direction AS "predictedDirection", s.feature_values_used AS "featureValuesUsed",
              s.proxy_state_at_generation AS "proxyStateAtGeneration", s.target_start_time AS "targetStartTime",
              s.target_end_time AS "targetEndTime",
              e.actual_direction AS "actualDirection", e.actual_return AS "actualReturn",
              e.mfe, e.mae, e.endpoint_data_complete AS "endpointDataComplete", e.path_data_complete AS "pathDataComplete",
              e.direction_eligible_for_statistics AS "directionEligibleForStatistics",
              e.path_eligible_for_statistics AS "pathEligibleForStatistics",
              vr.train_end_utc AS "trainEnd", vr.validation_end_utc AS "validationEnd"
       FROM historical_validation.replay_snapshots s
       JOIN historical_validation.validation_runs vr
         ON vr.validation_run_id=$1 AND vr.algorithm_version=s.algorithm_version AND vr.dataset_version=s.dataset_version
       LEFT JOIN historical_validation.replay_outcome_events e
         ON e.prediction_id=s.prediction_id AND e.research_availability_rule_version=s.research_availability_rule_version
        AND e.evaluation_version=$2
       WHERE EXISTS (
         SELECT 1 FROM historical_validation.replay_generation_runs g
         WHERE g.validation_run_id=$1 AND g.horizon=s.horizon
           AND g.historical_as_of_time=s.target_start_time AND g.status='SUCCEEDED'
       ) ORDER BY s.target_end_time, s.prediction_id`,
      [args['validation-run-id'], args['evaluation-version']]
    );
    rows = result.rows.map(row => {
      const trend = row.featureValuesUsed?.trend4h ?? row.featureValuesUsed?.trend4hDirection ?? null;
      return {
        predictionId: row.predictionId,
        horizon: row.horizon,
        targetStartTime: row.targetStartTime,
        targetEndTime: row.targetEndTime,
        predictedDirection: row.predictedDirection,
        actualDirection: row.actualDirection,
        actualReturn: row.actualReturn == null ? null : Number(row.actualReturn),
        mfe: row.mfe == null ? null : Number(row.mfe),
        mae: row.mae == null ? null : Number(row.mae),
        trend4hDirection: canonicalTrendOrNull(trend),
        proxyStateAtGeneration: row.proxyStateAtGeneration ?? null,
        marketRegime: row.featureValuesUsed?.marketRegime ?? null,
        trainEnd: row.trainEnd,
        validationEnd: row.validationEnd,
        endpointDataComplete: row.endpointDataComplete === true,
        pathDataComplete: row.pathDataComplete === true,
        directionEligibleForStatistics: row.directionEligibleForStatistics === true,
        pathEligibleForStatistics: row.pathEligibleForStatistics === true,
        dataMissing: row.directionEligibleForStatistics !== true || row.endpointDataComplete !== true || row.pathDataComplete !== true
      };
    });
  } finally {
    await pool.end();
  }
} else {
  throw new Error('--input=<JSON file> or --validation-run-id=<UUID> is required');
}

if (args['round-trip-cost-bps'] != null && (args['fee-bps'] != null || args['slippage-bps'] != null)) {
  throw new Error('--round-trip-cost-bps cannot be combined with --fee-bps or --slippage-bps');
}
// V1.4D unified fix: cost/fee/slippage assumptions are explicitly PRE_EXECUTION_DECISION_REQUIRED
// (V1_4D_DATA_BACKFILL_SPEC.md / V1_4D_180D_FORMAL_RESEARCH_PLAN.md §B — outcome-engine.js and
// forecast-contract.js model zero cost). This CLI previously defaulted silently to feeBps=8/
// slippageBps=4 when none of the three cost flags were given, which would have produced a
// "cost-adjusted" scorecard using invented numbers nobody approved. The default is now the
// pre-cost baseline (0/0), and any non-zero cost assumption must be passed explicitly and is
// echoed to stderr so it is never silent.
const costFlagsProvided = args['round-trip-cost-bps'] != null || args['fee-bps'] != null || args['slippage-bps'] != null;
const costOptions = args['round-trip-cost-bps'] != null
  ? { roundTripCostBps: Number(args['round-trip-cost-bps']) }
  : { feeBps: args['fee-bps'] == null ? 0 : Number(args['fee-bps']), slippageBps: args['slippage-bps'] == null ? 0 : Number(args['slippage-bps']) };
console.error(costFlagsProvided
  ? `cost_assumption explicit ${JSON.stringify(costOptions)}`
  : `cost_assumption default_pre_cost ${JSON.stringify(costOptions)} (no --round-trip-cost-bps/--fee-bps/--slippage-bps given; see V1_4D_180D_FORMAL_RESEARCH_PLAN.md §K.1 item 2)`);
const trainEnd = rows.find(row => row.trainEnd != null)?.trainEnd ?? null;
const validationEnd = rows.find(row => row.validationEnd != null)?.validationEnd ?? null;
const scorecard = buildResearchScorecard(rows, {
  ...costOptions,
  randomSeed: args.seed == null ? 1404 : Number(args.seed),
  trainEnd,
  validationEnd
});
await writeFile(output, `${JSON.stringify(scorecard, null, 2)}\n`);
await writeFile(markdownOutput, renderResearchScorecardMarkdown(scorecard));
console.log(`research_scorecard_status ${scorecard.status}`);
console.log(`Research scorecard JSON written to ${output}`);
console.log(`Research scorecard Markdown written to ${markdownOutput}`);
if (scorecard.status !== 'EVALUATED') process.exitCode = 2;
