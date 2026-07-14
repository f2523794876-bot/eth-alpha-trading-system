# V1_3_ACCEPTANCE_TESTS.md — V1.3「模拟交易账户」验收测试规范

版本：v1.3-draft-1（随 `V1_3_PAPER_TRADING_SPEC.md` v1.3-draft-1 同步）
依据：`V1_3_PAPER_TRADING_SPEC.md`（每条用例都标注对应章节）。所有测试**必须用构造好的合成K线/合成决策/合成预测对象跑**，不能只靠人工打开页面观察——沿用 `ACCEPTANCE_TESTS.md`/`V1_2_ACCEPTANCE_TESTS.md` 已确立的"合成数据优先"原则。

**fixture真实性红线**（与`V1_2_ACCEPTANCE_TESTS.md`同款，直接延伸到V1.3）：所有涉及 `decision`/`forecast`/`marketData` 字段的测试fixture，字段名和取值格式必须与 `v1-core.js buildDecision()`/`v1_2-forecast-core.js buildForecast()` 的真实返回结构逐字段一致（例如 `decision.opportunityScores.blocked`、`decision.signalPermission.addOnAllowed`、`decision.stopLoss`、`decision.targets`、`forecast.m15.directionLabel` 等）。**禁止**测试自造一套近似结构让测试通过而生产代码实际收到的数据形状不同——这是`CLAUDE_CODE_REVIEW_V1_2_FINAL.md`反复强调的"实现与测试不得共享同一错误假设"原则的直接延续。

**测试文件与运行方式**：
```
node tests/v13-paper-trading-tests.js
node tests/v13-ui-tests.js
node tests/v13-live-rest-test.js
```

---

## T1. 账户初始化与会计恒等式（对应SPEC §2）

| 用例 | 断言 |
|---|---|
| T1.1 | 首次 `loadPaperAccount(空storage)` 返回 `initialCapital===500`、`cash===500`、`marginUsed===0`、`equity===500`、`riskRegime==='NORMAL'`、`currency==='USDT'` |
| T1.2 | 任意一次操作后，`equity === cash + Σ unrealizedPnl` 恒成立（构造多组开仓/部分平仓/加仓场景各验证一次） |
| T1.3 | `availableCash === cash - marginUsed` 恒成立 |
| T1.4 | `cash === initialCapital + realizedPnlTotal - feesTotal` 恒成立，且**不**额外扣减`slippageCostTotal`（专项验证不重复扣减，见SPEC §2.2红线） |
| T1.5 | 任意成交后 `cash >= 0 && marginUsed <= cash` |
| T1.6 | 修改 `initialCapital` 时若存在OPEN持仓，返回 `{ok:false}` 并给出明确原因 |
| T1.7 | 修改 `initialCapital` 必须先返回"待二次确认"状态，只有传入二次确认标记后才真正生效（用mock confirmFn验证两阶段） |
| T1.8 | 重置账户会清空 `ethAlphaPaperTrades`/`ethAlphaPaperLog` 为空数组（不是删除key），且 `ethAlphaPaperLog` 清空后第一条记录是 `ACCOUNT_RESET` 审计记录 |
| T1.9 | 未经二次确认调用重置，账户状态不变 |

## T2. 多单开仓/止损/止盈（对应SPEC §3、§4.1-4.2、§6）

| 用例 | 断言 |
|---|---|
| T2.1 | `decision.biasDirection==='long'&&worthBetting&&!opportunityScores.blocked&&dataHealth==='normal'` 时，`buildTradeProposal` 返回有效方案；否则返回 `{ok:false}` 并给出具体拒绝原因 |
| T2.2 | `confirmOpenPosition` 成功后产生 `status:'OPEN'` 的 `PaperTrade`，`fills`长度为1且`fillType==='OPEN'`、`side==='BUY'` |
| T2.3 | 开仓成交价 = `referencePrice × (1 + spreadRate/2 + slippageRate)`（买入不利向上滑点） |
| T2.4 | 构造收盘K线 `low <= currentStop` 触发止损，产生 `fillType==='STOP_LOSS'`、`side==='SELL'` 的成交，`status`变为`EXITED` |
| T2.5 | 构造收盘K线 `high >= targets[0]` 触发止盈，`status`变为`PARTIALLY_CLOSED`，剩余`quantity`为原始的50%（SPEC §6.10默认比例） |
| T2.6 | `realizedPnl = (exitFillPrice - entryPrice) × closedQuantity`，逐条成交独立验证（不是只验证最终汇总数） |

