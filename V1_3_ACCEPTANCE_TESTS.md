# V1_3_ACCEPTANCE_TESTS.md — V1.3「模拟交易账户」验收测试规范

版本：v1.3-draft-4（随 `V1_3_PAPER_TRADING_SPEC.md` v1.3-draft-4 同步；T1-T27为draft-2既有内容，T28-T43为draft-3既有内容，新增T44-T57对应SPEC §16「真实行情自动模拟交易引擎」；draft-4正式撤销"逐笔点击确认"授权模型，见下方**函数名对照表**）
依据：`V1_3_PAPER_TRADING_SPEC.md`（每条用例都标注对应章节）。所有测试**必须用构造好的合成K线/合成决策/合成预测对象跑**，不能只靠人工打开页面观察——沿用 `ACCEPTANCE_TESTS.md`/`V1_2_ACCEPTANCE_TESTS.md` 已确立的"合成数据优先"原则。

**fixture真实性红线**：所有涉及 `decision`/`forecast`/`marketData` 字段的测试fixture，字段名和取值格式必须与 `v1-core.js buildDecision()`/`v1_2-forecast-core.js buildForecast()` 的真实返回结构逐字段一致。**禁止**测试自造一套近似结构让测试通过而生产代码实际收到的数据形状不同。

**字段命名红线（draft-2相对draft-1的重命名，测试断言必须使用新字段名）**：`equityHighWaterMark`→`peakEquity`；`availableCash`（=`cash-marginUsed`）→`availableBalance`（=**`equity-marginUsed`**，公式本身也变了，不只是改名）；`realizedPnlTotal`→`realizedPnlGross`；`slippageCostTotal`→`slippageCostReport`。任何测试如果沿用旧字段名或旧公式，视为未同步CEO决策，必须修正。

**函数名对照表（draft-4红线，对应`V1_3_PAPER_TRADING_SPEC.md`§17.2完整记录）**：本文档T1-T27中出现的`autoOpenPosition`/`autoAddOn`是draft-2/draft-3阶段的历史函数名，**已被draft-4废弃**；这些用例断言的会计恒等式/手续费滑点公式/加仓七条件/止损止盈撮合规则等**内容本身继续有效**，只是Codex实现`tests/v13-*.js`时必须把测试里出现的`autoOpenPosition`替换为`autoEngineOpenPosition`、`autoAddOn`替换为`autoEngineAddOn`；`confirmReduce`已整体移除，涉及它的用例（原T8.2/T10.2/T11.3/T21.3/T23.4）已在本文档下方**原地改写**为反映`emergencyClosePosition`唯一保留的现状；`confirmConservativeSettlement`已并入`emergencyClosePosition`，涉及它的用例（原T21.3/T23.4/T24.1）同样已原地改写。T28-T43（Signal Archive/Shadow Evaluation）額外新增：`markSignalRejected`已移除，`userActionStatus`枚举的`ACCEPTED`/`REJECTED`/`MISSED`三值已被`AUTO_EXECUTED`/`AUTO_BLOCKED_BY_RISK`/`AUTO_BLOCKED_BY_POSITION`/`AUTO_MISSED_ENGINE_OFF`/`AUTO_MISSED_DATA_GAP`五值取代（原T39.2-T39.4已原地改写）。

**测试文件与运行方式**：
```
node tests/v13-paper-trading-tests.js
node tests/v13-ui-tests.js
node tests/v13-live-rest-test.js
node tests/v13-signal-archive-tests.js       # draft-3新增
node tests/v13-signal-archive-ui-tests.js    # draft-3新增
node tests/v13-signal-archive-live-rest-test.js  # draft-3新增
node tests/v13-auto-engine-tests.js          # draft-4新增
node tests/v13-auto-engine-ui-tests.js       # draft-4新增
node tests/v13-auto-engine-live-rest-test.js # draft-4新增
```

**draft-3新增字段红线**：`SignalSnapshot`/`SignalEvent`/`ShadowResult`是全新数据结构，不存在字段重命名问题；但**禁止**测试把`ShadowResult`的`grossR`/`netR`/`realizedPnlDelta`等结果字段断言写入或影响`PaperAccount`/`PaperTrade`任何字段（T38专项验证该隔离红线）。

**draft-4新增字段红线**：`AutoEngineState`（`engineState`/`allowNewEntries`/`lastEngineHeartbeat`/`lastProcessedBarTime`等）、`PaperTrade.linkedSignalId`、`PaperTrade.dataGap.gapCause`均为全新字段，不存在重命名问题。

---

## T1. 账户初始化与会计恒等式（对应SPEC §2）

| 用例 | 断言 |
|---|---|
| T1.1 | 首次 `loadPaperAccount(空storage)` 返回 `initialCapital===500`、`cash===500`、`marginUsed===0`、`equity===500`、`peakEquity===500`、`availableBalance===500`、`riskRegime==='NORMAL'`、`currency==='USDT'` |
| T1.2 | 任意一次操作后，`equity === cash + Σ unrealizedPnl` 恒成立 |
| T1.3 | `availableBalance === equity - marginUsed`（**不是**`cash-marginUsed`）恒成立；专门构造一个`unrealizedPnl≠0`的场景，验证`availableBalance`会随浮动盈亏变化（若误用`cash-marginUsed`公式则该场景下断言会失败，用于捕获实现回退到draft-1公式的回归） |
| T1.4 | `cash === initialCapital + realizedPnlGross - feesTotal` 恒成立，且**不**额外扣减`slippageCostReport` |
| T1.5 | 任意成交后 `cash >= 0 && marginUsed <= equity`（等价于`availableBalance>=0`） |
| T1.6 | 修改 `initialCapital` 时若存在OPEN/PARTIALLY_CLOSED/UNRESOLVED_DATA_GAP持仓，返回 `{ok:false}` |
| T1.7 | 修改 `initialCapital` 必须先返回"待二次确认"状态，只有传入二次确认标记后才真正生效 |
| T1.8 | 修改`initialCapital`（或杠杆/费率等任意`settings`字段）**不会**改变`peakEquity`/`realizedPnlGross`/`feesTotal`/`dailyStartEquity`/`dailyAnchorDateUTC`（CEO决策第1项红线，专项构造"账户已有回撤历史后修改本金"场景，断言`peakEquity`数值不变） |
| T1.9 | 重置账户会清空 `ethAlphaPaperTrades`/`ethAlphaPaperLog` 为空数组，且 `ethAlphaPaperLog` 清空后第一条记录是 `ACCOUNT_RESET` 审计记录 |
| T1.10 | 未经二次确认调用重置，账户状态不变 |

## T2. 多单开仓/止损/止盈（对应SPEC §3、§4.1-4.2、§6）

| 用例 | 断言 |
|---|---|
| T2.1 | `decision.biasDirection==='long'&&worthBetting&&!opportunityScores.blocked&&dataHealth==='normal'` 时，`buildTradeProposal` 返回有效方案；否则返回 `{ok:false}` 并给出具体拒绝原因 |
| T2.2 | `autoOpenPosition` 成功后产生 `status:'OPEN'` 的 `PaperTrade`，`fills`长度为1且`fillType==='OPEN'`、`side==='BUY'` |
| T2.3 | 开仓成交价 = `referencePrice × (1 + spreadRate/2 + slippageRate)` |
| T2.4 | 构造收盘K线 `low <= currentStop` 触发止损，产生 `fillType==='STOP_LOSS'`、`side==='SELL'` 的成交，`status`变为`EXITED` |
| T2.5 | 构造收盘K线 `high >= targets[0]` 触发止盈，`status`变为`PARTIALLY_CLOSED`，剩余`quantity`为原始的50% |
| T2.6 | `realizedPnl = (exitFillPrice - entryPrice) × closedQuantity`（Gross口径，不扣手续费），逐条成交独立验证 |

## T3. 空单开仓/止损/止盈（与T2完全对称）

| 用例 | 断言 |
|---|---|
| T3.1 | `decision.biasDirection==='short'` 场景下`buildTradeProposal`/`autoOpenPosition`全流程，`side==='SELL'`（开仓） |
| T3.2 | 空单开仓成交价 = `referencePrice × (1 - spreadRate/2 - slippageRate)` |
| T3.3 | 收盘K线 `high >= currentStop` 触发止损，回补`side==='BUY'` |
| T3.4 | 收盘K线 `low <= targets[0]` 触发止盈 |
| T3.5 | `realizedPnl = (entryPrice - exitFillPrice) × closedQuantity` |

## T4. 手续费与双向滑点（对应SPEC §4.4）

| 用例 | 断言 |
|---|---|
| T4.1 | 每次成交各自独立收取 `fee = notional × takerFeeRate`，累计到`account.feesTotal`与`trade.fees` |
| T4.2 | `slippageCost = \|fillPrice - referencePrice\| × quantity`，累计到`account.slippageCostReport`与`trade.slippage`，且**不**在`cash`恒等式中被重复扣减（与T1.4互相印证） |
| T4.3 | 多单买入、空单回补：滑点使成交价高于参考价；多单卖出、空单开仓：滑点使成交价低于参考价 |
| T4.4 | `takerFeeRate`/`spreadRate`/`slippageRate` 可调整并生效于下一笔新成交，不影响已存在`PaperTrade`历史成交的历史费率记录 |

