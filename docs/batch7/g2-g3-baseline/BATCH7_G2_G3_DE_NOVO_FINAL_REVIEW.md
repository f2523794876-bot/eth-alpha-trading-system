# Batch7 G2/G3 De Novo 最终设计复审报告

## 1. 本轮性质和范围

本轮是一次**全新的、从零开始**的G2/G3设计复审（de novo review），**不是**对此前缺失材料所致"恢复复审"的延续或替代。本轮**不依赖**此前"G1 PASS/G2 FAIL/G3 FAIL"这一结论作为证据，只把它作为"为什么发起本轮复审"的背景动机来说明，不作为本轮判定G2/G3是否PASS的依据。本轮结论完全建立在**当前工作区实际存在的最终设计材料**之上，独立重新推导。

范围：只复审G2、G3两项固定门禁及与之直接相关的execution authority、operation ledger、artifact publication协议设计。**不重新审查G1**（按第7节要求，只标注`NOT_REVIEWED_IN_THIS_DE_NOVO_G2_G3_REVIEW`）。只进行只读设计复审，不修改任何既有文件、代码、测试、数据库、冻结契约，不修正发现的问题，不重新设计协议本身。

## 2. 为什么采用de novo review

此前两轮"恢复复审"尝试（`BATCH7_G2_G3_RECOVERY_REVIEW.md`及其撤回、`BATCH7_G2_G3_RECOVERY_REVIEW_EVIDENCE_CORRECTION.md`）均卡在同一个不可解的结构性障碍：此前给出"G1 PASS/G2 FAIL/G3 FAIL"结论的"独立最终复审"本身，除了一句裸结论陈述外，从未以任何形式（文件、消息或其他）存在于本会话或工作区中——不存在可供交叉核验的原始方法论、逐项核验记录或证据链。在这一材料缺口不可能被填补（该复审若确实只以口头/指令形式给出结论、从未产出更详细文档，则该文档永远不会出现）的情况下，继续要求"恢复"一份从未真正存在过的复审，会形成无法终止的循环。委托方据此明确指示改为不依赖旧复审、直接对**当前实际存在的设计**做一次独立、自包含、可被未来任何人重新追溯核验的全新判断，并以本报告作为新的持久化G2/G3正式复审基线。

## 3. 使用的当前证据材料及完整元数据

只读环境核验：

| 项 | 结果 |
|---|---|
| 当前分支 | `claude/r3-batch7-p0-p1-scoped-fix` |
| 当前HEAD | `239302eb48311882ea2f3fa2a4bd227b2b767b64` |
| git status | 干净 |
| 冻结契约SHA-256 | `5369742b33867d5b6870a7f9148246cd12fe5ae5b90a770f2474cc66e0610b42`（未变） |

实际读取（正文，非文件名/摘要）并用于本轮判断的文件：

| # | 文件 | 绝对路径 | 字节数 | 行数 | SHA-256 | Git状态 |
|---|---|---|---|---|---|---|
| 1 | Batch7原始PostgreSQL execution authority设计报告 | `/tmp/claude-1000/-home-ubuntu/c8d9e2d8-889a-4af7-97cf-808bd5f72f6e/scratchpad/frozen-test-evidence/r3-batch7-postgres-authority-DESIGN-REPORT.md` | 109752 | 556 | `926ae6463af3ebfdbce1d7ea642fb17b9bf191aa7d5384a08f5867fbb948afab` | 不受Git跟踪（位于repo工作树`/tmp/.../repo/cloned`之外的scratchpad目录，`git ls-files`确认） |
| 2 | Batch7最终修正报告（P0-1~P0-6，六项阻塞） | `/tmp/claude-1000/-home-ubuntu/c8d9e2d8-889a-4af7-97cf-808bd5f72f6e/scratchpad/frozen-test-evidence/BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md` | 56872 | 522 | `a1c526ddd87bc5053f4f8780183f1a2792ec0b1be43c8e0d670fa3d23c99b56d` | 同上，不受Git跟踪 |
| 3 | 当前合并后的artifact publication单点修正报告（含两轮修正：身份模型拆分+commitArtifactPublication顺序修正） | `/tmp/claude-1000/-home-ubuntu/c8d9e2d8-889a-4af7-97cf-808bd5f72f6e/scratchpad/frozen-test-evidence/BATCH7_ARTIFACT_PUBLICATION_PROTOCOL_SINGLE_ISSUE_CORRECTION.md` | 37836 | 422 | `1d9487dcbdf511c71f243757c4f1838a8ca072bfeb08a8f24a930dfc79dfd24d` | 同上，不受Git跟踪 |
| 4 | 冻结契约（仅确认未修改） | `/tmp/claude-1000/-home-ubuntu/c8d9e2d8-889a-4af7-97cf-808bd5f72f6e/scratchpad/fixwork-1786105615/repo/cloned/V1_4D_FORMAL_RESEARCH_EXECUTION_CONTRACT_V8_FINAL_R3.md` | 不适用(未改动，只核验哈希) | 不适用 | `5369742b33867d5b6870a7f9148246cd12fe5ae5b90a770f2474cc66e0610b42` | 受Git跟踪，HEAD `239302eb48311882ea2f3fa2a4bd227b2b767b64`一致 |

