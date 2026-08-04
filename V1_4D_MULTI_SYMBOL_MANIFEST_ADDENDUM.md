# V1_4D_MULTI_SYMBOL_MANIFEST_ADDENDUM.md — 多symbol Dataset Manifest 冻结规范补充

版本：v1.4d-multi-symbol-addendum-draft-1
基线：本附录建立在 `codex/v1.4d-execution-package2-p0-fixes@6b1f83d70a697da220acc930a16d41ff2930b591`（其父提交为 `main@e493abbe0720a7cdf7e268b1c95b8587302ddc79`）之上，即已包含 migration 006（`fixed_as_of`/`logical_window_hash`/advisory-lock并发治理/SQL级`vintage_id=ANY()`治理）落地之后的代码状态。**不得**从其他SHA创建、不得合并main、不得变基本提交。
角色：本文档是 P0-3（多symbol依赖治理）的**唯一权威架构裁决与契约冻结文档**——正式采纳"单一多symbol Dataset Manifest"模型（而非关联/链式Manifest模型）。本文档**补充并局部覆盖**`V1_4D_HISTORICAL_REPLAY_SPEC.md`（draft-4）中与单symbol假设相关的条款，其余四份draft-4文档未被本文档触及的条款继续完全有效。

**红线（贯穿全文，与既有五份文档一致）**：本文档只冻结规范，**不修改任何生产代码、不执行任何数据库Migration、不运行正式Backfill/Manifest构建/Feature Backfill/Replay/Evaluation/Validation Report**。

---

## 0. 本轮背景与文档间优先级/冲突处理机制

### 0.1 触发原因

提交`6b1f83d`已实现P0-3的**安全fail-closed下半场**——`historical-feature-backfill.js`的`validateInputsWithinManifest`能正确拒绝缺失BTCUSDT 15m依赖的场景，`PostgresRepository.loadHistoricalFeatureInputs`使用`vintage_id = ANY(...)`杜绝了"读取整库未治理K线"的旁路——但**没有获得合法的多symbol契约**：`dataset_manifests`表结构与`buildDatasetManifest`函数签名仍然只承认标量`symbol`字段，`intervals`字段仍隐含"该symbol覆盖这些周期"的单symbol假设。这意味着当前唯一能通过治理检查的方式，是**人工/临时构造**一个"看起来涵盖ETH+BTC"但实际上没有被规范承认、没有确定性哈希契约、没有依赖矩阵冻结定义的manifest，这不满足"直接交给Codex实施、独立可验收、无关键歧义"的要求。**执行包2维持REQUEST CHANGES结论**，本文档的目的是关闭这一契约缺口。

### 0.2 架构裁决：单一多symbol Manifest（正式采纳，非重新论证）

**裁决**：P0-3采用**单一多symbol Dataset Manifest**模型——一份Manifest（一个`dataset_version`）在同一组`fixed_as_of`/`from`/`to`/source/market语义下，**同时**治理 ETHUSDT 15m / ETHUSDT 1h / ETHUSDT 4h / BTCUSDT 15m 四个依赖，而非"多份彼此关联/链接的单symbol Manifest"。

**理由（裁决依据，不再重新论证，仅记录结论供追溯）**：ETH→BTC的依赖关系是`server/src/features/feature-engine.js`的`FEATURE_BAR_DEPENDENCIES`硬编码固定关系，不是运行时动态可变的依赖图；关联Manifest模型会引入"多份Manifest之间的跨Manifest一致性"这一本可避免的额外正确性风险（例如两份被关联的Manifest各自`fixed_as_of`不同步、各自`logical_window_hash`独立冲突检测但整体窗口并未真正对齐等一类新问题），而不会带来对应的复用收益（因为每份Manifest本就需要为其覆盖范围完整构建自己的内容哈希，不存在"跨run共享一份BTC Manifest、只重建ETH Manifest"这种有意义的增量复用场景——BTC依赖每次都必须与本次ETH窗口共享同一`fixed_as_of`重新验证）。单一Manifest模型在数据模型层面即结构性排除了这整类问题。

### 0.3 与既有五份draft-4文档的关系（优先级与冲突处理机制，闭环一致性自检第1/2项）

| 既有文档 | 是否与本附录存在条款冲突 | 处理方式 |
|---|---|---|
| `V1_4D_HISTORICAL_REPLAY_SPEC.md`（draft-4） | **是**——§2.8`dataset_manifests`表定义、§2.9`dataset_version`哈希绑定字段清单、§4.0/§4.1 CLI契约、§4.1a八步校验流程均建立在"一个manifest=一个symbol"假设上；此外该文档draft-4文本本身**尚未反映**migration 006已新增的`fixed_as_of`/`logical_window_hash`列（该列是在draft-4冻结之后、执行包1/2的P0修复轮次中直接加到代码里的，未回填进本文档文本——这是本附录动笔前就已存在的文档-代码漂移，不在本附录处理范围，本附录第五节仅如实引用该现状，不重新定义这两个字段本身的既有语义） | **本附录对上述条款具有明确的、限定范围的优先权**：凡本附录第二~十节对同一概念给出了新定义（`manifest_contract_version`、`symbols`、`dependency_set`、多symbol版本的内容哈希/逻辑窗口哈希/成员身份/校验流程），以本附录为准；`V1_4D_HISTORICAL_REPLAY_SPEC.md`draft-4原文对**契约版本1（legacy单symbol）**manifest的全部定义（哈希算法、CLI、八步校验、可变性分类等）**继续完全有效、不被修改、不被本附录废止**——本附录是"新增一个可与旧契约版本并存的新版本"，不是"替换旧版本" |
| `V1_4D_DATA_BACKFILL_SPEC.md`（draft-4） | 否——该文档§2.10已明确声明"`dataset_version`/`dataset_manifests`结构唯一权威定义已迁移至`V1_4D_HISTORICAL_REPLAY_SPEC.md`，本文档不重复定义"，本身不含与本附录冲突的结构性条款；其§2.1"15m/1h/4h必须同步补齐"的回填范围表述与本附录§四冻结的依赖矩阵（ETHUSDT 15m/1h/4h）完全一致，无需修改；该文档未提及BTCUSDT回填范围，本附录第四节补充冻结"BTCUSDT 15m必须与ETHUSDT三周期共享同一`--from`/`--to`回填窗口"这一新增要求（原文档未来若需要执行BTCUSDT回填，直接适用本附录第四节，不需要现在修改该文档正文——按"不为了形式修改冻结文件"的要求，本轮不改动该文件） | 无需修改，交叉引用生效 |
| `V1_4D_ACCEPTANCE_TESTS.md`（draft-4） | 否（结构性）——R28是本附录及后续实施治理记录承载的新增验收范围，不修改任何既有R1-R27条款 | draft-4正文保持逐字冻结；R28映射仅记录在本附录第十二节和实现测试中，未回写该冻结文档 |
| `V1_4D_CODEX_IMPLEMENTATION_TASK.md`（draft-4） | 否（结构性）——该文档§1.1对`dataset-manifest-builder.js`/`dataset-manifest-verifier.js`/`canonical-manifest-content.js`的任务描述继续保留其冻结时的单symbol范围 | draft-4正文保持逐字冻结；契约版本2的实施边界由本附录第十三节及后续实施治理记录承载，未回写该冻结文档 |
| `V1_4D_ARCHITECTURE_REVIEW.md`（draft-4） | 否（文本不变）——其`READY_FOR_CODEX_IMPLEMENTATION`结论只适用于原draft-4范围，不自动覆盖后续多symbol治理 | draft-4正文保持逐字冻结；多symbol范围的架构裁决与实施状态由本附录及后续独立复审记录承载，未追加或追溯修改该冻结文档 |

### 0.4 术语约定

- **契约版本1 / legacy单symbol Manifest**：`manifest_contract_version = 1`，即draft-4原始定义的Manifest形状（标量`symbol`字段），本附录发布前已存在或未来仍可能按旧CLI路径构建的Manifest。
- **契约版本2 / 多symbol Manifest**：`manifest_contract_version = 2`，本附录冻结的新契约。
- 除非特别说明"契约版本1"，本附录下文全部条款针对**契约版本2**。

---

## 一、Manifest契约版本（`manifest_contract_version`）

1. 新增列`historical_validation.dataset_manifests.manifest_contract_version`（integer，NOT NULL），取值集合冻结为`{1, 2}`，由数据库CHECK约束`dataset_manifests_contract_version_known`强制（见第十二节migration 007）。
2. `manifest_contract_version`是一个**显式持久化列**，不得通过"某字段是否为空"做模糊推断（例如"`symbols`列非空就当作版本2"）——`manifest_contract_version`本身就是唯一权威判据，任何读取路径（CLI/verifier/report/诊断脚本）**必须**优先读取该列，**禁止**用字段存在性做二次推断或交叉验证式的"猜测"。
3. 契约版本1与版本2在同一张表内**结构性互斥**（见第十二节`dataset_manifests_contract_v1_shape`/`dataset_manifests_contract_v2_shape`两条CHECK约束）：版本1要求`symbol`非空且`symbols`/`dependency_set`必须为NULL；版本2要求`symbol`必须为NULL且`symbols`/`dependency_set`必须为非空数组、且`fixed_as_of`/`logical_window_hash`必须非空。
4. **未知版本号必须fail-closed**：
   - 数据库层：CHECK约束`dataset_manifests_contract_version_known`拒绝写入`{1,2}`以外的任何整数值——这是防止应用层bug意外写入未定义版本的最后防线。
   - 应用层（`dataset-manifest-verifier.js`）：读取到`manifest_contract_version`时，若该值不在**当前部署的代码已知处理**的版本集合内（例如未来出现版本3但本轮代码只认识1和2），或该值虽合法存在但**不满足当前操作所要求的最低版本**（例如契约版本2专属的多symbol Feature Backfill流程被传入一份契约版本1的Manifest），**统一**返回错误码`DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED`（详见第九/第十节，两种触发条件共用同一错误码，因为对调用方而言都是"这份Manifest的契约版本不满足我这次操作的需要"这一个语义，不需要为"完全未知的版本号"与"已知但版本过旧"分别定义两个错误码制造不必要的复杂度）。
