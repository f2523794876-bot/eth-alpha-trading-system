# V1_3_ARCHITECTURE_REVIEW.md — V1.3「模拟交易账户」架构复核与一致性核查

版本：v1.3-draft-1
角色：本文档是四份V1.3文档中的最后一份，职责是**核对前三份文档（`V1_3_PAPER_TRADING_SPEC.md`/`V1_3_CODEX_IMPLEMENTATION_TASK.md`/`V1_3_ACCEPTANCE_TESTS.md`）互相一致**，核对与V1.1/V1.2/`STRATEGY_SPEC.md`既有代码接口的一致性，给出风险清单，并作为交给CEO复审的入口文档。本文档不新增算法规则，如发现三份文档之间的不一致，以`V1_3_PAPER_TRADING_SPEC.md`为准并在此记录。

---

## 0. 基准确认

| 项 | 值 |
|---|---|
| 基准分支 | `main` |
| 基准标签 | `v1.2.0`（提交 `0dc1943e744f0e997f48c7e2470f71fd80a64c64`） |
| 工作分支 | `claude/v1.3-paper-trading-spec` |
| V1.2预测层确认 | `main`已合并`v1_2-forecast-core.js`/`V1_2_FORECAST_SPEC.md`/`tests/v12-*.js`，`v1-core.js` SHA-256为`0a4d9e712859d79ecae592aacffe371abfba29a2c6b7b76119a68c49e0471a97`（V1.1冻结），本轮基于此基准展开设计，未修改任何既有文件 |

---

## 1. 三份V1.3文档一致性核对表

| 概念 | SPEC定义章节 | CODEX_TASK是否落地 | ACCEPTANCE_TESTS是否覆盖 | 一致？ |
|---|---|---|---|---|
| `PaperAccount`/`PaperAccountSettings`接口 | §2.1 | 步骤1 | T1 | 一致 |
| 会计恒等式 | §2.2 | 步骤1 | T1.2-T1.5 | 一致 |
| "模拟USDT本位合约"边界（不做强平） | §2.3 | 1.2禁止清单隐含（未新增强平逻辑） | 无专项用例（因为是"不做什么"，用T1/T2/T3的正常流程间接印证没有强平字段出现） | 一致，建议实现时对`PaperTrade`接口做一次"字段黑名单"扫描（不出现`liquidationPrice`等字段），本文档在此补充为验收隐含要求 |
| 初始本金修改/重置二次确认 | §2.4 | 步骤5 | T1.6-T1.9、T16 | 一致 |
| 持仓并发范围（单方向） | §3.1 | 步骤2状态机 | T21（间接：已有反方向持仓时新开仓应被状态机拒绝，建议在实现时把这条也纳入T21用例，本文档标注为待补） | **需在实现阶段于T21补充一条"反向持仓拒绝"用例**，见§4风险清单 |
| `PaperTrade`/`PaperFill`接口 | §3.2-§3.3 | 步骤1/3 | T2、T3、T19 | 一致 |
| 状态机 | §3.4 | 步骤2 | T21 | 一致 |
| 未实现/已实现盈亏公式 | §4.1-4.2 | 步骤3 | T2.6、T3.5 | 一致 |
| 加权平均建仓价 | §4.3 | 步骤3 | T6.2 | 一致 |
| 手续费/滑点公式 | §4.4 | 步骤3 | T4 | 一致 |
| 单笔/试仓风险预算 | §5.1 | 步骤2 | 间接覆盖于T6.3（加仓风险预算测试同时验证了`calcRiskBudget`调用方式），建议实现阶段为T2/T3补充独立的"试仓风险预算金额=净值×0.5%"数值断言 | **建议实现阶段补充独立数值断言**，见§4风险清单 |
| 加仓风险预算（STRATEGY_SPEC §8.2实现） | §5.2 | 步骤2/3 | T6、T7 | 一致 |
| 当日亏损锁定 | §5.3 | 步骤2 | T8 | 一致 |
| 总回撤强制观察 | §5.4 | 步骤2 | T9 | 一致 |
| 杠杆边界（不进入风险预算公式） | §5.5 | 步骤2/3 | 无专项用例（当前T6.3等隐含验证了风险预算公式不含杠杆项），建议补充一条"改变杠杆不改变`maxLossAmount`"的显式回归用例 | **建议实现阶段补充**，见§4风险清单 |
| 交易方案生成 | §6.1 | 步骤3 | T2.1、T17、T18 | 一致 |
| 参考价/撮合时间/陈旧禁止成交 | §6.2 | 步骤3 | T10 | 一致 |
| 滑点方向/手续费 | §6.3-6.4 | 步骤3 | T4 | 一致 |
| REST轮询复用（不新增） | §6.5 | 步骤4（事件时序） | 无专项自动化用例（属于"没有新增网络调用"这类反向断言，建议在`v13-live-rest-test.js`里加一条"整个测试过程中fetch调用次数不超过V1.1本身产生的次数"的计数断言） | **建议实现阶段补充**，见§4风险清单 |
| K线OHLC扫描止损止盈 | §6.6 | 步骤3 | T2.4/T2.5、T3.3/T3.4 | 一致 |
| 同K线冲突 | §6.7 | 步骤3 | T12 | 一致 |
| 跳空止损/止盈保守成交 | §6.8-6.9 | 步骤3 | T13 | 一致 |
| 部分止盈/移动止损 | §6.10 | 步骤3 | T5 | 一致 |
| 防重复点击 | §6.11 | 步骤3 | T11 | 一致 |
| 精度/最小名义价值 | §6.12 | 步骤3 | T20 | 一致 |
| V1.1/V1.2权限边界 | §7.1 | 步骤4 | T17、T18 | 一致 |
| 建仓快照冻结（深拷贝） | §7.2 | 步骤4 | T19 | 一致 |
| 事件时序（V1.3监听器在V1.2之后） | §7.3 | 步骤6/构建接线§4 | 无专项自动化用例（建议`v13-ui-tests.js`对构建产物做正则断言，确认`data-v13`脚本块在`data-v12`脚本块之后出现） | **建议实现阶段补充**，见§4风险清单 |
| 数据失败展示/恢复重扫 | §8 | 步骤3/4 | T10、（数据恢复重扫的完整链路）建议补充专项"断连后K线积压逐根扫描"用例 | **建议实现阶段补充**，见§4风险清单 |
| localStorage schema/迁移 | §9 | 步骤1 | T14 | 一致 |
| UI字段与文案 | §10 | 步骤6 | 建议`v13-ui-tests.js`对照`v12-ui-tests.js`已有的"禁用交易宣传措辞"/"常驻免责声明"正则扫描模式，逐条覆盖 | 一致（具体实现阶段落地） |
| 函数接口清单 | §11 | 步骤1-5 | 覆盖于T1-T20全部功能测试 | 一致 |
| 版本号红线 | §12 | 未在步骤中单列，建议补充为步骤1的一部分 | 无专项用例，建议比照`V1_2_FORECAST_SPEC.md`checksum模式补充一条"版本号常量与算法变化同步"回归用例 | **建议实现阶段补充**，见§4风险清单 |

