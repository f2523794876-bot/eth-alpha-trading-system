# V1_3_ARCHITECTURE_REVIEW.md — V1.3「模拟交易账户」架构复核与一致性核查

版本：v1.3-draft-4（§1-§8为draft-2内容，其中"逐笔点击确认"相关条款已被draft-4原地改写，见§10；§9为draft-3内容不变；§10为draft-4新增，对应CEO本轮「真实行情自动模拟交易引擎」需求，正式撤销draft-2/draft-3"用户必须逐笔点击确认才建立模拟仓位"的授权模型，见`V1_3_PAPER_TRADING_SPEC.md`§16）
角色：本文档是四份V1.3文档中的最后一份，职责是**核对前三份文档（`V1_3_PAPER_TRADING_SPEC.md`/`V1_3_CODEX_IMPLEMENTATION_TASK.md`/`V1_3_ACCEPTANCE_TESTS.md`）互相一致**，核对与V1.1/V1.2/`STRATEGY_SPEC.md`既有代码接口的一致性，给出风险清单，并作为交给CEO复审的入口文档。

---

## 0. 基准确认

| 项 | 值 |
|---|---|
| 基准分支 | `main` |
| 基准标签 | `v1.2.0`（提交 `0dc1943e744f0e997f48c7e2470f71fd80a64c64`） |
| 工作分支 | `claude/v1.3-paper-trading-spec` |
| draft-2基准提交 | `36c45d27efde8efc2fd3004b3889bd9eeda90eb5`（draft-3在此提交之上做增量修订） |
| 本轮（draft-2）性质 | draft-1的7项开放问题（`V1_3_PAPER_TRADING_SPEC.md`draft-1 §13）+ 3项统一规则，已由CEO逐条决策，为增量修订，不改变draft-1已确认无争议的部分（撮合方向表、K线扫描顺序、同K线冲突/跳空红线、构建脚本接线方式等） |
| 本轮（draft-3）性质 | CEO新需求「建议档案与影子验证」（`V1_3_PAPER_TRADING_SPEC.md`§15），与draft-2「模拟账户」（§2-§8）严格资金隔离的**新增并行子系统**，不改变draft-2已确认的任何账户/风险/撮合规则本身（§1-§8零改动） |
| draft-3基准提交 | `484f95a8a2676d55c4c2d4a44deea1fe2e6b38ea`（draft-4在此提交之上做增量修订） |
| 本轮（draft-4）性质 | CEO**正式撤销**draft-2/draft-3"模拟账户需要用户逐笔点击确认才生效"的授权模型，新增「真实行情自动模拟交易引擎」（`V1_3_PAPER_TRADING_SPEC.md`§16）。§2-§8的账户会计恒等式/手续费滑点公式/风险预算/加仓条件数值/日亏损/回撤/杠杆边界/K线扫描撮合红线**全部零改动**，仅授权触发方式改变；§15「建议档案与影子验证」的创建条件/生命周期状态机/影子撮合规则/统计口径**零改动**，仅`userActionStatus`枚举与建仓关联机制随§16更新（见SPEC §15.9） |

---

## 1. CEO七项决策+三项统一规则的逐条落地核对表

| # | CEO决策要点 | SPEC落地章节 | CODEX_TASK是否同步 | ACCEPTANCE_TESTS是否覆盖 | 状态 |
|---|---|---|---|---|---|
| 1 | 总回撤基准=`peakEquity`（历史最高净值），公式`(peakEquity-currentEquity)/peakEquity`，只在重置时重置 | §5.4、§2.4 | 步骤2/6 | T9、T1.8、T9.5、T16.2 | 已关闭 |
| 2 | 单笔1%/试仓0.5%风险预算恒以当前净值为基准，禁止用名义本金/杠杆后资金/固定500 | §5.1（红线） | 步骤2 | T26 | 已关闭 |
| 3 | 每笔交易最多加仓1次 | §5.2条件5 | 步骤3 | T7.5 | 已关闭 |
| 4 | 加仓七项前置条件（浮盈/V1.1许可/专业条件/成本保本位/统一止损1%/二次确认/禁止摊平） | §5.2、§6.10（`calcBreakevenStop`闭式解） | 步骤2、3 | T6、T7.6、T7.7 | 已关闭 |
| 5 | 50/30/20分批止盈，处理精度尾差，最后一次清空全部剩余 | §6.10 | 步骤3 | T5 | 已关闭 |
| 6 | 新增`UNRESOLVED_DATA_GAP`状态+回放+保守结算+`estimated`/`verified` | §3.4、§8 | 步骤4 | T21.3、T22、T23、T24、T25 | 已关闭 |
| 7 | 修正历史文档"模拟仓位=V3"过时措辞 | §0.1 | — | — | 已关闭（见§5本文档独立核查表） |
| 8 | 当日亏损用UTC自然日，UI同时显示UTC与本地时间，缺快照时确定性回退 | §5.3 | 步骤2 | T8 | 已关闭 |
| 9 | 账户会计字段区分：`equity`/`cash`/`availableBalance`/`marginUsed`/`realizedPnlGross`/`unrealizedPnl`/`feesTotal`/`slippageCostReport`，`availableBalance=equity-marginUsed` | §2.2 | 步骤2 | T1.3、T1.4 | 已关闭 |
| 10 | 统一`idempotencyKey`机制，覆盖开仓/加仓/减仓/平仓/重置 | §6.11 | 步骤5 | T11、T6.7、T16.4 | 已关闭 |

