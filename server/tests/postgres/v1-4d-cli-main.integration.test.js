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
import { generateReplaySnapshot } from '../../src/validation-replay/replay-generator.js';
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
// P0-4修复联动：integrity-check.js现在要求[from,to)整个范围按interval步长逐位连续覆盖（含边界），
// 见 v1-4d-cli-entry.integration.test.js 同名辅助函数的详细说明。
async function fillContiguousCoverage(pool, { from, to, replayNowMs }) {
  for (const [interval, stepMs] of [['15m', FIFTEEN_MIN_MS], ['4h', FOUR_HOUR_MS]]) {
    const bars = [];
    for (let openTime = from; openTime < to; openTime += stepMs) bars.push(kline(openTime, openTime + stepMs - 1, '1000.00'));
    if (!bars.length) continue;
    const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool, adapter, symbol: 'ETHUSDT', interval, startTime: from, endTime: to - stepMs, now: () => replayNowMs });
  }
}
async function buildVerifiedManifest(pool, { from, to, replayNowMs = Date.now() }) {
  await fillContiguousCoverage(pool, { from, to, replayNowMs });
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
    const from = referenceCloseTime - DAY_MS + 1; // P0-4修复联动：+1对齐open_time相位(referenceCloseTime本身是close_time相位)，见fillContiguousCoverage说明
    const to = referenceCloseTime + DAY_MS + 1;
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
    // fromMs前移至Jan26（而非Jan30）：referenceCloseTime(Jan31 23:59:59.999)自身的4h ATR回溯窗口
    // 达60小时(~2.5天)，达到Jan29左右，此前的边界(Jan30)未能完整覆盖该回溯窗口，
    // 会在测试库中留下无法被本测试自身清理的孤儿market_bars行。
    await purgeMarketData(pool, { fromMs: Date.UTC(2026, 0, 26), toMs: Date.UTC(2026, 1, 3) });
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
    const from = referenceCloseTime - DAY_MS + 1; // P0-4修复联动：+1对齐open_time相位(referenceCloseTime本身是close_time相位)，见fillContiguousCoverage说明
    const to = referenceCloseTime + DAY_MS + 1;
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
    const from = referenceCloseTime - DAY_MS + 1; // P0-4修复联动：+1对齐open_time相位(referenceCloseTime本身是close_time相位)，见fillContiguousCoverage说明
    const to = referenceCloseTime + DAY_MS + 1;
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
    const from = referenceCloseTime - DAY_MS + 1; // P0-4修复联动：+1对齐open_time相位(referenceCloseTime本身是close_time相位)，见fillContiguousCoverage说明
    const to = referenceCloseTime + DAY_MS + 1;
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

    // P2-h（独立复审第二轮）：§4.2冻结要求dry-run必须输出一份"执行计划"（预计推进的节奏点数量、
    // 预计涉及的backfill_batch_id范围、预计的purge边界），此前从未真正实现/输出过——这里验证
    // plan.executionPlan（main()真实调用runWalkForward()后拿到的返回值，不是重新计算的期望值）
    // 三项内容都真实存在且与本次真实输入吻合。
    assert.ok(plan.executionPlan, 'dry-run必须产出executionPlan');
    assert.equal(plan.executionPlan.rhythmPointCount, plan.generationAttempts, 'rhythmPointCount必须等于实际枚举的节奏点数量');
    assert.ok(plan.executionPlan.rhythmPointCount > 0);
    assert.ok(Array.isArray(plan.executionPlan.backfillBatchIds), 'backfillBatchIds必须是真实manifest记录的批次集合（数组）');
    assert.deepEqual(plan.executionPlan.purgeBoundary, { trainEnd: plan.effectiveOptions.trainEnd, validationEnd: plan.effectiveOptions.validationEnd });
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

// P1-A（独立复审第二轮）：resume时weight_version/evaluation_version必须与本run已有snapshot/outcome
// 实际记录的版本一致，不一致fail closed；无历史数据时允许本次显式提供的版本；历史数据本身已混有多个
// 版本时同样拒绝。A-G对应任务书原始编号。
async function generationRunCountFor(pool, validationRunId) {
  return (await pool.query('SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0].n;
}

test('P1-A-A：首次run使用weight V1，resume使用V2——拒绝(RESUME_WEIGHT_VERSION_MISMATCH)，零新增业务写入', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const dayStart = Date.UTC(2026, 2, 1, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(pool, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - DAY_MS + 1; // P0-4修复联动：+1对齐open_time相位(referenceCloseTime本身是close_time相位)，见fillContiguousCoverage说明
    const to = referenceCloseTime + DAY_MS + 1;
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    const plan1 = await withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', new Date(from).toISOString(), '--to', new Date(to).toISOString(),
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', datasetVersion,
      '--rule-version', RULE_VERSION, '--weight-version', 'v1.4c-server-weight-V1', '--evaluation-version', EVALUATION_VERSION
    ]));
    validationRunId = plan1.validationRunId;
    const before = await generationRunCountFor(pool, validationRunId);
    // 首次run会枚举整个[from,to)窗口内的全部24h节奏点（本测试窗口为2天，产生12条
    // generation_run记录，其中仅seedRhythmPoint覆盖的那个点会SUCCEEDED，其余因缺少数据
    // 而BLOCKED——但BLOCKED点同样会写入generation_run行）。这里不硬编码具体数值，只确认
    // 确实已有生成记录，真正要验证的不变量是resume拒绝后的after===before。
    assert.ok(before > 0, '前提确认：首次run必须已经产生至少一条generation_run记录');

    await assert.rejects(
      withMainEnv(() => main([
        '--resume', validationRunId, '--weight-version', 'v1.4c-server-weight-V2-DIFFERENT', '--evaluation-version', EVALUATION_VERSION
      ])),
      (e) => e.code === 'RESUME_WEIGHT_VERSION_MISMATCH' && e.original === 'v1.4c-server-weight-V1' && e.explicit === 'v1.4c-server-weight-V2-DIFFERENT'
    );

    const after = await generationRunCountFor(pool, validationRunId);
    assert.equal(after, before, '拒绝必须发生在任何生成尝试之前——replay_generation_runs行数不得增加');
  } finally {
    await purgeRun(pool, validationRunId);
    // seedRhythmPoint的4h ATR回溯窗口达60h（2.5天），purge下界必须覆盖到referenceCloseTime-2.5天
    // 以前，否则会有残留bar泄漏到相邻测试（如"--split 50/25/25"用例，其[Feb25,Mar5)区间假定
    // 区间内不存在任何market_bars）——此前fromMs=Feb27仅覆盖了2天，少覆盖了约12小时，是P2-g
    // 相关的测试间数据泄漏根因之一，这里改为Feb25以留出安全余量。
    await purgeMarketData(pool, { fromMs: Date.UTC(2026, 1, 25), toMs: Date.UTC(2026, 2, 4) });
    await pool.end();
  }
});

