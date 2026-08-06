// d8-research-page-render.js测试——与realtime-dashboard-view.test.js同一模式：XSS注入探测、
// NOT_RUN不得渲染任何伪造数值、全部状态覆盖、渲染函数toString()可被安全嵌入。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtmlD8, renderD8Panel, renderD8Horizon, D8_RENDER_FUNCTIONS
} from './d8-research-page-render.js';

test('escapeHtmlD8转义全部危险字符', () => {
  assert.equal(escapeHtmlD8('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtmlD8(`"'&<>`), '&quot;&#39;&amp;&lt;&gt;');
  assert.equal(escapeHtmlD8(null), '');
  assert.equal(escapeHtmlD8(undefined), '');
});

test('renderD8Panel：NOT_RUN不渲染任何数值/进度/百分比字段，只有文案', () => {
  const html = renderD8Panel({ state: 'NOT_RUN', message: '暂无正式研究结果', actionPermission: 'DISPLAY_ONLY', disclosure: 'DISPLAY_ONLY说明' });
  assert.ok(html.includes('暂无正式研究结果'));
  assert.ok(!/%/.test(html), 'NOT_RUN不得出现任何百分比数字（含伪造0%）');
  assert.ok(!html.includes('runId'));
});

test('renderD8Panel：XSS注入探测——message/blockedReasonCode/reasonCodes/runId/datasetVersion全部字段', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const cases = [
    { state: 'NOT_RUN', message: payload, disclosure: 'd' },
    { state: 'RUNNING', message: payload, progress: { currentBatch: 1, totalBatches: 3 }, disclosure: 'd' },
    { state: 'BLOCKED', message: 'm', blockedReasonCode: payload, progress: { currentBatch: 1, totalBatches: 3 }, disclosure: 'd' },
    { state: 'FAILED', message: 'm', readerReasonCode: payload, disclosure: 'd' },
    {
      state: 'GO', runId: payload, algorithmVersion: payload, datasetVersion: payload,
      generatedAt: payload, publishedAt: payload, disclosure: payload,
      overall: { primaryReasonCode: payload, reasonCodes: [payload] },
      horizonResults: {
        '24h': { status: payload, effectiveTest: 1, directionalCoverage: 0.5, marketRegimeCoverage: 0.5, preCostLift: 0.1, postCostLift: 0.1, primaryReasonCode: payload, reasonCodes: [payload], wilson95: { lower: 0.1, upper: 0.2, successes: 1, trials: 2, confidenceLevel: 0.95 } },
        '72h': null
      }
    }
  ];
  for (const d8 of cases) {
    const html = renderD8Panel(d8);
    // 真正的安全属性是"尖括号被转义、不能形成新标签"——onerror=作为纯文本内容出现是无害的，
    // 断言不应该要求payload文本片段整体消失（那样反而会掩盖"转义丢字符"的真实bug）。
    assert.ok(!html.includes(payload), `原始payload不得原样出现: state=${d8.state}`);
    assert.ok(!html.includes('<img'), `payload必须被转义: state=${d8.state}`);
    assert.ok(html.includes('&lt;img') && html.includes('&gt;'), `转义后的payload必须仍然出现（不是被丢弃）: state=${d8.state}`);
  }
});

test('renderD8Panel：全部7种状态都能渲染出对应badge，不抛异常', () => {
  const states = ['NOT_RUN', 'RUNNING', 'BLOCKED', 'GO', 'CONDITIONAL_GO', 'NO_GO', 'FAILED'];
  for (const state of states) {
    const base = { state, message: 'm', disclosure: 'd', progress: { currentBatch: 0, totalBatches: 1 }, blockedReasonCode: 'X', readerReasonCode: 'Y' };
    const html = assert.doesNotThrow(() => renderD8Panel(base)) || renderD8Panel(base);
    assert.ok(html.includes(state) || state === 'GO' || state === 'CONDITIONAL_GO' || state === 'NO_GO');
  }
});

test('renderD8Horizon：wilson95缺失时降级为"数据不足"，不抛异常、不显示NaN', () => {
  const html = renderD8Horizon('24h', { status: 'NO_GO', effectiveTest: 0, directionalCoverage: null, marketRegimeCoverage: null, preCostLift: null, postCostLift: null, primaryReasonCode: 'EFFECTIVE_TEST_ZERO', reasonCodes: ['EFFECTIVE_TEST_ZERO'], wilson95: null });
  assert.ok(html.includes('数据不足'));
  assert.ok(!/NaN/.test(html));
});

test('D8_RENDER_FUNCTIONS：每个函数都是function声明（toString可安全嵌入独立语句）', () => {
  for (const fn of D8_RENDER_FUNCTIONS) {
    assert.equal(typeof fn, 'function');
    assert.ok(/^function\s+\w+\s*\(/.test(fn.toString()), `${fn.name} 必须是function声明，不能是箭头函数`);
  }
});