**未使用/已识别为过时的文件**：`r3-batch7-lock-protocol-redesign-DESIGN-REPORT.md`（586字节，10行，`sha256=094bb068f079b6889b37611c2a23fc8b4dc6dbf683a41172379bd81fc3d0bd67`）——这是Batch7最早期基于flock方案（非PostgreSQL）的设计尝试留下的占位存档，内容仅10行，明确记录"该方案已被放弃、改用PostgreSQL方案"，与当前PostgreSQL execution authority设计无关，本轮不作为证据材料使用。

## 4. 当前有效版本判定

三份材料存在**一处关键的、必须显式裁决的版本冲突**，如实说明，不得混合使用：

**冲突点**：文件2（`BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md`）第135-176行（P0-3节）给出的`artifact_publications`表DDL、`registerArtifactUnderFence`/`commitArtifactPublication`机制，使用的是**单一`operation_id`列**同时承担register与promote两种ledger操作的身份（"`operation_id uuid NOT NULL UNIQUE REFERENCES operation_ledger(operation_id)`"）。这**正是**后续独立复审确认必然失败、并驱动文件3两轮修正的**那个原始缺陷版本**——文件2第492行自己给出的"G2: PASS"判断，正是建立在这个后来被证明有结构性缺陷的P0-3设计之上。

**裁决**：文件3是文件2 P0-3节之后产生的**两轮独立修正**（第一轮：`publication_id`/`register_operation_id`/`promote_operation_id`身份拆分；第二轮：`commitArtifactPublication`内部ledger调用顺序与fencing/promoted判断顺序修正），文件3自身第1节明确称"上一轮已正确消除...原始身份冲突"，第一轮又明确是对文件2 P0-3节的定向替换（"只处理独立复审确认的六项阻塞"之外新发现的问题）。**结论：凡涉及`artifact_publications`表结构、`register_operation_id`/`promote_operation_id`/`publication_id`身份模型、`registerArtifactUnderFence`/`commitArtifactPublication`具体伪代码、artifact发布相关的消费者查询条件——一律以文件3为唯一有效版本，文件2第P0-3节（135-202行）视为已被取代，本轮不采信、不引用其DDL或伪代码内容。** 文件2的其余部分（P0-1生产者/消费者审计、P0-2 operation ledger通用规则、P0-4 execution authority DDL、P0-5数据库权限与能力边界、P0-6 takeover判定算法、测试矩阵中不涉及artifact_publications旧DDL的部分）**未被文件3触及，继续有效**，本轮据此使用。

此外需要注意：文件2第484-498节给出的"G1/G2/G3三项最终门禁"自评（含"G2: PASS"）**同样建立在已被取代的P0-3设计之上，本轮不采信该自评结论本身**，只把文件2中未被取代的技术内容（P0-1/P0-2/P0-4/P0-5/P0-6）当作证据输入，重新独立推导G2/G3——这正是本轮"de novo"的含义：不是"確認文件2自己说的PASS对不对"，而是"用当前所有仍然有效的材料，自己重新算一遍"。

## 5. 缺失的当前必需材料

**无。** 判断G2/G3所需的全部当前有效设计材料（execution authority完整DDL与算法、operation ledger完整规则、artifact publication最终协议、生产者/消费者完整审计、权限与能力边界设计、测试矩阵）均可在文件2（除P0-3外）与文件3中完整、直接读取，不存在无法确定版本或缺失内容的情形。