## T5. 部分止盈、移动止损与成本调整保本位（对应SPEC §6.10，CEO决策第4/5项）

| 用例 | 断言 |
|---|---|
| T5.1 | 到达`targets[0]`：平仓`floor(initialQuantity×0.5, quantityPrecision)`，`currentStop`移动到`calcBreakevenStop`闭式解结果，逐项验证公式：`多单 = (E×Q-R)/(Q×(1-f)×(1-k))`，代入具体数值核对（不接受近似值，允许浮点误差在极小容差内） |
| T5.2 | 到达`targets[1]`：再平仓`floor(initialQuantity×0.3, quantityPrecision)`（固定基于`initialQuantity`，即使此前已发生1次加仓也不重新按当前quantity计算百分比），`currentStop`移动到`targets[0]` |
| T5.3 | 构造一个会因为`floor()`取整产生尾差的`initialQuantity`（例如使`0.5×initialQuantity`和`0.3×initialQuantity`取整后合计不足100%），断言最后一次平仓（到达`targets[2]`或触发止损/保守结算）**直接清空`trade.quantity`当前剩余全部**，不残留任何尾差 |
| T5.4 | 移动止损只能同方向收紧：构造一个会导致止损"变差"的错误路径输入，断言函数拒绝或钳制该次移动，不允许`currentStop`向不利方向移动 |
| T5.5 | 构造"已加仓"场景后再触发`targets[1]`，断言平仓数量仍是`floor(initialQuantity×0.3,...)`（不含加仓部分），加仓带来的新增数量随最终清空剩余全部一并了结，不单独产生自己的分批止盈档位 |

## T6. 浮盈后加仓（对应SPEC §5.2，CEO决策第4项七个条件）

| 用例 | 断言 |
|---|---|
| T6.1 | 全部前提（浮盈+V1.1许可有效+`signalPermission.addOnAllowed`+止损已达保本位+`addOnCount===0`+统一止损口径下`worstCaseLoss<=equity×maxRiskPct`+提供`idempotencyKey`）同时满足时，`autoAddOn`成功，产生`fillType==='ADD_ON'` |
| T6.2 | 加仓后 `entryPrice` 按§4.3加权平均公式更新，`quantity`增加，`addOnCount`变为1 |
| T6.3 | 加仓不产生`realizedPnlDelta`（`ADD_ON`类型成交的`realizedPnlDelta===0`） |
| T6.4 | 构造`currentStop`恰好等于`calcBreakevenStop`计算值的边界场景，断言允许加仓（边界值本身合法，不是要求严格大于） |
| T6.5 | 构造加仓后`worstCaseLoss`恰好等于`equity×maxRiskPct`的边界场景，断言允许加仓（边界值合法） |
| T6.6 | 构造加仓后`worstCaseLoss`略微超过`equity×maxRiskPct`（例如多算0.01 USDT）的场景，断言拒绝，且拒绝原因文案包含具体超出的金额数字 |
| T6.7 | `autoAddOn`未提供`idempotencyKey`或提供空字符串时拒绝执行（红线：不存在无幂等键的加仓路径） |

## T7. 禁止加仓的各类场景（逐条前提条件单独构造反例）

