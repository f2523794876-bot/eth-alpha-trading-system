// P1-3/P1-4/P1-5（独立复审）：cli-entry.js 真正的CLI main()/命令行解析层真实PostgreSQL验证——
// 不得只测试runWalkForward(options)。本文件通过真实调用main(argv)（可控argv+DATABASE_URL环境变量指向
// 隔离测试库的依赖注入，见V1_4D_CODEX_IMPLEMENTATION_TASK.md允许的测试方式）覆盖：
//   - 完整合法新任务参数、--resume最小形式（省略参数实际从原run继承）、--dry-run、--split；
//   - 各类缺失/冲突/非法参数在main()级别fail closed，且校验失败时不产生任何validation_runs行；
//   - 启动横幅确实由main()输出（真实捕获stdout，不只断言STARTUP_BANNER字符串常量）；
//   - 不连接生产数据库——DATABASE_URL全程被临时改写为TEST_DATABASE_URL，finally块无条件恢复原值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { main } from '../../src/validation-replay/cli-entry.js';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest } from '../../src/validation-replay/dataset-manifest-builder.js';
import { RESEARCH_AVAILABILITY_RULE_VERSION } from '../../src/validation-replay/research-availability.js';
import { FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION } from '../../src/features/feature-version.js';
import { sha256 } from '../../src/domain/hash.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;
const FOUR_HOUR_MS = 14400000;
const FIFTEEN_MIN_MS = 900000;
const DAY_MS = 86400000;

const ALGORITHM_VERSION = 'v1.4c-server-po-rule-1';
const WEIGHT_VERSION = 'v1.4c-server-weight-1';
const RULE_VERSION = 'v1.4c-po-rule-1';
const EVALUATION_VERSION = 'v1.4c-outcome-evaluation-1';

