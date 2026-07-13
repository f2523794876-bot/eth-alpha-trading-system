# V1_2_ARCHITECTURE_REVIEW.md — V1.2「走势预测层」架构复核与一致性核查

版本：v1.2-draft-1
角色：本文档是四份V1.2文档中的最后一份，职责是**核对前三份文档（`V1_2_FORECAST_SPEC.md`/`V1_2_CODEX_IMPLEMENTATION_TASK.md`/`V1_2_ACCEPTANCE_TESTS.md`）互相一致**，给出风险清单，并作为交给CEO/董事长复审的入口文档。本文档不新增算法规则，如发现三份文档之间的不一致，以 `V1_2_FORECAST_SPEC.md` 为准并在此记录、回去修正其余文档。

---

## 1. 一致性核查方法

对三份文档做了逐项字符串核查（`grep -c`，覆盖 spec/codex/tests 三个文件），确认以下命名在三份文档中同时出现、含义一致、无拼写漂移：

### 1.1 十二项因子 id

| 因子id | 中文名 | spec | codex | tests | 结论 |
|---|---|---|---|---|---|
| `trend4h` | 4小时趋势 | ✓ | ✓（`factorTrend4h`） | ✓（T1.4引用同类因子） | 一致 |
| `structure1h` | 1小时结构 | ✓ | ✓（`factorStructure1h`） | 隐含于T4.1（`mtfConflict`输入） | 一致 |
| `structure15m` | 15分钟执行结构 | ✓ | ✓（`factorStructure15m`） | 隐含于T4.1 | 一致 |
| `emaSlopeOwn` | EMA排列与斜率 | ✓ | ✓（`factorEmaSlopeOwn`） | 未单独设专项T，覆盖在T1/T2整体断言中 | 一致（建议见§3风险2） |
| `swingStructure` | Swing高低点结构 | ✓ | ✓（`factorSwingStructure`） | 隐含于T3/T5路径判定 | 一致 |
| `atrState` | ATR波动状态 | ✓ | ✓（`factorAtrState`） | ✓（T8.1直接断言） | 一致 |
| `srDistance` | 动态支撑压力距离 | ✓ | ✓（`factorSrDistance`） | 隐含于T15区间测试 | 一致 |
| `volumeQuality` | 成交量质量 | ✓ | ✓（`factorVolumeQuality`） | ✓（T7.1/T7.2直接断言） | 一致 |
| `btcAlignment3tf` | BTC三周期联动 | ✓ | ✓（`factorBtcAlignment3tf`） | ✓（T5.1直接断言） | 一致 |
| `falseBreakoutRisk` | 假突破风险 | ✓ | ✓（`factorFalseBreakoutRisk`） | ✓（T6.1直接断言） | 一致 |
| `rangePosition` | 区间位置 | ✓ | ✓（`factorRangePosition`） | 隐含于T3.1（区间40%-60%场景） | 一致 |
| `mtfConflict` | 多周期方向冲突 | ✓ | ✓（`factorMtfConflict`，签名强制只接收因子1/2/3结果对象） | ✓（T4.1直接断言） | 一致 |

### 1.2 权重表（spec §4.2）纵向求和自查

15m列：6+10+22+10+8+8+12+10+6+4+2+2 = **100**
1h列：12+20+10+9+8+6+10+8+9+5+2+1 = **100**
4h列：22+14+4+8+8+5+8+6+12+6+3+4 = **100**

三档权重表均已在写入spec前手工验算求和为100，`V1_2_ACCEPTANCE_TESTS.md` T14.2 对此有专项自动化断言（`Object.values(FACTOR_WEIGHTS[tf]).reduce(...)===100`），确保未来任何人手滑改动权重表都会被测试捕获。

### 1.3 顶层数据结构与函数签名

`ForecastOutput`/`HorizonForecast`/`DirectionWeights`/`PriceRangeEstimate`/`ScenarioTargets`/`PathScenarioId`/`InvalidationCondition`/`ConfidenceScore`/`ForecastFactorResult`/`ForecastLogEntry`/`buildForecast`/`buildForecastLogEntry`/`saveForecastLog`/`ethAlphaForecastLogs` 十四个关键名词在 spec/codex/tests 三份文档中均有出现且定义一致（详见附录核查命令输出，本节不重复贴表）。