## 6. G2 固定定义

所有纳入本轮范围的正式生产者和正式消费者，是否受到数据库执行权、ownership、fencing_token、幂等operation ledger及正式可见性边界的强制保护。

## 7. G2 逐项核验表

| # | 核验项 | 设计证据（文件:行/节） | 核验结论 | PASS/FAIL |
|---|---|---|---|---|
| 1 | execution authority是否以数据库状态为最终权威 | 文件2 P0-4（`run_execution_authority`表，第218-264行）；文件1 INV-10"文件内容和pathname不决定执行权" | 全部核验逻辑（`assertOwnerAndFence`等价查询）均只读取`run_execution_authority`表，文件系统上不存在任何被用于执行权判断的路径或内容 | **PASS** |
| 2 | lease ownership与fencing_token是否具有明确、单调且不可回退的语义 | 文件2 P0-4 DDL（`fencing_token bigint NOT NULL DEFAULT 0 CHECK(>=0)`第227-228行）；P0-6算法（`newToken = row.fencing_token + 1`第422行） | token仅在ACQUIRE时递增，值只增不减，语义明确 | **PASS** |
| 3 | takeover后旧owner是否不能继续提交正式副作用 | 文件2 P0-6"为什么这样仍然安全"核心论证（第406行）：旧owner任何后续关键副作用尝试都会因`fencing_token`不再匹配而被确定性拒绝 | 安全性来自fencing本身，不依赖"准确判断旧owner已死亡" | **PASS** |
| 4 | 所有正式生产者是否在提交正式副作用前重新验证数据库ownership和token | 文件2 P0-2（register侧authRow核验，第124-135行示例结构）；**文件3**§7 STEP 4（promote侧，fencing核验严格前置于STEP 6/7，第228-245行） | register与promote均在写入前重新以`SELECT...FOR UPDATE`核验当前`owner_instance_id`+`fencing_token` | **PASS** |
| 5 | operation ledger是否具有明确操作类型、请求载荷哈希、状态和结果 | 文件2 P0-2 DDL（`operation_ledger`表，第71-93行：`operation_type`枚举、`request_payload_hash`、`status`三态、`result_payload`） | 字段完整、CHECK约束齐全（含终态时间戳一致性约束） | **PASS** |
| 6 | 相同operation_id及相同载荷是否幂等 | 文件2 P0-2规则1（`ALREADY_COMMITTED`分支，第109行）；**文件3**§9幂等表（register/promote分别覆盖） | 两处生产者（execution authority操作、artifact register/promote）均明确定义幂等重放路径 | **PASS** |
| 7 | 相同operation_id及不同载荷是否被拒绝 | 文件2 P0-2规则（`OPERATION_ID_PAYLOAD_MISMATCH`，第108行）；**文件3**§9同一表 | 一致 | **PASS** |
| 8 | 失败、未知结果和重试是否具有确定恢复路径 | 文件2 P0-2 reconciliation规则（第113-119行）；**文件3**§11恢复规则（register未promote/promote结果未知两种情形分别给出确定路径） | 无"猜测"分支，全部归约为查询`operation_ledger`/业务表的确定性判据 | **PASS** |
| 9 | artifact register与promote是否通过publication_id稳定关联 | **文件3**§5 DDL（`publication_id uuid PRIMARY KEY`）、§6/§7伪代码（均以`publication_id`定位） | 独立于两次ledger操作各自的operation_id，稳定关联键；此项**取代**文件2 P0-3节已废弃的单一`operation_id`设计 | **PASS** |
| 10 | register_operation_id与promote_operation_id是否独立且语义唯一 | **文件3**§4语义定义、§5 DDL（两个独立UUID列，各自不同约束） | 互不干扰，各自只服务于对应ledger操作的幂等判定 | **PASS** |
| 11 | promote ledger创建时run_identity_sha256是否真实且非空 | **文件3**§7 STEP 0-1（不加锁预查询取得真实值后才调用`ledgerBeginOrInspect`，第162-187行） | 阻塞1的构造性修正，不存在用`null`调用`NOT NULL`列所在表的不可执行语句 | **PASS** |
| 12 | 新的promote操作是否在任何成功结果前验证当前owner与token | **文件3**§7 STEP 4严格前置于STEP 6（第228-266行），对`pubRow.promoted`为true或false均无条件适用 | 阻塞2的构造性修正 | **PASS** |
| 13 | 已promoted记录是否不能被新操作覆盖原发布身份 | **文件3**§7 STEP 6（`ALREADY_PROMOTED`分支不执行任何`UPDATE artifact_publications`，第253-265行）；§5 `ap_promoted_field_consistency` CHECK | 字段只能整体从空到非空一次性转变，唯一写入路径是STEP 7 | **PASS** |
| 14 | 旧token是否不能形成COMMITTED的成功promote记录 | **文件3**§7 STEP 4 `authRow IS NULL`分支明确写`ABORTED`（不是`COMMITTED`，第237-244行）；§12场景1-2 | 旧token只能产出`ABORTED`记录 | **PASS** |
| 15 | 两个owner竞争同一publication时是否最多一个合法发布 | **文件3**§12完整四场景分析，基于`FOR UPDATE`行锁串行化+STEP 4 fencing | 恰好一次合法promote成立 | **PASS** |
| 16 | 正式生产者是否不能绕过批准后的数据库协议产生正式可见结果 | 文件2 P0-5（`run_authority_runtime`角色对四张核心表零DML权限，仅`EXECUTE`受控函数，第343行；三层强制手段第388-392行） | 数据库权限系统物理层面阻止旁路，不依赖应用层自律 | **PASS** |
| 17 | 正式消费者是否只能通过正式数据库查询取得结果 | 文件2 P0-5（`run_authority_reader`角色只有`current_valid_artifacts`视图`SELECT`权限，第344行）；**文件3**§13（消费者唯一合法读取条件） | 一致，消费者角色权限范围明确排除底层表/staging/pathname | **PASS** |
| 18 | 当前设计是否存在不受上述控制的其他正式生产者或消费者 | 文件2 P0-1完整15类入口审计（第30-46行），结论为"仓库内合法生产入口已完整枚举"（第50行） | 未发现无法归类或存在旁路的入口；DRY_RUN/`historical_validation`子系统经确认为架构独立的域外系统，不计入 | **PASS** |

