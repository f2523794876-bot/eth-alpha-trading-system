# ACCEPTANCE_TESTS.md — 验收测试规范

版本：v2.1（第三轮修订。CEO第二轮验收**不批准**V1停留在15分钟单周期，T12-T14与T17.2/T17.3从"V2/V3范围"改为"V1必过用例"，其余T1-T11、T15、T18-T20、T24原有用例保持不变）
依据：`STRATEGY_SPEC.md`（每条用例都标注对应章节）。所有测试**必须用构造好的合成K线数据跑**，不能只用实盘行情人工点开页面观察——PROJECT_AUDIT.md 已经证明「实盘验证会漏掉关键分支」（P0缺陷在用实盘数据验证时完全没暴露）。

**V1/V2/V3范围说明（v2.1更新）**：T1-T15、T17-T20、T24 是 **V1阶段（当前）必须能跑通** 的用例，其中 **T12/T13/T14（三周期同向、15分钟逆4小时、BTC周期冲突）在v2.1起正式转为V1必过**，不再允许标记"不适用"。T16（WebSocket断线重连）、T20-T23中的T21-T23（历史回放/Swing未来数据泄漏/样本外验证）依赖 CODEX_IMPLEMENTATION_TASK.md 第1.3/1.4节定义的 V2/V3 功能，**V1阶段代码不需要通过这些用例**。每类测试标题后用 `[V1]`/`[V2]`/`[V3]` 标注适用阶段。

**测试实现方式建议**：Codex 阶段应在项目目录新增一个不影响正式单文件产品的测试脚本（例如 `legacy-tests/run-tests.mjs`，用 Node.js 直接 `vm` 加载 `eth-dynamic-trading-dashboard.html` 内联的 `<script>`，对导出的纯函数喂合成数据、用 `assert` 断言），使全部用例可以一条命令自动跑完并输出通过/失败清单，而不是每次都要人工用浏览器点一遍。是否新建此脚本文件、放在什么位置，Codex 阶段可自行决定并在 PROJECT_AUDIT.md 或本文件追加记录，但**不得删除或覆盖已有的四份文档和正式HTML**。

合成K线的通用生成约定：`bar(o,h,l,c,v,t)`，`t` 为该K线 `openTime`（毫秒），相邻K线间隔 900000ms（15分钟）。除非用例特别说明，成交量基准取 1000，"放量"取 >=1200（对应 volumeRatio>=1.2）。

---

## T1. 正常行情测试

**目的**：验证主链路（fetch → analyze → classify → advice → render）在正常数据下不抛异常、字段齐全。

| 用例 | 构造 | 预期 |
|---|---|---|
| T1.1 | 直接用 `fetchKlines` 拉取真实 Binance ETH/BTC 各100根15m K线（允许联网跑一次，仅作冒烟测试，不作为覆盖率来源） | `analyzeKlines` 返回对象无 `NaN`/`undefined` 必填字段；`DecisionOutput.state` 属于六态之一；页面渲染后所有 `dyn-item` 均有非空 `--` 以外的内容或明确的"数据不足"文案 |
| T1.2 | 用100根平稳小幅震荡的合成K线（振幅<0.3×一个固定ATR基准） | 不抛异常，`state` 落在 `RANGE_CHOP` 或 `STAND_ASIDE`，不应出现 `BULL_CONFIRMATION`/`BEAR_CONTINUATION` |

---

## T2. 多头测试（重点：验证 P0 缺陷已修复）

### T2.1 BULL_CONFIRMATION — 复现 PROJECT_AUDIT.md §4.1 的合成场景，验证修复

**构造**：40根震荡K线（1770-1800区间，其中1根摆动高点1810），随后1根放量突破K线（收盘1815，最高1818，量2000）+ 1根延续K线（收盘1816，量1500），BTC同期走平或走强（`btc.trend != 'down'`）。

**旧版实际输出（缺陷复现，见PROJECT_AUDIT.md）**：`state=STAND_ASIDE(neutral)`，advice="处于支撑压力中间"。

