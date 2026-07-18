'use strict';const assert=require('node:assert/strict'),V=require('../v1_4-gmkg-validation-core.js');let passed=0,failed=0;function t(n,f){try{f();passed++;console.log('PASS '+n)}catch(e){failed++;console.error('FAIL '+n+': '+e.message)}}
const samples=[{predictionId:'c',generatedAt:30},{predictionId:'a',generatedAt:10},{predictionId:'b',generatedAt:20}];
t('时间切分不打乱',()=>{const s=V.splitByTime(samples,10,20);assert.deepEqual(s.training.map(x=>x.predictionId),['a']);assert.deepEqual(s.validation.map(x=>x.predictionId),['b']);assert.deepEqual(s.test.map(x=>x.predictionId),['c'])});
t('时间切分结果冻结',()=>assert.ok(Object.isFrozen(V.splitByTime(samples,10,20))));
const intervals=[{predictionId:'a',instrument:'ETH',horizon:'24h',targetStartTime:0,targetEndTime:10,directionEligibleForStatistics:true,pathEligibleForStatistics:true},{predictionId:'b',instrument:'ETH',horizon:'24h',targetStartTime:5,targetEndTime:12,directionEligibleForStatistics:true,pathEligibleForStatistics:false},{predictionId:'c',instrument:'ETH',horizon:'24h',targetStartTime:10,targetEndTime:20,directionEligibleForStatistics:true,pathEligibleForStatistics:true},{predictionId:'d',instrument:'ETH',horizon:'72h',targetStartTime:0,targetEndTime:30,directionEligibleForStatistics:true,pathEligibleForStatistics:true}];
t('标准区间调度按结束时间',()=>assert.deepEqual(V.computeEffectiveSampleCount(intervals,'ETH','24h','directionEligibleForStatistics').selectedSampleIds,['a','c']));
t('方向原始分母3',()=>assert.equal(V.computeEffectiveSampleCount(intervals,'ETH','24h','directionEligibleForStatistics').rawSampleCount,3));
t('路径原始分母2',()=>assert.equal(V.computeEffectiveSampleCount(intervals,'ETH','24h','pathEligibleForStatistics').rawSampleCount,2));
t('时窗不混合',()=>assert.deepEqual(V.computeEffectiveSampleCount(intervals,'ETH','72h','directionEligibleForStatistics').selectedSampleIds,['d']));
t('非法分母字段拒绝',()=>assert.throws(()=>V.computeEffectiveSampleCount(intervals,'ETH','24h','x'),/INVALID/));
const snap={predictionId:'p',proxyState:'PO_TREND_UP_STRUCTURE',directionThreshold:.02},good={outcomeEventId:'o',endpointDataComplete:true,pathDataComplete:true,pathEligibleForStatistics:true,actualDirection:'DOWN',actualReturn:-.08,expectedEnvelopeTouched:false,realizedRangeInsideExpectedEnvelope:false,exclusionReasons:[]};
t('价格区间错误归因',()=>assert.equal(V.attributeError(snap,good).primaryCause,'price_zone_error'));
t('数据缺失优先归因',()=>assert.equal(V.attributeError(snap,{...good,pathDataComplete:false,exclusionReasons:['bar_missing:3']}).primaryCause,'data_missing_or_delayed'));
t('外生冲击恒不可评估',()=>{const a=V.attributeError(snap,good);assert.ok(a.notEvaluableCauses.includes('exogenous_shock'));assert.notEqual(a.primaryCause,'exogenous_shock');assert.ok(!a.secondaryCauses.includes('exogenous_shock'))});
t('极端波动只做中性标记',()=>{const a=V.attributeError(snap,good);assert.equal(a.unexplainedExtremeMove.unexplainedExtremeMove,true);assert.equal(a.unexplainedExtremeMove.thresholdMultiple,3)});
t('归因置信度不超过50',()=>assert.ok(V.attributeError(snap,good).attributionConfidence<=50));
t('归因规则版本固定',()=>assert.equal(V.attributeError(snap,good).attributionRuleVersion,'v1.4-attribution-rule-1'));
t('归因不可变',()=>assert.ok(Object.isFrozen(V.attributeError(snap,good))));
console.log(`RESULT passed=${passed} failed=${failed}`);if(failed)process.exitCode=1;
