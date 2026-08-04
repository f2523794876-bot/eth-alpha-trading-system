import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  DATABASE_FAILURE_EXIT_CODE,
  RESEARCH_DATABASE_NAME
} from '../src/db/research-database-guard.js';
import { main } from './v1-4d-manifest-inventory.mjs';

const AUTHORIZED_URL = `postgresql://test-user:test-password@localhost:5432/${RESEARCH_DATABASE_NAME}`;

function fakeDatabase({ actualDatabase = RESEARCH_DATABASE_NAME } = {}) {
  const calls = { poolQueries: [], clientQueries: [], connect: 0, release: 0, end: 0 };
  const client = {
    async query(sql) {
      calls.clientQueries.push(sql);
      if (/^SELECT dataset_version/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    release() { calls.release += 1; }
  };
  const pool = {
    async query(sql) {
      calls.poolQueries.push(sql);
      return { rows: [{ database: actualDatabase }] };
    },
    async connect() {
      calls.connect += 1;
      return client;
    },
    async end() { calls.end += 1; }
  };
  return { calls, pool };
}

async function runMain({ identity, databaseUrl = AUTHORIZED_URL, actualDatabase } = {}) {
  const database = fakeDatabase({ actualDatabase });
  const output = { stdout: [], stderr: [] };
  let createCount = 0;
  const code = await main(
    { V14D_DATABASE_IDENTITY: identity, DATABASE_URL: databaseUrl },
    {
      stdout: value => output.stdout.push(value),
      stderr: value => output.stderr.push(value),
      createPgPool: async () => { createCount += 1; return database.pool; }
    }
  );
  return { code, createCount, ...database, output };
}

for (const identity of ['research', 'test', ' Research ', 'TEST']) {
  test(`inventory CLI allows explicit normalized ${JSON.stringify(identity)} identity and preserves read-only output`, async () => {
    const result = await runMain({ identity });
    assert.equal(result.code, 0);
    assert.equal(result.createCount, 1);
    assert.equal(result.calls.poolQueries.length, 1, 'only current_database() may run before inventory');
    assert.match(result.calls.poolQueries[0], /current_database/i);
    assert.equal(result.calls.clientQueries.filter(sql => /^SELECT dataset_version/.test(sql)).length, 1);
    assert.equal(result.calls.clientQueries.filter(sql => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)).length, 0);
    assert.match(result.output.stdout[0], /READ_ONLY_DIAGNOSTIC/);
    assert.equal(result.output.stderr.length, 0);
    assert.equal(result.calls.release, 1);
    assert.equal(result.calls.end, 1);
  });
}

for (const [label, identity, errorCode] of [
  ['missing', undefined, 'DATABASE_IDENTITY_REQUIRED'],
  ['empty', '   ', 'DATABASE_IDENTITY_REQUIRED'],
  ['unknown', 'staging', 'DATABASE_IDENTITY_REJECTED'],
  ['production', 'production', 'DATABASE_IDENTITY_CONFLICT']
]) {
  test(`inventory CLI rejects ${label} identity before connection and inventory SQL`, async () => {
    const result = await runMain({ identity });
    assert.equal(result.code, DATABASE_FAILURE_EXIT_CODE);
    assert.equal(result.createCount, 0);
    assert.equal(result.calls.poolQueries.length, 0);
    assert.equal(result.calls.clientQueries.length, 0);
    assert.match(result.output.stderr[0], new RegExp(errorCode));
    assert.equal(result.output.stdout.length, 0);
  });
}

test('inventory CLI does not authorize a database by a test/research-looking name alone', async () => {
  for (const name of ['eth_alpha_v14d_test_backup', 'research_inventory', 'arbitrary_test_database']) {
    const result = await runMain({ identity: 'test', databaseUrl: `postgresql://u:p@localhost:5432/${name}` });
    assert.equal(result.code, DATABASE_FAILURE_EXIT_CODE);
    assert.equal(result.createCount, 0);
    assert.equal(result.calls.clientQueries.length, 0);
    assert.match(result.output.stderr[0], /DATABASE_TARGET_REJECTED/);
  }
});

test('inventory CLI rejects declared/connected database conflict before transaction or inventory SQL', async () => {
  const result = await runMain({ identity: 'research', actualDatabase: 'eth_alpha' });
  assert.equal(result.code, DATABASE_FAILURE_EXIT_CODE);
  assert.equal(result.createCount, 1);
  assert.equal(result.calls.poolQueries.length, 1);
  assert.match(result.calls.poolQueries[0], /current_database/i);
  assert.equal(result.calls.connect, 0);
  assert.equal(result.calls.clientQueries.length, 0);
  assert.equal(result.calls.end, 1);
  assert.match(result.output.stderr[0], /DATABASE_TARGET_REJECTED/);
});

test('inventory CLI subprocess exits nonzero with stable code when explicit identity is missing', () => {
  const env = { ...process.env, DATABASE_URL: AUTHORIZED_URL };
  delete env.V14D_DATABASE_IDENTITY;
  const result = spawnSync(process.execPath, ['scripts/v1-4d-manifest-inventory.mjs'], {
    cwd: new URL('..', import.meta.url),
    env,
    encoding: 'utf8'
  });
  assert.equal(result.status, DATABASE_FAILURE_EXIT_CODE);
  assert.match(result.stderr, /DATABASE_IDENTITY_REQUIRED/);
  assert.equal(result.stdout, '');
});