**新版预期输出（本用例的通过标准）**：
- `eth.isBreakout == true`，`eth.breakoutLevel` 等于突破前的 `priorStructureHigh20`（约1810附近，不是1820）。
- `falseBreakoutTier == 'none'`（放量、BTC不弱、非首根即时判定为 warning 时也应在第2根延续K线后转为none，具体看 breakoutBarsCount>=2 的判据）。
- `state == 'BULL_CONFIRMATION'`。
- `DecisionOutput.addOnCondition` 非空字符串。
- `stopLoss == breakoutLevel - ATR14*0.3`（严格按 STRATEGY_SPEC §3.3 突破后失效位改用 breakoutLevel 的规则，不是用更早的 firstSupport）。

### T2.2 BULL_PULLBACK

**构造**：价格在区间内震荡后回落到一个 Swing Low（`firstSupport`）附近0.2×ATR以内，未创新低，BTC不走弱，EMA未必完全多头排列。

**预期**：`state == 'BULL_PULLBACK'`，`biasDirection == 'long'`，`entryZone` 提及支撑价位，`exitConditions` 含止损/止盈/结构破坏三类。

### T2.3 反例：BTC走弱时不应判多头确认

**构造**：与 T2.1 相同的ETH突破形态，但BTC同期跌破自身 `priorStructureLow20`（`btc.isBreakdown=true`，`btc.trend=='down'`）。

**预期**：`state != 'BULL_CONFIRMATION'`，应落在 `TRANSITION_WATCH`（假突破风险，因为 STRATEGY_SPEC §8.1 BULL_CONFIRMATION 进入条件显式要求 `btc.trend!='down'`）或 `STAND_ASIDE`。

---

## T3. 空头测试

### T3.1 BEAR_CONTINUATION

**构造**：40根震荡K线后接1根跌破K线（收盘跌破 `priorStructureLow20`），BTC同期 `btc.trend=='down'`。

**预期**：`eth.isBreakdown==true`，`state=='BEAR_CONTINUATION'`，`stopLoss == breakdownLevel + ATR14*0.3`，`biasDirection=='short'`。

### T3.2 反例：跌破但BTC未同步走弱

**构造**：ETH跌破自身20根低点，但BTC同期 `trend=='flat'` 或 `'up'`。

**预期**：不应为 `BEAR_CONTINUATION`（STRATEGY_SPEC §8.1 明确要求 `btc.trend=='down'` 才能进入），应落在 `TRANSITION_WATCH`，文案需体现"跌破未得到BTC确认，不建议追空"（对应 STRATEGY_SPEC §6.3 模板）。

---

## T4. 震荡测试

**构造**：60+根K线在一个窄区间（例如 ±0.5×ATR）内反复横盘，EMA5/10/20 数值互相贴近（间距<0.5×ATR），最近5根K线波动率低于此前（`atr14 <= atrPrev`），BTC同期 `trend=='flat'`。

**预期**：`state=='RANGE_CHOP'`，`advice` 含"赔率一般/不适合重仓"类措辞，`bestInterceptionZone` 返回"区间中部，不介入"分支文案。

**反例**：同样窄幅震荡但 `atr14 > atrPrev`（波动率在放大，说明可能正在酝酿突破）——预期不应判 `RANGE_CHOP`（因为 STRATEGY_SPEC §8.1 要求 `atr14<=atrPrev`），应落 `STAND_ASIDE` 或视具体EMA/价格位置落 `TRANSITION_WATCH`。

---

## T5. 假突破测试（两级）

### T5.1 warning 级（风险提示，不是禁止）

**构造**：价格突破 `priorStructureHigh20` 但成交量未放大（`volumeRatio<1.2`），BTC同步走强，突破后K线未出现长上影线，也未收回区间。

**预期**：`falseBreakoutTier=='warning'`，`state=='TRANSITION_WATCH'`，文案含"未放量""建议减小仓位或等待确认"字样，**不能**出现"假突破，不建议追多"这种confirmation_failed级别的措辞（避免把所有缩量突破都一刀切判死，对应 STRATEGY_SPEC §9 / §6.2 的分级要求）。

### T5.2 confirmation_failed 级（确认失败，明确不建议追）

**构造**：价格突破后紧接1-2根K线内收盘价又跌回 `priorStructureHigh20` 以下（"回收区间"），或突破K线本身是长上影线（`(high-close)/(high-low)>0.5` 且振幅>0.5×ATR）。

