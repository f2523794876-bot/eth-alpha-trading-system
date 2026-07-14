# V1_3_ACCEPTANCE_TESTS.md — V1.3「模拟交易账户」验收测试规范

版本：v1.3-draft-2（随 `V1_3_PAPER_TRADING_SPEC.md` v1.3-draft-2 同步，对应CEO七项决策+三项统一规则）
依据：`V1_3_PAPER_TRADING_SPEC.md`（每条用例都标注对应章节）。所有测试**必须用构造好的合成K线/合成决策/合成预测对象跑**，不能只靠人工打开页面观察——沿用 `ACCEPTANCE_TESTS.md`/`V1_2_ACCEPTANCE_TESTS.md` 已确立的"合成数据优先"原则。

**fixture真实性红线**：所有涉及 `decision`/`forecast`/`marketData` 字段的测试fixture，字段名和取值格式必须与 `v1-core.js buildDecision()`/`v1_2-forecast-core.js buildForecast()` 的真实返回结构逐字段一致。**禁止**测试自造一套近似结构让测试通过而生产代码实际收到的数据形状不同。

**字段命名红线（draft-2相对draft-1的重命名，测试断言必须使用新字段名）**：`equityHighWaterMark`→`peakEquity`；`availableCash`（=`cash-marginUsed`）→`availableBalance`（=**`equity-marginUsed`**，公式本身也变了，不只是改名）；`realizedPnlTotal`→`realizedPnlGross`；`slippageCostTotal`→`slippageCostReport`。任何测试如果沿用旧字段名或旧公式，视为未同步CEO决策，必须修正。

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
| T2.2 | `confirmOpenPosition` 成功后产生 `status:'OPEN'` 的 `PaperTrade`，`fills`长度为1且`fillType==='OPEN'`、`side==='BUY'` |
| T2.3 | 开仓成交价 = `referencePrice × (1 + spreadRate/2 + slippageRate)` |
| T2.4 | 构造收盘K线 `low <= currentStop` 触发止损，产生 `fillType==='STOP_LOSS'`、`side==='SELL'` 的成交，`status`变为`EXITED` |
| T2.5 | 构造收盘K线 `high >= targets[0]` 触发止盈，`status`变为`PARTIALLY_CLOSED`，剩余`quantity`为原始的50% |
| T2.6 | `realizedPnl = (exitFillPrice - entryPrice) × closedQuantity`（Gross口径，不扣手续费），逐条成交独立验证 |

## T3. 空单开仓/止损/止盈（与T2完全对称）

| 用例 | 断言 |
|---|---|
| T3.1 | `decision.biasDirection==='short'` 场景下`buildTradeProposal`/`confirmOpenPosition`全流程，`side==='SELL'`（开仓） |
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
| T6.1 | 全部前提（浮盈+V1.1许可有效+`signalPermission.addOnAllowed`+止损已达保本位+`addOnCount===0`+统一止损口径下`worstCaseLoss<=equity×maxRiskPct`+提供`idempotencyKey`）同时满足时，`confirmAddOn`成功，产生`fillType==='ADD_ON'` |
| T6.2 | 加仓后 `entryPrice` 按§4.3加权平均公式更新，`quantity`增加，`addOnCount`变为1 |
| T6.3 | 加仓不产生`realizedPnlDelta`（`ADD_ON`类型成交的`realizedPnlDelta===0`） |
| T6.4 | 构造`currentStop`恰好等于`calcBreakevenStop`计算值的边界场景，断言允许加仓（边界值本身合法，不是要求严格大于） |
| T6.5 | 构造加仓后`worstCaseLoss`恰好等于`equity×maxRiskPct`的边界场景，断言允许加仓（边界值合法） |
| T6.6 | 构造加仓后`worstCaseLoss`略微超过`equity×maxRiskPct`（例如多算0.01 USDT）的场景，断言拒绝，且拒绝原因文案包含具体超出的金额数字 |
| T6.7 | `confirmAddOn`未提供`idempotencyKey`或提供空字符串时拒绝执行（红线：不存在无幂等键的加仓路径） |

## T7. 禁止加仓的各类场景（逐条前提条件单独构造反例）

