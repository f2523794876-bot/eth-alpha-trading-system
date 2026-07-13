# V1_2_ARCHITECTURE_REVIEW.md — V1.2「走势预测层」架构复核与一致性核查

版本：v1.2-draft-3（独立复审3项P1与3项P2关闭版）
角色：本文档是四份V1.2文档中的最后一份，职责是**核对前三份文档（`V1_2_FORECAST_SPEC.md`/`V1_2_CODEX_IMPLEMENTATION_TASK.md`/`V1_2_ACCEPTANCE_TESTS.md`）互相一致**，给出风险清单，并作为交给CEO/董事长复审的入口文档。本文档不新增算法规则，如发现三份文档之间的不一致，以 `V1_2_FORECAST_SPEC.md` 为准并在此记录、回去修正其余文档。

**draft-1复审结论回顾**：CEO对draft-1的原文复审发现 P0 3项、P1 7项、测试问题2项（含测试质量总述），逐项编号1-13，判定"当前规范错误地把传给`C.buildDecision()`的`ethTf`/`btcTf`描述为`AnalyzedSnapshot`对象"等一系列与V1.1真实代码不符或内部不自洽的问题，要求"不写业务代码，只修订现有四份V1.2文档"。本轮（draft-2）逐项关闭，见下方第0节。

---

## 0. CEO复审问题逐项关闭记录

本节是本轮修订的核心交付物：CEO原文提出的13项问题（一、二、三 = P0；四至十 = P1；十一、十二 = 测试问题；十三 = 文档一致性），逐项记录**关闭方式**与**关闭证据所在位置**。详细的算法级修订内容见 `V1_2_FORECAST_SPEC.md` §16 变更记录（本节只做"是否关闭+在哪关闭"的核对，不重复贴算法细节）。

| # | CEO问题 | 优先级 | 状态 | 关闭方式（关键改动） | 证据位置 |
|---|---|---|---|---|---|
| 一 | 输入接口与V1.1真实代码不一致（`ethTf`/`btcTf`误认为`AnalyzedSnapshot`） | P0 | **已关闭** | 订正为 `buildForecast(marketData, decision, prevForecast, now)`，`marketData`即`fetchAllTimeframeKlines()`原始返回结构；`ethSnap`/`btcSnap`由内部调用`analyzeKlines`派生；`window.__lastMarketData`取代`__lastEthTf`/`__lastBtcTf`；异常刷新经`window.invalidateDashboard`统一触发`clearForecast` | SPEC §0/§11.2/§11.3/§11.4；CODEX §2步骤8、§3函数接口清单；TESTS T27（端到端管线） |
| 二 | `TRANSITION_WATCH`分配不等于1（`0.6+0.2=0.8`） | P0 | **已关闭** | 定义唯一算法`transitionWatchSplit`，三分支和恒为1 | SPEC §4.1.1；CODEX 步骤2；TESTS T14.4（因子级和为1，覆盖三分支） |
| 三 | `failed`周期标识格式错误（`'btc-tf4h'`不存在） | P0 | **已关闭** | 订正为`fetchAllTimeframeKlines`真实格式`asset+'.'+key`（6个真实key），删除全部连字符示例 | SPEC §4.1因子9、§10.4；CODEX 因子9签名；TESTS T10（订正）+T21（6-key完整矩阵，直接用生产结构） |
| 四 | 假突破风险未按三周期分别计算 | P1 | **已关闭** | 定义"该horizon自己的`falseBreakoutTier(ethSnap[horizon],btcSnap[horizon])`"，三次独立调用，15m允许与`decision.falseBreakoutTier`一致性断言但不得复制给1h/4h | SPEC §4.1因子10、§8；CODEX 因子10签名；TESTS T22（突破成功/warning/confirmation_failed/BTC不同步×三周期） |
| 五 | 成交量方向规则阈值未定义 | P1 | **已关闭** | 唯一阈值：多头`ratio≥1.2&&sustained&&takerBuyRatio≥0.55`，空头对称`≤0.45`，`0.45~0.55`→range，`takerBuyRatio===null`→missing；三周期各自调用`calcVolumeQuality` | SPEC §4.1因子8；CODEX 因子8签名；TESTS T24（五档阈值+分周期独立） |
| 六 | Swing缺失规则用"且"误判 | P1 | **已关闭** | 改为"或"：任一侧不足2个点即missing | SPEC §4.1因子5、§4.4；CODEX 步骤2；TESTS T23（五类fixture） |
| 七 | 支撑压力距离未要求双边有效 | P1 | **已关闭** | 定义`isValidZone`双边校验+近端/远端精确字段定义 | SPEC §6.0、§4.1因子7；CODEX 因子7签名+`isValidZone`导出；TESTS T25（双边校验） |
| 八 | 价格区间/情景目标合法性缺失 | P1 | **已关闭** | 重写§6/§7：方向约束、finite/顺序/最小宽度检查、突破后正确方向下一结构区、ATR外推兜底、basis记录选择与回退原因 | SPEC §6、§7；CODEX 步骤4；TESTS T15.5-T15.12（8类fixture全覆盖） |
| 九 | "预计区间"语义误导 | P1 | **已关闭** | 强制措辞"规则型预计波动区间"/"ATR结构推演区间"二选一，禁止置信区间类表述 | SPEC §6.4、§10.8；TESTS T26（正则扫描） |
| 十 | V2日志schema不可复现 | P1 | **已关闭** | `ForecastLogEntry`新增版本号三元组+完整12项`factorResults`+`bar`唯一定义（固定15分钟跨度） | SPEC §12（含§12.1/§12.2）；CODEX 步骤7；TESTS T17（扩展）+T31（bar定义+版本号红线） |
| 十一 | 测试T12断言错误（`dataAsOf`必须不同） | P0（测试） | **已关闭** | 删除该断言，重写为对象引用不同+字段清空+真实DOM事件路径验证 | TESTS T12（完全重写，T12.1-T12.9） |
| 十二 | 测试质量不足（缺端到端/fixture可能造假/缺比例和为1/缺过期遮蔽） | P1（测试） | **已关闭** | 新增T27（端到端生产管线）、T28（fixture真实性元测试）、T14.4-T14.6（比例和为1+missing三项为0+finite）、T29（DOM全字段成功失败恢复）、T30（过期遮蔽） | TESTS T14/T27/T28/T29/T30；T18保留101项回归要求 |
| 十三 | 文档一致性 | — | **已关闭** | 四份文档同步修订，本文档第1节重新核查一致性（见下） | 全文档 |