**结论**：draft-1遗留的全部7项开放问题与本轮新增的3项统一规则，经核对**已在SPEC/CODEX_TASK/ACCEPTANCE_TESTS三份文档中逐条一致落地**，`V1_3_PAPER_TRADING_SPEC.md`§13（"需要CEO确认的问题"）本轮归零。

---

## 2. 关键设计一致性说明（本轮修订中值得记录的架构判断）

1. **加仓风险口径从"分段求和"改为"统一止损"，反而更贴合既有schema**：draft-1曾照搬`STRATEGY_SPEC.md §8.2`原文"试仓风险+加仓风险分别求和"的表述，但`PaperTrade`接口本身只有**一个**`currentStop`字段（不是每个tranche各自的止损），分段求和口径在实现层面缺少对应的数据结构支撑。CEO决策第4项给出的"加仓后用统一止损计算最坏损失，与当前净值1%比较"口径与`PaperTrade`的单一`currentStop`字段完全对应，本次复核确认这是一次**澄清而非冲突**：新口径更容易正确实现，且不违背`STRATEGY_SPEC.md §8.2`"总风险不能超过预设风险预算"的原始意图，只是用更适合V1.3实际数据结构的方式落地。
2. **`calcBreakevenStop`闭式解已给出完整推导**（SPEC§6.10），包含开仓手续费、预计平仓手续费、实际滑点三项成本，且在零成本假设下正确退化为`S=E`（验证过数学一致性）。这是本轮修订中复杂度最高的公式，`V1_3_ACCEPTANCE_TESTS.md` T5.1要求测试代入具体数值核对，是本文档认为的**最高实现风险点**（详见§4风险清单第1条）。
3. **`availableBalance`公式的修正是CEO主动指出的架构调整**（`equity-marginUsed`取代draft-1的`cash-marginUsed`），本质是把V1.3的保证金记账模型从"仅现金视角"调整为更贴近真实交易所"全仓保证金"语义的"净值视角"（浮动盈亏同步影响可用余额）——本次复核确认这个改动**只影响`availableBalance`一个字段的计算方式**，不影响`cash`/`equity`/`marginUsed`任何一个字段自身的定义或恒等式，改动范围可控。
4. **`dailyStartEquity`重建公式统一覆盖"正常跨日"与"应用重载/首次启动"两种场景**，避免了draft-1原先"跨日用一个规则、启动缺快照另想办法"的潜在口径分裂风险——本次复核确认单一公式（`equity_当前 - 今日已实现盈亏 + 今日手续费`）在正常跨日场景下会自然退化为等价于"直接用当前净值"，因此不需要为两种场景写两套逻辑，降低了实现出现口径不一致的风险。
5. **`idempotencyKey`机制从"一次性方案消费"升级为"真正的幂等重放"**：draft-1的设计更接近"防止重复提交"（第二次调用报错），CEO决策第10项要求的是"同一个key重复调用返回同一个结果"（真正的幂等语义）。本次复核确认这一升级对`resetPaperAccount`尤其重要——因为"重复点击重置按钮"如果按draft-1的"报错"语义处理，用户会看到一个奇怪的错误提示（"重置失败"），而按新语义处理则会正确地"什么都不做，因为已经重置过了"，用户体验更合理。

---

## 3. 与既有代码接口的核对表（无变化部分从draft-1原样保留，仅新增本轮涉及的部分）

| V1.3读取/复用的字段或函数 | 来源 | 本轮新增用途 |
|---|---|---|
| `C.calcRiskBudget` | `v1-core.js` | 调用时实参`capital`位置传入`equity`（当前净值），命名上容易被后来实现者混淆为字面"资本金"，`V1_3_CODEX_IMPLEMENTATION_TASK.md`步骤2已特别提醒 |
| `decision.signalPermission.addOnAllowed` | `v1-core.js`，经`computeSignalPermission` | 加仓条件2/3之一，未变 |
| `assessDataQuality`的`isStale`阈值 | `v1-core.js` | 数据缺口检测的判定基础之一（结合`fetchAllTimeframeKlines`固定窗口大小判断能否完整回补），未变 |

其余核对表项与draft-1一致，未重复列出，详见提交历史中draft-1版本的本节内容。

---

## 4. 风险清单（本轮新增/更新）

