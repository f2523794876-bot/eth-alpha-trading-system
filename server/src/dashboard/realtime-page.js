// 实时看板用户入口页面——自包含HTML+内联JS，客户端只调用本服务自己的
// GET /api/v1/dashboard/realtime（不直连Binance，不建立第二套数据通道）。
// 展示严格分三层：实时市场状态 / 24H·72H方向预测（UP/DOWN/RANGE） / 交易许可——
// 交易许可区块与方向预测区块彼此独立渲染，交易许可为BLOCK/OBSERVE时方向预测区块不隐藏、不清空。
export const REALTIME_DASHBOARD_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ETH Alpha 实时看板</title>
<style>
  :root{color-scheme:light dark;--bg:#0b0e14;--card:#151a24;--border:#262d3d;--text:#e6e9f0;--muted:#8892a6;--up:#2ecc71;--down:#e74c3c;--range:#f1c40f;--accent:#4a9eff;}
  *{box-sizing:border-box;}
  body{margin:0;padding:24px;background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}
  h1{font-size:20px;margin:0 0 16px;}
  h2{font-size:15px;margin:0 0 10px;color:var(--muted);font-weight:600;}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));}
  .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;}
  .price{font-size:32px;font-weight:700;}
  .change-up{color:var(--up);}.change-down{color:var(--down);}.change-flat{color:var(--muted);}
  .row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px dashed var(--border);}
  .row:last-child{border-bottom:none;}
  .label{color:var(--muted);}
  .badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600;}
  .badge-up{background:rgba(46,204,113,.15);color:var(--up);}
  .badge-down{background:rgba(231,76,60,.15);color:var(--down);}
  .badge-range{background:rgba(241,196,15,.15);color:var(--range);}
  .badge-block{background:rgba(231,76,60,.2);color:var(--down);}
  .badge-observe{background:rgba(74,158,255,.15);color:var(--accent);}
  .badge-allow{background:rgba(46,204,113,.2);color:var(--up);}
  .muted{color:var(--muted);}
  .direction-block{border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:8px;}
  .footer{margin-top:16px;font-size:12px;color:var(--muted);}
</style>
</head>
<body>
<h1>ETH Alpha 实时看板<span id="statusTag" class="muted"></span></h1>
<div class="grid">
  <div class="card" id="marketCard"><h2>实时市场状态</h2><div id="marketBody">加载中…</div></div>
  <div class="card" id="permissionCard"><h2>交易许可（不代表方向预测，方向预测独立展示于下方）</h2><div id="permissionBody">加载中…</div></div>
</div>
<div class="grid" style="margin-top:16px;">
  <div class="card"><h2>24H 预测</h2><div id="forecast24h">加载中…</div></div>
  <div class="card"><h2>72H 预测</h2><div id="forecast72h">加载中…</div></div>
</div>
<div class="footer" id="footer"></div>
<script>
const NA = v => (v === null || v === undefined || v === 'INSUFFICIENT_DATA' || v === 'NOT_YET_GENERATED') ? null : v;
const fmtPrice = v => NA(v) === null ? '数据不足' : Number(v).toFixed(2);
const fmtPct = v => NA(v) === null ? '数据不足' : (Number(v) * 100).toFixed(2) + '%';
const fmtSignedPct = v => { const n = NA(v); if (n === null) return '数据不足'; const p = (n * 100).toFixed(2); return (n >= 0 ? '+' : '') + p + '%'; };
const fmtTime = ms => NA(ms) === null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const fmtZone = z => (!Array.isArray(z) || z.length !== 2) ? '数据不足' : fmtPrice(z[0]) + ' ~ ' + fmtPrice(z[1]);
const fmtText = v => NA(v) === null ? (v === 'NOT_YET_GENERATED' ? '尚未生成' : '数据不足') : v;

