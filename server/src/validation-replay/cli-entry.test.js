// cli-entry.js 纯逻辑单元测试（不连接数据库）：参数解析/切分比例/顺序校验/resume一致性/节奏点枚举。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, parseSplitRatio, computeSplitBoundaries, validateSplitOrder, validateReplayRange,
  checkResumeParamConsistency, enumerateRhythmPoints, STARTUP_BANNER,
  validateEffectiveOptions, validateCliArgsBeforeDbAccess
} from './cli-entry.js';

const DAY_MS = 86400000;

test('parseArgs：解析--key value形式参数', () => {
  const args = parseArgs(['--symbol', 'ETHUSDT', '--dry-run']);
  assert.deepEqual(args, { symbol: 'ETHUSDT', 'dry-run': true });
});

test('parseSplitRatio：接受合法的train%/validation%/test%且和为100', () => {
  assert.deepEqual(parseSplitRatio('50/25/25'), { trainPct: 50, validationPct: 25, testPct: 25 });
});

test('parseSplitRatio：格式非法或和不为100时fail closed', () => {
  assert.throws(() => parseSplitRatio('abc'), (e) => e.code === 'INVALID_SPLIT_FORMAT');
  assert.throws(() => parseSplitRatio('50/25/30'), (e) => e.code === 'INVALID_SPLIT_FORMAT');
  assert.throws(() => parseSplitRatio(undefined), (e) => e.code === 'INVALID_SPLIT_FORMAT');
});

test('computeSplitBoundaries：按总日历天数比例四舍五入换算', () => {
  const from = Date.UTC(2026, 0, 1);
  const to = from + 100 * DAY_MS;
  const { trainEnd, validationEnd } = computeSplitBoundaries({ from, to, splitRatio: { trainPct: 50, validationPct: 25, testPct: 25 } });
  assert.equal((trainEnd - from) / DAY_MS, 50);
  assert.equal((validationEnd - trainEnd) / DAY_MS, 25);
  assert.equal((to - validationEnd) / DAY_MS, 25);
});

test('R23.6：--split 50/25/25，--from~--to跨度180天时，train_end=from+90天，validation_end=from+135天', () => {
  const from = Date.UTC(2026, 0, 1);
  const to = from + 180 * DAY_MS;
  const { trainEnd, validationEnd } = computeSplitBoundaries({ from, to, splitRatio: { trainPct: 50, validationPct: 25, testPct: 25 } });
  assert.equal((trainEnd - from) / DAY_MS, 90, '180天*50%=90天');
  assert.equal((validationEnd - from) / DAY_MS, 135, 'train_end(90天)+180天*25%(45天)=135天');
  assert.equal((to - validationEnd) / DAY_MS, 45, '剩余25%=45天(test段)');
});

test('validateSplitOrder：from<trainEnd<validationEnd<to时通过，否则fail closed', () => {
  const from = 0, to = 10000;
  assert.doesNotThrow(() => validateSplitOrder({ from, to, trainEnd: 4000, validationEnd: 7000 }));
  assert.throws(() => validateSplitOrder({ from, to, trainEnd: 7000, validationEnd: 4000 }), (e) => e.code === 'INVALID_SPLIT_ORDER');
  assert.throws(() => validateSplitOrder({ from, to, trainEnd: from, validationEnd: 7000 }), (e) => e.code === 'INVALID_SPLIT_ORDER', '不允许trainEnd等于from');
  assert.throws(() => validateSplitOrder({ from, to, trainEnd: 4000, validationEnd: to }), (e) => e.code === 'INVALID_SPLIT_ORDER', '不允许validationEnd等于to');
});

test('validateSplitOrder：trainEnd/validationEnd均为null时视为不做三段切分，直接通过', () => {
  assert.doesNotThrow(() => validateSplitOrder({ from: 0, to: 10000, trainEnd: null, validationEnd: null }));
});

test('validateReplayRange（§4.3）：to必须早于(当前真实UTC-72h)，否则INVALID_REPLAY_RANGE', () => {
  const nowMs = Date.UTC(2026, 6, 1);
  assert.doesNotThrow(() => validateReplayRange({ to: nowMs - 4 * DAY_MS, nowMs }));
  assert.throws(() => validateReplayRange({ to: nowMs - DAY_MS, nowMs }), (e) => e.code === 'INVALID_REPLAY_RANGE');
  assert.throws(() => validateReplayRange({ to: nowMs, nowMs }), (e) => e.code === 'INVALID_REPLAY_RANGE');
});

