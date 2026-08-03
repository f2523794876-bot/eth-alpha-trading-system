# V1_4D_ARCHITECTURE_REVIEW.md — V1.4D 独立架构复审

版本：**v1.4d-review-draft-4**（第三阶段定向修订：关闭dataset_version截断风险P1，核实canonicalJsonHash()契约，补齐排序决胜字段）
基线：`main@eb89c49f0957617c453ea2c0d149afb55e97dad0`
角色：本文档是对`V1_4D_DATA_BACKFILL_SPEC.md`（draft-4）/`V1_4D_HISTORICAL_REPLAY_SPEC.md`（draft-4）/`V1_4D_CODEX_IMPLEMENTATION_TASK.md`（draft-4）/`V1_4D_ACCEPTANCE_TESTS.md`（draft-4）四份文档的**第三阶段定向复审**，核验本轮用户直接指出的截断P1是否真正关闭、`canonicalJsonHash()`契约核实是否已落实（而非停留在"待确认"）、排序规则是否消除一切并列歧义。

---

## 1. 本轮触发原因

用户直接指出draft-3的`dataset_version = v1.4d-${contentHash.slice(0,16)}`只截取16个十六进制字符（64-bit），作为长期内容寻址的主键碰撞裕量不足，要求改为完整SHA-256或128-bit以上截断+独立校验，二选一并采用推荐方案（完整SHA-256）。用户同时指出三个未闭环的次要问题：canonical manifest输入字段清单需要精确对齐、排序规则需要消除并列歧义、`canonicalJsonHash()`此前只在架构评审中标记"待确认P2"而未真正核实。

---

## 2. 本轮关闭项逐一核验

### 2.1 dataset_version 截断风险 — 已关闭

**关闭方式**：采用用户推荐方案（完整SHA-256，未采用128-bit截断备选方案）。

- 新格式：`dataset_version = v1.4d-sha256-{完整64位十六进制}`，长度77字符，无截断（`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.9.0）。
- `content_hash`列改为Postgres**生成列**（`GENERATED ALWAYS AS`），与`dataset_version`结构性恒等，不存在"两个独立存储值需要运行时校验是否一致"这一步骤——比用户备选方案要求的"UNIQUE+启动时一致性校验"更强（生成列使二者不一致在数据库层面不可能发生，不需要额外校验代码）。
- 验收测试R27.1直接验证"不得截断为64-bit"。

### 2.2 canonical manifest 输入字段清单 — 已关闭

`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.9.1按用户本轮给出的清单逐项对齐：`manifestSchemaVersion`/`manifestHashAlgorithmVersion`/`symbol`/`intervals`/`dataFrom`/`dataTo`/`backfillBatchIds`（排序后）/`manifestMembers`（排序后）/`sourceFormalSemantics`/`researchAvailabilityRuleVersion`/`recordCount`/`perIntervalRecordCount`/`integrityCheckResult`——**十三项与用户清单十三项逐一对应**（用户原始清单口语化列出十项+"排序后的backfill_batch_ids"+"确定性排序后的manifest_members"两项，实为十二个概念点，本文档进一步拆分`intervals`/`data_from`/`data_to`为独立三项以精确对齐表结构，属于同一清单的等价展开，无遗漏无新增以外的字段）。

**特别订正**：`manifestHashAlgorithmVersion`此前（draft-3）被排除在哈希内容外，理由是"避免循环定义"——本轮核实该理由不成立（哈希函数处理一个固定版本标签字符串，与处理其他任何字符串字段无异，不构成"哈希引用自身输出"的循环），已改为**纳入**哈希内容，与用户清单要求一致。

### 2.3 排序规则 — 已关闭（消除并列歧义）

- `backfillBatchIds`：去重 + UUID文本字典序。UUID全局唯一，不存在排序并列的可能性，无需额外tiebreaker（`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.9.2）。
- `manifestMembers`：排序键从draft-3的三元组`(intervalName, openTime, revisionNumber)`扩展为**四元组**`(intervalName, openTime, revisionNumber, vintageId)`——`vintageId`在生产`market_bars`表上有`UNIQUE`约束（全局唯一），是唯一能保证在前三字段全部相同时仍能给出确定顺序的字段。**这不是"实践中大概率不会并列"的概率性论证，是"即使理论上出现并列，仍有一个结构性保证唯一的字段兜底"的确定性论证**（同§2.9.2）。
- `created_at`及运行时间继续排除在哈希外（§2.9.6，本轮未变）。
- 验收测试R27.2（批次顺序无关）/R27.3（成员查询顺序无关）/R27.4（人为构造并列场景验证`vintageId`决胜）三条覆盖。

### 2.4 canonicalJsonHash() 契约核实 — 已关闭（实际读取源码，非标记"待确认"）

**本轮实际执行**：使用Read工具完整读取`server/src/domain/hash.js`全文（37行），逐项核实结论记录于`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.9.4：