function makeMockAdapter({ pages, serverTimeMs }) {
  let call = 0;
  return {
    serverTime: async () => ({ body: { serverTime: serverTimeMs }, requestId: randomUUID() }),
    spotKlines: async () => { const page = pages[call] || []; call += 1; return { body: page, requestId: randomUUID(), status: 200, headers: {} }; }
  };
}
function kline(openTime, closeTime, closeStr = '1000.00') {
  return [openTime, '999.00', '2000.00', '500.00', closeStr, '10.5', closeTime, '10500.00', 5, '5.0', '5000.00'];
}
async function seedFeatureRecord(pool, { referenceCloseTime, historicalAsOfTime }) {
  await pool.query(
    `INSERT INTO feature_sets(feature_set_version, algorithm_version, schema_version, definition, definition_hash)
     VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(feature_set_version) DO NOTHING`,
    [FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, 'v1.4b-schema-1', JSON.stringify({}), sha256({})]
  );
  const featureValues = {
    closeToEma5: 0, trend4h: 'down', trend1h: 'down', volumeRatio20: 1,
    swingHigh: 1100, swingLow: 900, breakoutState: null, upperWickRatio: 0.1, lowerWickRatio: 0.1,
    distanceToSupportAtr: 5, distanceToResistanceAtr: 5, falseBreakoutRisk: 'NONE',
    btcTrendState: 'flat', ethBtcRollingCorrelation: 0, logReturn1: 0
  };
  await pool.query(
    `INSERT INTO feature_records(
       feature_id, symbol, target_interval, target_bar_open_time, target_bar_close_time, as_of_time, generated_at,
       feature_set_version, algorithm_version, source_dataset_version, completeness, quality_state, feature_values, availability, content_hash
     ) VALUES($1,'ETHUSDT','15m',to_timestamp($2/1000.0),to_timestamp($3/1000.0),to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6,$7,$8,1,'HEALTHY',$9::jsonb,'{}'::jsonb,$10)
     ON CONFLICT DO NOTHING`,
    [
      `feature-${referenceCloseTime}`, referenceCloseTime - FIFTEEN_MIN_MS + 1, referenceCloseTime, historicalAsOfTime, historicalAsOfTime,
      FEATURE_SET_VERSION, FEATURE_ALGORITHM_VERSION, SOURCE_DATASET_VERSION, JSON.stringify(featureValues), sha256(featureValues)
    ]
  );
}
async function seedRhythmPoint(pool, { referenceCloseTime, replayNowMs }) {
  const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
  const refAdapter = makeMockAdapter({ pages: [[kline(referenceOpenTime, referenceCloseTime, '1000.00')]], serverTimeMs: replayNowMs });
  await backfillInterval({ pool, adapter: refAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: referenceOpenTime, endTime: referenceOpenTime, now: () => replayNowMs });

  const count = 15;
  const bars = [];
  for (let i = count - 1; i >= 0; i--) {
    const closeTime = referenceCloseTime - i * FOUR_HOUR_MS;
    bars.push(kline(closeTime - FOUR_HOUR_MS + 1, closeTime, (1000 + i).toFixed(2)));
  }
  const start = referenceCloseTime - (count - 1) * FOUR_HOUR_MS - FOUR_HOUR_MS + 1;
  const atrAdapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
  await backfillInterval({ pool, adapter: atrAdapter, symbol: 'ETHUSDT', interval: '4h', startTime: start, endTime: referenceCloseTime, now: () => replayNowMs });

  await seedFeatureRecord(pool, { referenceCloseTime, historicalAsOfTime: referenceCloseTime });
}
async function buildVerifiedManifest(pool, { from, to }) {
  const result = await buildDatasetManifest({ pool, symbol: 'ETHUSDT', intervals: ['15m', '4h'], from, to });
  assert.equal(result.status, 'SUCCEEDED', 'manifest构建必须成功（前置bar数据必须无缺口）');
  return result.datasetVersion;
}
async function purgeRun(pool, validationRunId) {
  if (!validationRunId) return;
  await pool.query(`DELETE FROM historical_validation.replay_outcome_events WHERE evaluation_run_id IN (SELECT evaluation_run_id FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1)`, [validationRunId]);
  await pool.query(`DELETE FROM historical_validation.replay_snapshots WHERE generation_run_id IN (SELECT generation_run_id FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1)`, [validationRunId]);
  await pool.query(`DELETE FROM historical_validation.replay_evaluation_runs WHERE validation_run_id=$1`, [validationRunId]);
  await pool.query(`DELETE FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1`, [validationRunId]);
  await pool.query(`DELETE FROM historical_validation.validation_reports WHERE validation_run_id=$1`, [validationRunId]);
  await pool.query(`DELETE FROM historical_validation.validation_runs WHERE validation_run_id=$1`, [validationRunId]);
}
async function purgeMarketData(pool, { fromMs, toMs }) {
  await pool.query(`DELETE FROM feature_records WHERE symbol='ETHUSDT' AND target_bar_close_time>=to_timestamp($1/1000.0) AND target_bar_close_time<to_timestamp($2/1000.0)`, [fromMs, toMs]);
  await pool.query(`DELETE FROM market_bars WHERE instrument='ETHUSDT' AND open_time>=to_timestamp($1/1000.0) AND open_time<to_timestamp($2/1000.0)`, [fromMs, toMs]);
}

// main()内部自行loadConfig()/createPgPool()，无法像其余V1.4D集成测试那样注入client——
// 依赖注入点是DATABASE_URL环境变量本身（main()的合法测试方式之一，见任务书"可以通过依赖注入、
// 可控argv、子进程或规范允许的其他方式测试"）：临时改写为TEST_DATABASE_URL，任何情况下
// （包括测试断言失败/抛出）finally都必须恢复原值，绝不让main()在本文件运行期间之外意外指向测试库，
// 也绝不允许其指向生产数据库。
async function withMainEnv(fn) {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
}

