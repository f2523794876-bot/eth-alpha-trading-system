# V1_2_ACCEPTANCE_TESTS.md — V1.2「走势预测层」验收测试规范

版本：v1.2-draft-3（随 `V1_2_FORECAST_SPEC.md` v1.2-draft-3 同步修订；新增blocked审计、固定checksum、构建失配与V1.2真实REST生产链验收）
依据：`V1_2_FORECAST_SPEC.md`（每条用例都标注对应章节）。所有测试**必须用构造好的合成K线/合成快照数据跑**，不能只靠人工打开页面观察——沿用 `ACCEPTANCE_TESTS.md` 已确立的"合成数据优先"原则（PROJECT_AUDIT.md 已证明实盘验证会漏掉关键分支）。

**fixture真实性红线（呼应问题3/12，T28专门测试本条）**：所有涉及 `marketData`/`failed`/`succeeded` 字段的用例，字段名和取值格式必须与 `v1-core.js` `fetchAllTimeframeKlines()` 的真实返回结构逐字节一致（`{eth:{tf15m,tf1h,tf4h},btc:{tf15m,tf1h,tf4h},partial,succeeded,failed}`，`failed`/`succeeded` 内的字符串格式固定为 `asset+'.'+key`，如 `'btc.tf4h'`）。**禁止**测试自造一套近似结构（如用 `ethTf`/`btcTf` 命名、或用 `'btc-tf4h'` 连字符格式）让测试通过而生产代码实际收到的数据形状不同。

**测试实现方式**：新增 `tests/v12-forecast-tests.js`（因子/权重/区间/路径/失效/置信度/日志的纯逻辑测试）与 `tests/v12-ui-tests.js`（读取 `eth-dynamic-trading-dashboard.html` 字符串，断言新DOM结构与中文枚举覆盖），两个文件均沿用现有 `node:assert/strict` + 手写 `test(name,fn)` 跑分器风格（与 `tests/v1-tests.js` 等既有文件一致），互相独立可用 `node tests/v12-forecast-tests.js` / `node tests/v12-ui-tests.js` 单独运行，最终输出 `RESULT passed=N failed=0`。

**运行命令汇总**：
```sh
node tests/v1-tests.js
node tests/v11-tests.js
node tests/audit-fixes-tests.js
node tests/v11-ui-tests.js
node tests/third-review-tests.js
node tests/v12-forecast-tests.js
node tests/v12-ui-tests.js
```
（`live-rest-test.js` 为网络冒烟测试，不计入下方用例数，运行方式不变。）

**用例总数与已有V1.1测试的关系**：本文档定义的用例（T1-T31，明细见下）目标不少于 **150 项**自动化断言，全部落在两个新文件中；`v1-tests.js`/`v11-tests.js`/`audit-fixes-tests.js`/`v11-ui-tests.js`/`third-review-tests.js` 原有 **101 项**用例保持逐字节不变，不新增、不删除、不修改其中任何一条断言（T18 是对这一条本身的元测试）。

---

## T1. 明确多头结构 [对应需求9.1]

**构造**：`marketData.eth.tf4h`/`tf1h`/`tf15m` 原始K线使 `ethSnap.tf4h`/`tf1h`/`tf15m` 均为 EMA5>EMA10>EMA20 排列，`confirmedPrice>ema20`，`trend='up'`；`decision.state='BULL_CONFIRMATION'`，`decision.mtfState`/`htfState` 均为多头对应态；`btcAlignment(bias, btcSnap[对应周期])` 返回 `'support'`；成交量 `ratio>=1.2`、`sustained=true`、`takerBuyRatio>=0.55`；无假突破风险（该horizon自己的 `falseBreakoutTier==='none'`）。

| 用例 | 断言 |
|---|---|
| T1.1 | `h4.directionLabel==='偏多'` 且 `weights.bullish` 为三者最大值 |
| T1.2 | `h1.directionLabel==='偏多'` |
| T1.3 | `m15.directionLabel==='偏多'` |
| T1.4 | 三个horizon的 `supportingEvidence` 均非空，且至少包含1条 `structure*`/`trend4h` 类因子的证据文本 |
| T1.5 | `scenarioTargets.bullishZone` 非null，且 `bullishZone[0] < bullishZone[1]` |

---

## T2. 明确空头结构 [对应需求9.2]

**构造**：与T1对称（EMA空头排列、`trend='down'`、`state='BEAR_CONTINUATION'`、`btcAlignment='support'`（对空头方向支持）、量能确认）。

| 用例 | 断言 |
|---|---|
| T2.1 | 三个horizon `directionLabel==='偏空'` |
| T2.2 | `weights.bearish` 均为三者最大值 |
| T2.3 | `scenarioTargets.bearishZone` 非null 且下界<上界 |
| T2.4 | `mostLikelyPath.id` 不为 `'INSUFFICIENT_DATA'` |

---

## T3. 区间震荡 [对应需求9.3]

**构造**：三周期 `trend='flat'`，`state='RANGE_CHOP'`，价格在 `recentHigh20`/`recentLow20` 中段（区间位置40%-60%），ATR处于收缩区间（`atr14<atrPrev*0.85`）。

| 用例 | 断言 |
|---|---|
| T3.1 | 三个horizon `directionLabel==='震荡'` |
| T3.2 | `mostLikelyPath.id==='RANGE_ROUND_TRIP'` |
| T3.3 | `scenarioTargets.rangingZone` 等于该horizon的 `priceRange.[lower,upper]` |

---

## T4. 多周期方向冲突 [对应需求9.4]

**构造**：`ethSnap.tf4h.trend='up'`，`decision.mtfState` 判定偏空态，`decision.state` 判定震荡态——三者互不相同。