**预期**：`falseBreakoutTier=='confirmation_failed'`，文案精确输出"假突破风险，不建议重仓追多。"（STRATEGY_SPEC §6.3 模板原文）。

### T5.3 对称跌破假信号

**构造**：跌破后BTC未同步跌破，且刚发生（`breakdownBarsCount<=1`）。

**预期**：`falseBreakoutTier=='confirmation_failed'`，文案含"跌破未得到BTC和成交量确认，不建议追空。"

---

## T6. BTC冲突测试

**构造**：ETH自身呈现清晰多头结构（`isBreakout=true`，量能达标），但BTC自身 `trend=='down'`（`btc.price<btc.ema20` 且 `btc.ema5<btc.ema10<btc.ema20`）。

**预期**：
- `btcAlignment=='conflict'`。
- `state` 不应为 `BULL_CONFIRMATION`（硬性阻断，§8.1）。
- 若此时仍单独计算"假设按多头处理"的盈亏比，`RiskReward.flags` 中若 `value>2` 应包含 `btcConflictDespiteGoodRR` 标记（§10.3第8类边界）并在文案追加"赔率数字达标但BTC方向冲突"提示。

---

## T7. API失败测试

| 用例 | 构造 | 预期 |
|---|---|---|
| T7.1 | mock `fetch` 返回 HTTP 500 | 不抛未捕获异常；`dataSource` 文案切换为"实时数据获取失败"；`manualPanel` 自动进入可见/激活态；页面其余区域不白屏，仍渲染"等待手动输入"提示 |
| T7.2 | mock `fetch` 抛网络错误（`TypeError: Failed to fetch`，模拟断网） | 同上，且不应有未处理的 Promise rejection 输出到 console 报错级别（可以 warn，但不能是未捕获异常） |
| T7.3 | mock `fetch` 返回非JSON文本（模拟代理拦截返回HTML错误页） | JSON.parse 失败被捕获，同 T7.1 行为，不崩溃 |
| T7.4 | mock 一路（如ETH）成功、另一路（BTC）失败 | 系统必须整体判定为"数据不完整"，不能用"只有ETH"的半份数据继续输出正常建议（因为 BTC联动是所有多空确认状态的硬性前提，缺BTC数据时 `btc.trend` 应为特殊值如 `'unavailable'`，凡是依赖 `btc.trend` 的状态一律不能进入，只能停留在数据不足对应的降级态） |

---

## T8. 手动回退测试

| 用例 | 构造 | 预期 |
|---|---|---|
| T8.1 | 6个字段全部合法填写（`low20<=high20`，`recentLow<=recentHigh`，量级一致） | `analyzeManual` 正常产出 `AnalyzedSnapshot`，`isManual=true`，`confidence` 相关字段标记为 `medium/low`，UI明确展示"手动模式（近似值）" |
| T8.2 | `low20 > high20`（自相矛盾输入） | `validateManualInput` 返回 `ok=false`，`errorField` 指出具体字段，页面拒绝计算并提示，不得静默用默认值继续 |
| T8.3 | 误将 BTC 价格（约6万级别）填入 ETH 的 `recentLow`（约2千级别） | 量级校验触发，拒绝计算并提示"输入数值量级异常，请检查是否填反" |
| T8.4 | 手动模式下检验 `falseBreakoutTier` 能力上限 | 即使价格构造成"突破"形态，因缺少 `volumeRatio`/BTC K线，`falseBreakoutTier` 最高只能到 `warning`，不能出现 `confirmation_failed`（因为该级别依赖实时序列判据，§9.5）；同时 `BULL_CONFIRMATION`/`BEAR_CONTINUATION` 两个依赖BTC强确认的状态在纯手动模式下应大概率无法进入，停留在 `TRANSITION_WATCH`/`STAND_ASIDE`，这是预期的保守行为而非缺陷 |
| T8.5 | 用户先启用手动模式，之后API恢复 | 点击"重试实时数据"后，应能正确切回 `isManual=false` 并用K线重新计算，不残留手动模式产生的字段（例如 `confidence='low'` 不应该继续污染已经恢复的实时数据结果） |

---

## T9. 异常值测试

