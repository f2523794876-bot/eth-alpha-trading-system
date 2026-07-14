# V1_3_CODEX_IMPLEMENTATION_TASK.md — 给 Codex 的 V1.3「模拟交易账户」实现工单

版本：v1.3-draft-4（随 `V1_3_PAPER_TRADING_SPEC.md` v1.3-draft-4 同步；§1-§6为draft-2既有内容，draft-4对其中"逐笔点击确认"相关条款做了**原地改写**（见下方§1.2/§3标注与SPEC §17扫描记录），§7为draft-3新增内容不变，新增§8为draft-4「自动模拟交易引擎」实现工单）
依据：`V1_3_PAPER_TRADING_SPEC.md`（算法真相来源，本文档只定义"怎么落地成代码"，不重复定义算法，任何算法细节冲突以该文档为准，draft-3新增内容对应SPEC §15）+ 现有 `v1-core.js`（V1.1冻结核心）+ `v1_2-forecast-core.js`（V1.2冻结核心），三者**均不可修改**（含draft-2交付的`v1_3-paper-trading-core.js`等——本轮范围内该文件**尚未实现**，不存在"冻结"问题，但§1.3列出的既有前四份文档描述的规则不可回退修改）。
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
- **（draft-4撤销，见SPEC §17）** ~~不实现任何"无用户点击确认的自动模拟开仓/加仓/平仓"路径——全部要求一个只能来自真实UI点击事件的确认参数。~~ **CEO本轮已正式撤销这一条：V1.3的核心产品定义就是自动开仓/加仓/减仓/止损/分批止盈/移动保护/平仓（SPEC §16），本节禁止清单改为以下三条真正不可逾越的红线：**
  - 不自动下真实订单，不读取/存储/校验任何交易所API密钥，不连接/不模拟连接用户真实交易所账户（SPEC §16.0核心红线，唯一不受本轮授权模型变化影响的部分）。
  - `autoEngineOpenPosition`/`autoEngineAddOn`（自动开仓/加仓，SPEC §16.10）由引擎在`AutoEngineState.engineState==='AUTO_PAPER_RUNNING'`且SPEC §16.2十四项条件全部满足时自动调用，`idempotencyKey`由引擎按SPEC §16.8确定性规则生成，**不要求**用户点击；定时器（`setInterval(refresh,30000)`）触发的`v11decision`事件回调**允许**调用这两个函数以及只读的`scanClosedBarsForExits`/`replayDataGap`——这是draft-4相对draft-2/draft-3最根本的实现差异，不要沿用旧版本"定时器只能调只读函数"的假设。
  - `emergencyClosePosition`（唯一保留的人工介入操作，SPEC §16.6）以及`resetPaperAccount`/`changeInitialCapital`/`confirmForcedObservationAcknowledgement`/引擎开启-暂停-恢复-禁止新开仓-关闭（SPEC §16.1）**仍然**要求一个只能来自真实UI点击事件的确认参数+稳定的`idempotencyKey`——这部分红线保留，只是适用范围从"全部五种交易操作"收窄为"宏观控制+异常人工介入+账户级设置"。
- **（draft-4撤销，见SPEC §17）** ~~不实现UNRESOLVED_DATA_GAP状态下的任何自动平仓——该状态只能通过用户显式点击"确认保守结算"（confirmConservativeSettlement）走出。~~ **这一条部分保留**：`UNRESOLVED_DATA_GAP`状态下仍然**不允许**任何定时器/数据恢复回调自动把仓位标记为已平仓；但走出该状态的操作已从独立函数`confirmConservativeSettlement`**并入**`emergencyClosePosition`（SPEC §8.5/§16.6）——用户点击"紧急模拟平仓"时，若`trade.status==='UNRESOLVED_DATA_GAP'`，函数内部自动切换为保守结算成交规则，仍然是"只能由用户显式点击触发"，只是不再是一个专门的按钮/函数。

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
| `tests/v13-live-rest-test.js` | 真实Binance REST生产链测试：真实数据→`buildDecision`→`buildForecast`→`buildTradeProposal`→`autoEngineOpenPosition`（用完即撤销/reset，不污染任何真实localStorage）→`scanClosedBarsForExits`，对齐`v12-live-rest-test.js`模式（**不得**只测试V1.1/V1.2而不真正调用V1.3函数——这正是`CLAUDE_CODE_REVIEW_V1_2_FINAL.md`P1-2关闭的模式，必须原样复制到V1.3） |

---

## 3. 实施步骤顺序（Codex必须按此顺序实现，不得跳步）

### 步骤1：账户与Schema（对应SPEC §2、§9）

- 实现 `PaperAccount`/`PaperAccountSettings` 接口对应的 JS 对象结构、`loadPaperAccount`/`savePaperAccount`/`validatePaperAccountSettings`/`migratePaperAccount`。
- 先把损坏JSON/容量不足/版本不兼容的降级路径（SPEC §9.2）跑通并配上最基础的单测，再进入下一步——这是历史教训：V1.2第一轮曾因为"先写主流程，异常路径留到最后补"而漏掉§12.3红线场景，本轮改为异常路径与主流程同步实现。

### 步骤2：会计恒等式、风险预算与状态机（对应SPEC §2.2、§5、§3.4）