| 用例 | 断言 |
|---|---|
| T4.1 | 因子 `timeframeAgreementProxy` 的 `status==='ok'` 且 `range===1`（三者互不相同时全部导向震荡桶，见spec§4.1第12行）；术语明确为规则一致性代理，不是统计准确率 |
| T4.2 | 至少有一个horizon的 `directionLabel` 为 `'不确定'` 或 `'震荡'`（不应出现"三周期冲突却仍给出高置信度单一方向"的情况） |
| T4.3 | 该horizon的 `confidence.score` 明显低于T1.1同条件下（agreementFactor分量拖低总分） |

---

## T5. BTC反向 [对应需求9.5]

**构造**：ETH 4H呈多头结构，但BTC 4H `trend='down'`，`btcAlignment(bias,btc4h)` 返回 `'conflict'`。

| 用例 | 断言 |
|---|---|
| T5.1 | 因子 `btcAlignmentOwnTf` 在4h horizon下 `status==='ok'`，`range>=0.7`（conflict按spec§4.1第9行分配），中文标签为“BTC对应周期联动” |
| T5.2 | `h4.weights.bullish` 相比"BTC支持"场景（T1.1）明显更低 |
| T5.3 | `h4.opposingEvidence` 中包含提及BTC冲突的证据文本 |

---

## T6. 假突破确认失败 [对应需求9.6]

**构造**：15m出现突破（`isBreakout=true`），但 `falseBreakoutTier==='confirmation_failed'`。

| 用例 | 断言 |
|---|---|
| T6.1 | 因子 `falseBreakoutRisk` 的 `range===1`（原方向失效，见spec§4.1第10行） |
| T6.2 | `m15.mostLikelyPath.id` 不为 `'BREAKOUT_THEN_PULLBACK'`（因为该路径要求 `falseBreakoutTier!=='confirmation_failed'`） |
| T6.3 | `m15.invalidation` 中包含 `id==='INVALID_VOLUME_FAIL'` 的条目（若mostLikelyPath依赖突破确认） |

---

## T7. 成交量不足 [对应需求9.7]

**构造**：其余条件同T1（多头结构），但 `volumeQuality.ratio<1.2` 或 `sustained=false`。

| 用例 | 断言 |
|---|---|
| T7.1 | 因子 `volumeQuality` 的 `range===1`（未确认量能不给方向加分，见spec§4.1第8行） |
| T7.2 | 该horizon的 `weights.bullish` 相比T1同条件下明显更低（因子8从多头桶移到震荡桶） |

---

## T8. ATR异常扩大 [对应需求9.8]

**构造**：`atr14 > atrPrev*1.15`，且同周期状态机方向为多头。

| 用例 | 断言 |
|---|---|
| T8.1 | 因子 `atrState` 的 `bull===1`（扩张+多头方向，见spec§4.1第6行） |
| T8.2 | `priceRange` 半径（`upper-lower`）相比ATR正常场景明显更宽（因为半径直接用 `atr14×k`，spec§6.1） |
| T8.3 | `priceRange.basis` 中包含具体的 `atr14` 数值字符串 |

---

## T9. 数据陈旧 [对应需求9.9]

**构造**：`AnalyzedSnapshot.dataQuality.isStale===true`（`now - lastCloseTime > staleLimit`）。

| 用例 | 断言 |
|---|---|
| T9.1 | 该horizon `directionLabel==='数据不足'`（spec§5.2第5条硬性门槛） |
| T9.2 | `weights===null`，`priceRange===null`，`invalidation===[]` |
| T9.3 | `suppressedReason` 非null 且提及"陈旧" |

---

## T10. 数据缺失（单周期冒烟用例，完整6-key矩阵见T21）[对应需求9.10，P0问题3已订正]

**构造**：`marketData.failed` 包含该horizon对应的ETH或BTC周期标识，**必须**使用 `fetchAllTimeframeKlines()` 真实格式 `'btc.tf4h'`（`asset+'.'+key`），**禁止**使用 draft-1 中不存在的 `'btc-tf4h'` 连字符格式。

| 用例 | 断言 |
|---|---|
| T10.1 | `marketData.failed=['btc.tf4h']` 时，4h horizon `directionLabel==='数据不足'`（spec§10.4强制规则，优先于普通因子级missing处理） |
| T10.2 | `suppressedReason` 中明确写出缺失的周期名 `'btc.tf4h'` |
| T10.3 | 未受影响的其他horizon（15m/1h，其依赖的周期数据完整）不应被连带降级 |
| T10.4 | 对源码字符串扫描，确认不出现 `'btc-tf4h'`/`'eth-tf4h'` 等连字符格式的字面量（防止实现残留draft-1的错误示例） |

---

## T11. 手动观察模式 [对应需求9.11]

**构造**：`decision.isManual===true`。

| 用例 | 断言 |
|---|---|
| T11.1 | `ForecastOutput.m15/h1/h4` 全部为 `null` |
| T11.2 | `suppressedReason` 明确写"手动观察模式" |
| T11.3 | `executability.worthBetting===false` |
| T11.4 | 调用 `buildForecastLogEntry`/`saveForecastLog` 路径不应产生日志写入（对照V1.1 `isManual` 不写决策日志的规则） |

---

## T12. 成功刷新后API失败（P0问题11已重写：删除"dataAsOf必须不同"的错误断言）[对应需求9.12]