| 用例 | 构造 | 预期（对应 STRATEGY_SPEC §9.3） |
|---|---|---|
| T9.1 | 单根K线 `high < low`（脏数据） | 该K线被 `detectAnomalyBars` 标记，不参与Swing/极值候选，`dataQuality.anomalyBarsExcluded` 增加，UI提示已剔除异常K线 |
| T9.2 | 单根K线振幅 `(high-low) > 5*ATR14`（异常插针） | 同上被剔除，不应被误判为一次真实突破/跌破的触发依据 |
| T9.3 | 单根K线与前收盘价缺口 `>3*ATR14`（跳空） | 同上被剔除 |
| T9.4 | 100根K线中异常K线数量 `>5` | 系统整体判定"数据源异常"，提示用户改用手动输入或稍后重试，不能继续假装数据正常并输出交易建议 |
| T9.5 | `klines.length < 15` | `ATR14=null`，直接进入数据不足降级态（STRATEGY_SPEC §9.1），不得让后续函数收到 `null` 后自己各种"防御性"猜测继续算下去 |
| T9.6 | `klines.length` 在 15~24 之间 | `trend` 强制 `'flat'`，UI标注"EMA20样本不足，趋势判断已禁用" |
| T9.7 | `klines.length` 在 25~50 之间 | 50根中期字段（`recentHigh50`等）显示"数据不足（需51根含当前）"，不得偷用20周期数值填充 |

---

## T10. 盈亏比边界测试（对应 STRATEGY_SPEC §10.3 八类情况，逐条构造）

| # | 用例 | 构造 | 预期 status |
|---|---|---|---|
| 1 | 风险=0 | 令 `price == stopLoss` | `risk_zero_or_negative` |
| 2 | 风险<0 | 令 `price` 已经处于 `stopLoss` 不利一侧 | `risk_zero_or_negative`，文案含"应直接离场" |
| 3 | 目标方向错误 | 人为构造 `targets[0] <= price`（多单场景下目标反而在下方，模拟上游异常） | `target_wrong_side`，且要求断言此结果被记录用于排查（测试里检查是否有对应的日志/警告输出） |
| 4 | 价格已超目标 | 令 `price >= targets[0]` | `price_past_target`，文案含"建议考虑部分止盈" |
| 5 | 支撑压力缺失 | 构造无任何Swing点、且 `priorStructureHigh20/50` 也不可用的极端数据（例如极短历史），迫使 `firstResistance/firstSupport` 走到 `confidence='low'` 外推档 | `missing_level`（或在 `ok` 基础上打 `lowConfidence` 标记，两种设计二选一但必须在实现中体现"低置信度不能被当高置信度用"） |
| 6 | 数据无效 | `stopLoss=null` 或 `targets[0]=NaN` | `invalid_data`，不输出任何数字 |
| 7 | 多空双差 | 构造多单RR<1.5 且空单RR<1.5 的中性区间价格 | `flags` 含双向都差的提示文案，不能只展示一个方向就下结论 |
| 8 | RR好但BTC冲突 | 多单RR>2 但 `btcAlignment=='conflict'` | `flags` 含 `btcConflictDespiteGoodRR`，文案降级措辞出现 |

---

## T11. 数据陈旧测试

| 用例 | 构造 | 预期 |
|---|---|---|
| T11.1 | mock 最新K线 `closeTime` 为 40 分钟前（超过 STRATEGY_SPEC §9.2 的30分钟阈值） | `dataQuality.isStale=true`，页面出现不可关闭的陈旧数据横幅，`advice` 文案带"（基于陈旧数据）"前缀 |
| T11.2 | `closeTime` 为 10 分钟前（未超阈值） | `isStale=false`，无横幅 |
| T11.3 | 模拟浏览器标签页长时间处于后台（`document.visibilityState==='hidden'` 持续>1分钟后切回前台） | 切回前台时应触发一次立即重新拉取，而不是干等下一个20秒定时器（验证 PROJECT_AUDIT.md §6 第6条提到的后台节流问题已被处理） |

---

## T12. 三周期同向测试 [V1，v2.1起为必过用例]

**构造**：4小时K线呈 `HTF_BULL_TREND`（价格>ema20(4h)，EMA多头排列，Swing Low抬高），1小时K线呈 `BULL_CONFIRMATION`，15分钟K线呈 `BULL_CONFIRMATION`或`BULL_PULLBACK`，BTC三个周期均不走弱。

