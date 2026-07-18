# V1_4_HISTORICAL_VALIDATION_SPEC.md — V1.4 历史验证与误差归因规范

版本：v1.4-validation-draft-2（CEO本轮冻结裁决关闭P0-3/P0-4/P1-4后的修订版）
基线：`main` @ `a3d7aea`
角色：本文档是 **walk-forward切分方法、重叠样本处理、误差归因规则冻结** 的唯一权威文档。`GMKG_DRAGONFLY_ARCHITECTURE.md` 定义了`ErrorAttribution`类型与"`calibratedProbability`何时可从null变为数值"的门槛条件（§8.5），本文档在此基础上给出V1.4的**具体、可执行**方法学，不重新定义类型本身。

**红线（贯穿全文）**：本文档定义的是**V1.4 Walk-forward基础**，即"骨架"——按时间切分、不打乱、记录样本量、预留Brier Score占位。**不是**完整模型训练/参数寻优系统。任何实现代码**不得**在本文档定义的范围之外自行扩大到"自动调参""自动训练迁移权重"等超出V1.4范围的行为（见§7范围边界）。

---

## 1. 样本定义与生成节奏（红线：控制重叠样本规模的第一道防线）

### 1.1 生成节奏冻结

| 时间尺度 | `ForecastSnapshot`生成触发点 | 理由 |
|---|---|---|
| 24H | 每根**已收盘4小时K线**收盘时生成一次（即每4小时一次，`referenceBar`固定取该时刻最后一根已收盘15分钟K线） | 复用V1.1既有4小时HTF状态机的天然节奏作为触发点，不新增独立定时器；4小时间隔下，相邻两条24H预测的目标窗口重叠率为 (24-4)/24 ≈ 83%，仍需§3重叠处理，但比"每15分钟生成一次"（重叠率≈99%）显著改善 |
| 72H | 每根**已收盘24小时**（即每日UTC 00:00对应的4小时K线收盘时）生成一次 | 与24小时宏观节奏对齐，便于未来与日频宏观数据（若接入）对齐；相邻两条72H预测重叠率为 (72-24)/72 ≈ 67% |

**红线**：此生成节奏是V1.4的**工程实现节奏**，由`V1_4_CODEX_IMPLEMENTATION_TASK.md`落实为具体触发代码；本文档只冻结节奏本身及其对重叠率的影响，不得由Codex自行决定生成频率。

**红线（P1-4，CEO已冻结裁决，防止为凑样本量而改变节奏）**：
1. **24H预测每4小时最多生成一次**，**72H预测每日最多生成一次**——这是上限，不是建议值，不得在实现或未来任何版本中把72H提高到每12小时生成一次（那样虽然能更快积累`rawSampleCount`，但会把重叠率从67%推高到约83%，与"控制重叠样本规模"这一本节开篇即声明的目标直接矛盾）；
2. `rawSampleCount`与`effectiveSampleCount`**必须并列报告**（呼应§3.2红线2），不得只展示前者制造"样本充足"的错觉；
3. §4"最低样本量披露"要求的场景（`effectiveSampleCount`低于门槛）发生时，**必须诚实展示"样本不足"**，**不得**通过提高生成节奏、放宽`effectiveSampleCount`筛选条件等方式人为制造出大量高度重叠的样本、再包装成"样本量已经很充分"——样本积累速度慢是V1.4作为最小闭环的真实约束，不是需要被"优化掉"的工程缺陷。

### 1.2 样本记录范围

每条`ForecastSnapshot`（无论24H或72H）在生成时即计入"全量样本池"；`ForecastOutcomeEvent`完成回填（`pathEligibleForStatistics=true`或`directionEligibleForStatistics=true`）后才计入对应的"可统计样本池"。两个样本池分别按§3方法处理重叠问题。

---

## 2. 时间顺序切分（红线，不得随机打乱）

```
训练区间（Training）  ── 时间上最早的一段
验证区间（Validation）── 训练区间之后、测试区间之前
测试区间（Test）      ── 时间上最晚的一段

切分点固定为时间戳，不按样本数量均分（因为§1.1的生成节奏本身导致密度不均，按时间戳切分才能保证"训练区间只包含比验证/测试区间更早的信息"这一因果顺序）。
```

**红线**：三个区间**严格按时间先后排列，不重叠、不打乱、不随机抽样**——`STRATEGY_SPEC.md`§18.3已确立"数据集划分按时间顺序切分（不随机打乱）"的原则，本文档延续而非重新发明。**禁止**用随机打乱的时间序列训练或验证任何V1.4因子权重或阈值（呼应GMKG总架构§8.2/§18安全边界）。

