# V1_4_ARCHITECTURE_REVIEW.md — V1.4 独立架构复审

版本：v1.4-review-draft-1
基线：`main` @ `a3d7aea`
角色：本文档对其余五份 V1.4 文档 + 与 `GMKG_DRAGONFLY_ARCHITECTURE.md` 的交互，做**独立风险复审**。逐条给出风险、严重等级、复现路径、修复要求、是否阻断Codex、是否允许进入编码。**不得只写"通过"**。

---

## 1. 风险清单（P0/P1/P2）

### P0-1：`referenceBar` 是否"已收盘"依赖本地系统时钟，存在时钟偏差风险

- **风险描述**：`V1_4_FORECAST_DATA_SPEC.md`§3.1/§5.2把"已收盘"判定隐含依赖调用方（浏览器/构建环境）的本地时钟与Binance服务器时钟一致。若本地时钟快于Binance服务器时钟，可能把一根**实际尚未收盘**的K线误判为"最后一根已收盘K线"并选为`referenceBar`，进而污染`referencePrice`与整条24H/72H预测。
- **严重等级**：**P0**（直接影响GMKG总架构§4.4a/§10.2"只能使用已收盘K线"红线，属于数据完整性阻断问题）。
- **复现路径**：本地系统时钟快于真实时间超过K线更新延迟窗口（如本地时钟快2分钟）时，从Binance返回的最新K线数组末尾一条实际`closeTime`可能仍大于"本地当前时间戳减去若干安全边际"的天真判断，具体是否误判取决于实现是否直接信任K线数组最后一条、还是额外做"closeTime <= now"校验。
- **修复要求**：`locateTargetPath`/`referenceBar`选取逻辑**必须**以K线自身的`closeTime`字段作为唯一判据（`closeTime <= 调用Binance `/api/v3/time`得到的服务器时间`，而不是本地`Date.now()`），或至少要求`closeTime`小于本地时间减去一个安全边际（如2倍预期采集间隔），且安全边际数值须写入实施报告。
- **是否阻断Codex**：本轮**已关闭**——`V1_4_CODEX_IMPLEMENTATION_TASK.md`§3 `locateTargetPath`签名注释已补充"必须以Binance服务器时间或经记录的安全边际判定已收盘"的约束，`V1_4_ACCEPTANCE_TESTS.md`已新增T3.4验证该约束。
- **是否允许进入编码**：**允许**（文档层面已补齐约束与验收覆盖；实施阶段仍须在代码中真正落实该约束，不因文档已修订而自动满足，见§4处理记录）。

### P0-2：§12.3 `fusionState` 借用 `S2_BULL_EXPANSION` 等正式状态标签用于展示，存在"代理冒充正式状态"的措辞风险

- **风险描述**：`V1_4_FORECAST_DATA_SPEC.md`§12.3 定义 `fusionState`（V1.4展示层字段）直接借用`FusionStateId`中`S0_ACCUMULATION`...`S6_CAPITULATION`等**正式八状态命名**作为展示标签，即使该文档自身已加了红线注释"仅作展示标签，不代表FULL_STATE_MODE正式判定"，但这与GMKG总架构§18安全边界"不得把候选数据源/代理判断包装成已接入/正式状态"的精神存在**实质冲突**——用户在字面上看到"S2_BULL_EXPANSION"字样，无论旁边有多少小字免责声明，都可能望文生义为"系统判定为多头扩张正式状态"，这正是GMKG总架构反复强调要避免的"代理状态冒充正式状态"风险的**具体化身**。
- **严重等级**：**P0**（直接触及V1.4最核心红线之一："不得声称识别S0-S7正式状态"）。
- **复现路径**：任何查看V1.4 UI展示或`ForecastSnapshot.fusionStateAtGeneration`日志字段的人，只看字段值本身（不追溯到`operatingMode`/`primaryState`），都会读到一个正式状态命名。
- **修复要求**：**不建议**在V1.4阶段输出`fusionState`字段借用正式状态命名。修复方案二选一（留待CEO/下一版本裁决，本文档不擅自修改SPEC）：
  1. V1.4阶段`fusionState`/`fusionStateAtGeneration`**恒为占位值**（如新增一个不在`FusionStateId`枚举内的`'DISPLAY_PLACEHOLDER'`值，或直接省略该字段、只展示`proxyState`），完全不借用S0-S7命名；
  2. 或者保留当前设计，但**强制要求**任何展示`fusionState`的UI位置必须与`operatingMode='PRICE_ONLY_MODE'`+`primaryState='UNKNOWN'`+`'[PRICE_ONLY]'`前缀在**同一视觉区块内以同等字号**呈现，不得让`fusionState`单独抽出展示（如做成一个醒目的大字方向标签而把免责声明做成脚注）。