**订正说明**：draft-1 断言"API失败后 `dataAsOf` 必须不同于 `prevForecast`"，但API失败时最后一根已收盘K线的时间戳完全可能与上一次成功刷新时相同（例如两次刷新间隔内没有新K线收盘），该断言在真实场景下会产生误报，**已删除**。draft-2 改为验证真正的红线：受影响horizon被正确标记为数据不足、所有方向类字段被清空、不复用旧对象引用、UI旧预测被清空或明确标记失效、并且这条路径必须在真实DOM事件链路上验证（不能只测纯函数）。

**构造（纯函数部分，T12.1-T12.5）**：先用一次正常的 `marketData`/`decision` 调用 `buildForecast` 得到 `prevForecast`（非null的正常预测），再模拟下一次刷新 `marketData.partial===true`（部分周期失败，`failed` 用真实key格式）调用 `buildForecast(marketData2, decision2, prevForecast, now2)`。

| 用例 | 断言 |
|---|---|
| T12.1 | 受影响horizon的新结果 `directionLabel==='数据不足'`；`weights`/`priceRange`/`scenarioTargets`/`mostLikelyPath`/`confidence` 全部为 `null`；`invalidation===[]`（spec§10.2红线："不能保留旧预测冒充当前预测"） |
| T12.2 | 新结果**不是** `prevForecast` 对象本身（`newForecast!==prevForecast`），新结果的受影响horizon对象**不是** `prevForecast` 对应horizon对象的同一引用（`newForecast.h4!==prevForecast.h4`，用 `!==` 判等，而不是比较 `dataAsOf` 数值） |
| T12.3 | `suppressedReason` 列出**真实**失败的周期名（与构造时传入的 `marketData.failed` 逐一对应，格式为 `'btc.tf4h'` 这类真实key，不是笼统的"数据异常"） |
| T12.4 | 未受影响的horizon（若其依赖周期完整）保持正常输出，不因为其他horizon失败而被清空 |
| T12.5 | `dataAsOf` 允许与 `prevForecast` 对应horizon相同（当两次刷新之间没有新K线收盘时，这是合法情况，**不作为**失败判定依据——本条即draft-1错误断言的直接反例，用相同 `dataAsOf` 的构造数据验证T12.1-T12.3依然成立） |

**构造（真实DOM事件路径部分，T12.6-T12.9，呼应问题11第7点"不能只测纯函数"，与T29共用同一套DOM harness）**：加载 `eth-dynamic-trading-dashboard.html`（jsdom或等价方式），依次触发：①一次成功的 `refresh()`（`v11decision`正常派发，预测面板正常渲染）→②一次 `cache.partial===true` 的失败刷新（`refresh()` 内部 `throw`，`v11decision`当次不触发）→③再一次成功的 `refresh()`。

| 用例 | 断言 |
|---|---|
| T12.6 | 步骤①后，`forecast15m`/`forecast1h`/`forecast4h` DOM区域显示正常预测内容（非空、非"失效"文案） |
| T12.7 | 步骤②后（`v11decision`未触发），`window.invalidateDashboard` 的包装函数必须已执行，`forecast15m`/`forecast1h`/`forecast4h` 三个DOM区域被清空或加上明确的"预测已失效，等待下次成功刷新"标记，**不得**继续显示步骤①遗留的方向/权重/区间数字 |
| T12.8 | 步骤②后，`window.__prevForecast===null`（不是继续持有步骤①产出的对象） |
| T12.9 | 步骤③后，预测面板重新正常渲染，且渲染内容对应步骤③的新数据（不是步骤①的残留） |

---

## T13. 未收盘价格剧烈波动但confirmedPrice不变 [对应需求9.13]

**构造**：同一份 `marketData.eth`/`marketData.btc` 原始K线，仅修改未收盘的最后一根K线 `close`（模拟盘中价格剧烈跳动），保持已收盘K线（决定 `confirmedPrice`）不变，其余字段不变，调用两次 `buildForecast`。

| 用例 | 断言 |
|---|---|
| T13.1 | 两次调用的 `directionLabel`、`weights`、`priceRange.lower/upper`、`mostLikelyPath` **完全相同**（因为所有正式判定只应使用 `confirmedPrice`） |
| T13.2 | 若UI层展示"当前价"或距离提示，允许该数值不同（未收盘价仅用于展示，spec§0），但本用例聚焦纯逻辑层，UI展示差异不在此文件断言范围（由T19 UI测试单独覆盖） |

---

## T14. 因子比例与三类权重总和合法性（P0问题2修复验证 + P1问题12.5要求，已扩展）[对应需求9.14]

**构造**：随机/边界组合生成至少20组不同的因子结果集合（部分因子missing、部分因子极端值0/1、全部因子ok等），对每组分别跑三个horizon的 `computeDirectionWeights`。

| 用例 | 断言 |
|---|---|
| T14.1 | 只要 `weights!==null`，`weights.bullish+weights.bearish+weights.ranging===100` 对全部20+组合恒成立（spec§5.3） |
| T14.2 | `FACTOR_WEIGHTS['15m']`/`['1h']`/`['4h']` 三个对象的 `Object.values(...).reduce((a,b)=>a+b,0)===100` |
| T14.3 | 舍入边界用例（构造 `rawBull/rawBear/rawRange` 恰好导致舍入冲突的输入）验证 `ranging` 的强制补齐+溢出扣除逻辑不产生负数 |
| T14.4 | **（问题2/12.5核心新增，不能只测最终三类权重和为100）**：对全部12项因子函数逐一构造能触发其每个分支的输入，断言每次返回值 `status==='ok'` 时 `Math.abs(bull+bear+range-1)<1e-9`；因子2/因子3的 `TRANSITION_WATCH` 分支必须覆盖 `transitionWatchSplit` 的全部3个子分支（`confirmedPrice>ema20`/`<ema20`/`相等或数据不足`），每个子分支单独断言和为1 |
| T14.5 | `status==='missing'` 时 `bull===0 && bear===0 && range===0 && points.bull===0 && points.bear===0 && points.range===0`（spec§3 `ForecastFactorResult` 不变量），对12项因子的missing分支逐一构造 |
| T14.6 | 对T1-T13所有构造场景，遍历生成的 `HorizonForecast.factors` 数组，断言其中所有数值字段（`bull`/`bear`/`range`/`weightMax`/`points.bull`/`points.bear`/`points.range`）均为 `Number.isFinite` 为真（呼应问题12.5"所有数值finite"），`weights.bullish`/`bearish`/`ranging`（非null时）同样finite |

