// R19.1/R19.2：跨边界样本purge——不计入TRAIN/VALIDATION/TEST，但保留在ALL；§1.1冻结管道顺序红线验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { purgeStraddlingSamples, computeSplitEffectiveSamples } from './purge.js';

function sample({ predictionId, targetStartTime, targetEndTime, directionEligibleForStatistics = true }) {
  return { predictionId, horizon: '24h', targetStartTime, targetEndTime, directionEligibleForStatistics };
}

test('R19.1：跨越trainEnd的样本被purge，不计入TRAIN也不计入VALIDATION', () => {
  const trainEnd = 10000, validationEnd = 20000;
  const straddling = sample({ predictionId: 'p-straddle', targetStartTime: 9000, targetEndTime: 11000 }); // 9000<10000<=11000
  const cleanTrain = sample({ predictionId: 'p-train', targetStartTime: 1000, targetEndTime: 5000 });
  const cleanValidation = sample({ predictionId: 'p-validation', targetStartTime: 12000, targetEndTime: 15000 });
  const { purged, purgedStraddlingCount } = purgeStraddlingSamples([straddling, cleanTrain, cleanValidation], { trainEnd, validationEnd });
  assert.equal(purgedStraddlingCount, 1);
  assert.deepEqual(purged.map(s => s.predictionId).sort(), ['p-train', 'p-validation']);
});

test('R19.2：跨越validationEnd的样本同样被purge，不计入VALIDATION也不计入TEST', () => {
  const trainEnd = 10000, validationEnd = 20000;
  const straddling = sample({ predictionId: 'p-straddle', targetStartTime: 19000, targetEndTime: 21000 }); // 19000<20000<=21000
  const cleanTest = sample({ predictionId: 'p-test', targetStartTime: 25000, targetEndTime: 26000 });
  const { purged, purgedStraddlingCount } = purgeStraddlingSamples([straddling, cleanTest], { trainEnd, validationEnd });
  assert.equal(purgedStraddlingCount, 1);
  assert.deepEqual(purged.map(s => s.predictionId), ['p-test']);
});

test('purge后的样本仍保留在report_scope=ALL对应的全局去重集合中（本测试验证computeSplitEffectiveSamples.all不受purge影响）', () => {
  const trainEnd = 10000, validationEnd = 20000;
  const straddling = sample({ predictionId: 'p-straddle', targetStartTime: 9000, targetEndTime: 11000 });
  const clean = sample({ predictionId: 'p-clean', targetStartTime: 1000, targetEndTime: 5000 });
  const result = computeSplitEffectiveSamples([straddling, clean], { eligibilityField: 'directionEligibleForStatistics', trainEnd, validationEnd });
  assert.equal(result.all.length, 2, 'ALL视图（全局去重后、purge前）必须包含跨界样本');
  assert.equal(result.purgedStraddlingCount, 1);
  assert.deepEqual(result.training.map(s => s.predictionId), ['p-clean']);
  assert.deepEqual(result.validation, []);
});

test('未传trainEnd/validationEnd时只产出全局去重结果，不做三段切分', () => {
  const s1 = sample({ predictionId: 'p1', targetStartTime: 1000, targetEndTime: 2000 });
  const result = computeSplitEffectiveSamples([s1], { eligibilityField: 'directionEligibleForStatistics' });
  assert.equal(result.purgedStraddlingCount, 0);
  assert.equal(result.training, null);
  assert.equal(result.all.length, 1);
});

test('冻结管道顺序：全局贪心去重发生在purge之前——构造一个跨界样本与train内样本重叠的场景，验证全局去重优先于分桶', () => {
  // 两个样本的targetStartTime/targetEndTime区间重叠(违反区间调度不重叠要求)：
  // sA完全落在train内；sB跨越trainEnd。若"先分桶再各自贪心"，sA会独立通过train桶的贪心检验(桶内只有它自己)；
  // 若"先全局贪心再purge"（冻结顺序），全局贪心会按targetEndTime排序发现sA与sB重叠、其中一个被贪心算法剔除，
  // 剩下的可能因straddle被purge——两种实现顺序对"最终train样本数"可能给出不同答案，此处验证冻结顺序的实际行为。
  const trainEnd = 10000, validationEnd = 20000;
  const sA = sample({ predictionId: 'p-a', targetStartTime: 1000, targetEndTime: 9500 }); // 完全落在train内
  const sB = sample({ predictionId: 'p-b', targetStartTime: 9200, targetEndTime: 10500 }); // 与sA重叠，且跨越trainEnd
  const result = computeSplitEffectiveSamples([sA, sB], { eligibilityField: 'directionEligibleForStatistics', trainEnd, validationEnd });
  // 全局贪心按targetEndTime升序：sA(9500)先入选；sB(10500)因targetStartTime(9200)<lastSelected.targetEndTime(9500)而被跳过。
  assert.equal(result.all.length, 1);
  assert.deepEqual(result.all.map(s => s.predictionId), ['p-a']);
  assert.equal(result.purgedStraddlingCount, 0, 'sB已在全局贪心阶段被剔除，不会进入purge统计（不重复计数）');
  assert.deepEqual(result.training.map(s => s.predictionId), ['p-a']);
});