1. **`calcBreakevenStop`闭式解是本轮复杂度最高的实现点**：公式涉及"已实现盈亏-手续费"反推目标止损价，再考虑该止损价触发时自身也会产生新的滑点和手续费（自指性，公式推导已经处理，见SPEC§6.10），但实现时容易出现"忘记对`stopFillPrice`本身也要扣手续费"这类以为已经代入过就够了的错误。`V1_3_ACCEPTANCE_TESTS.md` T5.1要求逐项代入具体数值核对，建议实现阶段**优先**为这个函数编写测试（在实现主流程之前），因为它是加仓前置条件4的判定基础，如果算错会让"以为已经保本"的仓位其实仍在承担隐藏风险。
2. **`UNRESOLVED_DATA_GAP`的"完整覆盖"判定依赖K线`openTime`序列连续性检查**：需要实现方对`fetchAllTimeframeKlines`固定窗口大小（当前约120根）有准确认知——如果断线时长导致所需回补的K线数量超过该窗口能覆盖的范围，必须正确判定为"不完整"而进入`UNRESOLVED_DATA_GAP`，不能因为"拿到了一些新数据看起来能凑合用"就误判为完整覆盖。这是draft-1风险清单已经点出、本轮通过引入显式状态和`coverageComplete`布尔字段进一步强化了可测试性的问题，风险等级从"中"降为"低"，但仍需实现阶段仔细处理边界（缺口长度恰好等于/略超过窗口大小的临界情况）。
3. **`dailyStartEquity`重建公式依赖准确统计"今天（UTC）已经发生的全部`PaperFill`"**：需要遍历全部`PaperTrade.fills`按`fill.time`筛选UTC当天范围，实现时需注意`fill.time`是本地时间戳（`Date.now()`的毫秒数，与时区无关，本身不需要转换），只是"属于哪个UTC自然日"的判定需要用`new Date(fill.time).toISOString().slice(0,10)`这类UTC口径转换，不能用`toLocaleDateString`等本地时区口径，否则会与`dailyAnchorDateUTC`的UTC口径不一致产生边界错位（例如本地时区为UTC+8时，本地午夜与UTC午夜相差8小时，用错口径会导致同一笔交易被错误归入前一天或后一天）。
4. **幂等键有界环形缓冲的容量选择（建议500条）是本文档给出的默认建议，不是CEO明确决策的数字**：如果实际使用中用户操作频率远超预期（不太可能，因为都是需要人工点击确认的操作），环形缓冲可能在极端场景下过早淘汰掉一个仍可能被重放的旧key，导致该key的"重放"退化为"重新执行"（对开仓/加仓等操作而言，重新执行等价于绕开了幂等保护）。风险等级低（人工点击频率不可能高到触发500条环形缓冲耗尽），但实现阶段可以考虑改为"只保留最近N分钟内的key"而不是"固定条数"，两种策略本文档不强制指定，留给实现阶段权衡。

---

## 5. 历史文档"模拟仓位=V3"过时措辞修订核查（CEO决策第7项）

本轮已对以下8份历史文档的相关措辞做了**追加说明式**修订（只在原文后追加"v1.3范围调整说明"括注，不删除、不改写原有历史记录本身，不改变V1.1/V1.2任何已验收的规范或代码）：

| 文档 | 修订位置 | 修订方式 |
|---|---|---|
| `PROJECT_AUDIT.md` | 第9/11节各一处 | 追加说明模拟仓位已拆出至V1.3 |
| `V1_2_ARCHITECTURE_REVIEW.md` | 第4节V3边界一处 | 同上 |
| `V1_IMPLEMENTATION_REPORT.md` | 范围合规一处 | 同上 |
| `ACCEPTANCE_TESTS.md` | 验收清单一处 | 同上 |
| `CODEX_IMPLEMENTATION_TASK.md` | §1.4标题与正文、代码注释、§6禁止事项、验收清单，共7处 | 同上，其中§1.4标题额外调整为"V3：WebSocket、条件提醒与长期运行监控"（移除"模拟仓位"字样）并追加完整说明段落 |
| `STRATEGY_SPEC.md` | 第20节前V2/V3范围代码块一处 | 同上，代码块标题同步调整 |
| `V1_2_CODEX_IMPLEMENTATION_TASK.md` | §1.2禁止清单、§6禁止事项，共2处 | 同上 |
| `V1_CHECKLIST.md` | 约束条一处 | 同上 |

**核查结论**：全部修订均为"追加括注说明"，未删除任何历史陈述、未改变这些文档所描述的V1/V1.2阶段范围本身（V1/V1.2在当时确实没有实现模拟仓位，这一历史事实保持不变），只是澄清"模拟仓位从今往后不再属于V3范围"这一面向未来的分类调整。WebSocket、条件提醒推送、长期运行监控三项在全部8份文档中均**保持**归属V3不变。

---

## 6. V3边界重申

WebSocket、条件提醒推送、长期运行监控**仍然**不在V1.3范围内。"模拟仓位追踪"已正式确立为V1.3范围（本文档§0.1/§5）。

---

## 7. 仍需CEO决定的问题

无。draft-1列出的7项开放问题已全部由CEO在本轮决策关闭（见§1对照表）。本轮新增的3项统一规则同样已全部落地，未产生新的待决策开放问题。若实现阶段（Codex编码）过程中发现本文档未能预见的边界情况，将在`V1_3_IMPLEMENTATION_REPORT.md`中记录并视需要提请CEO补充决策，不属于本轮文档范围。

---

## 8. 变更记录

- v1.3-draft-1：首次交付。
- v1.3-draft-2：CEO七项决策+三项统一规则全部核对落地，draft-1开放问题清单归零，新增本轮设计一致性说明（§2）与历史文档修订核查（§5）。
- v1.3-draft-3（本版本）：新增CEO需求「建议档案与影子验证」核对（§9），含默认有效期决定的详细理由（§9.2，CEO要求本决定必须记录在本文档）。§1-§8「模拟账户」核对结论本轮零改动。

---

## 9. 本轮（draft-3）CEO新需求「建议档案与影子验证」核对（对应`V1_3_PAPER_TRADING_SPEC.md`§15）

### 9.1 CEO本轮十四项要求逐条落地核对表