**预期**：`computeSignalPermission` 返回 `alignment=='full_aligned'`，`level=='trend_entry_allowed'`，`addOnAllowed=true`，`positionSizeCapPct==20`，`reason` 文案包含"三周期同向"字样（STRATEGY_SPEC §12.4规则1）。`DecisionOutput.worthBetting` 应为 `true`（假设15分钟层本身也满足 `falseBreakoutTier!='confirmation_failed'` 且数据健康）。

## T13. 15分钟逆4小时测试 [V1，v2.1起为必过用例]

**构造**：4小时呈 `HTF_BEAR_TREND`，但15分钟因短线反弹呈 `BULL_PULLBACK` 或 `biasDirection=='long'`。

**预期**：`computeSignalPermission` 返回 `alignment=='counter_trend'`，`level=='counter_trend_only'`，`addOnAllowed=false`，`positionSizeCapPct==5`，`reason` 明确说明"只能作为反弹/回调交易，不得升级为趋势仓"（§12.4规则2）。同时验证：即使15分钟单独判断 `state=='BULL_PULLBACK'` 且盈亏比达标，`DecisionOutput.advice` 也必须附带"反弹/回调仓，不可加仓"的措辞，不能包装成与顺势交易同等地位的建议。

## T14. BTC周期冲突测试 [V1，v2.1起为必过用例]

**构造**：ETH三周期方向一致（例如均偏多），但BTC在其中一个周期（例如1小时）呈 `trend=='down'`。

**预期**：`btc_ok('long', btcMtf)` 返回 `false`，导致 `full_aligned` 条件不满足，`computeSignalPermission` 不应返回 `full_aligned`，应降级为 `partial_aligned` 或 `conflict`（取决于其余条件，按§12.4伪代码逐条判断），不能因为"多数周期支持"就忽略单个周期的BTC冲突。

## T15. 未收盘K线不得确认正式信号测试 [V1，核心用例]

**构造**：40根已收盘震荡K线后，第41根K线（当前最新，`isClosed=false`）盘中最高价短暂刺穿 `priorStructureHigh20`（例如瞬时high=1820，`priorStructureHigh20`=1810），但该根K线尚未收盘，`price`（取自该根K线的close，模拟盘中任意时刻的最新成交价）也已经短暂超过1810，随后构造收盘价回落到区间内（例如1805）并令 `isClosed=true` 完成收盘。

**预期（分两个时间点断言）**：
1. K线未收盘时（`isClosed=false`，`price=1815`〔盘中高点〕，`confirmedPrice`=上一根已收盘K线收盘价，仍在区间内）：`isBreakout` 必须为 `false`，`state` 不能是 `BULL_CONFIRMATION`，只能触发第19.2节"突破或跌破关键区域"提醒的"盘中提前预警"分支（文案含"未收盘，仅供参考"）。
2. K线收盘后（`isClosed=true`，`confirmedPrice=1805`，仍在区间内）：`isBreakout` 依然为 `false`，因为收盘价其实收回了区间——验证系统不会把"盘中插针"误认成"已确认突破"，即使插针幅度很大。

此用例是 STRATEGY_SPEC §13 的核心验收点，**必须在V1阶段就通过**，因为它验证的是 `confirmedPrice` 修正（§2.3/§13），不依赖三周期或WebSocket。

## T16. WebSocket断线重连测试 [V3]

| 用例 | 构造 | 预期 |
|---|---|---|
| T16.1 | 模拟WS连接建立后5秒断开 | `connectionState` 依次经过 `'connecting'→'open'→'reconnecting'`，重连延迟遵循指数退避公式（§14.2），首次约1秒左右开始重试 |
| T16.2 | 模拟连续10次重连失败 | `connectionState` 变为 `'failed'`，系统自动切换到 `'rest_fallback'`（REST轮询兜底），不应无限重试导致请求风暴 |
| T16.3 | 模拟断线期间有K线被跳过（重连后收到的下一根K线openTime与断线前最后一根不连续） | 触发§14.4"缺失K线检测"，自动发起REST补齐请求，补齐后 `dataQuality.gapDetected` 应重新为 `false` |
| T16.4 | 模拟长时间断网后REST补齐也失败 | `dataQuality.gapDetected` 保持 `true`，`dataHealth` 不应为 `'normal'` |