test('checkResumeParamConsistency：省略的参数视为沿用原run，不冲突', () => {
  const originalRun = { symbol: 'ETHUSDT', algorithmVersion: 'v1', datasetVersion: 'd1', ruleVersion: 'r1', fromUtc: 1000, toUtc: 2000, trainEndUtc: null, validationEndUtc: null };
  assert.doesNotThrow(() => checkResumeParamConsistency({ explicitParams: {}, originalRun }));
  assert.doesNotThrow(() => checkResumeParamConsistency({ explicitParams: { symbol: 'ETHUSDT' }, originalRun }));
});

test('checkResumeParamConsistency（§4.4红线）：显式传入且与原run不一致时RESUME_PARAM_MISMATCH', () => {
  const originalRun = { symbol: 'ETHUSDT', algorithmVersion: 'v1', datasetVersion: 'd1', ruleVersion: 'r1', fromUtc: 1000, toUtc: 2000, trainEndUtc: null, validationEndUtc: null };
  assert.throws(
    () => checkResumeParamConsistency({ explicitParams: { algorithmVersion: 'v2' }, originalRun }),
    (e) => e.code === 'RESUME_PARAM_MISMATCH' && e.mismatches[0].key === 'algorithmVersion'
  );
});

test('enumerateRhythmPoints：24h节奏点按4小时步长落在[from,to)内的对齐边界', () => {
  const from = Date.UTC(2026, 0, 1, 0, 0, 0);
  const to = from + DAY_MS; // 恰好1天=6个4H节奏点
  const points = enumerateRhythmPoints({ from, to, horizon: '24h' });
  assert.equal(points.length, 6);
  for (const p of points) assert.equal((p + 1) % (4 * 3600000), 0, '每个节奏点都必须是4H边界(闭区间右端)');
  assert.ok(points.every((p, i) => i === 0 || p > points[i - 1]), '节奏点必须严格递增');
});

test('enumerateRhythmPoints：72h节奏点按1天步长', () => {
  const from = Date.UTC(2026, 0, 1, 0, 0, 0);
  const to = from + 3 * DAY_MS;
  const points = enumerateRhythmPoints({ from, to, horizon: '72h' });
  assert.equal(points.length, 3);
});

test('STARTUP_BANNER（§4.1）：必须包含固定的HISTORICAL RESEARCH ONLY警告文案', () => {
  assert.match(STARTUP_BANNER, /HISTORICAL RESEARCH ONLY/);
  assert.match(STARTUP_BANNER, /不产出交易信号/);
});

// P1-4：validateEffectiveOptions —— resume/new-task合并后的最终effective options必须在任何生成/写入前
// 完整校验，不得依赖DB NOT NULL/FK报错来发现同类问题。algorithm-version/weight-version/dataset-version/
// rule-version/evaluation-version一律要求非空字符串，不得静默回退到任何生产常量（本函数不含任何默认值/兜底）。
const VALID_EFFECTIVE = Object.freeze({
  symbol: 'ETHUSDT', from: 1000, to: 2000, horizons: ['24h'],
  algorithmVersion: 'v1.4c-server-po-rule-1', datasetVersion: 'v1.4d-sha256-' + '1'.repeat(64), ruleVersion: 'v1.4c-po-rule-1',
  weightVersion: 'v1.4c-server-weight-1', evaluationVersion: 'v1.4c-outcome-evaluation-1'
});

test('validateEffectiveOptions：全部必填字段齐全且from<to、horizons合法时通过', () => {
  assert.doesNotThrow(() => validateEffectiveOptions({ ...VALID_EFFECTIVE }));
});

for (const field of ['symbol', 'algorithmVersion', 'datasetVersion', 'ruleVersion', 'weightVersion', 'evaluationVersion']) {
  test(`validateEffectiveOptions（P1-4）：${field}单独缺失时fail closed，MISSING_REQUIRED_PARAM，不静默回退任何常量`, () => {
    const effective = { ...VALID_EFFECTIVE };
    delete effective[field];
    assert.throws(() => validateEffectiveOptions(effective), (e) => e.code === 'MISSING_REQUIRED_PARAM' && e.missing.includes(field));
  });
  test(`validateEffectiveOptions（P1-4）：${field}为空字符串时fail closed，视同缺失`, () => {
    assert.throws(() => validateEffectiveOptions({ ...VALID_EFFECTIVE, [field]: '' }), (e) => e.code === 'MISSING_REQUIRED_PARAM' && e.missing.includes(field));
  });
}

