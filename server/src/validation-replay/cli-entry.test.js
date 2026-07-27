// cli-entry.js 纯逻辑单元测试（不连接数据库）：参数解析/切分比例/顺序校验/resume一致性/节奏点枚举。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, parseSplitRatio, computeSplitBoundaries, validateSplitOrder, validateReplayRange,
  checkResumeParamConsistency, enumerateRhythmPoints, STARTUP_BANNER
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