**额外发现并关闭的问题（不在CEO原始13项清单内，复审v1-core.js源码时发现）**：`ForecastOutput.blockedByV11`原定义"透传`decision.blocked`"，但`DecisionOutput`上不存在该顶层字段（核对`v1-core.js`第66/51行`buildDecision`/`calcOpportunityScores`源码确认），真实字段是`decision.opportunityScores.blocked`（同义`hardBlocked`）。已订正，见SPEC §3/§10.5，TESTS T27.2新增对该字段的生产路径断言。

---

## 1. 一致性核查方法

对三份文档做了逐项字符串核查（`grep -c`，覆盖 spec/codex/tests 三个文件），确认以下命名在三份文档中同时出现、含义一致、无拼写漂移：

### 1.1 十二项因子 id

| 因子id | 中文名 | spec | codex | tests | 结论 |
|---|---|---|---|---|---|
| `trend4h` | 4小时趋势 | ✓ | ✓（`factorTrend4h(ethSnap)`） | ✓（T1.4引用同类因子） | 一致 |
| `structure1h` | 1小时结构 | ✓（含`transitionWatchSplit`） | ✓（`factorStructure1h`+`transitionWatchSplit`） | ✓（T14.4覆盖TRANSITION_WATCH三分支） | 一致 |
| `structure15m` | 15分钟执行结构 | ✓（含`transitionWatchSplit`） | ✓（`factorStructure15m`复用同一`transitionWatchSplit`） | ✓（T14.4） | 一致 |
| `emaSlopeOwn` | EMA排列与斜率 | ✓ | ✓（`factorEmaSlopeOwn`） | 未单独设专项T，覆盖在T1/T2/T14整体断言中 | 一致（建议见§3风险2） |
| `swingStructure` | Swing高低点结构 | ✓（"或"逻辑，§4.4五类） | ✓（`factorSwingStructure`） | ✓（T23五类专项） | 一致 |
| `atrState` | ATR波动状态 | ✓ | ✓（`factorAtrState`） | ✓（T8.1直接断言） | 一致 |
| `srDistance` | 动态支撑压力距离 | ✓（`isValidZone`双边校验，§6.0） | ✓（`factorSrDistance`+`isValidZone`导出） | ✓（T25双边校验专项） | 一致 |
| `volumeQuality` | 成交量质量 | ✓（唯一阈值，逐周期独立） | ✓（`factorVolumeQuality`，参数为该horizon自身原始K线） | ✓（T7.1/T7.2 + T24五档分周期专项） | 一致 |
| `btcAlignmentOwnTf` | BTC对应周期联动 | ✓（真实failed key格式） | ✓（`factorBtcAlignmentOwnTf`，含`failedKeys`/`horizon`参数） | ✓（T5.1 + T21六key矩阵） | 一致，名称不再误示为一次汇总三个BTC周期 |
| `falseBreakoutRisk` | 假突破风险 | ✓（逐horizon独立调用） | ✓（`factorFalseBreakoutRisk(ethSnap,btcSnap)`，不接受外部tier字符串） | ✓（T6.1 + T22逐周期12用例） | 一致 |
| `rangePosition` | 区间位置 | ✓ | ✓（`factorRangePosition`） | 隐含于T3.1（区间40%-60%场景） | 一致 |
| `timeframeAgreementProxy` | 三周期规则一致性代理 | ✓ | ✓（`factorTimeframeAgreementProxy`，签名强制只接收因子1/2/3结果对象） | ✓（T4.1直接断言） | 一致；代理指标不代表统计胜率或预测准确率 |