5. `dataset_type`（新增列，text NOT NULL，本轮冻结唯一取值`'MARKET_BARS'`，由CHECK约束`dataset_manifests_dataset_type_known`强制）：与`manifest_contract_version`是两个正交维度——`dataset_type`描述"这份Manifest治理的是哪一类底层数据"（本轮及可预见范围内只有市场K线一种），`manifest_contract_version`描述"这份Manifest自身的字段形状版本"。两者都进入内容哈希（见第七节）。
6. `manifest_schema_version`（既有列）：契约版本1维持既有值`'v1.4d-manifest-schema-1'`，**永久不变**；契约版本2冻结新值`'v1.4d-manifest-schema-2'`。任何一份Manifest的`manifest_schema_version`必须与其`manifest_contract_version`一一对应（`v1`↔`v1.4d-manifest-schema-1`，`v2`↔`v1.4d-manifest-schema-2`），`dataset-manifest-builder.js`必须在构建前断言此对应关系，不一致直接拒绝构建（防止未来有人手滑传错版本标签组合）。

---

## 二、`symbols`模型

1. 契约版本2下，Manifest的symbol信息**只**通过新增列`symbols`（jsonb，元素类型为字符串数组）表达，标量列`symbol`**必须**为`NULL`（见第一节CHECK约束）——**禁止**同一份契约版本2的Manifest中`symbol`与`symbols`同时携带（哪怕数值一致）的情况，这不是"允许但要求一致"，而是结构性地禁止`symbol`出现任何非NULL值。
2. `symbols`取值规则（冻结，供`canonical-manifest-content.js`与`dataset-manifest-builder.js`实现）：
   - **非空**：数组长度必须`>=1`（CHECK约束已強制`jsonb_array_length(symbols) > 0`）。
   - **归一化**：数组元素必须是**去重后的**符号字符串集合，按**严格字典序（UTF-16 code unit）升序**排序后再持久化/参与哈希——与既有`intervals`/`backfillBatchIds`排序惯例一致，消除查询顺序/构造顺序带来的歧义。
   - **大小写规则**：symbol字符串必须为**全大写**（如`ETHUSDT`，不接受`ethusdt`/`EthUsdt`）；构建时若检测到非全大写输入，**拒绝构建**（返回构建期错误，不做静默大写转换——静默转换可能掩盖"调用方传参本身就有bug"这一事实，同时避免"大小写不同但语义相同"的两个字符串被错误地当成两个不同symbol、逃过去重逻辑）。
   - **允许的symbol格式**：必须匹配`^[A-Z0-9]+$`（纯大写字母与数字，不含连字符/下划线/空格等其他字符），本轮实际只会出现`ETHUSDT`/`BTCUSDT`两个值（见第四节，`symbols`集合是`dependency_set`推导出的派生视图，不是CLI自由输入，见下条）。
   - **禁止重复**：输入去重后如果发现两个字符串仅大小写不同（如同时出现`ETHUSDT`与`Ethusdt`），**视为非法输入直接拒绝**，不得静默合并为一个——这类输入本身就意味着调用方存在bug。
   - **null/未知值处理**：`symbols`数组元素不得为`null`或非字符串类型，出现即拒绝构建。
3. **`symbols`不是CLI自由参数**：契约版本2的`dataset:build-manifest`命令**不接受**`--symbol`/`--symbols`/`--intervals`参数（这些参数只在`--contract-version 1`路径下有效，见第十二节CLI契约变更）。`symbols`与`dependency_set`（见第四节）**均由`dataset-manifest-builder.js`内部直接读取`FEATURE_BAR_DEPENDENCIES`（`server/src/features/feature-engine.js`）机械推导**——即`symbols = [...new Set(FEATURE_BAR_DEPENDENCIES.map(d => d.symbol))].sort()`，不接受人工传参覆盖。这一设计是防止"人工CLI输入拼出一个笛卡尔积依赖集合"整类错误的**结构性**根治手段，而不只是靠事后校验发现：调用方**没有输入依赖组合的能力**，因而不存在"输错"的攻击面。
4. **本轮精确覆盖范围**：`symbols = ["BTCUSDT", "ETHUSDT"]`（已按字典序排序）。这是`FEATURE_BAR_DEPENDENCIES`当前配置下机械推导的唯一结果，任何未来若`FEATURE_BAR_DEPENDENCIES`发生变化（如新增第三个symbol），`symbols`集合会**自动**随之变化（因为是派生值），但**Manifest契约本身**（`manifest_schema_version='v1.4d-manifest-schema-2'`等）不需要因此升版——除非字段**形状**（而非集合内容）发生变化。
5. 契约版本1（legacy）的`symbol`字段**保留、不做任何修改**，作为只读兼容语义存在：任何读取契约版本1记录的代码，若需要"这份Manifest治理哪些symbol"这一信息，**必须**将`symbol`标量值等价看作单元素集合`[symbol]`，**不得**尝试读取契约版本1记录的`symbols`列（该列对契约版本1记录恒为`NULL`，读到`NULL`必须理解为"这是契约版本1，请改读`symbol`标量列"，不得理解为"这份Manifest没有symbol信息"）。

---

## 三、依赖矩阵（`dependency_set`）

1. 新增列`dependency_set`（jsonb，契约版本2下NOT NULL且非空数组，元素形状固定为四字段对象）：
   ```
   { "symbol": "BTCUSDT", "interval": "15m", "marketType": "spot", "source": "binance-spot" }
   ```
   四字段全部为字符串类型，**缺一不可**——`symbol`+`interval`+`marketType`+`source`共同构成一个依赖条目的完整身份，仅`symbol`+`interval`不足以唯一表达"来自哪个市场类型/哪个数据源"（本轮`marketType`恒为`'spot'`、`source`恒为`'binance-spot'`，但字段结构性保留，为未来引入期货市场类型或多数据源留出无需破坏性变更的扩展位）。
2. **红线：`dependency_set`绝不是`symbols × intervals`的笛卡尔积**——本轮冻结的精确依赖矩阵（严格四条，不多不少，与`server/src/features/feature-engine.js`的`FEATURE_BAR_DEPENDENCIES`逐条对应）：

   | symbol | interval | marketType | source |
   |---|---|---|---|
   | BTCUSDT | 15m | spot | binance-spot |
   | ETHUSDT | 15m | spot | binance-spot |
   | ETHUSDT | 1h | spot | binance-spot |
   | ETHUSDT | 4h | spot | binance-spot |

   **`symbols=["BTCUSDT","ETHUSDT"]`且`intervals`集合含`{15m,1h,4h}`，但`dependency_set`中绝不出现`{BTCUSDT, 1h}`或`{BTCUSDT, 4h}`**——这是本节存在的核心原因：如果系统只持久化`symbols`与`intervals`两个独立集合、让消费方自行"配对"，消费方几乎必然（哪怕是无意地）重新构造出笛卡尔积语义，隐式要求BTCUSDT的1h/4h数据存在。`dependency_set`作为**独立的、显式列出每一条真实依赖**的结构，从根本上杜绝这一错误。
3. **权威来源声明**：`server/src/features/feature-engine.js`的`FEATURE_BAR_DEPENDENCIES`是Feature输入依赖的**唯一权威定义**。`dataset-manifest-builder.js`构建契约版本2 Manifest时，`dependency_set`**必须**通过读取`FEATURE_BAR_DEPENDENCIES`机械映射得到（`{symbol, interval, marketType}`三字段直接取自`FEATURE_BAR_DEPENDENCIES`各条目，`source`字段补充固定值`'binance-spot'`，因为`FEATURE_BAR_DEPENDENCIES`当前不含数据源字段，这是本附录新增的维度），**不得**由CLI参数或人工输入指定依赖组合。Manifest的`dependency_set`必须**完全覆盖**`FEATURE_BAR_DEPENDENCIES`（即：`FEATURE_BAR_DEPENDENCIES`每一条都能在`dependency_set`中找到完全匹配的条目），同时**不得包含**`FEATURE_BAR_DEPENDENCIES`之外的任何未批准隐式依赖（即两者在`{symbol,interval,marketType}`三元组投影下必须**完全相等**，不是"超集"关系——多出的依赖同样是一种未经批准的隐式假设，必须拒绝，除非未来有独立规范修订显式批准）。
4. **归一化/排序/去重规则**：
   - 去重：以`(symbol, interval, marketType, source)`四元组完全相等为去重判据。
   - 排序键：`(symbol, interval, marketType, source)`四元组依次字典序比较（`symbol`：`'BTCUSDT' < 'ETHUSDT'`；`interval`：沿用既有`manifestMembers`排序惯例的字符串字典序，`'15m' < '1h' < '4h'`，逐字符UTF-16 code unit比较自然得到该结果，不需要额外定义周期优先级表）；四元组任一字段唯一即可确定顺序，本轮实际数据下四元组本身已全局互不相同，理论上不存在并列，但仍冻结四元组全字段比较作为通用规则（不依赖"实践中大概率不会并列"）。
