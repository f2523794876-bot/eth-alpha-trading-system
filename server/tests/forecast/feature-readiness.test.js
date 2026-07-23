import test from 'node:test';
import assert from 'node:assert/strict';
import { ForecastGenerator } from '../../src/forecast/generator-service.js';
import { FEATURE_SET_VERSION } from '../../src/features/feature-version.js';

const CLOSE = 1_784_400_000_000;
const create = ({ rows = [], attempts = 3 } = {}) => {
  let calls = 0;
  const client = {
    async query(sql, params) {
      calls += 1;
      assert.match(sql, /target_bar_close_time=to_timestamp\(\$2\/1000\.0\)/);
      assert.equal(params[0], 'ETHUSDT');
      assert.equal(params[1], CLOSE);
      assert.equal(params[3], FEATURE_SET_VERSION);
      return { rows: rows[calls - 1] || [] };
    }
  };
  const generator = new ForecastGenerator({
    pool: {}, holderId: 'forecast', serverTimeProvider: async () => ({ ok: true, sourceServerTime: CLOSE + 1000 }),
    featureWaitMs: 1, featureWaitAttempts: attempts
  });
  return { generator, client, calls: () => calls };
};

test('预测仅消费与referenceBar完全相同时间键的特征', async () => {
  const feature = { feature_record_id: 7, feature_values: {}, quality_state: 'HEALTHY', completeness: 1 };
  const { generator, client, calls } = create({ rows: [[feature]] });
  const result = await generator.waitForExactFeature(client, { instrument: 'ETHUSDT', targetBarCloseTime: CLOSE, asOfTime: CLOSE + 1000 });
  assert.equal(result.row, feature);
  assert.equal(result.attempts, 1);
  assert.equal(calls(), 1);
});

test('特征稍晚完成时预测有界重试后继续，不依赖同频定时器碰巧排序', async () => {
  const feature = { feature_record_id: 8 };
  const { generator, client, calls } = create({ rows: [[], [feature]], attempts: 4 });
  const result = await generator.waitForExactFeature(client, { instrument: 'ETHUSDT', targetBarCloseTime: CLOSE, asOfTime: CLOSE + 1000 });
  assert.equal(result.row, feature);
  assert.equal(result.attempts, 2);
  assert.equal(calls(), 2);
});

test('达到等待上限仍无特征时返回null并由正式流程fail closed', async () => {
  const { generator, client, calls } = create({ rows: [[], [], []], attempts: 3 });
  const result = await generator.waitForExactFeature(client, { instrument: 'ETHUSDT', targetBarCloseTime: CLOSE, asOfTime: CLOSE + 1000 });
  assert.equal(result.row, null);
  assert.equal(result.attempts, 3);
  assert.equal(calls(), 3);
});

test('服务停止会中断特征等待，不无限等待', async () => {
  const { generator, client } = create({ rows: [[], []], attempts: 3 });
  generator.featureWaitMs = 10_000;
  const waiting = generator.waitForExactFeature(client, { instrument: 'ETHUSDT', targetBarCloseTime: CLOSE, asOfTime: CLOSE + 1000 });
  await new Promise(resolve => setImmediate(resolve));
  await generator.stop();
  await assert.rejects(waiting, error => error.code === 'FORECAST_GENERATOR_STOPPING');
});
