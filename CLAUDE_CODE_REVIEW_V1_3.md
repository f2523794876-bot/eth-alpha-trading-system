# ETH Alpha V1.3 真实行情自动模拟交易 —— 独立复审报告

复审日期：2026-07-15
复审人：Claude（独立复审，未参与 V1.3 实现，未修改任何代码，未提交，未推送，未合并 main）
复审方式：`git worktree add /tmp/v13-review-peek 11fcc9c1cb57a0a442794b9ddcce0eb2521fb1d1 --detach` 隔离检出目标提交，在该隔离目录内静态阅读全部指定文件的完整内容 + 独立重新执行全部测试组（含真实 Binance REST）+ 独立重新执行构建两次核对可复现性 + 独立重新计算 `v1-core.js` SHA-256 + 逐条对照 4 份规范文档手工复算关键公式，不采信 `V1_3_IMPLEMENTATION_REPORT.md`/`V1_3_TEST_RESULTS.md` 的文字结论与数字，全部数字均独立重新产生。复审结束后已删除临时 worktree（`git worktree remove /tmp/v13-review-peek`），未对该提交或任何分支做任何写操作。

---

## 0. 审查的分支和提交

| 项 | 值 |
|---|---|
| 仓库 | `/home/ubuntu/eth-trading-dashboard`（`git@github.com:f2523794876-bot/eth-alpha-trading-system.git`） |
| 请求审查的分支 | `origin/codex/v1.3-auto-paper-trading` |
| 目标提交 | `11fcc9c1cb57a0a442794b9ddcce0eb2521fb1d1`（commit message: `feat: add V1.3 automatic paper trading`；核实**恰好是**该分支当前 HEAD，两者指向同一提交，无分支/提交不一致问题） |
| 对比基准 | `origin/main`（`8a43fa08d5e62ca0d4801cc335b504b9e2f23300`，已包含 draft-4-final 四份规范文档；`merge-base(main, 目标提交)` 核实等于 `main` 本身，即目标提交是在当前 main 基础上新增的单一提交，无需处理分叉） |

`git show --stat` 变更范围：23 个文件，473 行新增（1 行删除），新增 3 个核心 JS 模块（`v1_3-paper-trading-core.js` 49 行、`v1_3-signal-archive-core.js` 31 行、`v1_3-auto-engine-core.js` 30 行，均为极致压缩单行风格，非空文件——逐行阅读后确认是真实、密集的业务逻辑实现，不是占位符或桩代码，这一点需要明确记录，因为仅看行数极易误判为"实现不完整"）、12 个测试文件、4 个 UI 模板片段、`work/build-v1.js`/`work/v1-ui.template.html` 追加式接线、`eth-dynamic-trading-dashboard.html` 128 行新增（经核实与构建产物逐字节一致）、`V1_3_IMPLEMENTATION_REPORT.md`/`V1_3_TEST_RESULTS.md` 两份新文档。

---

## 1. P0/P1/P2 问题数量

| 级别 | 数量 |
|---|---:|
| P0 | 3 |
| P1 | 2 |
| P2 | 2 |

**合并结论：不允许合并 main。** 3 项 P0 均未关闭，其中 2 项是真实的资金/风险安全缺陷（并非文档或测试口径问题）。

---

## 2. P0 问题详情

### P0-1　当日亏损 3% 锁定的 UTC 日界从未真正滚动——多日运行后该风控形同虚设

**文件位置**：`v1_3-paper-trading-core.js` 第 27 行定义 `rollUtcDay(account,trades,now)`，但在整个 473 行新增代码（`v1_3-paper-trading-core.js`/`v1_3-auto-engine-core.js`/`work/v1-ui.template.html` 新增脚本块）中**没有任何一处调用它**。`tickAutoEngine`（`v1_3-auto-engine-core.js` 第 23-27 行）直接读取 `account.riskRegime`（由 `recomputeAccount`→`calcRiskRegime` 计算，`v1_3-paper-trading-core.js` 第 23/26 行），而 `calcRiskRegime` 使用的 `account.dailyStartEquity`/`account.dailyAnchorDateUTC` 只在 `createPaperAccount`（第 10 行）里初始化一次，此后再无任何写入路径。