5. **序列化**：`dependency_set`作为内容哈希的绑定字段之一，按上述排序后的数组形式参与`canonicalJsonHash()`计算（见第七节），数组元素内部对象字段顺序不影响哈希结果（`canonicalJsonHash()`对对象键排序，已核实，见`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.9.4）。

---

## 四、共享窗口与`fixed_as_of`

1. **结构性共享保证**：`dataset_manifests`表本身每行只有**一组**`data_from`/`data_to`/`fixed_as_of`/`source_formal_semantics`/`research_availability_rule_version`，这组值**对该行`dependency_set`列出的全部依赖同时生效**——不存在"每个依赖各自独立窗口"的表达能力，共享语义由表结构本身保证，不依赖应用层自觉遵守。
2. **时间格式与UTC规则**：`data_from`/`data_to`/`fixed_as_of`均为`timestamptz`列，应用层传入/序列化为哈希输入时统一使用ISO8601 UTC字符串（`YYYY-MM-DDTHH:mm:ss.sssZ`），与`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.2/§4.1既有UTC口径完全一致，不新增例外。
3. **区间语义**：`data_from`含、`data_to`不含（与既有`market_bars`查询边界惯例一致，见`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.8）。
4. **interval bucket对齐**：每个依赖各自按其`interval`自身的桶长对齐（15m/1h/4h各自的`open_time`必须是各自interval步长的整数倍epoch毫秒，复用`server/src/forecast/bar-path-locator.js`既有`computeAlignedReferenceCloseTime`同款对齐算法，不新造第二套对齐逻辑）——**共享同一`data_from`/`data_to`并不意味着不同interval的桶边界数值相同**（例如`data_from=2026-01-26T00:00:00Z`对15m/1h/4h而言都是合法桶起点，因为该时间戳恰好是1h和4h的整数倍，但如果`data_from`选在一个只对齐15m、不对齐1h/4h的时间点，构建必须fail-closed，见下条）。
5. **最后允许的已收盘K线 / `close_time<=fixed_as_of`**：对**每一个**依赖条目独立校验：该依赖在`[data_from, data_to)`范围内的每一根K线，其`close_time`必须`<=fixed_as_of`；任何`close_time>fixed_as_of`的行**不得**进入该依赖的`manifest_members`计数/统计/checkpoint（呼应`V1_4D_DATA_BACKFILL_SPEC.md`§2.9 `researchAvailability`语义与`V1_4D_HISTORICAL_REPLAY_SPEC.md`§4.3"禁止未来泄漏"红线，本条是同一红线在多symbol场景下的显式重申，不是新规则）。
6. **禁止不同symbol使用不同as-of**：`fixed_as_of`是Manifest行级单一值，ETHUSDT三个依赖与BTCUSDT依赖**共享同一个**`fixed_as_of`，不存在"BTC比ETH多给1小时缓冲"这类隐式差异化处理——若未来业务上确实需要为不同symbol设置不同的可见性边界，那是一次独立的、需要显式重新设计契约版本的架构变更，本轮不支持、不预留隐藏开关。
7. **resume不得漂移as-of**：与`V1_4D_HISTORICAL_REPLAY_SPEC.md`§4.4既有`--resume`参数一致性红线相同的原则在此适用——一旦某个`dataset_version`被创建，其`fixed_as_of`永久不变（内容寻址主键+不可变表设计已从根本上保证，见第一节/第十二节），任何"想用更新的as-of"的需求必须构建一份**新的**Manifest（新`dataset_version`），不得也不能就地修改。
8. **无法共享完整窗口时必须fail-closed**：若四个依赖中**任意一个**在`[data_from, data_to)`范围内存在缺口（gap）、或该symbol的可得数据起点晚于`data_from`（例如某symbol理论上市时间晚于窗口起点——本轮BTCUSDT/ETHUSDT均不存在此问题，但规则必须对未来symbol通用）、或任何一个依赖的完整性检查（第九节）未通过，**整个Manifest构建必须被拒绝**，**不得**将该依赖的窗口悄悄收缩为"该依赖实际可得的子区间"而其余依赖仍使用原始`[data_from, data_to)`——**四个依赖的窗口要么完全相同且都合法覆盖，要么整体拒绝构建**，不存在"部分窗口生效"的中间状态。
9. **回填范围联动**（交叉引用`V1_4D_DATA_BACKFILL_SPEC.md`，不修改该文档正文）：若目标窗口起点为`data_from`，则15m/1h/4h三个ETH周期均需回填至`data_from`往前推≥4天（`V1_4D_DATA_BACKFILL_SPEC.md`§2.1既有4h预热要求），BTCUSDT 15m同样需要回填覆盖`[data_from, data_to)`（无需4h预热缓冲，因为`FEATURE_BAR_DEPENDENCIES`中BTCUSDT只用于15m特征计算，不存在4h ATR回溯需求——若未来`FEATURE_BAR_DEPENDENCIES`新增BTCUSDT的1h/4h依赖，本条随之自动适用，不需要修改本附录文字，因为本条表述的是"回填范围必须覆盖`dependency_set`各条目各自的实际预热需求"这一原则，不是硬编码"BTC不需要预热"这一具体结论）。

---

## 五、Manifest成员身份（`manifest_members`，契约版本2新形状）

1. 契约版本2下，`manifest_members`数组元素形状**扩展**为七字段（在既有五字段基础上新增`symbol`/`marketType`/`source`，`closeTime`同时补充以增强可审计性，不依赖调用方从`openTime`+`interval`反推）：
   ```
   {
     "symbol": "BTCUSDT",
     "intervalName": "15m",
     "marketType": "spot",
     "source": "binance-spot",
     "openTime": 1769384700000,
     "closeTime": 1769386499999,
     "revisionNumber": 0,
     "vintageId": "BTCUSDT-spot-15m-1769384700000-0",
     "rowContentHash": "b28be94d41ccfdbda1f661302639db8ef888de3f4b7038c4276965f4f174cf5a"
   }
   ```
   `rowContentHash`计算方式与既有§2.9.3完全一致（`open`/`high`/`low`/`close`/`volume`/`quoteVolume`六字段，Postgres numeric原始字符串形式，不经JS number转换）。
2. **排序规则（红线，扩展既有四元组为七元组，`vintageId`仍是最终决胜字段）**：排序键依次比较`(symbol, intervalName, marketType, source, openTime, revisionNumber, vintageId)`。前六个字段任一环节出现并列均继续比较下一字段，`vintageId`（全局`UNIQUE`）保证在理论上任意前六字段全部相同的极端场景下仍有确定顺序。
3. **去重/重复身份处理**：以`vintageId`作为唯一去重判据（`vintage_id`在生产`market_bars`表本身`UNIQUE`，理论上不会出现重复，但构建逻辑仍应显式`Set`去重并在检测到重复时记录WARNING，与既有`backfillBatchIds`去重惯例一致）。
4. **同一`openTime`多版本（多vintage）选择规则**：当同一`(symbol, intervalName, openTime)`存在多个`revisionNumber`时，**必须**选择`revisionNumber`最大者（即最新修订）——与生产`bar-path-locator.js`既有`ORDER BY revision_number DESC`惯例一致（呼应`V1_4D_ACCEPTANCE_TESTS.md` R5.4）；`revision_number=0`是当前Binance现货已收盘K线的唯一实际取值，本规则为未来可能出现的修订场景预先冻结，不代表本轮预期会遇到多revision情形。
5. **同一`openTime`是否允许多member共存**：**同一`(symbol, intervalName)`组合内**，同一`openTime`**只允许**一个member进入最终`manifest_members`（即"多版本选择规则"选出的唯一胜者）；但**不同`symbol`或不同`intervalName`之间**，相同的`openTime`数值当然可以同时存在（例如BTCUSDT 15m与ETHUSDT 15m在同一`openTime`各有一条member，二者的`(symbol,intervalName)`不同，不构成冲突）。
6. **成员身份如何暴露给生产查询**：`manifest.memberVintageIds`（应用层从`manifest_members`提取的`vintageId`扁平数组）**天然跨symbol**——即数组同时包含BTCUSDT与ETHUSDT各依赖的全部vintageId，不需要对现有`PostgresRepository.loadHistoricalFeatureInputs`的`AND vintage_id = ANY($N::text[])`过滤逻辑做任何代码修改：只要`dataset-manifest-builder.js`把跨symbol的member正确写入同一份`manifest_members`，现有SQL级治理机制**结构性地**自动支持多symbol治理，这是单一Manifest模型相对关联Manifest模型的一个具体工程收益（关联模型需要额外代码合并多份manifest各自的vintageId集合，单一模型不需要）。
7. **禁止旁路读取**：除本节与`V1_4D_HISTORICAL_REPLAY_SPEC.md`§三.2已冻结的"全部SQL语句schema-qualified"红线外，本附录重申：`server/src/validation-replay/*`、`server/src/backfill/*`、Feature Backfill相关代码，**除第十一节明确列出的只读诊断/取证工具外**，不得存在任何绕过`vintage_id = ANY(governedVintageIds)`过滤、直接按`symbol+interval+时间范围`裸查询`public.market_bars`全表的代码路径。

---

## 六、内容哈希（契约版本2）

### 6.1 冻结绑定字段清单（契约版本2专属，16项，对照既有13项列表扩展）

```
manifestSchemaVersion              （固定 'v1.4d-manifest-schema-2'）
manifestHashAlgorithmVersion       （固定 'v1.4d-manifest-hash-1'，复用既有canonicalJsonHash实现，不新增算法）
manifestContractVersion            （固定数值 2，新增）
datasetType                        （固定 'MARKET_BARS'，新增）
symbols                            （见第二节，排序去重后的数组，取代标量symbol）
dependencySet                      （见第三节，排序去重后的数组，新增）
dataFrom
dataTo
fixedAsOf                          （新增纳入哈希内容——既有13项列表未包含fixed_as_of，因为migration 006引入该列时未同步更新哈希公式；契约版本2下`fixed_as_of`是治理红线的核心字段，必须进入哈希，任一变化必须确定性反映为不同dataset_version。**注**：此项调整只适用于契约版本2的新公式，不追溯、不改变契约版本1既有13项哈希公式与已产生的历史dataset_version）
backfillBatchIds                   （排序规则不变，见既有§2.9.2）
manifestMembers                    （契约版本2新形状，见第五节，排序规则扩展为七元组）
sourceFormalSemantics
researchAvailabilityRuleVersion
recordCount
perDependencyRecordCount           （取代既有perIntervalRecordCount，见6.2）
perDependencyIntegrityCheckResult  （取代既有integrityCheckResult，见6.2，落实第九节"禁止跨依赖抵消"要求）
```

字段名camelCase，与数据库列snake_case做1:1机械映射，语义与既有惯例一致。

### 6.2 `perDependencyRecordCount`/`perDependencyIntegrityCheckResult`结构

两者均为**以`"${symbol}:${interval}"`为key的对象**（而非数组），例如：
```
perDependencyRecordCount = {
  "BTCUSDT:15m": 17280,
  "ETHUSDT:15m": 17280,
  "ETHUSDT:1h": 4320,
  "ETHUSDT:4h": 1080
}
perDependencyIntegrityCheckResult = {
  "BTCUSDT:15m": { "gapCount": 0, "duplicateCount": 0, "outOfOrderCount": 0 },
  "ETHUSDT:15m": { "gapCount": 0, "duplicateCount": 0, "outOfOrderCount": 0 },
  "ETHUSDT:1h":  { "gapCount": 0, "duplicateCount": 0, "outOfOrderCount": 0 },
  "ETHUSDT:4h":  { "gapCount": 0, "duplicateCount": 0, "outOfOrderCount": 0 }
}
```
采用对象而非数组的理由：`canonicalJsonHash()`已核实对**对象**键做`Object.keys(current).sort()`规范化排序（见`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.9.4），因此调用方**不需要**额外实现"按symbol:interval排序"的数组排序逻辑——用对象天然获得确定性排序，比额外定义一套数组排序规则更简单、更不容易实现错误。key格式固定为`"${symbol}:${interval}"`（冒号分隔，symbol在前），构建时必须覆盖`dependency_set`全部条目，缺一即视为构建期内部错误（不应发生，构建逻辑bug）。

### 6.3 Caller侧类型纪律

与既有§2.9.5完全一致（numeric字段字符串化、时间字段ISO8601字符串化），额外补充：`manifestContractVersion`字段本身传入**JS number**类型（安全整数`2`，无精度风险，与`recordCount`等既有整数字段同类处理，不需要字符串化）。

### 6.4 完整worked example（本轮新增，供Codex实现golden test）

以下示例使用**当前实际的**`server/src/domain/hash.js canonicalJsonHash()`函数（已用Node实际执行验证，非手工推算）计算，覆盖一个最小化的2条member场景（1条BTCUSDT 15m + 1条ETHUSDT 15m，其余两个依赖`ETHUSDT:1h`/`ETHUSDT:4h`本例中记为0条record，仅用于演示`perDependencyRecordCount`/`perDependencyIntegrityCheckResult`对全部四个依赖的覆盖要求，不代表真实回填场景下1h/4h应为0——真实构建时四个依赖都应有非零覆盖，见第九节）：

**输入（`rowContentHash`所依据的原始OHLCV，字符串形式）**：
```
BTCUSDT 15m: { open:"61234.50000000", high:"61390.00000000", low:"61180.10000000", close:"61350.25000000", volume:"128.44310000", quoteVolume:"7876543.21000000" }
ETHUSDT 15m: { open:"3210.40000000",  high:"3225.90000000",  low:"3199.15000000",  close:"3220.05000000",  volume:"954.11200000",  quoteVolume:"3067521.55000000" }
```

**子哈希（`rowContentHash = canonicalJsonHash({open,high,low,close,volume,quoteVolume})`）**：
```
BTCUSDT 15m rowContentHash = b28be94d41ccfdbda1f661302639db8ef888de3f4b7038c4276965f4f174cf5a
ETHUSDT 15m rowContentHash = e1294238b443a8ac43e14d9dd00b42a154fe1650ad51b7fb34790c7fb5dec3c2
```

**openTime/closeTime**：`openTime = Date.parse("2026-01-25T23:45:00.000Z") = 1769384700000`，`closeTime = Date.parse("2026-01-26T00:14:59.999Z") = 1769386499999`。

**完整`manifestContentObject`（按6.1字段清单，`manifestMembers`已按第五节七元组排序：`BTCUSDT`<`ETHUSDT`故BTC条目在前）**：
```json
{
  "manifestSchemaVersion": "v1.4d-manifest-schema-2",
  "manifestHashAlgorithmVersion": "v1.4d-manifest-hash-1",
  "manifestContractVersion": 2,
  "datasetType": "MARKET_BARS",
  "symbols": ["BTCUSDT", "ETHUSDT"],
  "dependencySet": [
    { "symbol": "BTCUSDT", "interval": "15m", "marketType": "spot", "source": "binance-spot" },
    { "symbol": "ETHUSDT", "interval": "15m", "marketType": "spot", "source": "binance-spot" },
    { "symbol": "ETHUSDT", "interval": "1h",  "marketType": "spot", "source": "binance-spot" },
    { "symbol": "ETHUSDT", "interval": "4h",  "marketType": "spot", "source": "binance-spot" }
  ],
  "dataFrom": "2026-01-25T23:45:00.000Z",
  "dataTo": "2026-01-26T00:15:00.000Z",
  "fixedAsOf": "2026-01-26T00:14:59.999Z",
  "backfillBatchIds": ["11111111-1111-4111-8111-111111111111"],
  "manifestMembers": [
    {
      "symbol": "BTCUSDT", "intervalName": "15m", "marketType": "spot", "source": "binance-spot",
      "openTime": 1769384700000, "closeTime": 1769386499999, "revisionNumber": 0,
      "vintageId": "BTCUSDT-spot-15m-1769384700000-0",
      "rowContentHash": "b28be94d41ccfdbda1f661302639db8ef888de3f4b7038c4276965f4f174cf5a"
    },
    {
      "symbol": "ETHUSDT", "intervalName": "15m", "marketType": "spot", "source": "binance-spot",
      "openTime": 1769384700000, "closeTime": 1769386499999, "revisionNumber": 0,
      "vintageId": "ETHUSDT-spot-15m-1769384700000-0",
      "rowContentHash": "e1294238b443a8ac43e14d9dd00b42a154fe1650ad51b7fb34790c7fb5dec3c2"
    }
  ],
  "sourceFormalSemantics": "market_bars:formal:spot",
  "researchAvailabilityRuleVersion": "v1.4d-research-availability-1",
  "recordCount": 2,
  "perDependencyRecordCount": {
    "BTCUSDT:15m": 1, "ETHUSDT:15m": 1, "ETHUSDT:1h": 0, "ETHUSDT:4h": 0
  },
  "perDependencyIntegrityCheckResult": {
    "BTCUSDT:15m": { "gapCount": 0, "duplicateCount": 0, "outOfOrderCount": 0 },
    "ETHUSDT:15m": { "gapCount": 0, "duplicateCount": 0, "outOfOrderCount": 0 },
    "ETHUSDT:1h":  { "gapCount": 0, "duplicateCount": 0, "outOfOrderCount": 0 },
    "ETHUSDT:4h":  { "gapCount": 0, "duplicateCount": 0, "outOfOrderCount": 0 }
  }
}
```

**Golden哈希输出（实际用`canonicalJsonHash(manifestContentObject)`计算得到）**：
```
contentHash    = 0a0e3225e83ff09c9dcf22c6a87de317cfe94d0b6854b7c8c2f25e20d6bade46
dataset_version = v1.4d-sha256-0a0e3225e83ff09c9dcf22c6a87de317cfe94d0b6854b7c8c2f25e20d6bade46
```

**Codex实现要求**：`hash-contract-verification.test.js`（既有实施任务，见`V1_4D_CODEX_IMPLEMENTATION_TASK.md`）在实施阶段新增一条针对上述**完整对象**的断言用例——用当时实际的`canonicalJsonHash()`重新计算，结果必须**逐字符**等于本节给出的`contentHash`值；若不相等，说明`domain/hash.js`的实现已发生漂移（不满足`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.9.4核实结论），必须立即停止使用该函数并按该节末段冻结的应对路径处理，不得静默调整本附录的期望值来"迁就"新的哈希输出。

### 6.5 契约版本1的哈希公式不受影响

本节全部规则**仅适用于契约版本2**。契约版本1既有13字段哈希公式（`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.9.1-§2.9.7）**逐字不变**，已产生的契约版本1 `dataset_version`**不得**因本附录发布而重新计算或视为失效。

---

## 七、逻辑窗口身份（`logical_window_hash`，契约版本2）

1. 契约版本2的逻辑窗口身份对象（供`logicalWindowHash = canonicalJsonHash(identity)`计算）冻结为：
   ```json
   {
     "contractVersion": 2,
     "datasetType": "MARKET_BARS",
     "fixedAsOf": "<ISO8601>",
     "from": "<ISO8601>",
     "to": "<ISO8601>",
     "dependencySet": [ /* 第三节排序后的依赖数组 */ ],
     "sourceFormalSemantics": "market_bars:formal:spot"
   }
   ```
   **采用`dependencySet`而非扁平的`symbols`+`intervals`**作为身份对象字段——这是本附录相对于既有`dataset-manifest-builder.js`内部已存在的`canonicalManifestLogicalWindow()`原语（该原语当前使用扁平`symbols`/`intervals`数组）的**必要调整**：扁平表示会让"BTCUSDT+ETHUSDT两个symbol"×"15m/1h/4h三个周期"这一逻辑窗口身份看起来蕴含六个组合，而实际只批准四个，用`dependencySet`可从身份定义层面就避免这种误导性蕴含。**是否复用/扩展现有`canonicalManifestLogicalWindow()`函数、还是新增一个契约版本2专属的同名兄弟函数，属于实施阶段的实现细节，本附录只冻结上述身份对象的字段形状与取值**，不强制指定具体函数签名。
2. **`contractVersion`字段的防碰撞作用（红线）**：无论契约版本1既有的逻辑窗口身份对象是否已经包含某种版本标识，**本附录要求**：契约版本1与契约版本2各自的逻辑窗口身份对象**都必须显式包含一个能相互区分的版本判别字段**（版本1可沿用其现状，若现状未包含此类字段，须在实施阶段一并补充，避免"其余字段恰好相同"时两个不同契约版本的窗口被误判为同一逻辑窗口）——这是防止跨契约版本身份碰撞的结构性要求，不依赖"字段集合形状不同天然不会碰撞"这一较弱的隐含假设。
3. **同窗口同内容 → 幂等返回既有Manifest**：沿用既有`resolveManifestLogicalWindow()`机制——若候选`logicalWindowHash`已存在于`dataset_manifests`表中且其对应行的`dataset_version`（即`content_hash`所代表的完整内容）与本次候选构建结果**相同**，直接返回既有行，不产生新行（`INSERT ... ON CONFLICT(dataset_version) DO NOTHING`本身已保证这一点，因为相同内容必产生相同`dataset_version`）。
4. **同窗口不同内容 → 稳定`DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT`**：若候选`logicalWindowHash`已存在，但重新构建得到的`dataset_version`（`content_hash`）与既有行**不同**（例如同一声明窗口下，`market_bars`实际内容在两次构建之间发生了变化），**拒绝插入**，抛出既有错误码`DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT`（沿用现有实现，不新增契约版本2专属的等价错误码——该场景在语义上与契约版本1完全相同，没有理由为同一失败语义定义两个错误码）。
5. **参数顺序变化不得改变哈希**：`dependencySet`已按第三节规则排序后再进入身份对象，`canonicalJsonHash()`保留数组元素顺序但不改变——即调用`dataset-manifest-builder.js`时无论以什么顺序枚举/传入依赖条目，只要最终排序规则应用正确，`logicalWindowHash`结果一致；`from`/`to`/`fixedAsOf`等标量参数本身没有"顺序"概念，不适用本条，仅在此明确排除歧义。
6. **advisory lock key来源**：沿用既有模式，key为字符串`` `dataset-manifest:${logicalWindowHash}` ``，通过`pg_advisory_xact_lock(hashtextextended($1,0))`获取，事务级、随`COMMIT`/`ROLLBACK`自动释放——契约版本2不引入新的锁策略，直接复用既有`persistGovernedManifest`模式中的锁获取逻辑，只是传入的`logicalWindowHash`来自本节新身份对象。
7. **事务范围**：与既有实现一致——单个`pool.connect()`专用连接，`BEGIN`→获取advisory lock→查询既有行→`resolveManifestLogicalWindow`判定→`INSERT`（`23505`唯一冲突转译为`DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT`）→`COMMIT`/`ROLLBACK`，全程不变。
8. **partial unique index**：沿用migration 006既有的`dataset_manifests_logical_window_hash_uidx ON (logical_window_hash) WHERE logical_window_hash IS NOT NULL`——该索引是**全表级**的（不区分契约版本），这正确反映"逻辑窗口身份必须全局唯一"这一要求；配合第2条的`contractVersion`判别字段，跨契约版本的身份对象不会产生相同哈希，因此不会出现"版本1和版本2各自合法但被同一唯一索引误判冲突"的问题。
9. **失败/被阻塞状态是否参与唯一性判定**：`dataset_manifests`表本身没有"状态"列（构建失败时根本不会执行`INSERT`，见第九节"完整性检查未通过则拒绝生成Manifest，不写入任何行"），因此不存在"失败状态的行占用了`logical_window_hash`唯一索引位置"这一问题——失败的构建尝试在数据库中不留任何痕迹（该尝试的审计记录如需要，应记录在`historical_validation.backfill_batches`或未来独立的构建尝试审计表，不在`dataset_manifests`本身，本轮不新增此类审计表，非本次范围）。
10. **legacy记录如何参与冲突检测**：契约版本1既有记录若已经填充了`logical_window_hash`（migration 006之后新构建的契约版本1记录可能有值，更早的记录该列为`NULL`，不参与partial unique index），其冲突检测逻辑与判定范围完全遵循既有实现，本附录不改变；第2条的`contractVersion`判别字段保证契约版本1记录不会与本附录新定义的契约版本2身份对象产生跨版本误判。

---

## 八、完整性验证（多依赖独立验证，禁止跨依赖抵消）

1. **验证粒度**：对`dependency_set`**每一条**`(symbol, interval, marketType, source)`独立执行以下全部检查，任何一条依赖的任何一项检查失败，**整份Manifest构建被拒绝**（fail closed，不产生任何`dataset_manifests`行）：
   - `expectedRecordCount` vs `actualRecordCount`（复用既有`computeIntegrityBoundary({from,to,asOf,interval})`按该依赖自身`interval`计算期望值）；
   - 首/末`expectedOpenTime`与首/末`actualOpenTime`是否一致；
   - gap（K线序列存在跳步）；
   - 重复（同一`openTime`出现多个未通过"多版本选择规则"合并的member）；
   - 错误的`interval`（例如某行`open_time`间隔与声明周期不符）；
   - 错误的`symbol`（查询到不属于该依赖symbol的行——理论上SQL查询条件已保证不会发生，仍作为纵深防御断言一次）；
   - 错误的`source`/`marketType`（当前恒为`binance-spot`/`spot`，仍显式校验，为未来多来源场景预留）；
   - 越界（`open_time < data_from`或`close_time > data_to`）；
   - `close_time > fixed_as_of`（见第四节红线）；
   - 未被治理的vintage（该依赖范围内存在`market_bars`行但其`vintage_id`未出现在最终`manifest_members`中——用于捕捉"构建逻辑遗漏了某些应该纳入的行"这类bug）。
2. **禁止跨依赖抵消（核心红线，呼应"服务器历史72/-72"问题类别）**：上述每一项检查的结果**必须按依赖分别独立记录**（即`perDependencyIntegrityCheckResult`，见6.2），**不得**将多个依赖的正负计数差异合并/相加后再判断"总体是否为0"——例如BTCUSDT 15m多出3根、ETHUSDT 15m少3根，若按总量合并计算会呈现"净差为0、看似正常"的假象，**必须**分别报告"BTCUSDT 15m: +3"与"ETHUSDT 15m: -3"两条独立异常，两者都必须导致整份Manifest构建失败，不能因为总量抵消而被掩盖。
3. **"服务器历史72/-72"只读取证任务的保留**：本节完整性验证是**Manifest构建期**的检查，与`V1_4D_HISTORICAL_REPLAY_SPEC.md`此前记录的"服务器历史72/-72"这一独立的、**生产环境层面**的只读取证任务是两个不同范畴的问题（一个是"未来构建的Manifest必须满足什么条件"，一个是"过去某次生产观测异常的根因是什么"）。本附录**重申**：在该只读取证任务**实际完成**、给出有证据支持的根因结论之前，其状态**必须**保持`NOT_CONFIRMED`，本附录**不得**、也没有依据被引用为"已确认72/-72根因"的证据——本节新增的分依赖独立校验机制**可能有助于**未来该取证任务的方法论（例如提供"按symbol+interval分别统计"的现成实现），但这是"提供了更好的工具"，不是"已经完成了取证"。
4. **该只读取证任务本身不在本轮授权范围**：本轮不执行任何只读取证查询，不访问生产数据库，只在规范层面确认其状态标注要求（见第十五节一致性自检第10项）。

---

## 九、Feature查询与血缘（契约版本2的强制门禁）

### 9.1 校验时机（红线：先验证后计算，不得"先算后验"）

Feature Backfill（`historical-feature-backfill.js`）在**任何**输入查询或PO/特征计算开始之前，必须完成以下验证，全部通过后才允许继续：

1. 读取Manifest行，校验`manifest_contract_version`：
   - 若当前调用要求多symbol治理（即调用方明确请求跨ETH/BTC的正式Feature Backfill运行）但传入Manifest的`manifest_contract_version = 1`（legacy），**拒绝**，返回`DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED`——这正是"ETH-only legacy Manifest不得被用作新版本Feature正式运行输入"这一要求的具体落地点。
   - 若`manifest_contract_version`不在代码已知集合内，同样返回`DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED`。
2. 对契约版本2 Manifest，执行`V1_4D_HISTORICAL_REPLAY_SPEC.md`§4.1a既有八步校验（`DATASET_MANIFEST_NOT_FOUND`/`DATASET_CONTENT_HASH_MISMATCH`/`DATASET_RECORD_COUNT_MISMATCH`/`DATASET_TIME_RANGE_MISMATCH`/`DATASET_BATCH_SET_MISMATCH`/`DATASET_RESEARCH_AVAILABILITY_VERSION_MISMATCH`），**内容重算逻辑**须相应替换为读取`symbols`/`dependency_set`/`perDependencyRecordCount`等契约版本2字段（而非契约版本1的`symbol`/`intervals`/`per_interval_record_count`），八步流程的**顺序与fail-closed语义不变**。
3. **依赖完整性门禁（既有机制的确认与扩展）**：
   - `DATASET_MANIFEST_DEPENDENCY_UNGOVERNED`（既有错误码，`historical-feature-backfill.js validateInputsWithinManifest`已实现）：`FEATURE_BAR_DEPENDENCIES`中任一条目在Manifest的`dependency_set`中找不到完全匹配条目，触发。本附录**确认此既有检查继续作为权威门禁保留**，不做任何弱化。
   - `DATASET_MANIFEST_DEPENDENCY_INCOMPLETE`（**新增**）：依赖在`dependency_set`中**存在**，但该依赖的`perDependencyIntegrityCheckResult`/`perDependencyRecordCount`显示覆盖不完整（gap/count不足）——即Manifest**声称**治理该依赖，但其自身记录的完整性状态不支持"可安全用于计算"这一结论。**与`DEPENDENCY_UNGOVERNED`的区别**：`UNGOVERNED`是"依赖完全没被声明"，`INCOMPLETE`是"依赖被声明了，但声明本身不完整/有缺口"——两者是不同的失败层级，均须fail-closed，均不得继续计算。
   - `DATASET_MANIFEST_MEMBER_IDENTITY_MISSING`（**新增**）：针对某一依赖，Manifest的`perDependencyRecordCount`显示应有N>0条记录，但`manifest_members`中实际找不到任何`(symbol,intervalName)`匹配该依赖的条目（N与实际member数量不一致，或该依赖分组下member数量为0）——这是比`INCOMPLETE`更严重的**内部自相矛盾**信号（Manifest自己的统计字段与自己的成员列表对不上），必须fail-closed且应视为**构建阶段的实现缺陷**（正常构建流程不应产生这种Manifest，出现即说明`dataset-manifest-builder.js`存在bug）。
   - `DATASET_MANIFEST_MEMBERS_MISSING`（既有错误码，粒度更粗）：整份Manifest的`manifest_members`为空数组——继续保留作为最外层、契约版本1/2通用的粗粒度检查，不因新增细粒度的`MEMBER_IDENTITY_MISSING`而废止。
4. **运行时/查询时防线（既有机制，未变）**：`SOURCE_OUTSIDE_DATASET_MANIFEST`（越界）与`SOURCE_NOT_IN_DATASET_MANIFEST`（vintage未被治理）继续在实际数据读取时逐行生效，作为第9.1条第1-3款"构建期/启动期"验证之外的**运行期**纵深防御层——即使构建期验证全部通过，运行期仍然逐行二次确认，双层防御。

### 9.2 错误码总表（本附录冻结，含既有与新增）

| 错误码 | 触发层级 | 是否既有 | 触发条件 |
|---|---|---|---|
| `DATASET_MANIFEST_NOT_FOUND` | 启动期 | 既有 | `--dataset-version`/输入指定的Manifest行不存在 |
| `DATASET_CONTENT_HASH_MISMATCH` | 启动期 | 既有 | 重新计算的内容哈希与`dataset_version`不一致 |
| `DATASET_RECORD_COUNT_MISMATCH` | 启动期 | 既有 | 重算总行数与`record_count`不一致 |
| `DATASET_TIME_RANGE_MISMATCH` | 启动期 | 既有 | `data_from`/`data_to`被篡改或与实际范围不符 |
| `DATASET_BATCH_SET_MISMATCH` | 启动期 | 既有 | `backfill_batch_ids`集合不一致 |
| `DATASET_RESEARCH_AVAILABILITY_VERSION_MISMATCH` | 启动期 | 既有 | `research_availability_rule_version`与代码内置当前版本不符 |
| `DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT` | 构建期 | 既有 | 同`logical_window_hash`已存在但内容不同 |
| `DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED` | 启动期 | **新增** | 契约版本未知，或已知但不满足本次操作要求的最低版本（如legacy被喂给多symbol正式运行） |
| `DATASET_MANIFEST_DEPENDENCY_UNGOVERNED` | 计算前 | 既有 | `FEATURE_BAR_DEPENDENCIES`某依赖完全未出现在`dependency_set` |
| `DATASET_MANIFEST_DEPENDENCY_INCOMPLETE` | 计算前 | **新增** | 依赖已声明，但完整性/计数记录显示覆盖不完整 |
| `DATASET_MANIFEST_MEMBER_IDENTITY_MISSING` | 计算前 | **新增** | 依赖声明与`manifest_members`实际内容自相矛盾（细粒度） |
| `DATASET_MANIFEST_MEMBERS_MISSING` | 计算前 | 既有 | 整份Manifest的`manifest_members`为空（粗粒度） |
| `SOURCE_OUTSIDE_DATASET_MANIFEST` | 查询期（逐行） | 既有 | 行越界（超出`data_from`/`data_to`/`fixed_as_of`） |
| `SOURCE_NOT_IN_DATASET_MANIFEST` | 查询期（逐行） | 既有 | 行`vintage_id`未出现在`manifest.memberVintageIds` |

**新增错误码之外，本附录不再引入其他新增错误码**；上表已完整覆盖用户任务清单要求的五个最低错误码（`DATASET_MANIFEST_DEPENDENCY_UNGOVERNED`/`DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT`/`DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED`/`DATASET_MANIFEST_MEMBER_IDENTITY_MISSING`/`DATASET_MANIFEST_DEPENDENCY_INCOMPLETE`），并明确了每一个与既有错误码的关系，不存在未定义触发条件的"游离"错误码。

### 9.3 血缘（lineage）与审计

1. 输出的每一条Feature/PO计算结果，其审计记录（`feature_source_refs`等既有生产血缘结构，或`historical_validation`回放场景下的等价结构）**必须**同时包含ETH与BTC两个symbol的输入引用——不得只记录ETH输入而遗漏BTC输入（哪怕BTC特征在某次具体计算中数值上不产生影响，只要`FEATURE_BAR_DEPENDENCIES`声明了该依赖，血缘就必须诚实记录"计算时确实读取并依赖了这些BTC行"）。
2. 审计记录必须包含：Manifest身份（`dataset_version`）、依赖集合（`dependency_set`）、成员身份（至少涉及本次计算实际用到的`vintageId`子集）、`fixed_as_of`——四者缺一即视为审计不完整。
3. **不得"先算后验"**：9.1节验证必须在任何输入查询发起之前完成；实现层面即`dataset-manifest-verifier.js`的调用必须在`replay-generator.js`/`historical-feature-backfill.js`的任何数据访问代码路径之前执行，这是既有`V1_4D_CODEX_IMPLEMENTATION_TASK.md`§3.4已冻结的构建/校验分层原则的直接应用，本附录不改变该原则，只是将其应用范围扩展到契约版本2的多symbol场景。
4. **dry-run语义**：契约版本2下的dry-run与既有§4.2语义完全一致——完整执行9.1全部验证（验证本身是只读`SELECT`+哈希计算，不违反"零写入"），验证通过后只输出执行计划，不产生`replay_snapshots`等业务表写入；验证失败则fail-closed报告失败原因，同样零写入。

---

## 十、Legacy策略（契约版本1记录的只读治理）

1. **不可变性由既有机制自动覆盖**：`dataset_manifests_no_update`/`dataset_manifests_no_delete`两个既有触发器（migration 005）对表内**全部**行生效，不区分契约版本——契约版本1记录已经、且将继续被禁止`UPDATE`/`DELETE`，本附录**不需要**为legacy记录新增任何额外的不可变性保护机制，第十二节migration 007也**不包含**任何针对`dataset_manifests`的`UPDATE`/`DELETE`语句。
2. **禁止的操作（重申，非新规则）**：legacy Manifest不得被删除、不得被UPDATE、不得手工SQL补丁篡改内容、不得"就地升级"为契约版本2（即：不存在把某一行的`manifest_contract_version`从1改成2、同时补上`symbols`/`dependency_set`的操作——这在语义上等价于UPDATE，被触发器禁止；也不应该被允许，因为这会让一个"曾经只声明ETH的历史事实"被伪装成"当初就声明了ETH+BTC"，破坏审计真实性）。
3. **legacy记录不得作为契约版本2正式Feature运行的合法输入**：见第九节`DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED`，已是唯一权威的技术落地点。
4. **只读识别方法（不依赖模糊推断）**：
   ```sql
   SELECT dataset_version, manifest_contract_version, symbol, symbols, dependency_set, created_at
   FROM historical_validation.dataset_manifests
   ORDER BY created_at;
   ```
   `manifest_contract_version`列直接给出答案，不需要判断"`symbols`是否为空"这类间接推断——这与第一节第2条"禁止模糊推断"的要求完全一致，也是本附录新增该列的直接理由之一。
5. **冲突清单/状态披露**：任何未来的Manifest列表类CLI输出或诊断报告，**必须**显式展示每一行的`manifest_contract_version`，不得只展示`dataset_version`字符串本身（人眼无法从`v1.4d-sha256-{64hex}`字符串本身判断契约版本，字符串格式两个版本完全相同，故显式列展示是唯一可靠途径）。
6. **如何建立替代Manifest**：对同一业务窗口，运行`dataset:build-manifest --contract-version 2 ...`（见第十二节CLI变更）即可创建一份**新的**契约版本2 Manifest（新`dataset_version`），这是一次独立的`INSERT`，**不影响、不删除、不"替换"**原有契约版本1记录——原记录永久保留在表中。
7. **新旧共存规则**：契约版本1与契约版本2记录**允许无限期共存**，读取方（CLI/report/Feature Backfill）必须**显式**通过`dataset_version`声明要使用哪一份，**任何代码路径都不得隐式选择"最新的一份Manifest"作为默认输入**——这是防止"忘记声明、意外用错版本"的结构性要求，与既有CLI`--dataset-version`必需参数的设计哲学一致。
8. **回滚后避免误判契约版本**：由于`manifest_contract_version`是**显式持久化列**（不是推断值），只要该列本身没有丢失（见下方migration回滚限制），回滚生产代码到migration 007之前的版本**不会**造成"把契约版本2记录误判为契约版本1"的问题——因为回滚代码本身根本不会去读这个列，而数据库层面该列仍然存在、值仍然正确，一旦代码前滚回契约版本2感知的版本，读取结果立即恢复正确。**真正的风险点是migration本身的回滚（`DROP COLUMN`），而不是应用代码回滚**，见第十二节的migration回滚限制条款——这是本附录刻意区分"代码回滚"与"schema回滚"两种不同风险的地方。
9. **是否需要supersedes/replaces关系**：**本轮不定义**。理由：定义"新Manifest取代旧Manifest"这一关系本身需要新增一个指向关系（例如`superseded_by`列），而这类关系列如果要保持"不可变"语义、又要支持"后来才知道被谁取代"这一天然滞后的信息，需要额外设计（例如放在一张独立的、可变的"关系登记表"里，而不是`dataset_manifests`表本身，以免破坏该表的严格只增语义）。本附录判断这类关系管理是一个**独立的、后续可选的Manifest生命周期管理规范**范畴，不属于本轮"关闭P0-3多symbol契约缺口"的最小必要范围，**不冻结**，留待未来如有实际需要再独立评审——**本条本身即是对用户"若需要，定义时不得破坏不可变性"要求的回答：结论是本轮判断不需要，不是遗漏**。
10. **禁止隐式"最新Manifest"选择**：见第7条，重复强调作为独立红线：任何实现（含未来的诊断脚本、报告工具）如果出现"若未指定dataset_version则默认使用最近创建的一条"这类逻辑，视为违反本附录，验收测试见R28.NN（第十三节）静态扫描覆盖。

---

## 十一、Migration规则

### 11.1 结论：**需要 Migration 007**

理由：契约版本2需要的新列（`manifest_contract_version`/`dataset_type`/`symbols`/`dependency_set`）与新约束（版本互斥CHECK、版本已知CHECK）在当前schema（migration 001-006）中**不存在任何等价表达能力**——`symbol text NOT NULL`是标量列，无法承载"非空集合"语义；不存在任何列能表达`dependency_set`这种"显式依赖条目列表"结构；不存在`manifest_contract_version`这一显式判别列（若不新增，只能退回"用`symbols`是否为空模糊推断"，这正是用户明确禁止的做法）。因此现有schema**不能**无歧义地持久化本附录定义的新契约，**必须**新增migration。

### 11.2 Migration 007 设计（`007_v1_4d_multi_symbol_manifest_contract`）

**`up.sql`**（全部为`ALTER TABLE ADD COLUMN`/`ADD CONSTRAINT`/`ALTER COLUMN ... DROP NOT NULL`/`ALTER COLUMN ... DROP DEFAULT`，不含任何`INSERT`/`UPDATE`/`DELETE`语句，因而**不会触发**migration 005已冻结的`dataset_manifests_no_update`/`no_delete`触发器——`ALTER TABLE ADD COLUMN`是DDL元数据操作，不是逐行`UPDATE`，Postgres在此类操作中不会对已有行执行UPDATE语义、不会触发`BEFORE UPDATE`触发器；`ADD COLUMN ... DEFAULT <常量>`会在同一DDL语句内为既有行填充默认值，这是**列定义层面的回填**，不是应用层发起的`UPDATE`语句，不构成对不可变数据的"修改"）：

```sql
-- 007_v1_4d_multi_symbol_manifest_contract.up.sql
-- V1_4D_MULTI_SYMBOL_MANIFEST_ADDENDUM.md：dataset_manifests 契约版本化 + 多symbol契约新增列。
-- 001-006 号migration保持不变，不回头编辑；本迁移只新增列/约束，不产生任何DML。