| # | CEO要求要点 | SPEC落地章节 | CODEX_TASK是否同步 | ACCEPTANCE_TESTS是否覆盖 | 状态 |
|---|---|---|---|---|---|
| 一 | 严格区分建议档案/影子验证/模拟账户三套系统，禁止影子盈亏写入模拟账户 | §15.0（红线） | §7.1 | T38 | 已关闭 |
| 二 | 建议档案创建的八条件（AND） | §15.3 | 步骤10 | T28、T29 | 已关闭 |
| 三 | 建议快照不可变，字段清单 | §15.2 | 步骤10 | T31 | 已关闭 |
| 四 | `signalFingerprint`去重与版本规则 | §15.4 | 步骤10 | T30 | 已关闭 |
| 五 | 建议生命周期状态机（12个状态） | §15.5 | 步骤11 | T32 | 已关闭 |
| 六 | 真实行情影子验证（禁止未来数据泄漏、保守撮合、MFE/MAE/毛R净R） | §15.6 | 步骤12 | T33、T35、T36 | 已关闭 |
| 七 | 准确度统计口径（不止一个"准确率"，分组维度） | §15.8 | 步骤14 | T40 | 已关闭 |
| 八 | 用户行为关联（`userActionStatus`/`linkedPaperTradeId`） | §15.9 | 步骤15 | T39 | 已关闭 |
| 九 | 数据缺口规则（复用UNRESOLVED_DATA_GAP精神，不冒充真实结算） | §15.7 | 步骤13 | T37 | 已关闭 |
| 十 | 存储与审计（独立命名空间、迁移、导出、清空不触碰模拟账户） | §15.10 | 步骤16 | T41、T42 | 已关闭 |
| 十一 | UI新增区域"历史交易建议与影子验证" | §15.12 | 步骤16 | — | 已关闭 |
| 十二 | 默认有效期（先检查V1.1是否已有定义） | §15.11 | — | T34 | 已关闭，详细理由见本节§9.2 |
| 十三 | 测试要求（至少26项） | — | — | T28-T43全覆盖，见§9.4逐条映射 | 已关闭 |
| 十四 | 修改范围（只改4份文档，禁止事项） | 全文档 | §7.1 | — | 已关闭，见§9.5 |

**结论**：CEO本轮"一至十四"全部要求，经核对**已在SPEC §15/CODEX_TASK §7/ACCEPTANCE_TESTS T28-T43三份文档中逐条一致落地**，`V1_3_PAPER_TRADING_SPEC.md`§15.15（"仍需CEO确认的问题"）本轮同样归零。

### 9.2 默认有效期决定与详细理由（对应CEO"十二、默认有效期"，本节是CEO要求"必须在ARCHITECTURE_REVIEW中说明选择理由"的落地）

**检查过程**：逐一核对`v1-core.js`全部导出函数与`buildDecision()`返回对象的完整字段列表（`price`/`btcPrice`/`confirmedPrice`/`state`/`previousState`/`stateReason`/`falseBreakoutTier`/`biasDirection`/`advice`/`entryZone`/`addOnCondition`/`stopLoss`/`targets`/`exitConditions`/`riskReward`/`dragonflyText`/`bestInterceptionZone`/`worthBetting`/`btcAlignment`/`warnings`/`signalPermission`/`htf4h`/`mtf1h`/`ltf15m`/`htfState`/`mtfState`/`supportZones`/`resistanceZones`/`volumeQuality`/`score`/`opportunityScores`/`triggerPlans`/`positionMetrics`/`dataHealth`/`decisionLogId`/`isManual`/`manualInputs`/`missingData`/`updatedAt`/`chartModel`），**未发现**任何`validUntil`/`expiry`/`expires`/`TTL`字段或等价机制——`grep -n "validUntil\|expiry\|expires\|TTL" v1-core.js`返回零结果。V1.1的"新鲜度"完全依赖"每30秒重新拉取K线、重新整体计算`buildDecision()`"这一轮询节奏，结构性字段（`state`/S/R/`stopLoss`/`targets`）只在新15分钟K线收盘时才真正变化，两次收盘之间的重复计算得到相同结果，但**没有**一个显式声明"这份计划还有效多久"的字段。

**唯一先例**：V1.2 `buildForecast()`的每个时间窗预测对象（`m15`/`h1`/`h4`）都有明确的`dataAsOf`/`validUntil`字段对，公式为`validUntil = dataAsOf + TF_MS[horizon]`——即"有效期恰好等于该预测所属的时间窗自身周期"。这是代码库里唯一一处对"一份判断还有效多久"给出确定性数值公式的先例。

**决定**：`SIGNAL_DEFAULT_VALIDITY_MS = TF_MS['4h'] = 14400000`（4小时/16根15分钟K线），`SignalSnapshot.validUntil = dataAsOf + SIGNAL_DEFAULT_VALIDITY_MS`。

**选择理由（四点）**：

1. **有先例可循，不是凭空发明**：V1.2已经确立"有效期=该判断所依赖的最长相关时间窗自身周期"这一惯例（`h4`预测的有效期就是4小时）。V1.3建议档案的结构性依据同时来自15分钟/1小时/4小时三个时间窗（`decision.ltf15m`/`mtf1h`/`htf4h`），其中4小时（`htf4h`）是决定整体趋势方向、给`biasDirection`定调的最高层级时间窗（`htfState`/`classifyHtfState()`）。选择与V1.2最长时间窗一致的4小时，是把V1.3的"有效期"概念锚定在系统里已经存在、已经被验证过的语义上，而不是新造一个孤立的数字。
2. **确定、可测试**：`SIGNAL_DEFAULT_VALIDITY_MS`是硬编码常量，`validUntil`在创建时一次性计算并冻结，`V1_3_ACCEPTANCE_TESTS.md` T34.5用独立硬编码基准值断言，不依赖运行时对象自证式反算。
3. **不会无限等待进场**：16根15分钟K线（约4小时）足够让"回踩确认"这类交易设置有合理的实现窗口（15分钟结构的回踩通常在几根到十几根K线内完成或失败），同时又不会长到让一个早已过时的结构性判断继续挂在"等待触发"状态数天之久，与CEO"不允许建议永久等待进场"的要求直接对应。
4. **实现成本低、与既有状态机自然衔接**：`TF_MS`常量在`v1-core.js`/`v1_2-forecast-core.js`中已经重复定义（`{"15m":900000,"1h":3600000,"4h":14400000}`），`v1_3-signal-archive-core.js`只读复用该常量表达式即可，不需要引入新的时间单位换算逻辑。

