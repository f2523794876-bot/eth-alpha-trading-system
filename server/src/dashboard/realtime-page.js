// 实时看板用户入口页面——自包含HTML+内联JS，客户端只调用本服务自己的
// GET /api/v1/dashboard/realtime（不直连Binance，不建立第二套数据通道）。
// 展示严格分三层：实时市场状态 / 24H·72H方向预测（UP/DOWN/RANGE） / 展示态参考执行状态——
// 参考执行状态区块与方向预测区块彼此独立渲染，为BLOCK/OBSERVE时方向预测区块不隐藏、不清空。
//
// P1-4修复（独立复审）：渲染函数（含HTML转义）不在本文件内重复实现，而是从realtime-page-render.js
// 原样取用（RENDER_FUNCTIONS里每个函数的.toString()），保证发给浏览器的代码与被单元测试覆盖的代码
// 是同一份源码——本文件只负责静态页面骨架、CSS与"调用这些渲染函数+写入DOM"的胶水代码，胶水代码本身
// 不直接拼接任何来自API响应的原始字段（全部经上述已转义的渲染函数处理后才落地为HTML）。
import { RENDER_FUNCTIONS } from './realtime-page-render.js';

const RENDER_FUNCTIONS_SOURCE = RENDER_FUNCTIONS.map(fn => fn.toString()).join('\n');

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
  .row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px dashed var(--border);gap:12px;}
  .row:last-child{border-bottom:none;}
  .label{color:var(--muted);white-space:nowrap;}
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
  <div class="card" id="referenceStateCard"><h2>展示态参考执行状态（非正式交易许可引擎，不代表方向预测，方向预测独立展示于下方）</h2><div id="referenceStateBody">加载中…</div></div>
</div>
<div class="grid" style="margin-top:16px;">
  <div class="card"><h2>24H 预测</h2><div id="forecast24h">加载中…</div></div>
  <div class="card"><h2>72H 预测</h2><div id="forecast72h">加载中…</div></div>
</div>
<div class="footer" id="footer"></div>
<script>
${RENDER_FUNCTIONS_SOURCE}

async function refresh() {
  try {
    const res = await fetch('/api/v1/dashboard/realtime?instrument=ETHUSDT', { cache: 'no-store' });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error && body.error.message || '请求失败');
    const data = body.data;
    document.getElementById('marketBody').innerHTML = renderMarket(data.marketState);
    document.getElementById('referenceStateBody').innerHTML = renderReferenceExecutionState(data.referenceExecutionState);
    document.getElementById('forecast24h').innerHTML = renderForecast(data.forecast24h);
    document.getElementById('forecast72h').innerHTML = renderForecast(data.forecast72h);
    document.getElementById('statusTag').textContent = ' · 数据健康 ' + (data.dataHealth.ok ? '正常' : (data.dataHealth.status || '异常'));
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