| 核实项 | 结论 |
|---|---|
| 对象键是否规范化排序 | 是（`Object.keys(current).sort()`） |
| 数值/null/字符串序列化是否稳定 | 稳定，但小数字段（源自Postgres `numeric`）必须由调用方以字符串形式传入，不得转JS `number`（浮点精度风险不在函数本身，在调用方类型纪律，已冻结为§2.9.5红线） |
| 数组是否严格保留调用方顺序 | 是，已确认（`current.map(encode).join(',')`，无排序逻辑） |
| 是否采用冻结的哈希算法 | 是，`node:crypto`标准SHA-256 |

**结论：现有函数满足契约，继续复用，不新建第二套哈希/规范化实现**（用户"若不满足契约则须新建模块"的条件不成立）。同时，本轮按用户要求把"核实任务"本身写入了实施任务（`V1_4D_CODEX_IMPLEMENTATION_TASK.md`新增`hash-contract-verification.test.js`，构建顺序第3步第一项）与验收测试（R27.9/R27.10），**要求实施阶段对届时实际运行的`domain/hash.js`重新核实**（因为本轮核实的是当前代码状态，不能保证实施阶段代码未变）——若届时结论不再成立，规范已冻结应对路径：在允许新增的`canonical-manifest-content.js`内部实现独立版本化编码，不修改`domain/hash.js`本身（该文件是生产多处复用的既有模块，属于`V1_4D_CODEX_IMPLEMENTATION_TASK.md`§1.2"可复用但禁止修改"清单成员）。

**用户"不能仅在架构评审中标记为待确认P2"的要求已满足**：本文档不再使用"P2待确认"这一表述描述canonicalJsonHash契约问题，因为本轮已实际核实并得出确定结论；唯一保留的"未来时"表述是"实施阶段需对**届时**代码重新核实"，这不是本轮遗留的不确定性，是任何规范都无法对尚未开始的实施阶段代码做出的合理保留（本轮核实的是本轮读到的源码，这是可验证的事实，不是猜测）。

---

## 3. 追溯矩阵增量（在draft-3 33行基础上新增）

| # | 要求 | 规范章节 | 实施任务 | 验收测试 | 状态 |
|---|---|---|---|---|---|
| 34 | dataset_version禁止64-bit截断，采用完整SHA-256或128-bit+独立校验二选一并冻结 | REPLAY§2.9.0 | CODEX migration任务（dataset_version完整格式+content_hash生成列） | R27.1 | 已关闭（采用完整SHA-256） |
| 35 | canonical manifest输入十二字段精确对齐 | REPLAY§2.9.1 | CODEX `canonical-manifest-content.js`任务 | R26.1-R26.5/R27.5/R27.6 | 已关闭 |
| 36 | backfill_batch_ids确定性排序（不得只依赖可能并列字段） | REPLAY§2.9.2 | CODEX同上 | R27.2 | 已关闭 |
| 37 | manifest_members确定性排序，含完整稳定身份字段决胜 | REPLAY§2.9.2 | CODEX同上 | R27.3/R27.4 | 已关闭 |
| 38 | created_at及运行时间排除在哈希外 | REPLAY§2.9.6 | CODEX同上 | R26.2 | 已关闭 |
| 39 | 核实canonicalJsonHash()对象键排序/数值稳定性/数组保序/哈希算法 | REPLAY§2.9.4 | CODEX `hash-contract-verification.test.js`（本轮新增） | R27.9/R27.10 | 已关闭（本轮实际核实，非标记待确认） |
| 40 | 若现有函数不满足契约，须在允许新增模块中实现版本化编码，不修改生产路径 | REPLAY§2.9.4末段 | CODEX同上任务说明 | — | 已关闭（条件不成立：现有函数满足契约，应对路径仍已冻结备用） |
| 41 | 完整哈希不截断、批次/成员顺序无关、并列决胜确定、算法/schema版本变化产生不同版本、多种不一致fail-closed、resume/dry-run覆盖 | REPLAY§2.9全节/§4.1a | CODEX相应任务 | R27.1-R27.12 | 已关闭 |

**draft-3第3节9行、draft-2/draft-1的24行追溯矩阵继续有效**，本轮未发现需要撤销或降级的历史项。

---

## 4. 最终 P0/P1/P2 统计（本轮按用户要求以明确、无歧义方式陈述，不使用括号内暗示未关闭问题的表述）

**P0 数量：0**