## T17. 数据陈旧和周期不同步测试 [V1，REST版；V3再叠加WS专属子项]

| 用例 | 构造 | 预期 |
|---|---|---|
| T17.1（V1可测） | 沿用T11.1，最新K线 `closeTime` 超过30分钟未更新 | `dataHealth` 不为 `'normal'`（V1阶段没有三周期/WS概念，此处等价于v1.0已有的 `isStale` 判断，§9.2） |
| T17.2（V1，REST版） | 模拟ETH 15分钟序列最新收盘时间与BTC 15分钟序列相差超过一个周期（REST轮询时间戳比较，不依赖WS） | `ethBtcDesync('15m')` 为 `true`，`dataHealth` 不能为 `'normal'`（§14.5） |
| T17.3（V1，REST版） | 模拟15分钟序列最新收盘时间落后1小时序列超过1小时，或1小时落后4小时超过4小时 | 记入 `warnings`，不强制阻断但需在UI可见（§14.5"离谱滞后"检测） |
| T17.5（V3新增） | 在WS架构下模拟连接抖动导致的瞬时误报陈旧 | 需要WS连接状态机（§14.3）配合去抖，本条留待V3实现时设计 |
| T17.4（V1/V3通用） | `dataHealth=='invalid'` | `signalPermission.level` 强制 `'blocked_by_data'`，`worthBetting` 强制 `false`，UI出现不可关闭的红色横幅（§14.7） |

## T18. 支撑压力区域聚类测试 [V1]

**构造**：构造3个价格非常接近（价差均 `<0.3*ATR14`）的Swing High，分布在不同时间点。

**预期**：`findSwings` 后经聚类应归为同一个 `clusterId`（§5.2第5项），`buildSRZones` 应只产出**一个**压力区域（`rank=1`），`sourceSwingCount==3`，而不是三个几乎重叠的独立区域；`zoneHalfWidth` 应符合 `max(0.15*ATR14, 0.5*簇内价格极差)` 公式（§15）。另需验证 `secondResistance` 取自**不同簇**的下一个点，不能与 `firstResistance` 同源（复用§5.2第5项已有约束）。

## T19. 交易成本导致净盈亏比降级测试 [V1]

**构造**：设定 `TradingCost` 默认参数（taker手续费0.05%、价差0.02%、滑点0.03%），构造一个毛RR恰好等于2.05（略高于"较好"阈值2）的场景。

**预期**：`总成本率 = 0.05%+0.01%+0.03% = 0.09%`（单边），`总成本率×2` 约0.18%，按当前ETH价格换算成本金额后代入净RR公式，净RR应明显低于毛RR（具体数值取决于潜在风险的绝对金额，测试断言"netRR < grossValue"且两者都被展示）。构造一个更极端的场景（潜在风险很小，例如止损只有0.5×ATR，成本占比相对更高）：验证净RR可能从"较好"档（毛RR>2）**降级**到"一般"档（净RR<1.5），且系统输出的提示文案是按净RR判断的档位，不是毛RR的档位——这是本用例的核心断言（§10.1a/10.2）。

## T20. 透明评分明细测试 [V1，v2.1起4h/1h两项使用真实数据]

| 用例 | 构造 | 预期 |
|---|---|---|
| T20.1 | 15分钟处于 `BULL_CONFIRMATION`、`falseBreakoutTier=='none'`、净RR>3、`dataHealth=='normal'`、成交量`sustained`，**且4小时构造为`HTF_BULL_TREND`、1小时构造为`BULL_CONFIRMATION`（方向一致）** | `calcScore` 输出中"15分钟位置"=20、"净盈亏比"=15、"成交量"=10、"数据质量"=5、"4小时方向"=20、"1小时结构"=15，`total` 应等于以上六项之和减去适用的扣分项，在三周期同向的理想场景下应能接近满分100（v2.1起不再有35分固定占位缺口，这是评分设计的核心意图——分数应该真实反映三周期信号的扎实程度） |
| T20.4（v2.1新增） | 4小时/1小时数据缺失或不足（例如4小时K线数少于第9.1节最低要求） | "4小时方向""1小时结构"两项应按§9.1数据不足规则降级评分（不是恒为0，而是有明确的降级原因文案），且 `dataHealth` 相应反映数据不足，不能悄悄用15分钟数据顶替4h/1h两项评分 |
| T20.2 | 构造 `falseBreakoutTier=='confirmation_failed'` | 扣分项出现-20，且 `overriddenByHardRule==true`，UI必须显示"评分仅供参考，已被硬性规则否决"，即使其余各项分数很高 |
| T20.3 | 验证 `items` 数组完整性 | 每一项都必须有 `name`/`points`/`maxPoints`/`reason`，不能只给一个总分不给明细（对应需求"必须显示每个加分和扣分来源"） |