**复现方式**：
```js
const P = require('./v1_3-paper-trading-core.js');
const s = new (require('./tests/v13-fixtures.js').Storage)();
let a = P.createPaperAccount(500, Date.UTC(2026,0,1));           // day 1
s.setItem(P.KEYS.account, JSON.stringify(a));
// ……第1天正常交易，equity 变为 520……
// 第2天（UTC新自然日）开始，账户从未被 rollUtcDay 处理：
a = P.loadPaperAccount(s);
console.log(a.dailyAnchorDateUTC);   // 仍然是 day 1 的日期，不会自动变为 day 2
```
`calcRiskRegime` 里 `base=account.dailyStartEquity||account.cash` 永远比较的是账户创建（或上一次手工触发）时的历史基准，而不是"UTC 当日开盘净值"。

**影响**：SPEC §5.3、CEO 决策第 8 项、`V1_3_ACCEPTANCE_TESTS.md` T8（当日亏损 3% 锁定，UTC+确定性回退）明确要求"次日 UTC 自动解锁"且锁定判定必须以**当日**净值为基准。当前实现下：
- 若账户运行超过一天，"当日亏损 3%"实际上会退化成"自账户创建以来累计亏损 3%"，可能在没有任何单日亏损达到 3% 的情况下被错误永久锁定（过度保守）；
- 反过来，如果账户整体净值长期趋势上升，某一天真实发生了 3%+ 的当日亏损，也可能因为陈旧的 `dailyStartEquity` 基准过低而**不会触发锁定**——这是更危险的方向：CEO 明确设定的"止损刹车"在多日运行后可能悄无声息地失效。
- `V1_3_ACCEPTANCE_TESTS.md` T8 全部用例（含"次日 UTC 解锁"）在当前实现下**没有对应的真实调用路径可以通过**——已核实 `tests/v13-paper-trading-tests.js`/`tests/v13-auto-engine-tests.js` 中**不存在任何**涉及 `rollUtcDay`/`dailyAnchorDateUTC`/跨日场景的测试（`grep` 结果为空），说明这个缺口从未被验证覆盖到。

**修复建议**：在 `tickAutoEngine` 函数体最开始（`account=account||P.loadPaperAccount(storage)` 之后、`calcRiskRegime` 生效之前）插入 `account=P.rollUtcDay(account,trades,now)`；同时建议在 UI `render()` 读取账户时也调用一次（避免长时间不产生新 `v11decision` 事件时日界仍不刷新）。并补充至少两条真实驱动 `now` 跨越 UTC 零点的单元测试：① 前一天触发 `DAILY_LOSS_LOCKED` 后跨日应自动解锁；② 跨日后 `dailyStartEquity` 正确重建为当日开盘净值而非历史累计值。

---

### P0-2　小仓试错风险预算（0.5%）永远不可能被选中——所有交易都按 1% 而非按信号质量分级风险

**文件位置**：`v1_3-paper-trading-core.js` 第 29 行 `buildTradeProposal`：
```js
riskBudget = equity*(decision?.signalPermission?.level==='trend_entry_allowed'
              ? account.settings.maxRiskPct
              : account.settings.trialRiskPct)
```
对照 `v1-core.js` 第 28 行 `computeSignalPermission`：`full_aligned`（三周期同向，`positionSizeCapPct:20`）与 `partial_aligned`（"部分周期同向，仅允许**小仓试错**，等待结构继续证明"，`positionSizeCapPct:10`）**两种截然不同、CEO 明确要求区别对待的信号质量**，返回的 `level` 字段**都是同一个值 `'trend_entry_allowed'`**（唯一区别是 `alignment` 字段：`'full_aligned'` vs `'partial_aligned'`）。