ALTER TABLE historical_validation.dataset_manifests
  ADD COLUMN IF NOT EXISTS manifest_contract_version integer NOT NULL DEFAULT 1;

ALTER TABLE historical_validation.dataset_manifests
  ADD COLUMN IF NOT EXISTS dataset_type text NOT NULL DEFAULT 'MARKET_BARS';

ALTER TABLE historical_validation.dataset_manifests
  ALTER COLUMN symbol DROP NOT NULL;

ALTER TABLE historical_validation.dataset_manifests
  ADD COLUMN IF NOT EXISTS symbols jsonb;

ALTER TABLE historical_validation.dataset_manifests
  ADD COLUMN IF NOT EXISTS dependency_set jsonb;

ALTER TABLE historical_validation.dataset_manifests
  DROP CONSTRAINT IF EXISTS dataset_manifests_contract_version_known;
ALTER TABLE historical_validation.dataset_manifests
  ADD CONSTRAINT dataset_manifests_contract_version_known
  CHECK (manifest_contract_version IN (1, 2));

ALTER TABLE historical_validation.dataset_manifests
  DROP CONSTRAINT IF EXISTS dataset_manifests_dataset_type_known;
ALTER TABLE historical_validation.dataset_manifests
  ADD CONSTRAINT dataset_manifests_dataset_type_known
  CHECK (dataset_type = 'MARKET_BARS');

