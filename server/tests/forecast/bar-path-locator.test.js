import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFourHourAtr14, computeConsecutiveBreakoutBars, locateReferenceBarAndPath, locatePathForEvaluation } from '../../src/forecast/bar-path-locator.js';

const FOUR_HOUR_MS = 14400000, TIMEFRAME_MS = 900000;

function toRow(b) {
  return { open_time: new Date(b.open_time), close_time: new Date(b.close_time), open: String(b.open ?? 100), high: String(b.high ?? 101), low: String(b.low ?? 99), close: String(b.close ?? 100), revision_number: b.revision_number ?? 0 };
}

function makeQueryable(bars4h, bars15m) {
  return {
    async query(sql, params) {
      if (sql.includes('LIMIT $4')) {
        const [, intervalName, asOfTime, limit] = params;
        const source = intervalName === '4h' ? bars4h : bars15m;
        const rows = source.filter(b => b.close_time <= asOfTime && b.available_at <= asOfTime && b.fetched_at <= asOfTime)
          .sort((a, b) => b.open_time - a.open_time || b.revision_number - a.revision_number).slice(0, limit);
        return { rows: rows.map(toRow) };
      }
      if (sql.includes('close_time=to_timestamp($2/1000.0)')) {
        const [, closeTime, asOfTime] = params;
        const rows = bars15m.filter(b => b.close_time === closeTime && b.available_at <= asOfTime && b.fetched_at <= asOfTime)
          .sort((a, b) => b.revision_number - a.revision_number).slice(0, 1);
        return { rows: rows.map(toRow) };
      }
      if (sql.includes('ORDER BY open_time DESC, revision_number DESC LIMIT 1')) {
        const [, asOfTime] = params;
        const rows = bars15m.filter(b => b.close_time <= asOfTime && b.available_at <= asOfTime && b.fetched_at <= asOfTime)
          .sort((a, b) => b.open_time - a.open_time || b.revision_number - a.revision_number).slice(0, 1);
        return { rows: rows.map(toRow) };
      }
      if (sql.includes('open_time>=to_timestamp($2/1000.0)')) {
        const [, start, end, asOfTime] = params;
        const rows = bars15m.filter(b => b.open_time >= start && b.open_time <= end && b.close_time <= asOfTime && b.available_at <= asOfTime && b.fetched_at <= asOfTime)
          .sort((a, b) => a.open_time - b.open_time || b.revision_number - a.revision_number);
        return { rows: rows.map(toRow) };
      }
      throw new Error('Unhandled mock SQL: ' + sql);
    }
  };
}

function genContiguous(count, stepMs, base, fill) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const openTime = base + i * stepMs, closeTime = openTime + stepMs - 1;
    bars.push({ open_time: openTime, close_time: closeTime, available_at: closeTime, fetched_at: closeTime, revision_number: 0, ...(fill ? fill(i, openTime, closeTime) : {}) });
  }
  return bars;
}

test('computeFourHourAtr14：15根连续bar成功返回正数', async () => {
  const bars4h = genContiguous(15, FOUR_HOUR_MS, 0, (i) => ({ high: 100 + i, low: 99 + i, close: 99.5 + i }));
  const q = makeQueryable(bars4h, []);
  const result = await computeFourHourAtr14(q, { instrument: 'ETHUSDT', asOfTime: bars4h[14].close_time });
  assert.equal(result.ok, true);
  assert.ok(result.atr14FourHourAtGeneration > 0);
});

test('computeFourHourAtr14：仅14根bar时INSUFFICIENT', async () => {
  const bars4h = genContiguous(14, FOUR_HOUR_MS, 0);
  const q = makeQueryable(bars4h, []);
  const result = await computeFourHourAtr14(q, { instrument: 'ETHUSDT', asOfTime: bars4h[13].close_time });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ATR14_4H_INSUFFICIENT');
});

test('computeFourHourAtr14：15根bar中存在缺口时INSUFFICIENT（不得替代/猜测）', async () => {
  const bars4h = genContiguous(16, FOUR_HOUR_MS, 0);
  bars4h.splice(7, 1); // 制造缺口
  const q = makeQueryable(bars4h, []);
  const result = await computeFourHourAtr14(q, { instrument: 'ETHUSDT', asOfTime: bars4h[bars4h.length - 1].close_time });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ATR14_4H_INSUFFICIENT');
});

test('computeConsecutiveBreakoutBars：23根bar不足时INSUFFICIENT_DATA', async () => {
  const bars4h = genContiguous(22, FOUR_HOUR_MS, 0, () => ({ high: 100, low: 99, close: 99.5 }));
  const q = makeQueryable(bars4h, []);
  const result = await computeConsecutiveBreakoutBars(q, { instrument: 'ETHUSDT', asOfTime: bars4h[21].close_time, direction: 'up' });
  assert.equal(result.count, null);
  assert.equal(result.state, 'INSUFFICIENT_DATA');
});

test('computeConsecutiveBreakoutBars：最新3根均突破自身独立前20根high => count=3', async () => {
  // bars[0..19]为平稳区间(high=100)；bars[20..22]依次创新高，各自的"前20根"窗口滑动但仍以100为界
  const bars4h = genContiguous(23, FOUR_HOUR_MS, 0, (i) => {
    if (i < 20) return { high: 100, low: 95, close: 99 };
    return { high: 100, low: 95, close: 101 + i }; // close突破前20根high=100
  });
  const q = makeQueryable(bars4h, []);
  const result = await computeConsecutiveBreakoutBars(q, { instrument: 'ETHUSDT', asOfTime: bars4h[22].close_time, direction: 'up' });
  assert.equal(result.count, 3);
  assert.equal(result.state, 'BREAKOUT_ACTIVE');
});

