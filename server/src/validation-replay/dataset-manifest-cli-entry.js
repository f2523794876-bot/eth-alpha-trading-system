// V1_4D_HISTORICAL_REPLAY_SPEC.md §4.0：`npm run dataset:build-manifest` CLI参数解析入口。
// npm run dataset:build-manifest -- --symbol ETHUSDT --intervals 15m,1h,4h --from <UTC> --to <UTC>
// 只编排 dataset-manifest-builder.js，不直接操作数据库连接细节以外的业务逻辑。

import { loadConfig } from '../config.js';
import { createPgPool } from '../db/postgres.js';
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

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const symbol = args.symbol;
  const intervals = String(args.intervals || '').split(',').map(s => s.trim()).filter(Boolean);
  const from = parseUtc(args.from, '--from');
  const to = parseUtc(args.to, '--to');
  if (!symbol || !intervals.length) throw Object.assign(new Error('--symbol and --intervals are required'), { code: 'MISSING_REQUIRED_ARG' });

  const config = loadConfig();
  const pool = await createPgPool(config);
  try {
    const result = await buildDatasetManifest({ pool, symbol, intervals, from, to });
    if (result.status === 'REJECTED') {
      console.error('dataset manifest build REJECTED', { errorCode: result.errorCode, interval: result.interval, integrity: result.integrity });
      process.exitCode = 1;
      return result;
    }
    console.info('dataset manifest build SUCCEEDED', { datasetVersion: result.datasetVersion, recordCount: result.recordCount, inserted: result.inserted });
    if (result.warnings?.length) console.warn('dataset manifest build warnings', result.warnings);
    return result;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error('dataset manifest build failed', { code: error.code || error.message }); process.exitCode = 1; });
}