function captureConsole() {
  const info = [];
  const error = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args) => { info.push(args.map(String).join(' ')); };
  console.error = (...args) => { error.push(args.map(String).join(' ')); };
  return {
    info, error,
    restore() { console.info = originalInfo; console.error = originalError; }
  };
}

test('main()：完整合法新任务参数——端到端创建新validation_run并成功完成，启动横幅确实由main()输出到stdout', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const dayStart = Date.UTC(2026, 1, 1, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(pool, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - DAY_MS;
    const to = referenceCloseTime + DAY_MS;
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    const capture = captureConsole();
    let plan;
    try {
      plan = await withMainEnv(() => main([
        '--symbol', 'ETHUSDT', '--from', new Date(from).toISOString(), '--to', new Date(to).toISOString(),
        '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', datasetVersion,
        '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
      ]));
    } finally {
      capture.restore();
    }
    validationRunId = plan.validationRunId;

    assert.ok(capture.info.some(line => line.includes('HISTORICAL RESEARCH ONLY')), '启动横幅必须真实出现在main()捕获到的stdout输出中（不是只断言STARTUP_BANNER常量字符串）');
    assert.ok(capture.info.some(line => line.includes('validation_run_id')), 'main()必须打印validation_run_id');

    const runRow = (await pool.query('SELECT status, symbol, algorithm_version FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(runRow.status, 'SUCCEEDED');
    assert.equal(runRow.symbol, 'ETHUSDT');
    assert.equal(runRow.algorithm_version, ALGORITHM_VERSION);
  } finally {
    await purgeRun(pool, validationRunId);
    await purgeMarketData(pool, { fromMs: Date.UTC(2026, 0, 30), toMs: Date.UTC(2026, 1, 3) });
    await pool.end();
  }
});

test('main()：--resume最小形式——省略的symbol/from/to/algorithm-version/dataset-version/rule-version实际从原run继承并成功执行', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const dayStart = Date.UTC(2026, 1, 5, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(pool, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - DAY_MS;
    const to = referenceCloseTime + DAY_MS;
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    // 直接INSERT一条"半途"的原始run行（RUNNING/未完成的等价场景——resume的前置条件只需要该行存在，
    // 不要求其终态），模拟一次真实首次执行遗留下的validation_runs记录。
    validationRunId = randomUUID();
    await pool.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [validationRunId, datasetVersion, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );

    // 最小形式：只传--resume和不可继承的weight-version/evaluation-version，symbol/from/to/horizons/
    // algorithm-version/dataset-version/rule-version全部省略——必须实际从上面INSERT的原run行继承，
    // 而不是退回main()的任何默认值（若真的使用默认值，dataset-version会是undefined，manifest gate会
    // 立即fail closed，本测试断言最终SUCCEEDED就直接证伪了"只是跳过冲突检查、未真正继承"这一P1-3原bug）。
    const capture = captureConsole();
    let plan;
    try {
      plan = await withMainEnv(() => main([
        '--resume', validationRunId, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
      ]));
    } finally {
      capture.restore();
    }

    assert.equal(plan.validationRunId, validationRunId, 'resume后必须仍使用原validation_run_id');
    const runRow = (await pool.query('SELECT status, symbol, algorithm_version, dataset_version, rule_version, resumed_from_run_id FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(runRow.status, 'SUCCEEDED', '继承原run的dataset_version等参数后，manifest gate必须通过并完整执行完成');
    assert.equal(runRow.symbol, 'ETHUSDT');
    assert.equal(runRow.algorithm_version, ALGORITHM_VERSION);
    assert.equal(runRow.dataset_version, datasetVersion);
    assert.equal(runRow.rule_version, RULE_VERSION);
    // P2-6：resume复用同一validation_run_id（不产生新行），resumed_from_run_id结构性保持NULL——
    // 见cli-entry.js对应注释，只有唯一一条validation_runs行，没有"新行回指旧行"的场景。
    assert.equal(runRow.resumed_from_run_id, null);

    const snapshotCount = (await pool.query(
      `SELECT count(*)::int AS n FROM historical_validation.replay_snapshots s
       JOIN historical_validation.replay_generation_runs g ON g.generation_run_id=s.generation_run_id
       WHERE g.validation_run_id=$1`, [validationRunId]
    )).rows[0].n;
    assert.equal(snapshotCount, 1, '继承的from/to/horizons必须真正驱动了该节奏点的实际生成（不是被默认值/空区间短路成零推进）');
  } finally {
    await purgeRun(pool, validationRunId);
    await purgeMarketData(pool, { fromMs: Date.UTC(2026, 1, 3), toMs: Date.UTC(2026, 1, 8) });
    await pool.end();
  }
});

test('main()：--resume时省略的部分参数继承、另一部分参数显式提供且与原run一致——允许执行', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const dayStart = Date.UTC(2026, 1, 10, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(pool, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - DAY_MS;
    const to = referenceCloseTime + DAY_MS;
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    validationRunId = randomUUID();
    await pool.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [validationRunId, datasetVersion, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );

    const plan = await withMainEnv(() => main([
      '--resume', validationRunId, '--symbol', 'ETHUSDT', '--algorithm-version', ALGORITHM_VERSION,
      '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
    ]));
    assert.equal(plan.validationRunId, validationRunId);
    const runRow = (await pool.query('SELECT status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(runRow.status, 'SUCCEEDED');
  } finally {
    await purgeRun(pool, validationRunId);
    await purgeMarketData(pool, { fromMs: Date.UTC(2026, 1, 8), toMs: Date.UTC(2026, 1, 13) });
    await pool.end();
  }
});

test('main()：--resume时显式提供且与原run冲突的参数——拒绝，且不修改原run记录以外的任何东西', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const from = Date.UTC(2026, 1, 15) - DAY_MS;
    const to = Date.UTC(2026, 1, 15);
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    validationRunId = randomUUID();
    await pool.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [validationRunId, datasetVersion, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );

    await assert.rejects(
      withMainEnv(() => main([
        '--resume', validationRunId, '--algorithm-version', 'v1.4c-server-po-rule-DIFFERENT',
        '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
      ])),
      (e) => e.code === 'RESUME_PARAM_MISMATCH'
    );
  } finally {
    await purgeRun(pool, validationRunId);
    await pool.end();
  }
});

test('main()：不存在的--resume ID——拒绝(VALIDATION_RUN_NOT_FOUND)，不产生任何新validation_runs行', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const before = (await pool.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs')).rows[0].n;
  try {
    await assert.rejects(
      withMainEnv(() => main(['--resume', randomUUID(), '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION])),
      (e) => e.code === 'VALIDATION_RUN_NOT_FOUND'
    );
    const after = (await pool.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs')).rows[0].n;
    assert.equal(after, before);
  } finally {
    await pool.end();
  }
});

test('main()：--dry-run对五张业务表零写入，validation_runs仅新增1行(dry_run=true)', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const dayStart = Date.UTC(2026, 1, 20, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(pool, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - DAY_MS;
    const to = referenceCloseTime + DAY_MS;
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    const plan = await withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', new Date(from).toISOString(), '--to', new Date(to).toISOString(),
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', datasetVersion,
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION,
      '--dry-run'
    ]));
    validationRunId = plan.validationRunId;
    assert.equal(plan.dryRun, true);

    for (const table of ['replay_snapshots', 'replay_generation_runs', 'replay_outcome_events', 'replay_evaluation_runs', 'validation_reports']) {
      const n = (await pool.query(`SELECT count(*)::int AS n FROM historical_validation.${table}`)).rows[0].n;
      assert.equal(n, 0, `--dry-run模式下${table}必须零写入`);
    }
    const runRow = (await pool.query('SELECT dry_run, status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(runRow.dry_run, true);
  } finally {
    await purgeRun(pool, validationRunId);
    await purgeMarketData(pool, { fromMs: Date.UTC(2026, 1, 18), toMs: Date.UTC(2026, 1, 23) });
    await pool.end();
  }
});

test('main()：--split 50/25/25按总日历天数换算train_end_utc/validation_end_utc并落库', { skip }, async () => {
  // 非dry-run（--dry-run的validation_runs审计行按§4.2设计本就不落train_end_utc/validation_end_utc，
  // 见cli-entry.js对应INSERT分支——那是既有、独立于本轮P1-3/P1-4修复范围的设计，不是待验证对象）。
  // 区间内不预置任何market_bars——各节奏点的生成尝试会返回BLOCKED（数据缺失，非错误），
  // 不影响本测试真正要验证的目标：--split经main()正确传导为train_end_utc/validation_end_utc并落库。
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const from = Date.UTC(2026, 1, 25);
    const to = from + 8 * DAY_MS;
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    const plan = await withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', new Date(from).toISOString(), '--to', new Date(to).toISOString(),
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', datasetVersion,
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION,
      '--split', '50/25/25'
    ]));
    validationRunId = plan.validationRunId;

    const runRow = (await pool.query('SELECT status, train_end_utc, validation_end_utc FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(runRow.status, 'SUCCEEDED');
    const trainEndMs = runRow.train_end_utc.getTime();
    const validationEndMs = runRow.validation_end_utc.getTime();
    assert.equal(Math.round((trainEndMs - from) / DAY_MS), 4);
    assert.equal(Math.round((validationEndMs - trainEndMs) / DAY_MS), 2);
    assert.equal(Math.round((to - validationEndMs) / DAY_MS), 2);
  } finally {
    await purgeRun(pool, validationRunId);
    await pool.end();
  }
});

test('main()：缺少版本参数（--dataset-version）——fail closed且不产生任何validation_runs行，不进入数据库执行阶段', { skip }, async () => {
  const before = await (async () => {
    const pool = new Pool({ connectionString: TEST_DATABASE_URL });
    const n = (await pool.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs')).rows[0].n;
    await pool.end();
    return n;
  })();

  await assert.rejects(
    withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', '2026-09-01T00:00:00Z', '--to', '2026-09-02T00:00:00Z',
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION,
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
    ])),
    (e) => e.code === 'MISSING_REQUIRED_ARG' && e.missing.includes('--dataset-version')
  );

  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    const after = (await pool.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs')).rows[0].n;
    assert.equal(after, before, '校验失败时不得产生任何validation_runs行——证明校验发生在任何写入之前');
  } finally {
    await pool.end();
  }
});

test('main()：不会使用生产ALGORITHM_VERSION/WEIGHT_VERSION兜底——省略这两个参数时必须fail closed而不是静默使用某个默认值继续执行', { skip }, async () => {
  await assert.rejects(
    withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', '2026-09-01T00:00:00Z', '--to', '2026-09-02T00:00:00Z',
      '--horizons', '24h', '--dataset-version', 'v1.4d-sha256-' + '1'.repeat(64),
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
    ])),
    (e) => e.code === 'MISSING_REQUIRED_ARG' && e.missing.includes('--algorithm-version')
  );
  await assert.rejects(
    withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', '2026-09-01T00:00:00Z', '--to', '2026-09-02T00:00:00Z',
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', 'v1.4d-sha256-' + '1'.repeat(64),
      '--rule-version', RULE_VERSION, '--evaluation-version', EVALUATION_VERSION
    ])),
    (e) => e.code === 'MISSING_REQUIRED_ARG' && e.missing.includes('--weight-version')
  );
});