**复现方式**：
```js
const C = require('./v1-core.js');
// full_aligned 与 partial_aligned 两种场景，人工构造 htf/mtf/ltf 使其分别命中
// computeSignalPermission 的两个不同分支后可验证：
// full_aligned  -> {level:'trend_entry_allowed', alignment:'full_aligned', ...}
// partial_aligned -> {level:'trend_entry_allowed', alignment:'partial_aligned', ...}
// 二者 level 完全相同，buildTradeProposal 的三元表达式对两者取值恒为 maxRiskPct 分支
```
`v1_3-paper-trading-core.js` 里 `trialRiskPct` 分支在当前判据下**是不可达代码**（dead branch）：只要 `decision.worthBetting===true`（这是 `buildTradeProposal`/`opportunityChecks` 允许开仓的前提之一），根据 `v1-core.js` 里 `worthBetting` 的定义（`p.level==='trend_entry_allowed'&&...`），`level` 必然是 `'trend_entry_allowed'`，三元表达式必然进入 `maxRiskPct` 分支。

**影响**：CEO 决策第 2 项与 SPEC §5.1 明确要求"单笔最大风险 1%／试仓风险 0.5%"两级制度（`DEFAULT_SETTINGS.trialRiskPct=0.005` 也确实被定义），但当前判据使得试仓这一档**永远不会生效**——`partial_aligned`（低置信度、"仅允许小仓试错"）的信号会被当成 `full_aligned` 一样按 1%（而不是 0.5%）的风险预算开仓，即**系统性地对低置信度信号承担了两倍于设计意图的风险**，这不是边缘情形，`partial_aligned` 在实盘中出现频率通常不低于 `full_aligned`。需要说明：SPEC §5.1 原文本身（第 313 行）只写"`settings.trialRiskPct或maxRiskPct`"，未逐字指明用哪个字段区分两档，这是规范措辞上的疏漏，一定程度上解释了实现为何会取错字段；但 `computeSignalPermission` 的 `alignment` 字段与 `reason` 文案（"仅允许小仓试错"）已经清楚地把两档信号质量映射到位，`level` 字段客观上不能承担这个区分职责，这一点不依赖规范措辞的精确与否即可判定为实现缺陷。`V1_3_ACCEPTANCE_TESTS.md` T26 也未覆盖"哪个字段决定试仓/单笔档位"这一具体判据，因此测试无法暴露这个问题。

**修复建议**：把判据改为 `decision?.signalPermission?.alignment==='full_aligned' ? maxRiskPct : trialRiskPct`（或更保守地枚举 `['full_aligned'].includes(alignment)` 为 1% 档，其余允许开仓的 `alignment` 一律为 0.5% 档）；同时建议把 SPEC §5.1 第 313 行的措辞改为显式给出选择判据（而不是"或"字带过），避免未来再次出现同类型的字段误选。补充至少一条独立构造 `partial_aligned` 信号的测试，断言 `riskBudget===equity*trialRiskPct`。

---

### P0-3　数据缺口保守结算在真实路径下永远失败——唯一合规退出方式实质不可用

**文件位置**：`v1_3-paper-trading-core.js` 第 41 行 `confirmDataGapConservativeSettlement`：
```js
const ref=trade.dataGap?.firstAvailableAdversePrice;
if(!finite(ref))return{ok:false,reason:'缺少可验证的首个不利价格'};
```
全仓库范围内检索 `firstAvailableAdversePrice`（`grep -rn` 覆盖全部 `.js`/`.html`/`.md`），**唯一**赋值该字段的位置是 `tests/v13-paper-trading-tests.js` 第 22 行的单元测试**手工伪造**：`t.dataGap={firstAvailableAdversePrice:2900}`。生产路径中会真正写入 `trade.dataGap` 的两处——`v1_3-paper-trading-core.js` 第 42 行 `replayDataGap` 的"不完整覆盖"分支、`v1_3-auto-engine-core.js` 第 21 行 `markGaps`——写入的对象里**都没有这个字段**（分别是 `{coverageComplete:false,gapCause,replayAttempts:[...]}` 与 `{startBarOpenTime,detectedAt,missingBarCount:null,replayAttempts:[],resolvedAt:null,coverageComplete:false,gapCause}`）。

