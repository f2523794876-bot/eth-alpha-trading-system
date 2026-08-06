// D8正式研究面板——只读展示层，与realtime-page-render.js同一红线与同一模式（见该文件头注释）：
// 所有动态文本必须经escapeHtml()后才能进入innerHTML；本文件使用function声明以便toString()
// 原样嵌入自包含HTML页面，保证被测试覆盖的代码与实际发给浏览器的代码是同一份源码。
//
// 展示态ActionPermission=DISPLAY_ONLY：不是、也不影响任何交易执行许可判断（与实时看板的
// referenceExecutionState是完全独立的两套机制，互不混淆——D8面板本身不出现在任何入场/出场
// 决策路径上，本组件也不包含任何"开始研究/发起交易"的按钮或事件绑定）。
//
// 红线（渲染层，配合d8-status-reader.js的API侧红线）：
//   - NOT_RUN时不得显示0%或任何伪造的置信区间/样本数——只显示文案，不渲染任何数值区块。
//   - API不可达或Schema/hash校验失败时必须诚实降级为独立的错误态，绝不能"复用上一次成功的数据"
//     假装仍然新鲜（即fetch失败/FAILED状态与"从未加载过"分别展示，不共用同一处stale innerHTML）。

export function isD8Missing(value) {
  return value === null || value === undefined;
}

export function escapeHtmlD8(value) {
  if (value === null || value === undefined) return '';
  var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, function (ch) { return map[ch]; });
}

export function formatD8Pct(v) {
  return isD8Missing(v) ? '—' : escapeHtmlD8((Number(v) * 100).toFixed(2) + '%');
}

export function formatD8Number(v, digits) {
  return isD8Missing(v) ? '—' : escapeHtmlD8(Number(v).toFixed(digits === undefined ? 4 : digits));
}

export function formatD8Time(iso) {
  return isD8Missing(iso) ? '—' : escapeHtmlD8(iso);
}

export function d8StateBadgeClass(state) {
  var map = {
    GO: 'badge-allow', CONDITIONAL_GO: 'badge-observe', NO_GO: 'badge-block',
    DATA_GATE_FAILED: 'badge-block', BASELINE_NOT_EVALUABLE: 'badge-block',
    RUNNING: 'badge-observe', BLOCKED: 'badge-block', FAILED: 'badge-block', NOT_RUN: 'badge-observe'
  };
  return map[state] || 'badge-observe';
}

export function renderD8Horizon(label, h) {
  if (!h) return '<div class="direction-block muted">数据不足</div>';
  var wilson = h.wilson95
    ? formatD8Pct(h.wilson95.lower) + ' ~ ' + formatD8Pct(h.wilson95.upper) + '（n=' + escapeHtmlD8(h.wilson95.trials) + '，成功=' + escapeHtmlD8(h.wilson95.successes) + '）'
    : '数据不足';
  return '<div class="direction-block"><div><span class="badge ' + d8StateBadgeClass(h.status) + '">' + escapeHtmlD8(h.status) + '</span></div>' +
    '<div class="row"><span class="label">有效样本数</span><span>' + escapeHtmlD8(h.effectiveTest) + '</span></div>' +
    '<div class="row"><span class="label">方向覆盖率</span><span>' + formatD8Pct(h.directionalCoverage) + '</span></div>' +
    '<div class="row"><span class="label">市场状态覆盖率</span><span>' + formatD8Pct(h.marketRegimeCoverage) + '</span></div>' +
    '<div class="row"><span class="label">Wilson 95% CI</span><span>' + wilson + '</span></div>' +
    '<div class="row"><span class="label">成本前收益</span><span>' + formatD8Number(h.preCostLift) + '</span></div>' +
    '<div class="row"><span class="label">成本后收益</span><span>' + formatD8Number(h.postCostLift) + '</span></div>' +
    '<div class="row"><span class="label">主要原因</span><span>' + escapeHtmlD8(h.primaryReasonCode) + '</span></div>' +
    '<div class="row"><span class="label">全部原因</span><span>' + (Array.isArray(h.reasonCodes) ? h.reasonCodes.map(escapeHtmlD8).join('、') : '—') + '</span></div>' +
    '</div>';
}