**Walk-forward滚动**：在测试区间内进一步细分为多个滚动窗口——用窗口`[t0,t1)`内的样本做参数评估基准，紧接着的窗口`[t1,t2)`做样本外测试，窗口整体向前滚动，重复多轮（复用`STRATEGY_SPEC.md`§18.3已确立的滚动样本外验证设计，不重新发明）。V1.4阶段**只搭建这一滚动切分的脚手架**（即代码能够按时间戳把样本正确分配到"训练/验证/测试"三个桶、并能做多轮滚动切分），**不实现**任何基于滚动结果自动调整参数的闭环（那属于§7范围边界之外）。

---

## 3. 重叠样本处理（红线，防止"同一时间高度相关预测伪装成大量独立样本"）

### 3.1 问题定义

由于24H目标窗口长达96根15分钟bar、72H长达288根bar，即使按§1.1节奏生成（4小时/24小时一次），相邻预测的目标窗口仍然大幅重叠，其`actualReturn`/`directionCorrect`等结果高度相关（本质上是对同一段未来价格路径的多次部分重叠观测），**不构成统计意义上的独立样本**。

### 3.2 冻结规则：区分"全量样本"与"有效独立样本"（P0-3，CEO已冻结裁决，取代draft-1的`generatedAt`贪心算法）

**背景**：draft-1按`generatedAt`升序贪心选取的算法存在方法错误——排序键（`generatedAt`）与实际决定"是否重叠"的边界（`targetStartTime`/`targetEndTime`）不是同一个量纲，虽然二者高度相关，但不能保证正确性本身（区间调度问题必须按区间的**结束边界**排序才能保证"贪心=每一步都合法且不遗漏"）。CEO本轮已冻结为标准区间调度算法，不再是"以后可以优化"的次优方案，而是**唯一正确算法**：

```
第1步：按 instrument + horizon 分组（如 'ETH-24h'、'ETH-72h' 各自独立一组，见§3.3）。
第2步：只从该组"eligible"样本中选择——
  计算方向类effectiveSampleCount时，eligible = directionEligibleForStatistics === true 的样本；
  计算路径类（区间覆盖/MFE-MAE/RANGE专属）effectiveSampleCount时，eligible = pathEligibleForStatistics === true 的样本；
  两类eligible集合分别独立跑一次本算法，产生两个可能不同的effectiveSampleCount（呼应GMKG总架构两类统计分母独立红线）。
第3步：将eligible样本按 targetEndTime 升序排列；targetEndTime相同时，依次按 targetStartTime 升序、
  再按 predictionId（字符串）升序排序，确保排序结果完全确定（无并列歧义）。
第4步：选择排序后的第一条样本，计入effectiveSampleCount，记 lastSelected = 该样本。
第5步：沿排序结果继续向后扫描，只选择满足
  candidate.targetStartTime >= lastSelected.targetEndTime
  的下一条样本，选中后更新 lastSelected = candidate；不满足条件的样本跳过（不选中，但仍保留在rawSampleCount中）。
第6步：重复第5步直到排序列表结束，effectiveSampleCount = 最终选中样本总数。
```

**红线**：
1. `rawSampleCount` = 该组（`instrument+horizon`）内对应eligible集合的**全部**样本数（不做任何筛选，只区分方向类/路径类两个eligible集合）；`effectiveSampleCount`才是上述算法筛选后的非重叠子集大小；
2. 任何统计报告（方向准确率、区间覆盖率、未来Brier Score）**必须同时报告** `rawSampleCount`与`effectiveSampleCount`两个数字，**不得只报告`rawSampleCount`并暗示其为独立样本量**；
3. 样本量充分性判断（§4最低样本量门槛）**以`effectiveSampleCount`为准**，不得用`rawSampleCount`冒充满足门槛；
4. `rawSampleCount`可用于"描述性展示"（如UI上"近期共生成N条24H预测"），但**必须**在旁注明"含高度重叠样本，非独立统计意义上的N次验证"；
5. 本算法是**确定性算法**（同一输入集合必然产生同一输出），必须有对应的确定性单元测试（构造固定的`targetStartTime`/`targetEndTime`样本集合，验证选中结果与人工推算完全一致，见`V1_4_ACCEPTANCE_TESTS.md`对应测试）。

### 3.3 24H/72H各自独立处理

24H与72H的重叠子抽样**分别独立计算**，不得混合两个horizon的样本做同一个`effectiveSampleCount`（因为二者的目标窗口长度、生成节奏均不同，混合会产生无意义的抽样结果）。