**未采用的备选方案及排除理由**：曾考虑以15分钟（1根K线，`TF_MS['15m']`）为默认有效期——排除理由：过短，绝大多数回踩型进场区在1根K线内几乎不可能触发，会导致触发率被人为压低，产生"系统建议大量过期"的误导性统计，与CEO"客观检查系统准确度"的初衷相悖。也曾考虑以1小时（`TF_MS['1h']`）为默认——排除理由：1小时是三个时间窗里的中间层级，缺乏像"h4=趋势定调窗口"或"m15=触发确认窗口"那样清晰的语义支撑，选择它更接近任意拍板而非有先例的推导。

### 9.3 关键设计判断记录（本轮新增，供CEO复核的架构判断）

1. **"失效位"与"止损位"的数值收敛**：CEO要求判断"触发进场后先到止损、失效位还是目标位"，但V1.1的`exitConditions`/`triggerPlans.invalidation`是文案数组，没有定义独立于`stopLoss`的第二个数值失效价位。本文档确认这是一次**忠实于现有数据结构的收敛处理**而非遗漏：`SignalSnapshot.invalidation`字段继续保留文案证据（审计用途），但状态机判定只在`stopLoss`与`targets`之间比较先后（SPEC §15.5"设计说明"已注明）。
2. **不模拟移动止损**：`TARGET_1_HIT`/`TARGET_2_HIT`之后的止损判定统一使用`SignalSnapshot.stopLoss`原始冻结值，不引入draft-2 §6.10式的"移动止损到保本位"假设。理由：移动止损是Paper Trading账户里的主动仓位管理动作，若在Signal Archive里模拟，等同于为V1.1从未做出过的具体交易管理动作背书，与CEO"不得后见之明"的精神冲突。
3. **`PAPER_ALGORITHM_VERSION`保持不变**：本轮文档整体版本号升级到`v1.3-draft-3`，但`PAPER_ALGORITHM_VERSION`（描述§2-§8模拟账户算法）保持`'v1.3-draft-2'`不变，因为该部分规则字面零改动；新增`SIGNAL_ARCHIVE_ALGORITHM_VERSION='v1.3-draft-3'`独立维护建议档案子系统自己的版本号（SPEC §15.14）。
4. **Signal Archive与Paper Trading单向依赖**：`v1_3-signal-archive-core.js`（下轮实现）**不得**依赖`v1_3-paper-trading-core.js`内部实现，仅通过`signalId`/`tradeId`指针与`autoOpenPosition`新增的可选`signalId`参数关联；`v1_3-signal-archive-core.js`可以独立于Paper Trading Account是否已经实现而先行开发与测试（CODEX_TASK §7.1/§7.3已注明）。
5. **BTC结构快照的只读边界**：`SignalSnapshot.btcStructureSnapshot`通过只读调用`v1-core.js`已导出的`analyzeKlines()`对BTC原始K线（`window.__lastMarketData.btc`）生成，**不**重新做多空方向判断——`biasDirection`/`btcAlignment`等方向性结论仍完全来自V1.1原始决策对象，只是把V1.1内部已经用来计算这些结论的BTC结构原始数据也存档，供未来审计追溯"当时BTC结构具体是什么样"，不违反draft-2 §7.1"V1.3只读消费V1.1，不重新计算"的红线。

### 9.4 CEO"十三、测试要求"逐条映射（对应`V1_3_ACCEPTANCE_TESTS.md` T28-T43）

| CEO测试要求原文 | 对应测试类别 |
|---|---|
| 可执行建议自动创建快照 | T28 |
| blocked建议不进入正式档案 / 手动观察模式不进入正式档案 | T29 |
| 同一K线同一计划去重 / 新收盘K线但计划无实质变化不重复 / 计划变化创建新版本 | T30 |
| 快照不能被刷新覆盖 | T31 |
| 只使用dataAsOf之后K线 | T33.1 |
| 未触发过期不算亏损 | T34 |
| 进场与止损同K线按止损 / 止损与目标同K线按止损 / 跳空止损 | T33 |
| 目标1/2/3 | T35 |
| MFE/MAE / 毛R与净R | T36 |
| 数据缺口回补 / 无法回补排除统计 | T37、T40.3 |
| 影子结果不改变500 USDT账户 | T38 |
| 用户点击模拟开仓正确关联signalId | T39.2 |
| 用户错过建议统计 | T39.3、T40.9-T40.10 |
| 多空与市场状态分组统计 | T40.5-T40.8 |
| JSON/CSV导出安全 | T41.4-T41.6 |
| 删除建议历史二次确认 / 删除建议历史不重置模拟账户 | T42 |
| 旧V1.1/V1.2测试保持通过 | T43（追加于draft-2 T27） |

