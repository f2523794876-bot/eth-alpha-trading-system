// R7.1/R7.1a/R7.2：historical_validation schema 与生产 public schema 物理隔离的系统目录级自动化证明。
// 此前的验收（PR #16）只用public schema 31张表数量测试作为替代证据，未对historical_validation
// 自身的8张表数量/表名集合/建表顺序/外键缺失做过任何专属的自动化断言（人工代码审查 !=自动化测试）。
// 本文件直接查询information_schema/pg_catalog系统目录，不信任迁移SQL文件的字符串内容本身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(TEST_DATABASE_URL);

// V1_4D_HISTORICAL_REPLAY_SPEC.md §三.0冻结的建表顺序（先被引用者先建）。
const EXPECTED_TABLES_IN_BUILD_ORDER = Object.freeze([
  'dataset_manifests', 'validation_runs', 'backfill_batches', 'replay_generation_runs',
  'replay_evaluation_runs', 'replay_snapshots', 'replay_outcome_events', 'validation_reports'
]);

// V1_4D_HISTORICAL_REPLAY_SPEC.md §三所列，禁止historical_validation任何表通过外键引用的四张生产
// forecast_*表，以及生产collector_leases。
const FORBIDDEN_REFERENCED_PUBLIC_TABLES = Object.freeze([
  'forecast_snapshots', 'forecast_outcome_events', 'forecast_generation_runs', 'forecast_evaluation_runs', 'collector_leases'
]);
const PUBLIC_FORECAST_TABLES = Object.freeze([
  'forecast_snapshots', 'forecast_outcome_events', 'forecast_generation_runs', 'forecast_evaluation_runs'
]);

async function withPool(fn) {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  try { await fn(pool); } finally { await pool.end(); }
}

test('R7.1：historical_validation schema精确包含规范要求的8张表，表名集合完全一致（不只是数量）', { skip }, async () => {
  await withPool(async (pool) => {
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='historical_validation' ORDER BY table_name`
    );
    const actualNames = result.rows.map(r => r.table_name).sort();
    const expectedNames = [...EXPECTED_TABLES_IN_BUILD_ORDER].sort();
    assert.deepEqual(actualNames, expectedNames, 'historical_validation schema下的表名集合必须与规范冻结的8张表完全一致，不多不少');
    assert.equal(actualNames.length, 8);
  });
});

test('R7.1：historical_validation的全部8张表均不在public schema下（无同名表泄漏/重复定义）', { skip }, async () => {
  await withPool(async (pool) => {
    for (const table of EXPECTED_TABLES_IN_BUILD_ORDER) {
      const result = await pool.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
        [table]
      );
      assert.equal(result.rows[0].n, 0, `${table} 不得在public schema下同时存在同名表`);
    }
  });
});

test('R7.1a：migration 005建表顺序（按pg_class.oid反映的真实创建先后）与冻结规范§三.0一致', { skip }, async () => {
  await withPool(async (pool) => {
    // pg_class.oid在PostgreSQL中随对象创建单调递增分配，可直接作为"真实创建顺序"的系统级证据，
    // 不依赖迁移SQL文件本身的文本顺序（那只是"声明顺序"，此处要的是"数据库实际执行DDL的顺序"）。
    const result = await pool.query(
      `SELECT c.relname AS table_name FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='historical_validation' AND c.relkind='r'
       ORDER BY c.oid ASC`
    );
    const actualOrder = result.rows.map(r => r.table_name);
    assert.deepEqual(actualOrder, [...EXPECTED_TABLES_IN_BUILD_ORDER], '真实DDL执行顺序必须与§三.0冻结顺序（先被引用者先建）一致，否则外键定义时被引用表可能尚未存在');
  });
});

test('R7.2：historical_validation全部8张表的外键定义中，无任何一条指向public.forecast_*/collector_leases（精确断言外键数量为0）', { skip }, async () => {
  await withPool(async (pool) => {
    const result = await pool.query(
      `SELECT con.conname, src.relname AS from_table, dst.relname AS to_table
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_namespace srcns ON srcns.oid = src.relnamespace
       JOIN pg_class dst ON dst.oid = con.confrelid
       JOIN pg_namespace dstns ON dstns.oid = dst.relnamespace
       WHERE con.contype = 'f' AND srcns.nspname = 'historical_validation' AND dstns.nspname = 'public'
         AND dst.relname = ANY($1::text[])`,
      [FORBIDDEN_REFERENCED_PUBLIC_TABLES]
    );
    assert.deepEqual(result.rows, [], 'historical_validation不得有任何外键指向生产forecast_*表或collector_leases');
    assert.equal(result.rowCount, 0);
  });
});

test('R7.2：public schema下四张forecast_*表的外键定义中，无任何一条指向historical_validation（精确断言外键数量为0）', { skip }, async () => {
  await withPool(async (pool) => {
    const result = await pool.query(
      `SELECT con.conname, src.relname AS from_table, dst.relname AS to_table
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_namespace srcns ON srcns.oid = src.relnamespace
       JOIN pg_class dst ON dst.oid = con.confrelid
       JOIN pg_namespace dstns ON dstns.oid = dst.relnamespace
       WHERE con.contype = 'f' AND srcns.nspname = 'public' AND src.relname = ANY($1::text[])
         AND dstns.nspname = 'historical_validation'`,
      [PUBLIC_FORECAST_TABLES]
    );
    assert.deepEqual(result.rows, [], '生产forecast_*表不得有任何外键指向historical_validation');
    assert.equal(result.rowCount, 0);
  });
});

test('R7.2：historical_validation的全部外键中，被引用表(confrelid)必须全部落在historical_validation自身schema内（结构性隔离的正面确认，不只是负面排除清单）', { skip }, async () => {
  await withPool(async (pool) => {
    const result = await pool.query(
      `SELECT con.conname, src.relname AS from_table, dstns.nspname AS to_schema, dst.relname AS to_table
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_namespace srcns ON srcns.oid = src.relnamespace
       JOIN pg_class dst ON dst.oid = con.confrelid
       JOIN pg_namespace dstns ON dstns.oid = dst.relnamespace
       WHERE con.contype = 'f' AND srcns.nspname = 'historical_validation'`
    );
    assert.ok(result.rowCount > 0, '前提确认：historical_validation内部确实存在外键（如replay_snapshots→dataset_manifests），否则本测试没有验证到任何真实约束');
    for (const row of result.rows) {
      assert.equal(row.to_schema, 'historical_validation', `外键${row.conname}（${row.from_table}→${row.to_schema}.${row.to_table}）必须指向historical_validation自身，不得指向任何其他schema`);
    }
  });
});