### 3.4 `FormalTransitionRecord`/`ProxyTransitionRecord`分离（引用GMKG总架构§8.4，本节确认统计口径）

`PROXY_STATS`（V1.4当前唯一产出）与`FULL_STATE_STATS`（V1.4不产出）永久隔离，见 GMKG总架构 §8.4红线1。本文档的重叠样本处理规则**只适用于`ForecastSnapshot`/`ForecastOutcomeEvent`层面的方向/区间统计**，`ProxyTransitionRecord`本身的样本计数（`sampleSize`字段）是历史相似状态匹配的独立统计口径，与本节§3.2的"目标窗口重叠"问题是两回事，不得混淆处理规则。

---

## 4. 最低样本量披露（红线：不得伪造统计意义）

```
若 effectiveSampleCount < 30（24H）或 < 10（72H）：
  报告必须标注"样本不足，以下统计仅供描述性参考，不具备统计推断意义"
  isCalibrated（GMKG总架构§8.5）恒为false
若 effectiveSampleCount >= 门槛：
  报告可以正式声明"已达到最低样本量门槛"，但calibratedProbability是否能从null变为数值，
  仍需§8.5其余三项条件（walk-forward验证完成、校准误差达标、版本冻结）同时满足，样本量只是必要条件之一，不是充分条件。
```

**门槛数值来源说明**：`30`/`10`是统计学上"大样本近似"的通行经验下限（并非本文档凭空设定的"看似精确的数字"，而是明确标注为**保守起点**），随V1.4实际运行积累的数据分布，未来版本可在`V1_4_ARCHITECTURE_REVIEW.md`或后续版本中调整并递增`calibrationVersion`，本文档不预设"调整后的具体数字"（呼应GMKG总架构"不在数据都没有的情况下伪造看似精确的阈值"红线）。

---

## 5. 误差归因规则冻结（红线：结果发生前定义，防止事后解释）

### 5.1 V1.4可用归因原因子集（引用 GMKG总架构 §15.1/§15.2 `ErrorAttribution.primaryCause`枚举，本节冻结V1.4的可评估范围）

| `primaryCause`枚举值 | V1.4是否可评估 | 判定规则（若可评估） |
|---|---|---|
| `environment_misread` | **否，标记`NOT_EVALUABLE`** | 广度眼未真实运行（V1.4无`WorldState`真实数据），不得归因于"环境误判"，因为根本没有环境判断 |
| `target_state_misread` | **部分可评估**（代理层面） | 若`proxyState`判断的价格结构方向与`actualDirection`相反，且`pathEligibleForStatistics=true`，归因为"代理状态判断与实际路径不符"（记录为`target_state_misread`，但`attributionEvidence`必须注明"基于PRICE_ONLY_MODE代理状态，非正式S0-S7判断") |
| `proxy_transition_misread` | **可评估** | `ProxyTransitionRecord.transitionWeight`最高的候选迁移与实际观测到的`proxyState`变化不一致时归因于此 |
| `formal_transition_misread` | **否，标记`NOT_EVALUABLE`** | V1.4不产出`FormalTransitionRecord`，该模块未运行，不得归因 |
| `fusion_weight_error` | **否，标记`NOT_EVALUABLE`** | V1.4融合中枢未按GMKG总架构§11完整运行（`fusionState`只是§12.3的展示标签借用），不构成"融合权重"意义上的可归因对象 |
| `action_permission_error` | **否，标记`NOT_EVALUABLE`** | V1.4 `ActionPermission`恒为`DISPLAY_ONLY`且不影响任何真实行动，不存在"许可判断错误导致的后果" |
| `price_zone_error` | **可评估** | `expectedPriceZones`（baseline/upside/downside）与`realizedRangeInsideExpectedEnvelope`/`expectedEnvelopeTouched`结果对照，若预测区间系统性偏离实际路径，归因于此 |
| `data_missing_or_delayed` | **可评估** | `endpointDataComplete`/`pathDataComplete=false`导致`exclusionReasons`非空时，归因于此 |
| `data_revision` | **否，标记`NOT_EVALUABLE`**（V1.4当前无修订机制） | 已收盘现货K线`revisionNumber`恒为0（见`V1_4_FORECAST_DATA_SPEC.md`§8.4），V1.4阶段不存在数据修订场景；本枚举值的判定规则与存储占位保留，供未来接入有修订风险的数据源（宏观/ETF）时启用 |
| `exogenous_shock` | **否，标记`NOT_EVALUABLE`**（P0-4，CEO已冻结裁决，取代draft-1"可评估（粗粒度）"方案） | V1.4没有新闻、政策、宏观事件或`EventSnapshot`真实数据；仅凭价格剧烈变化**不能证明**是外生冲击（也可能是PRICE_ONLY_MODE代理判断本身失误、区间设定过窄、或数据缺口造成的假象），draft-1"价格波动超过`directionThreshold`若干倍即归因于此"的判定规则**因果证据不足**，本轮撤销，不再作为可评估的`primaryCause`；见下方`unexplainedExtremeMove`中性观测标记 |
| `execution_or_risk_param_error` | **否，标记`NOT_EVALUABLE`** | V1.4 24H/72H预测不产生任何执行/风险参数（`ActionPermission.mode`恒为`DISPLAY_ONLY`），不存在可归因的执行层错误 |