全部CEO列出的测试要求均已映射到具体测试类别，无遗漏项。

### 9.5 修改范围核查（对应CEO"十四、修改范围"）

本轮实际修改的文件**仅**限于CEO明确列出的四份文档（`V1_3_PAPER_TRADING_SPEC.md`/`V1_3_CODEX_IMPLEMENTATION_TASK.md`/`V1_3_ACCEPTANCE_TESTS.md`/`V1_3_ARCHITECTURE_REVIEW.md`），未新增、未修改任何HTML/JS/构建脚本/既有测试文件，未创建任何正式实现文件（`v1_3-signal-archive-core.js`等均只在CODEX_TASK §7.2作为"下一轮实现规划"列出，本轮未创建）。未自动建立任何`PaperPosition`（本轮为文档设计，无运行时行为；SPEC §15.0/§15.6在设计层面也明确禁止）。未把影子验证写入模拟账户（SPEC §15.0红线，本节§9.1第一项已核对）。

### 9.6 风险清单（本轮新增）

1. **影子撮合的"同一根K线内进场后止损"分支是本轮实现复杂度最高的点**：与draft-2 `calcBreakevenStop`类似，容易在"先算entryFillPrice还是先算stopFillPrice"的顺序上出错。建议实现阶段优先为SPEC §15.6.A的"entryHit且同根K线也触及stopLoss"分支单独编写测试（`V1_3_ACCEPTANCE_TESTS.md` T33.4），在实现主流程之前跑通。
2. **准确度统计的分组维度较多（方向×市场状态×预测背景×BTC态度×用户行为，共5个独立分组维度），实现时容易出现"某个分组遗漏了应该归入'无数据'桶的边界记录"（例如`forecastSnapshot===null`）而被静默丢弃，导致分组总和与总体统计对不上**。建议`computeSignalAccuracyStats`内部为每个分组维度都做一次"总和校验"（各分组计数之和必须等于分组前的总数），作为该函数自身的内部断言，而不只依赖外部测试。
3. **`ethAlphaSignalArchive`/`ethAlphaSignalEvents`容量上限（2000条，本文档建议值，非CEO明确决策的数字）与draft-2幂等键环形缓冲（500条）同属"本文档给出的默认建议"性质，实现阶段可以根据实际数据量调整，但调整时需注意`ethAlphaShadowResults`的孤儿记录清理逻辑要与容量裁剪逻辑保持同步（容量裁剪淘汰某条`SignalSnapshot`后，其对应`ShadowResult`也应一并清理，否则会积累无主记录）。
4. **`SignalSnapshot`与`decisionSnapshot`存在字段重叠但不完全重复的风险**：SPEC §15.2已明确"ATR/EMA/Swing/成交量/动态支撑压力均已包含在`decisionSnapshot.ltf15m/mtf1h/htf4h`内，不重复抽取"，实现阶段需注意不要因为"顶层字段读起来更方便"而擅自在`SignalSnapshot`顶层又抽取一份冗余副本——这会引入两份数据不同步的风险（`decisionSnapshot`是`deepClone`的完整对象，若顶层再单独抽取字段，未来`v1-core.js`若合法修订了`analyzeKlines()`内部字段名，两处会不同步失效）。

### 9.7 仍需CEO决定的问题

无。CEO本轮"十二、默认有效期"要求的自行决策已在§9.2给出并说明理由，CEO本轮其余十三项要求均已在§9.1核对表中确认落地。若实现阶段（Codex编码）发现本文档未能预见的边界情况，将在`V1_3_IMPLEMENTATION_REPORT.md`中记录并视需要提请CEO补充决策，不属于本轮文档范围。

---

## 10. 本轮（draft-4）CEO正式撤销「逐笔点击确认」并新增「真实行情自动模拟交易引擎」核对（对应`V1_3_PAPER_TRADING_SPEC.md`§16-§17）

### 10.0 撤销确认（红线，最高优先级核对项）

**核对结论**：draft-2/draft-3中"模拟账户需要用户逐笔点击确认才生效"这一错误定义，已在`V1_3_PAPER_TRADING_SPEC.md`中被**正式撤销**（§16.0撤销声明），且CEO明确列出的四条待删除/改写表述已逐条原地改写并可在SPEC §17.1核对表中逐条验证（不是仅在本文档追加旁注，而是四份文档原文本身已改写）。V1.3的产品定义现在准确反映为："系统使用真实Binance ETH/BTC行情，根据V1.1正式交易规则自动进行虚拟开仓/加仓/减仓/止损/50-30-20分批止盈/移动保护/平仓，使用默认500 USDT虚拟账户，用户只需一次性开启自动模拟交易总开关并二次确认"。

### 10.1 CEO本轮十一项要求逐条落地核对表