-- 契约版本1（legacy）形状：symbol非空，symbols/dependency_set必须为NULL。
ALTER TABLE historical_validation.dataset_manifests
  DROP CONSTRAINT IF EXISTS dataset_manifests_contract_v1_shape;
ALTER TABLE historical_validation.dataset_manifests
  ADD CONSTRAINT dataset_manifests_contract_v1_shape
  CHECK (manifest_contract_version <> 1 OR (
    symbol IS NOT NULL AND symbols IS NULL AND dependency_set IS NULL
  ));

-- 契约版本2（多symbol）形状：symbol必须为NULL（禁止symbol/symbols冲突表达），
-- symbols/dependency_set必须为非空数组，且fixed_as_of/logical_window_hash强制非空
-- （这是本迁移唯一收紧既有migration 006可选语义的地方，且仅对契约版本2生效，
-- 不追溯要求契约版本1记录满足）。
ALTER TABLE historical_validation.dataset_manifests
  DROP CONSTRAINT IF EXISTS dataset_manifests_contract_v2_shape;
ALTER TABLE historical_validation.dataset_manifests
  ADD CONSTRAINT dataset_manifests_contract_v2_shape
  CHECK (manifest_contract_version <> 2 OR (
    symbol IS NULL
    AND symbols IS NOT NULL AND jsonb_typeof(symbols) = 'array' AND jsonb_array_length(symbols) > 0
    AND dependency_set IS NOT NULL AND jsonb_typeof(dependency_set) = 'array' AND jsonb_array_length(dependency_set) > 0
    AND fixed_as_of IS NOT NULL
    AND logical_window_hash IS NOT NULL
  ));