### 5.2 `NOT_EVALUABLE` 的记录方式（红线，不得强行归因到未运行模块）

```ts
// 引用GMKG总架构§15.2 ErrorAttribution，V1.4使用规则：
{
  primaryCause: 从§5.1"可评估"或"部分可评估"子集中选取（exogenous_shock本轮起不再是合法取值，见§5.1/§5.2a），
  secondaryCauses: 同上子集内的其他项，
  attributionEvidence: [...],
  attributionConfidence: number,  // V1.4阶段"部分可评估"/"粗粒度"类的置信度必须显式压低（建议<=50）
  requiresHumanReview: boolean,
  notEvaluableCauses: string[],   // V1.4新增字段（GMKG总架构未定义，本文档补充）：列出§5.1中标记NOT_EVALUABLE的枚举值
                                   // （含exogenous_shock，本轮新划入），显式声明"这些原因当前无法评估，不是排除了它们，是模块未运行"
  attributionRuleVersion: 'v1.4-attribution-rule-1'  // 见§5.3版本冻结
}
```

**红线**：`notEvaluableCauses`必须**显式列出**，不得省略——省略等于让读者误以为"这些原因已经被排除"，而事实是"根本没有能力判断"，两者天差地别（呼应GMKG总架构§15.3"不得事后凭感觉强迫只选择一只眼作为错误来源"红线的反面：也不得强行给尚未运行的模块打上"没问题"的标签）。

### 5.2a `unexplainedExtremeMove` 中性观测标记（P0-4新增，取代`exogenous_shock`可评估方案）

**背景**：draft-1把"价格剧烈波动"直接归因为`exogenous_shock`（外生冲击），这是一个**因果声称**——"这次预测错了是因为发生了外部冲击"。V1.4没有新闻/事件数据能证明"确实发生了外生冲击"，这个因果声称本身无法被验证，属于"看到极端结果就编一个听起来合理的原因"的事后解释，CEO本轮裁决予以撤销。

```ts
interface UnexplainedExtremeMoveFlag {
  unexplainedExtremeMove: boolean;   // 或等价的diagnostic flag命名，具体命名由实现阶段确定，语义必须与本节一致
  observedMagnitude: number;         // 实际观测到的偏离幅度（相对directionThreshold的倍数），纯描述性数值
  thresholdMultiple: number;         // 触发该标记所用的倍数阈值（如3倍directionThreshold），随算法版本冻结
}
```

**冻结规则（红线）**：
1. `unexplainedExtremeMove`（或等价命名的诊断标记）**只描述一个客观观测事实**："本次评估窗口内发生了一次现有PRICE_ONLY证据无法解释的极端价格波动"，**不得声称**这一观测的**原因**是什么（不得写成"检测到外生冲击"，只能写"检测到无法由现有证据解释的极端波动"）；
2. 该标记**不得**成为`ErrorAttribution.primaryCause`的合法取值，也**不得**作为`secondaryCauses`的成员——它是`ErrorAttribution`记录中的一个**独立的、并列的诊断字段**，不混入`primaryCause`/`secondaryCauses`枚举体系；
3. 触发该标记不免除`primaryCause`仍必须从§5.1"可评估"/"部分可评估"子集中选取（或所有可评估原因都不成立时，`primaryCause`可以是`data_missing_or_delayed`这类真正可核实的原因，也可以在极端情况下保留为需要`requiresHumanReview=true`的人工复核项，但**不得**填`exogenous_shock`）；
4. `thresholdMultiple`具体数值与`unexplainedExtremeMove`判定逻辑本身必须与`attributionRuleVersion`一起冻结（见§5.3），不得随意调整。

### 5.3 版本冻结（红线）

`attributionRuleVersion = 'v1.4-attribution-rule-1'`——本节§5.1的判定规则表**必须**在V1.4代码实现前一并冻结、随代码提交，**不得**在看到实际预测结果之后才现场决定某次错误该归因到哪一项（GMKG总架构§15.3红线的具体落地）。未来若接入新数据源使某个`NOT_EVALUABLE`原因变为可评估，必须递增此版本号，不得静默改变判定规则。