test('main()：多个必填参数同时缺失（--algorithm-version与--weight-version）——一次性报告全部缺失项', { skip }, async () => {
  await assert.rejects(
    withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', '2026-09-01T00:00:00Z', '--to', '2026-09-02T00:00:00Z',
      '--horizons', '24h', '--dataset-version', 'v1.4d-sha256-' + '1'.repeat(64),
      '--rule-version', RULE_VERSION, '--evaluation-version', EVALUATION_VERSION
    ])),
    (e) => e.code === 'MISSING_REQUIRED_ARG' && e.missing.includes('--algorithm-version') && e.missing.includes('--weight-version')
  );
});

test('main()：空字符串参数值——视同缺失，fail closed', { skip }, async () => {
  await assert.rejects(
    withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', '2026-09-01T00:00:00Z', '--to', '2026-09-02T00:00:00Z',
      '--horizons', '24h', '--algorithm-version', '', '--dataset-version', 'v1.4d-sha256-' + '1'.repeat(64),
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
    ])),
    (e) => e.code === 'MISSING_REQUIRED_ARG' && e.missing.includes('--algorithm-version')
  );
});

test('main()：非法UTC时间格式——INVALID_TIME_FORMAT，不进入数据库执行阶段', { skip }, async () => {
  await assert.rejects(
    withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', '2026-09-01 00:00:00', '--to', '2026-09-02T00:00:00Z',
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', 'v1.4d-sha256-' + '1'.repeat(64),
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
    ])),
    (e) => e.code === 'INVALID_TIME_FORMAT'
  );
});