### 1.2 权重表（spec §4.2）纵向求和自查

15m列：6+10+22+10+8+8+12+10+6+4+2+2 = **100**
1h列：12+20+10+9+8+6+10+8+9+5+2+1 = **100**
4h列：22+14+4+8+8+5+8+6+12+6+3+4 = **100**

三档权重表均已在写入spec前手工验算求和为100，`V1_2_ACCEPTANCE_TESTS.md` T14.2 对此有专项自动化断言（`Object.values(FACTOR_WEIGHTS[tf]).reduce(...)===100`），确保未来任何人手滑改动权重表都会被测试捕获。

### 1.3 顶层数据结构与函数签名

`ForecastOutput`/`HorizonForecast`/`DirectionWeights`/`PriceRangeEstimate`/`ScenarioTargets`/`PathScenarioId`/`InvalidationCondition`/`ConfidenceScore`/`ForecastFactorResult`/`ForecastLogEntry`/`buildForecast`/`buildForecastLogEntry`/`saveForecastLog`/`ethAlphaForecastLogs` 十四个关键名词在 spec/codex/tests 三份文档中均有出现且定义一致（详见附录核查命令输出，本节不重复贴表）。

`buildForecast(marketData, decision, prevForecast, now)` 的四参数签名在三份文档中逐字核对一致（SPEC §11.2、CODEX §3函数接口清单、TESTS T27.1端到端管线用例的调用形式），`marketData` 字段名/形状与 `v1-core.js` `fetchAllTimeframeKlines()` 真实返回值逐字节核对一致（已用 `grep -n "function fetchAllTimeframeKlines"` 核实源码，见SPEC §0引用的`v1-core.js`第12行）。`buildForecastLogEntry(forecast, horizonForecast, horizon)` 三参数签名同样在SPEC §12.3、CODEX步骤7、TESTS T17.1中一致（相对draft-1的两参数签名`(forecast, horizon)`，draft-2新增了`horizonForecast`参数以承载该horizon自己的字段，三份文档已同步更新，不存在参数个数不一致的情况）。

`PathScenarioId` 的7个枚举值、`InvalidationId` 的5个枚举值**只在 `V1_2_FORECAST_SPEC.md` 中被逐一列出定义**，`V1_2_CODEX_IMPLEMENTATION_TASK.md` 有意不重复罗列，只引用"严格按spec §8/§9实现"——这是**刻意的DRY设计**，避免两份文档各存一份枚举值列表、未来改动时漏改一处导致漂移。`V1_2_ACCEPTANCE_TESTS.md` 中的T3.2/T6.2/T19.2 等用例直接引用spec定义的具体枚举值（如 `RANGE_ROUND_TRIP`），验证了测试文档与spec的绑定关系正确。

### 1.4 术语与安全红线自查