---

## T15. 价格区间与情景目标合法性（P1问题8已扩展为8类fixture）[对应需求9.15]

**构造**：覆盖正常、结构位收紧、结构位冲突回退（spec§6.2倒挂保护）三种场景，覆盖三个horizon；另加下表8类专项fixture（问题8列出的完整覆盖要求）。

**基础用例**：

| 用例 | 断言 |
|---|---|
| T15.1 | 任意合法输出中 `priceRange.lower < priceRange.upper`（无一例外，包括回退分支） |
| T15.2 | `priceRange.lower < confirmedPrice < priceRange.upper` |
| T15.3 | 结构位冲突场景下，`basis` 数组包含"已回退至ATR区间"字样 |
| T15.4 | `scenarioTargets.bullishZone`/`bearishZone` 若非null，各自的两个数值也满足前者<后者 |

**8类专项fixture（问题8逐条落地，每类至少1个测试，覆盖§6/§7全部分支）**：

| 用例 | fixture | 断言 |
|---|---|---|
| T15.5 | 价格已突破第一压力（`isBreakout=true`，`confirmedPrice`已高于原 `firstResistance`） | `bullishZone` 两端均 `>confirmedPrice`；`upper` 收紧逻辑改用 `secondResistance`（若有效）而非已被越过的 `firstResistance`；`basis` 注明"已突破，改用secondResistance" |
| T15.6 | 价格已跌破第一支撑（`isBreakdown=true`，对称场景） | `bearishZone` 两端均 `<confirmedPrice`；同理改用 `secondSupport` |
| T15.7 | 第一/第二区域重复（`firstResistance`与`secondResistance`价格相同或`resolveLevels`返回同一簇） | `isValidZone` 对二者的处理不产生 `upper===lower` 的零宽区间；最终 `priceRange`/`scenarioTargets` 仍满足最小宽度检查 |
| T15.8 | 区域顺序颠倒（构造 `secondResistance.lower < firstResistance.lower`，异常输入） | 实现必须以 `isValidZone`+显式比较筛选，不假设数组天然有序；不产生非法（倒挂）输出，触发时回退至ATR外推 |
| T15.9 | 单边区域缺失（如压力侧 `isValidZone(r0,...)===false` 但支撑侧有效） | 上界收紧步骤跳过（保留ATR外推上界），下界正常收紧；不因单边缺失导致整个区间失败 |
| T15.10 | ATR为0/null/NaN（3个子用例） | 该horizon直接判定"数据不足"（spec§5.2条件6），`priceRange`/`scenarioTargets` 均为 `null`，**不进入**§6/§7的计算逻辑（不产生除以0或NaN传播的区间） |
| T15.11 | 目标落在确认价错误方向（构造一个半宽极大的zone，其边界越过 `confirmedPrice`） | `isValidZone` 判定为false，该zone不被使用，最终 `bullishZone`/`bearishZone` 不包含任何越过 `confirmedPrice` 方向的数值（用T7.3的不变量断言覆盖：多头两端>price，空头两端<price） |
| T15.12 | 结构回退ATR（`firstResistance`/`firstSupport`均判定无效，或`isBreakout`且无有效`secondResistance`） | 最终使用纯ATR外推（`confirmedPrice±atr14×1.5/2.5`），`basis`/评论明确说明改用ATR外推，不静默虚构结构依据（问题8第8点） |

---

## T16. 不输出未经校准的"真实概率"或"胜率" [对应需求9.16]

| 用例 | 断言 |
|---|---|
| T16.1 | 对 `v1_2-forecast-core.js` 源码字符串做正则扫描，不匹配 `/真实概率/、/真实胜率/、/胜率\s*\d/、/概率\s*\d+%/、/必涨/、/必跌/、/稳赚/、/保证盈利/` |
| T16.2 | 对 `eth-dynamic-trading-dashboard.html` 新增DOM部分（第4个`<script>`块及其新增HTML区块）做同样的正则扫描 |
| T16.3 | 任意构造输入下，`ForecastOutput` 及其嵌套对象的**字段名**中不出现 `probability`/`winRate`/`realProbability` 等暗示已校准概率的命名（只允许 `calibratedProbability` 这一个显式标注V2占位、且值恒为 `null` 的字段） |
| T16.4 | 任意构造输入下，`calibratedProbability` 字段值恒为 `null`（V1.2禁止对其赋任何非null值） |
| T16.5 | `HorizonForecast.disclaimer` 恒等于常量字符串 `'规则型权重，尚未经过历史胜率校准'`，且在 `weights!==null` 时该字段不可省略 |

---

## T17. 预测日志字段完整（P1问题10已扩展：完整schema + 版本号 + 可复现性）[对应需求9.17]

