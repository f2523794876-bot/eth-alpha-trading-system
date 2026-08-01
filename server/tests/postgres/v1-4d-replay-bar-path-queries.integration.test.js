// P0-3（独立复审）：物理独立的 research 查询层（replay-bar-path-queries.js）真实PostgreSQL验证。
// 目标：证明研究查询①不是通过改写生产SQL实现的，②严格实现 researchAvailability(bar)=close_time 语义
// （不依赖 available_at，依赖 close_time<=asOfTime AND fetched_at<=replayNowMs），③未来数据/未收盘数据/
// 仍在进行中的并发回填批次数据都不能进入回放。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import {
  locateReferenceBarAndPathForReplay, locatePathForEvaluationForReplay,
  computeFourHourAtr14ForReplay, computeConsecutiveBreakoutBarsForReplay
} from '../../src/validation-replay/replay-bar-path-queries.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;
const FIFTEEN_MIN_MS = 900000;
const FOUR_HOUR_MS = 14400000;

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
async function withTxClient(fn) {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const client = await pool.connect();
  try { await client.query('BEGIN'); await fn(client); }
  finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
}

test('P0-3静态核验：replay-bar-path-queries.js 不导入 bar-path-locator.js 的任何查询函数，只导入两个纯计算函数；SQL文本不含available_at', () => {
  const source = readFileSync(join(__dirname, '../../src/validation-replay/replay-bar-path-queries.js'), 'utf8');
  const importMatch = source.match(/import \{([^}]*)\} from ['"]\.\.\/forecast\/bar-path-locator\.js['"];/);
  assert.ok(importMatch, '必须能定位到从bar-path-locator.js的import语句');
  const importedNames = importMatch[1].split(',').map(s => s.trim());
  assert.deepEqual(new Set(importedNames), new Set(['rhythmBoundaryMs', 'computeAlignedReferenceCloseTime']), '只允许共享两个无SQL、无副作用的纯计算函数');
  // available_at允许出现在SELECT列表/审计记录构造中（P1-1审计证据需要它），但绝不允许出现在WHERE可得性判据里
  // （即"available_at<=to_timestamp(...)"这一比较形状）——这才是research/production物理分离要保护的核心。
  // 只扫描代码正文（去掉//注释行，因为顶部说明性注释里为了解释"改之前是什么样"会引用这个历史模式字符串）。
  const codeOnly = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codeOnly, /available_at\s*<=/, 'research查询的WHERE可得性判据中不得出现available_at比较——researchAvailability语义只依赖close_time+fetched_at');
  assert.doesNotMatch(codeOnly, /\.replace\(\s*[A-Z_]+_PATTERN/, '不得包含正则改写SQL的代码路径');
});

test('可得性边界：真实回填行的available_at恒等于回填执行时的墙钟时间（远晚于历史close_time），research查询仍能读到该bar——证明不依赖available_at，与生产查询物理分离的直接证据', { skip }, async () => {
  await withTxClient(async (client) => {
    const replayNowMs = Date.UTC(2026, 4, 10, 0, 0, 0);
    const closeTime = Date.UTC(2026, 4, 1, 0, 0, 0) - 1;
    const openTime = closeTime - FIFTEEN_MIN_MS + 1;
    const adapter = makeMockAdapter({ pages: [[kline(openTime, closeTime)]], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime, now: () => replayNowMs });

    // §2.9冻结裁决：回填协议下 available_at 恒等于"回填任务实际执行的真实系统时间"(replayNowMs)，
    // 与该bar的历史close_time（约9天前）相差巨大——若research查询像生产查询一样检查
    // available_at<=asOfTime(=closeTime)，这条件恒假，该bar永远读不到（这正是backfill spec §2.9指出的
    // "悖论"）。research查询必须完全无视这一列，只用close_time/fetched_at做可得性判断。
    const row = (await client.query(`SELECT available_at, close_time FROM market_bars WHERE instrument='ETHUSDT' AND close_time=to_timestamp($1/1000.0)`, [closeTime])).rows[0];
    assert.ok(new Date(row.available_at).getTime() > closeTime, '前提核验：真实回填行的available_at确实远晚于close_time（悖论场景）');

    const located = await locateReferenceBarAndPathForReplay(client, { instrument: 'ETHUSDT', horizon: '24h', asOfTime: closeTime, replayNowMs, symbol: 'ETH' });
    assert.ok(located.referenceBarRef, 'available_at远晚于close_time(asOfTime)不应影响research查询——它根本不检查这一列，只有生产查询才会因此拒绝该行');
    assert.equal(located.referenceBarRef.closeTime, closeTime);
  });
});

test('并发回填防护：fetched_at晚于replayNowMs的行（仍在进行中的回填批次）必须被排除', { skip }, async () => {
  await withTxClient(async (client) => {
    const replayNowMs = Date.UTC(2026, 4, 10, 0, 0, 0);
    const inFlightFetchedAt = replayNowMs + 3_600_000; // 回填任务在回放发起【之后】才提交完成——不应被本次回放读到
    const closeTime = Date.UTC(2026, 4, 1, 0, 0, 0) - 1;
    const openTime = closeTime - FIFTEEN_MIN_MS + 1;
    const adapter = makeMockAdapter({ pages: [[kline(openTime, closeTime)]], serverTimeMs: inFlightFetchedAt });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime, now: () => inFlightFetchedAt });

    const located = await locateReferenceBarAndPathForReplay(client, { instrument: 'ETHUSDT', horizon: '24h', asOfTime: closeTime, replayNowMs, symbol: 'ETH' });
    assert.equal(located.referenceBarRef, null, 'fetched_at晚于replayNowMs的行代表"回放发起时仍在进行中的回填批次"，必须fail closed为不可得，不得读取');
  });
});

