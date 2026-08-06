import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';
import { loadFormalResearchRows } from '../../src/validation-replay/formal-research-data-repository.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(url);

test('T13 repository SQL compiles against migrated PostgreSQL and an unknown run leaks zero rows', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const rows = await loadFormalResearchRows(pool, { validationRunId: randomUUID(), evaluationVersion: 'r3-batch3-integration' });
    assert.deepEqual(rows, []);
  } finally {
    await pool.end();
  }
});
