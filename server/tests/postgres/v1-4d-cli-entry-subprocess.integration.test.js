// P2-c（独立复审第二轮）：cli-entry.js底部`if (import.meta.url === ...) { main().catch(...) }`这段
// 真实的"作为OS子进程被直接执行时"的入口/退出码逻辑，此前从未被任何测试真实覆盖过——所有既有测试
// 都是在同一进程内直接调用main()，绕过了该guard、绕过了`process.exitCode`的设置路径。
// 这里用node:child_process真实spawn一个`node cli-entry.js`子进程，验证：
// 1) 失败路径（--resume不带值）：真实非零退出码，stderr包含可诊断的错误码；
// 2) 成功路径：真实非零→零退出码转换，stdout包含启动横幅与validation_run_id，且真实使用隔离测试库
//    （通过子进程环境变量DATABASE_URL=TEST_DATABASE_URL传入，不使用任何生产连接串）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest } from '../../src/validation-replay/dataset-manifest-builder.js';

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY_PATH = path.resolve(__dirname, '../../src/validation-replay/cli-entry.js');

const DAY_MS = 86400000;
const FIFTEEN_MIN_MS = 900000;
const ALGORITHM_VERSION = 'v1.4c-server-po-rule-1';
const RULE_VERSION = 'v1.4c-po-rule-1';
const WEIGHT_VERSION = 'v1.4c-server-weight-1';
const EVALUATION_VERSION = 'v1.4c-outcome-evaluation-1';

function kline(openTime, closeTime, closeStr = '1000.00') {
  return [openTime, '999.00', '2000.00', '500.00', closeStr, '10.5', closeTime, '10500.00', 5, '5.0', '5000.00'];
}
function makeMockAdapter({ pages, serverTimeMs }) {
  let call = 0;
  return {
    serverTime: async () => ({ body: { serverTime: serverTimeMs }, requestId: randomUUID() }),
    spotKlines: async () => { const page = pages[call] || []; call += 1; return { body: page, requestId: randomUUID(), status: 200, headers: {} }; }
  };
}

// P0-4修复联动：integrity-check.js现在要求[from,to)整个范围按interval步长逐位连续覆盖（含边界），
// 见 v1-4d-cli-entry.integration.test.js 同名辅助函数的详细说明。调用方须确保from/to已对齐open_time相位。
async function fillContiguousCoverage(pool, { from, to, replayNowMs, interval = '15m' }) {
  const stepMs = FIFTEEN_MIN_MS;
  const bars = [];
  for (let openTime = from; openTime < to; openTime += stepMs) bars.push(kline(openTime, openTime + stepMs - 1, '1000.00'));
  if (!bars.length) return;
  const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
  await backfillInterval({ pool, adapter, symbol: 'ETHUSDT', interval, startTime: from, endTime: to - stepMs, now: () => replayNowMs });
}

test('子进程真实运行（P2-c）：--resume不带值——真实非零退出码，stderr包含INVALID_RESUME_ID，且不需要任何数据库连接（不传DATABASE_URL也应如此）', { skip }, async () => {
  await assert.rejects(
    execFileAsync('node', [CLI_ENTRY_PATH, '--resume', '--symbol', 'ETHUSDT'], {
      env: { ...process.env, DATABASE_URL: '' },
      timeout: 20000
    }),
    (err) => {
      assert.notEqual(err.code, 0, '真实子进程必须以非零退出码结束');
      assert.match(err.stdout, /HISTORICAL RESEARCH ONLY/, '启动横幅必须已经作为子进程真实stdout的第一行输出');
      assert.match(err.stderr, /INVALID_RESUME_ID/, 'stderr必须包含可诊断的错误码');
      return true;
    }
  );
});

test('子进程真实运行（P2-c）：完整合法新任务参数——真实子进程以0退出码结束，stdout包含validation_run_id与effective_options，真实写入隔离测试库', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const dayStart = Date.UTC(2026, 4, 1, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    const refAdapter = makeMockAdapter({ pages: [[kline(referenceOpenTime, referenceCloseTime, '1000.00')]], serverTimeMs: replayNowMs });
    await backfillInterval({ pool, adapter: refAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: referenceOpenTime, endTime: referenceOpenTime, now: () => replayNowMs });

    const from = referenceCloseTime - DAY_MS + 1; // +1对齐open_time相位（referenceCloseTime本身是close_time相位）
    const to = referenceCloseTime + DAY_MS + 1;
    await fillContiguousCoverage(pool, { from, to, replayNowMs });
    const manifestResult = await buildDatasetManifest({ pool, symbol: 'ETHUSDT', intervals: ['15m'], from, to });
    assert.equal(manifestResult.status, 'SUCCEEDED');
    const datasetVersion = manifestResult.datasetVersion;

    const { stdout, stderr } = await execFileAsync('node', [
      CLI_ENTRY_PATH,
      '--symbol', 'ETHUSDT', '--from', new Date(from).toISOString(), '--to', new Date(to).toISOString(),
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', datasetVersion,
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
    ], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      timeout: 30000
    });

    assert.match(stdout, /HISTORICAL RESEARCH ONLY/);
    assert.match(stdout, /validation_run_id /);
    assert.match(stdout, /effective_options /);
    assert.equal(stderr, '', '成功路径不应有任何stderr输出');

    const match = /validation_run_id ([0-9a-f-]{36})/.exec(stdout);
    assert.ok(match, '必须能从真实子进程stdout中解析出validation_run_id');
    validationRunId = match[1];

    const runRow = (await pool.query('SELECT status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.ok(runRow, '子进程真实写入的validation_runs行必须能从独立的父进程连接中查询到（证明真实COMMIT到了隔离测试库，不是某种mock）');
    assert.equal(runRow.status, 'SUCCEEDED');
  } finally {
    if (validationRunId) {
      await pool.query(`DELETE FROM historical_validation.replay_outcome_events WHERE evaluation_run_id IN (SELECT evaluation_run_id FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1)`, [validationRunId]);
      await pool.query(`DELETE FROM historical_validation.replay_snapshots WHERE generation_run_id IN (SELECT generation_run_id FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1)`, [validationRunId]);
      await pool.query(`DELETE FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1`, [validationRunId]);
      await pool.query(`DELETE FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1`, [validationRunId]);
      await pool.query(`DELETE FROM historical_validation.validation_reports WHERE validation_run_id=$1`, [validationRunId]);
      await pool.query(`DELETE FROM historical_validation.validation_runs WHERE validation_run_id=$1`, [validationRunId]);
    }
    await pool.query(`DELETE FROM feature_records WHERE symbol='ETHUSDT' AND target_bar_close_time>=to_timestamp($1/1000.0) AND target_bar_close_time<to_timestamp($2/1000.0)`, [Date.UTC(2026, 3, 29), Date.UTC(2026, 4, 4)]);
    await pool.query(`DELETE FROM market_bars WHERE instrument='ETHUSDT' AND open_time>=to_timestamp($1/1000.0) AND open_time<to_timestamp($2/1000.0)`, [Date.UTC(2026, 3, 29), Date.UTC(2026, 4, 4)]);
    await pool.end();
  }
});