| 用例 | 断言 |
|---|---|
| T17.1 | `buildForecastLogEntry(forecast, horizonForecast, '1h')` 返回对象包含 spec§12 定义的**全部**字段，包括 `status`/`blocked`/`blockReasons`/`algorithmVersion`/`weightVersion`；`calibratedProbability`恒为null |
| T17.2 | `outcomeAfter1Bar`/`outcomeAfter4Bars`/`outcomeAfter16Bars`/`brierScoreComponent`/`directionAccuracy`/`rangeCoverage`/`calibrationBucket`/`calibratedProbability` 在V1.2生成的条目中恒为 `null`（V1.2不做回填） |
| T17.3 | 手动模式下调用 `saveForecastLog` 不写入任何 `localStorage` 记录（与V1.1决策日志规则一致） |
| T17.4 | `saveForecastLog` 使用的 `localStorage` key 为 `ethAlphaForecastLogs`，与V1.1现有的 `ethAlphaDecisionLogs`/`ethAlphaDecisionLogsV11` 均不同（防止存储互相覆盖） |
| T17.5 | 数据不足、陈旧、关键周期缺失、预测失败或过期均写blocked审计；方向、权重、区间、目标、路径、置信度为null或空集合，不能沿用旧预测 |
| T17.5 | `closedKlineRef` 只包含引用信息（`symbol`/`timeframe`/`lastClosedOpenTime`），不包含完整K线数组（防止日志体积失控），且长度恒为6（ETH+BTC×三周期） |
| T17.6 | `directionLabel==='数据不足'` 的horizon**仍然**产出日志条目（`factorResults`如实记录missing因子，`directionWeights`/`priceRange`等为null），不得因为没有方向结论就跳过写入（spec§12.3） |
| T17.7 | `factorResults` 长度恒为12，且每一项包含 `id`/`status`/`bull`/`bear`/`range`/`weightMax`/`points`/`evidenceText` 全部字段；用该日志条目独立重算一遍 §5.1-§5.3（不调用被测代码本身，而是测试脚本自行按spec公式重算），得到的 `directionWeights` 必须与日志中记录的完全一致（这是"可复现性"的直接验证，防止 `factorResults` 记录了却对不上最终权重） |
| T17.8 | `schemaVersion`/`forecastAlgorithmVersion`/`factorWeightVersion` 均为非空字符串，且与 `v1_2-forecast-core.js` 导出的同名常量值相等（防止日志里硬编码了与代码不同步的版本号） |
| T17.9 | `closedKlineRef` 中每条记录的 `lastClosedOpenTime` 与生成该条日志时对应快照最后一根已收盘K线的 `openTime` 相等（防止引用信息本身就是错的，反查不到真实K线） |

---

## T18. 不影响现有101项V1.1自动测试 [对应需求9.18]

| 用例 | 断言 |
|---|---|
| T18.1 | 依次运行 `node tests/v1-tests.js`（38项）、`node tests/v11-tests.js`（17项）、`node tests/audit-fixes-tests.js`（15项）、`node tests/v11-ui-tests.js`（12项）、`node tests/third-review-tests.js`（11项），各自 `RESULT` 行的 `passed` 数值与 `TEST_RESULTS.md` 记录的原值逐一相等，`failed=0` |
| T18.2 | 对这5个文件分别做 `git diff` 检查，V1.2实现分支相对 `v1.1.0` 的这5个文件应为空diff（本用例作为CI/人工检查项记录，不一定能在纯Node断言中自动化，需在 `V1_2_ARCHITECTURE_REVIEW.md` 的验收清单中人工核对一次） |
| T18.3 | `v1-core.js` 相对 `v1.1.0` 的 `git diff` 为空 |

---

## T19. UI结构与中文枚举覆盖（`tests/v12-ui-tests.js`）

| 用例 | 断言 |
|---|---|
| T19.1 | `eth-dynamic-trading-dashboard.html` 中存在 `forecast15m`/`forecast1h`/`forecast4h`/`forecastDisclaimer`/`forecastBlocked`/`forecastBetting` 全部DOM id |
| T19.2 | 页面新增的可见静态文本（非`<script>`/`<style>`内）中不出现英文枚举值原文（如 `PULLBACK_THEN_UP`、`INSUFFICIENT_DATA` 等裸露），需有对应中文映射覆盖，比照 `tests/v11-ui-tests.js` 已有断言风格 |
| T19.3 | 页面新增的 `<script>` 块数量为1个（合计变为4个），且不包含 `<script src=...>` 外部引用 |
| T19.4 | `forecastDisclaimer` 对应DOM文本恒含"规则型权重，尚未经过历史胜率校准" |
| T19.5 | 现有V1.1的既有DOM id（`price`/`state`/`worth`/`score`/`htf`/`mtf`/`ltf`/`advice`/`entry`/`addon`/`stop`/`targets`/`rr`/`falseBreakout`/`dragonZone`/`volume`/`supports`/`resistances`/`exits`/`scoreItems`/`warnings`/`health`/`updated` 等）全部依旧存在且未被移动出原有父级结构 |

---

## T20. 模块边界与纯函数性（元测试，防止实现偷懒违反spec§11.1/§15）

| 用例 | 断言 |
|---|---|
| T20.1 | `v1_2-forecast-core.js` 源码字符串不包含 `document.`/`window.` 直接访问（UMD导出行本身允许出现 `root.ETHAlphaForecast=api` 这一行例外，测试需精确排除该行再扫描） |
| T20.2 | `v1_2-forecast-core.js` 不包含对 Binance API URL（`api.binance.com`）的字符串引用（预测层不自己发起网络请求，spec§禁止事项4） |
| T20.3 | `v1_2-forecast-core.js` 不包含任何形如 `fetch(`/`XMLHttpRequest`/`WebSocket` 的调用 |
| T20.4 | `v1_2-forecast-core.js` 不包含任何 API Key/Secret 相关字符串（如 `apiKey`/`secret`/`private_key`，防止未来误引入） |

