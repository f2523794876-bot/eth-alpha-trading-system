// research-availability.js 纯逻辑单元测试：SQL改写正确性（不连接数据库）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchAvailabilityQueryable } from './research-availability.js';

// 直接摘自 server/src/forecast/bar-path-locator.js 的三种真实查询文本形状，
// 保证本测试对着"实际会被传入"的SQL做验证，而不是自造的近似文本。
const SHAPE_A_RECENT_CONTIGUOUS = `SELECT open_time, close_time, open::text, high::text, low::text, close::text, revision_number
     FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name=$2
       AND close_time<=to_timestamp($3/1000.0) AND available_at<=to_timestamp($3/1000.0) AND fetched_at<=to_timestamp($3/1000.0)
     ORDER BY open_time DESC, revision_number DESC
     LIMIT $4`;

const SHAPE_B_EXACT_REFERENCE = `SELECT open_time, close_time, close::text FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name='15m'
       AND close_time=to_timestamp($2/1000.0)
       AND available_at<=to_timestamp($3/1000.0) AND fetched_at<=to_timestamp($3/1000.0)
     ORDER BY revision_number DESC LIMIT 1`;

const SHAPE_C_PATH_RANGE = `SELECT open_time, close_time FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name='15m'
       AND open_time>=to_timestamp($2/1000.0) AND open_time<=to_timestamp($3/1000.0)
       AND close_time<=to_timestamp($4/1000.0) AND available_at<=to_timestamp($4/1000.0) AND fetched_at<=to_timestamp($4/1000.0)
     ORDER BY open_time ASC, revision_number DESC`;

// locatePathForEvaluation()（bar-path-locator.js，评估期专用）的路径范围查询——WHERE子句形状与SHAPE_C相同，
// 但SELECT列不同（多selects high/low/close），是独立的第4种真实调用点文本，与locateReferenceBarAndPath的
// SHAPE_B/SHAPE_C（生成期专用）合计构成P1-2要求覆盖的"4种query shape"。
const SHAPE_D_EVALUATION_PATH_RANGE = `SELECT open_time, close_time, high::text, low::text, close::text FROM market_bars
     WHERE instrument=$1 AND market_type='spot' AND interval_name='15m'
       AND open_time>=to_timestamp($2/1000.0) AND open_time<=to_timestamp($3/1000.0)
       AND close_time<=to_timestamp($4/1000.0) AND available_at<=to_timestamp($4/1000.0) AND fetched_at<=to_timestamp($4/1000.0)
     ORDER BY open_time ASC, revision_number DESC`;

function makeCapturingPool() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
}

test('四种真实query形状均能被识别并改写：available_at子句被丢弃，fetched_at改绑定新参数(replayNowMs)', async () => {
  for (const shape of [SHAPE_A_RECENT_CONTIGUOUS, SHAPE_B_EXACT_REFERENCE, SHAPE_C_PATH_RANGE, SHAPE_D_EVALUATION_PATH_RANGE]) {
    const capturing = makeCapturingPool();
    const replayNowMs = 1_800_000_000_000;
    const queryable = createResearchAvailabilityQueryable(capturing, { replayNowMs });
    const originalParams = shape === SHAPE_A_RECENT_CONTIGUOUS ? ['ETHUSDT', '4h', 1000, 45]
      : shape === SHAPE_B_EXACT_REFERENCE ? ['ETHUSDT', 2000, 2000]
      : ['ETHUSDT', 3000, 4000, 5000];
    await queryable.query(shape, originalParams);

    assert.equal(capturing.calls.length, 1);
    const { sql, params } = capturing.calls[0];
    assert.doesNotMatch(sql, /available_at/, 'available_at子句必须被完全移除');
    assert.match(sql, /fetched_at<=to_timestamp\(\$(\d+)\/1000\.0\)/);
    const fetchedAtParamIndex = Number(sql.match(/fetched_at<=to_timestamp\(\$(\d+)\/1000\.0\)/)[1]);
    assert.equal(params[fetchedAtParamIndex - 1], replayNowMs, 'fetched_at必须绑定replayNowMs而非原asOfTime');
    assert.equal(params.length, originalParams.length + 1, '应恰好新增一个参数(replayNowMs)，不改变原有参数');
    assert.deepEqual(params.slice(0, originalParams.length), originalParams, '原有参数必须原样保留、顺序不变');
  }
});

test('未识别的查询形状fail closed，拒绝盲目转发生产available_at判据', async () => {
  const capturing = makeCapturingPool();
  const queryable = createResearchAvailabilityQueryable(capturing, { replayNowMs: 1_800_000_000_000 });
  await assert.rejects(
    queryable.query('SELECT 1 FROM market_bars WHERE available_at<=to_timestamp($1/1000.0)', [1000]),
    (err) => err.code === 'UNRECOGNIZED_QUERY_SHAPE'
  );
  assert.equal(capturing.calls.length, 0, 'fail closed时不得转发任何查询给底层pool');
});