| 用例 | 断言 |
|---|---|
| T7.1 | `unrealizedPnl<=0`（含=0边界）时拒绝加仓，理由文案包含"浮盈"字样，且**不**输出任何"补仓/摊平"措辞 |
| T7.2 | `decision.biasDirection !== position.direction` 时拒绝 |
| T7.3 | `opportunityScores.blocked===true` 时拒绝，即使`decision.worthBetting`字段本身可能仍为true也必须拒绝 |
| T7.4 | `signalPermission.addOnAllowed===false`（非full_aligned）时拒绝 |
| T7.5 | **第二次加仓被明确阻止**：构造`addOnCount===1`（已成功加仓过一次）的持仓，再次调用`confirmAddOn`，断言拒绝，理由文案明确"V1.3每笔交易最多允许1次加仓"，且不产生任何新的`PaperFill` |
| T7.6 | **未移动到成本保本位时禁止加仓**：构造`currentStop`仍等于`initialStop`（尚未触发过`targets[0]`分批止盈、止损从未移动）的持仓，即使`unrealizedPnl>0`且其余条件都满足，断言`confirmAddOn`仍然拒绝，理由文案明确提及"止损尚未移动到保本位" |
| T7.7 | 构造`currentStop`已经移动但**低于**（多单）/**高于**（空单）`calcBreakevenStop`计算值的场景（即移动了但移动幅度不够，仍不足以真正保本），断言拒绝 |
| T7.8 | `addOnQuantity > initialQuantity` 时拒绝 |
| T7.9 | 全文扫描`confirmAddOn`所有拒绝路径的文案，断言不出现"摊平"以外的禁止词 |

## T8. 当日亏损3%锁定（对应SPEC §5.3，CEO决策第8项）

| 用例 | 断言 |
|---|---|
| T8.1 | 构造当日累计`realizedPnlDelta`使`dailyRealizedLoss >= dailyStartEquity × dailyLossLimitPct`，账户`riskRegime`变为`DAILY_LOSS_LOCKED` |
| T8.2 | `DAILY_LOSS_LOCKED`状态下`buildTradeProposal`/`confirmAddOn`均返回拒绝，但`confirmReduce`/`confirmClose`（含止损止盈自动触发）仍正常工作 |
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
| T10.1 | `decision.dataHealth!=='normal'`时，`buildTradeProposal`/`confirmAddOn`拒绝 |
| T10.2 | `decision.dataHealth!=='normal'`时，用户仍可对`OPEN`/`PARTIALLY_CLOSED`（非`UNRESOLVED_DATA_GAP`）持仓执行`confirmReduce`/`confirmClose`，但返回结果/UI标记须包含"陈旧数据"提示字样 |
| T10.3 | `decision.dataHealth!=='normal'`期间，`scanClosedBarsForExits`不产生新的自动止损/止盈成交 |

## T11. 幂等键防重复操作（对应SPEC §6.11，CEO决策第10项，覆盖五种操作）

| 用例 | 断言 |
|---|---|
| T11.1 | 用同一个`idempotencyKey`连续两次调用`confirmOpenPosition`，第二次调用**不产生**第二笔`PaperTrade`/`PaperFill`，而是返回与第一次完全相同的结果（真正的幂等重放，不是简单报错） |
| T11.2 | 用同一个`idempotencyKey`连续两次调用`confirmAddOn`，验证同上（不重复加仓，返回原结果） |
| T11.3 | 用同一个`idempotencyKey`连续两次调用`confirmReduce`/`confirmClose`，验证不产生重复成交 |
| T11.4 | 用同一个`idempotencyKey`连续两次调用`resetPaperAccount`，验证`resetCount`只增加1次（不是2次），第二次调用返回与第一次相同的账户状态 |
| T11.5 | 模拟"并发"调用（同一tick内连续调用两次任意确认函数，不同`idempotencyKey`），`account.actionLock`机制阻止真正意义上的重入，断言最终状态变化次数与传入的不同key数一致（即锁不会误伤合法的不同操作） |
| T11.6 | `TradeProposal`过期（`Date.now() > expiresAt`）后调用`confirmOpenPosition`（即使`idempotencyKey`是全新的）必须拒绝，要求重新生成方案 |

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
| T17.2 | 已有持仓场景下，`decision.opportunityScores.blocked`变为true后，`confirmAddOn`必须拒绝 |
| T17.3 | `decision.isManual===true`时，`buildTradeProposal`必须拒绝，理由文案明确提及"手动观察模式" |

## T18. V1.2预测不能单独触发模拟开仓（对应SPEC §7.1）

| 用例 | 断言 |
|---|---|
| T18.1 | 构造`forecast.m15/h1/h4`全部为"偏多"高权重、高置信度，但`decision.worthBetting===false`（或`opportunityScores.blocked===true`）的fixture，断言`buildTradeProposal`仍然拒绝 |
| T18.2 | 扫描`buildTradeProposal`/`confirmOpenPosition`/`confirmAddOn`函数体源码，断言不引用`forecast.m15`/`forecast.h1`/`forecast.h4`/`weights`/`directionLabel`等V1.2字段作为条件判断依据 |
| T18.3 | `forecastSnapshot`允许为`null`时，若`decision`本身满足开仓条件，`buildTradeProposal`/`confirmOpenPosition`依然可以正常工作 |

## T19. 建仓快照冻结不可被后续刷新覆盖（对应SPEC §7.2）

| 用例 | 断言 |
|---|---|
| T19.1 | 开仓后修改原始传入的`decision`对象某字段，断言`trade.decisionSnapshot`不受影响 |
| T19.2 | 同样验证`forecastSnapshot`不受后续`forecast`对象变化影响 |
| T19.3 | 构造模拟"v1-core.js风格原地修改"的fixture，确认`confirmOpenPosition`在赋值之后才做深拷贝仍能拿到正确的最终值 |

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
| T21.3 | `UNRESOLVED_DATA_GAP`状态下调用`confirmAddOn`/`confirmReduce`/`confirmClose`（非`confirmConservativeSettlement`）一律拒绝，断言状态不变 |

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
| T23.4 | `UNRESOLVED_DATA_GAP`状态下`confirmAddOn`/`confirmReduce`/`confirmClose`全部拒绝，只有`confirmConservativeSettlement`可用 |

## T24. 用户确认保守结算（对应SPEC §8.5，CEO决策第6项）

| 用例 | 断言 |
|---|---|
| T24.1 | `confirmConservativeSettlement`只能由显式调用触发，不存在任何自动触发路径（源码扫描：该函数不出现在`scanClosedBarsForExits`/定时器回调内部） |
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
| **新增用例组合计（T1-T26）** | **118** |

（draft-1为85条，draft-2新增/扩展33条，主要来自：T1/T5/T6/T7/T8/T9/T11/T14/T15/T16细化，以及全新的T22-T26。"用例组"指本文档表格中的一行，实际实现时单个用例组可能展开为多条`assert`。）