---

## T21. 生产结构真实failed-key完整矩阵（P0问题3完整覆盖）[对应CEO复审问题3]

**构造**：直接用与 `fetchAllTimeframeKlines()` 真实返回值同构的 `marketData` 对象（`{eth:{tf15m,tf1h,tf4h},btc:{tf15m,tf1h,tf4h},partial:true,succeeded:[...],failed:[...]}`），`failed` 数组逐一使用6个真实key中的1个，其余5个周期数据正常。

| 用例 | 断言 |
|---|---|
| T21.1 | `failed=['eth.tf15m']` → 仅15m horizon降级为"数据不足"，1h/4h正常 |
| T21.2 | `failed=['eth.tf1h']` → 仅1h horizon降级，15m/4h正常 |
| T21.3 | `failed=['eth.tf4h']` → 仅4h horizon降级，15m/1h正常 |
| T21.4 | `failed=['btc.tf15m']` → 仅15m horizon降级，1h/4h正常 |
| T21.5 | `failed=['btc.tf1h']` → 仅1h horizon降级，15m/4h正常 |
| T21.6 | `failed=['btc.tf4h']` → 仅4h horizon降级，15m/1h正常 |
| T21.7 | 本节全部6个用例**禁止**通过测试自造的另一套key（如数字索引、驼峰命名）绕过生产路径判定逻辑——测试代码本身对 `marketData` 的构造函数与T1等其余用例共用同一个fixture builder，该builder的字段名与 `v1-core.js` 源码逐字核对（元测试，防止出现"两套fixture，一套给测试用一套是生产真实形状"的分裂） |

---

## T22. 三周期假突破风险独立计算（P1问题4）[对应CEO复审问题4]

**构造**：分别为15m/1h/4h三个周期独立构造能触发下列4种tier的快照组合，验证 `factorFalseBreakoutRisk`/`pickMostLikelyPath` 是**逐周期独立调用** `C.falseBreakoutTier(ethSnap[horizon], btcSnap[horizon])`，不是把15m结果复制给其他周期。

| 用例 | 场景 | 断言 |
|---|---|---|
| T22.1-3 | 突破成功（`tier==='none'`且有突破/跌破），分别在15m/1h/4h构造 | 该horizon因子10 `range===0`（原方向100%延续，见spec§4.1第10行"none且存在突破→原方向=1"） |
| T22.4-6 | `warning`，分别在15m/1h/4h构造 | 该horizon因子10 `range===0.5` 且原方向`===0.5` |
| T22.7-9 | `confirmation_failed`，分别在15m/1h/4h构造 | 该horizon因子10 `range===1`；`pickMostLikelyPath` 不会返回 `BREAKOUT_THEN_PULLBACK`/`BREAKDOWN_THEN_BOUNCE` |
| T22.10-12 | BTC不同步（ETH突破但BTC未同步突破/跌破），分别在15m/1h/4h构造 | 该horizon的tier因btcSync=false而倾向`confirmation_failed`（见`falseBreakoutTier`实现：`!btcSync&&bars<=1`分支），断言与ETH+BTC同步突破的对照组相比tier更差 |
| T22.13 | 构造15m/1h/4h三个周期tier**互不相同**的组合（如15m=none，1h=warning，4h=confirmation_failed） | 三个horizon各自的因子10结果互不相同，且15m的结果与 `decision.falseBreakoutTier` 一致（一致性断言），1h/4h**不等于**15m的结果（防止实现偷懒复制15m值） |

---

## T23. Swing结构五类情形（P1问题6）[对应CEO复审问题6，spec§4.4]

| 用例 | 场景 | 断言 |
|---|---|---|
| T23.1 | 只有高点降低但低点抬高（`swingHighs`降序、`swingLows`升序，双边均≥2个点） | `status==='ok'`，`range===1` |
| T23.2 | 只有低点降低但高点抬高（对称混合） | `status==='ok'`，`range===1` |
| T23.3 | 单边Swing缺失（`swingHighs.length<2`，`swingLows.length>=2`） | `status==='missing'`（不因低点数据充分就判定为有效震荡） |
| T23.3b | 单边Swing缺失（`swingLows.length<2`，`swingHighs.length>=2`，对称） | `status==='missing'` |
| T23.4 | 完整多头（双边均≥2个点，最近两个swing high抬高且最近两个swing low抬高） | `status==='ok'`，`bull===1` |
| T23.5 | 完整空头（双边均≥2个点，两者都降低） | `status==='ok'`，`bear===1` |
| T23.6 | 双边均为0个点（彻底无swing数据） | `status==='missing'`（`0<2`同样触发missing条件） |

---

## T24. 成交量方向规则五档阈值 + 分周期独立计算（P1问题5）[对应CEO复审问题5]

**构造**：分别为15m/1h/4h构造各自独立的K线数据（不复用15m的量能给1h/4h）。

| 用例 | 场景 | 断言 |
|---|---|---|
| T24.1 | `ratio>=1.2 && sustained===true && takerBuyRatio>=0.55`，同周期方向为多 | `bull===1` |
| T24.2 | `ratio>=1.2 && sustained===true && takerBuyRatio<=0.45`，同周期方向为空 | `bear===1` |
| T24.3 | `ratio>=1.2 && sustained===true && takerBuyRatio===0.50`（中性区间） | `range===1` |
| T24.4 | `ratio<1.2`（未放量，即使`sustained===true`且`takerBuyRatio`极端） | `range===1` |
| T24.5 | `sustained===false`（即使`ratio>=1.2`且`takerBuyRatio`极端） | `range===1` |
| T24.6 | `takerBuyRatio===null`（`last.volume===0`导致无法计算） | `status==='missing'`（明确按missing处理，不做保守方向猜测，spec问题5红线） |
| T24.7 | `calcVolumeQuality` 返回 `label==='unavailable'`（K线不足） | `status==='missing'` |
| T24.8 | 15m/1h/4h三个周期分别构造**不同**的volume fixture（一个多头确认、一个空头确认、一个missing） | 三个horizon因子8结果互不相同，验证确实各自独立调用 `C.calcVolumeQuality(marketData.eth[对应tf], ...)`，不是15m结果被复制3份 |

