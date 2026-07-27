// R5：CLI参数与UTC时间格式fail-closed校验（静态单元测试，不需要数据库）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseUtc } from '../../src/backfill/backfill-cli-entry.js';

test('parseArgs：解析 --key value 形式的参数', () => {
  const args = parseArgs(['--symbol', 'ETHUSDT', '--intervals', '15m,1h,4h', '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-02T00:00:00Z']);
  assert.deepEqual(args, { symbol: 'ETHUSDT', intervals: '15m,1h,4h', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' });
});

test('parseArgs：无值的flag（如 --resume 缺参数时后面紧跟另一个--flag）被解析为boolean true', () => {
  const args = parseArgs(['--dry-run', '--symbol', 'ETHUSDT']);
  assert.equal(args['dry-run'], true);
  assert.equal(args.symbol, 'ETHUSDT');
});

test('parseUtc：接受严格的UTC ISO8601（含毫秒的Z后缀）', () => {
  assert.equal(parseUtc('2026-01-01T00:00:00Z', '--from'), Date.UTC(2026, 0, 1));
  assert.equal(parseUtc('2026-01-01T00:00:00.123Z', '--from'), Date.UTC(2026, 0, 1) + 123);
});

test('parseUtc：fail closed 拒绝非UTC/无Z后缀/本地时区偏移/非法格式', () => {
  for (const bad of ['2026-01-01', '2026-01-01T00:00:00', '2026-01-01T00:00:00+08:00', '2026/01/01T00:00:00Z', 'not-a-date', undefined, true]) {
    assert.throws(() => parseUtc(bad, '--from'), (err) => err.code === 'INVALID_TIME_FORMAT');
  }
});