| # | CEO要求要点 | SPEC落地章节 | CODEX_TASK是否同步 | ACCEPTANCE_TESTS是否覆盖 | 状态 |
|---|---|---|---|---|---|
| 一 | 最终产品定义：真实行情自动虚拟开仓/加仓/减仓/止损/分批止盈/移动保护/平仓，默认500 USDT，禁止连接真实账户/读密钥/发真实单/用真实资金 | §16.0（红线） | §8.1 | T44.1、T52.2 | 已关闭 |
| 二 | 授权方式修正：一次性总开关+二次确认，六状态`EngineState`，六项用户宏观控制 | §16.1 | §8.3步骤18 | T44 | 已关闭 |
| 三 | 自动建仓十四项条件 | §16.2 | §8.3步骤19 | T45 | 已关闭 |
| 四 | 自动模拟仓位规则（500 USDT/单标的/单主交易/杠杆1-3x/风险预算/加仓上限/50-30-20） | §16.3（指针复用§2/§4/§5/§6，数值零改动） | §8.3步骤19-20 | T46、T47 | 已关闭 |
| 五 | 反向信号：不同刷新反手、先按离场规则处理、平仓后等待下一根K线、重新校验 | §16.4 | §8.3步骤21 | T48 | 已关闭 |
| 六 | 真实市场模拟成交术语（markPrice/triggerPrice/simulatedFillPrice/confirmedBar/liveMarketData）+ 全部成交要素计算+不可变成交记录 | §16.5（术语映射到既有字段，无新公式） | §8.3步骤22 | 复用T2-T4/T46既有公式测试 | 已关闭 |
| 七 | 与建议档案/影子验证的关系：三套系统继续隔离，signalId/paperTradeId关联，五个新userActionStatus，影子结果不进账户，账户结果不回写SignalSnapshot | §15.9（更新）/§16.6 | §8.1、§7.3步骤15（同步更新） | T52 | 已关闭 |
| 八 | 浏览器运行限制：心跳、lastProcessedBarTime、恢复回补重放、同K线/跳空既有红线、无法回补进UNRESOLVED_DATA_GAP、不伪造成交顺序、UI显示心跳/离线/回放状态 | §16.7 | §8.3步骤22 | T50 | 已关闭 |
| 九 | 幂等和重复保护：全部自动/人工操作使用稳定idempotencyKey，六类场景不重复成交，同一signalId最多一次主交易 | §16.8 | §8.3步骤23 | T51 | 已关闭 |
| 十 | UI新增区域"500 USDT真实行情自动模拟交易"，含全部列出字段+新常驻文案 | §16.9 | §8.3步骤24 | T54 | 已关闭 |
| 十一 | 删除全部冲突旧定义 | §16.12/§17完整扫描记录 | §1.2/§1.3/§3步骤3-4已原地改写 | T55（废弃函数不存在性校验） | 已关闭 |

**结论**：CEO本轮"一至十一"全部要求，经核对**已在SPEC §16-§17/CODEX_TASK §1.2/§1.3/§3/§8/ACCEPTANCE_TESTS T44-T57三份文档中逐条一致落地**，`V1_3_PAPER_TRADING_SPEC.md`§16.13（"仍需CEO确认的问题"）本轮同样归零。

### 10.2 引擎状态机一致性核对

`AutoEngineState`六态（`AUTO_PAPER_OFF`/`AUTO_PAPER_ARMED`/`AUTO_PAPER_RUNNING`/`AUTO_PAPER_PAUSED`/`AUTO_PAPER_RISK_LOCKED`/`AUTO_PAPER_DATA_BLOCKED`）在SPEC §16.1、CODEX_TASK §8.3步骤18、ACCEPTANCE_TESTS T44四份出现位置完全一致（逐词核对枚举拼写，无大小写/下划线差异）。`allowNewEntries`独立开关（非状态机第七态）在三份文档中表述一致，T44.10专项验证其与`AUTO_PAPER_PAUSED`的行为差异。`PositionStatus`撤销`PENDING_ENTRY`/`CANCELLED`/`BLOCKED`三态在SPEC §3.4/§17.3、ACCEPTANCE_TESTS T55.3中一致记录。

**设计判断复核**：SPEC §16.1"`AUTO_PAPER_PAUSED`/`AUTO_PAPER_RISK_LOCKED`/`AUTO_PAPER_DATA_BLOCKED`均保留对已有仓位的自动止损/止盈保护"这一判断，与draft-2 T8.2/T9.4"`DAILY_LOSS_LOCKED`/`FORCED_OBSERVATION`状态下减仓/平仓/止损止盈自动触发仍正常工作"的既有先例方向一致，本次复核确认这是**延续既有精神而非新发明的例外**，风险可控。

### 10.3 三套系统边界重新核对（与§9.1第一项/SPEC §15.0/§16.0交叉验证）

Signal Archive（自动存档）与Shadow Evaluation（只读影子验证）的创建条件、去重规则、生命周期状态机（`RECORDED`到`CANCELLED_BY_RULE_CHANGE`共12态）、影子撮合规则、统计口径**在draft-4本轮零改动**——唯一变化的是Auto Paper Account一侧：从"用户点击才建仓"变为"引擎监听Signal Archive自身的`WAITING_TRIGGER→TRIGGERED`转换后自动建仓"（SPEC §16.2条件6架构决定）。这一变化**不需要**Shadow Evaluation修改自己的判定逻辑——Auto Engine只是"读取"Shadow Evaluation已经算出的触发结果，两者在数据流向上保持单向（Signal Archive/Shadow Evaluation → Auto Engine，反向不允许），资金隔离红线（影子结果不得进入500 USDT账户、账户结果不得回写SignalSnapshot）经核对在SPEC §15.9/§16.6中均已明确重申，ACCEPTANCE_TESTS T38（draft-3）与T52（draft-4新增）共同覆盖该红线的两个方向。

### 10.4 全文冲突旧定义扫描结果核查（复核SPEC §17）

已复核SPEC §17完整扫描记录，确认：