test('P1-A-B：首次run与resume均使用weight V1——允许', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const dayStart = Date.UTC(2026, 2, 6, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(pool, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - DAY_MS + 1; // P0-4修复联动：+1对齐open_time相位(referenceCloseTime本身是close_time相位)，见fillContiguousCoverage说明
    const to = referenceCloseTime + DAY_MS + 1;
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    const plan1 = await withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', new Date(from).toISOString(), '--to', new Date(to).toISOString(),
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', datasetVersion,
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
    ]));
    validationRunId = plan1.validationRunId;

    const plan2 = await withMainEnv(() => main([
      '--resume', validationRunId, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
    ]));
    assert.equal(plan2.validationRunId, validationRunId);
    const runRow = (await pool.query('SELECT status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(runRow.status, 'SUCCEEDED', '相同weight_version的resume必须被允许并正常完成');
  } finally {
    await purgeRun(pool, validationRunId);
    // 同上（P1-A-A处的说明）：referenceCloseTime=Mar5 23:59:59.999时，ATR回溯最早触及Mar3
    // 中午左右，原fromMs=Mar4仍会漏掉约12小时残留，同样落入"--split 50/25/25"用例假定为空的
    // [Feb25,Mar5)区间——这里前移到Mar2留出安全余量。
    await purgeMarketData(pool, { fromMs: Date.UTC(2026, 2, 2), toMs: Date.UTC(2026, 2, 9) });
    await pool.end();
  }
});

