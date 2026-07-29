// research-availability.js 纯逻辑单元测试（不连接数据库）。
// P0-3修复后，本文件不再测试"SQL文本改写"（该机制已删除，见 replay-bar-path-queries.js 与
// tests/postgres/v1-4d-replay-bar-path-queries.integration.test.js 对物理独立SQL层的验证），
// 只测试仍留在本模块内、与SQL无关的常量与纯函数：RESEARCH_AVAILABILITY_RULE_VERSION、buildResearchDataVintage。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildResearchDataVintage, RESEARCH_AVAILABILITY_RULE_VERSION } from './research-availability.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// P0-3红线核验：本文件（research-availability.js）源码本身不得再包含任何正则改写/生产SQL文本改写的痕迹，
// 也不得导入 bar-path-locator.js（生产查询模块）——物理分离的静态证明之一，不依赖运行时行为。
test('P0-3：research-availability.js 源码不导入 bar-path-locator.js，不含正则改写生产SQL的痕迹', () => {
  const source = readFileSync(join(__dirname, 'research-availability.js'), 'utf8');
  assert.doesNotMatch(source, /from ['"].*bar-path-locator\.js['"]/, 'research-availability.js 不得导入生产查询模块 bar-path-locator.js');
  assert.doesNotMatch(source, /\.replace\(/, '不得包含任何正则/文本替换改写SQL的代码');
  assert.doesNotMatch(source, /RegExp|\/available_at.*fetched_at/, '不得包含用于匹配/改写生产SQL文本的正则表达式');
  assert.doesNotMatch(source, /createResearchAvailabilityQueryable/, '改写生产SQL的queryable包装函数必须已被删除');
});

test('buildResearchDataVintage：产出包含规则版本/asOfTime/去重后的消费bar列表(按vintageId)/批次列表/明确声明文本', () => {
  const auditRecords = [
    { vintageId: 'v-1', barKey: 'ETH-15m-1000', symbol: 'ETH', interval: '15m', openTime: 100, closeTime: 1000, availableAt: 1500, fetchedAt: 1600, sourceId: 'binance', revisionNumber: 0 },
    null,
    { vintageId: 'v-2', barKey: 'ETH-15m-2000', symbol: 'ETH', interval: '15m', openTime: 1100, closeTime: 2000, availableAt: 2500, fetchedAt: 2600, sourceId: 'binance', revisionNumber: 0 },
    // 同一vintageId重复出现（例如ATR窗口与breakout窗口重叠消费了同一根4h bar）——必须被去重，不重复计入consumedBars。
    { vintageId: 'v-1', barKey: 'ETH-15m-1000', symbol: 'ETH', interval: '15m', openTime: 100, closeTime: 1000, availableAt: 1500, fetchedAt: 1600, sourceId: 'binance', revisionNumber: 0 }
  ];
  const vintage = buildResearchDataVintage({ auditRecords, backfillBatchIds: ['b1', 'b1', 'b2'], asOfTime: 5000 });
  assert.equal(vintage.researchAvailabilityRuleVersion, RESEARCH_AVAILABILITY_RULE_VERSION);
  assert.equal(vintage.asOfTime, 5000);
  assert.equal(vintage.consumedBars.length, 2, '重复vintageId必须去重，null条目必须被丢弃');
  assert.deepEqual(new Set(vintage.consumedBars.map(b => b.vintageId)), new Set(['v-1', 'v-2']));
  // P1-1核验：每条consumedBars必须携带完整审计字段，不再是只有{barKey, closeTime}两项。
  for (const bar of vintage.consumedBars) {
    for (const field of ['vintageId', 'barKey', 'symbol', 'interval', 'openTime', 'closeTime', 'availableAt', 'fetchedAt', 'sourceId', 'revisionNumber']) {
      assert.ok(field in bar, `consumedBars每条记录必须包含字段 ${field}`);
    }
  }
  assert.deepEqual(vintage.backfillBatchIds, ['b1', 'b2']);
  assert.match(vintage.disclosure, /not a record of when the system historically\/actually possessed this data/);
});

test('buildResearchDataVintage：未实际消费的K线(无vintageId的占位/缺口BarRef)不会被写入consumedBars', () => {
  const vintage = buildResearchDataVintage({
    auditRecords: [
      { vintageId: 'v-1', barKey: 'ETH-15m-1000', symbol: 'ETH', interval: '15m', openTime: 100, closeTime: 1000, availableAt: 1500, fetchedAt: 1600, sourceId: 'binance', revisionNumber: 0 },
      { barKey: 'ETH-15m-9999-placeholder', symbol: 'ETH', interval: '15m', openTime: 9000, closeTime: 9999 } // 占位BarRef：无vintageId，因为它从未被任何SQL查询实际返回过
    ],
    backfillBatchIds: [],
    asOfTime: 5000
  });
  assert.equal(vintage.consumedBars.length, 1, '缺少vintageId的占位/缺口BarRef不得出现在consumedBars中');
  assert.equal(vintage.consumedBars[0].vintageId, 'v-1');
});

test('buildResearchDataVintage：空输入产出空consumedBars（不报错）', () => {
  const vintage = buildResearchDataVintage({ auditRecords: [], backfillBatchIds: [], asOfTime: 1000 });
  assert.deepEqual(vintage.consumedBars, []);
  assert.deepEqual(vintage.backfillBatchIds, []);
});