- CEO明确列出的四条表述（"用户必须逐笔点击确认才建立模拟仓位"/"每次开仓必须手动接受"/"不实现无人确认的自动模拟开仓"/"PaperAccount只有用户点击才生效"）均已定位并原地改写，替换文案与CEO"十一"要求的四条替换表述逐句对应。
- 函数级改动（`confirmReduce`整体移除、`confirmConservativeSettlement`并入`emergencyClosePosition`、`autoOpenPosition`/`autoAddOn`废弃改为`autoEngineOpenPosition`/`autoEngineAddOn`、`buildTradeProposal`保留但角色改变）在SPEC §17.2、CODEX_TASK §8.1/§8.5、ACCEPTANCE_TESTS函数名对照表（文档头部）与T55五处表述完全一致，未发现遗漏或矛盾。
- **唯一已知的、经过明确取舍的残留**：`V1_3_ACCEPTANCE_TESTS.md` T1-T27的历史用例文本中仍出现`autoOpenPosition`/`autoAddOn`字样（draft-2/draft-3阶段的历史函数名），SPEC §17.5记录了这一取舍理由（保持200余条已验证断言逐字稳定，优先级高于函数名的表面一致性），并要求实现阶段Codex按文档头部"函数名对照表"换算为最终函数名。本次复核**认可**这一取舍——理由与SPEC §17.5一致，且ACCEPTANCE_TESTS文档头部的对照表本身构成了充分的、可审计的换算依据，不属于"遗漏未处理"。

### 10.5 与既有代码接口的核对表（本轮新增）

| V1.3读取/复用的字段或函数 | 来源 | 本轮新增用途 |
|---|---|---|
| `decision.confirmedPrice`所属K线的`isClosed`/`openTime`/`closeTime` | `v1-core.js` | `confirmedBar`术语的实际数据来源（SPEC §16.5），与`liveMarketData`边界判断的依据 |
| `TF_MS['15m']` | `v1-core.js`/`v1_2-forecast-core.js` | §16.7心跳过期判定阈值（`lastEngineHeartbeat`距今超过一个15分钟周期视为可能离线过），复用既有常量，未新增 |
| `fetchAllTimeframeKlines`固定窗口（约120根） | `v1-core.js` | §16.7引擎离线回补的可行性判定依据，与draft-2 §8.3/draft-3 §15.7"完整覆盖判定"共用同一常量基准 |

### 10.6 风险清单（本轮新增）

1. **`checkReverseSignalCooldown`与"同一次tick内不得连续平仓+反向开仓"两条规则的实现耦合是本轮新引入复杂度最高的点**：若`scanClosedBarsForExits`（自动止损/止盈）与`autoEngineOpenPosition`（自动开仓）在同一次`tickAutoEngine`调用内被连续调用而没有正确的"本tick已经平过仓，跳过本tick的反向开仓判定"标记，可能违反CEO"不允许同一刷新直接自动反手"的红线。建议实现阶段为`tickAutoEngine`函数本身维护一个"本次调用是否已处理平仓事件"的内部标志，作为该函数单元测试的重点（`V1_3_ACCEPTANCE_TESTS.md` T48.1）。
2. **心跳/离线判定阈值（`TF_MS['15m']`，本文档建议值）与"引擎确实离线"之间不是绝对等价关系**：用户短暂切换浏览器标签页也可能导致`lastEngineHeartbeat`短暂滞后而未必真的错过K线收盘，实现阶段需要用`lastProcessedBarTime`与实际可获取的最新`confirmedBar.openTime`比较（而非单纯用心跳时间差）来判定"是否真的错过了K线"，避免把"标签页短暂不在前台但没错过任何K线"误判为需要回放的数据缺口——SPEC §16.7已经是按这个口径设计的（"比较`lastProcessedBarTime`与当前可获取的最新confirmedBar.openTime"），本条风险提示是给实现阶段的强调，不是文档设计缺陷。
3. **`emergencyClosePosition`合并了"常规人工平仓"与"保守结算"两条路径，实现时的内部分支判断（`trade.status==='UNRESOLVED_DATA_GAP'`）如果被写反或遗漏，会导致数据缺口期间的平仓错误地使用当前`markPrice`（该状态下`markPrice`本身已冻结/不可靠）而非保守结算规则**，产生一个看似正常但实际不可靠的成交价。`V1_3_ACCEPTANCE_TESTS.md` T49.2/T49.3已分别覆盖两条分支，建议实现阶段优先编写这两条测试用例。
4. **draft-2遗留的"`v1_3-paper-trading-core.js`本轮尚未实现"这一事实，意味着本文档§16全部内容目前仍是纯粹的设计规范，尚无任何实现可供交叉验证**——与draft-2/draft-3阶段相同的固有限制，不是draft-4新增的风险，但风险敞口随文档复杂度增加而增大（draft-4新增约560行SPEC正文），建议下一轮实现启动时安排比draft-2/draft-3更宽裕的自测时间。

### 10.7 仍需CEO决定的问题

无。CEO本轮"一至十一"全部要求已在§10.1核对表中确认落地。SPEC §16.13已记录的两项设计判断（暂停状态保留仓位保护、保守结算并入紧急平仓）本次复核已在§10.2/§10.6中独立核实并认可，不构成新的待决策事项。若实现阶段（Codex编码）发现本文档未能预见的边界情况，将在`V1_3_IMPLEMENTATION_REPORT.md`中记录并视需要提请CEO补充决策，不属于本轮文档范围。