-- 回填完成后收紧默认值：未来任何INSERT必须显式声明契约版本与dataset_type，
-- 不得依赖DEFAULT悄悄落入legacy契约。
ALTER TABLE historical_validation.dataset_manifests
  ALTER COLUMN manifest_contract_version DROP DEFAULT;
ALTER TABLE historical_validation.dataset_manifests
  ALTER COLUMN dataset_type DROP DEFAULT;
```

**`down.sql`**（**红线：必须先守卫，确认不存在契约版本2记录才允许回滚**——这是本附录识别出的关键回滚风险点，见11.3）：

```sql
-- 007_v1_4d_multi_symbol_manifest_contract.down.sql
-- 红线：DROP COLUMN 是DDL操作，不受 dataset_manifests_no_update/no_delete 触发器保护
-- （该触发器只拦截 UPDATE/DELETE DML，不拦截 ALTER TABLE DROP COLUMN）。
-- 若表中已存在 manifest_contract_version = 2 的行，直接回滚会不可恢复地销毁其
-- symbols/dependency_set/manifest_contract_version/dataset_type 内容，属于事实上的数据丢失。
-- 因此本回滚脚本必须显式守卫：存在契约版本2记录时拒绝执行。

DO $$
DECLARE
  v2_count integer;
BEGIN
  SELECT count(*) INTO v2_count
  FROM historical_validation.dataset_manifests
  WHERE manifest_contract_version = 2;

  IF v2_count > 0 THEN
    RAISE EXCEPTION
      'MIGRATION_007_ROLLBACK_BLOCKED: % 条 manifest_contract_version=2 记录存在，回滚将不可恢复地销毁多symbol Manifest身份数据，拒绝执行',
      v2_count;
  END IF;