---

## T25. 支撑压力距离双边校验（P1问题7）[对应CEO复审问题7，spec§6.0]

| 用例 | 场景 | 断言 |
|---|---|---|
| T25.1 | 压力侧`isValidZone`为false（zone越过confirmedPrice），支撑侧正常 | `status==='missing'`（不再是draft-1"两者都为null才missing"的几乎不可能触发条件） |
| T25.2 | 支撑侧`isValidZone`为false，压力侧正常（对称） | `status==='missing'` |
| T25.3 | 两侧均有效，距压力更近（`<0.4×距支撑`） | `bear===0.6, range===0.4` |
| T25.4 | 两侧均有效，距支撑更近 | `bull===0.6, range===0.4` |
| T25.5 | `atr14`为`null`/`NaN`/`0` | `status==='missing'` |
| T25.6 | 两侧zone均有效但价格居中（都不满足`<0.4×`条件） | `range===1` |

---

## T26. "预计区间"措辞红线正则扫描（P1问题9）[对应CEO复审问题9，spec§6.4/§10.8]

| 用例 | 断言 |
|---|---|
| T26.1 | 对 `v1_2-forecast-core.js` 源码字符串扫描，涉及 `PriceRangeEstimate`/`priceRange`/`basis` 生成逻辑的字符串常量中，出现"区间"相关表述时必须命中 `/规则型预计波动区间/` 或 `/ATR结构推演区间/` 之一 |
| T26.2 | 同一源码字符串扫描，**不匹配** `/置信区间/、/覆盖率\s*\d+%/、/有\s*\d+%\s*概率/、/统计显著/、/历史命中率\s*\d/` |
| T26.3 | 对 `eth-dynamic-trading-dashboard.html` 新增DOM部分做同样的正反两组正则扫描 |
| T26.4 | `HorizonForecast.confidence` 相关文案与 `priceRange` 相关文案不共用同一个数值来源（即 `confidence.score` 不等于任何暗示区间覆盖率的百分比字段），防止"置信度"与"区间准确率"被混为一谈 |

---

## T27. 生产接口端到端测试（P1问题12第1点）[对应CEO复审问题12.1]

**构造**：不经过任何简化fixture，从最底层开始构造原始K线数组（120根，含收盘/未收盘），走完整管线：

```
原始六路K线（构造） → C.fetchAllTimeframeKlines等价的marketData结构
  → C.buildDecision(marketData.eth, marketData.btc, null, {}, C.COST_DEFAULT) 得到 decision
  → ETHAlphaForecast.buildForecast(marketData, decision, null, now) 得到 forecast
  → buildForecastLogEntry(forecast, forecast.h1, '1h') 得到日志条目
  → renderForecast(forecast)（若在DOM环境中，写入真实DOM节点）
```

| 用例 | 断言 |
|---|---|
| T27.1 | 全链路无异常抛出，`forecast` 是合法 `ForecastOutput`（`m15`/`h1`/`h4` 均非 `undefined`） |
| T27.2 | `decision` 与 `forecast` 之间的关键字段一致性：`forecast.blockedByV11===decision.opportunityScores.blocked`，`forecast.executability.worthBetting===decision.worthBetting` |
| T27.3 | `forecast.h1.factors` 中因子1读到的 `ethSnap.tf4h.trend` 与直接调用 `C.analyzeKlines(marketData.eth.tf4h,'4h','ETH').trend` 逐字节相等（验证"只读派生，不改变V1.1决策结果"这一红线，spec§0） |
| T27.4 | DOM环境下（若可用），`renderForecast` 写入的DOM文本内容与 `forecast` 对象的字段值一致（如 `forecast15m` 区域文本包含 `m15.directionLabel`对应中文） |

---

## T28. Fixture真实性强制检查（P1问题12第2点，元测试）[对应CEO复审问题12.2]

| 用例 | 断言 |
|---|---|
| T28.1 | `tests/v12-forecast-tests.js`/`tests/v12-ui-tests.js` 全文搜索，不出现 `ethTf`/`btcTf`/`fetchMeta` 这类draft-1遗留但生产代码不存在的变量名/字段名 |
| T28.2 | 全文搜索，`marketData`/`decision` fixture 的字段名与真实 `fetchAllTimeframeKlines()`/`buildDecision()` 返回结构做过至少一次逐字段diff（可用一个公共的 `assertRealMarketDataShape(obj)` 断言辅助函数统一校验，本用例断言该辅助函数确实被T1-T27各用例调用而非形同虚设） |
| T28.3 | 全文搜索，不出现 `'btc-tf4h'`、`'eth-tf1h'` 等连字符格式的字符串字面量 |

---

## T29. ForecastOutput全数据类DOM成功→失败→恢复验证（P1问题12第3点，与T12后半部分共用DOM harness）[对应CEO复审问题12.3]

**构造**：同T12.6-T12.9的DOM harness，额外覆盖 `weights`/`priceRange`/`scenarioTargets`/`mostLikelyPath`/`invalidation`/`confidence`/`supportingEvidence`/`opposingEvidence` 全部数据类字段对应的DOM节点（不只测方向标签）。