function renderMarket(m) {
  if (!m || m.status === 'INSUFFICIENT_DATA') return '<div class="muted">当前价格数据不足</div>';
  const dir = m.changeAbs > 0 ? 'up' : m.changeAbs < 0 ? 'down' : 'flat';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·';
  return \`
    <div class="price change-\${dir}">\${fmtPrice(m.price)} <span style="font-size:16px;">\${arrow} \${fmtSignedPct(m.changePct)}</span></div>
    <div class="row"><span class="label">涨跌额</span><span>\${m.changeAbs >= 0 ? '+' : ''}\${fmtPrice(m.changeAbs)}</span></div>
    <div class="row"><span class="label">比较基准</span><span>上一根已完成15m K线收盘价 \${fmtPrice(m.changeBasis && m.changeBasis.closePrice)}（\${fmtTime(m.changeBasis && m.changeBasis.closeTime)}）</span></div>
    <div class="row"><span class="label">变化速度/动量</span><span>\${fmtText(m.momentum)}</span></div>
    <div class="row"><span class="label">价格来源</span><span>\${m.priceSource === 'LIVE_PROVISIONAL_CANDLE' ? '当前进行中K线' : '最近已完成K线'}</span></div>
    <div class="row"><span class="label">数据时间</span><span>\${fmtTime(m.dataTime)}</span></div>
  \`;
}

function renderPermission(t) {
  if (!t) return '<div class="muted">数据不足</div>';
  const cls = { ALLOW: 'badge-allow', PREPARE: 'badge-allow', OBSERVE: 'badge-observe', BLOCK: 'badge-block' }[t.mode] || 'badge-observe';
  return \`<div><span class="badge \${cls}">\${t.mode}</span></div><div class="row"><span class="label">原因</span><span>\${t.reason}</span></div><div class="row"><span class="label">说明</span><span>\${t.detail}</span></div>\`;
}

function renderDirection(label, cls, d) {
  return \`<div class="direction-block"><div><span class="badge \${cls}">\${label}</span> 概率 \${fmtPct(d.probabilityPct)}</div>
    <div class="row"><span class="label">目标区间</span><span>\${fmtZone(d.targetZone || (d.upperBound !== undefined ? [d.lowerBound, d.upperBound] : null))}</span></div>
    <div class="row"><span class="label">预计空间</span><span>\${d.expectedMovePct !== undefined ? fmtSignedPct(Array.isArray(d.expectedMovePct) ? d.expectedMovePct[1] : d.expectedMovePct) : '数据不足'}</span></div>
    <div class="row"><span class="label">触发条件</span><span>\${fmtText(d.triggerCondition)}</span></div>
    <div class="row"><span class="label">失效条件</span><span>\${fmtText(d.invalidationCondition)}</span></div>
  </div>\`;
}

function renderForecast(f) {
  if (!f || f.status === 'NOT_YET_GENERATED') return '<div class="muted">尚未生成</div>';
  const staleTag = f.status === 'EXPIRED_AWAITING_NEXT_GENERATION' ? '<span class="badge badge-block">已过期，等待下一次正式生成</span>' : '<span class="badge badge-observe">ACTIVE</span>';
  return \`
    <div class="row"><span class="label">状态</span><span>\${staleTag}</span></div>
    <div class="row"><span class="label">参考价</span><span>\${fmtPrice(f.referencePrice)}</span></div>
    <div class="row"><span class="label">概率来源</span><span>\${f.probabilityStatus === 'rule_based' ? '规则型情景权重（非统计校准）' : (f.probabilityStatus || '数据不足')}</span></div>
    <div class="row"><span class="label">生成时间</span><span>\${fmtTime(f.generatedAt)}</span></div>
    <div class="row"><span class="label">到期时间</span><span>\${fmtTime(f.targetEndTime)}</span></div>
    \${renderDirection('UP · 多头', 'badge-up', f.up)}
    \${renderDirection('DOWN · 空头', 'badge-down', f.down)}
    \${renderDirection('RANGE', 'badge-range', f.range)}
  \`;
}

async function refresh() {
  try {
    const res = await fetch('/api/v1/dashboard/realtime?instrument=ETHUSDT', { cache: 'no-store' });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error && body.error.message || '请求失败');
    const data = body.data;
    document.getElementById('marketBody').innerHTML = renderMarket(data.marketState);
    document.getElementById('permissionBody').innerHTML = renderPermission(data.tradingPermission);
    document.getElementById('forecast24h').innerHTML = renderForecast(data.forecast24h);
    document.getElementById('forecast72h').innerHTML = renderForecast(data.forecast72h);
    document.getElementById('statusTag').textContent = ' · 数据健康 ' + (data.dataHealth.ok ? '正常' : data.dataHealth.status || '异常');
    document.getElementById('footer').textContent = '最后刷新：' + new Date(data.generatedAt).toISOString();
  } catch (err) {
    document.getElementById('footer').textContent = '刷新失败：' + err.message;
  }
}
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>
`;
