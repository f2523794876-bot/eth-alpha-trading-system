import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';
import { main } from '../../scripts/v1-4d-manifest-inventory.mjs';
import { DATABASE_FAILURE_EXIT_CODE, RESEARCH_DATABASE_NAME } from '../../src/db/research-database-guard.js';

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

pgtest('inventory CLI rejects a real PostgreSQL target mismatch before transaction or inventory SQL', async () => {
  const declaredUrl = new URL(TEST_DATABASE_URL);
  assert.equal(declaredUrl.pathname.slice(1), RESEARCH_DATABASE_NAME);

  const mismatchUrl = new URL(TEST_DATABASE_URL);
  mismatchUrl.pathname = '/postgres';
  assert.notEqual(mismatchUrl.pathname.slice(1), RESEARCH_DATABASE_NAME);

  const observed = {
    poolQueries: [],
    currentDatabase: null,
    connectCalls: 0,
    endCalls: 0
  };
  const output = { stdout: [], stderr: [] };

  const code = await main(
    { V14D_DATABASE_IDENTITY: 'test', DATABASE_URL: TEST_DATABASE_URL },
    {
      stdout: value => output.stdout.push(value),
      stderr: value => output.stderr.push(value),
      createPgPool: async () => {
        const realPool = new pg.Pool({ connectionString: mismatchUrl.toString() });
        return {
          async query(...args) {
            const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
            observed.poolQueries.push(sql);
            const result = await realPool.query(...args);
            if (/current_database\s*\(\s*\)/i.test(sql)) {
              observed.currentDatabase = result.rows?.[0]?.database ?? null;
            }
            return result;
          },
          async connect() {
            observed.connectCalls += 1;
            return realPool.connect();
          },
          async end() {
            observed.endCalls += 1;
            await realPool.end();
          }
        };
      }
    }
  );

  assert.equal(observed.currentDatabase, 'postgres');
  assert.equal(code, DATABASE_FAILURE_EXIT_CODE);
  assert.equal(code, 5);
  assert.equal(output.stdout.length, 0);
  assert.equal(output.stderr.length, 1);
  assert.equal(JSON.parse(output.stderr[0]).errorCode, 'DATABASE_TARGET_REJECTED');

  assert.equal(observed.poolQueries.length, 1);
  assert.match(observed.poolQueries[0].replace(/\s+/g, ' ').trim(), /^SELECT current_database\(\) AS database$/i);
  assert.equal(observed.connectCalls, 0, 'target rejection must happen before acquiring an inventory client');
  assert.equal(observed.endCalls, 1, 'the rejected real PostgreSQL pool must be closed');
  assert.equal(observed.poolQueries.filter(sql => /historical_validation\.dataset_manifests/i.test(sql)).length, 0);
  assert.equal(observed.poolQueries.filter(sql => /\b(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)).length, 0);
  assert.equal(observed.poolQueries.filter(sql => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)).length, 0);
});