**复现方式**：
```js
const P = require('./v1_3-paper-trading-core.js'), X = require('./tests/v13-fixtures.js');
const {a,s} = X.account(P), d = X.decision();
P.autoEngineOpenPosition(X.signal(d), d, null, a, s);
const t = P.loadPaperTrades(s)[0];
// 真实路径进入缺口：连续15分钟K线不连续 -> replayDataGap 判定 coverageComplete=false
const gapBar = X.bar(t.lastScannedBarOpenTime + 1800000); // 跳过一根K线，制造真实不连续
P.replayDataGap(t, [gapBar], P.loadPaperAccount(s), s);
const gapped = P.loadPaperTrades(s)[0];
console.log(gapped.status, gapped.dataGap);
// status === 'UNRESOLVED_DATA_GAP'，dataGap 里没有 firstAvailableAdversePrice
const r = P.confirmDataGapConservativeSettlement(gapped, P.loadPaperAccount(s), s, 'GAP-REAL');
console.log(r); // {ok:false, reason:'缺少可验证的首个不利价格'} —— 永远失败
```

**影响**：这不是罕见边界情形，而是"数据缺口保守结算"这一功能在**任何**真实触发场景下都无法完成。后果链条：① SPEC §16.6a/T49.5 明确 `emergencyClosePosition` 在 `UNRESOLVED_DATA_GAP` 下**直接拒绝**（已核实此半正确，`v1_3-paper-trading-core.js` 第 40 行确有此校验）；② 唯一合规出口 `confirmDataGapConservativeSettlement` 又因本缺陷永远失败；③ `disarmAutoEngine`（`v1_3-auto-engine-core.js` 第 11 行）要求"账户不存在任何非终态 `PaperTrade`"才允许关闭引擎——三者叠加意味着一旦真实发生数据缺口且无法自动回补，**该模拟仓位会永久卡死，用户既不能紧急平仓，也不能保守结算，也无法关闭自动引擎**，这正是本轮 CEO"最终一致性修正"专门设计"有持仓禁止关闭+保守结算独立出口"这套机制原本要防止的死锁场景，现在因为这个字段缺口而重新出现。`tests/v13-paper-trading-tests.js` 第 22 行的"保守结算独立语义"测试因为手工构造了本该由生产代码计算的字段，**掩盖了这个缺陷**，是 CEO 复审要求里明确点名要排查的"绕过真实路径的手工字段构造"的具体实例。

**修复建议**：在 `replayDataGap` 判定为不完整覆盖时（`v1_3-paper-trading-core.js` 第 42 行 `if(!complete||!sorted.length)` 分支），以及 `markGaps`（`v1_3-auto-engine-core.js` 第 21 行）写入 `dataGap` 时，按 SPEC §8.5/§16.6b 规则——"缺口结束后第一根可获得的已收盘K线的 open 价格，按方向叠加不利滑点"——只要有新的已收盘K线到达（即便仍不足以完整回补整个缺口），就应计算并持久化 `dataGap.firstAvailableAdversePrice`（多单按 SELL 方向不利、空单按 BUY 方向不利，复用 `fillPrice()`）。同时把 `tests/v13-paper-trading-tests.js` 第 22 行的测试改为从真实 `replayDataGap`/`markGaps` 路径产生 `UNRESOLVED_DATA_GAP` 后再调用 `confirmDataGapConservativeSettlement`，不再手工写入 `dataGap` 字段。

---

## 3. P1 问题详情

### P1-1　三份 V1.3"真实 REST 生产链"测试手工覆盖了 V1.1 的真实交易许可判定字段