export function renderD8Panel(d8) {
  if (!d8 || !d8.state) return '<div class="muted">D8面板暂不可用（响应格式异常）</div>';
  var badge = '<span class="badge ' + d8StateBadgeClass(d8.state) + '">' + escapeHtmlD8(d8.state) + '</span>';
  var disclosure = '<div class="row"><span class="label">重要说明</span><span>' + escapeHtmlD8(d8.disclosure) + '</span></div>';

  if (d8.state === 'NOT_RUN') {
    return '<div>' + badge + '</div><div class="row"><span class="label">状态</span><span>' + escapeHtmlD8(d8.message) + '</span></div>' + disclosure;
  }
  if (d8.state === 'RUNNING' || d8.state === 'BLOCKED') {
    var progress = d8.progress ? escapeHtmlD8(d8.progress.currentBatch) + ' / ' + escapeHtmlD8(d8.progress.totalBatches) + ' 批' : '—';
    var blockedRow = d8.state === 'BLOCKED'
      ? '<div class="row"><span class="label">阻塞原因</span><span>' + escapeHtmlD8(d8.blockedReasonCode) + '</span></div>' : '';
    return '<div>' + badge + '</div>' +
      '<div class="row"><span class="label">状态</span><span>' + escapeHtmlD8(d8.message) + '</span></div>' +
      '<div class="row"><span class="label">180天分批进度</span><span>' + progress + '</span></div>' +
      blockedRow + disclosure;
  }
  if (d8.state === 'FAILED') {
    return '<div>' + badge + '</div>' +
      '<div class="row"><span class="label">状态</span><span>' + escapeHtmlD8(d8.message) + '</span></div>' +
      '<div class="row"><span class="label">读取失败原因</span><span>' + escapeHtmlD8(d8.readerReasonCode) + '</span></div>' + disclosure;
  }
  // GO / CONDITIONAL_GO / NO_GO / DATA_GATE_FAILED / BASELINE_NOT_EVALUABLE：完整结论展示。
  return '<div>' + badge + '</div>' +
    '<div class="row"><span class="label">运行ID</span><span>' + escapeHtmlD8(d8.runId) + '</span></div>' +
    '<div class="row"><span class="label">算法版本</span><span>' + escapeHtmlD8(d8.algorithmVersion) + '</span></div>' +
    '<div class="row"><span class="label">数据集版本</span><span>' + escapeHtmlD8(d8.datasetVersion) + '</span></div>' +
    '<div class="row"><span class="label">生成时间</span><span>' + formatD8Time(d8.generatedAt) + '</span></div>' +
    '<div class="row"><span class="label">发布时间</span><span>' + formatD8Time(d8.publishedAt) + '</span></div>' +
    '<div class="row"><span class="label">总体主要原因</span><span>' + escapeHtmlD8(d8.overall && d8.overall.primaryReasonCode) + '</span></div>' +
    '<div class="row"><span class="label">总体全部原因</span><span>' + (d8.overall && Array.isArray(d8.overall.reasonCodes) ? d8.overall.reasonCodes.map(escapeHtmlD8).join('、') : '—') + '</span></div>' +
    '<h3 style="margin:10px 0 4px;font-size:13px;color:var(--muted);">24H</h3>' + renderD8Horizon('24h', d8.horizonResults && d8.horizonResults['24h']) +
    '<h3 style="margin:10px 0 4px;font-size:13px;color:var(--muted);">72H</h3>' + renderD8Horizon('72h', d8.horizonResults && d8.horizonResults['72h']) +
    disclosure;
}

export const D8_RENDER_FUNCTIONS = Object.freeze([
  isD8Missing, escapeHtmlD8, formatD8Pct, formatD8Number, formatD8Time, d8StateBadgeClass, renderD8Horizon, renderD8Panel
]);