**结论**：三份文档核心概念覆盖完整、互相引用一致；本节标记的"建议实现阶段补充"共6项，均为**测试覆盖粒度的加强建议**，不是设计矛盾或缺口，将在下一轮`V1_3_CODEX_IMPLEMENTATION_TASK.md`执行时一并转化为`V1_3_ACCEPTANCE_TESTS.md`的具体新增用例（不在本轮文档交付范围内修改测试文档本身，因为本轮不产出可执行代码，用例的精确断言写法最好等实现阶段结合真实函数签名一起定稿，避免文档阶段就把断言写死导致与实现细节脱节）。

---

## 2. 与既有代码接口的核对表（对照V1.2文档同款"因子对照表"风格）

| V1.3读取的字段 | 来源 | 真实存在？（本次复核方式） | 用途 |
|---|---|---|---|
| `decision.biasDirection` | `v1-core.js buildDecision` | 存在（`d.biasDirection=ad.biasDirection`） | 开仓方向门禁 |
| `decision.worthBetting` | 同上 | 存在（`worthBetting=!manual&&health==='normal'&&p.level==='trend_entry_allowed'&&...`） | 开仓门禁 |
| `decision.opportunityScores.blocked` | 同上，经`calcOpportunityScores`/`assessHardBlocks` | 存在 | 硬性否决门禁 |
| `decision.signalPermission.addOnAllowed` | 同上，经`computeSignalPermission` | 存在（仅`full_aligned`为true） | 加仓结构性条件 |
| `decision.stopLoss`/`decision.targets` | 同上，经`buildStopAndTargets` | 存在 | 建仓止损/目标来源 |
| `decision.exitConditions` | 同上，经`buildExitConditions` | 存在 | `invalidation`快照字段来源 |
| `decision.dataHealth` | 同上，经`assessOverallHealth` | 存在，取值`'normal'/'delayed'/'invalid'` | 陈旧/失效门禁 |
| `decision.isManual` | 同上 | 存在 | 手动模式门禁 |
| `decision.price`/`decision.confirmedPrice` | 同上（`e15.price`/`e15.confirmedPrice`） | 存在，两者语义不同（本文档已在SPEC §4.1明确区分用途） | 估值用`price`，判定用已收盘K线 |
| `C.calcRiskBudget(entry,stop,settings,cost)` | `v1-core.js`已导出 | 存在（含`maxLossAmount`/`suggestedNotional`/`suggestedMargin`/`totalRisk`/`projectedAddOnRisk`/`addOnWithinBudget`） | V1.3风险预算核心复用 |
| `C.csvCell` | `v1-core.js`已导出 | 存在 | V1.3 CSV导出转义复用 |
| `C.validateRiskSettings`风格 | `v1-core.js`已导出（虽是V1.1自己的设置校验，V1.3参照其风格自建`validatePaperAccountSettings`，不直接复用同一函数因为字段集合不同） | 存在，仅作风格参照 | 一致性参照 |
| `window.__lastMarketData` | V1.1既有（`work/v1-ui.template.html`：`cache=await C.fetchAllTimeframeKlines();window.__lastMarketData=cache;`） | 存在 | V1.3撮合与K线扫描的数据来源 |
| `window.__prevForecast` | V1.2既有 | 存在 | `forecastSnapshot`来源 |
| `v11decision`自定义事件 | V1.1既有（`document.dispatchEvent(new CustomEvent('v11decision',{detail:d}))`） | 存在 | V1.3驱动估值刷新与K线扫描的唯一事件源 |
| `window.invalidateDashboard`钩子链 | V1.1既有，V1.2已包装 | 存在（V1.2已在其基础上追加`clearForecast`），V1.3将在该包装链末尾**再次追加**（不覆盖V1.2的包装），实现方式与V1.2包装V1.1的手法一致 | 数据失败展示 |
| `assessDataQuality`的`isStale`阈值 | `v1-core.js` | 存在（`max(2×TF_MS[timeframe],1800000)`） | V1.3陈旧判定直接复用，不新定义 |