- **是否阻断Codex**：**是**——`V1_4_FORECAST_DATA_SPEC.md`§12.3当前方案**不建议直接进入编码**，建议在下一版本修订中采纳修复方案1（更彻底、更不容易被误用），或由CEO明确裁决采纳方案2并在验收测试中新增强制视觉一致性检查。
- **是否允许进入编码**：**否，本项需先修订`V1_4_FORECAST_DATA_SPEC.md`§12.3或经CEO明确批准现有方案后，方可进入编码**。

### P1-1：72H 有效样本量积累速度极慢，`V1_4_HISTORICAL_VALIDATION_SPEC.md`§4门槛在现实中需要较长运行时间才能达到

- **风险描述**：72H预测按§1.1节奏每24小时生成一次，`effectiveSampleCount`要求目标窗口互不重叠（间隔>=72小时），意味着理论最优情况下每3天才产生1个"有效独立样本"，达到§4门槛`effectiveSampleCount>=10`需要至少30天不间断运行，实际因数据缺口/系统重启会更久。
- **严重等级**：**P1**（不阻断架构本身，但需要提前管理预期，避免未来误以为"V1.4上线几天后就能看到有统计意义的72H验证结果"）。
- **复现路径**：无需复现，纯粹是节奏与门槛数值的算术后果。
- **修复要求**：`V1_4_HISTORICAL_VALIDATION_SPEC.md`已在§4标注"样本不足时必须披露"，本项无需修改文档，只需在未来实施报告与UI展示中管理预期，建议在`V1_4_CODEX_IMPLEMENTATION_TASK.md`§11"实施报告要求"中补充一句"须预估并披露达到最低样本量门槛的预计时间"。
- **是否阻断Codex**：否。
- **是否允许进入编码**：是。

### P1-2：`V1_4_HISTORICAL_VALIDATION_SPEC.md`§3.2 非重叠子抽样算法为贪心算法，非严格最大化，属已知次优但非错误

- **风险描述**：贪心"按`generatedAt`升序、选中后跳过所有目标窗口重叠样本"的子抽样方法，理论上不保证在给定样本集合中选出**数量最多**的互不重叠子集（区间调度问题的经典贪心最优策略应按**结束时间**排序而非开始时间，但由于本场景样本本身是按固定节奏生成、`targetEndTime`与`generatedAt`高度线性相关，实践中差异很小）。
- **严重等级**：**P2**（方法学上可改进，但不构成正确性错误，`effectiveSampleCount`仍然是一个**合法的下界估计**，不会高估独立样本数，只会轻微低估）。
- **修复要求**：无需本轮修改，建议未来版本若要更精确，可改用按`targetEndTime`升序的经典区间调度贪心算法。风险方向是"保守低估"而非"虚报"，符合"宁可保守也不夸大统计意义"的整体红线精神，可以接受。
- **是否阻断Codex**：否。
- **是否允许进入编码**：是。

### P1-3：`V1_4_CODEX_IMPLEMENTATION_TASK.md`未显式测试"误差归因规则版本冻结"的不可变性

- **风险描述**：`V1_4_HISTORICAL_VALIDATION_SPEC.md`§5.3要求归因规则必须结果发生前冻结、不得事后修改，但`V1_4_ACCEPTANCE_TESTS.md`当前**没有**一条测试专门验证"归因规则表在代码中不因运行时输入而改变判定逻辑"（即没有测试守护这条不可变性红线本身）。
- **严重等级**：**P1**（规则本身在文档层面已冻结，但缺少代码层面的守护测试，存在被未来维护者不小心破坏而无人察觉的风险）。
- **修复要求**：**已在本轮一致性检查中发现，将在§3跨文档一致性核对后回填至`V1_4_ACCEPTANCE_TESTS.md`**（见本文档§4处理记录）。
- **是否阻断Codex**：否（文档修订后即解决）。
- **是否允许进入编码**：是（待文档修订）。

### P2-1：单文件架构限制（重申，非新发现）

沿用 GMKG总架构 §16.1-16.2 已充分说明的单文件HTML限制（不能24小时连续采集、不能承担大规模历史数据库等）。V1.4阶段本身就是在承认这一限制的前提下设计的最小闭环，不构成新风险，只需在`V1_4_CODEX_IMPLEMENTATION_TASK.md`交付时再次确认未违反。