## T21. 逐根历史回放测试 [V2]

**构造**：取一段已知结果的历史K线区间（例如人工核实过的一段明确上涨突破行情），逐根喂给回放引擎。

**预期**：回放引擎在每个时间点 `t` 产出的 `state`/`isBreakout` 等，应与"假设当时就用这套系统实时跑一遍"得到的结果完全一致（即回放引擎和实时引擎必须复用同一套纯函数，不能有两套实现导致结果不一致，§18.5）。

## T22. Swing未来数据泄漏测试 [V2，核心用例]

**构造**：在回放引擎运行到第 `i` 根K线时（`i` 满足在原始数据里其后方第 `i+1`、`i+2` 根K线会形成一个更高的Swing High），检查此时回放引擎能访问到的 `swingHighs` 数组。

**预期**：第 `i` 根K线时刻，那个依赖 `i+1`/`i+2` 才能确认的Swing High **不应该**出现在此刻可用的 `swingHighs` 里（因为按规则要等到第 `i+2` 根被回放引擎"揭示"之后才能确认第 `i` 根是Swing——本用例specifically验证的是一个稍晚的、需要更晚K线确认的点，不应该被提前看到）。这是历史回测最容易犯错的地方，必须作为V2开发的第一优先级正确性测试，任何"回测结果好得不真实"的情况都应该先怀疑这里。

## T23. 样本外验证流程测试 [V2]

**构造**：把一段历史数据按时间顺序切成训练区间（前70%）和测试区间（后30%）。

**预期**：训练区间内调整/选择的任何参数（如止损ATR系数）不应该以任何形式读取测试区间的数据（含未来函数式的"提前看一眼测试集表现再决定用哪个参数"）；滚动样本外验证（walk-forward）每一轮的训练窗口和测试窗口不重叠且按时间顺序前进，测试断言窗口边界计算正确、无重叠、无逆序。

## T24. 决策日志测试 [V1] 与条件提醒测试 [V3]

| 用例 | 阶段 | 构造 | 预期 |
|---|---|---|---|
| T24.1 | V1 | 正常产出一次 `DecisionOutput` 后调用 `buildDecisionLogEntry` | 返回的 `DecisionLogEntry` 字段齐全，`htfState`/`mtfState` **是真实的4小时/1小时状态**（v2.1起不再是占位的`'not_available_v1'`），`supportingEvidence`/`opposingEvidence` 按§19.1规则从评分明细分流生成，条目被写入 `localStorage`（校验容量上限500条、超出后先进先出） |
| T24.2 | V3 | 连续两次tick，`bestInterceptionZone` 的 `zone` 从"非拦截区"变为"拦截区" | `checkAlertConditions` 触发"进入最佳拦截区"提醒（第19.2节第1类），V1阶段不要求实现，本条留给V3 |
| T24.3 | V3 | `isBreakout` 从 `false` 变为 `true`（基于 `confirmedPrice`） | 触发"突破或跌破关键区域"提醒（第2类），且不应该在K线未收盘时用 `price` 提前触发这个"正式"提醒（应走T15验证过的"盘中预警"分支），V1阶段不要求实现 |
| T24.4 | V3 | `price` 与 `stopLoss` 距离缩小到 `<0.3*ATR14` | 触发"临近失效位"提醒（第6类），V1阶段不要求实现 |
| T24.5 | V3 | `dataHealth` 从 `'normal'` 变为 `'invalid'` | 触发"数据失效"提醒（第8类），且该提醒应是最高优先级展示，V1阶段不要求实现（但V1的"数据失效"横幅本身仍是必须的，见T17系列，区别在于"横幅提示"是V1范围，"主动推送提醒"是V3范围） |