test('未收盘/未来数据防护：路径范围内close_time>asOfTime的bar必须被排除在observedBars之外（进入missingBarRefs）', { skip }, async () => {
  await withTxClient(async (client) => {
    const replayNowMs = Date.UTC(2026, 4, 10, 0, 0, 0);
    const referenceCloseTime = Date.UTC(2026, 4, 1, 0, 0, 0) - 1;
    const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
    const nextOpenTime = referenceCloseTime + 1;
    const nextCloseTime = nextOpenTime + FIFTEEN_MIN_MS - 1;

    const adapter = makeMockAdapter({
      pages: [[kline(referenceOpenTime, referenceCloseTime), kline(nextOpenTime, nextCloseTime)]],
      serverTimeMs: replayNowMs
    });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: referenceOpenTime, endTime: nextOpenTime, now: () => replayNowMs });

    // asOfTime定格在referenceBar收盘后1毫秒——下一根bar（nextCloseTime）此刻按历史时钟而言尚未收盘，
    // 即便它已经存在于market_bars中（真实历史上它当然已经发生），回放层面必须假装"还没到那个时刻"。
    const asOfTime = referenceCloseTime + 1;
    const located = await locateReferenceBarAndPathForReplay(client, { instrument: 'ETHUSDT', horizon: '24h', asOfTime, replayNowMs, symbol: 'ETH' });
    assert.ok(located.referenceBarRef, 'referenceBar本身(closeTime===asOfTime-1+1的对齐点)必须能被定位');
    assert.equal(located.observedBars.length, 0, '尚未到收盘时刻的下一根bar不得出现在observedBars中');
    assert.equal(located.missingBarRefs.length >= 1, true, '未到时刻的bar必须体现为missing（数据缺口），而不是被静默跳过');
    assert.equal(located.missingBarRefs[0].openTime, nextOpenTime);
  });
});