END $$;

ALTER TABLE historical_validation.dataset_manifests
  DROP CONSTRAINT IF EXISTS dataset_manifests_contract_v2_shape,
  DROP CONSTRAINT IF EXISTS dataset_manifests_contract_v1_shape,
  DROP CONSTRAINT IF EXISTS dataset_manifests_dataset_type_known,
  DROP CONSTRAINT IF EXISTS dataset_manifests_contract_version_known,
  DROP COLUMN IF EXISTS dependency_set,
  DROP COLUMN IF EXISTS symbols,
  DROP COLUMN IF EXISTS dataset_type,
  DROP COLUMN IF EXISTS manifest_contract_version;

ALTER TABLE historical_validation.dataset_manifests
  ALTER COLUMN symbol SET NOT NULL;
```

（`ALTER COLUMN symbol SET NOT NULL`在守卫通过后是安全的：守卫已确认零契约版本2行，意味着零行`symbol IS NULL`，`SET NOT NULL`必然成功。）

### 11.3 回滚限制（红线，闭环一致性自检第7项）

1. **`DROP COLUMN`不受`dataset_manifests_no_update`/`no_delete`触发器保护**——这两个触发器只拦截`UPDATE`/`DELETE` DML语句，`ALTER TABLE ... DROP COLUMN`是DDL，触发器不会拦截。这意味着"表被声明为不可变"与"表的schema本身不会被破坏性变更"是**两个独立的保证**，前者不自动蕴含后者。本附录通过11.2的`down.sql`显式守卫弥补这一缺口，**要求任何未来的migration 007回滚操作前必须先确认零契约版本2记录**，不得仅依赖人工检查清单。
2. **实施阶段操作要求**：若确需回滚migration 007，操作者必须先运行只读查询确认`SELECT count(*) FROM historical_validation.dataset_manifests WHERE manifest_contract_version = 2`为0（或明确决定放弃已有的契约版本2记录，走独立的、显式授权的数据归档/迁移流程后再回滚——本轮不定义该流程），否则`down.sql`本身会在守卫处抛异常并中止，不会执行到实际的`DROP COLUMN`语句（PL/pgSQL的`DO`块异常会导致整个migration事务回滚，不会留下"部分列已删除"的中间态）。
3. **与migration 006兼容性**：migration 007完全建立在migration 006已存在的`fixed_as_of`/`logical_window_hash`列之上，不修改、不删除这两列，不修改migration 006新增的partial unique index与format CHECK。
4. **001-006不得修改**：本附录重申既有红线，migration 007是**唯一**允许新增的migration文件，001-006文件内容不得回头编辑。
5. **legacy行不得被伪造为新版本Manifest**：11.2的`up.sql`不包含任何将既有行的`manifest_contract_version`从默认值1改为2的语句（`ALTER TABLE ADD COLUMN ... DEFAULT 1`只会让所有既有行获得值`1`，没有任何机制把某些既有行"升级"为`2`）——这从migration设计层面直接保证了"不会有历史遗留数据被意外贴上契约版版2标签"。
6. **并发创建同一逻辑窗口的行为**：与既有单symbol路径完全一致，见第七节第6-7条——advisory lock+`resolveManifestLogicalWindow`机制不因migration 007而改变，并发请求构建同一逻辑窗口的两个进程，一个成功`INSERT`，另一个要么幂等返回同一行（内容相同时），要么收到`DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT`（内容不同时）——不会出现两条同逻辑窗口但内容不同的行同时持久化成功的情况。

### 11.4 CLI变更（`dataset:build-manifest`，冻结）

```
# 契约版本1（legacy，既有语义不变，本轮起显式要求 --contract-version 1）
npm run dataset:build-manifest -- \
  --contract-version 1 \
  --symbol ETHUSDT \
  --intervals 15m,1h,4h \
  --from 2026-01-26T00:00:00Z \
  --to 2026-07-25T00:00:00Z