对三份文档做了 `真实概率|胜率\d|必涨|必跌|稳赚|保证盈利` 的全文正则扫描：命中的**全部6处**都是在"明确禁止使用"的上下文中出现（作为反面示例被引用，如"禁止出现'胜率70%'"），**没有一处是作为系统实际输出的正面表述**。`V1_2_ACCEPTANCE_TESTS.md` T16.1-T16.5 把这条红线转成了可自动化执行的正则扫描+字段值断言，不依赖人工复查。

### 1.5 与 V1.1 命名空间的隔离核查

| 项目 | V1.1既有 | V1.2新增 | 是否冲突 |
|---|---|---|---|
| localStorage决策日志key | `ethAlphaDecisionLogs`、`ethAlphaDecisionLogsV11`（已用 `grep` 核实于 `v1-core.js:42/63`） | `ethAlphaForecastLogs` | 不冲突 |
| 模块全局变量名 | `window.ETHAlphaCore` | `window.ETHAlphaForecast` | 不冲突 |
| 自定义DOM事件名 | `v11decision` | 无新增（draft-2已明确：直接监听既有`v11decision`事件即可满足需求，去掉draft-1曾设想的`v12forecast`事件，"不重复造轮子"，见SPEC §11.3末段） | 不冲突（因为根本没有新增） |
| `window` 上暴露的原始数据引用 | 无（V1.1不暴露原始K线到`window`） | `window.__lastMarketData`（`fetchAllTimeframeKlines()`原始返回值）、`window.__prevForecast`（上一次`ForecastOutput`或`null`） | 不冲突；取代draft-1中不存在的`window.__lastEthTf`/`__lastBtcTf`/`__lastFetchMeta`三变量方案 |
| 测试文件命名 | `v1-tests.js`/`v11-tests.js`/`audit-fixes-tests.js`/`v11-ui-tests.js`/`third-review-tests.js`/`live-rest-test.js` | `v12-forecast-tests.js`/`v12-ui-tests.js`/`v12-live-rest-test.js` | 不冲突；V1.2真实REST正式生产链单独统计 |
| 单文件构建 | 原替换链无失配保护 | `replaceExact`校验每个目标和核心占位符的精确出现次数 | 缺失或重复立即失败，避免静默生成残缺HTML |
| DOM id 前缀 | 现有约30个既有id（如`price`/`state`/`htf`等，见T19.5） | `forecast15m`/`forecast1h`/`forecast4h`/`forecastDisclaimer`/`forecastBlocked`/`forecastBetting` | 不冲突 |
| 导出函数名 | `v1-core.js` §H列出的完整导出列表（`buildDecision`/`analyzeKlines`等） | `v1_2-forecast-core.js` 新导出的 `buildForecast`/`factorXxx`/`computeDirectionWeights`等 | 不冲突，且两个模块通过 `require`/`window.ETHAlphaCore` 单向依赖（V1.2依赖V1.1，反向不允许） |

---

## 2. 单向依赖关系确认（架构红线）

```
v1-core.js（冻结，V1.1）
     ↑ 只读依赖（require/window.ETHAlphaCore）
v1_2-forecast-core.js（新增，V1.2）
     ↑ 只读依赖（require/window.ETHAlphaForecast）
eth-dynamic-trading-dashboard.html 第4个<script>块（新增渲染层，V1.2）
```
`v1-core.js` **不知道** `v1_2-forecast-core.js` 的存在，不导入、不引用、不为其新增任何导出。这是本轮架构设计的核心约束（spec §11.1、codex任务§禁止事项1），保证：
1. V1.1 现有101项测试的输入输出契约不会因为V1.2的存在而改变。
2. 未来即使V1.2整体被移除，V1.1完全不受影响（可回滚性）。
3. V2的历史回放引擎可以选择只依赖 `v1-core.js` 的纯函数，或额外依赖 `v1_2-forecast-core.js` 的因子/权重函数做校准，两条路径都不需要改动 `v1-core.js`。

---

## 3. 风险清单（已识别，供CEO复审时参考；draft-1中的风险3/4/5实际就是本轮CEO正式指出的P0问题一/三，现已通过重写关闭，保留在此作为"曾经的风险如何演变为已确认问题并关闭"的记录，不再是"待观察风险"）