test('validateEffectiveOptions（P1-4）：多个必填参数同时缺失时，MISSING_REQUIRED_PARAM.missing列出全部缺失项', () => {
  const effective = { ...VALID_EFFECTIVE };
  delete effective.algorithmVersion;
  delete effective.weightVersion;
  delete effective.datasetVersion;
  assert.throws(() => validateEffectiveOptions(effective), (e) =>
    e.code === 'MISSING_REQUIRED_PARAM' &&
    e.missing.includes('algorithmVersion') && e.missing.includes('weightVersion') && e.missing.includes('datasetVersion')
  );
});

test('validateEffectiveOptions（P1-4）：horizons为空数组或非数组时fail closed', () => {
  assert.throws(() => validateEffectiveOptions({ ...VALID_EFFECTIVE, horizons: [] }), (e) => e.code === 'MISSING_REQUIRED_PARAM' && e.missing.includes('horizons'));
  assert.throws(() => validateEffectiveOptions({ ...VALID_EFFECTIVE, horizons: undefined }), (e) => e.code === 'MISSING_REQUIRED_PARAM' && e.missing.includes('horizons'));
});

test('validateEffectiveOptions（P1-4）：horizons含非法值（不在24h/72h集合内）时INVALID_HORIZON', () => {
  assert.throws(() => validateEffectiveOptions({ ...VALID_EFFECTIVE, horizons: ['24h', '1h'] }), (e) => e.code === 'INVALID_HORIZON');
});

test('validateEffectiveOptions（P1-4）：from>=to时fail closed（INVALID_TIME_ORDER），不依赖DB CHECK约束偶然报错', () => {
  assert.throws(() => validateEffectiveOptions({ ...VALID_EFFECTIVE, from: 2000, to: 2000 }), (e) => e.code === 'INVALID_TIME_ORDER');
  assert.throws(() => validateEffectiveOptions({ ...VALID_EFFECTIVE, from: 3000, to: 2000 }), (e) => e.code === 'INVALID_TIME_ORDER');
});

test('validateEffectiveOptions（P1-4）：from/to非有限数字（未提供/NaN）时MISSING_REQUIRED_PARAM', () => {
  assert.throws(() => validateEffectiveOptions({ ...VALID_EFFECTIVE, from: undefined }), (e) => e.code === 'MISSING_REQUIRED_PARAM' && e.missing.includes('from'));
  assert.throws(() => validateEffectiveOptions({ ...VALID_EFFECTIVE, to: NaN }), (e) => e.code === 'MISSING_REQUIRED_PARAM' && e.missing.includes('to'));
});

// P1-4：validateCliArgsBeforeDbAccess —— main()级别、DB连接之前的快速fail-closed前置校验。
const FULL_NEW_TASK_ARGS = Object.freeze({
  symbol: 'ETHUSDT', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', horizons: '24h',
  'algorithm-version': 'v1.4c-server-po-rule-1', 'dataset-version': 'v1.4d-sha256-' + '1'.repeat(64), 'rule-version': 'v1.4c-po-rule-1',
  'weight-version': 'v1.4c-server-weight-1', 'evaluation-version': 'v1.4c-outcome-evaluation-1'
});

test('validateCliArgsBeforeDbAccess：new-task模式下全部必填参数齐全时通过', () => {
  assert.doesNotThrow(() => validateCliArgsBeforeDbAccess({ args: { ...FULL_NEW_TASK_ARGS }, resumeId: null }));
});

for (const [key, flag] of [
  ['symbol', '--symbol'], ['from', '--from'], ['to', '--to'], ['horizons', '--horizons'],
  ['algorithm-version', '--algorithm-version'], ['dataset-version', '--dataset-version'], ['rule-version', '--rule-version'],
  ['weight-version', '--weight-version'], ['evaluation-version', '--evaluation-version']
]) {
  test(`validateCliArgsBeforeDbAccess（P1-4）：new-task模式下${flag}单独缺失时MISSING_REQUIRED_ARG，不进入DB阶段`, () => {
    const args = { ...FULL_NEW_TASK_ARGS };
    delete args[key];
    assert.throws(() => validateCliArgsBeforeDbAccess({ args, resumeId: null }), (e) => e.code === 'MISSING_REQUIRED_ARG' && e.missing.includes(flag));
  });
}

test('validateCliArgsBeforeDbAccess（P1-4）：new-task模式下多个必填参数同时缺失时，missing列出全部', () => {
  const args = { ...FULL_NEW_TASK_ARGS };
  delete args['dataset-version'];
  delete args['weight-version'];
  assert.throws(() => validateCliArgsBeforeDbAccess({ args, resumeId: null }), (e) =>
    e.code === 'MISSING_REQUIRED_ARG' && e.missing.includes('--dataset-version') && e.missing.includes('--weight-version')
  );
});