**G2逐项核验：18/18 PASS。**

## 8. G3 固定定义

是否仍存在无法通过数据库ownership/fencing隔离的关键正式副作用，或者任何正式消费者可以绕过数据库正式状态读取未授权、未完成、未promote、已失效或属于旧owner的结果。

## 9. G3 逐项核验表

| # | 核验项 | 设计证据 | 核验结论 | PASS/FAIL |
|---|---|---|---|---|
| 1 | staging文件、临时文件、pathname和rename是否不能自行产生正式可见性 | **文件3**§13（消费者只`SELECT current_valid_artifacts`视图）；文件2 P0-5（reader角色对底层表/staging零访问权限） | 文件系统状态从不参与消费者可见性判断 | **PASS** |
| 2 | register成功但未promote的artifact是否不可见 | **文件3**§6（`promoted`显式写`false`）、§13视图`WHERE promoted=true`过滤 | 未promote行被视图排除 | **PASS** |
| 3 | promote失败或结果未知时是否只能依据数据库最终提交状态判断可见性 | **文件3**§11恢复规则（`reconcileOperationOutcome`）；文件2 P0-2 reconciliation | 全部归约为查询已提交状态，无猜测分支 | **PASS** |
| 4 | 旧owner即使已经写出文件，是否仍不能发布 | **文件3**§7 STEP 7注释（rename在调用本函数前已完成，但`promoted`只能由STEP 7的`UPDATE`设置，且STEP 7前必须先通过STEP 4 fencing） | rename本身不触发正式可见性 | **PASS** |
| 5 | takeover前启动、takeover后完成的旧owner操作是否会被token拒绝 | 文件2 P0-6核心论证；**文件3**§12场景1-2 | 旧owner的后续尝试在STEP 4/`assertCurrentFence`处被拒绝 | **PASS** |
| 6 | publication由新owner发布后，旧owner是否不能通过新operation_id获得成功记录 | **文件3**§12场景1、§14.2测试场景N1 | STEP 4无条件拒绝，不到达STEP 6/7 | **PASS** |
| 7 | 消费者是否不能通过register_operation_id或未发布数据库行旁路读取 | **文件3**§13（消费者权限范围不含`register_operation_id`/底层表列）；文件2 P0-5 reader角色定义 | 消费者只能`SELECT`视图，视图本身不暴露该列供旁路查询使用 | **PASS** |
| 8 | content_hash、publication状态和正式记录是否必须一致 | **文件3**§7 STEP 5（fencing通过后校验`content_hash`一致，不一致则`ARTIFACT_CONTENT_HASH_MISMATCH`） | 一致性作为独立校验步骤存在 | **PASS** |
| 9 | 已撤销、失效或不完整的publication是否不可见 | **文件3**§13（"未引入撤销/失效机制，继承既有设计，非本轮范围"）；"不完整"（`promoted=false`）行经视图过滤不可见 | 当前设计**未引入**撤销/失效概念，因此不存在"已撤销但仍可见"这一风险类别本身（vacuous）；"不完整"这一子情形已被验证覆盖。若未来引入撤销机制，需要新的独立设计与复审，非本轮范围内缺陷 | **PASS**（附带范围说明，非缺陷） |
| 10 | 是否存在数据库事务之外即可被正式消费者接受的关键副作用 | **文件3**§13+文件2 P0-5：消费者唯一入口是数据库视图查询，本身即是一次数据库事务读取 | 不存在事务外的可信副作用 | **PASS**（"是否存在"的正确答案为"否"，判定PASS） |
| 11 | 是否存在先产生不可逆正式副作用、后验证fencing的执行顺序 | **文件3**§7 STEP 4严格前置STEP 6/7（这正是阻塞2的修正对象）；§16"本轮是否完全消除了已确认的两处阻塞"结论"是" | 不存在——fencing核验是任何导向`COMMITTED`/`promoted=true`结果的路径的无条件前置条件 | **PASS**（"是否存在"的正确答案为"否"） |
| 12 | artifact修正是否引入新的直接旁路或身份矛盾 | **文件3**§17逐项复核（预查询陈旧数据、一致性核验分支、fencing顺序调整、状态区分、幂等边界、竞争场景、消费者读取条件——均确认未引入新矛盾） | 未发现新增矛盾 | **PASS** |

