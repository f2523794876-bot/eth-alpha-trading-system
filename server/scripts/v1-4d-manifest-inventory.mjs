import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createPgPool } from '../src/db/postgres.js';
import {
  assertExplicitResearchDatabaseIdentity,
  createGuardedResearchPgPool,
  exitCodeForCliError,
  RESEARCH_DATABASE_IDENTITY_ENV
} from '../src/db/research-database-guard.js';
import { diagnoseLegacyWindowConflicts, inventoryDatasetManifests } from '../src/legacy-diagnostics/dataset-manifest-inventory.js';

export const INVENTORY_DATABASE_IDENTITY_ENV = RESEARCH_DATABASE_IDENTITY_ENV;

export async function main(env = process.env, {
  stdout = console.log,
  stderr = console.error,
  createPgPool: createPgPoolOverride = createPgPool
} = {}) {
  let pool;
  let client;
  let transactionStarted = false;
  try {
    // 必须先验证显式运行身份。production/缺失/未知身份在创建连接前即拒绝。
    assertExplicitResearchDatabaseIdentity(env[INVENTORY_DATABASE_IDENTITY_ENV]);
    const config = { ...loadConfig(), databaseUrl: env.DATABASE_URL || '' };
    pool = await createGuardedResearchPgPool(config, { createPgPool: createPgPoolOverride });
    client = await pool.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    transactionStarted = true;
    const manifests = await inventoryDatasetManifests(client);
    const conflicts = diagnoseLegacyWindowConflicts(manifests);
    await client.query('ROLLBACK');
    transactionStarted = false;
    stdout(JSON.stringify({ status: 'READ_ONLY_DIAGNOSTIC', server72Minus72RootCause: 'NOT_CONFIRMED', manifests, conflicts }, null, 2));
    return 0;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 回滚失败不得覆盖触发fail-closed的原始错误。
      }
    }
    stderr(JSON.stringify({ status: 'BLOCKED', errorCode: error.code || 'MANIFEST_INVENTORY_FAILED' }));
    return exitCodeForCliError(error);
  } finally {
    try {
      client?.release();
    } finally {
      await pool?.end();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