- 严格按SPEC §2.2字段命名实现：`equity`/`cash`/`availableBalance`（**必须**是`equity-marginUsed`，不是`cash-marginUsed`，这是draft-2相对draft-1的修正点，实现时要特别注意不要沿用直觉上更常见的"可用=现金-保证金"写法）/`marginUsed`/`realizedPnlGross`/`unrealizedPnl`/`feesTotal`/`slippageCostReport`。
- 实现 `calcRiskRegime`/`calcDrawdown`（回撤基准为`peakEquity`，只在账户重置时重建，SPEC §5.4）/`calcDailyStartEquity`（SPEC §5.3的"当前净值反减今天已发生已实现盈亏、反加今天已发生手续费"闭式重建公式，**不得**简化成"直接取当前净值"，即使多数正常跨日场景下两者数值相同，也必须实现完整公式以覆盖应用重载/首次启动场景）。
- 单笔/试仓风险预算求解**只能**传入`equity`（当前净值）作为`C.calcRiskBudget`的`capital`实参（SPEC §5.1红线），代码里建议直接用`equity`命名局部变量传参，不要用`capital`这类容易让人误以为是固定本金的命名，避免后续维护者看错。
- 实现 `PositionStatus` 状态机与状态转换表（SPEC §3.4，**新增`UNRESOLVED_DATA_GAP`**）的纯函数校验，单独可测，不与UI耦合。

### 步骤3：撮合引擎（对应SPEC §6，**draft-4更新：开仓/加仓改为引擎自动调用，`confirmReduce`已移除，见SPEC §17/本文档§8**）

- 先实现 `buildTradeProposal`（只读，无副作用，draft-4起角色变为引擎内部消费+UI"下一自动动作"预览，见SPEC §16.5），再实现 `emergencyClosePosition`（唯一保留的人工介入型撮合，含§6.11/§16.8幂等键机制，见步骤5）。**不实现**`confirmReduce`（已整体移除）。`autoEngineOpenPosition`/`autoEngineAddOn`（自动开仓/加仓）的实现顺序与要求见本文档§8步骤，依赖本步骤先实现好的`calcBreakevenStop`/50-30-20分批止盈/`scanClosedBarsForExits`等底层撮合函数，但函数本身属于§8范畴，不在本步骤实现。
- 实现 `calcBreakevenStop`（SPEC §6.10闭式解，多空两个方向分别实现，**必须**包含开仓手续费+预计平仓手续费+实际滑点三项成本，不能只用`entryPrice`简化替代）；实现50/30/20分批止盈（SPEC §6.10，**最后一档必须直接取`trade.quantity`当前剩余全部，不得独立按比例重新计算，以规避取整尾差**）。
- 实现加仓的统一止损风险校验（SPEC §5.2条件7：加仓后用**唯一的**`currentStop`计算`worstCaseLoss`，与`equity×maxRiskPct`比较），**不要**照抄`STRATEGY_SPEC.md §8.2`原文里"试仓风险+加仓风险分别求和"的旧口径，SPEC §5.2已明确本轮采用统一止损口径，两种口径在多数场景下数值相近但公式不同，必须以`V1_3_PAPER_TRADING_SPEC.md`当前版本为准。
- 再实现 `scanClosedBarsForExits`（K线扫描型撮合，含§6.7同K线冲突、§6.8跳空止损、§6.9止盈保守成交）。
- **每个撮合函数落地后立即补齐对应的`tests/v13-paper-trading-tests.js`用例，不要把所有撮合规则都写完了再统一补测试**。

### 步骤4：数据缺口检测、回放与紧急平仓（对应SPEC §8，draft-2新增步骤；**draft-4更新：`confirmConservativeSettlement`已并入`emergencyClosePosition`**）

- 实现`replayDataGap(trade, marketData, account, storage)`：数据恢复后按SPEC §8.3逐根回放缺失K线，**必须**先判断`fetchAllTimeframeKlines`返回的已收盘K线是否完整覆盖缺口（`openTime`序列是否等间隔连续），完整覆盖才执行回放并解除`UNRESOLVED_DATA_GAP`，否则把`replayAttempt`记录为`STILL_GAP`并保持该状态——**不得**为了让测试更容易通过而简化成"只要拿到新数据就假设覆盖完整"。
- 实现`emergencyClosePosition(trade, decision, account, storage, idempotencyKey)`：只能由用户显式点击触发，**内部分支**——若`trade.status==='UNRESOLVED_DATA_GAP'`，成交价取"缺口结束后第一根可获得的已收盘K线的`open`价格"并叠加不利滑点（SPEC §8.5保守结算规则），产生`closeReason='DATA_GAP_CONSERVATIVE'`、`estimated=true`、`verified=false`；否则（`OPEN`/`PARTIALLY_CLOSED`）按当前`markPrice`+常规不利滑点成交，`estimated=false`、`verified=true`。**不要**把这两条路径实现成两个独立导出函数——CEO本轮已明确合并，保留两个函数会与SPEC §16.10/§17产生不一致。
- **红线**：`estimated`/`verified`两个字段必须真实反映交易是否走过保守结算路径，`exportPaperLogsJSON`/`exportPaperLogsCSV`必须原样导出这两个字段，供下游任何统计（含未来V1.4+）过滤估算交易。

### 步骤5：与V1.1/V1.2联动只读接线 + 幂等键机制（对应SPEC §7、§6.11）

- `deepClone`辅助函数（建议直接用 `JSON.parse(JSON.stringify(x))`）。
- 确认事件监听顺序：V1.3的`v11decision`监听器注册代码必须出现在模板拼接顺序里V1.2监听器**之后**（见§4构建接线）。
- 实现`account.processedIdempotencyKeys`有界环形缓冲（建议最近500条）+ 幂等重放逻辑（SPEC §6.11）：开仓/加仓/减仓/平仓/重置/改本金/解除强制观察**全部**七类操作必须支持传入`idempotencyKey`，重复的key必须返回上一次的结果而不是报错或重新执行——这是draft-2相对draft-1"一次性方案消费+拒绝重复"更严格的要求，实现时注意区分"幂等重放"（返回原结果）与"简单拒绝"（返回错误）两种不同语义，不要混用。

### 步骤6：导出与重置（对应SPEC §2.4、§11）

- `exportPaperLogsJSON`/`exportPaperLogsCSV`：CSV导出必须复用`v1-core.js`已导出的`csvCell`辅助函数做公式注入转义。
- `resetPaperAccount`/`changeInitialCapital`二次确认流程，**必须**验证`peakEquity`只在`resetPaperAccount`里被重建，`changeInitialCapital`（即使同时选择"重置账户"选项）也只能通过内部调用同一条重置路径来重建`peakEquity`，不能有第二条独立实现（避免两处实现分叉导致以后只改了一处）。