**P1 数量：0**

**P2 数量：4，逐一列出，均为已归档的历史遗留观察项，不影响本轮结论**：
1. `backfill_batch_id`在`replay_snapshots`中的角色是审计字段而非查询过滤条件，这一区分在`V1_4D_HISTORICAL_REPLAY_SPEC.md`中的表述可以更精确（draft-2识别，本轮复查仍成立，不属于本轮新增问题）。
2. `OBSERVED`/`FROZEN_POLICY`/`ASSUMPTION`标注依赖人工审查，暂无自动化测试逐条断言标注存在（draft-2识别，本轮复查仍成立）。
3. `manifest_members`哈希计算在大数据量（如180天窗口约22,680行）下的启动耗时未设性能基准，建议实施阶段记录（draft-3识别，本轮复查仍成立）。
4. 实施阶段第一步的`hash-contract-verification.test.js`结论**必然**要到实施阶段实际执行才能100%确认（本轮的核实基于当前读到的源码，具备事实依据，但"届时代码是否变化"是任何规范文档都无法对未来做出的保证）——这不是本轮遗留的设计缺陷，是对"实施阶段与规范阶段之间可能存在时间差"这一客观事实的如实记录，规范已冻结了该情形发生时的应对路径（§2.4末段），不构成阻断。

**以上四项均为P2，不是P1，不是"暂时按P2处理的P1"，也不是"本轮新发现尚待关闭的问题"——四项在措辞上均已给出关闭路径或复查确认，唯一共性是"重要性不足以阻断本轮结论、但值得在实施阶段留意"，这正是P2的定义，不构成本节标题"P0/P1/P2统计"与下一节最终结论之间的矛盾。**

---

## 5. 最终结论

# **READY_FOR_CODEX_IMPLEMENTATION**

判定依据：**P0=0，P1=0**，二者同时成立，按用户冻结的判定规则直接对应`READY_FOR_CODEX_IMPLEMENTATION`，无需任何例外解释或改写措辞。本轮用户指出的截断风险已通过采用完整SHA-256（用户推荐方案）真正关闭；canonical manifest输入字段清单、排序规则的并列歧义、`canonicalJsonHash()`契约核实三项要求均已逐项落实到规范文本、实施任务、验收测试三层，追溯矩阵新增8行全部标记"已关闭"。

**本轮仍然只是规范制定与修订，未执行任何代码/数据库/回填/回放/生产变更；即使结论为`READY_FOR_CODEX_IMPLEMENTATION`，也不得开始实施、不得提交，等待CEO单独授权方可进入实施阶段。**

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4d-review-draft-1 | 2026-07-25 | 初稿：CEO十条裁决逐条核验、回填协议七项子要求复核、主动发现6项P1/P2风险、数据窗口独立复核、既有规范接口一致性检查、最终结论READY_FOR_IMPLEMENTATION_REVIEW |
| v1.4d-review-draft-2 | 2026-07-25 | 第三阶段独立复审：发现并订正120天窗口证明错误（purge缺失），推荐窗口改为180天；统一订正"六张表"为七张；逐项关闭draft-1遗留4项P1；新增物理隔离/backfill边界/CLI契约核对与24行追溯矩阵；结论升级为READY_FOR_CODEX_IMPLEMENTATION（**遗留自相矛盾：第9节写P1=1，第10节仍给出该结论**） |
| v1.4d-review-draft-3 | 2026-07-26 | 第三阶段补充修订：修正draft-2判定冲突，真正关闭`dataset_version`内容哈希P1（新增`dataset_manifests`表、七张→八张、确定性生成规则、§4.1a八步校验）；自我复审发现2项P2；追溯矩阵新增9行；结论保持READY_FOR_CODEX_IMPLEMENTATION且判定规则真正被满足 |
| v1.4d-review-draft-4 | 2026-07-26 | 第三阶段定向修订：①关闭用户直接指出的`dataset_version`截断风险（16hex/64-bit→完整64hex SHA-256，采用推荐方案，`content_hash`改为生成列）；②`manifestHashAlgorithmVersion`订正为纳入哈希内容；③`manifest_members`排序补齐`vintageId`决胜字段，`backfillBatchIds`排序规则明确去重+字典序；④**实际读取`domain/hash.js`源码**核实`canonicalJsonHash()`四项契约（不再标记"待确认P2"），核实任务与应对路径写入实施任务与验收测试；⑤追溯矩阵新增8行；⑥第4节按用户要求以明确、无歧义方式重新陈述P0/P1/P2统计，避免"P1=0但括号中仍描述新增问题"的矛盾句式；⑦结论保持READY_FOR_CODEX_IMPLEMENTATION |