---

## 12. 最终验收清单（提交 ChatGPT/CEO 验收前，逐条勾选）

- [ ] T1 全部通过（主链路无异常，字段齐全）。
- [ ] T2.1 通过 —— **P0缺陷复现场景在新代码下输出 BULL_CONFIRMATION**，这是本阶段唯一"一票否决"级别的用例，不通过则不允许提交验收。
- [ ] T2.2、T2.3 通过。
- [ ] T3.1、T3.2 通过。
- [ ] T4 通过（含反例）。
- [ ] T5.1、T5.2、T5.3 通过，且能在UI上肉眼区分"风险提示"与"确认失败"两种视觉样式。
- [ ] T6 通过，BTC冲突时不能被判多头确认。
- [ ] T7.1-T7.4 通过，任何API失败形态都不能导致白屏或未捕获异常。
- [ ] T8.1-T8.5 通过，手动模式校验严格、能力边界诚实（不冒充自己有BTC/成交量数据）。
- [ ] T9.1-T9.7 通过，异常K线与数据不足都被正确识别和降级，不会"带病运行"。
- [ ] T10 八类边界全部有专门分支和文案，不再是"只处理risk<=0一种"的粗糙版本。
- [ ] T11 通过，陈旧数据有醒目且不可关闭的提示。
- [ ] T15 通过 —— **未收盘K线插针不得误判为已确认突破**，这是v2.0第二重"一票否决"级用例（与T2.1的P0用例同等重要），不通过则不允许提交验收。
- [ ] T18、T19、T20、T24 通过（V1阶段必须实现的支撑压力区域化/净盈亏比/透明评分/决策日志；T24中涉及推送提醒的部分不适用，V1只做被动日志记录）。
- [ ]（v2.1修正）T12、T13、T14 **必须通过**（三周期同向/15分钟逆4小时/BTC周期冲突，不再允许标记"不适用"），T17.2、T17.3（REST版周期同步检测）同样必须通过。
- [ ] T16（WebSocket断线重连）、T21、T22、T23（历史回放/Swing未来数据泄漏/样本外验证）**在V1阶段允许标记为"不适用（V2/V3范围）"**，不计入本轮通过率，但接口/数据结构必须已按STRATEGY_SPEC.md第14/18节的设计就位，不能完全没有对应字段。
- [ ] 已在真实浏览器（非本地http server，直接双击文件）下人工过一遍主流程，截图或文字记录 CORS/网络实测结果，回填 PROJECT_AUDIT.md。
- [ ] `CODEX_IMPLEMENTATION_TASK.md` 第7节 Definition of Done 全部勾选（含v2.0新增项）。
- [ ] 全程未触碰 `CODEX_IMPLEMENTATION_TASK.md` 第6节任何一条禁止事项（无自动下单、无密钥读取、无摊平包装成加仓、无盈利承诺、无杠杆、无黑箱AI自主决策、未扩展其他币种）。
- [ ]（v2.0新增）评分系统 `worthBetting` 未依赖 `score.total`（STRATEGY_SPEC §17.3），Code Review确认。
- [ ]（v2.1修正）确认V1阶段**已经**实现三周期REST数据与三周期决策（不再是占位字段），且**未**提前实现WebSocket/历史回测引擎/条件提醒推送/模拟仓位/长期运行监控的功能代码（这五项在当时是V2/V3范围；**v1.3范围调整说明**：模拟仓位已于v1.3阶段拆出单独实现，不再属于V3范围，见`V1_3_PAPER_TRADING_SPEC.md`，本条其余四项范围不变）。
- [ ]（v2.1新增）项目已 `git init` 并提交开发基线；旧文件保持原样未被删除/移动/归档。

以上全部勾选，本阶段（V1）方可视为完成，可提交下一阶段（正式编码与真实浏览器联调）。T16、T21-T23 留待 V2/V3 阶段实际开发时按本文档标准验收，不阻塞V1提交；T12-T14、T17.2-T17.3 已改为V1必过项，不再属于留待项。