test('右闭区间边界：close_time恰好等于asOfTime时必须被包含（边界值本身是合法的历史时刻）', { skip }, async () => {
  await withTxClient(async (client) => {
    const replayNowMs = Date.UTC(2026, 4, 10, 0, 0, 0);
    const closeTime = Date.UTC(2026, 4, 1, 0, 0, 0) - 1;
    const openTime = closeTime - FIFTEEN_MIN_MS + 1;
    const adapter = makeMockAdapter({ pages: [[kline(openTime, closeTime)]], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: openTime, endTime: openTime, now: () => replayNowMs });

    const located = await locateReferenceBarAndPathForReplay(client, { instrument: 'ETHUSDT', horizon: '24h', asOfTime: closeTime, replayNowMs, symbol: 'ETH' });
    assert.ok(located.referenceBarRef, 'asOfTime===close_time时（右闭区间语义）该bar必须被视为已收盘、可得');
  });
});

test('locatePathForEvaluationForReplay：referenceBarRef.closeTime晚于asOfTime——fail closed，不得下发任何查询', { skip }, async () => {
  await withTxClient(async (client) => {
    let queried = false;
    const spyClient = { query: async (...args) => { queried = true; return client.query(...args); } };
    await assert.rejects(
      locatePathForEvaluationForReplay(spyClient, {
        instrument: 'ETHUSDT', referenceBarRef: { symbol: 'ETH', closeTime: 3000 }, expectedBarCount: 96,
        asOfTime: 2000, replayNowMs: Date.now()
      }),
      (err) => err.code === 'EXACT_MATCH_CLOSE_TIME_AFTER_AS_OF_TIME'
    );
    assert.equal(queried, false, 'fail closed必须发生在任何查询下发给数据库之前');
  });
});

test('computeFourHourAtr14ForReplay/computeConsecutiveBreakoutBarsForReplay：成功时auditRecords覆盖实际消费的4h bar，数据不足时auditRecords为空', { skip }, async () => {
  await withTxClient(async (client) => {
    const replayNowMs = Date.UTC(2026, 4, 10, 0, 0, 0);
    const asOfTime = Date.UTC(2026, 4, 5, 0, 0, 0) - 1;
    const count = 15;
    const bars = [];
    for (let i = count - 1; i >= 0; i--) {
      const closeTime = asOfTime - i * FOUR_HOUR_MS;
      bars.push(kline(closeTime - FOUR_HOUR_MS + 1, closeTime, (1000 + i).toFixed(2)));
    }
    const start = asOfTime - (count - 1) * FOUR_HOUR_MS - FOUR_HOUR_MS + 1;
    const adapter = makeMockAdapter({ pages: [bars], serverTimeMs: replayNowMs });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '4h', startTime: start, endTime: asOfTime, now: () => replayNowMs });

    const atr = await computeFourHourAtr14ForReplay(client, { instrument: 'ETHUSDT', asOfTime, replayNowMs, symbol: 'ETH' });
    assert.equal(atr.ok, true);
    assert.equal(atr.auditRecords.length, 15, 'ATR14成功计算时，必须记录全部15根实际消费的4h bar的审计信息');
    for (const record of atr.auditRecords) {
      for (const field of ['vintageId', 'symbol', 'interval', 'openTime', 'closeTime', 'availableAt', 'fetchedAt', 'sourceId', 'revisionNumber']) {
        assert.ok(field in record, `4h bar审计记录必须包含字段 ${field}`);
      }
    }

    // 数据不足场景：asOfTime往前推得远到没有回填过4h数据的时间点。
    const insufficientAsOfTime = start - 10 * FOUR_HOUR_MS;
    const insufficientAtr = await computeFourHourAtr14ForReplay(client, { instrument: 'ETHUSDT', asOfTime: insufficientAsOfTime, replayNowMs, symbol: 'ETH' });
    assert.equal(insufficientAtr.ok, false);
    assert.deepEqual(insufficientAtr.auditRecords, [], '数据不足(未实际产出ATR结果)时不得虚构任何审计记录');

    const breakout = await computeConsecutiveBreakoutBarsForReplay(client, { instrument: 'ETHUSDT', asOfTime: insufficientAsOfTime, replayNowMs, symbol: 'ETH', direction: 'up' });
    assert.equal(breakout.state, 'INSUFFICIENT_DATA');
    assert.deepEqual(breakout.auditRecords, []);
  });
});