### 步骤7：UI接线（对应SPEC §10）

- 在 `eth-dynamic-trading-dashboard.html` 现有V1.2预测区域 `</section>` 之后（具体定位以文件当前实际结构为准，Codex实现时自行定位不猜测行号，与V1.2实现时的既有做法一致），新增：
  ```html
  <section class="grid" id="paperTradingSection">
  <!--__PAPER_UI__-->
  </section>
  ```
- 新增 `<script data-v13="paper-trading">/*__PAPER__*/</script>`，紧跟在V1.2的 `<script data-v12="forecast-layer">` 之后（不得插在V1.1/V1.2两块脚本中间）。

### 步骤8：构建脚本接线（对应`work/build-v1.js`已有的`replaceExact`精确计数保护机制，见§4）

### 步骤9：自测与回归

- 按`V1_3_ACCEPTANCE_TESTS.md`全部测试类别自测通过。
- **必须**重新完整跑一遍V1.1（`v1-tests.js`/`v11-tests.js`/`audit-fixes-tests.js`/`v11-ui-tests.js`/`third-review-tests.js`/`live-rest-test.js`）与V1.2（`v12-forecast-tests.js`/`v12-ui-tests.js`/`v12-live-rest-test.js`）全部既有测试，确认零回归（`V1_3_ACCEPTANCE_TESTS.md` T27列出具体回归要求）。

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

---

## 7. draft-3新增：建议档案与影子验证 Signal Archive & Shadow Evaluation（对应`V1_3_PAPER_TRADING_SPEC.md`§15）

角色重申：本节与§1-§6一样，只是给Codex的工单依据，本文档（含本节）不交付任何实际代码。§1-§6描述的「模拟账户」实现工单**零改动**，本节是**追加**的独立子系统工单。

### 7.1 范围重申（红线，本节专用）

- 新增独立模块，**不与**`v1_3-paper-trading-core.js`合并成一个文件——Signal Archive在设计上必须能独立于Paper Trading Account运行（SPEC §15.0：不需要账户存在），合并成一个文件会让"读一个文件就必须理解两套完全不同的资金语义"，增加认知负担且违背§15.0的系统边界声明。
- 不建立任何`PaperPosition`/`PaperFill`/占用`marginUsed`——Signal Archive/Shadow Evaluation产生的一切数据只读写`ethAlphaSignalArchive`/`ethAlphaSignalEvents`/`ethAlphaShadowResults`三个key，**禁止**在实现中出现任何路径把`ShadowResult`的字段写入`ethAlphaPaperAccount`/`ethAlphaPaperTrades`（SPEC §15.0红线，`V1_3_ACCEPTANCE_TESTS.md` T38专项测试）。
- 不为`UNRESOLVED_DATA_GAP`状态的影子验证实现任何"强制结算/估算收敛"出口（SPEC §15.7红线，与draft-4 Paper Trading的`emergencyClosePosition`保守结算分支**刻意不对称**——Paper Trading有真实资金/仓位，需要一个人工出口来"结清"；Shadow Evaluation没有真实后果，可以无限期`UNRESOLVED_DATA_GAP`下去，不要照抄§8.5的模式）。
- 不修改`v1-core.js`/`v1_2-forecast-core.js`/draft-2交付的`v1_3-paper-trading-core.js`（该文件本轮尚未实现，若与本轮Signal Archive实现同批交付，两者只能通过`window.__paperAccount`/`linkedPaperTradeId`等只读指针关联，`v1_3-signal-archive-core.js`**不得**`require`并调用`v1_3-paper-trading-core.js`内部未导出的私有逻辑，只能通过其已导出的函数接口只读交互，若两者需要交叉引用，单向依赖方向为：Signal Archive **不依赖** Paper Trading（Paper Trading/Auto Engine的`autoEngineOpenPosition`（以`signal`为必填入参，SPEC §16.10）可以单向调用Signal Archive导出的`linkSignalToPaperTrade`，反向不允许）。

### 7.2 新增文件规划

| 文件 | 职责 |
|---|---|
| `v1_3-signal-archive-core.js` | 纯逻辑核心：建议创建判定/去重/生命周期/影子撮合/统计/存储/导出，`require('./v1-core.js')`（只读，含`analyzeKlines`/`csvCell`等已导出工具函数）与`require('./v1_2-forecast-core.js')`（只读，仅用于快照存档，不参与创建判定），通过`window.ETHAlphaSignalArchive`暴露（浏览器）/`module.exports`（Node测试） |
| `work/v1-signal-archive.template.html` | 新UI区域"历史交易建议与影子验证"的模板片段，风格参照`work/v1-paper-trading.template.html`（draft-2工单，本轮同批规划） |
| `tests/v13-signal-archive-tests.js` | 核心逻辑非联网自动化测试，命名对齐`v13-paper-trading-tests.js`模式 |
| `tests/v13-signal-archive-ui-tests.js` | 单文件构建产物里的UI接线/DOM事件测试 |
| `tests/v13-signal-archive-live-rest-test.js` | 真实Binance REST生产链测试：真实数据→`buildDecision`→`buildForecast`→`recordSignalIfEligible`→`evaluateShadowSignals`（用完即`resetSignalArchive`撤销/不污染真实localStorage），对齐`v13-live-rest-test.js`/`v12-live-rest-test.js`模式，**必须**真正调用本模块的导出函数，不得只验证V1.1/V1.2（同§2表格已强调的`CLAUDE_CODE_REVIEW_V1_2_FINAL.md`P1-2教训） |