## T3. 空单开仓/止损/止盈（对应SPEC §3、§4.1-4.2、§6，与T2完全对称）

| 用例 | 断言 |
|---|---|
| T3.1 | `decision.biasDirection==='short'` 场景下`buildTradeProposal`/`confirmOpenPosition`全流程，`side==='SELL'`（开仓） |
| T3.2 | 空单开仓成交价 = `referencePrice × (1 - spreadRate/2 - slippageRate)`（卖出不利向下滑点） |
| T3.3 | 收盘K线 `high >= currentStop` 触发止损，回补`side==='BUY'`，成交价向上不利滑点 |
| T3.4 | 收盘K线 `low <= targets[0]` 触发止盈 |
| T3.5 | `realizedPnl = (entryPrice - exitFillPrice) × closedQuantity` |

## T4. 手续费与双向滑点（对应SPEC §4.4）

| 用例 | 断言 |
|---|---|
| T4.1 | 每次成交（开/加/减/平/止损/止盈）各自独立收取 `fee = notional × takerFeeRate`，累计到`account.feesTotal`与`trade.fees` |
| T4.2 | `slippageCost = \|fillPrice - referencePrice\| × quantity`，累计到`account.slippageCostTotal`与`trade.slippage`，且**不**在`cash`恒等式中被重复扣减（与T1.4互相印证） |
| T4.3 | 多单买入、空单回补：滑点使成交价高于参考价；多单卖出、空单开仓：滑点使成交价低于参考价（四个方向逐一构造） |
| T4.4 | `takerFeeRate`/`spreadRate`/`slippageRate` 可通过 `validatePaperAccountSettings` 修改并生效于下一笔新成交，且修改不影响已存在`PaperTrade`历史成交的历史费率记录 |

## T5. 部分止盈与移动止损（对应SPEC §6.10）

| 用例 | 断言 |
|---|---|
| T5.1 | 到达`targets[0]`：平仓50%，`currentStop`移动到`calcBreakevenStop`计算出的保本价（不是简单`entryPrice`），验证保本价公式：剩余仓位在该价止损时，`trade.realizedPnl`累计不为负 |
| T5.2 | 到达`targets[1]`：再平仓原始quantity的30%，`currentStop`移动到`targets[0]` |
| T5.3 | 剩余20%在未触发止损/止盈前保持`PARTIALLY_CLOSED`不变 |
| T5.4 | 移动止损只能同方向收紧：构造一个会导致止损"变差"的错误路径输入，断言函数拒绝或钳制该次移动，不允许`currentStop`向不利方向移动 |

## T6. 浮盈后加仓（对应SPEC §5.2）

| 用例 | 断言 |
|---|---|
| T6.1 | `unrealizedPnl>0 && decision.biasDirection===position.direction && !opportunityScores.blocked && signalPermission.addOnAllowed===true && addOnCount===0 && currentStop已保本` 全部满足时，`confirmAddOn`成功，产生`fillType==='ADD_ON'` |
| T6.2 | 加仓后 `entryPrice` 按SPEC §4.3加权平均公式更新，`quantity`增加，`addOnCount`变为1 |
| T6.3 | `totalRiskAfterAddOn <= riskBudget` 时允许，超过时拒绝并给出具体超出的金额 |
| T6.4 | `addOnQuantity > initialQuantity` 时拒绝（加仓不超过首次试仓仓位红线） |
| T6.5 | 加仓不产生`realizedPnlDelta`（`ADD_ON`类型成交的`realizedPnlDelta===0`） |

## T7. 禁止加仓的各类场景（对应SPEC §5.2，逐条前提条件单独构造反例）

| 用例 | 断言 |
|---|---|
| T7.1 | `unrealizedPnl<=0`（含=0边界）时拒绝加仓，理由文案包含"浮盈"字样，且**不**输出任何"补仓/摊平"措辞 |
| T7.2 | `decision.biasDirection !== position.direction` 时拒绝（方向已失效） |
| T7.3 | `opportunityScores.blocked===true` 时拒绝，即使`decision.worthBetting`字段本身可能仍为true也必须拒绝（V1.1硬性否决优先） |
| T7.4 | `signalPermission.addOnAllowed===false`（非full_aligned）时拒绝 |
| T7.5 | `addOnCount===1`（已加仓过一次）时拒绝，理由文案明确"V1.3每笔交易最多允许1次加仓" |
| T7.6 | `currentStop`尚未移动到保本价时拒绝加仓 |
| T7.7 | 全文扫描`confirmAddOn`所有拒绝路径的文案，断言不出现"摊平"以外的禁止词（即确保没有任何路径把亏损加仓包装成合法建议） |

