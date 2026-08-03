import test from 'node:test';
import assert from 'node:assert/strict';
import { withManifestPersistenceConnection } from './dataset-manifest-v2.js';

function connectedClient() {
  const calls = [];
  return {
    calls,
    connectCalls: 0,
    endCalls: 0,
    releaseCalls: 0,
    async connect() { this.connectCalls += 1; throw new Error('Client has already been connected. You cannot reuse a client.'); },
    async end() { this.endCalls += 1; },
    release() { this.releaseCalls += 1; },
    async query(sql) { calls.push(sql); return { rows: [{ ok: 1 }], rowCount: 1 }; }
  };
}

function poolWithClient(client) {
  return {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    connectCalls: 0,
    endCalls: 0,
    async connect() { this.connectCalls += 1; return client; },
    async query() { throw new Error('Pool.query must not be used inside the owned transaction'); },
    async end() { this.endCalls += 1; }
  };
}

test('already-connected external Client is never connected, ended, released, or transaction-owned', async () => {
  const client = connectedClient();
  const result = await withManifestPersistenceConnection(client, connection => connection.query('SELECT external_work'));
  assert.equal(result.rows[0].ok, 1);
  assert.deepEqual(client.calls, ['SELECT external_work']);
  assert.equal(client.connectCalls, 0);
  assert.equal(client.endCalls, 0);
  assert.equal(client.releaseCalls, 0);
});

test('internally acquired PoolClient is connected once, committed, and released without ending caller Pool', async () => {
  const client = connectedClient();
  const pool = poolWithClient(client);
  const result = await withManifestPersistenceConnection(pool, async connection => {
    assert.equal(connection, client);
    await connection.query('SELECT internal_work');
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(pool.connectCalls, 1);
  assert.equal(pool.endCalls, 0);
  assert.equal(client.releaseCalls, 1);
  assert.deepEqual(client.calls, ['BEGIN', 'SELECT internal_work', 'COMMIT']);
});

test('owned PoolClient rolls back and releases after persistence failure while preserving original error', async () => {
  const client = connectedClient();
  const pool = poolWithClient(client);
  const expected = Object.assign(new Error('insert failed'), { code: 'TEST_INSERT_FAILURE' });
  await assert.rejects(
    withManifestPersistenceConnection(pool, async connection => {
      await connection.query('SELECT before_failure');
      throw expected;
    }),
    error => error === expected
  );
  assert.equal(pool.connectCalls, 1);
  assert.equal(pool.endCalls, 0);
  assert.equal(client.releaseCalls, 1);
  assert.deepEqual(client.calls, ['BEGIN', 'SELECT before_failure', 'ROLLBACK']);
});

test('external Client remains usable after successful and failed operations', async () => {
  const client = connectedClient();
  await withManifestPersistenceConnection(client, connection => connection.query('SELECT first'));
  const expected = new Error('external failure');
  await assert.rejects(withManifestPersistenceConnection(client, async () => { throw expected; }), error => error === expected);
  const after = await client.query('SELECT after');
  assert.equal(after.rows[0].ok, 1);
  assert.deepEqual(client.calls, ['SELECT first', 'SELECT after']);
  assert.equal(client.connectCalls, 0);
  assert.equal(client.endCalls, 0);
  assert.equal(client.releaseCalls, 0);
});