**G3逐项核验：12/12 PASS。**

## 10. 并发与故障场景矩阵

| # | 场景 | 设计规则来源 | 结论 |
|---|---|---|---|
| 1 | 两个owner同时竞争 | 文件2 P0-6"两个recovery同时takeover"（execution authority层）；**文件3**§12（publication层） | `FOR UPDATE`行锁天然串行化，恰好一方成功 |
| 2 | 新owner takeover期间旧owner仍在运行 | 文件2 P0-6核心论证；**文件3**§12场景1-2 | 旧owner后续任何写入尝试均因fencing不匹配被拒绝，不构成数据损坏/双写 |
| 3 | 相同operation_id相同载荷重试 | 文件2 P0-2规则1；**文件3**§9、§14.2 N3 | `ALREADY_COMMITTED`直接返回原结果，不重复副作用 |
| 4 | 相同operation_id不同载荷冲突 | 文件2 P0-2；**文件3**§9 | `OPERATION_ID_PAYLOAD_MISMATCH`，无写入 |
| 5 | 数据库提交成功但调用方结果未知 | 文件2 P0-2 reconciliation；**文件3**§11 | 用原operation_id查询ledger/业务表判定真实结果，不盲目重试 |
| 6 | ledger创建后业务事务失败 | 文件2 P0-2规则2（`UPDATE...SET status='ABORTED'`同事务提交）；**文件3**§7 STEP 4/5/6各`ABORTED`分支 | 失败本身是明确的、持久化的结果，不是"什么都没发生" |
| 7 | publication预查询后、加锁前被删除或身份改变 | **文件3**§7 STEP 2-3、§14.2 N4/N6 | STEP 2独立以`FOR UPDATE`重新裁决，不信任STEP 0陈旧读结果；STEP 3核验一致性，不一致则`ARTIFACT_PUBLICATION_IDENTITY_DRIFT` |
| 8 | register成功但promote未发生 | **文件3**§11第一条 | 任意后续持有效token的进程可发起promote，STEP 4验证后正常完成 |
| 9 | 新owner先promote，旧owner随后调用 | **文件3**§12场景1、§14.2 N1 | 旧owner在STEP 4被拒绝，不产生`ALREADY_PROMOTED`或任何成功记录 |
| 10 | 当前合法owner对已promoted记录使用新的operation_id确认状态 | **文件3**§12场景4、§14.2 N2 | STEP 4通过后走STEP 6"确认既成状态"分支，不覆盖原字段 |
| 11 | 消费者尝试直接读取staging/pathname/未发布行 | 文件2 P0-5 reader角色权限定义；**文件3**§13 | 权限系统物理阻止，消费者角色不具备底层表/staging访问权限 |
| 12 | 数据库暂时不可用时生产者是否会fail closed | 文件1 INV-9（`createGuardedResearchPgPool`fail-closed实现）；文件2继承未修改 | 连接失败即拒绝，不产生任何本地文件写入或状态假设 |