`PathScenarioId` 的7个枚举值、`InvalidationId` 的5个枚举值**只在 `V1_2_FORECAST_SPEC.md` 中被逐一列出定义**，`V1_2_CODEX_IMPLEMENTATION_TASK.md` 有意不重复罗列，只引用"严格按spec §8/§9实现"——这是**刻意的DRY设计**，避免两份文档各存一份枚举值列表、未来改动时漏改一处导致漂移。`V1_2_ACCEPTANCE_TESTS.md` 中的T3.2/T6.2/T19.2 等用例直接引用spec定义的具体枚举值（如 `RANGE_ROUND_TRIP`），验证了测试文档与spec的绑定关系正确。

### 1.4 术语与安全红线自查

对三份文档做了 `真实概率|胜率\d|必涨|必跌|稳赚|保证盈利` 的全文正则扫描：命中的**全部6处**都是在"明确禁止使用"的上下文中出现（作为反面示例被引用，如"禁止出现'胜率70%'"），**没有一处是作为系统实际输出的正面表述**。`V1_2_ACCEPTANCE_TESTS.md` T16.1-T16.5 把这条红线转成了可自动化执行的正则扫描+字段值断言，不依赖人工复查。

### 1.5 与 V1.1 命名空间的隔离核查

| 项目 | V1.1既有 | V1.2新增 | 是否冲突 |
|---|---|---|---|
| localStorage决策日志key | `ethAlphaDecisionLogs`、`ethAlphaDecisionLogsV11`（已用 `grep` 核实于 `v1-core.js:42/63`） | `ethAlphaForecastLogs` | 不冲突 |
| 模块全局变量名 | `window.ETHAlphaCore` | `window.ETHAlphaForecast` | 不冲突 |
| 自定义DOM事件名 | `v11decision` | `v12forecast`（codex任务文档中作为渲染层内部事件，若改为直接监听`v11decision`则不新增事件名，两种实现路径均在codex任务§2步骤8中说明为允许） | 不冲突 |
| 测试文件命名 | `v1-tests.js`/`v11-tests.js`/`audit-fixes-tests.js`/`v11-ui-tests.js`/`third-review-tests.js`/`live-rest-test.js` | `v12-forecast-tests.js`/`v12-ui-tests.js` | 不冲突 |
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

## 3. 风险清单（已识别，供CEO复审时参考，不代表本轮需要现在解决）

| # | 风险 | 影响 | 缓解/后续动作 |
|---|---|---|---|
| 1 | 12项因子的权重表（spec §4.2）数值是本文档作者基于业务理解拍定的初始值，尚未经过任何历史数据回测验证其合理性 | 规则型权重的"手感"可能与未来V2校准后的真实表现有出入 | 这正是V1.2明确声明"规则型权重，未经校准"的原因；V2完成回测后，若校准结果显示权重需要调整，应回到本spec提出修改，而不是绕过spec直接改代码 |
| 2 | `emaSlopeOwn`（因子4）依赖的斜率阈值（±0.3，spec §4.1第4行）是启发式设定，未做过灵敏度测试 | 阈值过松/过紧可能导致该因子经常性输出极端值或经常性中性 | 建议V2回测阶段把该阈值也纳入参数敏感性测试范围（呼应STRATEGY_SPEC.md已有的"参数敏感性测试"概念） |
| 3 | `buildForecast` 需要 `fetchMeta`（`{partial, failed}`）作为独立参数传入，而不是从 `decision` 对象上读取——因为V1.1的`DecisionOutput`当前不包含逐周期的fetch成败明细 | Codex实现时若偷懒直接从`decision.dataHealth`推断而不接收显式的`fetchMeta`参数，会丢失"到底是哪个具体周期缺失"的精度，导致§10.4的降级判断不够精确 | codex任务§3函数签名已显式要求`fetchMeta`作为独立参数，`V1_2_ACCEPTANCE_TESTS.md` T10 用例专门针对此场景验证 |
| 4 | 新增第4个`<script>`块如何拿到`ethTf`/`btcTf`原始快照对象，需要在现有`refresh()`函数体内追加一行暴露变量（codex任务§2步骤8） | 这是本工单唯一被允许触碰V1.1既有函数体的地方，若实现不当（多加了逻辑而不只是一行赋值）可能意外改变`refresh()`的既有行为 | codex任务文档已明确"唯一允许"的范围仅限"新增一行赋值"，DoD第3条要求对三个既有`<script>`块做`git diff`核查，`V1_2_ACCEPTANCE_TESTS.md` T18.2 列为人工核对项 |
| 5 | `AnalyzedSnapshot`未直接暴露"该资产该周期是否在本次fetch中失败"这一布尔值（该信息目前只在`fetchAllTimeframeKlines`返回值的顶层`partial/failed`数组中），因子9（BTC联动）的"硬性missing"判断需要跨对象比对周期标识字符串 | 若字符串标识约定（如`'btc-tf4h'`）在实现时与`fetchAllTimeframeKlines`实际使用的key格式不一致，会导致该判断失效 | codex任务实现步骤6明确要求"严格按spec §14优先级顺序"，建议Codex在实现`factorBtcAlignment3tf`前先打印一次`fetchAllTimeframeKlines`真实返回值确认key格式，而不是凭本文档猜测的示例字符串直接硬编码 |
| 6 | UI新增区域的具体HTML结构（codex任务§2步骤8给出的示例代码）是设计参考，不是强制逐字节实现 | 若Codex完全照抄示例但现有CSS grid/span系统与示例assumed的不完全匹配，可能出现布局错位 | 已在codex任务原文注明"实际DOM细节允许Codex按现有CSS调整，但语义ID命名必须保持"，把约束收窄到ID命名而非具体HTML标签结构 |