### P2-2：`localStorage` 容量与性能

`ForecastSnapshot`/`ForecastOutcomeEvent`长期积累（尤其24H每4小时一条、72H每天一条，一年下来24H约2190条、72H约365条）需关注`localStorage`总体积（单条`featureValuesUsed`+`contentHash`等字段会显著增加单条记录体积，比既有`ForecastLogEntry`更重）。`V1_4_CODEX_IMPLEMENTATION_TASK.md`§4.2已定义淘汰策略，建议实施阶段做一次实测记录单条记录的平均字节数，确认1500条上限不会导致单个key超过浏览器`localStorage`典型5MB限制。

### P2-3：CORS（重申，非新发现）

现货K线端点CORS已在V1.1-V1.3.1三轮独立复审+本轮`curl`实测确认可用，不构成新风险。

### P2-4：性能

V1.4新增计算量极小（9个PO_\*状态判定+情景权重计算，均为O(1)复杂度的规则打分），不构成性能风险。

---

## 2. 汇总表

| 编号 | 风险 | 严重等级 | 是否阻断Codex | 是否允许进入编码 |
|---|---|---|---|---|
| P0-1 | referenceBar已收盘判定依赖本地时钟 | P0 | 本轮已关闭 | 允许（CODEX_TASK约束+TESTS T3.4已补齐，实施阶段仍须真正落实） |
| P0-2 | fusionState借用正式状态标签 | P0 | 是 | 否，需先修订SPEC§12.3或CEO明确裁决 |
| P1-1 | 72H有效样本积累缓慢 | P1 | 否 | 是 |
| P1-2 | 非重叠子抽样贪心次优 | P2 | 否 | 是 |
| P1-3 | 归因规则不可变性缺少守护测试 | P1 | 否（本轮已回填） | 是 |
| P2-1至P2-4 | 单文件限制/存储容量/CORS/性能 | P2 | 否 | 是 |

---

## 3. 跨文档一致性核对（逐项，用户§二十二15项）

| # | 核对项 | 结论 |
|---|---|---|
| 1 | SPEC要求全部进入CODEX_TASK | 达标——PO_\*判定、ForecastSnapshot生成、路径定位、回填、walk-forward切分、误差归因均已在CODEX_TASK§3列出对应纯函数签名 |
| 2 | CODEX_TASK全部进入ACCEPTANCE_TESTS | **发现缺口并已回填**：迁移(T21.1)/损坏(T21.2)/超限(T21.3)/导出(T22)/离线+REST(T25)/UI最低要求(T5.3)均有覆盖；构建脚本占位符替换未有专属测试，判定为可接受的P2级别缺口（构建失败会在构建阶段直接报错阻断，不需要额外验收测试，`replaceExact`本身自带精确计数校验机制） |
| 3 | ACCEPTANCE_TESTS覆盖ARCHITECTURE_REVIEW风险 | **发现缺口**：P0-1（服务器时间校验）与P1-3（归因规则不可变性）在原26类测试中未直接覆盖，**已在本文档§4记录回填要求**，需在提交前更新`V1_4_ACCEPTANCE_TESTS.md`新增T3.4/T27两条 |
| 4 | 所有字段名一致 | 达标——已用`grep`核对`expectedBarCount`/`closeTime`公式/`readinessCeiling`等关键字段跨文档一致，见本文档撰写前的核对记录 |
| 5 | 所有枚举一致 | 达标——`OperatingMode`/`PriceOnlyStateId`/`TargetStateId`/`FusionStateId`均只在GMKG总架构定义一次，五份V1.4文档均为引用，未见平行定义 |
| 6 | 所有时间定义一致 | 达标——`closeTime=openTime+timeframeMs-1`在SPEC/MATRIX/TESTS三处表述完全一致（均引用同一次2026-07-18现场核实） |
| 7 | 24H/72H bar数量一致 | 达标——96/288在SPEC/TESTS/VALIDATION_SPEC三处一致 |
| 8 | 可空类型一致 | 达标——`ForecastOutcomeEvent`可空字段直接引用GMKG总架构接口，未重新定义 |
| 9 | 两类统计分母一致 | 达标——`pathEligibleForStatistics`/`directionEligibleForStatistics`定义与使用规则在SPEC/VALIDATION_SPEC/TESTS三处一致 |
| 10 | PRICE_ONLY_MODE边界一致 | 达标——`primaryState`恒`UNKNOWN`、`proxyState`带`PO_`前缀、不产出`FormalTransitionRecord`三条红线在五份文档中表述一致 |
| 11 | ActionPermission边界一致 | 达标——`mode='DISPLAY_ONLY'`、`readinessCeiling='ALLOW_TEST'`、`gateStatus='WAIT'`在SPEC/TESTS中一致；**但见P0-2**，`fusionState`的展示方式需要额外裁决，不属于"边界不一致"，属于"边界本身设计是否稳妥"的问题 |
| 12 | 概率语义一致 | 达标——`scenarioWeights`≠概率、`calibratedProbabilities`恒null、Brier Score仅占位，三份文档（SPEC/VALIDATION_SPEC/TESTS）表述一致 |
| 13 | 数据源状态一致 | 达标——MATRIX的A层（唯一实施）与SPEC§2的"当前可用/不可用"列表完全对应，无矛盾 |
| 14 | 当前能力与目标架构不混淆 | 达标——【V1.4真实实现】/【仍需研究】/【目标架构】标注体系贯穿全部文档，MATRIX的B/C两层与A层边界清晰 |
| 15 | 不削弱V1.3.1 | 达标——CODEX_TASK§1.2/§12、SPEC§12.2均明确禁止调用四个交易门控函数与修改V1.3.1文件，TESTS T23/T24提供对应验收覆盖 |