**12/12场景均有明确、可追溯的设计规则覆盖，无未定义行为。**

## 11. artifact publication协议专项核验

（本节汇总第7/9节中artifact publication相关项，作为独立聚焦视角，不重复完整推导）

- **身份模型**：`publication_id`（关联键）+ `register_operation_id`（register幂等）+ `promote_operation_id`（promote幂等）三者语义互不重叠，经文件3§4/§5确认。
- **两处历史阻塞**（run_identity_sha256为null时调用ledger、promoted判断先于fencing核验）均已在文件3§7给出构造性修正（STEP 0-7完整顺序），并经文件3§16逐条确认关闭。
- **消费者边界**：文件3§13定义的唯一合法查询路径与文件2 P0-5定义的数据库权限设计（`run_authority_reader`角色）完全一致、无冲突。
- **本专项核验结论：与G2第9-15项、G3全部12项核验结果一致，全部PASS，无独立于上述逐项核验之外的新增发现。**

## 12. 正式生产者覆盖清单

（引自文件2 P0-1完整审计表，第30-46行；本轮确认自P0-1审计完成后仓库`git status`持续保持干净、HEAD未变，无新代码改动，该清单当前仍然准确）

| 生产者 | 类型 | fencing覆盖 |
|---|---|---|
| `formal-research-orchestrator.js`（创建run/启动/恢复/checkpoint/最终状态，8处调用点） | 正式研究FORMAL入口 | 是（改接`acquireExecutionAuthority`+`publishRunStatusUnderFence`+`publishArtifactUnderFence`） |
| `artifact-publisher.js`（`publishArtifact`） | D7 artifact发布 | 是（改接`publishArtifactUnderFence`，内部即文件3的`registerArtifactUnderFence`+`commitArtifactPublication`） |
| `research-run-status.js`（legacy锁实现） | 待退役 | 退役后由统一能力函数完全替代，不再是独立生产者 |
| `cli-entry.js`（`validation:walk-forward`） | DRY_RUN域外系统 | 不适用（域外，自带独立治理，不产出正式研究结果） |

未发现清单外的其他正式生产者（文件2 P0-1第50行结论）。

## 13. 正式消费者覆盖清单

| 消费者 | 类型 | fencing/可见性覆盖 |
|---|---|---|
| `d8-status-reader.js`（`readD8DisplayStatus`） | 正式状态读取核心 | 迁移为查询`current_valid_artifacts`视图 |
| `src/api/server.js`（`GET /api/v1/research/d8/status`） | HTTP API | 经由d8-status-reader传导，同上 |
| `src/dashboard/d8-research-page-render.js` | Dashboard渲染 | 经由d8-status-reader传导，同上 |
| `v1-4d-scorecard-cli.mjs` | DRY_RUN域外消费者 | 不适用（域外，读取`historical_validation.*`表，与正式研究结果无关） |

未发现清单外的其他正式消费者（文件2 P0-1第50行结论）。

## 14. 是否存在未受fencing保护的正式副作用

**否。** 第7/9/10/11节逐项核验、第12节生产者清单交叉确认：正式研究管线（`formal-research-orchestrator.js`→`artifact-publisher.js`）不产生任何数据库写副作用之外的、未被fencing覆盖的关键副作用；子进程/webhook/第三方API发布等类别经文件2 P0-1第44行确认零命中。

## 15. 是否存在消费者旁路

**否。** 第9节第1/7/10项、第13节消费者清单确认：全部正式消费者入口均已设计为唯一通过`current_valid_artifacts`视图取得结果，数据库权限（`run_authority_reader`角色）在物理层面排除对底层表、staging路径、register_operation_id等的直接访问。

## 16. 是否依赖范围外假设