test('P1-A-C：已有outcome使用evaluation V1，resume使用V2——拒绝(RESUME_EVALUATION_VERSION_MISMATCH)，零新增业务写入', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const dayStart = Date.UTC(2026, 2, 10, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(pool, { referenceCloseTime, replayNowMs });
    // 补齐24h完整路径，使evaluateReplayOutcomes真实产出outcome（评估阶段在historicalAsOfTime到达
    // targetEndTime后才会实际评估，from~to必须覆盖到该时刻，故整体窗口设置得更宽）。
    const pathStart = referenceCloseTime + 1;
    const bars = [];
    for (let i = 0; i < 96; i++) { const o = pathStart + i * FIFTEEN_MIN_MS; bars.push(kline(o, o + FIFTEEN_MIN_MS - 1, '1000.00')); }
    const pathAdapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool, adapter: pathAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: pathStart, endTime: pathStart + 96 * FIFTEEN_MIN_MS, now: () => replayNowMs });

    const from = referenceCloseTime - DAY_MS + 1; // P0-4修复联动：+1对齐open_time相位(referenceCloseTime本身是close_time相位)，见fillContiguousCoverage说明
    const to = referenceCloseTime + 2 * DAY_MS;
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    const plan1 = await withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', new Date(from).toISOString(), '--to', new Date(to).toISOString(),
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', datasetVersion,
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', 'v1.4c-outcome-evaluation-V1'
    ]));
    validationRunId = plan1.validationRunId;
    const outcomeCount = (await pool.query(
      `SELECT count(*)::int AS n FROM historical_validation.replay_outcome_events e
       JOIN historical_validation.replay_evaluation_runs er ON er.evaluation_run_id=e.evaluation_run_id
       WHERE er.validation_run_id=$1`, [validationRunId]
    )).rows[0].n;
    assert.ok(outcomeCount > 0, '前提确认：首次run必须真实产出至少一条outcome，否则本测试没有验证到目标场景');

    const before = await generationRunCountFor(pool, validationRunId);
    await assert.rejects(
      withMainEnv(() => main([
        '--resume', validationRunId, '--weight-version', WEIGHT_VERSION, '--evaluation-version', 'v1.4c-outcome-evaluation-V2-DIFFERENT'
      ])),
      (e) => e.code === 'RESUME_EVALUATION_VERSION_MISMATCH' && e.original === 'v1.4c-outcome-evaluation-V1' && e.explicit === 'v1.4c-outcome-evaluation-V2-DIFFERENT'
    );
    const after = await generationRunCountFor(pool, validationRunId);
    assert.equal(after, before, '拒绝必须发生在任何生成/评估尝试之前');
  } finally {
    await purgeRun(pool, validationRunId);
    await purgeMarketData(pool, { fromMs: Date.UTC(2026, 2, 8), toMs: Date.UTC(2026, 2, 14) });
    await pool.end();
  }
});

test('P1-A-D：首次run与resume均使用相同evaluation版本——允许', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const dayStart = Date.UTC(2026, 2, 16, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(pool, { referenceCloseTime, replayNowMs });
    const pathStart = referenceCloseTime + 1;
    const bars = [];
    for (let i = 0; i < 96; i++) { const o = pathStart + i * FIFTEEN_MIN_MS; bars.push(kline(o, o + FIFTEEN_MIN_MS - 1, '1000.00')); }
    const pathAdapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool, adapter: pathAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: pathStart, endTime: pathStart + 96 * FIFTEEN_MIN_MS, now: () => replayNowMs });

    const from = referenceCloseTime - DAY_MS + 1; // P0-4修复联动：+1对齐open_time相位(referenceCloseTime本身是close_time相位)，见fillContiguousCoverage说明
    const to = referenceCloseTime + 2 * DAY_MS;
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    const plan1 = await withMainEnv(() => main([
      '--symbol', 'ETHUSDT', '--from', new Date(from).toISOString(), '--to', new Date(to).toISOString(),
      '--horizons', '24h', '--algorithm-version', ALGORITHM_VERSION, '--dataset-version', datasetVersion,
      '--rule-version', RULE_VERSION, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
    ]));
    validationRunId = plan1.validationRunId;

    const plan2 = await withMainEnv(() => main([
      '--resume', validationRunId, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
    ]));
    assert.equal(plan2.validationRunId, validationRunId);
    const runRow = (await pool.query('SELECT status FROM historical_validation.validation_runs WHERE validation_run_id=$1', [validationRunId])).rows[0];
    assert.equal(runRow.status, 'SUCCEEDED');
  } finally {
    await purgeRun(pool, validationRunId);
    await purgeMarketData(pool, { fromMs: Date.UTC(2026, 2, 14), toMs: Date.UTC(2026, 2, 20) });
    await pool.end();
  }
});