**结论**：本文档引用的全部V1.1/V1.2字段与函数经复核确认真实存在于当前`main`分支代码中，命名与实际导出完全一致，未出现"臆想接口"问题（这正是`V1_2_ARCHITECTURE_REVIEW.md`draft-1阶段曾经犯过、后来在draft-2修正的错误类型，本轮从设计之初就已核对源码，不是先写文档再核对）。

---

## 3. 命名空间与localStorage冲突核查

| 命名空间类型 | V1.1 | V1.2 | V1.3 | 冲突？ |
|---|---|---|---|---|
| localStorage key | `ethAlphaDecisionLogs`/`ethAlphaRiskSettings` | `ethAlphaForecastLogs` | `ethAlphaPaperAccount`/`ethAlphaPaperTrades`/`ethAlphaPaperLog` | 不冲突 |
| `window`全局对象 | `ETHAlphaCore` | `ETHAlphaForecast` | `ETHAlphaPaperTrading` | 不冲突 |
| `window`原始引用 | 无 | `__lastMarketData`/`__prevForecast` | 新增`__paperAccount`（只读展示用） | 不冲突 |
| 自定义DOM事件 | `v11decision`（唯一来源） | 监听既有，不新增 | 监听既有，不新增 | 不冲突 |
| 测试文件命名 | 6个既有文件 | `v12-*.js`三个 | `v13-*.js`三个 | 不冲突 |
| 构建占位符 | `/*__CORE__*/` | `/*__FORECAST__*/` | `/*__PAPER__*/`、`/*__PAPER_UI__*/`（新增） | 不冲突，且顺序要求见SPEC§7.3 |

---

## 4. 风险清单