### 7.3 实施步骤顺序（Codex必须按此顺序实现，紧接draft-2工单步骤9之后，不得跳步；若draft-2的`v1_3-paper-trading-core.js`尚未实现，Codex可先独立实现Signal Archive核心逻辑与非UI测试，但"步骤15：用户行为关联"中依赖`linkSignalToPaperTrade`↔`autoEngineOpenPosition`联动的部分必须等两者都存在后才能完成集成）

**步骤10：建议快照与去重（对应SPEC §15.2-§15.4）**

- 实现`SignalSnapshot`对应的JS对象结构、`loadSignalArchive`/`migrateSignalArchive`/损坏JSON与容量降级路径（**先实现异常路径，同draft-2步骤1的既有历史教训**）。
- 实现`calcSignalFingerprint(decision, direction, sourceConfirmedBarTime)`：**必须**先对价格类分量按`pricePrecision`取整再拼接，避免浮点噪声误判"实质变化"（SPEC §15.4）。
- 实现`recordSignalIfEligible(decision, forecast, marketData, storage)`：先做SPEC §15.3八条件AND判定，再做§15.4去重/版本判定，**顺序不能颠倒**（先判定"是否值得存档"，再判定"是否已经存过"，两步职责分离，便于分别测试）。

**步骤11：生命周期状态机（对应SPEC §15.5）**

- 实现纯函数状态机校验（不与影子撮合逻辑耦合，同draft-2步骤2"状态机纯函数单独可测"的既有模式），覆盖SPEC §15.5全部转换表行，**含**"终态不可逆"的显式拒绝校验。

**步骤12：影子撮合与MFE/MAE/毛R净R（对应SPEC §15.6，本轮复杂度最高的实现点，优先编写测试）**

- 实现`evaluateShadowSignals(signals, marketData, storage)`：**必须**先校验只使用`openTime>sourceConfirmedBarTime`且`isClosed===true`的K线（SPEC §15.6"禁止未来数据泄漏"红线），建议在函数入口就做这个过滤而不是散落在判断逻辑各处，便于`V1_3_ACCEPTANCE_TESTS.md` T33.1单独测试这一条过滤本身。
- `WAITING_TRIGGER`阶段判定与`TRIGGERED`阶段判定分别实现为独立可测的子函数（SPEC §15.6.A/§15.6.B），**不要**为了"复用代码"把两段揉进一个大循环——两段的红线不同（A段是entry/invalid/expire三选一，B段复用draft-2既有的stop/target红线），揉在一起容易在"同一根K线内进场又止损"这个交叉场景上出错（SPEC §15.5转换表已明确要求）。
- MFE/MAE/毛R/净R公式**逐项**对照SPEC §15.6代入具体数值编写测试（`V1_3_ACCEPTANCE_TESTS.md` T36要求），**每写完一个公式立即补测试，不要写完整个撮合引擎再统一补测试**（同draft-2步骤3的既有要求）。

**步骤13：影子验证数据缺口（对应SPEC §15.7）**

- 实现`ShadowDataGap`回补/重放逻辑，**复用**draft-2 `replayDataGap`的"K线openTime序列连续性判断"这一段核心算法思路（可以抽取成`v1-core.js`风格的共享纯函数供两个模块各自调用，但**不得**让`v1_3-signal-archive-core.js`直接`require`并调用`v1_3-paper-trading-core.js`内部实现——如果需要共享，应该把这段连续性判断逻辑放在双方都能只读依赖的地方，例如作为`v1_3-signal-archive-core.js`自己内部的一份独立实现，代码相似但物理上独立，避免引入两个本应各自独立的子系统之间的强耦合）。
- **红线**：不实现§8.5式的"用户确认保守结算"出口（SPEC §15.7红线，本节7.1已重申）。

**步骤14：准确度统计（对应SPEC §15.8，分母规则是本步骤最容易出错的地方）**

- 实现`computeSignalAccuracyStats`，**建议**先写一份测试专用的"分母集合断言辅助函数"（类似draft-2 T25.2的"聚合胜率验证契约"模式），在实现每一个比率指标时都先用这个辅助函数验证分母集合是否符合SPEC §15.8"分母红线"四条，再计算比率本身——这类"看起来算对了但分母偷偷混入了不该算的记录"的错误历史上在类似统计口径实现里很常见，值得为分母本身单独测试。

**步骤15：用户行为关联（对应SPEC §15.9）**

- **（draft-4更新，见SPEC §15.9/§17）** 实现`markSignalSeen`/`linkSignalToPaperTrade`，以及"建议进入终态时按SPEC §15.9事件表自动追加`AUTO_EXECUTED`/`AUTO_BLOCKED_BY_RISK`/`AUTO_BLOCKED_BY_POSITION`/`AUTO_MISSED_ENGINE_OFF`/`AUTO_MISSED_DATA_GAP`之一"的判定。**不实现**`markSignalRejected`（draft-3遗留函数，draft-4已撤销`REJECTED`枚举值，见SPEC §17）。draft-4起`SEEN`是**唯一**仍需要真实用户点击才触发的`userActionStatus`事件，其余五个`AUTO_*`事件全部由引擎自动判定追加，实现时不需要再像draft-3那样为"哪个事件不需要点击"做特殊注释区分——这是draft-4的默认情况，只有`SEEN`是例外。
- **红线（draft-4更新：`autoEngineOpenPosition`是draft-4新定义的自动开仓函数，本身就以`signal`为第一入参，见SPEC §16.10，不是"给draft-2旧函数追加可选参数"）**：`autoEngineOpenPosition`成功后**必须**调用`linkSignalToPaperTrade`，两者的调用顺序与失败回滚语义需在实现阶段明确（建议：先完成开仓，开仓成功后再关联；若关联步骤本身失败，不回滚已经成功的开仓，只记录关联失败，因为关联关系是审计性质的旁路信息，不应让一个次要的审计写入失败反过来撤销一笔已经成立的模拟交易）。

**步骤16：导出与重置 + UI接线 + 构建脚本接线（对应SPEC §15.10/§15.12）**