**文件位置**：`tests/v13-live-rest-test.js`、`tests/v13-signal-archive-live-rest-test.js`、`tests/v13-auto-engine-live-rest-test.js` 三个文件均遵循同一模式：先用真实 `C.fetchAllTimeframeKlines`→`C.buildDecision`→`F.buildForecast` 取得真实行情与真实决策对象 `raw`/`d`，随后立即：
```js
const h={...d, worthBetting:true, biasDirection:side, dataHealth:'normal', isManual:false,
  opportunityScores:{...d.opportunityScores, blocked:false, blockReasons:[]},
  signalPermission:{...d.signalPermission, level:'trend_entry_allowed', addOnAllowed:true},
  triggerPlans:{...d.triggerPlans,[side]:{estimatedEntry:price, entryZone:[...], invalidation:..., targets:[...]}}}
```
即手工覆盖了决定"是否应该开仓"的全部关键字段（`worthBetting`/`opportunityScores.blocked`/`signalPermission.level`/`triggerPlans`），只保留 `confirmedPrice`/`atr14` 等数值取自真实行情。

**影响**：`V1_3_TEST_RESULTS.md` 将这些测试描述为"V1.3自动引擎链**实际经过**：六路REST → buildDecision → buildForecast → recordSignalIfEligible → tickAutoEngine → 虚拟开仓"，字面属实（调用链确实被执行到），但容易让读者误以为验证了"真实市场条件下 V1.1 判定值得交易时，引擎正确自动开仓"这一端到端场景——实际上被验证的只是"给定一个人工拼装的、保证可交易的决策对象，引擎的机械执行是正确的"，`worthBetting`/`opportunityScores`/`signalPermission` 这些**真正体现 V1.1 交易许可判定**的字段完全没有用真实行情产生的原始值，因为等待真实行情自然出现一个立即可交易的信号在测试运行时点几乎不可能保证发生。这正是 CEO 复审清单第十条明确要求排查的"是否有绕过真实路径的手工字段构造"，在这三个文件中确认存在且是系统性模式（不是单次疏忽）。

**修复建议**：在 `V1_3_TEST_RESULTS.md`/`V1_3_IMPLEMENTATION_REPORT.md` 中明确披露"真实REST测试使用真实价格/ATR/数据健康度，但交易许可相关字段（worthBetting/opportunityScores/signalPermission/triggerPlans）为保证测试确定性而人工构造"，避免"生产链完整覆盖"的表述被过度解读；有条件的话补充一种"多次轮询真实数据，若恰好出现真实可交易信号则额外断言"的非强制测试，用于偶发场景下验证纯有机路径。

### P1-2　"T1–T58 验收矩阵 284 项"并非 284 个独立断言，仍有相当数量的验收行没有任何行为级测试兜底

**文件位置**：`tests/v13-acceptance-matrix-tests.js`。核实其对每个从 `V1_3_ACCEPTANCE_TESTS.md` 解析出的 284 个 `T\d+(\.\d+)?` 编号，只是按编号区间套用四组**完全相同**的通用断言（`n<=26`一组、`n<=42`一组、`n<=56`一组、其余一组），并非分别验证每一行具体描述的行为（例如它不会检查 T2.3 的精确成交价公式、T6.6 的具体越界拒绝文案数字、T7.9 的措辞扫描等）。`V1_3_TEST_RESULTS.md` 已诚实披露"不能把后者误读为284套彼此独立的端到端市场场景"，这一点应予肯定；但即便按披露口径理解，这 284 项本质上只是"编号存在性+模块版本/接口存在性"检查，真正的行为级验证依赖另外 159 项聚焦测试，而经核对，`V1_3_ACCEPTANCE_TESTS.md` 中相当一部分具体用例行（尤其 T7 系列多条禁止加仓反例、T20 精度边界、T40 统计分组的多个子项等）在 159 项聚焦测试中**找不到一一对应的独立断言**。

**影响**：不构成"数字造假"（443 与 284 两个数字本身可独立复现，见第 4 节），但存在"验收覆盖率被高估"的风险——284 这个数字容易被非技术读者当作"284 处规范要求都被验证过"，而实际有效行为覆盖率明显更低。

**修复建议**：`V1_3_TEST_RESULTS.md` 中改为分别报告"结构性检查通过数"与"行为级断言实际覆盖的验收行数量"两个数字；后续实现中逐步为 159 项之外的验收行补齐专门断言，或在文档中明确列出当前未覆盖的具体编号清单。

---