test('computeConsecutiveBreakoutBars：最新一根非突破 => count=0（即使更早的候选是突破，从最新往回数遇到第一个不匹配即停止）', async () => {
  const bars4h = genContiguous(23, FOUR_HOUR_MS, 0, (i) => {
    if (i === 22) return { high: 100, low: 95, close: 99 }; // 最新一根未突破
    if (i < 20) return { high: 100, low: 95, close: 99 };
    return { high: 100, low: 95, close: 105 };
  });
  const q = makeQueryable(bars4h, []);
  const result = await computeConsecutiveBreakoutBars(q, { instrument: 'ETHUSDT', asOfTime: bars4h[22].close_time, direction: 'up' });
  assert.equal(result.count, 0);
  assert.equal(result.state, 'NOT_BREAKOUT');
});

test('computeConsecutiveBreakoutBars：向下跌破对称计算', async () => {
  const bars4h = genContiguous(23, FOUR_HOUR_MS, 0, (i) => {
    if (i < 20) return { high: 105, low: 100, close: 102 };
    return { high: 105, low: 100, close: 95 - i };
  });
  const q = makeQueryable(bars4h, []);
  const result = await computeConsecutiveBreakoutBars(q, { instrument: 'ETHUSDT', asOfTime: bars4h[22].close_time, direction: 'down' });
  assert.equal(result.count, 3);
});

test('locateReferenceBarAndPath：referenceBar恒选取as-of时刻最近的一根已收盘bar', async () => {
  const bars15m = genContiguous(5, TIMEFRAME_MS, 0);
  const q = makeQueryable([], bars15m);
  const result = await locateReferenceBarAndPath(q, { instrument: 'ETHUSDT', horizon: '24h', asOfTime: bars15m[2].close_time, symbol: 'ETH' });
  assert.equal(result.referenceBarRef.sequenceIndex, 0);
  assert.equal(result.referenceBarRef.closeTime, bars15m[2].close_time);
});

test('locateReferenceBarAndPath：生成时刻(asOfTime=referenceBar自身收盘时间)目标路径尚不存在，96根全部missing，pathDataComplete=false（符合"生成时路径必然未来"的真实语义，回填由locatePathForEvaluation在到期后独立完成）', async () => {
  const bars15m = genContiguous(1, TIMEFRAME_MS, 0);
  const q = makeQueryable([], bars15m);
  const result = await locateReferenceBarAndPath(q, { instrument: 'ETHUSDT', horizon: '24h', asOfTime: bars15m[0].close_time, symbol: 'ETH' });
  assert.equal(result.endpointDataComplete, false);
  assert.equal(result.pathDataComplete, false);
  assert.equal(result.missingBarRefs.length, 96);
  assert.equal(result.observedBars.length, 0);
});

test('locateReferenceBarAndPath：referenceBar缺失 => endpointDataComplete=false', async () => {
  const q = makeQueryable([], []);
  const result = await locateReferenceBarAndPath(q, { instrument: 'ETHUSDT', horizon: '24h', asOfTime: 1_000_000, symbol: 'ETH' });
  assert.equal(result.endpointDataComplete, false);
  assert.deepEqual(result.exclusionReasons, ['reference_bar_missing']);
});

test('locatePathForEvaluation：完整路径给出actualStartPrice/actualEndPrice/actualHigh/actualLow', async () => {
  const bars15m = genContiguous(97, TIMEFRAME_MS, 0, (i) => ({ high: 100 + i, low: 90 + i, close: 95 + i }));
  const q = makeQueryable([], bars15m);
  const referenceBarRef = { symbol: 'ETH', closeTime: bars15m[0].close_time };
  const result = await locatePathForEvaluation(q, { instrument: 'ETHUSDT', referenceBarRef, expectedBarCount: 96, asOfTime: bars15m[96].close_time });
  assert.equal(result.endpointDataComplete, true);
  assert.equal(result.pathDataComplete, true);
  assert.equal(result.actualStartPrice, Number(bars15m[0].close));
  assert.equal(result.actualEndPrice, Number(bars15m[96].close));
  assert.equal(result.actualHigh, Math.max(...bars15m.slice(1, 97).map(b => b.high)));
  assert.equal(result.actualLow, Math.min(...bars15m.slice(1, 97).map(b => b.low)));
});

test('locatePathForEvaluation：referenceBar本尊在评估时仍未出现 => actualStartPrice为null，不得沿用referencePrice', async () => {
  const bars15m = genContiguous(97, TIMEFRAME_MS, 0).slice(1); // 缺失开头的referenceBar
  const q = makeQueryable([], bars15m);
  const referenceBarRef = { symbol: 'ETH', closeTime: 0 + TIMEFRAME_MS - 1 };
  const result = await locatePathForEvaluation(q, { instrument: 'ETHUSDT', referenceBarRef, expectedBarCount: 96, asOfTime: bars15m[bars15m.length - 1].close_time });
  assert.equal(result.actualStartPrice, null);
  assert.equal(result.endpointDataComplete, false);
});