## T8. 当日亏损3%锁定（对应SPEC §5.3）

| 用例 | 断言 |
|---|---|
| T8.1 | 构造当日累计`realizedPnlDelta`使`dailyRealizedLoss >= dailyStartEquity × dailyLossLimitPct`，账户`riskRegime`变为`DAILY_LOSS_LOCKED` |
| T8.2 | `DAILY_LOSS_LOCKED`状态下`buildTradeProposal`/`confirmAddOn`均返回拒绝，但`confirmReduce`/`confirmClose`（含止损止盈自动触发）仍正常工作 |
| T8.3 | 仅浮亏（未实现）不触发当日锁定（构造大额`unrealizedPnl<0`但`realizedPnlDelta`为0的场景，断言`riskRegime`保持`NORMAL`） |
| T8.4 | UTC日期翻转后，`DAILY_LOSS_LOCKED`（若未同时触发总回撤锁定）自动解除，`dailyStartEquity`重新锚定为翻转前一刻的`equity` |

## T9. 总回撤10%强制观察锁定（对应SPEC §5.4）

| 用例 | 断言 |
|---|---|
| T9.1 | 构造`equity`相对`equityHighWaterMark`回撤达到`maxDrawdownPct`，`riskRegime`变为`FORCED_OBSERVATION` |
| T9.2 | `equityHighWaterMark`只增不减（即使账户后续继续亏损，历史峰值保持不变） |
| T9.3 | `FORCED_OBSERVATION`不会因日期翻转自动解除（与T8.4的日锁定形成对比测试），只能通过显式二次确认解除函数或账户重置解除 |
| T9.4 | `FORCED_OBSERVATION`状态下同样允许减仓/平仓/止损止盈自动触发，禁止新开仓/加仓 |

## T10. 数据陈旧禁止成交（对应SPEC §6.2）

| 用例 | 断言 |
|---|---|
| T10.1 | `decision.dataHealth!=='normal'`时，`buildTradeProposal`/`confirmAddOn`拒绝 |
| T10.2 | `decision.dataHealth!=='normal'`时，用户仍可对已有持仓执行`confirmReduce`/`confirmClose`（手动离场权利保留），但返回结果/UI标记须包含"陈旧数据"提示字样 |
| T10.3 | `decision.dataHealth!=='normal'`期间，`scanClosedBarsForExits`不产生新的自动止损/止盈成交（与手动离场路径区分：自动扫描暂停，手动仍可操作） |

## T11. 重复点击防重（对应SPEC §6.11）

| 用例 | 断言 |
|---|---|
| T11.1 | 连续两次（同步）调用`confirmOpenPosition`传入同一个`proposalId`，第二次必须返回`{ok:false}`且不产生第二笔`PaperTrade`/`PaperFill` |
| T11.2 | 模拟"并发"调用（同一tick内连续调用两次任意确认函数），`account.actionLock`机制阻止第二次执行，断言最终只有一次状态变化生效 |
| T11.3 | `TradeProposal`过期（`Date.now() > expiresAt`）后调用`confirmOpenPosition`必须拒绝，要求重新生成方案 |

## T12. 同K线止盈止损冲突采用不利结果（对应SPEC §6.7）

| 用例 | 断言 |
|---|---|
| T12.1 | 多单场景：构造一根收盘K线同时满足`low<=currentStop`且`high>=targets[0]`，断言最终只产生`STOP_LOSS`成交，**不**产生`TAKE_PROFIT`成交 |
| T12.2 | 空单场景对称验证 |
| T12.3 | 断言该场景下`status`变为`EXITED`而不是`PARTIALLY_CLOSED`（即确认止盈确实完全没有发生，不是"先记录止盈再覆盖成止损"这种会产生错误历史记录的实现方式——`fills`数组里不应出现被覆盖或删除的`TAKE_PROFIT`记录，只应该有一条`STOP_LOSS`记录） |

## T13. 跳空止损（对应SPEC §6.8）