## 4. P2 问题详情

### P2-1　`buildTradeProposal` 未直接复用 `C.calcRiskBudget`，而是独立重新推导了等价公式

**文件位置**：`v1_3-paper-trading-core.js` 第 29 行 `unitRisk=Math.abs(entry-stop)+entry*(takerFeeRate*2+spreadRate+slippageRate*2)` 与 `v1-core.js` 第 58 行 `calcRiskBudget` 内部 `costRate=(takerFeeRate+spreadRate/2+slippageRate)*2`。经手工代数核对，两者化简后**数学等价**（`costRate` 展开即 `2×takerFeeRate+spreadRate+2×slippageRate`，与 `unitRisk` 里的成本项完全相同），当前**没有发现数值偏差**。但 SPEC §5.1（第 310-314 行）与函数清单（第 41 行）明确要求"复用 `v1-core.js` 已导出的 `calcRiskBudget(entry,stop,settings,cost)` 作为核心求解公式"，实现选择了独立重新推导而非直接调用，属于对"单一事实来源"架构原则的偏离——若未来 `calcRiskBudget` 的公式发生任何合规修订，`v1_3-paper-trading-core.js` 里的这份内联副本不会自动跟随变化，也没有任何测试会检测出两者不再等价。

**修复建议**：改为直接调用 `C.calcRiskBudget(entry, stop, {capital:equity, maxRiskPct, leverage}, {takerFeeRate,spreadRate,slippageRate})` 取得 `suggestedNotional` 后再换算 `quantity`；若维持现状，至少补充一条对两个公式在若干随机输入下数值相等的交叉验证测试。

### P2-2　`AUTO_PAPER_PAUSED` 状态下风控锁定不会转入 `AUTO_PAPER_RISK_LOCKED`（状态标签偏差，非保护缺口）