test('replayNowMs非安全整数时立即fail closed（不得静默使用历史asOfTime代替）', () => {
  assert.throws(() => createResearchAvailabilityQueryable({}, { replayNowMs: undefined }), (err) => err.code === 'INVALID_REPLAY_NOW');
  assert.throws(() => createResearchAvailabilityQueryable({}, { replayNowMs: NaN }), (err) => err.code === 'INVALID_REPLAY_NOW');
});

// P1-2修复（独立复审）：exact-match查询（SHAPE_B/SHAPE_D的姊妹exact-match形状，用真实的SHAPE_B文本，
// 因为SHAPE_B与locatePathForEvaluation()的引用查询文本逐字符相同——见research-availability.js顶部注释）
// 不得只依赖调用者（bar-path-locator.js，冻结复用模块，不可修改）保证closeTime<=asOfTime，
// 必须在本模块内部对该关系做fail-closed强制校验。
test('P1-2：exact-match查询中closeTime<asOfTime——允许，正常转发', async () => {
  const capturing = makeCapturingPool();
  const queryable = createResearchAvailabilityQueryable(capturing, { replayNowMs: 1_800_000_000_000 });
  // SHAPE_B: params = [instrument, closeTime($2), asOfTime($3)]
  await queryable.query(SHAPE_B_EXACT_REFERENCE, ['ETHUSDT', 1000, 2000]);
  assert.equal(capturing.calls.length, 1, 'closeTime<asOfTime时必须正常执行查询');
});

test('P1-2：exact-match查询中closeTime=asOfTime——允许（右闭区间语义），正常转发', async () => {
  const capturing = makeCapturingPool();
  const queryable = createResearchAvailabilityQueryable(capturing, { replayNowMs: 1_800_000_000_000 });
  await queryable.query(SHAPE_B_EXACT_REFERENCE, ['ETHUSDT', 2000, 2000]);
  assert.equal(capturing.calls.length, 1, 'closeTime=asOfTime时必须正常执行查询（与range查询的<=语义一致）');
});

test('P1-2红线：exact-match查询中closeTime>asOfTime——立即fail closed，拒绝发生在查询下发给数据库之前', async () => {
  const capturing = makeCapturingPool();
  const queryable = createResearchAvailabilityQueryable(capturing, { replayNowMs: 1_800_000_000_000 });
  // closeTime($2)=3000 > asOfTime($3)=2000：模拟恶意构造/上游bug产出的"未来"closeTime。
  await assert.rejects(
    queryable.query(SHAPE_B_EXACT_REFERENCE, ['ETHUSDT', 3000, 2000]),
    (err) => err.code === 'EXACT_MATCH_CLOSE_TIME_AFTER_AS_OF_TIME'
  );
  assert.equal(capturing.calls.length, 0, 'fail closed时不得把查询转发给底层pool——恶意构造的未来closeTime数据不能有任何机会被读取');
});

test('P1-2：拒绝仅针对exact-match形状生效，range形状（SHAPE_A/C/D）的close_time<=asOfTime本身已由SQL保证，不受此项额外校验影响', async () => {
  for (const [shape, params] of [
    [SHAPE_A_RECENT_CONTIGUOUS, ['ETHUSDT', '4h', 1000, 45]],
    [SHAPE_C_PATH_RANGE, ['ETHUSDT', 3000, 4000, 5000]],
    [SHAPE_D_EVALUATION_PATH_RANGE, ['ETHUSDT', 3000, 4000, 5000]]
  ]) {
    const capturing = makeCapturingPool();
    const queryable = createResearchAvailabilityQueryable(capturing, { replayNowMs: 1_800_000_000_000 });
    await queryable.query(shape, params);
    assert.equal(capturing.calls.length, 1, `range形状(${shape.slice(0, 20)}...)不应被exact-match校验误拦截`);
  }
});

test('buildResearchDataVintage：产出包含规则版本/asOfTime/消费的bar列表/批次列表/明确声明文本', async () => {
  const { buildResearchDataVintage, RESEARCH_AVAILABILITY_RULE_VERSION } = await import('./research-availability.js');
  const vintage = buildResearchDataVintage({
    barRefs: [{ barKey: 'ETH-15m-1000', closeTime: 1000 }, null, { barKey: 'ETH-15m-2000', closeTime: 2000 }],
    backfillBatchIds: ['b1', 'b1', 'b2'],
    asOfTime: 5000
  });
  assert.equal(vintage.researchAvailabilityRuleVersion, RESEARCH_AVAILABILITY_RULE_VERSION);
  assert.equal(vintage.asOfTime, 5000);
  assert.deepEqual(vintage.consumedBars, [{ barKey: 'ETH-15m-1000', closeTime: 1000 }, { barKey: 'ETH-15m-2000', closeTime: 2000 }]);
  assert.deepEqual(vintage.backfillBatchIds, ['b1', 'b2']);
  assert.match(vintage.disclosure, /not a record of when the system historically\/actually possessed this data/);
});