- `exportSignalArchiveJSON`/`exportSignalArchiveCSV`：CSV导出复用`v1-core.js`已导出的`csvCell`（同draft-2步骤6模式）。
- `resetSignalArchive`：两步确认+`idempotencyKey`，**红线**：只清空三个Signal Archive专属key，绝不触碰`ethAlphaPaperAccount`/`ethAlphaPaperTrades`/`ethAlphaPaperLog`（SPEC §15.10红线，7.1已重申，`V1_3_ACCEPTANCE_TESTS.md` T42专项验证）。
- UI接线：在`eth-dynamic-trading-dashboard.html`现有§10模拟账户区域`</section>`之后，新增：
  ```html
  <section class="grid" id="signalArchiveSection">
  <!--__SIGNAL_ARCHIVE_UI__-->
  </section>
  ```
  新增`<script data-v13="signal-archive">/*__SIGNAL_ARCHIVE__*/</script>`，紧跟在V1.3模拟账户脚本块`<script data-v13="paper-trading">`之后（**不得**插在V1.1/V1.2/V1.3模拟账户三块脚本中间——事件监听顺序要求见下）。
- **事件时序要求（对应SPEC §15.3"评估频率复用既有30秒v11decision事件"，**draft-4更新理由**）**：Signal Archive的`v11decision`监听器必须在构建产物中位于V1.3模拟账户脚本块**之后**——理由：draft-4起，Signal Archive的建议创建（`recordSignalIfEligible`）与Shadow Evaluation的触发判定（`evaluateShadowSignals`）必须先于Auto Engine的自动开仓判定（`tickAutoEngine`内部调用`autoEngineOpenPosition`，SPEC §16.10）在**同一次**tick内完成，因为`autoEngineOpenPosition`依赖本次tick"某个signal是否恰好完成`WAITING_TRIGGER→TRIGGERED`转换"这一判定结果（SPEC §16.2条件6）——如果脚本顺序颠倒，Auto Engine会读到上一次tick的陈旧`signal`生命周期状态，导致开仓判定延迟一整个刷新周期（约30秒），不是正确性错误但会造成"引擎慢一拍"的体验问题，仍应避免。
- 构建脚本接线：`work/build-v1.js`现有`replacements`数组**追加**（不改动既有条目顺序或内容）：
  ```js
  ['/*__SIGNAL_ARCHIVE_UI__*/', <v1-signal-archive.template.html中的HTML片段字符串>, 1, 'V1.3建议档案与影子验证UI占位符'],
  ```
  以及末尾核心拼接部分，在`/*__PAPER__*/`的`replaceExact`调用**之后**追加：
  ```js
  const signalArchiveCore = fs.readFileSync(path.join(root,'v1_3-signal-archive-core.js'),'utf8').replace(/<\/script/gi,'<\\/script');
  template = replaceExact(template, '/*__SIGNAL_ARCHIVE__*/', signalArchiveCore, 1, 'V1.3建议档案与影子验证核心占位符');
  ```
  最终产物`<script>`块顺序：V1.1核心 → V1.2预测核心 → V1.3模拟交易核心 → V1.3建议档案核心。

**步骤17：自测与回归**

- 按`V1_3_ACCEPTANCE_TESTS.md` T28-T43全部测试类别自测通过。
- **必须**重新完整跑一遍draft-2已有的`V1_3_ACCEPTANCE_TESTS.md` T27回归命令列表（含V1.1/V1.2既有测试与`work/build-v1.js`构建产物逐字节可复现校验），确认零回归；若draft-2的Paper Trading代码本轮已经交付，还需额外确认新增的`/*__SIGNAL_ARCHIVE_UI__*/`/`/*__SIGNAL_ARCHIVE__*/`占位符替换不破坏既有`/*__CORE__*/`/`/*__FORECAST__*/`/`/*__PAPER_UI__*/`/`/*__PAPER__*/`替换。

### 7.4 接口冲突检查清单（追加于§5已有表格，风格一致）

| 项 | V1.1 | V1.2 | V1.3模拟账户 | V1.3建议档案（draft-3新增） | 是否冲突 |
|---|---|---|---|---|---|
| 模块全局变量名 | `window.ETHAlphaCore` | `window.ETHAlphaForecast` | `window.ETHAlphaPaperTrading` | `window.ETHAlphaSignalArchive` | 不冲突 |
| 自定义DOM事件名 | `v11decision`（唯一来源） | 监听既有事件 | 监听既有事件 | 监听既有事件，不新增 | 不冲突 |
| localStorage key | 见§5原表 | 见§5原表 | `ethAlphaPaperAccount`/`ethAlphaPaperTrades`/`ethAlphaPaperLog` | `ethAlphaSignalArchive`/`ethAlphaSignalEvents`/`ethAlphaShadowResults` | 不冲突 |
| `window`暴露的原始引用 | 无 | `window.__lastMarketData`/`window.__prevForecast` | `window.__paperAccount` | 新增`window.__signalArchiveLatest`（供UI渲染层读取本次tick评估后的建议列表，只读，不建议其余模块写入） | 不冲突 |
| DOM id前缀 | 见§5原表 | 见§5原表 | `paperAccount*`/`paperTrade*`/`paperFill*`/`paperLog*` | `signalArchive*`/`signalEvent*`/`shadowResult*`（具体清单由Codex实现时列出并交叉核对） | 需Codex实现时逐一核对 |
| 导出函数名 | 见§5原表 | 见§5原表 | `v1_3-paper-trading-core.js`导出列表（SPEC§11） | `v1_3-signal-archive-core.js`导出列表（SPEC§15.13） | 不冲突，依赖方向：Signal Archive与Paper Trading互相**不**依赖对方内部实现，仅通过`signalId`/`tradeId`指针关联，二者都单向依赖V1.1/V1.2 |
| 测试文件命名 | 见§5原表 | 见§5原表 | `v13-paper-trading-tests.js`等3个 | `v13-signal-archive-tests.js`/`v13-signal-archive-ui-tests.js`/`v13-signal-archive-live-rest-test.js` | 不冲突 |

