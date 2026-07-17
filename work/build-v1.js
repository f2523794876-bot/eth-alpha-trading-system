'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

function occurrenceCount(source,target){if(!target)throw Error('构建替换目标不能为空');return source.split(target).length-1;}
function replaceExact(source,target,replacement,expected=1,label=target){const actual=occurrenceCount(source,target);if(actual!==expected)throw Error(`构建替换失配：${label}，预期 ${expected} 处，实际 ${actual} 处`);return source.split(target).join(replacement);}

function build(){
  let template=fs.readFileSync(path.join(__dirname,'v1-ui.template.html'),'utf8');
  const paperUi=fs.readFileSync(path.join(__dirname,'v1-paper-trading.template.html'),'utf8');
  const signalUi=fs.readFileSync(path.join(__dirname,'v1-signal-archive.template.html'),'utf8');
  const autoUi=fs.readFileSync(path.join(__dirname,'v1-auto-engine.template.html'),'utf8');
  const diagnosticsUi=fs.readFileSync(path.join(__dirname,'v1-trade-gate-diagnostics.template.html'),'utf8');
  const replacements=[
    ['ETH ALPHA · V1 REST DECISION CORE','ETH Alpha · V1 多周期REST决策核心',1,'页面标题'],
    ['4H','4小时',6,'4H中文化'],
    ['};function zones(a){',"};const zhTrend={up:'上涨',down:'下跌',flat:'横盘'},zhAlign={support:'支持',conflict:'冲突',neutral:'中性'},zhTier={none:'暂未触发',warning:'风险提示',confirmation_failed:'确认失败'},zhVolume={expanded:'成交量放大',normal:'成交量正常',contracted:'成交量收缩',high_volume_stall:'放量滞涨',unavailable:'成交量不可用'},zhConfidence={high:'高可信度',medium:'中可信度',low:'低可信度'},zhHealth={normal:'正常',delayed:'延迟',invalid:'失效'};function zones(a){",1,'中文枚举注入'],
    ['${z.confidence} · ${z.source} · Swing ${z.sourceSwingCount}个','${zhConfidence[z.confidence]||z.confidence} · ${z.sourceLabel} · 摆动点 ${z.sourceSwingCount}个',1,'区域标签中文化'],
    ['`趋势 ${d.htf4h.trend}','`趋势 ${zhTrend[d.htf4h.trend]||d.htf4h.trend}',1,'4小时趋势中文化'],
    ['`趋势 ${d.mtf1h.trend}','`趋势 ${zhTrend[d.mtf1h.trend]||d.mtf1h.trend}',1,'1小时趋势中文化'],
    ["'BTC联动：'+d.btcAlignment","'BTC联动：'+(zhAlign[d.btcAlignment]||d.btcAlignment)",1,'BTC联动中文化'],
    ["d.falseBreakoutTier;$('falseBreakout')","zhTier[d.falseBreakoutTier]||d.falseBreakoutTier;$('falseBreakout')",1,'假突破中文化'],
    ["`${d.volumeQuality.label} · ${d.volumeQuality.evidence.join(' · ')}`","`${zhVolume[d.volumeQuality.label]||d.volumeQuality.label} · ${d.volumeQuality.evidence.join(' · ')}`",1,'成交量中文化'],
    ["${x.dataHealth} / ${x.worthBetting?'值得':'不下注'}","${zhHealth[x.dataHealth]||x.dataHealth} / ${x.worthBetting?'值得':'不下注'}",1,'日志健康状态中文化'],
    ['function render(d){',"function render(d){if(d.dataHealth!=='normal'&&!d.isManual){window.invalidateDashboard?.(d.dataHealth==='delayed'?'数据陈旧或时间不同步':'关键周期缺失或数据失效',d);return;}document.querySelectorAll('.invalidated').forEach(n=>n.classList.remove('invalidated'));",1,'统一数据失效守卫'],
    ["$('score').textContent=d.score.total;","$('score').textContent=d.score.overriddenByHardRule?'不可执行':d.score.effectiveTotal;",1,'硬性否决总评分'],
    ["$('worth').textContent=d.worthBetting?'值得（仍需风控）':'不值得';","$('worth').textContent=d.isManual?'禁止参与':d.worthBetting?'值得（仍需风控）':'不值得';",1,'手动模式下注阻断'],
    ["$('stop').textContent=fmt(d.stopLoss);$('targets').textContent=d.targets.map(fmt).join(' / ');","$('stop').textContent=d.isManual?'手动模式不计算':fmt(d.stopLoss);$('targets').textContent=d.isManual?'手动模式不计算':d.targets.map(fmt).join(' / ');",1,'手动止损目标阻断'],
    ["d.isManual?'手动模式（近似值）：4h/1h不可用，实时建议已阻断。'","d.isManual?'手动观察模式：数据不完整，仅用于查看近似支撑压力，不生成交易建议。缺少完整K线、ATR、成交量和多周期确认，因此不计算止损、目标、盈亏比、仓位或加仓条件。'",1,'手动观察说明'],
    ["prev={ltf:d.state,mtf:d.mtfState,htf:d.htfState};const log=C.buildDecisionLogEntry(d);d.decisionLogId=log.id;C.saveDecisionLog(log,localStorage);","if(!d.isManual){prev={ltf:d.state,mtf:d.mtfState,htf:d.htfState};const log=C.buildDecisionLogEntry(d);d.decisionLogId=log.id;C.saveDecisionLog(log,localStorage);}",1,'手动日志阻断'],
    ["if(cache.partial)d.warnings.push('部分API失败：'+cache.failed.join(', '));render(d);","if(cache.partial)throw Error('关键周期缺失：'+cache.failed.join(', '));render(d);",1,'部分数据失败阻断'],
    ["}catch(e){$('health').className='banner invalid';","}catch(e){window.invalidateDashboard?.(e.message);$('health').className='banner invalid';",1,'刷新异常失效'],
    ['手动近似模式','手动观察模式',1,'手动模式术语'],
    ["showLogs();}function showLogs()","showLogs();document.dispatchEvent(new CustomEvent('v11decision',{detail:d}));}function showLogs()",1,'V1.1决策事件'],
    ['showLogs();refresh();setInterval','window.renderDashboard=render;showLogs();refresh();setInterval',1,'渲染函数暴露'],
    ['cache=await C.fetchAllTimeframeKlines();const d=','cache=await C.fetchAllTimeframeKlines();window.__lastMarketData=cache;const d=',1,'市场数据生产接线']
    ,['C.invalidateDashboard(id=>$(id),k,reason);',"C.invalidateDashboard(id=>$(id),k,reason);['paperEquity','paperAvailable','paperMargin','paperAccounting','paperRisk','paperPosition','paperLogs','paperExportJson','paperExportCsv','paperReset','paperEmergencyClose','paperGapSettle','signalArchiveList','signalExportJson','signalExportCsv','signalReset','shadowStats','autoEngineState','autoAllowEntries','autoHeartbeat','autoGap','autoNextAction','autoArm','autoPause','autoResume','autoToggleEntries','autoDisarm','gateData','gatePermission','gatePlans','gateConclusion','gateReasons','gateStats','gateStorageWarning','gateExportJson','gateExportCsv'].forEach(id=>$(id)?.classList.add('invalidated'));",1,'V1.3数据字段统一失效样式']
  ];
  for(const [target,replacement,expected,label] of replacements)template=replaceExact(template,target,replacement,expected,label);
  template=replaceExact(template,'/*__PAPER_TRADING_UI__*/',paperUi,1,'V1.3模拟账户UI占位符');
  template=replaceExact(template,'/*__SIGNAL_ARCHIVE_UI__*/',signalUi,1,'V1.3建议档案UI占位符');
  template=replaceExact(template,'/*__AUTO_ENGINE_UI__*/',autoUi,1,'V1.3自动引擎UI占位符');
  template=replaceExact(template,'/*__TRADE_GATE_DIAGNOSTICS_UI__*/',diagnosticsUi,1,'V1.3.1自动交易诊断UI占位符');
  const core=fs.readFileSync(path.join(root,'v1-core.js'),'utf8').replace(/<\/script/gi,'<\\/script');
  const forecast=fs.readFileSync(path.join(root,'v1_2-forecast-core.js'),'utf8').replace(/<\/script/gi,'<\\/script');
  const paper=fs.readFileSync(path.join(root,'v1_3-paper-trading-core.js'),'utf8').replace(/<\/script/gi,'<\\/script');
  const signal=fs.readFileSync(path.join(root,'v1_3-signal-archive-core.js'),'utf8').replace(/<\/script/gi,'<\\/script');
  const auto=fs.readFileSync(path.join(root,'v1_3-auto-engine-core.js'),'utf8').replace(/<\/script/gi,'<\\/script');
  const diagnostics=fs.readFileSync(path.join(root,'v1_3-trade-gate-diagnostics.js'),'utf8').replace(/<\/script/gi,'<\\/script');
  template=replaceExact(template,'/*__CORE__*/',core,1,'V1.1核心占位符');
  template=replaceExact(template,'/*__FORECAST__*/',forecast,1,'V1.2预测核心占位符');
  template=replaceExact(template,'/*__PAPER_TRADING__*/',paper,1,'V1.3模拟账户核心占位符');
  template=replaceExact(template,'/*__SIGNAL_ARCHIVE__*/',signal,1,'V1.3建议档案核心占位符');
  template=replaceExact(template,'/*__AUTO_ENGINE__*/',auto,1,'V1.3自动引擎核心占位符');
  template=replaceExact(template,'/*__TRADE_GATE_DIAGNOSTICS__*/',diagnostics,1,'V1.3.1自动交易诊断核心占位符');
  fs.writeFileSync(path.join(root,'eth-dynamic-trading-dashboard.html'),template);
  console.log('built eth-dynamic-trading-dashboard.html');
}

if(require.main===module)build();
module.exports={occurrenceCount,replaceExact,build};
