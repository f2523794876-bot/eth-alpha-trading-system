# V1_3_CODEX_IMPLEMENTATION_TASK.md — 给 Codex 的 V1.3「模拟交易账户」实现工单

版本：v1.3-draft-1（随 `V1_3_PAPER_TRADING_SPEC.md` v1.3-draft-1 同步）
依据：`V1_3_PAPER_TRADING_SPEC.md`（算法真相来源，本文档只定义"怎么落地成代码"，不重复定义算法，任何算法细节冲突以该文档为准）+ 现有 `v1-core.js`（V1.1冻结核心）+ `v1_2-forecast-core.js`（V1.2冻结核心），两者**均不可修改**。
角色分工：本文档作者（Claude Code）负责本轮 V1.3 的架构设计与验收规范，**不编写正式业务代码**；Codex 负责实际编码；本文档、`V1_3_ACCEPTANCE_TESTS.md`、`V1_3_ARCHITECTURE_REVIEW.md` 与 `V1_3_PAPER_TRADING_SPEC.md` 是本轮交付的全部四份文档，本轮**不交付任何业务代码或测试代码**。

---

## 1. 范围重申（红线，逐条对照用户需求第八节）

### 1.1 本轮（V1.3实现阶段，非本次文档阶段）Codex 必须实现

新增独立模块 `v1_3-paper-trading-core.js`（命名与 `v1-core.js`/`v1_2-forecast-core.js` 风格一致），实现 `V1_3_PAPER_TRADING_SPEC.md` §2-§9 定义的账户/持仓/成交/风险/撮合/存储逻辑，以纯函数或"状态+storage参数注入"风格实现（§11函数接口清单）。

### 1.2 本轮 Codex 禁止实现的内容（与用户需求第八节一一对应）

- 不实现任何真实交易所下单API调用。
- 不读取、存储或校验任何交易所API密钥。
- 不连接、不模拟连接用户真实交易所账户（不新增任何登录/OAuth/账户绑定流程）。
- 不实现任何盈利承诺性文案或"胜率""收益预测"字段（V1.3不涉及V2历史校准语义，`calibratedProbability`等字段与本轮完全无关）。
- 不实现亏损摊平（任何形式的"在浮亏时增加仓位"功能或文案）。
- 不实现"杠杆提高风险预算"的任何计算路径（§5.5红线，杠杆只能出现在`margin=notional/leverage`一个公式里）。
- **不修改** `v1-core.js`、`v1_2-forecast-core.js` 已验收的任何函数体、导出签名或算法常量——只允许以`require`/`window.ETHAlphaCore`/`window.ETHAlphaForecast`只读方式调用两者已导出的函数。
- 不实现V2历史校准（回放引擎、Brier Score、方向准确率、区间覆盖率、校准曲线）。
- 不实现V3 WebSocket实时架构、条件提醒推送（`Notification` API）、长期运行监控——`模拟仓位`已从原V3范围拆出（见`V1_3_PAPER_TRADING_SPEC.md`§0.1），但这三项**仍然**不在本轮范围内，提前实现视为范围蔓延。
- 不实现任何"无用户点击确认的自动模拟开仓/加仓/平仓"路径——`confirmOpenPosition`/`confirmAddOn`/`confirmReduce`/`confirmClose` 四个函数**必须**要求一个只能来自真实UI点击事件的 `proposal`/确认参数，定时器（`setInterval(refresh,30000)`）触发的刷新回调**只允许**调用只读的 `scanClosedBarsForExits`（止损/止盈的自动触发，这是"已有仓位的风控执行"，不是"无人确认的新开仓"，两者性质不同，不得混淆——止损止盈触发是持有仓位期间的既定退出规则自动执行，而不是开立新头寸）。

### 1.3 不修改既有文件（红线，本轮范围边界）

不修改 `eth-dynamic-trading-dashboard.html`（由构建脚本重新生成，不手工编辑产物）、不修改 `v1-core.js`、`v1_2-forecast-core.js`、`work/v1-ui.template.html` 中V1.1/V1.2已有的任何一行、`tests/v1*.js`/`tests/v11*.js`/`tests/v12*.js`/`tests/third-review-tests.js`/`tests/audit-fixes-tests.js`/`tests/live-rest-test.js` 任何既有测试文件的既有断言。**只允许新增**文件与新增对既有模板/构建脚本的**追加式**接线（见§4）。

---

## 2. 新增文件规划