| 用例 | 断言 |
|---|---|
| T13.1 | 多单：构造`bar.open < currentStop`（跳空穿过止损），断言成交基准价为`bar.open`而非原`currentStop`，且在此基础上仍叠加不利滑点 |
| T13.2 | 空单对称验证（`bar.open > currentStop`） |
| T13.3 | 无跳空场景（`bar.open`未越过止损，只有`bar.low`/`bar.high`触及）：成交基准价为原`currentStop`本身 |
| T13.4 | 有利跳空穿过止盈目标位场景（SPEC §6.9）：断言成交价仍按计划目标价（扣减滑点）计算，**不**采用更有利的跳空开盘价 |

## T14. JSON损坏恢复（对应SPEC §9.2）

| 用例 | 断言 |
|---|---|
| T14.1 | `ethAlphaPaperAccount`存储损坏JSON（如`'{bad'`），`loadPaperAccount`安全恢复为默认账户，不抛出异常 |
| T14.2 | `ethAlphaPaperTrades`/`ethAlphaPaperLog`存储损坏JSON，安全恢复为空数组 |
| T14.3 | `schemaVersion`为未知版本字符串时，走"重新初始化+SCHEMA_MISMATCH审计记录"路径，且返回结果标记提示文案存在 |
| T14.4 | 容量超限（`QuotaExceededError`）写入时，返回`{ok:false, reason:'模拟交易存储空间不足'}`，且不抛出未捕获异常，内存态账户状态保持正确（不因写入失败而回滚已经生效的成交） |

## T15. 导出安全（对应SPEC §11）

| 用例 | 断言 |
|---|---|
| T15.1 | `exportPaperLogsJSON`产出合法可被`JSON.parse`还原的字符串，字段与`PaperTrade`/`ethAlphaPaperLog`结构一致 |
| T15.2 | `exportPaperLogsCSV`对含有`=`/`+`/`-`/`@`开头的字段值（模拟恶意`closeReason`文本）正确转义，复用`C.csvCell`，不产生公式注入（对照`audit-fixes-tests.js`已有的CSV公式注入回归测试风格） |
| T15.3 | 导出函数不修改传入的原始数据（纯函数，无副作用） |

## T16. 账户重置二次确认（对应SPEC §2.4，与T1.7/T1.9互补）

| 用例 | 断言 |
|---|---|
| T16.1 | 第一次点击只弹出确认，不改变任何账户字段 |
| T16.2 | 第二次显式确认后，账户按SPEC §2.4列出的全部字段准确复位，`resetCount+1` |
| T16.3 | 重置时存在OPEN持仓也允许强制重置（重置的定义就是清空一切，与"修改初始本金必须先无持仓"的限制不同，两者不能混淆，需专项区分测试） |

## T17. V1.1硬性否决不可绕过（对应SPEC §7.1红线）

| 用例 | 断言 |
|---|---|
| T17.1 | 构造`decision.opportunityScores.blocked===true`但其余字段（`worthBetting`/`biasDirection`等）看似正常的fixture，断言`buildTradeProposal`仍然拒绝 |
| T17.2 | 已有持仓场景下，`decision.opportunityScores.blocked`变为true后，`confirmAddOn`必须拒绝（即使浮盈条件本身满足） |
| T17.3 | `decision.isManual===true`（手动观察模式）时，`buildTradeProposal`必须拒绝，理由文案明确提及"手动观察模式" |

## T18. V1.2预测不能单独触发模拟开仓（对应SPEC §7.1红线）

| 用例 | 断言 |
|---|---|
| T18.1 | 构造`forecast.m15/h1/h4`全部为"偏多"高权重、高置信度，但`decision.worthBetting===false`（或`opportunityScores.blocked===true`）的fixture，断言`buildTradeProposal`仍然拒绝——证明V1.2数据本身不出现在任何开仓判断表达式里 |
| T18.2 | 扫描`buildTradeProposal`/`confirmOpenPosition`/`confirmAddOn`函数体（源码字符串断言，对照`v12-ui-tests.js`用正则扫描源码的既有做法），断言函数体内不引用`forecast.m15`/`forecast.h1`/`forecast.h4`/`weights`/`directionLabel`等V1.2字段作为条件判断依据（只允许在`forecastSnapshot`赋值语句里出现，且必须是整体对象深拷贝赋值，不是挑字段做if判断） |
| T18.3 | `forecastSnapshot`允许为`null`（V1.2未生成预测的场景，例如手动模式），断言此时若`decision`本身满足开仓条件（非手动、非否决），`buildTradeProposal`/`confirmOpenPosition`依然可以正常工作，不因为forecast缺失而被连带拒绝（证明V1.2是纯旁路记录，不是硬性前置依赖） |

