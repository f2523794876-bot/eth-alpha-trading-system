// P1-4修复（独立复审）：实时看板页面的渲染函数——纯字符串拼接，零DOM依赖，因此可以：
//   1. 在Node下直接单元测试（本文件即生产渲染逻辑本身，不是另写一套测试专用的简化版本）；
//   2. 通过Function.prototype.toString()把源码原样嵌入自包含HTML页面的<script>标签
//      （见realtime-page.js），保证"被测试的代码"与"实际发给浏览器的代码"是同一份源码，不会漂移。
//
// 红线：触发条件/失效条件/参考执行状态原因说明/阻塞原因/数据状态文字等，即使当前来自系统内部
// （trigger_conditions/invalidation_conditions/reason/detail/disclosure等最终来自数据库或API响应），
// 也不得假设永久可信——所有动态文本必须经过escapeHtml()后才能进入innerHTML，不允许任何插值点绕过。
// 所有格式化函数（formatPrice/formatPct/formatSignedPct/formatTime/formatText）内部都统一收口调用
// escapeHtml()，渲染函数（renderMarket/renderReferenceExecutionState/renderDirection/renderForecast）
// 只通过这些格式化函数输出动态内容，不直接拼接原始字段。
//
// 使用function声明（而非箭头函数/const）——toString()对函数声明产生可直接作为语句嵌入的完整源码，
// 箭头函数表达式toString()不含变量名，无法安全地原样嵌入独立语句序列。

export function isDisplayMissing(value) {
  return value === null || value === undefined || value === 'INSUFFICIENT_DATA' || value === 'NOT_YET_GENERATED';
}

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, function (ch) { return map[ch]; });
}

export function formatPrice(v) {
  return isDisplayMissing(v) ? '数据不足' : escapeHtml(Number(v).toFixed(2));
}

export function formatPct(v) {
  return isDisplayMissing(v) ? '数据不足' : escapeHtml((Number(v) * 100).toFixed(2) + '%');
}

export function formatSignedPct(v) {
  if (isDisplayMissing(v)) return '数据不足';
  var n = Number(v);
  var p = (n * 100).toFixed(2);
  return escapeHtml((n >= 0 ? '+' : '') + p + '%');
}