| 文件 | 职责 |
|---|---|
| `v1_3-paper-trading-core.js` | 纯逻辑核心：账户/持仓/成交/风险/撮合/存储/导出，`require('./v1-core.js')`与`require('./v1_2-forecast-core.js')`只读依赖，通过 `window.ETHAlphaPaperTrading` 暴露（浏览器）/ `module.exports`（Node测试） |
| `work/v1-paper-trading.template.html` | 新UI区域的模板片段（HTML+内联`<script data-v13="paper-trading">`），供构建脚本拼接进最终产物，参照 `work/v1-ui.template.html` 中V1.2部分的既有写法风格 |
| `tests/v13-paper-trading-tests.js` | 核心逻辑非联网自动化测试（对应`V1_3_ACCEPTANCE_TESTS.md`大部分用例），命名对齐`v12-forecast-tests.js`模式 |
| `tests/v13-ui-tests.js` | 单文件构建产物里的UI接线/DOM事件测试，对齐`v12-ui-tests.js`模式 |
| `tests/v13-live-rest-test.js` | 真实Binance REST生产链测试：真实数据→`buildDecision`→`buildForecast`→`buildTradeProposal`→`confirmOpenPosition`（用完即撤销/reset，不污染任何真实localStorage）→`scanClosedBarsForExits`，对齐`v12-live-rest-test.js`模式（**不得**只测试V1.1/V1.2而不真正调用V1.3函数——这正是`CLAUDE_CODE_REVIEW_V1_2_FINAL.md`P1-2关闭的模式，必须原样复制到V1.3） |

---

## 3. 实施步骤顺序（Codex必须按此顺序实现，不得跳步）

### 步骤1：账户与Schema（对应SPEC §2、§9）

- 实现 `PaperAccount`/`PaperAccountSettings` 接口对应的 JS 对象结构、`loadPaperAccount`/`savePaperAccount`/`validatePaperAccountSettings`/`migratePaperAccount`。
- 先把损坏JSON/容量不足/版本不兼容的降级路径（SPEC §9.2）跑通并配上最基础的单测，再进入下一步——这是历史教训：V1.2第一轮曾因为"先写主流程，异常路径留到最后补"而漏掉§12.3红线场景，本轮改为异常路径与主流程同步实现。

### 步骤2：风险预算与状态机（对应SPEC §5、§3.4）

- 实现 `calcRiskRegime`/`calcDrawdown`，接入`C.calcRiskBudget`作为核心求解器（SPEC §5.1），不重新发明公式。
- 实现 `PositionStatus` 状态机与状态转换表（SPEC §3.4）的纯函数校验（给定当前状态+事件，返回允许的下一状态或拒绝原因），单独可测，不与UI耦合。

### 步骤3：撮合引擎（对应SPEC §6）

- 先实现 `buildTradeProposal`（只读，无副作用），再实现 `confirmOpenPosition`/`confirmAddOn`/`confirmReduce`/`confirmClose`（点击型撮合，含§6.11防重复点击的锁与一次性方案消费）。
- 再实现 `scanClosedBarsForExits`（K线扫描型撮合，含§6.7同K线冲突、§6.8跳空止损、§6.9止盈保守成交、§6.10部分止盈与`calcBreakevenStop`）。
- **每个撮合函数落地后立即补齐对应的`tests/v13-paper-trading-tests.js`用例，不要把所有撮合规则都写完了再统一补测试**——保守撮合规则细节多，边写边测能更快发现"同一根K线冲突/跳空/精度取整顺序"这类容易犯错的边界。

### 步骤4：与V1.1/V1.2联动只读接线（对应SPEC §7）

- `deepClone`辅助函数（建议直接用 `JSON.parse(JSON.stringify(x))`，与SPEC §7.2要求一致，不需要引入额外的深拷贝库）。
- 确认事件监听顺序：V1.3的`v11decision`监听器注册代码必须出现在模板拼接顺序里V1.2监听器**之后**（见§4构建接线）。

### 步骤5：导出与重置（对应SPEC §2.4、§11）

- `exportPaperLogsJSON`/`exportPaperLogsCSV`：CSV导出必须复用`v1-core.js`已导出的`csvCell`辅助函数做公式注入转义（不得重新发明一套转义规则，`audit-fixes-tests.js`此前已经为CSV公式注入问题写过回归测试，V1.3必须延续同一防护）。
- `resetPaperAccount`/`changeInitialCapital`二次确认流程。

### 步骤6：UI接线（对应SPEC §10）

- 在 `eth-dynamic-trading-dashboard.html` 现有V1.2预测区域 `</section>` 之后（具体定位以文件当前实际结构为准，Codex实现时自行定位不猜测行号，与V1.2实现时的既有做法一致），新增：
  ```html
  <section class="grid" id="paperTradingSection">
  <!--__PAPER_UI__-->
  </section>
  ```
- 新增 `<script data-v13="paper-trading">/*__PAPER__*/</script>`，紧跟在V1.2的 `<script data-v12="forecast-layer">` 之后（不得插在V1.1/V1.2两块脚本中间）。

### 步骤7：构建脚本接线（对应`work/build-v1.js`已有的`replaceExact`精确计数保护机制，见§4）

### 步骤8：自测与回归