---

## 6. Brier Score 占位（红线：只预留，不伪造）

```
brierScoreComponent（单条样本） = (calibratedProbability_预测值 − 实际结果的0/1指示变量)²
```

**红线**：
1. 上述公式**只是数学定义占位**，V1.4阶段`calibratedProbability`恒为`null`（GMKG总架构§8.2/§8.5红线），因此`brierScoreComponent`在V1.4阶段**无法计算**，字段恒为`null`，**不得**用`scenarioWeights`（规则型权重）冒名顶替`calibratedProbability`去凑出一个"看似有效"的Brier Score；
2. 只有未来版本满足GMKG总架构§8.5的全部四项门槛（最低样本量、walk-forward完成、校准误差达标、版本冻结）后，`calibratedProbability`才可能非null，届时Brier Score才有意义；
3. 本文档只预留这一计算公式的**存在**，供未来版本直接复用，不在V1.4阶段执行、不在任何V1.4报告中展示一个"伪造的"Brier Score数值。

---

## 7. V1.4 Walk-forward基础的范围边界（红线，防止Codex自行扩大）

### 7.1 V1.4 必须实现

1. 按§1.1节奏生成`ForecastSnapshot`并独立存储；
2. 按§2时间顺序（非随机）把样本分配到训练/验证/测试三个区间，能够指定切分时间点；
3. 按§3计算`rawSampleCount`与`effectiveSampleCount`并在报告中同时展示；
4. 按§5.1冻结的归因规则对已回填样本做`primaryCause`/`notEvaluableCauses`标注；
5. `brierScoreComponent`字段占位存在，恒为`null`；
6. 滚动窗口切分的**脚手架代码**（能够把测试区间进一步切成多个滚动子窗口），但不要求真正跑出"多轮参数调优结果"的报告。

### 7.2 V1.4 不得实现（超出范围）

1. 不得实现任何"根据测试结果自动调整`directionThreshold`/PO_\*阈值/`scenarioWeights`打分表"的自动化闭环——阈值调整只能通过人工修改`V1_4_FORECAST_DATA_SPEC.md`并递增版本号来完成（呼应`V1_2_FORECAST_SPEC.md`已确立的版本号红线）；
2. 不得实现`calibratedProbability`的实际赋值逻辑（§8.5门槛在V1.4阶段不可能全部满足，因为样本积累时间不够）；
3. 不得实现跨24H/72H的"合并模型"或"合并校准"（§3.3已冻结二者独立处理）；
4. 不得实现真正的Brier Score计算与展示（§6红线2）；
5. 不得因为"想让walk-forward看起来更完整"而自行接入§2.2列出的B/C层数据源。

---

## 8. 与其他文档的接口

- 本文档消费 `V1_4_FORECAST_DATA_SPEC.md` 产出的 `ForecastSnapshot`/`ForecastOutcomeEvent`（字段唯一权威定义在GMKG总架构+该文档，本文档不重复）；
- 本文档的§5归因规则表是 `V1_4_ACCEPTANCE_TESTS.md` 相应误差归因测试用例的判定依据；
- 本文档的§3重叠样本处理规则、§4最低样本量披露是 `V1_4_ARCHITECTURE_REVIEW.md` 审查"统计分母是否被污染""重叠预测样本是否被伪装成独立样本"两项风险的判据。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4-validation-draft-1 | 2026-07-18 | 初稿：冻结24H/72H生成节奏、时间顺序切分与滚动walk-forward脚手架范围、重叠样本"全量/有效独立"双口径、最低样本量披露、误差归因V1.4可评估子集与`NOT_EVALUABLE`记录方式、Brier Score占位红线、V1.4 Walk-forward基础的范围边界（防止Codex自行扩大为完整模型训练） |
| v1.4-validation-draft-2 | 2026-07-18 | CEO本轮冻结裁决：①§3.2重写`effectiveSampleCount`算法为标准区间调度（按instrument+horizon分组→取eligible样本→按targetEndTime/targetStartTime/predictionId排序→贪心不重叠选择），取代draft-1按generatedAt排序的贪心算法（P0-3）；②§5.1把`exogenous_shock`改列`NOT_EVALUABLE`，新增§5.2a `unexplainedExtremeMove`中性观测标记，不构成因果声称、不进入primaryCause/secondaryCauses（P0-4）；③§1.1新增红线：24H/72H生成节奏为上限而非建议值，不得为凑样本量提高频率，样本不足须诚实披露（P1-4） |