test('validateCliArgsBeforeDbAccess（P1-4）：参数以--flag形式出现但未跟值（parseArgs解析为true）时视同缺失', () => {
  const args = { ...FULL_NEW_TASK_ARGS, 'dataset-version': true };
  assert.throws(() => validateCliArgsBeforeDbAccess({ args, resumeId: null }), (e) => e.code === 'MISSING_REQUIRED_ARG' && e.missing.includes('--dataset-version'));
});

test('validateCliArgsBeforeDbAccess（P1-4）：参数为空字符串时视同缺失', () => {
  const args = { ...FULL_NEW_TASK_ARGS, 'rule-version': '' };
  assert.throws(() => validateCliArgsBeforeDbAccess({ args, resumeId: null }), (e) => e.code === 'MISSING_REQUIRED_ARG' && e.missing.includes('--rule-version'));
});

test('validateCliArgsBeforeDbAccess（P1-3/P1-4）：resume模式下最小形式(只有--resume)通过——不要求symbol/from/to/version等新任务必填参数', () => {
  assert.doesNotThrow(() => validateCliArgsBeforeDbAccess({
    args: { resume: 'aaaaaaaa-0000-0000-0000-000000000000', 'weight-version': 'v1.4c-server-weight-1', 'evaluation-version': 'v1.4c-outcome-evaluation-1' },
    resumeId: 'aaaaaaaa-0000-0000-0000-000000000000'
  }));
});

test('validateCliArgsBeforeDbAccess（P1-3）：resume模式下weight-version/evaluation-version仍必须显式提供（不是可恢复的run身份字段）', () => {
  assert.throws(
    () => validateCliArgsBeforeDbAccess({ args: { resume: 'id-1', 'evaluation-version': 'v1' }, resumeId: 'id-1' }),
    (e) => e.code === 'MISSING_REQUIRED_ARG' && e.missing.includes('--weight-version')
  );
  assert.throws(
    () => validateCliArgsBeforeDbAccess({ args: { resume: 'id-1', 'weight-version': 'v1' }, resumeId: 'id-1' }),
    (e) => e.code === 'MISSING_REQUIRED_ARG' && e.missing.includes('--evaluation-version')
  );
});

test('validateCliArgsBeforeDbAccess（P1-3）：--resume提供空值/非法值（无跟随值）时INVALID_RESUME_ID，区别于"未提供--resume"', () => {
  assert.throws(() => validateCliArgsBeforeDbAccess({ args: { resume: true }, resumeId: true }), (e) => e.code === 'INVALID_RESUME_ID');
  assert.throws(() => validateCliArgsBeforeDbAccess({ args: { resume: '' }, resumeId: '' }), (e) => e.code === 'INVALID_RESUME_ID');
});

test('validateCliArgsBeforeDbAccess：完全省略--resume（resumeId为null）时视为new-task模式，走完整必填校验', () => {
  assert.doesNotThrow(() => validateCliArgsBeforeDbAccess({ args: { ...FULL_NEW_TASK_ARGS }, resumeId: null }));
  const args = { ...FULL_NEW_TASK_ARGS };
  delete args.symbol;
  assert.throws(() => validateCliArgsBeforeDbAccess({ args, resumeId: null }), (e) => e.code === 'MISSING_REQUIRED_ARG');
});

test('validateCliArgsBeforeDbAccess（§4.1红线）：--split与--train-end/--validation-end同时出现时CONFLICTING_SPLIT_PARAMS', () => {
  const args = { ...FULL_NEW_TASK_ARGS, split: '50/25/25', 'train-end': '2026-01-01T12:00:00Z' };
  assert.throws(() => validateCliArgsBeforeDbAccess({ args, resumeId: null }), (e) => e.code === 'CONFLICTING_SPLIT_PARAMS');
});

test('checkResumeParamConsistency（P1-3）：horizons数组比较——顺序不同但集合相同视为一致，集合不同视为冲突', () => {
  const originalRun = { symbol: 'ETHUSDT', horizons: ['24h', '72h'], algorithmVersion: 'v1', datasetVersion: 'd1', ruleVersion: 'r1', fromUtc: 1000, toUtc: 2000, trainEndUtc: null, validationEndUtc: null };
  assert.doesNotThrow(() => checkResumeParamConsistency({ explicitParams: { horizons: ['72h', '24h'] }, originalRun }));
  assert.throws(
    () => checkResumeParamConsistency({ explicitParams: { horizons: ['24h'] }, originalRun }),
    (e) => e.code === 'RESUME_PARAM_MISMATCH' && e.mismatches.some(m => m.key === 'horizons')
  );
});