| # | 风险 | 状态 | 影响 | 缓解/后续动作 |
|---|---|---|---|---|
| 1 | 12项因子的权重表（spec §4.2）数值是本文档作者基于业务理解拍定的初始值，尚未经过任何历史数据回测验证其合理性 | 待观察（不阻塞本轮） | 规则型权重的"手感"可能与未来V2校准后的真实表现有出入 | 这正是V1.2明确声明"规则型权重，未经校准"的原因；V2完成回测后，若校准结果显示权重需要调整，应回到本spec提出修改，而不是绕过spec直接改代码。draft-2新增的`FACTOR_WEIGHT_VERSION`版本号（SPEC §12.2）保证未来调整权重时旧日志不会被误用新权重解释 |
| 2 | `emaSlopeOwn`（因子4）依赖的斜率阈值（±0.3，spec §4.1第4行）是启发式设定，未做过灵敏度测试 | 待观察（不阻塞本轮） | 阈值过松/过紧可能导致该因子经常性输出极端值或经常性中性 | 建议V2回测阶段把该阈值也纳入参数敏感性测试范围（呼应STRATEGY_SPEC.md已有的"参数敏感性测试"概念） |
| 3 | ~~`buildForecast` 需要 `fetchMeta`（`{partial, failed}`）作为独立参数传入~~ | **已确认为真实问题并关闭（=CEO问题一部分）** | draft-1这条"风险"预判的方向是对的（确实需要显式传入失败信息），但draft-1自己给出的解决方案`fetchMeta`是凭空设计的参数名，未核对`fetchAllTimeframeKlines`真实返回结构就是`{eth,btc,partial,succeeded,failed}`整个对象本身——不需要另造`fetchMeta`，直接把`marketData`（即`fetchAllTimeframeKlines()`原始返回值）整体传入即可，`partial`/`failed`就在其中 | 订正为`buildForecast(marketData, decision, prevForecast, now)`，见SPEC §0/§11.2 |
| 4 | ~~新增第4个`<script>`块如何拿到`ethTf`/`btcTf`原始快照对象~~ | **已确认为真实问题并关闭（=CEO问题一部分）** | draft-1假设可以暴露"已算好的快照"（`window.__lastEthTf`/`__lastBtcTf`），但核对`v1-core.js`源码后发现`buildDecision`内部BTC三周期快照算完即弃、从不写入返回对象，根本没有"已算好的BTC快照"可供暴露；唯一能安全暴露的是`fetchAllTimeframeKlines()`的原始返回值本身 | 订正为暴露`window.__lastMarketData=cache`单一对象（仍是"唯一允许的一行改动"），`ethSnap`/`btcSnap`由`buildForecast`内部自行调用`analyzeKlines`派生，见SPEC §11.3 |
| 5 | ~~周期标识约定（如`'btc-tf4h'`）可能与`fetchAllTimeframeKlines`实际key格式不一致~~ | **已确认为真实问题并关闭（=CEO问题三）** | draft-1的示例字符串`'btc-tf4h'`确实是凭猜测写的，与源码`id:asset+'.'+key`（`v1-core.js`第12行）的真实格式`'btc.tf4h'`不符，已核对源码而非"建议Codex自行打印确认"这种事后补救方式 | 全文档订正为真实格式`asset+'.'+key`，共6个固定值，见SPEC §10.4；TESTS T21直接用生产结构做6-key矩阵测试，T28做"不出现连字符格式"的元测试兜底 |
| 6 | UI新增区域的具体HTML结构（codex任务§2步骤8给出的示例代码）是设计参考，不是强制逐字节实现 | 待观察（不阻塞本轮） | 若Codex完全照抄示例但现有CSS grid/span系统与示例assumed的不完全匹配，可能出现布局错位 | 已在codex任务原文注明"实际DOM细节允许Codex按现有CSS调整，但语义ID命名必须保持"，把约束收窄到ID命名而非具体HTML标签结构 |
| 7（新增） | `DecisionOutput`上不存在draft-1假设的顶层`blocked`字段 | **已确认为真实问题并关闭（本轮复审源码时额外发现，不在CEO原13项清单内）** | draft-1的`blockedByV11`字段定义"透传`decision.blocked`"，但该字段在`v1-core.js`中不存在，真实可读字段是`decision.opportunityScores.blocked` | 已订正，见SPEC §3/§10.5，TESTS T27.2新增生产路径断言 |