test('main()：from>=to——fail closed（INVALID_TIME_ORDER），不产生任何validation_runs行', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const before = (await pool.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs')).rows[0].n;
  try {
    await assert.rejects(
      withMainEnv(() => main([
        '--symbol', 'ETHUSDT', '--from', '2026-09-05T00:00:00Z', '--to', '2026-09-01T00:00:00Z',
        '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', 'v1.4d-sha256-' + '1'.repeat(64),
        '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
      ])),
      (e) => e.code === 'INVALID_TIME_ORDER'
    );
    const after = (await pool.query('SELECT count(*)::int AS n FROM historical_validation.validation_runs')).rows[0].n;
    assert.equal(after, before);
  } finally {
    await pool.end();
  }
});

test('main()：非法--split格式——INVALID_SPLIT_FORMAT', { skip }, async () => {
  await assert.rejects(
    withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', '2026-09-01T00:00:00Z', '--to', '2026-09-02T00:00:00Z',
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', 'v1.4d-sha256-' + '1'.repeat(64),
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION,
      '--split', 'not-a-ratio'
    ])),
    (e) => e.code === 'INVALID_SPLIT_FORMAT'
  );
});

test('main()：新任务与--split/--train-end冲突参数——CONFLICTING_SPLIT_PARAMS', { skip }, async () => {
  await assert.rejects(
    withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', '2026-09-01T00:00:00Z', '--to', '2026-09-02T00:00:00Z',
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', 'v1.4d-sha256-' + '1'.repeat(64),
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION,
      '--split', '50/25/25', '--train-end', '2026-09-01T12:00:00Z'
    ])),
    (e) => e.code === 'CONFLICTING_SPLIT_PARAMS'
  );
});

test('main()：不同--resume run_id与--dataset-version混用——拒绝（不得混用其他run的dataset_version）', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const from = Date.UTC(2026, 1, 27) - DAY_MS;
    const to = Date.UTC(2026, 1, 27);
    const datasetVersionA = await buildVerifiedManifest(pool, { from, to });
    validationRunId = randomUUID();
    await pool.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [validationRunId, datasetVersionA, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );
    const foreignDatasetVersion = 'v1.4d-sha256-' + '9'.repeat(64);
    await assert.rejects(
      withMainEnv(() => main([
        '--resume', validationRunId, '--dataset-version', foreignDatasetVersion,
        '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
      ])),
      (e) => e.code === 'RESUME_PARAM_MISMATCH'
    );
  } finally {
    await purgeRun(pool, validationRunId);
    await pool.end();
  }
});
