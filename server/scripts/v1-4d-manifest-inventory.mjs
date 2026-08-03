import { loadConfig } from '../src/config.js';
import { createPgPool } from '../src/db/postgres.js';
import { diagnoseLegacyWindowConflicts, inventoryDatasetManifests } from '../src/legacy-diagnostics/dataset-manifest-inventory.js';

const pool = await createPgPool(loadConfig());
const client = await pool.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  const manifests = await inventoryDatasetManifests(client);
  const conflicts = diagnoseLegacyWindowConflicts(manifests);
  console.log(JSON.stringify({ status: 'READ_ONLY_DIAGNOSTIC', server72Minus72RootCause: 'NOT_CONFIRMED', manifests, conflicts }, null, 2));
  await client.query('ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