| 用例 | 断言 |
|---|---|
| T29.1 | 成功态：全部数据类字段对应DOM节点均有非空、非"数据不足"占位的真实内容 |
| T29.2 | 失败态（`v11decision`未触发）：全部数据类字段对应DOM节点均被清空或标记失效，逐字段核对（不能只清空方向标签而权重/区间数字残留） |
| T29.3 | 恢复态：全部数据类字段对应DOM节点恢复为新数据，且新数据与恢复前的失败态/更早的成功态数值不同（用不同的构造输入验证不是"看起来正常但其实是旧DOM没刷新"） |

---

## T30. 过期计时清除测试（P1问题12第4点）[对应CEO复审问题12.4]

**构造**：生成一个 `HorizonForecast`（`validUntil=T0`），分别用 `now=T0-1`（未过期）、`now=T0+1`（刚过期）、`now=T0+3600000`（过期很久）三个时间点触发UI渲染。

| 用例 | 断言 |
|---|---|
| T30.1 | `now<validUntil` 时正常显示方向/权重/区间/目标 |
| T30.2 | `now>validUntil` 时，DOM中 `directionLabel`/`weights`/`priceRange`/`scenarioTargets`对应节点必须被清除或整体遮蔽（用一个统一的"已过期"容器replace，而不是在原数字旁边加一行小字提示） |
| T30.3 | 过期后**不能**出现"显示一行『已过期』但下方原方向/权重数字继续正常显示"这种半遮蔽状态——逐个检查这些字段对应的DOM节点，确认其 `textContent` 不再包含过期前的具体数值 |
| T30.4 | 过期状态与"数据不足"状态使用不同的提示文案（"预测已过期，等待刷新" vs `suppressedReason` 的具体原因），不得混淆两种不同成因 |

---

## T31. Bar单位定义一致性 + 日志版本号红线（P1问题10最后一点）[对应CEO复审问题10]

| 用例 | 断言 |
|---|---|
| T31.1 | 四份V1.2文档（本文档+SPEC+CODEX任务书+ARCHITECTURE_REVIEW）中出现"bar"定义的地方，全部一致地描述为"固定15分钟跨度"，不出现"以预测horizon自身周期为单位"这一互斥的另一种定义（人工/grep双重核对，见`V1_2_ARCHITECTURE_REVIEW.md`验收清单） |
| T31.2 | 对 `horizon='4h'` 的日志条目，`outcomeAfter1Bar`（值为null，但生成该字段的代码逻辑）对应的时间锚点是 `dataAsOf+15分钟`，**不是** `dataAsOf+4小时`（用注入mock的"当前时间"驱动一次假设性回填逻辑桩函数验证锚点计算正确，即使V1.2本身不实现真回填，也要验证字段的时间语义没有被写反） |
| T31.3 | 修改 `FACTOR_WEIGHTS` 中任意一个数值后（测试脚本临时mock），若未同步更新 `FACTOR_WEIGHT_VERSION`，则有一条断言专门检测"权重表校验和"与"记录在案的版本号校验和快照"不一致时测试**必须失败**（验证版本号红线不是摆设，而是真的会被测试网住——用一个记录当前 `FACTOR_WEIGHTS` 内容hash并与 `FACTOR_WEIGHT_VERSION` 绑定比对的机制实现） |
| T31.4 | 固定checksum与权重版本显式绑定，预期checksum不得由运行时权重对象生成；只改点数、版本或checksum任一项均失败，合法权重更新必须同步三者 |

### T32：V1.2真实REST正式生产链（独立于V1.1的8项REST冒烟）

执行 `node tests/v12-live-rest-test.js`，真实Binance数据必须依次经过 `fetchAllTimeframeKlines → buildDecision → buildForecast → 三个时窗 → buildForecastLogEntry/saveForecastLog`。分别断言三时窗生成、权重和100、`calibratedProbability=null`、区间目标有限且有序、三条日志写入、同`dataAsOf`去重、数据不足blocked审计不携带旧预测、手动模式不写日志。报告必须将V1.1真实REST数量与V1.2真实REST生产链数量分开列出。

### T33：构建替换失配保护

`work/build-v1.js` 每个目标与核心占位符必须校验精确出现次数。测试分别构造目标缺失、目标重复和正常单次匹配；前两者必须抛出“构建替换失配”并终止，正常匹配才允许生成HTML。

---

## draft-1 → draft-2 变更摘要（供 `V1_2_ARCHITECTURE_REVIEW.md` 交叉核对）

- T4 构造描述订正为 `ethSnap`（不是不存在的 `ethTf`）。
- T10 订正为真实key格式 `'btc.tf4h'`，完整6-key矩阵移至新增T21。
- T12 删除"dataAsOf必须不同"的错误断言，重写为对象引用不同+字段清空+真实DOM路径验证（T12.6-T12.9）。
- T14 新增因子级 `bull+bear+range===1` 断言（T14.4）、missing因子三项为0断言（T14.5）、全字段finite断言（T14.6）。
- T15 从4个基础用例扩展为12个用例，覆盖问题8列出的全部8类fixture。
- T17 从5个用例扩展为9个用例，覆盖完整日志schema、版本号、可复现性重算验证。
- 新增 T21（真实failed-key完整矩阵）、T22（假突破逐周期）、T23（Swing五类）、T24（成交量五档分周期）、T25（SR双边校验）、T26（措辞正则扫描）、T27（端到端生产管线）、T28（fixture真实性元测试）、T29（DOM全字段成功失败恢复）、T30（过期遮蔽）、T31（bar定义与版本号红线）。
- 用例数从约60项提升至150+项。