## T19. 建仓快照冻结不可被后续刷新覆盖（对应SPEC §7.2红线）

| 用例 | 断言 |
|---|---|
| T19.1 | 开仓后，修改原始传入的`decision`对象的某个字段（如`decision.stopLoss=999`），断言`trade.decisionSnapshot.stopLoss`不受影响，仍是开仓时刻的原始值（验证深拷贝而非引用） |
| T19.2 | 同样验证`forecastSnapshot`不受后续`forecast`对象变化影响 |
| T19.3 | 构造一个模拟"v1-core.js风格原地修改"的fixture（先构造对象，再对同一对象做属性赋值，模拟`e15.state=l.state`这种既有代码模式），确认`confirmOpenPosition`在赋值**之后**才做深拷贝仍能拿到正确的最终值，且后续对该对象的任何进一步修改不影响已保存的快照 |

## T20. 精度与最小名义价值（对应SPEC §6.12）

| 用例 | 断言 |
|---|---|
| T20.1 | 成交价按`pricePrecision`四舍五入 |
| T20.2 | 成交数量按`quantityPrecision`向下取整（不得四舍五入向上，防止超出风险预算） |
| T20.3 | 计算出的`quantity × entryPrice < minNotional`时，开仓/加仓请求被拒绝，且给出具体的最小名义价值文案 |

## T21. 状态机全转换覆盖（对应SPEC §3.4）

| 用例 | 断言 |
|---|---|
| T21.1 | 逐条覆盖SPEC §3.4状态转换表列出的**每一行**转换（`NO_POSITION→PENDING_ENTRY`、`→CANCELLED`、`PENDING_ENTRY→OPEN`、`OPEN→EXITED`/`→PARTIALLY_CLOSED`、`PARTIALLY_CLOSED→EXITED`/保持、任意→`BLOCKED`），每行至少一个独立测试用例 |
| T21.2 | 断言状态机纯函数对"当前状态不允许该事件"的组合（例如对`EXITED`状态尝试`confirmReduce`）返回明确拒绝而不是抛出异常或静默忽略 |

## T22. V1.1/V1.2回归要求（红线，不允许更改被测文件本身）

必须重新执行以下既有测试命令，全部保持通过，**不得修改**这些测试文件的既有内容来"迁就"V1.3的改动（V1.3是纯叠加层，不应导致任何既有断言失败）：

```
node tests/v1-tests.js
node tests/v11-tests.js
node tests/audit-fixes-tests.js
node tests/v11-ui-tests.js
node tests/third-review-tests.js
node tests/live-rest-test.js
node tests/v12-forecast-tests.js
node tests/v12-ui-tests.js
node tests/v12-live-rest-test.js
node work/build-v1.js   # 构建产物逐字节可复现，且新增的/*__PAPER__*/占位符不破坏既有/*__CORE__*//*__FORECAST__*/替换
```

---

## 测试类别数量汇总

| 类别 | 用例组数 |
|---|---:|
| T1 账户初始化与会计恒等式 | 9 |
| T2 多单开仓/止损/止盈 | 6 |
| T3 空单开仓/止损/止盈 | 5 |
| T4 手续费与双向滑点 | 4 |
| T5 部分止盈与移动止损 | 4 |
| T6 浮盈后加仓 | 5 |
| T7 禁止加仓场景 | 7 |
| T8 当日亏损3%锁定 | 4 |
| T9 总回撤10%强制观察 | 4 |
| T10 数据陈旧禁止成交 | 3 |
| T11 重复点击防重 | 3 |
| T12 同K线止盈止损冲突 | 3 |
| T13 跳空止损 | 4 |
| T14 JSON损坏恢复 | 4 |
| T15 导出安全 | 3 |
| T16 账户重置二次确认 | 3 |
| T17 V1.1硬性否决不可绕过 | 3 |
| T18 V1.2预测不能单独开仓 | 3 |
| T19 建仓快照冻结 | 3 |
| T20 精度与最小名义价值 | 3 |
| T21 状态机全转换覆盖 | 2 |
| T22 V1.1/V1.2回归（既有测试文件重跑，不计入新增用例数） | 10个既有命令 |
| **新增用例组合计（T1-T21）** | **85** |

（"用例组"指本文档表格中的一行，实际实现时单个用例组可能展开为多条`assert`，具体断言粒度由`V1_3_CODEX_IMPLEMENTATION_TASK.md`落地时决定，不强制一行一断言。）