test('P1-A-E：run尚无任何snapshot/outcome时，本次显式提供的weight/evaluation版本可以使用', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const from = Date.UTC(2026, 2, 21) - DAY_MS;
    const to = Date.UTC(2026, 2, 21);
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    // 直接INSERT一条尚未产生任何snapshot/outcome的validation_runs行（模拟"首次尝试刚创建行就被中断"）。
    validationRunId = randomUUID();
    await pool.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [validationRunId, datasetVersion, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );
    const snapshotCountBefore = (await pool.query(
      `SELECT count(*)::int AS n FROM historical_validation.replay_generation_runs WHERE validation_run_id=$1`, [validationRunId]
    )).rows[0].n;
    assert.equal(snapshotCountBefore, 0, '前提确认：该run确实尚无任何生成记录');

    // 无历史数据可比对——任意weight/evaluation版本都必须被接受（不会误判为"缺失版本"或"混合版本"）。
    const plan = await withMainEnv(() => main([
      '--resume', validationRunId, '--weight-version', 'v1.4c-server-weight-FIRST-TIME', '--evaluation-version', 'v1.4c-outcome-evaluation-FIRST-TIME'
    ]));
    assert.equal(plan.validationRunId, validationRunId);
  } finally {
    await purgeRun(pool, validationRunId);
    await pool.end();
  }
});

test('P1-A-F：历史数据已经混有多个weight_version（模拟本轮修复生效前遗留的混合数据）——resume必须fail closed(RESUME_MIXED_WEIGHT_VERSIONS)', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const dayStart = Date.UTC(2026, 2, 23, 0, 0, 0);
    const referenceCloseTime1 = dayStart - 1;
    const referenceCloseTime2 = dayStart + FOUR_HOUR_MS - 1; // 下一个4h节奏点
    const replayNowMs = Date.now();
    await seedRhythmPoint(pool, { referenceCloseTime: referenceCloseTime1, replayNowMs });
    await seedRhythmPoint(pool, { referenceCloseTime: referenceCloseTime2, replayNowMs });
    // seedRhythmPoint只各自插入一根15m参考bar（分别落在referenceCloseTime1和referenceCloseTime2，
    // 两者相隔4h），中间留有15根15m bar的空档——manifest的gap检测会将其判定为一个缺口区域并REJECTED。
    // 这里补齐两点之间的15m bar，使其连续，让manifest真实构建成功；这不影响本测试要验证的目标
    // （resume时对"历史数据本身已混合多个weight_version"的fail-closed处理）。
    const gapStart = referenceCloseTime1 + 1;
    const gapBars = [];
    for (let t = gapStart; t < referenceCloseTime2 - FIFTEEN_MIN_MS + 1; t += FIFTEEN_MIN_MS) {
      gapBars.push(kline(t, t + FIFTEEN_MIN_MS - 1, '1000.00'));
    }
    const gapAdapter = makeMockAdapter({ pages: [gapBars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool, adapter: gapAdapter, symbol: 'ETHUSDT', interval: '15m', startTime: gapStart, endTime: referenceCloseTime2 - FIFTEEN_MIN_MS, now: () => replayNowMs });
    const from = referenceCloseTime1 - DAY_MS;
    const to = referenceCloseTime2 + DAY_MS;
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    validationRunId = randomUUID();
    await pool.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [validationRunId, datasetVersion, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );

    // 直接用generateReplaySnapshot在同一validationRunId下产出两条使用不同weight_version的快照——
    // 模拟"本轮修复生效前，历史上已经通过某种途径（如round-1的原始bug）混入了两个weight_version"这一
    // 遗留场景，而不是通过CLI制造（CLI本身现在已经会在第一次resume时就拦截，见P1-A-A/B/C/D），
    // 用来验证checkResumeVersionConsistency对"历史数据本身已经混合"这一分支的处理。
    const gen1 = await generateReplaySnapshot({
      pool, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime1, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: 'v1.4c-server-weight-MIXED-1',
      datasetVersion, ruleVersion: RULE_VERSION
    });
    const gen2 = await generateReplaySnapshot({
      pool, validationRunId, instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h',
      historicalAsOfTime: referenceCloseTime2, replayNowMs, algorithmVersion: ALGORITHM_VERSION, weightVersion: 'v1.4c-server-weight-MIXED-2',
      datasetVersion, ruleVersion: RULE_VERSION
    });
    assert.equal(gen1.status, 'INSERTED');
    assert.equal(gen2.status, 'INSERTED');

    await assert.rejects(
      withMainEnv(() => main([
        '--resume', validationRunId, '--weight-version', 'v1.4c-server-weight-MIXED-1', '--evaluation-version', EVALUATION_VERSION
      ])),
      (e) => e.code === 'RESUME_MIXED_WEIGHT_VERSIONS' && e.priorWeightVersions.length === 2
    );
  } finally {
    await purgeRun(pool, validationRunId);
    await purgeMarketData(pool, { fromMs: Date.UTC(2026, 2, 21), toMs: Date.UTC(2026, 2, 26) });
    await pool.end();
  }
});