| 用例 | 断言 |
|---|---|
| T7.1 | `unrealizedPnl<=0`（含=0边界）时拒绝加仓，理由文案包含"浮盈"字样，且**不**输出任何"补仓/摊平"措辞 |
| T7.2 | `decision.biasDirection !== position.direction` 时拒绝 |
| T7.3 | `opportunityScores.blocked===true` 时拒绝，即使`decision.worthBetting`字段本身可能仍为true也必须拒绝 |
| T7.4 | `signalPermission.addOnAllowed===false`（非full_aligned）时拒绝 |
| T7.5 | **第二次加仓被明确阻止**：构造`addOnCount===1`（已成功加仓过一次）的持仓，再次调用`autoAddOn`，断言拒绝，理由文案明确"V1.3每笔交易最多允许1次加仓"，且不产生任何新的`PaperFill` |
| T7.6 | **未移动到成本保本位时禁止加仓**：构造`currentStop`仍等于`initialStop`（尚未触发过`targets[0]`分批止盈、止损从未移动）的持仓，即使`unrealizedPnl>0`且其余条件都满足，断言`autoAddOn`仍然拒绝，理由文案明确提及"止损尚未移动到保本位" |
| T7.7 | 构造`currentStop`已经移动但**低于**（多单）/**高于**（空单）`calcBreakevenStop`计算值的场景（即移动了但移动幅度不够，仍不足以真正保本），断言拒绝 |
| T7.8 | `addOnQuantity > initialQuantity` 时拒绝 |
| T7.9 | 全文扫描`autoAddOn`所有拒绝路径的文案，断言不出现"摊平"以外的禁止词 |

## T8. 当日亏损3%锁定（对应SPEC §5.3，CEO决策第8项）

| 用例 | 断言 |
|---|---|
| T8.1 | 构造当日累计`realizedPnlDelta`使`dailyRealizedLoss >= dailyStartEquity × dailyLossLimitPct`，账户`riskRegime`变为`DAILY_LOSS_LOCKED` |
| T8.2 | `DAILY_LOSS_LOCKED`状态下自动开仓/自动加仓判定（§16.2条件10）均返回拒绝，但`scanClosedBarsForExits`自动止损止盈与`emergencyClosePosition`（紧急模拟平仓）仍正常工作 |
| T8.3 | 仅浮亏（未实现）不触发当日锁定 |
| T8.4 | 正常跨日场景（当天此前无任何成交）：UTC日期翻转后，`dailyStartEquity`重建为翻转前一刻的`equity`（与"直接使用当前净值"数值相同，验证公式在此场景下退化正确），`DAILY_LOSS_LOCKED`（若未同时触发总回撤锁定）自动解除 |
| T8.5 | **应用重载/首次启动的确定性回退场景（红线）**：构造"今天已经发生过若干笔已实现盈亏与手续费的成交，但`dailyAnchorDateUTC`尚未被设置或仍是更早日期"的fixture，断言`dailyStartEquity`按公式`equity_当前 - Σ今日realizedPnlDelta + Σ今日fee`重建，**不等于**"直接取当前净值"（构造一个两者数值不同的具体场景，验证系统没有用当前净值掩盖当日已有亏损） |
| T8.6 | 账户/UI数据模型同时暴露UTC日期锚点字符串与对应的本地时间表示（测试环境下验证两个字段/两种展示同时存在，不要求测试真实渲染DOM，只验证数据层面具备双时区信息） |

## T9. 总回撤10%强制观察锁定（对应SPEC §5.4，CEO决策第1项）

| 用例 | 断言 |
|---|---|
| T9.1 | 构造`equity`相对`peakEquity`回撤达到`maxDrawdownPct`，`riskRegime`变为`FORCED_OBSERVATION` |
| T9.2 | `peakEquity`只增不减（即使账户后续继续亏损，历史峰值保持不变） |
| T9.3 | `FORCED_OBSERVATION`不会因日期翻转自动解除，只能通过显式二次确认解除函数或账户重置解除 |
| T9.4 | `FORCED_OBSERVATION`状态下同样允许减仓/平仓/止损止盈自动触发，禁止新开仓/加仓 |
| T9.5 | 与T1.8互证：账户已产生非零`peakEquity`历史（高于`initialCapital`）后，修改`initialCapital`不会把`peakEquity`重置为新的`initialCapital`数值 |

## T10. 数据陈旧禁止成交（对应SPEC §6.2）

| 用例 | 断言 |
|---|---|
| T10.1 | `decision.dataHealth!=='normal'`时，`buildTradeProposal`/`autoAddOn`拒绝 |
| T10.2 | `decision.dataHealth!=='normal'`时，用户仍可对`OPEN`/`PARTIALLY_CLOSED`（非`UNRESOLVED_DATA_GAP`）持仓执行`emergencyClosePosition`，但返回结果/UI标记须包含"陈旧数据"提示字样 |
| T10.3 | `decision.dataHealth!=='normal'`期间，`scanClosedBarsForExits`不产生新的自动止损/止盈成交 |

## T11. 幂等键防重复操作（对应SPEC §6.11，CEO决策第10项，覆盖五种操作）

| 用例 | 断言 |
|---|---|
| T11.1 | 用同一个`idempotencyKey`连续两次调用`autoOpenPosition`，第二次调用**不产生**第二笔`PaperTrade`/`PaperFill`，而是返回与第一次完全相同的结果（真正的幂等重放，不是简单报错） |
| T11.2 | 用同一个`idempotencyKey`连续两次调用`autoAddOn`，验证同上（不重复加仓，返回原结果） |
| T11.3 | 用同一个`idempotencyKey`连续两次调用`emergencyClosePosition`，验证不产生重复成交 |
| T11.4 | 用同一个`idempotencyKey`连续两次调用`resetPaperAccount`，验证`resetCount`只增加1次（不是2次），第二次调用返回与第一次相同的账户状态 |
| T11.5 | 模拟"并发"调用（同一tick内连续调用两次任意确认函数，不同`idempotencyKey`），`account.actionLock`机制阻止真正意义上的重入，断言最终状态变化次数与传入的不同key数一致（即锁不会误伤合法的不同操作） |
| T11.6 | `TradeProposal`过期（`Date.now() > expiresAt`）后调用`autoOpenPosition`（即使`idempotencyKey`是全新的）必须拒绝，要求重新生成方案 |

## T12. 同K线止盈止损冲突采用不利结果（对应SPEC §6.7）

| 用例 | 断言 |
|---|---|
| T12.1 | 多单场景：构造一根收盘K线同时满足`low<=currentStop`且`high>=targets[0]`，断言最终只产生`STOP_LOSS`成交，**不**产生`TAKE_PROFIT`成交 |
| T12.2 | 空单场景对称验证 |
| T12.3 | 断言该场景下`status`变为`EXITED`而不是`PARTIALLY_CLOSED`，`fills`数组里不应出现被覆盖或删除的`TAKE_PROFIT`记录，只应该有一条`STOP_LOSS`记录 |

## T13. 跳空止损（对应SPEC §6.8-6.9）

| 用例 | 断言 |
|---|---|
| T13.1 | 多单：构造`bar.open < currentStop`，断言成交基准价为`bar.open`而非原`currentStop`，且在此基础上仍叠加不利滑点 |
| T13.2 | 空单对称验证 |
| T13.3 | 无跳空场景：成交基准价为原`currentStop`本身 |
| T13.4 | 有利跳空穿过止盈目标位场景：断言成交价仍按计划目标价（扣减滑点）计算，**不**采用更有利的跳空开盘价 |

## T14. JSON损坏恢复与Schema迁移（对应SPEC §9.2-9.3）

| 用例 | 断言 |
|---|---|
| T14.1 | `ethAlphaPaperAccount`存储损坏JSON，`loadPaperAccount`安全恢复为默认账户，不抛出异常 |
| T14.2 | `ethAlphaPaperTrades`/`ethAlphaPaperLog`存储损坏JSON，安全恢复为空数组 |
| T14.3 | `schemaVersion`为未知（比当前更新的）版本字符串时，走"重新初始化+SCHEMA_MISMATCH审计记录"路径 |
| T14.4 | 容量超限（`QuotaExceededError`）写入时，返回`{ok:false, reason:'模拟交易存储空间不足'}`，且不抛出未捕获异常，内存态账户状态保持正确 |
| T14.5 | 构造`schemaVersion==='v1.3-account-1'`（draft-1旧版）的历史数据，字段包含`equityHighWaterMark`/`availableCash`/`realizedPnlTotal`/`slippageCostTotal`旧命名，断言`migratePaperAccount`正确迁移到`v1.3-account-2`：`equityHighWaterMark`值原样搬到`peakEquity`，`realizedPnlTotal`值原样搬到`realizedPnlGross`，`slippageCostTotal`值原样搬到`slippageCostReport`，`availableCash`字段被丢弃（不再持久化），新增的`estimated`/`verified`/`dataGap`/`processedIdempotencyKeys`字段按默认值补齐 |

## T15. 导出安全（对应SPEC §11）

| 用例 | 断言 |
|---|---|
| T15.1 | `exportPaperLogsJSON`产出合法可被`JSON.parse`还原的字符串，字段与`PaperTrade`/`ethAlphaPaperLog`结构一致 |
| T15.2 | `exportPaperLogsCSV`对含有`=`/`+`/`-`/`@`开头的字段值正确转义，复用`C.csvCell` |
| T15.3 | 导出函数不修改传入的原始数据（纯函数，无副作用） |
| T15.4 | 导出结果（JSON与CSV）中每笔交易均包含`estimated`/`verified`字段且数值与源数据一致（正常交易`estimated===false`，保守结算交易`estimated===true`） |

## T16. 账户重置二次确认（对应SPEC §2.4）

| 用例 | 断言 |
|---|---|
| T16.1 | 第一次点击只弹出确认，不改变任何账户字段 |
| T16.2 | 第二次显式确认后，账户按§2.4列出的全部字段准确复位（含`peakEquity=initialCapital`，这是`peakEquity`**唯一**允许被重建的路径），`resetCount+1` |
| T16.3 | 重置时存在OPEN/PARTIALLY_CLOSED/UNRESOLVED_DATA_GAP持仓也允许强制重置（与"修改初始本金必须先无持仓"的限制不同） |
| T16.4 | 重置操作若未提供`idempotencyKey`则拒绝执行 |

## T17. V1.1硬性否决不可绕过（对应SPEC §7.1）

| 用例 | 断言 |
|---|---|
| T17.1 | 构造`decision.opportunityScores.blocked===true`但其余字段看似正常的fixture，断言`buildTradeProposal`仍然拒绝 |
| T17.2 | 已有持仓场景下，`decision.opportunityScores.blocked`变为true后，`autoAddOn`必须拒绝 |
| T17.3 | `decision.isManual===true`时，`buildTradeProposal`必须拒绝，理由文案明确提及"手动观察模式" |

## T18. V1.2预测不能单独触发模拟开仓（对应SPEC §7.1）

| 用例 | 断言 |
|---|---|
| T18.1 | 构造`forecast.m15/h1/h4`全部为"偏多"高权重、高置信度，但`decision.worthBetting===false`（或`opportunityScores.blocked===true`）的fixture，断言`buildTradeProposal`仍然拒绝 |
| T18.2 | 扫描`buildTradeProposal`/`autoOpenPosition`/`autoAddOn`函数体源码，断言不引用`forecast.m15`/`forecast.h1`/`forecast.h4`/`weights`/`directionLabel`等V1.2字段作为条件判断依据 |
| T18.3 | `forecastSnapshot`允许为`null`时，若`decision`本身满足开仓条件，`buildTradeProposal`/`autoOpenPosition`依然可以正常工作 |

## T19. 建仓快照冻结不可被后续刷新覆盖（对应SPEC §7.2）

| 用例 | 断言 |
|---|---|
| T19.1 | 开仓后修改原始传入的`decision`对象某字段，断言`trade.decisionSnapshot`不受影响 |
| T19.2 | 同样验证`forecastSnapshot`不受后续`forecast`对象变化影响 |
| T19.3 | 构造模拟"v1-core.js风格原地修改"的fixture，确认`autoOpenPosition`在赋值之后才做深拷贝仍能拿到正确的最终值 |

## T20. 精度与最小名义价值（对应SPEC §6.12）

| 用例 | 断言 |
|---|---|
| T20.1 | 成交价按`pricePrecision`四舍五入 |
| T20.2 | 成交数量按`quantityPrecision`向下取整 |
| T20.3 | 计算出的`quantity × entryPrice < minNotional`时，开仓/加仓请求被拒绝 |

## T21. 状态机全转换覆盖（对应SPEC §3.4，含`UNRESOLVED_DATA_GAP`）

| 用例 | 断言 |
|---|---|
| T21.1 | 逐条覆盖SPEC §3.4状态转换表列出的**每一行**转换，含新增的`OPEN/PARTIALLY_CLOSED→UNRESOLVED_DATA_GAP`与`UNRESOLVED_DATA_GAP→EXITED` |
| T21.2 | 断言状态机纯函数对"当前状态不允许该事件"的组合返回明确拒绝而不是抛出异常或静默忽略 |
| T21.3 | `UNRESOLVED_DATA_GAP`状态下调用自动加仓判定一律拒绝，断言状态不变；`emergencyClosePosition`在该状态下**允许**调用但自动切换为§8.5保守结算成交规则（非常规成交），断言两种路径分别正确 |

## T22. 数据缺口成功回放（对应SPEC §8.3，CEO决策第6项）

| 用例 | 断言 |
|---|---|
| T22.1 | 构造数据失效期间的缺失K线，恢复后`marketData.eth.tf15m`返回的已收盘K线**完整覆盖**缺口（`openTime`序列连续），断言按§6.6-6.9规则逐根顺序回放，正确识别期间是否触发止损/止盈并相应更新状态 |
| T22.2 | 回放完成后`trade.dataGap.resolvedAt`被设置，`replayAttempts`数组新增一条`coverageComplete:true`记录 |
| T22.3 | 回放解决缺口后，"无法可靠估值"标签被摘除，`unrealizedPnl`恢复正常随行情更新 |

## T23. 数据缺口无法回补时不伪造成交（对应SPEC §8.3-8.4）

| 用例 | 断言 |
|---|---|
| T23.1 | 构造恢复后返回的K线相对缺口存在不连续（`openTime`序列出现跳跃），断言`status`变为`UNRESOLVED_DATA_GAP` |
| T23.2 | `replayAttempts`新增一条`coverageComplete:false`记录，`missingBarCount`给出可估算的缺口跨度 |
| T23.3 | 该次失败回放尝试**不产生**任何`PaperFill`（不得因为找不到完整数据就假装按当前价格继续或假装已经安全离场） |
| T23.4 | `UNRESOLVED_DATA_GAP`状态下自动加仓判定拒绝；`emergencyClosePosition`是唯一可用操作，且必然采用保守结算成交规则（非常规当前markPrice成交） |

## T24. 用户确认保守结算（对应SPEC §8.5，CEO决策第6项）

| 用例 | 断言 |
|---|---|
| T24.1 | `emergencyClosePosition`的保守结算分支只能由用户显式点击触发，不存在任何自动触发路径（源码扫描：该函数不出现在`scanClosedBarsForExits`/`tickAutoEngine`内部的自动调用列表中） |
| T24.2 | 成交价 = 缺口结束后第一根可获得的已收盘K线的`open`价格，按方向叠加不利滑点（多单向下、空单向上，与§4.2方向表一致） |
| T24.3 | 平仓后`closeReason==='DATA_GAP_CONSERVATIVE'`，`estimated===true`，`verified===false` |
| T24.4 | `dataGap.startTime`/`dataGap.replayAttempts`/`dataGap.conservativeSettlementConfirmedAt`三项审计字段均被正确填充且不可再被覆盖 |

## T25. estimated交易排除于验证统计（对应SPEC §8.5红线）

| 用例 | 断言 |
|---|---|
| T25.1 | 导出的交易记录（JSON/CSV）中`estimated`/`verified`字段真实可读，取值与交易实际路径一致 |
| T25.2 | 构造一个测试专用的"聚合胜率/平均盈亏比"辅助计算函数（仅用于验证契约，不是生产代码），验证若不过滤`estimated===true`记录会得到与预期不同（被污染）的结果，过滤后得到正确结果——用于确立"下游必须过滤"这一契约的可测试性，而不是断言V1.3自己实现了统计（V1.3本身不计算胜率） |
| T25.3 | 正常止损/止盈/手动平仓路径产生的交易，`estimated`恒为`false`、`verified`恒为`true`，只有`DATA_GAP_CONSERVATIVE`路径产生`true`/`false` |

## T26. 单笔/试仓风险预算恒以当前净值为基准（对应SPEC §5.1，CEO决策第2项红线）

| 用例 | 断言 |
|---|---|
| T26.1 | 相同`equity`前提下，改变`leverage`（1/2/3）不改变`maxLossAmount`（风险预算金额只应通过`margin`字段体现杠杆影响，不影响风险预算本身） |
| T26.2 | 构造`equity`因已实现/未实现盈亏变化而不同的两个场景（`initialCapital`相同），断言两次计算出的风险预算金额按新的`equity`成比例变化，而不是固定为基于`initialCapital`算出的同一个数字 |
| T26.3 | 构造`initialCapital`不同但`equity`相同的两个账户状态（例如一个从500起步已盈利到600，另一个`initialCapital`直接设为600且尚无盈亏），断言两者算出的风险预算金额相同（证明基准是`equity`而非`initialCapital`） |

## T27. V1.1/V1.2回归要求（红线，不允许更改被测文件本身）

必须重新执行以下既有测试命令，全部保持通过，**不得修改**这些测试文件的既有内容：

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

## T28. 建议档案自动创建（对应SPEC §15.3八条件，draft-3新增）

| 用例 | 断言 |
|---|---|
| T28.1 | 构造同时满足SPEC §15.3全部八条件的`decision`/`forecast`/`marketData` fixture，`recordSignalIfEligible`返回`{ok:true, signal}`，`signal`已写入`ethAlphaSignalArchive`，`lifecycleStatus==='RECORDED'`、`userActionStatus==='UNSEEN'`、`acknowledgedAt===null`、`linkedPaperTradeId===null` |
| T28.2 | 新建`signal`的`decisionSnapshot`/`forecastSnapshot`/`btcStructureSnapshot`字段与传入的`decision`/`forecast`/`marketData.btc`逐字段深度相等（非引用相等，见T31深拷贝专项） |
| T28.3 | `entryZone`/`triggerConditions`字段值与`decision.triggerPlans[decision.biasDirection]`对应字段完全一致 |
| T28.4 | `riskRewardGross`/`riskRewardNet`取自`decision.triggerPlans[direction].riskReward.grossValue`/`.netValue`，**不等于**任何影子验证事后计算值（因为此时尚未发生影子验证） |
| T28.5 | 不产生`SignalSnapshot`时（八条件任一不满足），既有`ethAlphaDecisionLogs`/`ethAlphaDecisionLogsV11`写入行为不受影响（draft-2/V1.1既有机制不因Signal Archive存在而改变） |

## T29. 建议不进入正式档案的排除场景（对应SPEC §15.3红线，逐条构造反例）

| 用例 | 断言 |
|---|---|
| T29.1 | `decision.opportunityScores.blocked===true`（其余条件均满足）：`recordSignalIfEligible`返回`{ok:false}`，不写入`ethAlphaSignalArchive` |
| T29.2 | `decision.isManual===true`（手动观察模式）：同上拒绝，理由文案明确提及"手动观察模式" |
| T29.3 | `decision.dataHealth!=='normal'`：同上拒绝 |
| T29.4 | `decision.biasDirection==='long_caution'`（降级确信度，非完全可执行）：同上拒绝，理由文案说明"非可执行方向" |
| T29.5 | `decision.worthBetting===false`：同上拒绝 |
| T29.6 | `decision.stopLoss`/`decision.targets`/`decision.exitConditions`任一缺失或空数组：同上拒绝 |
| T29.7 | 扫描`recordSignalIfEligible`函数体源码，断言创建判定表达式不引用`forecast.m15`/`h1`/`h4`/`directionLabel`等V1.2字段（同draft-2 T18.2先例，V1.2只能作快照证据） |

## T30. `signalFingerprint`去重与版本规则（对应SPEC §15.4）

| 用例 | 断言 |
|---|---|
| T30.1 | 同一`sourceConfirmedBarTime`、同一`direction`、同一指纹连续两次调用`recordSignalIfEligible`：第二次返回`{ok:true, signal, deduped:true}`，`ethAlphaSignalArchive`长度不变（不产生第二条记录） |
| T30.2 | 新的已收盘K线到来但计划全部分量（方向/进场区/止损/目标/`riskRuleVersion`/`decisionAlgorithmVersion`）与该方向最新记录指纹相同：不创建新版本，返回已存在记录 |
| T30.3 | 新的已收盘K线到来且止损或目标发生实质变化：创建新`SignalSnapshot`，`supersedesSignalId`指向被取代的上一条`signalId`，`ethAlphaSignalEvents`新增一条该旧`signalId`名下的`SUPERSEDED`事件 |
| T30.4 | 构造价格分量因浮点噪声产生极小差异（差异小于`pricePrecision`取整精度）的两次计算：指纹相同，不误判为"实质变化"（验证§15.4取整后再拼接的红线） |
| T30.5 | 构造`decision.price`（未收盘实时价）在同一根已收盘K线周期内多次跳动、但`sourceConfirmedBarTime`不变的场景：不产生新版本（验证"禁止用未收盘实时价格制造新建议"红线） |
| T30.6 | 被取代的旧版本若当时仍处于`WAITING_TRIGGER`，其影子验证独立继续进行，最终仍正常判定出`TRIGGERED`/`EXPIRED_UNTRIGGERED`等结果，不因被取代而提前终止或从统计中消失 |

## T31. 建议快照不可变性（对应SPEC §15.2红线）

| 用例 | 断言 |
|---|---|
| T31.1 | 创建`signal`后，修改传入的原始`decision`/`forecast`/`marketData`对象某字段，断言`ethAlphaSignalArchive`中已存储的对应`SignalSnapshot`不受影响（同draft-2 T19.1深拷贝先例） |
| T31.2 | 创建后调用任意生命周期推进/用户行为标记函数（`evaluateShadowSignals`/`markSignalSeen`/`linkSignalToPaperTrade`等），断言`ethAlphaSignalArchive`中该`signalId`对应记录的`lifecycleStatus`/`acknowledgedAt`/`linkedPaperTradeId`/`userActionStatus`四个字段**原始存储值**始终分别保持`'RECORDED'`/`null`/`null`/`'UNSEEN'`不变（红线，验证"投影不回写原始数组"设计） |
| T31.3 | 同一场景下，`getSignalCurrentView(signalId)`返回的**合并视图**里，以上四个字段确实反映了最新状态（与T31.2的原始存储值形成对照，证明"不可变存储+可变投影"两层机制都工作正常） |
| T31.4 | `ethAlphaShadowResults`中对应`signalId`的记录**允许**被新的评估结果覆盖更新（验证这是本文档唯一允许覆写的存储，与`ethAlphaSignalArchive`/`ethAlphaSignalEvents`的不可变/追加式约束形成对照） |
| T31.5 | `verifySignalArchiveIntegrity`对未被篡改的`ethAlphaSignalArchive`返回`{ok:true, mismatches:[]}`；人为篡改测试环境下存储的某条记录后调用，返回该条记录的不一致清单 |

## T32. 建议生命周期状态机全转换覆盖（对应SPEC §15.5）

| 用例 | 断言 |
|---|---|
| T32.1 | 逐条覆盖SPEC §15.5转换表列出的**每一行**转换 |
| T32.2 | 断言纯函数状态机对"当前状态不允许该事件"的组合返回明确拒绝而不是抛出异常或静默忽略 |
| T32.3 | 断言全部终态（`COMPLETED`/`STOPPED`/`EXPIRED_UNTRIGGERED`/`INVALIDATED_BEFORE_ENTRY`/`CANCELLED_BY_RULE_CHANGE`）不可再转换到任何非终态（红线，CEO原文"不允许完成状态重新变回等待状态"） |
| T32.4 | `UNRESOLVED_DATA_GAP`离开该状态只能前进到"按回补K线继续判定所得出的状态"，不允许倒退到进入该状态前更早的生命周期阶段 |

## T33. 影子撮合规则：进场区触及、同K线冲突、跳空（对应SPEC §15.6）

| 用例 | 断言 |
|---|---|
| T33.1 | **红线**：构造包含`openTime<=sourceConfirmedBarTime`的K线与`isClosed===false`的K线混入待评估数据，断言`evaluateShadowSignals`完全不使用这些K线参与任何判定（防未来数据泄漏专项） |
| T33.2 | 多头：构造`bar.low<=entryZone.upper`的已收盘K线，断言`lifecycleStatus`转`TRIGGERED`，`entryFillPrice===entryZone.estimatedEntry` |
| T33.3 | 空头对称验证 |
| T33.4 | **同一根K线同时触发进场和止损**：构造`bar.low<=entryZone.upper`且同一根`bar.low<=stopLoss`，断言最终`lifecycleStatus==='STOPPED'`（不停留在`TRIGGERED`），CEO"进场后止损"规则专项 |
| T33.5 | **同一根K线同时触及止损和目标（已处于TRIGGERED之后）**：构造`bar.low<=stopLoss && bar.high>=targets[0]`（多头），断言只产生`STOPPED`结果，不产生`TARGET_1_HIT` |
| T33.6 | 跳空止损：构造`bar.open`已越过`stopLoss`的K线，断言止损成交基准价为`bar.open`而非原`stopLoss`本身，且叠加不利滑点 |
| T33.7 | 有利跳空穿过目标位：断言目标成交价仍按计划目标价（扣减滑点）计算，不采用更有利的跳空开盘价 |
| T33.8 | 未触及进场区但已越过止损（跳空穿过整个进场区与止损）：断言转`INVALIDATED_BEFORE_ENTRY`，不产生任何"进场后止损"的假设成交 |

## T34. 未触发过期与触发前失效（对应SPEC §15.5/§15.11）

| 用例 | 断言 |
|---|---|
| T34.1 | 构造有效期内全部已收盘K线均未触及`entryZone`，且最新已收盘K线`closeTime>validUntil`：断言`lifecycleStatus==='EXPIRED_UNTRIGGERED'` |
| T34.2 | `EXPIRED_UNTRIGGERED`结果**不计算**`grossR`/`netR`/MFE/MAE（均为`null`），且不被`computeSignalAccuracyStats`的触发后胜负率分母计入（与T40互证） |
| T34.3 | 触发前价格越过`stopLoss`（未触及进场区）：断言`lifecycleStatus==='INVALIDATED_BEFORE_ENTRY'`，同样不计算R值 |
| T34.4 | **红线**：`validUntil`创建后不因任何后续调用被修改（构造尝试传入"事后调整"的路径，断言不存在这样的函数/参数，或存在也返回拒绝） |
| T34.5 | `SIGNAL_DEFAULT_VALIDITY_MS`硬编码断言等于`TF_MS['4h']`（14400000），版本校验测试使用独立硬编码基准值，不从运行时对象自证式反算（同draft-2 T14.5/`V1_3_PAPER_TRADING_SPEC.md`§12"不得自证式反算"先例） |

## T35. 目标1/2/3与止损结果判定（对应SPEC §15.5/§15.6）

| 用例 | 断言 |
|---|---|
| T35.1 | 依次构造触及`targets[0]`/`targets[1]`/`targets[2]`的已收盘K线序列，断言`lifecycleStatus`依次经过`TRIGGERED→TARGET_1_HIT→TARGET_2_HIT→TARGET_3_HIT→COMPLETED` |
| T35.2 | **红线**：`TARGET_1_HIT`之后构造一根触及原始`stopLoss`（而非任何"移动止损"价位）的K线，断言转`STOPPED`——专项验证§15.5"不模拟移动止损"设计决定，即使假设性地在同一场景下用draft-2式移动止损价位计算会得出不同结果，本测试断言系统使用的是`SignalSnapshot.stopLoss`原始冻结值 |
| T35.3 | `TARGET_3_HIT`到`COMPLETED`的转换不需要额外事件，达到`targets[2]`立即为`COMPLETED`终态 |

## T36. MFE/MAE与毛R/净R计算（对应SPEC §15.6公式）

| 用例 | 断言 |
|---|---|
| T36.1 | 构造具体数值场景，逐项代入SPEC §15.6公式验证`MFE`/`MAE`计算结果（多头/空头各一组，含浮点误差极小容差） |
| T36.2 | 逐项代入`grossR = (exitPrice-entryFillPrice)/risk`（多头）验证结果 |
| T36.3 | 逐项代入净R公式（含`feeAssumption`/`slippageAssumption`双边调整）验证结果，与`grossR`结果比较，断言`netR`严格劣于`grossR`（净值总是因成本假设而变差，同一盈利结果下净R小于毛R；同一亏损结果下净R比毛R更差） |
| T36.4 | `barsHeld`/`durationMs`按SPEC §15.6公式计算，逐项验证 |
| T36.5 | `EXPIRED_UNTRIGGERED`/`INVALIDATED_BEFORE_ENTRY`的`grossR`/`netR`/MFE/MAE/`barsHeld`/`durationMs`全部为`null`（与T34.2互证） |

## T37. 影子验证数据缺口（对应SPEC §15.7）

| 用例 | 断言 |
|---|---|
| T37.1 | 构造数据失效期间的缺失K线，恢复后完整覆盖缺口（`openTime`序列连续）：断言按§15.6规则逐根顺序回放，`ShadowDataGap.resolvedAt`被设置，`lifecycleStatus`恢复为回放前对应状态并继续判定 |
| T37.2 | 无法完整回补：`replayAttempts`新增`STILL_GAP`记录，`lifecycleStatus`维持`UNRESOLVED_DATA_GAP`，`ShadowResult.verified===false`，**不产生**任何猜测性的胜负判定 |
| T37.3 | **红线**：扫描Signal Archive全部导出函数，断言不存在任何"用户确认强制结算/估算收敛"路径（与Auto Paper Trading Account的`emergencyClosePosition`保守结算分支刻意不对称，验证§15.7"没有人工出口"红线） |
| T37.4 | `UNRESOLVED_DATA_GAP`可以无限期保持（构造超长时间跨度仍未回补的场景），不因超时被强制转为任何终态 |

## T38. 影子验证与模拟账户资金隔离（对应SPEC §15.0红线，本轮最高优先级测试）

| 用例 | 断言 |
|---|---|
| T38.1 | 构造一个完整的`TARGET_3_HIT→COMPLETED`盈利影子验证场景，运行前后对比`ethAlphaPaperAccount`（`equity`/`cash`/`marginUsed`/`realizedPnlGross`等全部字段）逐字节不变 |
| T38.2 | 同上构造一个`STOPPED`亏损影子验证场景，同样验证`PaperAccount`零变化 |
| T38.3 | 扫描`evaluateShadowSignals`/`computeSignalAccuracyStats`等全部Signal Archive导出函数源码，断言不存在对`ethAlphaPaperAccount`/`ethAlphaPaperTrades`/`ethAlphaPaperLog`的任何写操作（`localStorage.setItem`/`storage.setItem`调用目标key白名单校验） |
| T38.4 | 断言`evaluateShadowSignals`不产生任何`PaperPosition`/`PaperFill`对象，不调用`v1_3-paper-trading-core.js`的任何写操作型导出函数（`autoOpenPosition`等） |

## T39. 用户行为关联与执行对比（对应SPEC §15.9）

| 用例 | 断言 |
|---|---|
| T39.1 | `markSignalSeen`后`getSignalCurrentView`返回的`userActionStatus`变为`'SEEN'`，`acknowledgedAt`投影值被设置；原始`ethAlphaSignalArchive`记录不变（与T31.2互证） |
| T39.2 | 引擎自动开仓并携带`signalId`（§16.2条件6完成`TRIGGERED`转换且其余十四项条件满足）：`autoEngineOpenPosition`成功后，`ethAlphaSignalEvents`新增`LINKED_PAPER_TRADE`事件，`getSignalCurrentView`返回的`linkedPaperTradeId`等于新建`PaperTrade.tradeId`，`userActionStatus`变为`'AUTO_EXECUTED'` |
| T39.3 | 构造建议进入终态（非`EXPIRED_UNTRIGGERED`）时仍为`UNSEEN`/`SEEN`且从未产生`AUTO_EXECUTED`的场景：断言系统自动追加对应事件，`userActionStatus`变为`AUTO_MISSED_DATA_GAP`（数据/引擎离线原因）或保持既有分类；`SEEN`是唯一仍需要真实用户点击（打开UI查看）才改变的`userActionStatus`前置状态，其余全部由引擎自动判定 |
| T39.4 | 构造该signal触发那一刻`riskRegime`为`DAILY_LOSS_LOCKED`/`FORCED_OBSERVATION`或`engineState`为`AUTO_PAPER_PAUSED`/`AUTO_PAPER_RISK_LOCKED`或`allowNewEntries===false`的场景：断言`userActionStatus`变为`'AUTO_BLOCKED_BY_RISK'`；构造已有冲突仓位或同signalId已开过仓的场景：断言变为`'AUTO_BLOCKED_BY_POSITION'`；构造触发时`engineState`为`AUTO_PAPER_OFF`/`AUTO_PAPER_ARMED`的场景：断言变为`'AUTO_MISSED_ENGINE_OFF'` |
| T39.5 | 关联后，`getSignalCurrentView`同时暴露`entryZone.estimatedEntry`（建议理论进场价）与关联`PaperTrade.entryPrice`（模拟账户真实成交价）两个独立字段，断言两者不被互相覆盖或平均，即使数值不同 |

## T40. 准确度统计口径与分组（对应SPEC §15.8，分母规则专项）

| 用例 | 断言 |
|---|---|
| T40.1 | `computeSignalAccuracyStats`返回对象包含SPEC §15.8表格列出的**全部**独立指标字段，**不**只返回一个笼统的"准确率"字段 |
| T40.2 | **分母红线1**：构造包含若干`EXPIRED_UNTRIGGERED`记录的数据集，断言"触发后止损率"/"目标123到达率"的分母不包含这些记录（分母仅统计已触发数） |
| T40.3 | **分母红线2**：构造包含`UNRESOLVED_DATA_GAP`/`verified===false`记录的数据集，断言这些记录不计入任何比率类指标的分子分母，只在"数据缺口导致无法验证的数量"单独出现 |
| T40.4 | **分母红线3**：混合构造`estimated`概念对应的场景（若关联了draft-2保守结算的`PaperTrade`，Signal Archive层面该signal本身仍以自己的`ShadowResult.verified`为准，不因关联的`PaperTrade.estimated===true`而受影响，两者是独立判定），断言Signal Archive统计口径只依赖自身`ShadowResult.verified`字段 |
| T40.5 | 多头/空头分组：构造两个方向各若干条记录，断言分组统计数值正确且总和与不分组统计一致 |
| T40.6 | 按`decisionSnapshot.state`（V1.1市场状态六态）分组统计正确 |
| T40.7 | 按`forecastSnapshot.m15/h1/h4.directionLabel`分组，`forecastSnapshot===null`的记录归入独立"无预测快照"分组，不丢弃 |
| T40.8 | 按`decisionSnapshot.btcAlignment`（支持/反对/中性）分组统计正确 |
| T40.9 | 用户执行/用户错过/用户主动放弃数量按当前`userActionStatus`投影值正确计数 |
| T40.10 | "系统建议正确但用户错过"数量：构造`userActionStatus==='MISSED'`且`lifecycleStatus`为目标命中类终态的记录，断言被正确计数 |
| T40.11 | **红线**：`computeSignalAccuracyStats`输出对象包含固定字段`statisticsBasis==='FORWARD_RULE_BASED_SHADOW_EVALUATION'`；扫描相关文案/导出内容，断言不出现"校准""概率""预测准确度保证"等措辞 |

## T41. 存储、迁移、损坏恢复、容量与导出安全（对应SPEC §15.10）

| 用例 | 断言 |
|---|---|
| T41.1 | `ethAlphaSignalArchive`/`ethAlphaSignalEvents`/`ethAlphaShadowResults`任一存储损坏JSON，安全恢复为空数组，不抛出异常 |
| T41.2 | 容量超限（构造超过2000条记录）：断言只裁剪最旧记录，新记录保留 |
| T41.3 | `migrateSignalArchive`对未知/过期`schemaVersion`的历史数据按默认值重建并留下可审计记录 |
| T41.4 | `exportSignalArchiveJSON`产出合法可被`JSON.parse`还原的字符串 |
| T41.5 | `exportSignalArchiveCSV`对含`=`/`+`/`-`/`@`开头的字段值正确转义，复用`C.csvCell`（同draft-2 T15.2先例） |
| T41.6 | 导出函数不修改传入的原始数据（纯函数，无副作用） |
| T41.7 | 删除某`signalId`对应的`SignalSnapshot`后（理论上不应发生，容量裁剪除外），断言`ethAlphaShadowResults`中对应的孤儿记录被一并清理，不残留 |

## T42. 清空建议历史二次确认且不触碰模拟账户（对应SPEC §15.10红线）

| 用例 | 断言 |
|---|---|
| T42.1 | 第一次点击只弹出确认，不清空任何数据 |
| T42.2 | 第二次显式确认后，`ethAlphaSignalArchive`/`ethAlphaSignalEvents`/`ethAlphaShadowResults`三个key全部清空 |
| T42.3 | `resetSignalArchive`未提供`idempotencyKey`则拒绝执行 |
| T42.4 | **红线**：构造一个存在若干`OPEN`/`EXITED`状态`PaperTrade`（含`linkedPaperTradeId`指向它们的`SignalSnapshot`）的场景，调用`resetSignalArchive`确认清空后，断言`ethAlphaPaperAccount`/`ethAlphaPaperTrades`/`ethAlphaPaperLog`三者逐字节不变，`PaperTrade`记录本身完整保留（只是失去了指向它们的建议档案索引） |

## T43. V1.1/V1.2/V1.3既有测试回归（红线，追加于draft-2 T27，不允许更改被测文件本身）

必须在draft-2 T27既有命令基础上，额外重新执行以下命令，全部保持通过，**不得修改**这些测试文件的既有内容：

```
node tests/v13-paper-trading-tests.js
node tests/v13-ui-tests.js
node tests/v13-live-rest-test.js
node work/build-v1.js   # 构建产物逐字节可复现，新增的/*__SIGNAL_ARCHIVE_UI__*//*__SIGNAL_ARCHIVE__*/占位符不破坏既有全部占位符替换
```

---

## T44. 引擎宏观状态机（对应SPEC §16.1，draft-4新增）

| 用例 | 断言 |
|---|---|
| T44.1 | `engineState==='AUTO_PAPER_OFF'`时，`tickAutoEngine`不产生任何自动开仓/加仓判定（CEO"自动模式关闭不交易"） |
| T44.2 | 用户第一次点击"开启自动模拟交易"只弹出确认，`engineState`保持`AUTO_PAPER_OFF`不变（CEO"首次开启需要二次确认"） |
| T44.3 | 第二次显式确认+`idempotencyKey`后，`engineState`变为`AUTO_PAPER_ARMED`；未提供`idempotencyKey`时`armAutoEngine`拒绝执行 |
| T44.4 | `AUTO_PAPER_ARMED`状态下，下一次`v11decision`事件tick到达后`engineState`自动变为`AUTO_PAPER_RUNNING`，无需任何额外用户操作（CEO"ARMED到RUNNING"） |
| T44.5 | `AUTO_PAPER_RUNNING`状态下用户点击"暂停"：`engineState`变为`AUTO_PAPER_PAUSED`，之后构造满足自动开仓十四项条件的场景，断言`tickAutoEngine`不产生新开仓（CEO"暂停状态不交易"） |
| T44.6 | `AUTO_PAPER_PAUSED`状态下，构造已有`OPEN`持仓触及止损的场景，断言`scanClosedBarsForExits`仍正常触发止损（验证§16.1"暂停不停止已有仓位保护"设计判断） |
| T44.7 | `riskRegime`变为`DAILY_LOSS_LOCKED`或`FORCED_OBSERVATION`时，`engineState`自动变为`AUTO_PAPER_RISK_LOCKED`；日亏损次日UTC解锁后（且未同时触发总回撤锁定）`engineState`自动回到`AUTO_PAPER_RUNNING` |
| T44.8 | `decision.dataHealth!=='normal'`时，`engineState`变为`AUTO_PAPER_DATA_BLOCKED`，`preDataBlockedState`正确记录进入前状态（分别构造从`RUNNING`/`PAUSED`/`RISK_LOCKED`进入的三种场景）；数据恢复后`engineState`正确回退到`preDataBlockedState`记录的值 |
| T44.9 | 任意非`AUTO_PAPER_OFF`状态下用户点击"关闭自动模拟交易"（二次确认+`idempotencyKey`）：`engineState`变为`AUTO_PAPER_OFF` |
| T44.10 | `allowNewEntries=false`（用户点击"禁止新开仓"）时，`engineState`仍显示`AUTO_PAPER_RUNNING`（不因此变为`PAUSED`），但自动开仓/加仓判定被拒绝，已有仓位自动止损/止盈继续正常工作 |

## T45. 自动开仓十四项条件（对应SPEC §16.2，draft-4新增）

| 用例 | 断言 |
|---|---|
| T45.1 | 构造十四项条件全部满足的fixture，断言`autoEngineOpenPosition`成功产生`status:'OPEN'`的`PaperTrade`，`linkedSignalId`等于对应`signalId`（CEO"V1.1许可触发自动开仓"） |
| T45.2 | **红线**：扫描自动开仓十四项条件判定表达式源码，断言不引用`forecast.m15`/`forecast.h1`/`forecast.h4`/`weights`/`directionLabel`等V1.2字段（CEO"V1.2不能单独开仓"，同draft-2 T18.2先例） |
| T45.3 | 构造forecast全部为"偏多"高权重但`decision.worthBetting===false`的fixture，断言仍不产生自动开仓 |
| T45.4 | 同一个`signalId`成功开仓后，即使其余十三项条件依然满足，再次调用`autoEngineOpenPosition`（同一`signalId`）断言拒绝，不产生第二笔`PaperTrade`（CEO"同一signalId不重复开仓"，条件13） |
| T45.5 | 多头场景全流程：条件1-14全部满足→自动开仓成功，`side==='BUY'`，`fills`长度为1且`fillType==='OPEN'`（CEO"自动多单"） |
| T45.6 | 空头场景对称验证（CEO"自动空单"） |
| T45.7 | 逐条构造条件2/3/5/7/8/9/14单独不满足的反例，断言均拒绝且不产生`PaperTrade` |
| T45.8 | 构造`account.riskRegime==='DAILY_LOSS_LOCKED'`的场景，断言拒绝（CEO"日亏损锁定"，条件10） |
| T45.9 | 构造`account.riskRegime==='FORCED_OBSERVATION'`的场景，断言拒绝（CEO"总回撤锁定"，条件11） |
| T45.10 | 构造`decision.dataHealth!=='normal'`的场景，断言拒绝（CEO"数据陈旧禁止新交易"，条件7） |
| T45.11 | 构造已存在一笔非终态`PaperTrade`（另一signalId）的场景，断言新的自动开仓判定拒绝（CEO隐含"当前没有冲突仓位"，条件12） |
| T45.12 | 条件4（`signalId`存在且未过期）：构造对应`signal`已过`validUntil`的场景，断言拒绝 |
| T45.13 | 条件6：构造该signal尚处于`WAITING_TRIGGER`（未完成`TRIGGERED`转换）的场景，断言不产生自动开仓 |

## T46. 自动止损/止盈（复用SPEC §6.6-§6.10既有机制，验证无需点击即可自动触发）

| 用例 | 断言 |
|---|---|
| T46.1 | 持仓`OPEN`后，构造收盘K线`low<=currentStop`（多头），断言`scanClosedBarsForExits`在下一次`tickAutoEngine`内自动产生`STOP_LOSS`成交，无需任何用户操作（CEO"自动止损"） |
| T46.2 | 依次构造触及`targets[0]`/`targets[1]`/`targets[2]`的收盘K线，断言50%/30%/清空剩余的分批止盈自动依次触发（CEO"自动50/30/20止盈"），公式与draft-2 §6.10逐项一致 |
| T46.3 | 同一根K线同时触及止损与目标（多头`low<=currentStop && high>=targets[0]`），断言只产生`STOP_LOSS`（CEO"同K线冲突采用不利结果"，同draft-2 §6.7红线） |
| T46.4 | 跳空止损：构造`bar.open<currentStop`（多头），断言成交基准价为`bar.open`而非`currentStop`本身（CEO"跳空止损"，同draft-2 §6.8红线） |

## T47. 自动加仓（复用SPEC §5.2，验证自动触发，draft-4新增用例，公式本身已由draft-2 T6/T7覆盖）

| 用例 | 断言 |
|---|---|
| T47.1 | 构造§5.2条件1-7全部满足的持仓，断言`autoEngineAddOn`在下一次`tickAutoEngine`内自动执行，无需用户点击，`addOnCount`变为1（CEO"自动浮盈加仓一次"） |
| T47.2 | 构造`unrealizedPnl<=0`的持仓，断言自动加仓判定不触发（CEO"亏损禁止加仓"） |
| T47.3 | 构造加仓后`worstCaseLoss>equity×maxRiskPct`的场景，断言自动加仓判定不触发（CEO"加仓后风险超过1%时禁止"） |
| T47.4 | 已加仓过一次（`addOnCount===1`）的持仓，断言后续tick不再触发第二次自动加仓（复用draft-2 T7.5结论） |

## T48. 反向信号与冷却期（对应SPEC §16.4，draft-4新增）

| 用例 | 断言 |
|---|---|
| T48.1 | 持仓多头`OPEN`期间出现空头候选`signal`（十四项条件均满足）：断言同一次`tickAutoEngine`内不产生反向自动开仓，原多头仓位继续按既有止损/止盈规则运行（CEO"反向信号不立即反手"） |
| T48.2 | 原多头仓位触发止损`EXITED`后，`lastPositionClosedAt`/`lastPositionClosedDirection`/`lastPositionClosedBarOpenTime`正确更新 |
| T48.3 | 平仓后紧接着（同一根K线或下一根K线开盘前）出现反向空头信号，断言`checkReverseSignalCooldown`拒绝（`sourceConfirmedBarTime`未晚于`lastPositionClosedBarOpenTime`），要求至少等待下一根已收盘15分钟K线（CEO"平仓后等待下一根收盘K线"） |
| T48.4 | 冷却期满足（反向信号的`sourceConfirmedBarTime`晚于`lastPositionClosedBarOpenTime`）后，断言反向信号仍需重新通过完整十四项条件判定（构造此时该反向信号已过期/已被十四项条件其中一条拒绝的场景，断言依然不开仓） |
| T48.5 | 同方向新信号（与`lastPositionClosedDirection`相同）不受本节冷却期约束，仅受§16.2条件12"当前无冲突仓位"约束——构造场景验证同方向信号在原仓位平仓后可以立即（不受冷却期限制）重新开仓 |

## T49. 紧急模拟平仓（对应SPEC §16.6，draft-4新增，公式复用draft-2既有滑点/手续费规则）

| 用例 | 断言 |
|---|---|
| T49.1 | 任意非终态`PaperTrade`存在时，用户点击"紧急模拟平仓"立即触发，无需满足§16.2任何条件（CEO"紧急模拟平仓"） |
| T49.2 | `trade.status`为`OPEN`/`PARTIALLY_CLOSED`时，`emergencyClosePosition`按当前`markPrice`+§4.4常规不利滑点成交，`estimated===false`、`verified===true` |
| T49.3 | `trade.status==='UNRESOLVED_DATA_GAP'`时，`emergencyClosePosition`自动切换为§8.5保守结算成交规则，`estimated===true`、`verified===false`（同T24结论） |
| T49.4 | `emergencyClosePosition`未提供`idempotencyKey`时拒绝执行 |

## T50. 浏览器运行限制、心跳与离线回放（对应SPEC §16.7，draft-4新增）

| 用例 | 断言 |
|---|---|
| T50.1 | 每次`tickAutoEngine`成功执行后，`lastEngineHeartbeat`更新为当前时间，`lastProcessedBarTime`更新为本次处理的最新`confirmedBar.openTime` |
| T50.2 | 构造"应用重新加载，`lastProcessedBarTime`落后当前可获取的最新`confirmedBar`若干根"的场景，断言`replayEngineOfflineGap`按§8.3规则逐根回放，止损/目标/失效/离场按时间顺序正确触发（CEO"页面恢复后K线回放"） |
| T50.3 | 回放期间同K线冲突采用更不利结果、跳空止损采用首个可获得的不利价格——直接复用draft-2 §6.7/§6.8既有断言集，验证回放路径与实时路径调用同一套撮合函数 |
| T50.4 | 离线时长超过可回补窗口（`fetchAllTimeframeKlines`固定窗口大小）时，断言`dataGap.gapCause==='ENGINE_OFFLINE'`且`status`变为`UNRESOLVED_DATA_GAP`，不伪造中断期间的精确成交顺序 |
| T50.5 | UI数据层面同时暴露`lastEngineHeartbeat`本地时间展示、离线时长（`Date.now()-lastEngineHeartbeat`）、回放状态三项（CEO"心跳过期提示"，测试环境验证数据层面具备这三项信息，不要求真实渲染DOM） |
| T50.6 | 构造`lastEngineHeartbeat`距今超过`TF_MS['15m']`的场景，断言系统能够识别"引擎曾经离线过"这一状态（用于驱动UI提示），即使当前已恢复心跳 |

## T51. 幂等与重复保护（对应SPEC §16.8，draft-4新增）

| 用例 | 断言 |
|---|---|
| T51.1 | 同一`signalId`触发条件在同一根K线内被处理两次（模拟REST返回重复数据/页面重复刷新），断言`autoEngineOpenPosition`的`AUTO-OPEN-${signalId}`幂等key生效，不产生第二笔`PaperTrade`（CEO"重复刷新不重复成交"） |
| T51.2 | 同一`tradeId`同一`barOpenTime`同一`fillType`的自动止损/止盈成交被重复处理（模拟同一根K线重复扫描），断言`AUTO-EXIT-${tradeId}-${barOpenTime}-${fillType}`幂等key生效，不重复扣费 |
| T51.3 | 数据缺口回放期间"重新遇到"实时阶段已经处理过的同一根K线，断言回放幂等key（`AUTO-REPLAY-...`）与实时幂等key构造方式一致，落到同一个key，不产生重复成交 |
| T51.4 | 用户对"暂停"/"恢复"/"禁止新开仓"/"紧急模拟平仓"按钮的同一次点击在网络抖动下触发多次底层调用，断言UI生成的同一个随机`idempotencyKey`保证只执行一次 |
| T51.5 | **红线**：同一个`signalId`最多建立一次主交易，由`AUTO-OPEN-${signalId}`幂等key与§16.2条件13共同保证——构造条件13判定层面存在竞态（例如两次并发tick同时通过条件13检查）的极端场景，断言幂等key仍能在执行层拦截，不产生第二笔`PaperTrade` |

## T52. 与建议档案、影子验证的隔离与关联（对应SPEC §16.6，draft-4更新）

| 用例 | 断言 |
|---|---|
| T52.1 | 构造一笔完整的自动开仓+止损/止盈全流程，运行前后对比该signal的`ShadowResult`（影子验证独立计算结果）与`PaperTrade`的真实`fills`/`realizedPnl`，断言两者数值可能不同（因为影子验证使用`entryZone.estimatedEntry`而实际成交使用市场撮合价），且互不覆盖（CEO"自动账户与影子验证隔离"） |
| T52.2 | 扫描`v1_3-auto-engine-core.js`全部导出函数源码，断言不存在对`ethAlphaShadowResults`的写操作（只读引用） |
| T52.3 | 自动开仓成功后，`SignalSnapshot`原始记录（`ethAlphaSignalArchive`中的那条）逐字节不变，加仓/止损/止盈等后续`PaperTrade`状态变化同样不回写`SignalSnapshot`任何字段（CEO"自动账户结果也不得回写修改原始SignalSnapshot"） |
| T52.4 | 完整覆盖`userActionStatus`五个`AUTO_*`新枚举值的产生场景（`AUTO_EXECUTED`/`AUTO_BLOCKED_BY_RISK`/`AUTO_BLOCKED_BY_POSITION`/`AUTO_MISSED_ENGINE_OFF`/`AUTO_MISSED_DATA_GAP`），逐一构造触发条件并断言映射正确（同T39.2-T39.4） |

## T53. 自动动作审计日志（对应CEO"所有自动动作产生审计日志"）

| 用例 | 断言 |
|---|---|
| T53.1 | 每一次`engineState`变化（含`AUTO_PAPER_ARMED→AUTO_PAPER_RUNNING`的自动转换）均在`ethAlphaPaperLog`写入一条`ENGINE_STATE_CHANGE`记录 |
| T53.2 | 每一次自动开仓/自动加仓均写入对应`AUTO_OPEN`/`AUTO_ADDON`审计记录，含`signalId`/`tradeId`/触发条件快照 |
| T53.3 | 每一次引擎离线/回放事件写入`ENGINE_HEARTBEAT_GAP`审计记录 |
| T53.4 | 审计日志记录不可被后续操作删除或修改（追加式，同draft-2`ethAlphaPaperLog`既有约束） |

## T54. UI字段规范（对应SPEC §16.9）

| 用例 | 断言 |
|---|---|
| T54.1 | "500 USDT真实行情自动模拟交易"区域必须显示SPEC §16.9列出的全部字段（测试环境下验证数据层面具备这些字段，不要求真实渲染DOM，对齐既有T8.6/T50.5模式） |
| T54.2 | 常驻文案"使用真实市场行情自动进行虚拟交易，不发送真实订单。页面关闭或电脑休眠时不会实时运行。"必须与净值/盈亏数字同屏出现 |
| T54.3 | "下一自动动作"字段：无有效候选时展示"暂无"，有候选时展示`buildTradeProposal`当前tick的只读结果 |

## T55. 废弃函数不存在性校验（对应`V1_3_PAPER_TRADING_SPEC.md`§17扫描记录的可测试化）

| 用例 | 断言 |
|---|---|
| T55.1 | 扫描`v1_3-paper-trading-core.js`导出列表，断言不存在`autoOpenPosition`/`autoAddOn`/`confirmReduce`/`confirmConservativeSettlement`四个已废弃导出 |
| T55.2 | 扫描`v1_3-signal-archive-core.js`导出列表，断言不存在`markSignalRejected` |
| T55.3 | 扫描`PositionStatus`可能取值，断言不存在`PENDING_ENTRY`/`CANCELLED`/`BLOCKED`三个已撤销状态 |
| T55.4 | 扫描`userActionStatus`可能取值，断言不存在`ACCEPTED`/`REJECTED`两个已撤销值 |

## T56. Schema迁移（对应SPEC §16.11新增字段）

| 用例 | 断言 |
|---|---|
| T56.1 | 构造`schemaVersion==='v1.3-account-2'`（draft-2/draft-3旧版）的历史数据，断言`migratePaperAccount`正确迁移到`v1.3-account-3`：`AutoEngineState`全部字段按默认值补齐（`engineState='AUTO_PAPER_OFF'`，`allowNewEntries=true`，心跳/冷却期字段为`null`） |
| T56.2 | 历史`PaperTrade`记录（draft-2/draft-3阶段产生，若存在）迁移后`linkedSignalId`补`null` |
| T56.3 | 历史`dataGap`记录迁移后`gapCause`补`'MARKET_DATA_INVALID'` |

## T57. V1.1/V1.2/V1.3既有测试回归（红线，追加于draft-3 T43，不允许更改被测文件本身）

必须在draft-3 T43既有命令基础上，额外重新执行以下命令，全部保持通过，**不得修改**这些测试文件的既有内容：

```
node tests/v13-signal-archive-tests.js
node tests/v13-signal-archive-ui-tests.js
node tests/v13-signal-archive-live-rest-test.js
node work/build-v1.js   # 构建产物逐字节可复现，新增的/*__AUTO_ENGINE_UI__*//*__AUTO_ENGINE__*/占位符不破坏既有全部占位符替换
```

---

## 测试类别数量汇总

| 类别 | 用例组数 |
|---|---:|
| T1 账户初始化与会计恒等式 | 10 |
| T2 多单开仓/止损/止盈 | 6 |
| T3 空单开仓/止损/止盈 | 5 |
| T4 手续费与双向滑点 | 4 |
| T5 部分止盈/移动止损/成本保本位 | 5 |
| T6 浮盈后加仓 | 7 |
| T7 禁止加仓场景 | 9 |
| T8 当日亏损3%锁定（UTC+确定性回退） | 6 |
| T9 总回撤10%强制观察（peakEquity） | 5 |
| T10 数据陈旧禁止成交 | 3 |
| T11 幂等键防重复操作 | 6 |
| T12 同K线止盈止损冲突 | 3 |
| T13 跳空止损 | 4 |
| T14 JSON损坏恢复与Schema迁移 | 5 |
| T15 导出安全 | 4 |
| T16 账户重置二次确认 | 4 |
| T17 V1.1硬性否决不可绕过 | 3 |
| T18 V1.2预测不能单独开仓 | 3 |
| T19 建仓快照冻结 | 3 |
| T20 精度与最小名义价值 | 3 |
| T21 状态机全转换覆盖（含UNRESOLVED_DATA_GAP） | 3 |
| T22 数据缺口成功回放 | 3 |
| T23 数据缺口无法回补时不伪造成交 | 4 |
| T24 用户确认保守结算 | 4 |
| T25 estimated交易排除于验证统计 | 3 |
| T26 风险预算恒以当前净值为基准 | 3 |
| T27 V1.1/V1.2回归（既有测试文件重跑，不计入新增用例数） | 10个既有命令 |
| **draft-2新增用例组合计（T1-T26）** | **118** |
| T28 建议档案自动创建 | 5 |
| T29 建议不进入正式档案的排除场景 | 7 |
| T30 signalFingerprint去重与版本规则 | 6 |
| T31 建议快照不可变性 | 5 |
| T32 建议生命周期状态机全转换覆盖 | 4 |
| T33 影子撮合规则（进场区/同K线冲突/跳空） | 8 |
| T34 未触发过期与触发前失效 | 5 |
| T35 目标1/2/3与止损结果判定 | 3 |
| T36 MFE/MAE与毛R/净R计算 | 5 |
| T37 影子验证数据缺口 | 4 |
| T38 影子验证与模拟账户资金隔离 | 4 |
| T39 用户行为关联与执行对比 | 5 |
| T40 准确度统计口径与分组（分母规则） | 11 |
| T41 存储/迁移/损坏恢复/容量/导出安全 | 7 |
| T42 清空建议历史二次确认且不触碰模拟账户 | 4 |
| **draft-3新增用例组合计（T28-T42）** | **83** |
| T43 V1.1/V1.2/V1.3既有回归（追加于T27，不计入新增用例数） | 4个既有命令 |
| **累计用例组合计（T1-T42）** | **201** |
| T44 引擎宏观状态机 | 10 |
| T45 自动开仓十四项条件 | 13 |
| T46 自动止损/止盈 | 4 |
| T47 自动加仓 | 4 |
| T48 反向信号与冷却期 | 5 |
| T49 紧急模拟平仓 | 4 |
| T50 浏览器运行限制、心跳与离线回放 | 6 |
| T51 幂等与重复保护 | 5 |
| T52 与建议档案/影子验证的隔离与关联 | 4 |
| T53 自动动作审计日志 | 4 |
| T54 UI字段规范 | 3 |
| T55 废弃函数不存在性校验 | 4 |
| T56 Schema迁移 | 3 |
| **draft-4新增用例组合计（T44-T56）** | **69** |
| T57 V1.1/V1.2/V1.3既有回归（追加于T43，不计入新增用例数） | 4个既有命令 |
| **累计用例组合计（T1-T56）** | **270** |

（draft-1为85条，draft-2新增/扩展33条（T1-T26合计118条），主要来自：T1/T5/T6/T7/T8/T9/T11/T14/T15/T16细化，以及全新的T22-T26；draft-3新增83条（T28-T42），对应SPEC §15「建议档案与影子验证」，累计201条；draft-4新增69条（T44-T56），对应SPEC §16「真实行情自动模拟交易引擎」，累计270条。"用例组"指本文档表格中的一行，实际实现时单个用例组可能展开为多条`assert`。回归命令（T27/T43/T57）不计入用例组数量，是对既有测试文件的重新执行要求。）