### 7.5 交付清单（追加，Codex在下一轮实现完成后应交付）

- `v1_3-signal-archive-core.js`
- `work/v1-signal-archive.template.html`
- `tests/v13-signal-archive-tests.js`、`tests/v13-signal-archive-ui-tests.js`、`tests/v13-signal-archive-live-rest-test.js`
- 对`work/build-v1.js`、`work/v1-ui.template.html`（仅新增脚本标签引用位置）的追加式修改（**draft-4更新**：`autoEngineOpenPosition`成功后对`linkSignalToPaperTrade`的单向调用属于Auto Engine自身实现的一部分，见本文档§8，不再是"给draft-2旧函数追加可选参数"这种事后修补模式）
- `V1_3_IMPLEMENTATION_REPORT.md`/`V1_3_TEST_RESULTS.md`需同时覆盖模拟账户与建议档案两部分结果（或分别产出两份对应文档，实现阶段自行决定，本文档不强制）

本节（draft-3文档阶段）同样**不包含**以上任何一项的实际代码，仅作为下一轮实现的工单依据。

---

## 8. draft-4新增：真实行情自动模拟交易引擎 Auto Paper Trading Engine（对应`V1_3_PAPER_TRADING_SPEC.md`§16）

角色重申：本节与§1-§7一样，只是给Codex的工单依据，本文档（含本节）不交付任何实际代码。§1-§6「模拟账户」的账户/风险/撮合**公式**零改动；§7「建议档案与影子验证」零改动；本节新增的是"引擎如何自动调用这些既有公式"这一层，以及§1.2/§3已原地改写的授权模型变化的具体落地。

### 8.1 范围重申（红线，本节专用）

- 不自动下真实订单，不读取/存储/校验任何交易所API密钥，不连接/不模拟连接用户真实交易所账户——三条红线与draft-2/draft-3完全一致，是唯一不受本轮授权模型撤销影响的部分（SPEC §16.0）。
- `PENDING_ENTRY`/`CANCELLED`/`BLOCKED`三个`PositionStatus`**不实现**（SPEC §3.4/§17已撤销）；`confirmReduce`**不实现**（已整体移除）；`confirmConservativeSettlement`**不实现为独立函数**（并入`emergencyClosePosition`）。
- `autoEngineOpenPosition`/`autoEngineAddOn`**必须**由`tickAutoEngine`（每次`v11decision`事件调用）内部触发，**不得**要求任何来自UI点击事件的确认参数——这与§1.2原有红线方向相反，是draft-4最容易在实现阶段"想当然地抄draft-2旧模式"出错的地方，Codex实现前应先完整阅读SPEC §16.0撤销声明。
- `emergencyClosePosition`、引擎开启/暂停/恢复/禁止新开仓/关闭、`resetPaperAccount`/`changeInitialCapital`/`confirmForcedObservationAcknowledgement`**仍然**要求真实UI点击事件+`idempotencyKey`，且这些操作**不得**被`tickAutoEngine`自动调用（红线：引擎自动循环可以"做"的事仅限于开仓/加仓/止损/止盈/分批止盈/移动保护——用户宏观控制与紧急人工介入必须永远来自真实点击，不存在"引擎自己暂停自己"这种设计）。

### 8.2 新增文件规划

| 文件 | 职责 |
|---|---|
| `v1_3-auto-engine-core.js` | 纯逻辑核心：`AutoEngineState`状态机、§16.2十四项自动开仓条件判定、§16.4反向信号冷却期、§16.7心跳/离线回放触发、§16.8幂等key生成。`require('./v1-core.js')`/`require('./v1_2-forecast-core.js')`/`require('./v1_3-paper-trading-core.js')`/`require('./v1_3-signal-archive-core.js')`四者只读依赖（单向：Auto Engine依赖Paper Trading与Signal Archive，反向不允许，与CODEX_TASK §5接口冲突检查表一致），通过`window.ETHAlphaAutoEngine`暴露（浏览器）/`module.exports`（Node测试） |
| `work/v1-auto-engine.template.html` | "500 USDT真实行情自动模拟交易"UI区域模板片段（SPEC §16.9），取代`work/v1-paper-trading.template.html`中"开仓/加仓/减仓/平仓按钮"部分，两个模板文件如何合并/共存由Codex实现阶段决定（建议：`v1-paper-trading.template.html`保留账户字段展示部分，控制面板部分移到本文件，避免同一批HTML片段职责混杂） |
| `tests/v13-auto-engine-tests.js` | 核心逻辑非联网自动化测试（对应`V1_3_ACCEPTANCE_TESTS.md` T44+），命名对齐`v13-signal-archive-tests.js`模式 |
| `tests/v13-auto-engine-ui-tests.js` | 单文件构建产物里的UI接线/DOM事件测试（暂停/恢复/禁止新开仓/紧急平仓按钮、总开关二次确认流程） |
| `tests/v13-auto-engine-live-rest-test.js` | 真实Binance REST生产链测试：真实数据→`buildDecision`→`buildForecast`→`recordSignalIfEligible`→`evaluateShadowSignals`→`tickAutoEngine`（含`autoEngineOpenPosition`真实调用，用完即`disarmAutoEngine`+`resetPaperAccount`+`resetSignalArchive`撤销，不污染任何真实localStorage），对齐既有`v13-*-live-rest-test.js`模式，**不得**只测试到Signal Archive而不真正触发Auto Engine的自动开仓路径 |

### 8.3 实施步骤顺序（Codex必须按此顺序实现，紧接§7工单步骤17之后，不得跳步；依赖draft-2 `v1_3-paper-trading-core.js`与draft-3 `v1_3-signal-archive-core.js`均已实现完毕才能开始本节，因为Auto Engine是二者的消费方）