- 按`V1_3_ACCEPTANCE_TESTS.md`全部测试类别自测通过。
- **必须**重新完整跑一遍V1.1（`v1-tests.js`/`v11-tests.js`/`audit-fixes-tests.js`/`v11-ui-tests.js`/`third-review-tests.js`/`live-rest-test.js`）与V1.2（`v12-forecast-tests.js`/`v12-ui-tests.js`/`v12-live-rest-test.js`）全部既有测试，确认零回归（`V1_3_ACCEPTANCE_TESTS.md`§9列出具体回归要求）。

---

## 4. 构建脚本接线细节（复用V1.2已修复的`replaceExact`精确计数保护，见`CLAUDE_CODE_REVIEW_V1_2_FINAL.md`对`work/build-v1.js`的复审结论）

`work/build-v1.js` 现有 `replacements` 数组（`[target, replacement, expected, label]`四元组）与 `replaceExact(source,target,replacement,expected,label)` 精确次数校验机制**必须原样复用**，新增以下条目（**追加**在数组末尾，不改动既有条目的顺序或内容）：

```js
['/*__PAPER_UI__*/', <v1-paper-trading.template.html中的HTML片段字符串>, 1, 'V1.3模拟交易UI占位符'],
```

以及末尾核心拼接部分，新增：

```js
const paperCore = fs.readFileSync(path.join(root,'v1_3-paper-trading-core.js'),'utf8').replace(/<\/script/gi,'<\\/script');
template = replaceExact(template, '/*__PAPER__*/', paperCore, 1, 'V1.3模拟交易核心占位符');
```

**必须**保证 `/*__PAPER__*/` 的 `replaceExact` 调用在 `/*__FORECAST__*/` 之后执行（脚本内的语句顺序即决定了生成顺序，无需额外机制），从而保证最终产物里三个 `<script>` 块的顺序是 V1.1核心 → V1.2预测核心 → V1.3模拟交易核心（对应`V1_3_PAPER_TRADING_SPEC.md`§7.3的事件时序要求）。**不得**修改 `work/build-v1.js` 中V1.1/V1.2已有的任何一个 `replacements` 数组条目或既有的两次 `replaceExact('/*__CORE__*/'...)`/`replaceExact('/*__FORECAST__*/'...)` 调用。

---

## 5. 与 `V1_2_CODEX_IMPLEMENTATION_TASK.md` 同款的"接口冲突检查"清单

| 项 | V1.1 | V1.2 | V1.3 | 是否冲突 |
|---|---|---|---|---|
| 模块全局变量名 | `window.ETHAlphaCore` | `window.ETHAlphaForecast` | `window.ETHAlphaPaperTrading` | 不冲突 |
| 自定义DOM事件名 | `v11decision`（唯一来源） | 监听既有事件，不新增 | 监听既有事件，不新增 | 不冲突 |
| localStorage key | `ethAlphaDecisionLogs`/`ethAlphaDecisionLogsV11`/`ethAlphaRiskSettings` | `ethAlphaForecastLogs` | `ethAlphaPaperAccount`/`ethAlphaPaperTrades`/`ethAlphaPaperLog` | 不冲突 |
| `window`暴露的原始引用 | 无 | `window.__lastMarketData`/`window.__prevForecast` | 只读消费以上两个，新增 `window.__paperAccount`（供UI渲染层读取当前账户状态，不建议其余模块写入） | 不冲突 |
| DOM id前缀 | 约30个既有id | `forecast15m`/`forecast1h`/`forecast4h`/`forecastDisclaimer`/`forecastBlocked`/`forecastBetting` | `paperAccount*`/`paperTrade*`/`paperFill*`/`paperLog*`（具体清单由Codex在实现时列出并交叉核对，避免与前两者id碰撞） | 需Codex实现时逐一核对，本文档不预先枚举全部id防止与实际DOM结构脱节 |
| 导出函数名 | `v1-core.js`完整列表 | `v1_2-forecast-core.js`新增列表 | `v1_3-paper-trading-core.js`新增列表（见SPEC§11） | 不冲突，三者单向依赖：V1.3依赖V1.2依赖V1.1，反向不允许 |
| 测试文件命名 | `v1-tests.js`等6个 | `v12-forecast-tests.js`/`v12-ui-tests.js`/`v12-live-rest-test.js` | `v13-paper-trading-tests.js`/`v13-ui-tests.js`/`v13-live-rest-test.js` | 不冲突 |

---

## 6. 交付清单（Codex在下一轮实现完成后应交付，本文档不要求现在完成）

- `v1_3-paper-trading-core.js`
- `work/v1-paper-trading.template.html`
- `tests/v13-paper-trading-tests.js`、`tests/v13-ui-tests.js`、`tests/v13-live-rest-test.js`
- 对 `work/build-v1.js`、`work/v1-ui.template.html`（仅新增脚本标签引用位置，不改动既有内容）的追加式修改
- `V1_3_IMPLEMENTATION_REPORT.md`、`V1_3_TEST_RESULTS.md`（对照V1.2交付模式）

本文档（V1.3文档阶段）**不包含**以上任何一项的实际代码，仅作为下一轮实现的工单依据。
