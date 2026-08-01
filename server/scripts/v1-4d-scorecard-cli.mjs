import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { buildResearchScorecard, renderResearchScorecardMarkdown } from '../src/validation-replay/research-scorecard.js';

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
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const result = await pool.query(
      `SELECT s.horizon, s.expected_direction AS "predictedDirection", s.feature_values_used AS "featureValuesUsed",
              s.proxy_state_at_generation AS "proxyStateAtGeneration", s.target_end_time AS "targetEndTime",
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
      const targetEnd = new Date(row.targetEndTime).getTime();
      const trainEnd = row.trainEnd == null ? null : new Date(row.trainEnd).getTime();
      const validationEnd = row.validationEnd == null ? null : new Date(row.validationEnd).getTime();
      const trend = row.featureValuesUsed?.trend4h ?? row.featureValuesUsed?.trend4hDirection ?? null;
      return {
        horizon: row.horizon,
        predictedDirection: row.predictedDirection,
        actualDirection: row.actualDirection,
        actualReturn: row.actualReturn == null ? null : Number(row.actualReturn),
        mfe: row.mfe == null ? null : Number(row.mfe),
        mae: row.mae == null ? null : Number(row.mae),
        trend4hDirection: trend === 'up' ? 'UP' : trend === 'down' ? 'DOWN' : trend === 'flat' ? 'RANGE' : null,
        proxyStateAtGeneration: row.proxyStateAtGeneration ?? null,
        marketRegime: row.featureValuesUsed?.marketRegime ?? null,
        split: trainEnd == null || validationEnd == null ? 'ALL' : targetEnd < trainEnd ? 'TRAIN' : targetEnd < validationEnd ? 'VALIDATION' : 'TEST',
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
const costOptions = args['round-trip-cost-bps'] != null
  ? { roundTripCostBps: Number(args['round-trip-cost-bps']) }
  : { feeBps: args['fee-bps'] == null ? 8 : Number(args['fee-bps']), slippageBps: args['slippage-bps'] == null ? 4 : Number(args['slippage-bps']) };
const scorecard = buildResearchScorecard(rows, { ...costOptions, randomSeed: args.seed == null ? 1404 : Number(args.seed) });
await writeFile(output, `${JSON.stringify(scorecard, null, 2)}\n`);
await writeFile(markdownOutput, renderResearchScorecardMarkdown(scorecard));
console.log(`research_scorecard_status ${scorecard.status}`);
console.log(`Research scorecard JSON written to ${output}`);
console.log(`Research scorecard Markdown written to ${markdownOutput}`);
if (scorecard.status !== 'EVALUATED') process.exitCode = 2;