**步骤18：引擎状态机（对应SPEC §16.1）**

- 实现`AutoEngineState`对应JS对象结构、`armAutoEngine`/`pauseAutoEngine`/`resumeAutoEngine`/`setAllowNewEntries`/`disarmAutoEngine`，覆盖SPEC §16.1完整状态转换表，纯函数校验单独可测（同既有状态机实现模式）。
- **先实现`AUTO_PAPER_DATA_BLOCKED`的`preDataBlockedState`记录/恢复逻辑并配测试**，这是本步骤最容易遗漏边界的地方——历史教训同draft-2步骤1/draft-3步骤10"异常路径与主流程同步实现"的一贯要求。

**步骤19：自动开仓十四项条件与`autoEngineOpenPosition`（对应SPEC §16.2）**

- **红线**：条件6（进场区真实触发）**直接读取**Signal Archive的`ShadowResult`/`SignalSnapshot.lifecycleStatus`投影值判断本次tick是否恰好完成`WAITING_TRIGGER→TRIGGERED`转换，**不重新实现**一遍entryZone触及判定——如果实现时发现"好像重新写一遍判断更方便"，说明对SPEC §16.2的架构决定理解有误，应回头重读SPEC原文而不是绕过它。
- 十四项条件建议按SPEC §16.2列出的顺序逐条实现为独立可测的子判断函数（或至少独立的具名布尔变量），**不要**写成一个大的`&&`链导致某一条判断失败时无法定位是哪一条——这直接影响到`userActionStatus`要精确映射到`AUTO_BLOCKED_BY_RISK`/`AUTO_BLOCKED_BY_POSITION`/`AUTO_MISSED_ENGINE_OFF`/`AUTO_MISSED_DATA_GAP`四个不同值中的哪一个（SPEC §15.9事件表），条件判断本身若不分离会导致无法正确归类。
- `autoEngineOpenPosition`内部调用`buildTradeProposal`得到方案数据后立即执行开仓，`idempotencyKey`按`AUTO-OPEN-${signalId}`规则构造（SPEC §16.8）。
- 开仓成功后**必须**调用Signal Archive的`linkSignalToPaperTrade`（见§7.3步骤15既有实现，本步骤只是从"等待被Paper Trading手动触发"变为"被Auto Engine自动触发"）。

**步骤20：自动加仓`autoEngineAddOn`（对应SPEC §5.2/§16.3）**

- 复用draft-2已实现的§5.2条件1-7判定逻辑（该逻辑本轮零改动，只是调用方从"UI点击事件处理器"变为"`tickAutoEngine`内部循环"），`idempotencyKey`按`AUTO-ADDON-${tradeId}`规则构造。

**步骤21：反向信号冷却期（对应SPEC §16.4，draft-4全新规则，无draft-2先例可复用）**

- 实现`PaperAccount`新增字段`lastPositionClosedAt`/`lastPositionClosedDirection`/`lastPositionClosedBarOpenTime`的更新时机——**必须**在`scanClosedBarsForExits`或`emergencyClosePosition`产生`EXITED`结果的**同一个事务/调用**内更新，不要作为一个独立的、可能被跳过的后续步骤，否则会出现"仓位已平但冷却期字段未更新"的不一致状态。
- 实现`checkReverseSignalCooldown`，**红线**：该函数只在候选`signal.direction !== lastPositionClosedDirection`时才生效拦截，同方向新信号不受本函数影响（SPEC §16.4已明确范围限定于反向）。
- **红线**：不允许在检测到"应平仓"的同一个`tickAutoEngine`调用内，同一tick又立即为反向信号调用`autoEngineOpenPosition`——`scanClosedBarsForExits`产生`EXITED`结果后，本次`tickAutoEngine`调用应该到此为止，反向开仓判定留给**下一次**tick（SPEC §16.4条件1），实现时注意函数调用顺序不要把两者串在同一次循环里"顺手"执行。

**步骤22：真实市场模拟成交术语与浏览器心跳/离线回放（对应SPEC §16.5/§16.7）**

- 心跳/离线检测本身不需要新的定时器——复用既有30秒`v11decision`事件，每次成功处理完一个tick更新`lastEngineHeartbeat`/`lastProcessedBarTime`（SPEC §16.7）。
- 页面加载/`visibilitychange`恢复可见时的回补重放逻辑`replayEngineOfflineGap`，**复用**draft-2`replayDataGap`的K线连续性判断算法（同§7.3步骤13"共享连续性判断逻辑，物理上独立实现"的既有模式，避免与Signal Archive的`replayDataGap`风格实现产生跨模块强依赖），新增`gapCause='ENGINE_OFFLINE'`标记。

**步骤23：幂等键生成规则（对应SPEC §16.8）**

- 实现§16.8全部6类key构造规则的辅助函数（例如`buildAutoIdempotencyKey(kind, ...ids)`），**不要**在每个调用点手写字符串拼接——同一套构造规则被`autoEngineOpenPosition`/`autoEngineAddOn`/自动止损止盈/数据缺口回放补记多处复用，集中实现可以避免某一处拼错格式导致幂等失效。

**步骤24：UI接线（对应SPEC §16.9）**

- 在`eth-dynamic-trading-dashboard.html`现有Signal Archive区域`</section>`之后（draft-3已接线的`signalArchiveSection`之后），新增：
  ```html
  <section class="grid" id="autoEngineSection">
  <!--__AUTO_ENGINE_UI__-->
  </section>
  ```
  新增`<script data-v13="auto-engine">/*__AUTO_ENGINE__*/</script>`，紧跟在V1.3建议档案脚本块`<script data-v13="signal-archive">`之后。
- **事件时序**：Auto Engine的`v11decision`监听器必须在构建产物中位于Signal Archive脚本块**之后**（原因见§7.3步骤16"事件时序要求"draft-4更新说明）。

**步骤25：构建脚本接线**

