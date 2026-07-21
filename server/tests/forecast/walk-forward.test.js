import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTimeOrdered, rollingWalkForwardWindows, computeEffectiveSampleCount, computeEffectiveSampleCountByHorizon, checkSampleSufficiency, MIN_SAMPLE_THRESHOLDS } from '../../src/validation/walk-forward.js';

function sample(id, targetStartTime, targetEndTime, horizon = '24h', directionEligibleForStatistics = true, pathEligibleForStatistics = true) {
  return { predictionId: id, targetStartTime, targetEndTime, horizon, directionEligibleForStatistics, pathEligibleForStatistics };
}

test('splitTimeOrdered：严格按targetEndTime分配到训练/验证/测试三区间，不打乱', () => {
  const samples = [sample('a', 0, 100), sample('b', 100, 200), sample('c', 200, 300), sample('d', 300, 400)];
  const { training, validation, test: testSet } = splitTimeOrdered(samples, { trainEnd: 200, validationEnd: 300 });
  assert.deepEqual(training.map(s => s.predictionId), ['a']);
  assert.deepEqual(validation.map(s => s.predictionId), ['b']);
  assert.deepEqual(testSet.map(s => s.predictionId), ['c', 'd']);
});
test('splitTimeOrdered：非法边界拒绝', () => {
  assert.throws(() => splitTimeOrdered([], { trainEnd: 100, validationEnd: 50 }), error => error.code === 'INVALID_SPLIT_BOUNDARIES');
});

test('rollingWalkForwardWindows：按窗口/步长切分测试区间，滚动向前', () => {
  // 窗口成员判据与computeEffectiveSampleCount排序一致，统一用targetEndTime（而非区间重叠）判断样本归属，
  // 保持模块内"排序/分组均以targetEndTime为唯一时间锚点"的一致性（避免同一样本因用途不同而采用不同时间判据）
  const samples = [sample('a', 0, 50), sample('b', 60, 110), sample('c', 150, 200)];
  const windows = rollingWalkForwardWindows(samples, { windowMs: 100, stepMs: 50, testStart: 0, testEnd: 200 });
  assert.equal(windows.length, 3);
  assert.deepEqual(windows[0].samples.map(s => s.predictionId), ['a']); // [0,100): 只有a的targetEndTime=50落入
  assert.deepEqual(windows[1].samples.map(s => s.predictionId), ['a', 'b']); // [50,150): a(50)/b(110)落入
  assert.deepEqual(windows[2].samples.map(s => s.predictionId), ['b']); // [100,200): 仅b(110)落入，c(200)不满足<200右开区间
});

test('computeEffectiveSampleCount：区间调度贪心算法——不重叠样本示例', () => {
  // 三个互不重叠的窗口：[0,100) [100,200) [200,300)
  const samples = [sample('a', 0, 100), sample('b', 100, 200), sample('c', 200, 300)];
  const result = computeEffectiveSampleCount(samples, 'directionEligibleForStatistics');
  assert.equal(result.rawSampleCount, 3);
  assert.equal(result.effectiveSampleCount, 3);
});

test('computeEffectiveSampleCount：高度重叠样本只选出非重叠子集（按targetEndTime排序后贪心选择）', () => {
  // a:[0,100) b:[10,110) c:[100,200)：a与b重叠，c与a不重叠(100>=100)，应选中a和c，不选b
  const samples = [sample('a', 0, 100), sample('b', 10, 110), sample('c', 100, 200)];
  const result = computeEffectiveSampleCount(samples, 'directionEligibleForStatistics');
  assert.equal(result.rawSampleCount, 3);
  assert.equal(result.effectiveSampleCount, 2);
  assert.deepEqual(result.selected.map(s => s.predictionId), ['a', 'c']);
});

test('computeEffectiveSampleCount：targetEndTime相同时按targetStartTime再按predictionId确定性排序（结果可复现）', () => {
  const samples = [sample('z', 50, 200), sample('a', 0, 200), sample('b', 0, 200)];
  const r1 = computeEffectiveSampleCount(samples, 'directionEligibleForStatistics');
  const r2 = computeEffectiveSampleCount([...samples].reverse(), 'directionEligibleForStatistics');
  assert.deepEqual(r1.selected.map(s => s.predictionId), r2.selected.map(s => s.predictionId));
});

test('computeEffectiveSampleCount：只统计eligible=true的样本，方向类/路径类分母独立', () => {
  const samples = [sample('a', 0, 100, '24h', true, false), sample('b', 100, 200, '24h', false, true)];
  const direction = computeEffectiveSampleCount(samples, 'directionEligibleForStatistics');
  const path = computeEffectiveSampleCount(samples, 'pathEligibleForStatistics');
  assert.equal(direction.rawSampleCount, 1);
  assert.equal(path.rawSampleCount, 1);
  assert.notDeepEqual(direction.selected.map(s => s.predictionId), path.selected.map(s => s.predictionId));
});

test('computeEffectiveSampleCountByHorizon：24H/72H分别独立计算，不混合', () => {
  const samples = [sample('a', 0, 100, '24h'), sample('b', 0, 100, '72h'), sample('c', 100, 200, '72h')];
  const result = computeEffectiveSampleCountByHorizon(samples, 'directionEligibleForStatistics');
  assert.equal(result['24h'].rawSampleCount, 1);
  assert.equal(result['72h'].rawSampleCount, 2);
});

test('MIN_SAMPLE_THRESHOLDS：24H=30, 72H=10', () => {
  assert.equal(MIN_SAMPLE_THRESHOLDS['24h'], 30);
  assert.equal(MIN_SAMPLE_THRESHOLDS['72h'], 10);
});
test('checkSampleSufficiency：未达门槛时isCalibrated恒为false且标注样本不足', () => {
  const result = checkSampleSufficiency(5, '24h');
  assert.equal(result.sufficient, false);
  assert.equal(result.isCalibrated, false);
  assert.match(result.disclosure, /样本不足/);
});
test('checkSampleSufficiency：达到门槛时isCalibrated仍恒为false（样本量只是必要条件之一）', () => {
  const result = checkSampleSufficiency(30, '24h');
  assert.equal(result.sufficient, true);
  assert.equal(result.isCalibrated, false);
});
