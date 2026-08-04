import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';
import { main } from '../../scripts/v1-4d-manifest-inventory.mjs';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(TEST_DATABASE_URL);
const pgtest = skip ? test.skip : test;

pgtest('inventory CLI passes both explicit and connected identities before running its real read-only PostgreSQL query', async () => {
  const output = { stdout: [], stderr: [] };
  let poolsCreated = 0;
  const code = await main(
    { V14D_DATABASE_IDENTITY: 'test', DATABASE_URL: TEST_DATABASE_URL },
    {
      stdout: value => output.stdout.push(value),
      stderr: value => output.stderr.push(value),
      createPgPool: async config => {
        poolsCreated += 1;
        return new pg.Pool({ connectionString: config.databaseUrl });
      }
    }
  );

  assert.equal(code, 0);
  assert.equal(poolsCreated, 1);
  assert.equal(output.stderr.length, 0);
  const report = JSON.parse(output.stdout[0]);
  assert.equal(report.status, 'READ_ONLY_DIAGNOSTIC');
  assert.ok(Array.isArray(report.manifests));
  assert.ok(Array.isArray(report.conflicts));
});