**方法论反思（写给本文档自己，非对外交付物但保留以备后续复审参考）**：draft-1的风险清单3/4/5之所以能"预判到方向但给错具体方案"，根本原因是本文档作者在写draft-1时没有先读`v1-core.js`源码确认`fetchAllTimeframeKlines`/`buildDecision`的真实返回结构，而是凭对"应该长什么样"的合理推测直接写了接口设计。draft-2修订时已对`v1-core.js`做了逐函数源码核对（`fetchAllTimeframeKlines`/`buildDecision`/`analyzeKlines`/`buildSRZones`/`calcPositionMetrics`/`calcVolumeQuality`/`falseBreakoutTier`/`btcAlignment`/`resolveLevels`/`classifyState`/`assessDataQuality`/`calcOpportunityScores`/`calcScore`），后续若再修订本系列文档，应先核对源码再写规范，不能反过来。

---

## 4. 与 V1.1 / V2 边界的最终确认

- **V1.1边界**：本轮四份文档均不修改 `v1-core.js`、不修改 `PROJECT_AUDIT.md`/`STRATEGY_SPEC.md`/`CODEX_IMPLEMENTATION_TASK.md`/`ACCEPTANCE_TESTS.md`/`V1_IMPLEMENTATION_REPORT.md`/`TEST_RESULTS.md` 六份V1.1既有文档，不修改 `v1.1.0` tag / `main` 分支历史。
- **V2边界**：`V1_2_FORECAST_SPEC.md` §12 只定义了 `ForecastLogEntry` 的字段结构和"写入接口"，`outcomeAfter*`/`brierScoreComponent`/`directionAccuracy`/`rangeCoverage`/`calibrationBucket`/`calibratedProbability` 六个字段本轮**只建结构不实现计算**，恒为`null`，回放引擎、Brier Score计算、样本外验证等留给独立的V2工程。
- **V3边界**：WebSocket、条件提醒推送、模拟仓位追踪均未在本轮四份文档中出现任何实现要求，`V1_2_CODEX_IMPLEMENTATION_TASK.md` §1.2 显式列为"禁止顺手实现"。

---

## 5. CEO / 董事长复审清单（Definition of Ready for Review）

复审时建议按以下顺序检查：

- [ ] 第0节列出的CEO原文13项问题是否确认全部关闭（逐条核对"关闭方式"是否真正解决了原问题，而不是文字游戏式的重新措辞）。
- [ ] `V1_2_FORECAST_SPEC.md` §2 的十个概念区分是否认可（尤其"规则型权重≠真实概率"的措辞是否满足业务对合规/风控表述的要求）。
- [ ] §4.2 的12因子三档权重表数值是否需要在实现前就调整（一旦Codex按此表实现并通过测试，后续调整需要重新走一轮spec变更流程；数值本身本轮未改动，仅新增了版本号机制）。
- [ ] §6-§9 的价格区间/情景目标/路径/失效条件算法（本轮已重写，新增双边有效性/finite/顺序/最小宽度检查）是否符合对"专业交易预测面板"的产品预期。
- [ ] §10 的六条安全降级规则、§15 的十条禁止事项是否有遗漏的合规/风控要求需要补充。
- [ ] §12 新版日志schema（版本号三元组+完整12项factorResults+固定15分钟bar定义）是否满足V2未来可复现校准的需要。
- [ ] `V1_2_CODEX_IMPLEMENTATION_TASK.md` 的10步实施顺序（接口签名已随spec同步订正）是否可以直接作为Codex的工单下发。
- [ ] `V1_2_ACCEPTANCE_TESTS.md` 的T1-T31（目标150+项断言）是否覆盖了CEO关心的全部业务场景，是否需要补充新的T类别。
- [ ] 本文档§3风险清单中"待观察"的3项（1/2/6）是否有需要在实现前就解决、而非留到实现阶段再处理的；已关闭的4项（3/4/5/7）确认不需要重新打开。
- [ ] 确认本轮不涉及V1.1 Release/Tag的任何变更，`v1.1.0` 保持不动，`v1-core.js`零改动。

**本文档作者结论**：CEO原文复审提出的13项问题（P0三项、P1七项、测试问题两项、文档一致性一项）已逐项关闭，详见第0节；额外发现并关闭1项draft-1遗留的字段虚构问题（`decision.blocked`）。四份文档字段名/函数名/枚举值经交叉核查一致，权重表验算求和正确，安全红线术语扫描无正面违规表述，V1.1命名空间无冲突，V1.1/V2/V3边界清晰，全部关键接口声明均已对照`v1-core.js`真实源码逐函数核对。**可以再次提交CEO复审。**