---

## 4. 与 V1.1 / V2 边界的最终确认

- **V1.1边界**：本轮四份文档均不修改 `v1-core.js`、不修改 `PROJECT_AUDIT.md`/`STRATEGY_SPEC.md`/`CODEX_IMPLEMENTATION_TASK.md`/`ACCEPTANCE_TESTS.md`/`V1_IMPLEMENTATION_REPORT.md`/`TEST_RESULTS.md` 六份V1.1既有文档，不修改 `v1.1.0` tag / `main` 分支历史。
- **V2边界**：`V1_2_FORECAST_SPEC.md` §12 只定义了 `ForecastLogEntry` 的字段结构和"写入接口"，`outcomeAfter*`/`brierScoreComponent`/`directionAccuracy`/`rangeCoverage`/`calibrationBucket`/`calibratedProbability` 六个字段本轮**只建结构不实现计算**，恒为`null`，回放引擎、Brier Score计算、样本外验证等留给独立的V2工程。
- **V3边界**：WebSocket、条件提醒推送、模拟仓位追踪均未在本轮四份文档中出现任何实现要求，`V1_2_CODEX_IMPLEMENTATION_TASK.md` §1.2 显式列为"禁止顺手实现"。

---

## 5. CEO / 董事长复审清单（Definition of Ready for Review）

复审时建议按以下顺序检查：

- [ ] `V1_2_FORECAST_SPEC.md` §2 的十个概念区分是否认可（尤其"规则型权重≠真实概率"的措辞是否满足业务对合规/风控表述的要求）。
- [ ] §4.2 的12因子三档权重表数值是否需要在实现前就调整（一旦Codex按此表实现并通过测试，后续调整需要重新走一轮spec变更流程）。
- [ ] §6-§9 的价格区间/情景目标/路径/失效条件算法是否符合对"专业交易预测面板"的产品预期。
- [ ] §10 的六条安全降级规则、§15 的十条禁止事项是否有遗漏的合规/风控要求需要补充。
- [ ] `V1_2_CODEX_IMPLEMENTATION_TASK.md` 的10步实施顺序是否可以直接作为Codex的工单下发。
- [ ] `V1_2_ACCEPTANCE_TESTS.md` 的T1-T20（目标60+项断言）是否覆盖了CEO关心的全部业务场景，是否需要补充新的T类别。
- [ ] 本文档§3风险清单中的6项是否有需要在实现前就解决、而非留到实现阶段再处理的。
- [ ] 确认本轮不涉及V1.1 Release/Tag的任何变更，`v1.1.0` 保持不动。

**本文档作者结论**：四份文档字段名/函数名/枚举值经交叉核查一致，权重表验算求和正确，安全红线术语扫描无正面违规表述，V1.1命名空间无冲突，V1.1/V2/V3边界清晰。**可以提交CEO复审。**
