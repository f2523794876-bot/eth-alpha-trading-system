// V1_4D_HISTORICAL_REPLAY_SPEC.md §4.0：`npm run dataset:build-manifest` CLI参数解析入口。
// npm run dataset:build-manifest -- --symbol ETHUSDT --intervals 15m,1h,4h --from <UTC> --to <UTC>
// 只编排 dataset-manifest-builder.js，不直接操作数据库连接细节以外的业务逻辑。

import { loadConfig } from '../config.js';
import { createPgPool } from '../db/postgres.js';
import { createGuardedResearchPgPool, exitCodeForCliError } from '../db/research-database-guard.js';
import { parseUtc } from '../backfill/backfill-cli-entry.js';
import { buildDatasetManifest } from './dataset-manifest-builder.js';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      args[key] = value;
      if (value !== true) i += 1;
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2), { createPgPool: createPgPoolOverride = createPgPool } = {}) {
  const args = parseArgs(argv);
  if (args['contract-version'] === undefined || args['contract-version'] === true) throw Object.assign(new Error('--contract-version is required'), { code: 'MISSING_REQUIRED_ARG' });
  const contractVersion = Number(args['contract-version']);
  if (![1, 2].includes(contractVersion)) throw Object.assign(new Error('--contract-version must be 1 or 2'), { code: 'DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED' });
  const from = parseUtc(args.from, '--from');
  const to = parseUtc(args.to, '--to');
  let buildOptions;
  if (contractVersion === 2) {
    if (args.symbol !== undefined || args.symbols !== undefined || args.intervals !== undefined) throw Object.assign(new Error('contract version 2 does not accept --symbol/--symbols/--intervals'), { code: 'CONFLICTING_CONTRACT_PARAMS' });
    if (args['fixed-as-of'] === undefined || args['fixed-as-of'] === true) throw Object.assign(new Error('--fixed-as-of is required for contract version 2'), { code: 'AS_OF_REQUIRED' });
    buildOptions = { contractVersion, from, to, fixedAsOf: parseUtc(args['fixed-as-of'], '--fixed-as-of'), dryRun: args['dry-run'] === true };
  } else {
    const symbol = args.symbol;
    const intervals = String(args.intervals || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!symbol || !intervals.length) throw Object.assign(new Error('--symbol and --intervals are required for contract version 1'), { code: 'MISSING_REQUIRED_ARG' });
    const asOf = args['fixed-as-of'] ?? args['as-of'];
    buildOptions = { contractVersion, symbol, intervals, from, to, fixedAsOf: asOf && asOf !== true ? parseUtc(asOf, '--fixed-as-of') : to - 1, dryRun: args['dry-run'] === true };
  }

  const config = loadConfig();
  const pool = await createGuardedResearchPgPool(config, { createPgPool: createPgPoolOverride });
  try {
    const result = await buildDatasetManifest({ pool, ...buildOptions });
    if (result.status === 'REJECTED') {
      console.error('dataset manifest build REJECTED', { errorCode: result.errorCode, interval: result.interval, integrity: result.integrity });
      process.exitCode = 1;
      return result;
    }
    console.info(`dataset manifest build ${result.status}`, { datasetVersion: result.datasetVersion, manifestContractVersion: contractVersion, recordCount: result.recordCount, inserted: result.inserted, fixedAsOf: new Date(result.fixedAsOf).toISOString(), groupStatistics: result.groupStatistics });
    if (result.warnings?.length) console.warn('dataset manifest build warnings', result.warnings);
    return result;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error('dataset manifest build failed', { code: error.code || error.message }); process.exitCode = exitCodeForCliError(error); });
}