test('P1-A-G：resume继承其他允许继承参数后，main()输出的effective_options反映真实生效值（含weight_version/evaluation_version）', { skip }, async () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  let validationRunId;
  try {
    const dayStart = Date.UTC(2026, 2, 28, 0, 0, 0);
    const referenceCloseTime = dayStart - 1;
    const replayNowMs = Date.now();
    await seedRhythmPoint(pool, { referenceCloseTime, replayNowMs });
    const from = referenceCloseTime - DAY_MS + 1; // P0-4修复联动：+1对齐open_time相位(referenceCloseTime本身是close_time相位)，见fillContiguousCoverage说明
    const to = referenceCloseTime + DAY_MS + 1;
    const datasetVersion = await buildVerifiedManifest(pool, { from, to });

    validationRunId = randomUUID();
    await pool.query(
      `INSERT INTO historical_validation.validation_runs(validation_run_id, dataset_version, symbol, horizons, from_utc, to_utc, algorithm_version, rule_version, status, started_at)
       VALUES($1,$2,'ETHUSDT','["24h"]'::jsonb,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,'RUNNING',now())`,
      [validationRunId, datasetVersion, from, to, ALGORITHM_VERSION, RULE_VERSION]
    );

    const capture = captureConsole();
    let plan;
    try {
      plan = await withMainEnv(() => main([
        '--resume', validationRunId, '--weight-version', WEIGHT_VERSION, '--evaluation-version', EVALUATION_VERSION
      ]));
    } finally {
      capture.restore();
    }

    const effectiveLine = capture.info.find(line => line.startsWith('effective_options'));
    assert.ok(effectiveLine, 'main()必须真实输出effective_options这一行');
    const printed = JSON.parse(effectiveLine.slice('effective_options '.length));
    assert.equal(printed.validationRunId, validationRunId);
    assert.equal(printed.symbol, 'ETHUSDT', 'effective_options必须反映继承自原run的symbol，而非CLI原始空值');
    assert.equal(printed.datasetVersion, datasetVersion, '必须反映继承自原run的dataset_version');
    assert.equal(printed.algorithmVersion, ALGORITHM_VERSION);
    assert.equal(printed.ruleVersion, RULE_VERSION);
    assert.equal(printed.weightVersion, WEIGHT_VERSION, '必须反映本次实际生效的weight_version');
    assert.equal(printed.evaluationVersion, EVALUATION_VERSION, '必须反映本次实际生效的evaluation_version');
    assert.equal(printed.from, from);
    assert.equal(printed.to, to);
    assert.equal(plan.validationRunId, validationRunId);
  } finally {
    await purgeRun(pool, validationRunId);
    await purgeMarketData(pool, { fromMs: Date.UTC(2026, 2, 26), toMs: Date.UTC(2026, 3, 1) });
    await pool.end();
  }
});
