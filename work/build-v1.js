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
  .replace("function render(d){", "function render(d){if(d.dataHealth!=='normal'){window.invalidateDashboard?.(d.dataHealth==='delayed'?'数据陈旧或时间不同步':'关键周期缺失或数据失效',d);return;}document.querySelectorAll('.invalidated').forEach(n=>n.classList.remove('invalidated'));")
  .replace("if(cache.partial)d.warnings.push('部分API失败：'+cache.failed.join(', '));render(d);", "if(cache.partial)throw Error('关键周期缺失：'+cache.failed.join(', '));render(d);")
  .replace("}catch(e){$('health').className='banner invalid';", "}catch(e){window.invalidateDashboard?.(e.message);$('health').className='banner invalid';")
  .replace("showLogs();}function showLogs()", "showLogs();document.dispatchEvent(new CustomEvent('v11decision',{detail:d}));}function showLogs()");
const core=fs.readFileSync(path.join(root,'v1-core.js'),'utf8').replace(/<\/script/gi,'<\\/script');
fs.writeFileSync(path.join(root,'eth-dynamic-trading-dashboard.html'),template.replace('/*__CORE__*/',core));
console.log('built eth-dynamic-trading-dashboard.html');