**否。** 本轮结论完全建立在第3/4节明确列出、已实际读取正文的当前有效设计材料之上，未引用任何缺失文档、未依赖旧复审的裸结论、未假设任何本轮未直接核验的内容成立。第4节已明确处理并裁决了唯一发现的版本冲突（文件2 P0-3节已被文件3取代），不存在混用相互冲突历史版本的情况。

**需要如实标注的、不影响本轮G2/G3判定但应记录在案的既有限制**（继承自文件2"未解决风险"，非本轮新发现，不构成范围外假设，只是设计与实施之间的既有边界声明）：
- G2第16-18项、G3第1/7/10项的"PASS"判定，其安全性由**数据库权限系统**（P0-5）在设计层面强制，这一保证的现实生效前提是该权限设计在**实施阶段**被准确落地为真实的PostgreSQL GRANT/REVOKE语句——这是"设计正确"与"未来实施完整性"之间的常规边界，不是本轮判定所依赖的"范围外假设"，因为判定对象本身就是**设计**是否正确、完备、自洽，不是"是否已经实施"。

## 17. G1状态

**G1: NOT_REVIEWED_IN_THIS_DE_NOVO_G2_G3_REVIEW**

## 18. G2 最终结论

**G2: PASS**（18/18项逐项核验通过，见第7节；结论建立在当前有效设计材料之上，不依赖已废弃的文件2 P0-3节，不依赖此前缺失的旧复审材料）

## 19. G3 最终结论

**G3: PASS**（12/12项逐项核验通过，见第9节；未发现无法fencing的关键正式副作用，未发现消费者旁路，artifact修正未引入新矛盾）

## 20. PostgreSQL 16 非跳过验证

**MISSING**（本地环境仅PostgreSQL 14.23客户端与集群，`postgres`/`initdb` 16版本二进制不存在；文件2已核实CI侧多数V1.4D相关workflow已配置`postgres:16`镜像，但本地验证环境缺失PG16这一事实不变；本轮为只读设计复审，未做任何环境变更、未安装、未以PostgreSQL 14替代）

## 21. 生产代码实施状态

**NOT_STARTED**

## 22. 180天研究状态

**NOT_STARTED / NOT_AUTHORIZED**

## 23. 实施授权

**NOT_GRANTED_BY_THIS_REVIEW**

本报告的`G2: PASS`/`G3: PASS`结论仅表示：基于当前工作区实际存在的最终设计材料，G2/G3两项固定门禁在**设计层面**可以被独立、自包含地证明成立。这**不代表**：生产代码已经实施（确认`NOT_STARTED`）；PostgreSQL 16验证已经完成（确认`MISSING`）；跨主机功能已经可以上线；180天正式研究已经获得启动授权（确认`NOT_STARTED/NOT_AUTHORIZED`）。上述四项均需独立、明确的后续授权，不因本报告的结论而自动触发。

## 24. 明确声明

本轮工作全程只读：未修改任何既有设计报告（文件1/2/3均只被读取，未被本轮改动）；未修改任何生产代码；未修改任何测试代码；未修改任何数据库；未执行任何migration；未修改冻结契约；未修正本轮发现的任何问题；未重新设计execution authority、operation ledger或artifact publication协议本身；未处理PostgreSQL 16环境问题；未处理180天研究样本、预注册或启动门禁；未重新审查G1；未创建commit；未merge；未push；未生成bundle；未启动180天正式研究；未实施跨主机功能；未宣称生产系统已经可上线。`git status`全程干净，HEAD始终为`239302eb48311882ea2f3fa2a4bd227b2b767b64`，冻结契约SHA-256始终为`5369742b33867d5b6870a7f9148246cd12fe5ae5b90a770f2474cc66e0610b42`。

## 25. 唯一最终结论

**DE_NOVO_G2_G3_DESIGN_APPROVED**

判定依据（对照判定规则）：当前必需设计材料完整且版本明确（第3/4/5节，唯一版本冲突已裁决）；G2全部18项限定核验PASS（第7节）；G3全部12项限定核验PASS（第9节）；全部正式生产者与消费者均在覆盖清单内（第12/13节）；不存在未受fencing保护的正式副作用（第14节）；不存在消费者旁路（第15节）；artifact publication修正未发现直接矛盾（第11节、文件3§17）；结论不依赖旧复审摘要或范围外假设（第16节）。

现停止，等待独立复核。