**文件位置**：`v1_3-auto-engine-core.js` 第 24 行：
```js
if(account.riskRegime!=='NORMAL'&&['AUTO_PAPER_RUNNING','AUTO_PAPER_ARMED'].includes(account.engineState))
  account.engineState='AUTO_PAPER_RISK_LOCKED';
```
SPEC §16.1 状态转换表明确列出 `AUTO_PAPER_RUNNING`**/**`AUTO_PAPER_PAUSED` 两者都应在 `riskRegime` 锁定时转入 `AUTO_PAPER_RISK_LOCKED`，代码的判断数组里遗漏了 `'AUTO_PAPER_PAUSED'`。

**实际影响评估**：已核实这**不是**真正的保护缺口——`opportunityChecks`（同文件第 15 行）的"当日风控"/"回撤风控"检查独立于 `engineState` 具体取值，`scanClosedBarsForExits` 对已有仓位的止损/止盈保护也不依赖 `engineState`，因此暂停状态下即使风控锁定未被正确标记，新开仓/加仓依旧会被正确拦截，已有仓位依旧会被正确保护。唯一的实际后果是：① UI 展示的引擎状态文案不准确（仍显示"已暂停"而非"风险锁定"）；② 风控解除后依赖 `else if(...)account.engineState='AUTO_PAPER_RUNNING'`（同一行的另一半）的自动恢复逻辑不会触发（因为从未进入过 `RISK_LOCKED`），导致账户会一直停留在 `PAUSED`，需要用户手动点"恢复"，而不是 SPEC 承诺的自动恢复到 `RUNNING`。

**修复建议**：将判断数组改为 `['AUTO_PAPER_RUNNING','AUTO_PAPER_ARMED','AUTO_PAPER_PAUSED']`。

---

## 5. V1.1 / V1.2 / V1.3 独立测试实际通过/失败数量（全部本轮独立重新执行，非采信文档）

| 测试组 | 通过 | 失败 | 与文档声称数字是否一致 |
|---|---:|---:|---|
| V1.1 非联网回归（`v1-tests.js`38 + `v11-tests.js`17 + `audit-fixes-tests.js`15 + `v11-ui-tests.js`12 + `third-review-tests.js`11） | 93 | 0 | 一致 |
| V1.1 真实 REST（`live-rest-test.js`） | 8 | 0 | 一致 |
| V1.2 非联网回归（`v12-forecast-tests.js`250 + `v12-ui-tests.js`49） | 299 | 0 | 一致 |
| V1.2 真实 REST 生产链（`v12-live-rest-test.js`） | 24 | 0 | 一致 |
| V1.3 聚焦业务/UI/文档测试（paper-trading 35 + signal-archive 33 + auto-engine 26 + ui-tests 22 + auto-engine-ui-tests 22 + signal-archive-ui-tests 14 + docs-consistency 7） | 159 | 0 | 一致 |
| V1.3 T1–T58 验收矩阵（`v13-acceptance-matrix-tests.js`） | 284 | 0（但见 P1-2，通过不等于逐行行为验证） | 数字一致，性质需按 P1-2 重新解读 |
| V1.3 真实 REST 生产链（模拟账户6 + 建议档案6 + 自动引擎8） | 20 | 0（但见 P1-1，决策关键字段被人工覆盖） | 数字一致，性质需按 P1-1 重新解读 |
| 构建可复现性（两次独立 `node work/build-v1.js` 输出 SHA-256） | 一致（`8f3c6a07…`） | — | 通过 |
| 正式 HTML 与构建产物一致性（`git diff` 检出的 HTML vs 重新构建产物） | 无差异 | — | 通过 |
| `v1-core.js` 冻结哈希 | `0a4d9e712859d79ecae592aacffe371abfba29a2c6b7b76119a68c49e0471a97` | — | 与文档声称值一致，V1.1 核心确认未被触碰 |

**443 项 V1.3 自动化数字核实**：159（聚焦测试）+284（验收矩阵）=443，与文档声称的"443项通过"一致，**不存在重复计数**——两组测试分别针对不同粒度（聚焦测试=具体业务场景断言，验收矩阵=规范编号存在性/接口证据检查），彼此没有重叠的测试用例定义，是两个互补而非冗余的集合，但如 P1-2 所述，"284"这个数字的实际验证深度不应被高估。

未发现"测试复制实现中同一错误清单"的证据——恰恰相反，本轮找到的 3 个 P0 问题（UTC日界未滚动、试仓风险档位不可达、保守结算字段缺失）**都没有**被现有测试覆盖到，说明测试盲区与实现盲区高度重合，但并非测试代码抄袭了实现代码的错误假设，而是两者各自独立地都遗漏了同一批边界场景（跨日、partial_aligned 信号分级、真实缺口回放链路）。

---

## 6. 真实 REST 是否真正覆盖 V1.3 自动交易生产链

**部分覆盖，有明确保留意见（见 P1-1）**。真实 Binance 公开 REST 数据确实被用于取得价格、ATR、`dataHealth`、K线收盘时间等数值型输入，且六路 REST→`buildDecision`→`buildForecast`→`recordSignalIfEligible`→`tickAutoEngine`→虚拟开仓→关联→重复刷新去重 这条调用链在 `tests/v13-auto-engine-live-rest-test.js` 中被真实、完整地执行了一遍（本轮独立重跑确认 8/8 通过）。但链路中"是否应该开仓"这一核心决策所依赖的 `worthBetting`/`opportunityScores`/`signalPermission`/`triggerPlans` 字段是测试手工覆盖产生的，不是真实行情在测试运行当下自然产生的判断结果，因此**不能**认为已经端到端验证了"真实市场条件驱动 V1.1 做出真实判断、该判断驱动引擎自动交易"这一完整场景，只能认为验证了"给定一个基于真实价格拼装的可交易信号，引擎的执行环节是正确的"。

## 7. 500 USDT 账户会计是否正确

**核心公式正确，但受 P0-2 影响，实际风险预算档位选择错误。** 独立复算并确认：`cash=initialCapital+realizedPnlGross-feesTotal`、`equity=cash+unrealizedPnl`、`availableBalance=equity-marginUsed` 三个恒等式的实现（`recomputeAccount`，`v1_3-paper-trading-core.js`第23行）与 SPEC §2.2 逐字一致；`calcBreakevenStop` 闭式解（第 34 行）与 SPEC §6.10 的推导公式**逐项手工代数核对完全一致**（含 `R=realizedPnl-fees` 的定义、多空两个方向的分母结构）；滑点未被重复扣除（`slippageCost` 只在 `makeFill` 里按一次价格偏移计算一次，`account.slippageCostReport` 只累加一次）；杠杆经核实只出现在 `margin=notional/leverage` 与可用余额前置校验里，风险预算/`unitRisk`/`qty` 计算全程不引用 `leverage`，符合"杠杆不得扩大风险预算"红线。50/30/尾差清零、同K线止损优先、跳空止损用不利开盘价、止盈不因有利跳空改善成交价，均逐条手工构造场景验证正确。**但**由于 P0-2，试错 0.5% 档位实际不可达，account 层面记录的每一笔 `riskBudget` 在 `partial_aligned` 场景下都会偏高一倍，这是会计公式本身之外的风险控制正确性问题。

## 8. 自动交易是否真的由真实市场数据驱动

**是，止损/止盈/开仓价格机制上确认只使用已收盘15分钟K线**（`scanClosedBarsForExits` 过滤 `isClosed!==false`，`v1_3-paper-trading-core.js`第38行），未收盘价格（`markPrice`/`decision.price`）确认只用于持仓估值（`calcUnrealizedPnl`）与紧急平仓这一刻意允许使用实时价的例外场景，不用于自动止损/止盈/开仓判定；不存在固定演示数据、不要求逐笔点击（UI wiring 确认 `tickAutoEngine` 挂在真实 `v11decision` 事件上，非 `setInterval` 定时器伪造）。但如 P1-1 所述，"值得交易"这一判断本身在测试环境下被人工构造，不代表实现存在缺陷，只代表这一结论目前只能由代码走查而非真实市场自然触发的测试来支撑。

## 9. 是否存在任何真实下单或密钥访问路径

**不存在。** 全仓库（含新增 V1.3 文件与生成的 `eth-dynamic-trading-dashboard.html`）搜索 `apiKey`/`secret`/`signature`/`hmac`/`createOrder`/`placeOrder`/`/api/v3/order`/`withdraw` 等关键词均无匹配；`v1-core.js` 唯一的网络请求目标是 Binance 公开只读端点 `GET /api/v3/klines`（无需签名、无需 API Key）。三条红线（不连接交易所账户、不读取密钥、不发送真实订单）确认成立。

## 10. Chrome 人工验收是否仍未完成

**仍未完成，且这一点已被文档如实自我披露、未计入自动化数量。** `V1_3_TEST_RESULTS.md`"人工Chrome验收"一节明确写"0项完成，1项环境阻塞"，注明是 Codex 桌面会话无法连接 Chrome Extension 导致，未用其他方式冒充完成，也未把该项计入 443 项自动化数字——本轮复审认可这一处理方式是诚实的，但仍需指出：规范列出的双击页面交互清单（弹窗确认文案、按钮禁用状态、UI 实际渲染）目前完全没有在真实浏览器环境中被验证过，`work/v1-ui.template.html` 的事件绑定与 DOM 更新逻辑目前只经过字符串/正则级别的 `v13-ui-tests.js`/`v13-auto-engine-ui-tests.js` 检查，未经真实 DOM 运行时验证。

## 11. 是否允许合并 main

**不允许。** 3 项 P0 未关闭（其中 2 项——当日亏损锁定日界不滚动、试仓风险档位不可达——直接影响资金安全与风险控制，1 项——保守结算字段缺失——直接影响数据恢复与自动交易可用性，均落在合并标准明确排除的类别内），2 项 P1 未关闭。按既定合并标准，任何 P0/P1 未关闭即不允许合并；P2 的 2 项本身不足以阻塞合并，但需等 P0/P1 关闭后一并处理。建议 Codex 按第 2/3 节修复建议逐条修复并补充对应回归测试后，再提交下一轮独立复审。