- `work/build-v1.js`追加（不改动既有条目顺序/内容）：
  ```js
  ['/*__AUTO_ENGINE_UI__*/', <v1-auto-engine.template.html中的HTML片段字符串>, 1, 'V1.3自动模拟交易引擎UI占位符'],
  ```
  末尾核心拼接部分，在`/*__SIGNAL_ARCHIVE__*/`的`replaceExact`调用**之后**追加：
  ```js
  const autoEngineCore = fs.readFileSync(path.join(root,'v1_3-auto-engine-core.js'),'utf8').replace(/<\/script/gi,'<\\/script');
  template = replaceExact(template, '/*__AUTO_ENGINE__*/', autoEngineCore, 1, 'V1.3自动模拟交易引擎核心占位符');
  ```
  最终产物`<script>`块顺序：V1.1核心 → V1.2预测核心 → V1.3模拟交易核心 → V1.3建议档案核心 → V1.3自动引擎核心。

**步骤26：自测与回归**

- 按`V1_3_ACCEPTANCE_TESTS.md` T44+全部测试类别自测通过。
- **必须**重新完整跑一遍`V1_3_ACCEPTANCE_TESTS.md` T27+T43既有回归命令列表，确认零回归；`work/build-v1.js`构建产物逐字节可复现校验需额外确认新增的`/*__AUTO_ENGINE_UI__*/`/`/*__AUTO_ENGINE__*/`占位符替换不破坏既有全部占位符替换。

### 8.4 接口冲突检查清单（追加于§5/§7.4已有表格，风格一致）

| 项 | V1.1 | V1.2 | V1.3模拟账户 | V1.3建议档案 | V1.3自动引擎（draft-4新增） | 是否冲突 |
|---|---|---|---|---|---|---|
| 模块全局变量名 | `window.ETHAlphaCore` | `window.ETHAlphaForecast` | `window.ETHAlphaPaperTrading` | `window.ETHAlphaSignalArchive` | `window.ETHAlphaAutoEngine` | 不冲突 |
| 自定义DOM事件名 | `v11decision`（唯一来源） | 监听既有事件 | 监听既有事件 | 监听既有事件 | 监听既有事件，不新增 | 不冲突 |
| localStorage key | 见§5原表 | 见§5原表 | `ethAlphaPaperAccount`/`ethAlphaPaperTrades`/`ethAlphaPaperLog`（draft-4新增`AutoEngineState`字段落在`ethAlphaPaperAccount`内，不新增key） | `ethAlphaSignalArchive`/`ethAlphaSignalEvents`/`ethAlphaShadowResults` | 不新增key，读写上述既有key | 不冲突 |
| `window`暴露的原始引用 | 无 | `window.__lastMarketData`/`window.__prevForecast` | `window.__paperAccount` | `window.__signalArchiveLatest` | 只读消费以上，不新增全局引用 | 不冲突 |
| DOM id前缀 | 见§5原表 | 见§5原表 | `paperAccount*`/`paperTrade*`/`paperFill*`/`paperLog*` | `signalArchive*`/`signalEvent*`/`shadowResult*` | `autoEngine*`（引擎状态/控制按钮），复用`paperAccount*`前缀展示账户字段（SPEC §16.9大量字段"复用§10"） | 需Codex实现时逐一核对 |
| 导出函数名 | 见§5原表 | 见§5原表 | `v1_3-paper-trading-core.js`（draft-4更新：移除`autoOpenPosition`/`autoAddOn`/`confirmReduce`/`confirmConservativeSettlement`，新增`autoEngineOpenPosition`/`autoEngineAddOn`见下） | `v1_3-signal-archive-core.js`导出列表（SPEC§15.13，`markSignalRejected`已移除） | `v1_3-auto-engine-core.js`导出列表（SPEC§16.10） | 不冲突，依赖方向：Auto Engine依赖Paper Trading与Signal Archive，二者互相不依赖，全部单向依赖V1.1/V1.2 |
| 测试文件命名 | 见§5原表 | 见§5原表 | `v13-paper-trading-tests.js`等3个 | `v13-signal-archive-tests.js`等3个 | `v13-auto-engine-tests.js`/`v13-auto-engine-ui-tests.js`/`v13-auto-engine-live-rest-test.js` | 不冲突 |

### 8.5 交付清单（Codex在下一轮实现完成后应交付）

- `v1_3-auto-engine-core.js`
- `work/v1-auto-engine.template.html`
- `tests/v13-auto-engine-tests.js`、`tests/v13-auto-engine-ui-tests.js`、`tests/v13-auto-engine-live-rest-test.js`
- 对`work/build-v1.js`、`work/v1-ui.template.html`（仅新增脚本标签引用位置）的追加式修改
- 对draft-2交付的`v1_3-paper-trading-core.js`的**修改**（非追加）：移除`autoOpenPosition`/`autoAddOn`/`confirmReduce`/`confirmConservativeSettlement`四个导出函数，新增`autoEngineOpenPosition`/`autoEngineAddOn`/`emergencyClosePosition`（含保守结算分支）——**这是本轮唯一允许对已交付V1.3代码做非追加式修改的例外**，因为SPEC本身已经正式撤销了这几个函数的存在依据，保留死代码会造成"文档说没有但代码里还在"的不一致，风险高于修改本身；`PaperAccount`/`PaperTrade`新增字段（`AutoEngineState`全部字段、`linkedSignalId`、`dataGap.gapCause`）按SPEC §16.11迁移规则实现
- 对draft-3交付的`v1_3-signal-archive-core.js`的**修改**：移除`markSignalRejected`，`userActionStatus`枚举更新为draft-4五值集合
- `V1_3_IMPLEMENTATION_REPORT.md`/`V1_3_TEST_RESULTS.md`需同时覆盖模拟账户、建议档案、自动引擎三部分结果

本节（draft-4文档阶段）同样**不包含**以上任何一项的实际代码，仅作为下一轮实现的工单依据。