// P2-h（独立复审第二轮）：R9.1b要求"检查stdout输出"——只在main()内存返回值层面验证plan.executionPlan
// 还不够充分，因为main()真实作为CLI被调用时，使用者读到的是真实进程的stdout文本，不是JS返回值。
// 这里用真实子进程验证--dry-run的stdout确实包含dry_run_execution_plan这一行，且内容可解析、
// 三项要素（节奏点数量/backfill_batch_id范围/purge边界）均存在。
test('子进程真实运行（P2-h/R9.1b）：--dry-run的真实stdout必须包含执行计划（节奏点数量/backfill_batch_id范围/purge边界）', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const dayStart = Date.UTC(2026, 4, 6, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    const refAdapter = makeMockAdapter({ pages: [[kline(referenceOpenTime, referenceCloseTime, '1000.00')]], serverTimeMs: replayNowMs });
    await backfillInterval({ pool, adapter: refAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: referenceOpenTime, endTime: referenceOpenTime, now: () => replayNowMs });

    const from = referenceCloseTime - DAY_MS + 1; // +1对齐open_time相位（referenceCloseTime本身是close_time相位）
    const to = referenceCloseTime + DAY_MS + 1;
    await fillContiguousCoverage(pool, { from, to, replayNowMs });
    const manifestResult = await buildDatasetManifest({ pool, symbol: 'ETHUSDT', intervals: ['15m'], from, to });
    assert.equal(manifestResult.status, 'SUCCEEDED');
    const datasetVersion = manifestResult.datasetVersion;

    const { stdout, stderr } = await execFileAsync('node', [
      CLI_ENTRY_PATH,
      '--symbol', 'ETHUSDT', '--from', new Date(from).toISOString(), '--to', new Date(to).toISOString(),
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', datasetVersion,
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION,
      '--dry-run'
    ], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      timeout: 30000
    });

    assert.equal(stderr, '', '成功路径不应有任何stderr输出');
    const match = /validation_run_id ([0-9a-f-]{36})/.exec(stdout);
    assert.ok(match);
    validationRunId = match[1];

    const planMatch = /dry_run_execution_plan (.+)/.exec(stdout);
    assert.ok(planMatch, 'stdout必须真实包含dry_run_execution_plan这一行（R9.1b冻结要求）');
    const executionPlan = JSON.parse(planMatch[1]);
    assert.ok(executionPlan.rhythmPointCount > 0, '必须包含预计推进的historical_as_of_time节奏点数量');
    assert.ok(Array.isArray(executionPlan.backfillBatchIds), '必须包含预计涉及的backfill_batch_id范围');
    assert.ok('trainEnd' in executionPlan.purgeBoundary && 'validationEnd' in executionPlan.purgeBoundary, '必须包含预计的purge边界');

    for (const table of ['replay_snapshots', 'replay_generation_runs', 'replay_outcome_events', 'replay_evaluation_runs', 'validation_reports']) {
      const n = (await pool.query(`SELECT count(*)::int AS n FROM historical_validation.${table}`)).rows[0].n;
      assert.equal(n, 0, `--dry-run模式下${table}必须零写入`);
    }
    const runRow = (await pool.query('SELECT dry_run, status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(runRow.dry_run, true);
  } finally {
    if (validationRunId) {
      await pool.query(`DELETE FROM historical_validation.validation_runs WHERE validation_run_id=$1`, [validationRunId]);
    }
    await pool.query(`DELETE FROM feature_records WHERE symbol='ETHUSDT' AND target_bar_close_time>=to_timestamp($1/1000.0) AND target_bar_close_time<to_timestamp($2/1000.0)`, [Date.UTC(2026, 4, 4), Date.UTC(2026, 4, 9)]);
    await pool.query(`DELETE FROM market_bars WHERE instrument='ETHUSDT' AND open_time>=to_timestamp($1/1000.0) AND open_time<to_timestamp($2/1000.0)`, [Date.UTC(2026, 4, 4), Date.UTC(2026, 4, 9)]);
    await pool.end();
  }
});