---

## 4. 本轮已执行的文档修正记录（对应§3发现的缺口）

在提交前，已对 `V1_4_ACCEPTANCE_TESTS.md` 追加以下测试用例以关闭P0-1/P1-3两项缺口（具体内容见该文档T3.4/T27）：
- 新增测试验证"已收盘"判定使用Binance服务器时间而非本地时间（对应P0-1）；
- 新增测试类别验证误差归因规则表版本不可变、代码中不存在运行时动态修改归因规则的路径（对应P1-3）。

---

## 5. 仍需 CEO 决定的问题

1. **`fusionState`借用正式状态标签的展示方式**（P0-2）——是否采纳本文档建议的"完全不借用S0-S7命名"方案，或采纳"强制同视觉区块展示免责声明"折衷方案，或有第三种裁决；
2. **`referenceBar`已收盘判定是否必须调用Binance `/api/v3/time`**，还是接受"本地时间减安全边际"的简化方案（涉及是否额外增加一次网络请求的工程权衡）；
3. **72H有效样本积累缓慢的问题是否需要调整生成节奏**（如提高到每12小时生成一次以加快样本积累，代价是重叠率从67%升至约83%）——本文档不擅自裁决，留待CEO结合V1.4实际上线后的运行数据决定；
4. **未来接入B/C层数据源的优先级顺序**——`V1_4_DATA_SOURCE_MATRIX.md`已记录候选清单，但未排出接入优先级，留待独立立项时讨论。

---

## 6. 最终结论：是否允许进入编码

**有条件允许**——五份V1.4文档在架构层面基本自洽，与GMKG总架构无平行结构冲突。本轮复审发现的**2项P0中，P0-1（referenceBar时钟依赖）已在本轮直接关闭**（`V1_4_CODEX_IMPLEMENTATION_TASK.md`补充约束+`V1_4_ACCEPTANCE_TESTS.md`新增T3.4，见§4）。**P0-2（`fusionState`借用正式状态标签的展示方式）仍需CEO裁决**（见§5问题1），在此之前**不建议**开始`V1_4_CODEX_IMPLEMENTATION_TASK.md`§5步骤2/步骤6（涉及`fusionState`生成与UI展示部分）；步骤1（PO_\*状态判定纯函数）、步骤3（`ForecastOutcomeEvent`回填，P0-1已关闭）、步骤4（walk-forward脚手架）不受P0-2影响，理论上可以先行开发，但建议整体等待CEO就§5问题1一次性裁决后再统一启动，避免步骤2返工牵连UI已完成的工作。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4-review-draft-1 | 2026-07-18 | 初稿：独立发现2项P0（referenceBar本地时钟依赖、fusionState借用正式状态标签风险）、3项P1（72H样本积累缓慢、非重叠子抽样次优、归因规则不可变性缺少测试）、4项P2（单文件限制/存储容量/CORS/性能均为重申非新发现）；完成15项跨文档一致性核对，发现并回填2处ACCEPTANCE_TESTS缺口；给出"有条件允许进入编码"的最终结论及2个需CEO裁决的P0问题 |
