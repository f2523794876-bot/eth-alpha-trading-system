import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { persistGovernedManifest } from './dataset-manifest-builder.js';

const persistenceInput = Object.freeze({
  datasetVersion: `v1.4d-sha256-${'a'.repeat(64)}`,
  contentObject: {
    manifestSchemaVersion: 'v1.4d-dataset-manifest-1',
    manifestHashAlgorithmVersion: 'sha256-canonical-json-v1',
    sourceFormalSemantics: 'market_bars:formal:spot',
    researchAvailabilityRuleVersion: 'v1.4d-research-availability-1',
    integrityCheckResult: { gapCount: 0, duplicateCount: 0, outOfOrderCount: 0 }
  },
  symbol: 'ETHUSDT',
  sortedIntervals: ['15m'],
  from: 0,
  to: 900000,
  fixedAsOf: 899999,
  backfillBatchIds: [],
  recordCount: 1,
  perIntervalRecordCount: { '15m': 1 },
  manifestMembers: [],
  logicalWindowHash: 'b'.repeat(64)
});

function successfulQueryLog() {
  const statements = [];
  return {
    statements,
    async query(sql) {
      statements.push(sql);
      if (sql.includes('SELECT dataset_version')) return { rows: [] };
      if (sql.includes('INSERT INTO')) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  };
}

test('persistGovernedManifest：传入Pool时由函数管理本地事务与release', async () => {
  const client = successfulQueryLog();
  let connectCount = 0;
  let releaseCount = 0;
  client.release = () => { releaseCount += 1; };
  const pool = Object.create(Pool.prototype);
  pool.connect = async () => { connectCount += 1; return client; };

  assert.equal(await persistGovernedManifest(pool, persistenceInput), true);
  assert.equal(connectCount, 1);
  assert.equal(releaseCount, 1);
  assert.deepEqual(client.statements.filter(sql => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)), ['BEGIN', 'COMMIT']);
});

test('persistGovernedManifest：已连接PoolClient直接执行，不二次connect、不release调用方连接', async () => {
  const client = successfulQueryLog();
  let connectCount = 0;
  let releaseCount = 0;
  client.connect = async () => { connectCount += 1; throw new Error('must not reconnect'); };
  client.release = () => { releaseCount += 1; };

  assert.equal(await persistGovernedManifest(client, persistenceInput), true);
  assert.equal(connectCount, 0);
  assert.equal(releaseCount, 0);
  assert.deepEqual(client.statements.filter(sql => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)), []);
});

test('persistGovernedManifest：调用方事务中的query executor不被擅自提交或回滚', async () => {
  const executor = successfulQueryLog();
  executor.statements.push('CALLER_BEGIN');

  assert.equal(await persistGovernedManifest(executor, persistenceInput), true);
  assert.equal(executor.statements.includes('BEGIN'), false);
  assert.equal(executor.statements.includes('COMMIT'), false);
  assert.equal(executor.statements.includes('ROLLBACK'), false);
  assert.equal(executor.statements[0], 'CALLER_BEGIN');
});

test('persistGovernedManifest：查询失败时仅Pool路径回滚并release，调用方executor责任保持不变', async () => {
  const failure = Object.assign(new Error('query failed'), { code: 'QUERY_FAILED' });
  const poolClient = {
    statements: [],
    releaseCount: 0,
    async query(sql) {
      this.statements.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) throw failure;
      return { rows: [], rowCount: 0 };
    },
    release() { this.releaseCount += 1; }
  };
  const pool = Object.create(Pool.prototype);
  pool.connect = async () => poolClient;

  await assert.rejects(persistGovernedManifest(pool, persistenceInput), failure);
  assert.deepEqual(poolClient.statements, ['BEGIN', 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', 'ROLLBACK']);
  assert.equal(poolClient.releaseCount, 1);

  let releaseCount = 0;
  const callerExecutor = {
    statements: [],
    async query(sql) { this.statements.push(sql); throw failure; },
    async connect() { throw new Error('must not reconnect'); },
    release() { releaseCount += 1; }
  };
  await assert.rejects(persistGovernedManifest(callerExecutor, persistenceInput), failure);
  assert.deepEqual(callerExecutor.statements, ['SELECT pg_advisory_xact_lock(hashtextextended($1,0))']);
  assert.equal(releaseCount, 0);
});