export function formatTime(ms) {
  return isDisplayMissing(ms) ? '—' : escapeHtml(new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
}

export function formatZone(zone) {
  if (!Array.isArray(zone) || zone.length !== 2) return '数据不足';
  return formatPrice(zone[0]) + ' ~ ' + formatPrice(zone[1]);
}

export function formatText(v) {
  if (isDisplayMissing(v)) return v === 'NOT_YET_GENERATED' ? '尚未生成' : '数据不足';
  return escapeHtml(v);
}

export function renderMarket(m) {
  if (!m || m.status === 'INSUFFICIENT_DATA') {
    var missingReason = m && m.staleness && m.staleness.reason ? '（' + formatText(m.staleness.reason) + '）' : '';
    return '<div class="muted">当前价格数据不足' + missingReason + '</div>';
  }
  var dir = m.changeAbs > 0 ? 'up' : m.changeAbs < 0 ? 'down' : 'flat';
  var arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·';
  var staleNote = m.status === 'STALE_PROVISIONAL_FALLBACK'
    ? '<div class="row"><span class="label">实时状态</span><span>⚠ 实时数据已过期，已回退到最近已完成K线（' + formatText(m.staleness ? m.staleness.reason : null) + '）</span></div>'
    : '';
  return '' +
    '<div class="price change-' + dir + '">' + formatPrice(m.price) + ' <span style="font-size:16px;">' + arrow + ' ' + formatSignedPct(m.changePct) + '</span></div>' +
    '<div class="row"><span class="label">交易对</span><span>' + escapeHtml(m.instrument) + '</span></div>' +
    '<div class="row"><span class="label">涨跌额</span><span>' + (m.changeAbs >= 0 ? '+' : '') + formatPrice(m.changeAbs) + '</span></div>' +
    '<div class="row"><span class="label">比较基准</span><span>上一根已完成15m K线收盘价 ' + formatPrice(m.changeBasis && m.changeBasis.closePrice) + '（' + formatTime(m.changeBasis && m.changeBasis.closeTime) + '）</span></div>' +
    '<div class="row"><span class="label">变化速度/动量</span><span>' + formatText(m.momentum) + '</span></div>' +
    '<div class="row"><span class="label">价格来源</span><span>' + (m.priceSource === 'LIVE_PROVISIONAL_CANDLE' ? '当前进行中K线' : '最近已完成K线') + '</span></div>' +
    '<div class="row"><span class="label">数据时间</span><span>' + formatTime(m.dataTime) + '</span></div>' +
    '<div class="row"><span class="label">状态</span><span>' + escapeHtml(m.status) + '</span></div>' +
    staleNote;
}

export function renderReferenceExecutionState(t) {
  if (!t) return '<div class="muted">数据不足</div>';
  var badgeClass = { ALLOW: 'badge-allow', PREPARE: 'badge-allow', OBSERVE: 'badge-observe', BLOCK: 'badge-block' }[t.mode] || 'badge-observe';
  return '<div><span class="badge ' + badgeClass + '">' + escapeHtml(t.mode) + '</span></div>' +
    '<div class="row"><span class="label">原因</span><span>' + escapeHtml(t.reason) + '</span></div>' +
    '<div class="row"><span class="label">说明</span><span>' + escapeHtml(t.detail) + '</span></div>' +
    '<div class="row"><span class="label">重要说明</span><span>' + escapeHtml(t.disclosure) + '</span></div>';
}

export function renderDirection(label, badgeClass, d) {
  if (!d) return '<div class="direction-block muted">数据不足</div>';
  var zoneText = Array.isArray(d.targetZone) ? formatZone(d.targetZone)
    : (d.upperBound !== undefined ? formatZone([d.lowerBound, d.upperBound]) : '数据不足');
  var moveSource = Array.isArray(d.expectedMovePct) ? d.expectedMovePct[1] : d.expectedMovePct;
  var moveText = d.expectedMovePct !== undefined ? formatSignedPct(moveSource) : '数据不足';
  return '<div class="direction-block"><div><span class="badge ' + badgeClass + '">' + escapeHtml(label) + '</span> 概率 ' + formatPct(d.probabilityPct) + '</div>' +
    '<div class="row"><span class="label">目标区间</span><span>' + zoneText + '</span></div>' +
    '<div class="row"><span class="label">预计空间</span><span>' + moveText + '</span></div>' +
    '<div class="row"><span class="label">触发条件</span><span>' + formatText(d.triggerCondition) + '</span></div>' +
    '<div class="row"><span class="label">失效条件</span><span>' + formatText(d.invalidationCondition) + '</span></div>' +
    '</div>';
}

export function renderForecast(f) {
  if (!f || f.status === 'NOT_YET_GENERATED') return '<div class="muted">尚未生成</div>';
  var staleTag = f.status === 'EXPIRED_AWAITING_NEXT_GENERATION'
    ? '<span class="badge badge-block">已过期，等待下一次正式生成</span>'
    : '<span class="badge badge-observe">ACTIVE</span>';
  return '' +
    '<div class="row"><span class="label">状态</span><span>' + staleTag + '</span></div>' +
    '<div class="row"><span class="label">参考价</span><span>' + formatPrice(f.referencePrice) + '</span></div>' +
    '<div class="row"><span class="label">概率来源</span><span>' + (f.probabilityStatus === 'rule_based' ? '规则型情景权重（非统计校准）' : formatText(f.probabilityStatus)) + '</span></div>' +
    '<div class="row"><span class="label">生成时间</span><span>' + formatTime(f.generatedAt) + '</span></div>' +
    '<div class="row"><span class="label">到期时间</span><span>' + formatTime(f.targetEndTime) + '</span></div>' +
    renderDirection('UP · 多头', 'badge-up', f.up) +
    renderDirection('DOWN · 空头', 'badge-down', f.down) +
    renderDirection('RANGE', 'badge-range', f.range);
}

// 供realtime-page.js把这些渲染函数的真实源码原样嵌入<script>标签——保证浏览器实际执行的
// 就是本文件（已被单元测试覆盖）的同一份代码，不是另外维护的一份"看起来差不多"的副本。
export const RENDER_FUNCTIONS = Object.freeze([
  isDisplayMissing, escapeHtml, formatPrice, formatPct, formatSignedPct, formatTime, formatZone, formatText,
  renderMarket, renderReferenceExecutionState, renderDirection, renderForecast
]);