1. **测试覆盖粒度待加强项（6项，见§1表格标注）**：均为"建议在实现阶段补充更细粒度断言"，不是设计缺口，风险等级低，已逐条列出，转交`V1_3_CODEX_IMPLEMENTATION_TASK.md`执行时处理。
2. **历史文档措辞过时（不在本轮范围内修改）**：`CODEX_IMPLEMENTATION_TASK.md`第54/145/217/272行、`STRATEGY_SPEC.md`第936-938行、`V1_2_CODEX_IMPLEMENTATION_TASK.md`第30/247行仍把"模拟仓位"描述为V3范围或一个简化的"标注+outcome字段"概念，与本轮V1.3的实际范围和数据结构不再一致。本轮按任务要求只新增四份V1.3文档、不回填修改历史文档，此项需要CEO决定是否在下一轮追加一次"历史文档措辞对齐"的小改动（性质类似`V1_2`收尾时的`docs(v1.2): align factor terms and test numbering`提交）。
3. **`calcRiskBudget`复用的字段冗余**：`v1-core.js calcRiskBudget(entry,stop,settings,cost)`的`settings`参数本身携带`takerFeeRate`/`spreadRate`/`slippageRate`字段，但函数体实际只使用单独传入的`cost`参数计算成本率（`settings`里的同名字段在该函数内被忽略）——这是V1.1既有代码的实现细节（不属于V1.3引入的问题），V1.3调用时必须显式传入`cost`参数而不能假设"把值放进`settings`就会生效"，`V1_3_CODEX_IMPLEMENTATION_TASK.md`步骤2实现时需要注意这个既有陷阱，本文档在此提前预警，避免重蹈"看接口签名以为参数会被使用，实际被忽略"的实现错误。
4. **`equityHighWaterMark`回撤基准选择**（SPEC§5.4/§13问题1）与**风险预算基准选择**（SPEC§5.1/§13问题2）：均已在SPEC文档中明确标注为需要CEO确认的开放问题，本文档不重复展开，只提醒这两项一旦CEO给出不同选择，只需替换SPEC中对应的一个变量引用（`equityHighWaterMark`→`initialCapital`，或`account_equity`→`account.initialCapital`），不影响文档其余部分的设计完整性，改动成本低。
5. **`calcBreakevenStop`的实现复杂度**（SPEC§6.10）：是本轮设计中数学上最复杂的一个纯函数（需要联立已实现盈亏、剩余仓位止损价三者的等式求解），`V1_3_CODEX_IMPLEMENTATION_TASK.md`已要求将其拆成独立可单测的纯函数，但仍建议实现阶段优先为这个函数编写测试（已在`V1_3_ACCEPTANCE_TESTS.md` T5.1中列出），因为它是"移动止损保护规则"能否真正达到"保本"效果的唯一保障点，如果实现有误，会在用户不知情的情况下让"移动到保本"变成"移动到一个仍然会小幅亏损的价位"。
6. **数据长时间中断后的不可恢复缺口**（SPEC§8.3第3点）：属于极端场景（长时间断网/页面挂起后恢复），SPEC已给出"保守假设已触发止损"的降级策略并标注为需要CEO确认的问题（§13问题6），风险等级低但发生时影响直接（可能让一笔实际仍然浮盈的仓位被误判为已止损），建议CEO在下一轮明确是否接受这个保守假设，或要求改为"标记为不确定状态，需要用户人工核实"而不是系统自动判定。

---

## 5. V3边界重申

WebSocket、条件提醒推送（`Notification`主动推送）、长期运行监控均**未**在本轮四份V1.3文档中出现任何实现要求，`V1_3_CODEX_IMPLEMENTATION_TASK.md`§1.2显式列为"本轮禁止实现"。"模拟仓位追踪"本身已从原V3范围正式拆出并入V1.3（见`V1_3_PAPER_TRADING_SPEC.md`§0.1），这是本轮唯一的范围调整，不代表WebSocket/提醒/监控三项也一并提前。

---

## 6. 需要CEO确认的问题（汇总自`V1_3_PAPER_TRADING_SPEC.md`§13，供本轮对话结尾统一呈现）

1. 总回撤10%锁定基准：净值历史最高点（默认）vs 固定初始本金500 USDT？
2. 单笔/试仓风险预算基准：当前账户净值（默认）vs 固定初始本金？
3. 加仓次数上限：是否限定V1.3最多1次加仓（默认）？
4. 加仓前是否强制要求止损已移动到保本价（默认要求）？
5. 部分止盈默认比例50%/30%/20%与移动止损档位是否符合预期？
6. 数据长时间中断且历史K线不足以完整回补时，是否认可"保守假设已触发止损"的默认降级处理？
7.（本文档§4第2点新增）是否需要在下一轮追加一次历史文档措辞对齐（`CODEX_IMPLEMENTATION_TASK.md`/`STRATEGY_SPEC.md`/`V1_2_CODEX_IMPLEMENTATION_TASK.md`中"模拟仓位=V3范围"的过时措辞）？

---

## 7. 变更记录

- v1.3-draft-1（本版本）：首次交付，基于`main`分支`v1.2.0`标签独立设计。