# 契约版本2（本附录新增，symbols/dependency_set由FEATURE_BAR_DEPENDENCIES机械推导，不接受--symbol/--intervals）
npm run dataset:build-manifest -- \
  --contract-version 2 \
  --from 2026-01-26T00:00:00Z \
  --to 2026-07-25T00:00:00Z \
  --fixed-as-of 2026-07-24T23:59:59.999Z
```

**冻结规则**：
1. `--contract-version`本轮起为**必需参数**，取值`{1,2}`，不设默认值（fail-closed against省略导致的隐式行为）——这是对既有CLI契约的一次刻意的、有意为之的breaking change，理由：防止实施完成后有人在不知情的情况下继续悄悄构建契约版本1 Manifest。
2. `--contract-version 2`时，`--symbol`/`--intervals`**不得传入**，传入即报错`CONFLICTING_CONTRACT_PARAMS`（符号与本附录同名精神一致：显式冲突参数直接拒绝，不做"忽略多余参数"的宽容处理）；`--fixed-as-of`**必需**（对应第一节CHECK约束的强制非空要求）。
3. `--contract-version 1`时，行为与`V1_4D_HISTORICAL_REPLAY_SPEC.md`§4.0既有描述完全一致，`--fixed-as-of`保持既有的**可选**语义（migration 006既有的nullable约定，本附录不追溯收紧）。

---

## 十二、验收测试新增总纲（R28由本附录及实现测试承载）

本附录要求的24项验收场景以`R28`编号记录在本节，并由后续实现测试与治理记录落实。它们**没有**追加或回写到`V1_4D_ACCEPTANCE_TESTS.md`；该draft-4正式冻结文档继续逐字保持原样。本节列出场景到条款的映射索引：

| 场景 | 对应R28 ID | 对应本附录条款 |
|---|---|---|
| 正确ETH/BTC依赖集合成功 | R28.1 | 第三节 |
| 仅ETH被阻断 | R28.2 | 第九节 |
| 缺失BTC 15m被阻断 | R28.3 | 第九节 |
| 误含BTC 1h/4h的处理 | R28.4 | 第三节第3条 |
| 依赖顺序变化不改变哈希 | R28.5 | 第三节第4条/第六节 |
| 成员顺序变化不改变哈希 | R28.6 | 第五节第2条/第六节 |
| 重复依赖的确定性处理 | R28.7 | 第三节第4条 |
| 未知契约版本被阻断 | R28.8 | 第一节第4条 |
| legacy Manifest不可用于新版本Feature | R28.9 | 第九节/第十节 |
| 同窗口同内容幂等 | R28.10 | 第七节第3条 |
| 同窗口不同内容冲突 | R28.11 | 第七节第4条 |
| 并发创建只产生一个合法结果 | R28.12 | 第七节第6-7条 |
| 不同周期计数差异不得抵消 | R28.13 | 第八节第2条 |
| 超出fixed_as_of的K线被阻断 | R28.14 | 第四节第5条 |
| 不在成员ID内的vintage被阻断 | R28.15 | 第九节第4条 |
| 全库多余K线不被读取 | R28.16 | 第五节第6-7条 |
| ETH/BTC血缘完整 | R28.17 | 第九节3.3 |
| dry-run零写入 | R28.18 | 第九节3.4 |
| Migration up/down/up | R28.19 | 第十一节 |
| 回滚与legacy共存 | R28.20 | 第十一节/第十节 |
| 哈希golden测试向量 | R28.21 | 第六节6.4 |
| 真实PostgreSQL查询验证 | R28.22 | 第五节第6条 |
| 事务回滚 | R28.23 | 第七节第7条 |
| 服务器历史72/-72只读诊断 | R28.24 | 第八节第3条 |

---

## 十三、实施边界（由本附录及后续实施治理记录承载）

本附录要求的Codex后续实施包边界（schema/migration、repository层、Manifest builder/verifier扩展、CLI、Backfill适配、Feature Backfill适配、血缘/审计、dry-run、legacy只读诊断、单元测试、PostgreSQL集成测试、回归测试、服务器只读取证命令）由本附录及后续实施治理记录承载。它们**没有**作为新章节追加或回写到`V1_4D_CODEX_IMPLEMENTATION_TASK.md`；该draft-4正式冻结文档继续逐字保持原样。

---

## 十四、一致性自检（本附录发布前自查，十项）

1. **本附录是否与draft-4五份文件任一条款冲突？** 是，与`V1_4D_HISTORICAL_REPLAY_SPEC.md`存在预期内的、范围受限的冲突（见§0.3），已通过"新增契约版本2、不修改契约版本1既有条款"的方式化解，不存在未声明的隐藏冲突。
2. **全部冲突是否已通过显式的"附录优先级与范围"机制解决？** 是，见§0.3表格，逐文档列出冲突有无、化解方式；`V1_4D_ARCHITECTURE_REVIEW.md`的历史结论适用范围边界仅在本附录中说明，未回写或追溯修改该draft-4冻结文档。
3. **`symbol`/`symbols`双重语义是否仍然存在？** 否——第一节/第二节已通过契约版本互斥CHECK约束（`dataset_manifests_contract_v1_shape`/`v2_shape`）从数据库层面结构性禁止同一行同时携带`symbol`与`symbols`的非NULL值，不存在"两个字段都有值、可能冲突"的状态。
4. **依赖集合是否错误使用了笛卡尔积？** 否——第三节`dependency_set`显式列出四条真实依赖，且第三节第3条要求其与`FEATURE_BAR_DEPENDENCIES`在`{symbol,interval,marketType}`投影下**完全相等**（非超集），`symbols`/`intervals`两个独立集合的存在**不产生**任何笛卡尔积推断路径（第三节第2条已明确指出这正是`dependency_set`需要独立存在的原因）。
5. **内容哈希是否可能被两种不同（但均符合规范）的实现给出不同结果？** 否——第六节已冻结精确的16字段清单、逐字段排序规则（含`vintageId`最终决胜）、caller侧类型纪律，并提供了基于**实际生产`canonicalJsonHash()`函数**计算得到的完整worked example与golden哈希值（第六节6.4），任何遵循本附录字段清单与排序规则的正确实现都必须复现该golden值，偏差即说明实现有误而非规范有歧义。
6. **legacy处理策略是否会修改不可变数据？** 否——第十节第1-2条确认legacy记录的保护完全依赖既有`dataset_manifests_no_update`/`no_delete`触发器（对全表生效，不区分契约版本），本附录未新增、也不需要新增任何针对legacy记录的写操作；migration 007（第十一节）不含任何`UPDATE`/`DELETE`语句。
7. **Migration回滚是否会丢失或误读数据？** 已识别真实风险点并冻结应对方案——`DROP COLUMN`不受不可变触发器保护（第十一节11.3第1条），已通过`down.sql`显式守卫（存在契约版本2记录时拒绝回滚，第十一节11.2）消除"静默丢失多symbol身份数据"的可能性。
8. **Feature是否仍可能在新规范下读取未治理的BTC数据？** 否——SQL级`vintage_id = ANY(governedVintageIds)`治理（既有实现）在单一多symbol Manifest模型下结构性地自动覆盖BTC与ETH（第五节第6条），第九节新增的构建期/启动期门禁（`DEPENDENCY_UNGOVERNED`/`DEPENDENCY_INCOMPLETE`/`MEMBER_IDENTITY_MISSING`/`CONTRACT_VERSION_UNSUPPORTED`）在查询发生前提供额外一层拦截，运行期`SOURCE_NOT_IN_DATASET_MANIFEST`/`SOURCE_OUTSIDE_DATASET_MANIFEST`提供逐行二次防线，三层防御无一依赖"BTC数据恰好不存在"这类偶然条件。
9. **验收测试是否覆盖真实PostgreSQL代码路径而非只有mock？** 是——本附录R28.22专门要求真实PostgreSQL集成测试验证`vintage_id = ANY()`治理效果（对照既有单symbol场景下已完成的同类真实数据库验证方法），R28.19/R28.23同样要求PostgreSQL集成测试；这些要求由本附录及实现测试承载，未写入`V1_4D_ACCEPTANCE_TESTS.md` draft-4正文。
10. **服务器历史72/-72结论是否在只读取证实际完成前保持`NOT_CONFIRMED`？** 是——第八节第3-4条明确重申该状态要求，本附录本身不执行任何取证查询、不访问生产数据库，不对该结论做出或暗示任何新的确认。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4d-multi-symbol-addendum-draft-1 | 2026-08-03 | 初稿：正式冻结P0-3"单一多symbol Dataset Manifest"架构裁决；新增`manifest_contract_version`/`dataset_type`/`symbols`/`dependency_set`契约；冻结契约版本2内容哈希16字段清单与基于实际`canonicalJsonHash()`计算的worked example/golden哈希值；冻结`logical_window_hash`多symbol身份对象（`dependencySet`取代扁平`symbols`+`intervals`）；冻结分依赖独立完整性验证与禁止跨依赖抵消规则；新增5个错误码并与既有错误码（`DATASET_MANIFEST_DEPENDENCY_UNGOVERNED`/`LOGICAL_WINDOW_CONFLICT`/`MEMBERS_MISSING`/`SOURCE_NOT_IN_DATASET_MANIFEST`/`SOURCE_OUTSIDE_DATASET_MANIFEST`）逐一reconcile；冻结legacy策略十条；判定Migration 007为**必需**并给出完整up/down.sql（含回滚守卫）；与draft-4五份文档的冲突范围与化解机制（§0.3）；十项一致性自检全部通过 |
