'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
let template=fs.readFileSync(path.join(__dirname,'v1-ui.template.html'),'utf8');
template=template
  .replace('ETH ALPHA · V1 REST DECISION CORE','ETH Alpha · V1 多周期REST决策核心')
  .replaceAll('4H','4小时')
  .replace("};function zones(a){", "};const zhTrend={up:'上涨',down:'下跌',flat:'横盘'},zhAlign={support:'支持',conflict:'冲突',neutral:'中性'},zhTier={none:'暂未触发',warning:'风险提示',confirmation_failed:'确认失败'},zhVolume={expanded:'成交量放大',normal:'成交量正常',contracted:'成交量收缩',high_volume_stall:'放量滞涨',unavailable:'成交量不可用'},zhConfidence={high:'高可信度',medium:'中可信度',low:'低可信度'},zhHealth={normal:'正常',delayed:'延迟',invalid:'失效'};function zones(a){")
  .replace("${z.confidence} · ${z.source} · Swing ${z.sourceSwingCount}个", "${zhConfidence[z.confidence]||z.confidence} · ${z.sourceLabel} · 摆动点 ${z.sourceSwingCount}个")
  .replace("`趋势 ${d.htf4h.trend}", "`趋势 ${zhTrend[d.htf4h.trend]||d.htf4h.trend}")
  .replace("`趋势 ${d.mtf1h.trend}", "`趋势 ${zhTrend[d.mtf1h.trend]||d.mtf1h.trend}")
  .replace("'BTC联动：'+d.btcAlignment", "'BTC联动：'+(zhAlign[d.btcAlignment]||d.btcAlignment)")
  .replace("d.falseBreakoutTier;$('falseBreakout')", "zhTier[d.falseBreakoutTier]||d.falseBreakoutTier;$('falseBreakout')")
  .replace("`${d.volumeQuality.label} · ${d.volumeQuality.evidence.join(' · ')}`", "`${zhVolume[d.volumeQuality.label]||d.volumeQuality.label} · ${d.volumeQuality.evidence.join(' · ')}`")
  .replace("${x.dataHealth} / ${x.worthBetting?'值得':'不下注'}", "${zhHealth[x.dataHealth]||x.dataHealth} / ${x.worthBetting?'值得':'不下注'}")
  .replace("function render(d){", "function render(d){if(d.dataHealth!=='normal'&&!d.isManual){window.invalidateDashboard?.(d.dataHealth==='delayed'?'数据陈旧或时间不同步':'关键周期缺失或数据失效',d);return;}document.querySelectorAll('.invalidated').forEach(n=>n.classList.remove('invalidated'));")
  .replace("$('score').textContent=d.score.total;", "$('score').textContent=d.score.overriddenByHardRule?'不可执行':d.score.effectiveTotal;")
  .replace("$('worth').textContent=d.worthBetting?'值得（仍需风控）':'不值得';", "$('worth').textContent=d.isManual?'禁止参与':d.worthBetting?'值得（仍需风控）':'不值得';")
  .replace("$('stop').textContent=fmt(d.stopLoss);$('targets').textContent=d.targets.map(fmt).join(' / ');", "$('stop').textContent=d.isManual?'手动模式不计算':fmt(d.stopLoss);$('targets').textContent=d.isManual?'手动模式不计算':d.targets.map(fmt).join(' / ');")
  .replace("d.isManual?'手动模式（近似值）：4h/1h不可用，实时建议已阻断。'", "d.isManual?'手动观察模式：数据不完整，仅用于查看近似支撑压力，不生成交易建议。缺少完整K线、ATR、成交量和多周期确认，因此不计算止损、目标、盈亏比、仓位或加仓条件。'")
  .replace("prev={ltf:d.state,mtf:d.mtfState,htf:d.htfState};const log=C.buildDecisionLogEntry(d);d.decisionLogId=log.id;C.saveDecisionLog(log,localStorage);", "if(!d.isManual){prev={ltf:d.state,mtf:d.mtfState,htf:d.htfState};const log=C.buildDecisionLogEntry(d);d.decisionLogId=log.id;C.saveDecisionLog(log,localStorage);}")
  .replace("if(cache.partial)d.warnings.push('部分API失败：'+cache.failed.join(', '));render(d);", "if(cache.partial)throw Error('关键周期缺失：'+cache.failed.join(', '));render(d);")
  .replace("}catch(e){$('health').className='banner invalid';", "}catch(e){window.invalidateDashboard?.(e.message);$('health').className='banner invalid';")
  .replaceAll('手动近似模式','手动观察模式')
  .replace("showLogs();}function showLogs()", "showLogs();document.dispatchEvent(new CustomEvent('v11decision',{detail:d}));}function showLogs()")
  .replace("showLogs();refresh();setInterval", "window.renderDashboard=render;showLogs();refresh();setInterval");
const core=fs.readFileSync(path.join(root,'v1-core.js'),'utf8').replace(/<\/script/gi,'<\\/script');
fs.writeFileSync(path.join(root,'eth-dynamic-trading-dashboard.html'),template.replace('/*__CORE__*/',core));
console.log('built eth-dynamic-trading-dashboard.html');
