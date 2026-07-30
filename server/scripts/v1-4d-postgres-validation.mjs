import { appendFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate.js';

const EXPECTED_DATABASE = 'eth_alpha_v14d_test';
const BUSINESS_TABLES = Object.freeze([
  'replay_snapshots',
  'replay_generation_runs',
  'replay_outcome_events',
  'replay_evaluation_runs',
  'validation_reports'
]);
const TARGETED_FILES = Object.freeze([
  'tests/postgres/v1-4d-dry-run-full-compute.integration.test.js',
  'tests/postgres/v1-4d-replay-generator-evaluator.integration.test.js'
]);

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required');
const parsedUrl = new URL(testDatabaseUrl);
const configuredDatabase = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
if (configuredDatabase !== EXPECTED_DATABASE) {
  throw new Error(`TEST_DATABASE_URL must target ${EXPECTED_DATABASE}, received ${configuredDatabase}`);
}

const childEnv = Object.freeze({
  PATH: process.env.PATH,
  TEST_DATABASE_URL: testDatabaseUrl,
  CI: 'true',
  NODE_ENV: 'test'
});
const results = {
  database: configuredDatabase,
  migrations: [],
  targetedRuns: [],
  suites: []
};

function parseTestStats(output, label) {
  const readLast = key => {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    if (!matches.length) throw new Error(`${label}: missing TAP statistic ${key}`);
    return Number(matches.at(-1)[1]);
  };
  return {
    tests: readLast('tests'),
    pass: readLast('pass'),
    fail: readLast('fail'),
    skipped: readLast('skipped')
  };
}

async function runTestCommand(label, command, args, extraEnv = {}) {
  console.log(`\n=== ${label} ===`);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...childEnv, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      (stream === child.stdout ? process.stdout : process.stderr).write(text);
    });
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const stats = parseTestStats(output, label);
  if (exitCode !== 0 || stats.fail !== 0 || stats.skipped !== 0 || stats.pass !== stats.tests) {
    throw Object.assign(
      new Error(`${label} failed strict gate: exit=${exitCode}, tests=${stats.tests}, pass=${stats.pass}, fail=${stats.fail}, skipped=${stats.skipped}`),
      { stats, exitCode }
    );
  }
  console.log(`${label}: tests=${stats.tests}, pass=${stats.pass}, fail=${stats.fail}, skipped=${stats.skipped}`);
  return stats;
}

async function countBusinessTables(pool) {
  const counts = {};
  for (const table of BUSINESS_TABLES) {
    const result = await pool.query(`SELECT count(*)::int AS count FROM historical_validation.${table}`);
    counts[`historical_validation.${table}`] = result.rows[0].count;
  }
  return counts;
}

function assertCountsUnchanged(before, after, label) {
  for (const table of Object.keys(before)) {
    if (before[table] !== after[table]) {
      throw new Error(`${label}: ${table} changed from ${before[table]} to ${after[table]}`);
    }
  }
}

async function publishSummary(status, error = null) {
  const lines = [
    '# V1.4D P0-2/P1-1 PostgreSQL 16 validation',
    '',
    `- Status: **${status}**`,
    `- Database: \`${results.database}\``,
    `- Migrations: ${results.migrations.join(', ') || 'not completed'}`,
    ''
  ];
  for (const run of results.targetedRuns) {
    lines.push(
      `## Targeted PostgreSQL run ${run.run}`,
      '',
      `- Tests/pass/fail/skip: ${run.stats.tests}/${run.stats.pass}/${run.stats.fail}/${run.stats.skipped}`,
      `- Before: \`${JSON.stringify(run.before)}\``,
      `- After: \`${JSON.stringify(run.after)}\``,
      '- Five-table zero-write check: PASS',
      ''
    );
  }
  for (const suite of results.suites) {
    lines.push(`- ${suite.label}: ${suite.stats.tests}/${suite.stats.pass}/${suite.stats.fail}/${suite.stats.skipped}`);
  }
  if (error) lines.push('', `- Error: \`${error.message}\``);
  await writeFile('v1-4d-postgres-validation-results.json', `${JSON.stringify({ status, ...results, error: error?.message ?? null }, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
}

const pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
try {
  const databaseResult = await pool.query('SELECT current_database() AS database');
  const actualDatabase = databaseResult.rows[0]?.database;
  if (actualDatabase !== EXPECTED_DATABASE) {
    throw new Error(`current_database() must be ${EXPECTED_DATABASE}, received ${actualDatabase}`);
  }
  console.log(`current_database()=${actualDatabase}`);

  await runMigrations(pool, 'up');
  const migrationResult = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  results.migrations = migrationResult.rows.map(row => row.version);
  const expectedMigrations = ['001', '002', '003', '004', '005'];
  if (JSON.stringify(results.migrations) !== JSON.stringify(expectedMigrations)) {
    throw new Error(`migration set mismatch: ${JSON.stringify(results.migrations)}`);
  }
  console.log(`migrations=${results.migrations.join(',')}`);

  for (let run = 1; run <= 2; run += 1) {
    const before = await countBusinessTables(pool);
    const stats = await runTestCommand(
      `targeted PostgreSQL run ${run}`,
      process.execPath,
      ['--test', '--test-reporter=tap', ...TARGETED_FILES]
    );
    const after = await countBusinessTables(pool);
    results.targetedRuns.push({ run, stats, before, after });
    assertCountsUnchanged(before, after, `targeted PostgreSQL run ${run}`);
    console.log(`targeted PostgreSQL run ${run} counts before=${JSON.stringify(before)}`);
    console.log(`targeted PostgreSQL run ${run} counts after=${JSON.stringify(after)}`);
  }

  const postgresFiles = (await readdir('tests/postgres'))
    .filter(file => /^v1-4d-.*\.integration\.test\.js$/.test(file))
    .sort()
    .map(file => `tests/postgres/${file}`);
  const postgresStats = await runTestCommand(
    'all V1.4D PostgreSQL integration tests',
    process.execPath,
    ['--test', '--test-reporter=tap', ...postgresFiles]
  );
  results.suites.push({ label: 'all V1.4D PostgreSQL integration tests', stats: postgresStats });

  const validationReplayFiles = (await readdir('src/validation-replay'))
    .filter(file => file.endsWith('.test.js'))
    .sort()
    .map(file => `src/validation-replay/${file}`);
  const validationStats = await runTestCommand(
    'validation-replay unit tests',
    process.execPath,
    ['--test', '--test-reporter=tap', ...validationReplayFiles]
  );
  results.suites.push({ label: 'validation-replay unit tests', stats: validationStats });

  const serverStats = await runTestCommand(
    'server npm test',
    'npm',
    ['test'],
    { NODE_OPTIONS: '--test-reporter=tap' }
  );
  results.suites.push({ label: 'server npm test', stats: serverStats });

  await publishSummary('PASS');
} catch (error) {
  await publishSummary('FAIL', error);
  throw error;
} finally {
  await pool.end();
}
