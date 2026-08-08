# Batch7 执行权协议 — 定向修正报告（关闭六项阻塞）

本文件是对`r3-batch7-postgres-authority-DESIGN-REPORT.md`（上一轮DESIGN-ONLY报告）的**定向修正**，只处理独立复审确认的六项阻塞（P0-1~P0-6），不重写无关章节。未列出的章节（候选方案比较、上一轮已证明的18条不变量中未被本轮修正触及的部分等）仍以上一份报告为准。

## 0. 环境与只读核验结果

| 项 | 结果 |
|---|---|
| 当前分支 | `claude/r3-batch7-p0-p1-scoped-fix` |
| 当前HEAD | `239302eb48311882ea2f3fa2a4bd227b2b767b64` |
| git status | 干净（空输出） |
| 上一份DESIGN-ONLY报告路径 | `/tmp/claude-1000/-home-ubuntu/c8d9e2d8-889a-4af7-97cf-808bd5f72f6e/scratchpad/frozen-test-evidence/r3-batch7-postgres-authority-DESIGN-REPORT.md`（该文件此前只存了占位符，本轮已先补齐完整存档内容，属于文档归档修正，不涉及代码/测试/数据库/契约） |
| 冻结契约文件清单及SHA-256 | `V1_4D_FORMAL_RESEARCH_EXECUTION_CONTRACT_V8_FINAL_R3.md` → `5369742b33867d5b6870a7f9148246cd12fe5ae5b90a770f2474cc66e0610b42`（未变） |
| PostgreSQL server version(本地) | 14.23 (Ubuntu 14.23-0ubuntu0.22.04.1) |
| PostgreSQL client version | psql 14.23（同一集群自带） |
| PostgreSQL 16是否实际运行 | 否——本地只有PG14集群；**但CI侧核实**（本轮新增审计发现）：`.github/workflows/v1-4c-postgres16-lifecycle-validation.yml`、`v1-4d-full-verification.yml`、`v1-4d-authenticity-postgres-verification.yml`均已声明`image: postgres:16`，只有更早的`v1-4a-postgres-integration.yml`仍用`postgres:14`（v1.4a里程碑早于PG16门禁要求）——即PG16在CI中已是既定目标，本地开发环境缺失PG16是环境限制，不是CI/项目配置缺失 |
| 是否发现与本任务无关的未提交修改 | 否——`git status`全程空输出，工作树干净，未发现任何需要先报告并停止的无关改动 |
| 本轮将修改/创建的唯一设计报告文件 | 本文件：`BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md`（另：上一份报告的存档占位修正，见上，非本轮"设计修正"范畴，是归档完整性修复） |

---

## P0-1：完整生产入口与消费者审计

### 审计方法

对`server/src`、`server/scripts`、`.github/workflows`全部相关文件执行`grep`调用链追踪，逐一确认导入方/被调用方/实际读写对象。全部结果均基于真实代码搜索（命令与输出见本轮工具调用记录），非抽象类别罗列。

### 完整清单

| # | 文件 | 函数/入口 | 调用者 | 被调用对象 | 当前副作用/读取对象 | 依赖pathname? | 直接写状态表? | 验证owner_instance_id? | 验证fencing_token? | 未来接入的统一能力函数 | 能否安全fencing | 是否存在旁路 | 生产者/消费者 | 设计处置 | 剩余风险 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `formal-research-orchestrator.js` | 8处调用点（创建run/启动/恢复/checkpoint/最终状态） | 无（是最外层生产入口） | `createResearchRunIdentity`,`writeRunStatus`,`publishArtifact` | 文件（run-status JSON + D7 main/sidecar） | 是(当前) | 否(当前无状态表) | 否(当前) | 否(当前) | `acquireExecutionAuthority`+`publishRunStatusUnderFence`+`publishArtifactUnderFence` | 能(见P0-3) | 无(已确认无子进程、无DB写副作用) | 生产者 | 全部写入路径改接统一能力函数 | 无(P0-1审计范围内) |
| 2 | `research-run-status.js` | `acquireResearchRunStatusLock`/`releaseResearchRunStatusLock`/`writeRunStatus`/`quarantinePublishedLock`等全部内部实现 | 仅#1和测试fixture | 当前的`.status.lock`文件 | 文件 | 是(当前) | 否 | 否 | 否 | 整体退役，由新统一能力函数替代（见实施影响清单） | 能 | 无(本轮及历次审计确认无其他生产文件直接操作`.status.lock`) | 生产者(legacy) | 退役 | 无 |
| 3 | `artifact-publisher.js` | `publishArtifact`(main+sidecar) | #1 | D7 main/sidecar文件；**新发现**：`quarantineStaleLock`对D7**自身内部的**`.research-artifact.lock`执行`renameNoReplace`(第111行，与run-status的`.status.lock`是完全不同的两个文件，此前未在报告中明确点出) | 文件 | 是(当前，两套lock：run-status锁+D7内部发布锁) | 否 | 否 | 否 | `publishArtifactUnderFence`(见P0-3) | 能 | **需明确处置**：D7内部发布锁在新协议下变为冗余(因为fencing已经保证同一时刻至多一个持有效token的进程会调用`publishArtifact`)，但保留它不产生新的不安全性(只是多余的本地互斥，不影响fencing正确性)——**设计决策**：实施阶段可选择保留(防御纵深)或移除(简化)，本轮不强制二选一，因为它不影响本轮六项阻塞的关闭 | 生产者 | 内部D7发布锁标注为"实施阶段可选移除"，不构成阻塞 | 若保留，需在测试中确认它不会与新的`publishArtifactUnderFence`产生死锁(两把锁的获取顺序需固定) |
| 4 | `d8-status-reader.js` | `readD8DisplayStatus` | `src/api/server.js`,`src/dashboard/d8-research-page-render.js` | 文件（`findMostRecentRunStatus`/`findMostRecentRejectedResearchAttempt`读run-status JSON；经`artifact-reader.js`/`d8-artifact-discovery.js`读D7 artifact） | 文件 | 是(当前) | 否 | 否 | 否 | 消费者侧必须改为查询`current_valid_artifacts`视图/`reconcileOperationOutcome`等价读取路径，不再直接扫描文件 | 能(见P0-3消费者规则) | **此前报告标注为"未闭合"的完整性缺口，本轮明确闭合**：D8 reader是本系统**唯一**面向外部展示"正式研究状态"的路径，其两个上游调用者(#5 API、#6 dashboard)已完整枚举，无第三个隐藏调用者(`grep`确认) | 消费者 | 迁移为查询`run_orchestration.current_valid_artifacts`视图，不再直接读文件 | 见"剩余风险"总述 |
| 5 | `src/api/server.js` | `GET /api/v1/research/d8/status` | HTTP客户端 | #4 | 同上 | 同上 | 否 | 否 | 否 | 同上(经由#4传导) | 能 | 无(唯一路由，`grep`确认无第二条研究相关路由) | 消费者(HTTP API) | 随#4一并迁移 | 同上 |
| 6 | `src/dashboard/d8-research-page-render.js` | 渲染HTML | 浏览器/运维查看 | #4 | 同上 | 同上 | 否 | 否 | 否 | 同上 | 能 | 无 | 消费者(dashboard) | 随#4一并迁移 | 同上 |
| 7 | `artifact-reader.js` | `readArtifactPair`等 | #1,#3,`artifact-schema-registry.js`,#4,`d8-artifact-discovery.js` | D7 main/sidecar文件内容（低层读取原语，本身不做"是否可信"的裁决，只做文件解析+schema/hash校验） | 文件 | 是(当前) | 否 | 否 | 否 | 保留作为"读取已确认合法路径下的文件内容"这一底层工具，但调用方(#4)必须先经过数据库裁决(见P0-3消费者规则)才能决定"该不该调用它、该读哪个path" | 能(作为底层工具，不独立做信任判断，风险由调用方是否遵守新规则决定) | 无独立旁路 | 底层工具(被生产者与消费者共用) | 不改动其自身实现，改动调用方(#1/#4)的调用前提 | 若#4的迁移不完整，此工具仍会被误用于读取未经数据库确认的路径——完整性依赖#4严格执行(与上一轮报告已标注的完整性依赖一致) |
| 8 | `d8-artifact-discovery.js` | D7 artifact发现/列举 | #4 | 文件系统目录扫描 | 文件 | 是(当前) | 否 | 否 | 否 | 同#4，迁移为查询发布记录而非目录扫描 | 能 | 无独立旁路 | 生产者辅助/消费者辅助 | 随#4一并迁移 | 同上 |
| 9 | `cli-entry.js`(`npm run validation:walk-forward`) | `main`/`runWalkForward` | CLI直接调用 | `historical_validation.validation_runs`/`replay_generation_runs`/`replay_evaluation_runs`(直接INSERT/UPDATE，无lease/fencing) | 数据库(DRY_RUN scope) | 否 | 是，但**不是本协议的状态表** | 不适用 | 不适用 | **不适用——确认为域外系统** | 不适用 | **本轮新增明确结论**：该CLI文件头注释明确标注"HISTORICAL RESEARCH ONLY...不产出交易信号、不代表当前市场状态、不得用于实盘决策"，写入目标是`historical_validation.validation_runs`（自带独立的`status='RUNNING'`互斥guard，`dry_run boolean`列），从未`import``research-run-status.js`/`artifact-publisher.js`/`d8-status-reader.js`中的任何符号（`grep`确认零引用），是与"正式研究"（`formal-research-orchestrator.js`的FORMAL artifactMode）完全独立、预先已有自身治理机制的系统——**不在本协议(Batch7执行权重设计)范围内，不构成旁路** | 域外(DRY_RUN验证工具) | 不纳入本协议，不作为P0-1的旁路认定 | 若未来有人误把这条DRY_RUN管线的产出当作"正式研究结果"展示给消费者，那是调用方误用，不是本协议的设计缺口——建议(非本轮强制)在`report-builder.js`/`v1-4d-scorecard-cli.mjs`的输出中保留现有`dry_run`标记以防混淆 |
| 10 | `report-builder.js` | `buildValidationReports` | #9(仅) | `historical_validation.validation_reports` | 数据库(DRY_RUN scope) | 否 | 同上 | 不适用 | 不适用 | 不适用 | 不适用 | 同#9，域外 | 域外 | 不纳入 | 同上 |
| 11 | `v1-4d-scorecard-cli.mjs` | CLI | 人工/CI调用 | 读`historical_validation.validation_runs`/`validation_reports`/`replay_snapshots`/`replay_generation_runs`（`grep`确认表名与#9/#10完全一致） | 数据库读(DRY_RUN scope) | 否 | 否 | 不适用 | 不适用 | 不适用 | 不适用 | 同#9，域外消费者 | 域外 | 不纳入 | 同上 |
| 12 | 测试fixture`run-status-writer-child.mjs` | `LOCK_HOLD`/`LOCK_CRASH`/`SLOW_PUBLISH` | 仅`research-run-status-concurrency.test.js` | `.status.lock`(通过导出的公开原语，`SLOW_PUBLISH`分支复用与生产bootstrap完全相同的`writeTempFileDurable`+`renameNoReplace`) | 文件 | 是 | 否 | 否 | 否 | 测试专属，实施阶段随legacy协议一起重写为数据库集成测试 | 能 | 无(仅测试专用，非生产入口) | 测试基础设施 | 随legacy协议退役同步重写 | 无 |
| 13 | 子进程/`spawn`/`fork` | — | — | — | — | — | — | — | — | 不适用 | 不适用 | **本轮复核确认**：`grep -rn "spawn(\|child_process\|fork("`覆盖`formal-research-orchestrator.js`/`artifact-publisher.js`/`replay-evaluator.js`/`replay-generator.js`/`report-builder.js`全部为零命中，唯一命中在测试文件 | 不适用 | 不构成关键副作用类别 | 无 |
| 14 | CI workflow文件（6个`.github/workflows/*postgres*.yml`） | CI pipeline | GitHub Actions | 拉起PG16(多数)/PG14(仅v1-4a)容器 | 不适用(不是生产入口，是测试环境配置) | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | 无(已核实版本声明，见上表环境核验) | 不适用 | 不需要设计处置，仅记录审计事实 | 无 |
| 15 | `purge.js` | `purgeStraddlingSamples`等 | `report-builder.js`(#10链路，DRY_RUN scope) | 纯内存样本过滤，无IO | 不适用 | 否 | 否 | 不适用 | 不适用 | 不适用 | 不适用 | 无 | 不适用(纯函数) | 不需要设计处置 | 无 |

### P0-1结论

**仓库内合法生产入口已完整枚举，证据充分（15类，全部标注文件/函数/调用链/读写对象/是否存在旁路）。** 本系统当前存在**两个架构上独立、彼此不共享任何符号引用的子系统**：(a) 正式研究（FORMAL，`formal-research-orchestrator.js`为唯一入口，是Batch7本协议的设计对象）；(b) 历史回放/DRY_RUN验证（`validation:walk-forward` CLI，自带独立`status='RUNNING'`治理机制，写入`historical_validation.*`表，明确不产出正式研究结果，明确域外）。**未发现无法枚举、无法归类、或需要用"可能还有其他入口"来搪塞的情形。** D8 reader/dashboard/API三个此前标注"未闭合"的消费者入口，本轮已完整追溯其调用链（表格#4-6），闭合方式统一为"迁移到查询数据库发布记录视图"，不存在遗漏的第四个消费者。

**P0-1: PASS**（软件保证边界内完整；不覆盖操作系统/数据库管理员权限级别的带外违规，按指令边界声明为不在设计防御范围内）。

---

## P0-2：统一 unknown-outcome 规则（修正错误表述）

### 修正的错误

上一份报告场景16描述"数据库连接在commit时中断"时把它归类为可能"回滚"，这**不准确**——一旦客户端已经发出`COMMIT`且连接在等待服务端响应期间中断，**服务端到底有没有真正完成WAL落盘，客户端物理上无法从连接错误本身推断**（回滚和已提交都可能表现为同样的"连接错误"）。正确规则必须以**明确的三态**替代原先含糊的"回滚"表述：

| 阶段 | 明确结果 | 可否重试 |
|---|---|---|
| `BEGIN`前失败 | 操作未开始 | 是，同`operation_id`安全重试 |
| `BEGIN`后、`COMMIT`调用前，收到数据库**明确**的错误回执（如约束冲突、显式`ROLLBACK`确认） | 操作确定未提交(ABORTED) | 是，同`operation_id`安全重试（见下方ledger的ABORTED处理） |
| `COMMIT`调用后发生超时/断连/进程崩溃/连接池错误/**未收到明确确认** | **UNKNOWN_OUTCOME**（不得假定为"回滚"，也不得假定为"已提交"） | 否，禁止用新`operation_id`盲目重试；必须先reconciliation |

### operation ledger 确定 schema

```sql
CREATE TABLE run_orchestration.operation_ledger (
  operation_id           uuid PRIMARY KEY,
  run_identity_sha256      text NOT NULL
                            CONSTRAINT ledger_run_identity_format CHECK (run_identity_sha256 ~ '^[0-9a-f]{64}$'),
  operation_type            text NOT NULL
                            CONSTRAINT ledger_operation_type_valid CHECK (operation_type IN
                              ('ACQUIRE','HEARTBEAT','RELEASE','QUARANTINE','ARTIFACT_REGISTER','ARTIFACT_PROMOTE')),
  request_payload_hash       text NOT NULL
                            CONSTRAINT ledger_request_hash_format CHECK (request_payload_hash ~ '^[0-9a-f]{64}$'),
  status                      text NOT NULL DEFAULT 'PENDING'
                            CONSTRAINT ledger_status_valid CHECK (status IN ('PENDING','COMMITTED','ABORTED')),
  result_payload                jsonb,
  created_at                     timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at                    timestamptz,
  aborted_at                       timestamptz,
  CONSTRAINT ledger_terminal_has_timestamp CHECK (
    (status = 'PENDING') OR
    (status = 'COMMITTED' AND committed_at IS NOT NULL) OR
    (status = 'ABORTED' AND aborted_at IS NOT NULL)
  )
);
CREATE INDEX ledger_run_identity_idx ON run_orchestration.operation_ledger(run_identity_sha256, created_at);
```

`request_payload_hash` = 对本次调用的规范化参数（如`run_identity_sha256`+`owner_instance_id`+`operation_type`+其余业务参数）做canonical JSON后sha256——**唯一约束天然由`operation_id`主键提供**：同一`operation_id`第二次尝试`INSERT`会因主键冲突失败，调用方捕获冲突后必须转为"比较`request_payload_hash`"分支，不得把冲突误判为整体失败。

### 幂等/冲突/回收处理规则（唯一确定流程，无二选一）

1. 调用方先在**独立、立即提交的小事务**中执行：
   ```sql
   INSERT INTO operation_ledger(operation_id, run_identity_sha256, operation_type, request_payload_hash)
   VALUES ($1,$2,$3,$4)
   ON CONFLICT (operation_id) DO NOTHING
   RETURNING status;
   ```
   - 返回1行（`status='PENDING'`）：全新操作，继续下一步。
   - 返回0行（冲突）：`SELECT request_payload_hash, status, result_payload FROM operation_ledger WHERE operation_id=$1`：
     - `request_payload_hash`不匹配 → 立即返回**`OPERATION_ID_PAYLOAD_MISMATCH`**，不做任何进一步动作。
     - `request_payload_hash`匹配且`status='COMMITTED'` → 直接返回已存的`result_payload`，**不重新执行**（幂等重放，安全）。
     - `request_payload_hash`匹配且`status='ABORTED'` → 允许用**同一`operation_id`**重新走完整流程（从步骤2开始），因为ABORTED本身已经是确定性结果，重试不会产生"第二次语义操作"的歧义（业务事务本身会重新走一次完整核验，若条件仍不满足会再次ABORTED，是确定性的、幂等安全的）。
     - `request_payload_hash`匹配且`status='PENDING'`（**这正是UNKNOWN_OUTCOME的可观察信号**）→ 转到步骤3的reconciliation，不得直接重试业务逻辑。
2. 全新操作：在**业务事务**内完成核验+状态写入+审计写入+把`operation_ledger`该行更新为`status='COMMITTED', result_payload=$x, committed_at=clock_timestamp()`，**全部在同一个事务里`COMMIT`**（业务效果与ledger终态是原子的一件事，不是两件事）。若业务核验在事务内确定性失败（如fencing不匹配），事务本身**不**回滚整个ledger行的存在——而是执行`UPDATE operation_ledger SET status='ABORTED', aborted_at=clock_timestamp() WHERE operation_id=$1`并在**这一个**事务内`COMMIT`（即：失败也是一次明确的、需要持久化的结果，不是"什么都没发生"）。
3. **reconciliation**（`reconcileOperationOutcome(operationId)`，处理"ledger仍是PENDING但已经过了合理超时"的情形）：
   - 直接查询该`operation_type`对应的**业务状态表**是否已经记录了这个`operation_id`作为其转换的产生者——即`SELECT 1 FROM run_execution_authority WHERE run_identity_sha256=$run AND current_operation_id=$opId`（ACQUIRE/HEARTBEAT类）或`SELECT 1 FROM run_authority_audit WHERE operation_id=$opId`（任意类型，审计表是最终真相，因为它与业务状态更新在同一事务提交）或`SELECT 1 FROM artifact_publications WHERE operation_id=$opId`（发布类）。
   - 若找到匹配 → 业务效果确实已经提交，**修复**`operation_ledger`该行为`COMMITTED`（用查到的真实结果回填`result_payload`），返回该结果。
   - 若未找到匹配 → 业务效果确实从未提交，**修复**该行为`ABORTED`，允许后续用同一`operation_id`安全重试。
   - **这一步本身绝不产生新的语义操作**——它只读取已经存在的、由某次真实事务提交下来的记录，不执行任何`acquire`/`release`等业务函数。
4. **"ledger行完全不存在"时如何证明服务器没有提交**：由**协议自身的调用顺序保证**——`acquireExecutionAuthority`等全部统一能力函数的内部实现，第一条语句永远是步骤1的ledger INSERT（这是共享内部实现的强制顺序，不是调用方可选项，见P0-5的函数封装），因此"ledger行不存在"在逻辑上等价于"连步骤1的那个独立、立即提交的小事务都从未提交过"——由于步骤1本身是一个内容极简、几乎不可能长时间悬而不决的事务（一条`INSERT`），它的"未提交"可以被更快地、独立地重试确认（若这个最外层的、最简单的INSERT反复无法提交，那是数据库连通性问题本身，归入INV-9 fail closed，不是"业务操作结果未知"的范畴）。
5. **PostgreSQL重启/主从切换/连接池重连**：统一适用上述规则——任何形式的"我不确定上次调用发生了什么"，动作都是同一个：用**原**`operation_id`执行reconciliation查询，不重新发起业务操作，直到reconciliation给出确定性的`COMMITTED`或`ABORTED`。

**P0-2: PASS**——规则统一、无歧义、ledger schema确定（唯一约束=主键、状态三值、终态时间戳CHECK约束防止"COMMITTED却没有committed_at"这类不一致行）。

---

## P0-3：修正 artifact 发布与恢复协议（消除逻辑冲突）

### 冲突的根源（本轮明确诊断）

上一份报告把两件不同的事混为一谈：**（a）某次发布尝试在intent-commit那一刻是否被fencing接受**（这是一个历史事实，一旦发生就永久不变）与**（b）`run_execution_authority`表当前的、随时间不断变化的`fencing_token`**（这是一个持续演进的运行时状态）。旧设计要求消费者查询时把两者相等，导致"当前token变了"（例如运行完成后很久，同一run identity因某种诊断原因被重新acquire了一次）会让**早已合法完成并被接受**的历史结果凭空失效——这正是CEO指出的逻辑冲突。

### 确定方案（唯一，不保留候选）

**核心原则**：发布记录（`artifact_publications`每一行）在`promoted=true`那一刻记录的合法性是**永久性的历史事实**，此后**永不**重新对照`run_execution_authority`的当前token做二次校验。合法性只在**intent-commit**与**promote**两个时间点各校验一次（fencing的唯一作用时机），校验通过后即成为不可撤销的既成事实——这与`run_authority_audit`的append-only精神完全一致，只是把同一原则应用到artifact发布记录上。

### 修正后 schema

```sql
CREATE TABLE run_orchestration.artifact_publications (
  publication_id           bigserial PRIMARY KEY,
  operation_id               uuid NOT NULL UNIQUE
                              REFERENCES run_orchestration.operation_ledger(operation_id),
  run_identity_sha256          text NOT NULL,
  artifact_kind                  text NOT NULL CHECK (artifact_kind IN ('RUN_STATUS','D7_ARTIFACT')),
  owner_instance_id                uuid NOT NULL,
  fencing_token_at_intent            bigint NOT NULL,   -- intent-commit那一刻校验通过的token，永久历史事实
  fencing_token_at_promote             bigint,            -- promote那一刻再次校验通过的token(通常与intent相同；若不同也不影响已成立的合法性，只做审计记录)
  content_hash                          text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  staging_path                           text NOT NULL,
  final_path                              text NOT NULL,
  intent_committed_at                      timestamptz NOT NULL DEFAULT clock_timestamp(),
  promoted                                  boolean NOT NULL DEFAULT false,
  promoted_at                                timestamptz
);
CREATE INDEX artifact_pub_run_kind_promoted_idx
  ON run_orchestration.artifact_publications(run_identity_sha256, artifact_kind, promoted, promoted_at DESC);
```

**与上一版的关键差异**：**删除**了`UNIQUE(run_identity_sha256, artifact_kind, content_hash)`——新的唯一约束只围绕`operation_id`（`UNIQUE`+外键到`operation_ledger`），不阻止不同token/不同operation_id对**相同**`content_hash`各自登记独立的发布记录（CEO要求第8/9条）。content-addressed存储层（实际字节存放）本身仍按`content_hash`去重（同一份字节内容只物理存一次），这是**存储优化**，与**发布记录**（谁在什么时候、以什么身份，登记了"这份内容是当次操作的合法产物"）是两个独立的概念，不再混用同一唯一约束表达。

### 完整流程（唯一版本）

1. **staging写入**（owner持有效`(ownerInstanceId, fencingToken)`，本步骤不查数据库）：写入`{artifactRoot}/.staging/{operationId}/{contentHash}`，`fsync`。
2. **register（intent-commit）**（`registerArtifactUnderFence`，对应ledger`operation_type='ARTIFACT_REGISTER'`）：在**同一事务**内，先执行P0-2步骤1/2的ledger流程，然后`assertOwnerAndFence`核验通过后`INSERT INTO artifact_publications(...,fencing_token_at_intent=$currentToken,promoted=false)`，与ledger的`COMMITTED`更新一起`COMMIT`。核验不通过：ledger记为`ABORTED`，staging文件成为孤儿（后续清理回收），owner必须停止。
3. **promote**（`commitArtifactPublication`，对应ledger`operation_type='ARTIFACT_PROMOTE'`）：**任何**当前持有效token的进程（不要求是最初staging/register的那个进程——这是outbox模式允许的"代为完成"）可以执行：先`renameAllowCreate(stagingPath, finalPath)`+`fsyncDirectory`（文件层面，不在数据库事务内），成功后开启数据库事务，`assertOwnerAndFence`再次核验（因为rename期间token可能已经变化），通过则`UPDATE artifact_publications SET promoted=true, promoted_at=clock_timestamp(), fencing_token_at_promote=$currentToken WHERE operation_id=$1`与ledger的`COMMITTED`更新一起`COMMIT`。**核验不通过**：文件已经物理rename成功，但`promoted`永远停在`false`——这正是"旧token即使成功把文件写入正式目录，也不能让消费者接受它"的字面实现（见下方消费者规则，`promoted=false`的记录永不被消费者选中，无论对应文件是否存在于`finalPath`）。

### 消费者规则（唯一，无需联表当前token）

```sql
CREATE VIEW run_orchestration.current_valid_artifacts AS
SELECT DISTINCT ON (run_identity_sha256, artifact_kind)
  run_identity_sha256, artifact_kind, content_hash, final_path, owner_instance_id,
  fencing_token_at_intent, promoted_at
FROM run_orchestration.artifact_publications
WHERE promoted = true
ORDER BY run_identity_sha256, artifact_kind, promoted_at DESC;
```
消费者**只**读这个视图（`GRANT SELECT`给只读消费角色，见P0-5），**不**联表`run_execution_authority`，**不**扫描目录，**不**只凭`content_hash`接受文件——`promoted=true`本身就是永久生效的信任凭证。**"run完成后正式artifact应绑定该run已提交的final result generation，而不是永远要求等于未来可能产生的current ownership token"**——本设计通过"发布记录一旦promoted即永久有效、从不重新对照当前token"直接满足这一要求，二者是同一件事的两种表述。

### 逐项场景处理（CEO列出的8个必须处理的情形）

| 情形 | 处理 |
|---|---|
| staging写完、DB未登记 | 孤儿，cleanup按年龄+可达性回收（见下） |
| DB登记后、blob尚不可见 | 不适用于本设计——register步骤**不**创建"blob"这一独立于staging文件之外的第二份数据，`staging_path`本身就是最终会被rename的那份内容，不存在"DB说有但文件层看不到"的中间态 |
| blob可见、publication未提交(`promoted=false`) | 文件存在于`finalPath`但视图选不中它，消费者不信任，与"旧token完成rename"是同一情形 |
| publication commit后客户端未确认 | 走P0-2统一reconciliation规则（`operation_type='ARTIFACT_PROMOTE'`） |
| cleanup与publish并发 | cleanup只删除"无任何`operation_id`引用（含`promoted=false`但未过期）的孤儿staging"，见下方清理条件 |
| quarantine与publish并发 | quarantine只影响**之后**的fencing校验，不追溯撤销owner在被quarantine**之前**已经合法完成的promote（该promote的`assertOwnerAndFence`在其自己的事务内已经成立，是历史事实） |
| 新owner复用相同content_hash | 允许——新owner用自己的`operation_id`+新token执行完整register+promote流程，产生**独立的新行**，不复用/不修改旧行 |
| 旧owner迟到rename | rename本身可能物理成功（文件层无法阻止），但promote的`assertOwnerAndFence`会失败，该行永远`promoted=false`，消费者视图选不中 |

**cleanup清理条件（回应CEO"cleanup不得删除当前owner或后来owner引用的staging"）**：
```sql
-- 只清理"确认从未被任何publication记录引用、且已超过安全阈值"的staging文件
-- 判据：staging文件对应的 (run_identity_sha256, content_hash) 在 artifact_publications 中
--       不存在任何行（无论 promoted 是否为 true），且文件年龄 > 清理阈值
```
只要`artifact_publications`存在**任意**一行引用该`(run, content_hash)`（哪怕`promoted=false`且刚刚intent-commit），该staging文件就不可清理——天然覆盖"当前owner或后来owner正在使用"的情形，不需要额外查询owner身份。

**证明：旧token即使成功把文件写入正式目录，也不能让消费者接受它**——见"消费者规则"：视图的`WHERE promoted=true`条件在数据库层面是唯一真相，而`promoted`字段只能被`commitArtifactPublication`这一个SECURITY DEFINER函数在fencing核验通过后写入（P0-5强制），旧token的promote尝试在核验步骤即被拒绝，物理上不可能把`promoted`置为`true`，与文件系统上是否存在同名/同内容文件完全无关。∎

**P0-3: PASS**——不再存在"发布记录绑定旧token vs 要求等于当前token"的矛盾；不存在会阻止合法重新登记的唯一约束；恢复/清理/并发情形均给出确定处理，无二选一。

---

## P0-4：严格数据库状态约束（确定 DDL，不含 RECOVERING/RELEASING/QUARANTINING 持久态）

### 修正决定

**明确删除**`RELEASING`/`QUARANTINING`/`RECOVERING`作为持久化`state`列取值——上一份报告的暧昧表述（"是逻辑中间态但非独立持久态"）本轮**收敛为唯一选择：不持久化**。理由：本设计的release/quarantine/acquire全部是**单事务内原子完成**（P0-2/P0-5的函数内部：核验→写状态→写审计→写ledger→COMMIT，一次性完成，不存在跨越多个事务的"进行中"状态需要被持久化观察），因此不存在需要被别的事务读到的"RELEASING中"状态——`state`列只需四个终态值。这些标签仅作为`operation_ledger.operation_type`/`run_authority_audit.transition_type`里的**过程描述**，从不出现在`run_execution_authority.state`列。

### 完整 DDL

```sql
CREATE SCHEMA IF NOT EXISTS run_orchestration;

-- ============ 1. 所有权状态表 ============
CREATE TABLE run_orchestration.run_execution_authority (
  run_identity_sha256      text PRIMARY KEY
                            CONSTRAINT rea_run_identity_format CHECK (run_identity_sha256 ~ '^[0-9a-f]{64}$'),
  state                     text NOT NULL DEFAULT 'RELEASED'
                            CONSTRAINT rea_state_valid CHECK (state IN ('ACTIVE','RELEASED','QUARANTINED','FAILED')),
  owner_instance_id         uuid,
  owner_host_identity       text,       -- 沿用现有 hostIdentitySha256() 输出，仅诊断用途(见P0-6)
  owner_process_identity    text,       -- 沿用现有 processStartIdentity() 输出，仅诊断用途(见P0-6)
  owner_pid                 integer,    -- 仅诊断用途，不参与任何安全判定(见P0-6)
  fencing_token              bigint NOT NULL DEFAULT 0
                              CONSTRAINT rea_fencing_token_nonneg CHECK (fencing_token >= 0),
  lease_expires_at            timestamptz,
  last_heartbeat_at            timestamptz,
  current_operation_id          uuid,
  acquired_at                    timestamptz,
  released_at                     timestamptz,
  quarantined_at                   timestamptz,
  quarantine_reason                 text,
  state_version                      bigint NOT NULL DEFAULT 0,
  created_at                          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at                           timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT rea_active_requires_full_owner CHECK (
    state <> 'ACTIVE' OR (
      owner_instance_id IS NOT NULL AND owner_host_identity IS NOT NULL AND
      owner_process_identity IS NOT NULL AND fencing_token IS NOT NULL AND
      lease_expires_at IS NOT NULL AND acquired_at IS NOT NULL
    )
  ),
  CONSTRAINT rea_released_clears_owner CHECK (
    state <> 'RELEASED' OR (
      owner_instance_id IS NULL AND owner_host_identity IS NULL AND
      owner_process_identity IS NULL AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT rea_quarantined_clears_owner_has_reason CHECK (
    state <> 'QUARANTINED' OR (
      owner_instance_id IS NULL AND owner_host_identity IS NULL AND
      owner_process_identity IS NULL AND lease_expires_at IS NULL AND
      quarantine_reason IS NOT NULL
    )
  ),
  CONSTRAINT rea_failed_clears_owner CHECK (
    state <> 'FAILED' OR (owner_instance_id IS NULL AND lease_expires_at IS NULL)
  )
);
CREATE INDEX rea_state_idx ON run_orchestration.run_execution_authority(state, lease_expires_at);

-- ============ 2. operation ledger（见P0-2） ============
-- (schema 已在P0-2节给出，此处不重复)

-- ============ 3. append-only 审计表 ============
CREATE TABLE run_orchestration.run_authority_audit (
  audit_id                     bigserial PRIMARY KEY,
  operation_id                 uuid NOT NULL
                                REFERENCES run_orchestration.operation_ledger(operation_id),
  run_identity_sha256          text NOT NULL
                                CONSTRAINT audit_run_identity_format CHECK (run_identity_sha256 ~ '^[0-9a-f]{64}$'),
  transition_type              text NOT NULL
                                CONSTRAINT audit_transition_type_valid CHECK (transition_type IN
                                  ('ACQUIRE','HEARTBEAT','RELEASE','QUARANTINE','FAIL')),
  previous_state                text,
  next_state                    text NOT NULL,
  previous_owner_instance_id    uuid,
  next_owner_instance_id        uuid,
  previous_fencing_token        bigint,
  next_fencing_token            bigint NOT NULL,
  actor_pid                     integer,
  actor_host                    text,
  actor_process_identity        text,
  reason                        text,
  disposition                   jsonb,
  original_record                jsonb NOT NULL,
  original_record_hash            text NOT NULL
                                  CONSTRAINT audit_original_hash_format CHECK (original_record_hash ~ '^[0-9a-f]{64}$'),
  observed_at                      timestamptz NOT NULL,
  committed_at                      timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata                          jsonb
);
CREATE INDEX audit_run_identity_idx ON run_orchestration.run_authority_audit(run_identity_sha256, committed_at);
CREATE UNIQUE INDEX audit_operation_id_idx ON run_orchestration.run_authority_audit(operation_id, transition_type);

-- ============ 4. artifact publications（见P0-3） ============
-- (schema 已在P0-3节给出，此处不重复)
```

### 权限（本节先声明表级权限，函数级见P0-5）

```sql
REVOKE ALL ON SCHEMA run_orchestration FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA run_orchestration FROM PUBLIC;
-- 应用运行时角色(run_authority_runtime)不被授予对以下四张表的任何直接INSERT/UPDATE/DELETE权限，
-- 全部访问只能经由P0-5定义的SECURITY DEFINER函数。
GRANT INSERT, SELECT ON run_orchestration.run_authority_audit TO run_authority_owner; -- 表owner角色自身(函数以其身份执行)
-- 不向 run_authority_runtime 授予 UPDATE/DELETE，此约束在权限系统层面（非应用层承诺）阻止篡改。
```

### CEO 逐项要求核对

| 要求 | 是否满足 |
|---|---|
| ACTIVE字段非空组合 | `rea_active_requires_full_owner` |
| RELEASED清空owner字段 | `rea_released_clears_owner` |
| QUARANTINED清空owner+reason非空 | `rea_quarantined_clears_owner_has_reason` |
| RECOVERING不得同时说"合法状态"又"永不持久化" | **明确删除**，不出现在`state`的CHECK允许值里，只作为过程标签存在于`transition_type`/`metadata` |
| fencing_token: BIGINT/非负/单调/溢出行为/sequence空洞 | `bigint`+`CHECK(>=0)`；单调性由函数内部`fencing_token+1`（每次ACQUIRE的UPDATE语句本身）保证，永不在应用层重新赋任意值；**溢出行为**：`bigint`上限约9.2×10^18，按当前系统实际acquire频率（每次checkpoint一次，量级远低于每秒百万次）需要超过千亿年才可能触及上限，本设计**不**为此设计特殊回绕逻辑，理由是触及上限所需时间远超系统任何可预见的生命周期，标注为已知的、可忽略的理论限制而非需要处理的运行时分支；空洞见P0-2场景分析，不影响安全性 |
| owner_instance_id用不可复用UUID | 是，每次ACQUIRE生成全新`gen_random_uuid()`/应用层`randomUUID()` |
| PID仅诊断 | 是，见P0-6 |
| CHECK约束或受控函数强制状态组合 | 是，四条CHECK约束+P0-5的函数是唯一写入路径 |
| final result generation与current ownership generation区分 | 是，见P0-3（`fencing_token_at_intent`永久历史事实 vs `run_execution_authority.fencing_token`持续变化） |
| ledger/audit/publication外键与唯一约束明确 | 是：`audit.operation_id`→`ledger.operation_id`（FK）；`artifact_publications.operation_id`→`ledger.operation_id`（FK+UNIQUE）；`audit_operation_id_idx`唯一索引防重复审计 |
| audit append-only，runtime角色不得UPDATE/DELETE | 是，权限段落 |
| 不允许状态机认定"不可能"的组合 | 四条CHECK约束在数据库层面物理拒绝任何试图违反的INSERT/UPDATE，不依赖应用层自律 |

**P0-4: PASS**——确定DDL，无"若…若…"的未决分支，`RECOVERING`等争议状态已明确排除出持久化枚举。

---

## P0-5：确定唯一数据库权限与能力边界（SECURITY DEFINER + 最小权限角色，不再二选一）

### 角色设计（唯一）

| 角色 | 用途 | 权限 |
|---|---|---|
| `run_authority_owner` | 全部表和函数的**属主**，从不用于交互式登录/应用连接 | 拥有表/函数的DDL级所有权 |
| `run_authority_runtime` | 应用运行时连接角色 | 只有`USAGE`(schema) + `EXECUTE`(下列函数)；**零**表级DML权限 |
| `run_authority_reader` | 只读消费者角色(D8 reader/dashboard/API等，见P0-1表#4-6迁移后使用) | 只有`SELECT`(`current_valid_artifacts`视图)；不能`SELECT`任何底层表 |
| `run_authority_admin` | migration/人工治理专用，独立于runtime，每次使用需独立留痕(INV-14) | 拥有底层表的直接DML权限，仅供migration脚本与经审批的人工治理操作使用，不用于日常应用运行 |

### SECURITY DEFINER 函数（唯一确定清单）

全部函数：**属主为`run_authority_owner`**（不是`run_authority_runtime`，满足CEO"函数owner不得是普通runtime role"）；固定`SET search_path = run_orchestration, pg_catalog`（防止依赖调用方的`search_path`被劫持到同名对象）；内部第一步显式核验`current_user = 'run_authority_runtime'`（防御纵深，即便GRANT EXECUTE已经限制了谁能调用，函数体内仍二次确认，并把该值记入审计`actor`字段）。

```
acquireExecutionAuthority(p_run_identity, p_operation_id, p_request_hash, p_owner_instance_id,
                           p_owner_host, p_owner_process_identity, p_owner_pid, p_lease_ttl_ms) RETURNS jsonb
renewExecutionAuthority(p_run_identity, p_operation_id, p_request_hash, p_owner_instance_id,
                         p_fencing_token, p_lease_ttl_ms) RETURNS jsonb
transitionExecutionState(...)   -- 内部共享实现，被acquire/release/quarantine复用，不单独导出给runtime角色
releaseExecutionAuthority(p_run_identity, p_operation_id, p_request_hash, p_owner_instance_id, p_fencing_token) RETURNS jsonb
quarantineExecutionAuthority(p_run_identity, p_operation_id, p_request_hash, p_stale_lock_ms) RETURNS jsonb
recoverExecutionAuthority(...)  -- SQL别名，函数体直接调用acquireExecutionAuthority，不重复实现
assertCurrentFence(p_run_identity, p_owner_instance_id, p_fencing_token) RETURNS void
commitSideEffectUnderFence(p_run_identity, p_owner_instance_id, p_fencing_token, p_operation_id,
                            p_request_hash, p_effect_description jsonb) RETURNS jsonb
  -- 当前系统无数据库类关键副作用需要接入(见P0-1)，本函数为可扩展能力边界预留，非死代码——
  -- 若未来新增数据库类副作用，必须通过它接入，不得另开写入路径
registerArtifactUnderFence(p_run_identity, p_operation_id, p_request_hash, p_owner_instance_id, p_fencing_token,
                            p_artifact_kind, p_content_hash, p_staging_path, p_final_path) RETURNS jsonb
commitArtifactPublication(p_operation_id, p_request_hash, p_owner_instance_id, p_fencing_token) RETURNS jsonb
reconcileOperationOutcome(p_operation_id) RETURNS jsonb
```

### 权限授予（唯一）

```sql
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA run_orchestration FROM PUBLIC;
GRANT USAGE ON SCHEMA run_orchestration TO run_authority_runtime, run_authority_reader;
GRANT EXECUTE ON FUNCTION run_orchestration.acquireExecutionAuthority(...) TO run_authority_runtime;
-- ...对每个应用需要调用的函数逐一GRANT EXECUTE给run_authority_runtime（reconcileOperationOutcome/assertCurrentFence
--    等内部/诊断函数也只授予runtime，不授予reader）
GRANT SELECT ON run_orchestration.current_valid_artifacts TO run_authority_reader, run_authority_runtime;
-- run_authority_admin不通过上述GRANT获得权限，而是作为表owner的同级/migration角色单独管理，
-- 不出现在应用日常连接路径中
```

### JS侧唯一约束

`server/src/db/run-authority.js`（新增，唯一实现文件）内部函数**只**调用`SELECT run_orchestration.acquire_execution_authority($1,$2,...)`这类函数调用语法，**不**拼接任何`INSERT INTO run_orchestration.*`/`UPDATE run_orchestration.*`字面SQL——业务模块（`formal-research-orchestrator.js`等）只导入这个文件的高层函数，不直接`import { Pool }`自行拼SQL访问这些表。

### 三层强制手段（CEO要求"不得只依赖字符串相似性"）

1. **数据库权限（终极强制）**：`run_authority_runtime`角色在数据库层面物理不具备对四张核心表的DML权限——即使应用代码出现bug拼出任意SQL字符串，PostgreSQL会以`ERROR: permission denied for table ...`（`42501`）拒绝执行，这是运行时集成测试可以直接断言的行为（见测试矩阵T1/T2）。
2. **CI静态扫描（辅助，非最终边界）**：扫描生产`.js`/`.mjs`，禁止在`run-authority.js`之外出现`run_execution_authority`/`run_authority_audit`/`artifact_publications`/`operation_ledger`字面表名的SQL字符串。
3. **模块导出面**：`run-authority.js`只`export`高层能力函数，不`export`任何返回原始`pool`/`client`的辅助工具供业务模块自行拼SQL。

**P0-5: PASS**——唯一确定为"SECURITY DEFINER函数+最小权限角色"，不再保留二选一；权限、函数清单、调用约束均已给出可直接转化为migration的具体内容。

---

## P0-6：明确跨主机 takeover 判定（不依赖远程PID检测）

### 修正的错误前提

上一份报告的quarantine判定逻辑**沿用了flock方案遗留的本地思维**——`processAlive(pid)`（`process.kill(pid,0)`）在语义上**只能检测调用者自己所在主机上的PID**，跨主机场景下对一个属于**另一台机器**的PID调用它，要么返回误导性的结果（该PID号码在**本机**恰好也存在、但属于完全无关的进程），要么在容器/沙箱环境下直接不可比较。**本轮明确纠正**：判定"是否允许takeover"的**唯一**依据必须是`lease_expires_at`（数据库服务端时间）比较，`owner_pid`/`owner_host_identity`/`owner_process_identity`三个字段**只作为审计/诊断展示**，不出现在任何自动化判定分支的条件表达式里。

### 为什么这样仍然安全（核心论证）

安全性的来源**从来不是**"我们准确判断出旧owner已经死亡"，而是**fencing本身**：即使lease到期的判断是"错误的"（旧owner其实还活着，只是心跳慢了），新owner接管后，旧owner后续的**任何**关键副作用尝试（数据库写入的`assertCurrentFence`、artifact发布的`registerArtifactUnderFence`/`commitArtifactPublication`）都会因为它持有的`fencing_token`不再等于`run_execution_authority`行内的当前值而被**确定性拒绝**。takeover判断"是否允许尝试接管"这件事本身只需要"足够合理"（避免不必要的抢占），**不需要"绝对正确"**——错误的后果被fencing兜底吸收为"旧owner的后续工作被拒绝、需要重新开始"，而不是"数据损坏"或"双写"。这是fencing设计的核心价值，也是本轮修正的关键认知：**PID检测是活性判断的辅助优化（避免不必要的抢占），从来不是安全判断的一部分**——上一份报告没有把这一区分讲清楚，本轮明确澄清。

### 唯一确定算法

```
recoverExecutionAuthority(runIdentity, operationId, requestHash, ownerInstanceId,
                           ownerHost, ownerProcessIdentity, ownerPid, leaseTtlMs):
  -- 直接调用 acquireExecutionAuthority，无独立实现
  BEGIN
    (ledger流程，见P0-2)
    row = SELECT * FROM run_execution_authority WHERE run_identity_sha256=$1 FOR UPDATE
    IF row.state = 'ACTIVE' AND row.lease_expires_at > clock_timestamp():
      -- 唯一的拒绝条件：租约未过期。不检查PID、不检查host、不检查process_identity。
      ABORT此次operation_ledger行(status='ABORTED')
      RETURN { acquired: false, reason: 'LEASE_STILL_VALID' }
    -- 走到这里：row.state IN ('RELEASED','QUARANTINED','FAILED') 或 (ACTIVE 且 lease已过期)
    newToken = row.fencing_token + 1
    UPDATE run_execution_authority SET
      state='ACTIVE', owner_instance_id=$ownerInstanceId, owner_host_identity=$ownerHost,
      owner_process_identity=$ownerProcessIdentity, owner_pid=$ownerPid,
      fencing_token=newToken, lease_expires_at=clock_timestamp()+$leaseTtlMs,
      last_heartbeat_at=clock_timestamp(), current_operation_id=$operationId,
      acquired_at=clock_timestamp(), state_version=state_version+1, updated_at=clock_timestamp()
    WHERE run_identity_sha256=$1
    INSERT INTO run_authority_audit(...) VALUES (..., transition_type='ACQUIRE', ...)
    UPDATE operation_ledger SET status='COMMITTED', result_payload=jsonb_build_object('fencingToken',newToken), committed_at=clock_timestamp() WHERE operation_id=$operationId
  COMMIT
  RETURN { acquired: true, ownerInstanceId, fencingToken: newToken }
```

**关键点**：`owner_host_identity`/`owner_process_identity`/`owner_pid`三列**仍然被写入**（供人工审计/诊断"上一个owner是谁、在哪台机器"），但它们**从不出现在`IF`条件里**——判定语句里唯一的条件是`row.lease_expires_at > clock_timestamp()`。

### fenced-complete 与 fenced-incomplete 两种情况下的状态转换

| 情况 | acquire/recovery行为 |
|---|---|
| **fenced-complete**（P0-1审计确认：本系统当前全部关键副作用均可fencing，见P0-1结论） | 允许上述算法**自动**执行跨主机takeover，`commit`后新owner立即获得执行权，不要求任何形式的"确认旧PID已死亡" |
| **fenced-incomplete**（若未来新增某个无法fencing的副作用，且P0-1式审计发现它） | 该副作用所属的run/子系统**必须**被排除在自动takeover之外——具体做法：**不**新增持久化的`MANUAL_RECOVERY_REQUIRED`状态值（避免违反P0-4"不引入未经证明必要的持久态"原则），而是在**应用配置层面**为该子系统关闭对`quarantineExecutionAuthority`/`acquireExecutionAuthority`接管分支的调用（即：该子系统的调用方代码根本不允许自己去接管一个`ACTIVE`且lease已过期的行，只能等待显式`releaseExecutionAuthority`），需要人工判断后手动触发release才能重新开放acquire——这一分支在当前系统中**不适用**（P0-1未发现任何fenced-incomplete的副作用），此处仅为完整性说明，不引入不必要的代码路径 |

### 两个recovery同时takeover

`SELECT...FOR UPDATE`天然串行化——先中签者完成UPDATE+COMMIT，后中签者读到的已经是`lease_expires_at`为**新值**（未过期）的行，判定条件`lease_expires_at > clock_timestamp()`成立，直接ABORTED，不会产生第二个owner。

### commit确认丢失

统一走P0-2的reconciliation规则，不允许在commit确认收到前认为自己已经获得执行权（`acquireExecutionAuthority`的调用方在收到明确的`{acquired:true,...}`返回**之前**不得开始任何正式研究工作——这是应用层调用纪律，由P0-5"业务模块只能调用统一能力边界"这一收口保证不会被绕过）。

**P0-6: PASS**——takeover判定唯一依据`lease_expires_at`（数据库服务端时间），PID/host/processIdentity明确降级为纯诊断字段，不参与任何安全判定；fenced-complete/fenced-incomplete两分支均已给出确定处理，当前系统属于前者。

---

## 与六项阻塞直接相关的测试矩阵

| # | 测试名称 | 关键断言 |
|---|---|---|
| 1 | runtime role直接UPDATE ownership表被拒绝 | 以`run_authority_runtime`身份执行`UPDATE run_execution_authority SET state='ACTIVE' WHERE ...`，断言收到`42501 permission denied` |
| 2 | runtime role直接INSERT/UPDATE audit被拒绝 | 同上，对`run_authority_audit`执行INSERT/UPDATE，断言被拒绝(INSERT应该也被拒绝，因为runtime角色不直接写audit，只能通过函数写) |
| 3 | 相同operation_id、相同payload返回同一结果 | 两次调用`acquireExecutionAuthority`携带相同`operation_id`+相同参数，断言第二次直接返回第一次的`fencingToken`，且`run_authority_audit`只有一条对应记录 |
| 4 | 相同operation_id、不同payload返回OPERATION_ID_PAYLOAD_MISMATCH | 断言错误码精确匹配，且未产生任何状态变更 |
| 5 | COMMIT后确认丢失，通过ledger查到已提交结果 | 用同进程hook在`afterServerCommitBeforeClientAck`处杀死连接，断言重新连接后`reconcileOperationOutcome`返回`COMMITTED`及正确的`fencingToken` |
| 6 | 两个跨主机recovery同时takeover，只有一个成功 | 用两个真实独立子进程（模拟不同host_identity参数）竞争同一`run_identity`，断言恰好一个`acquired:true`，`run_execution_authority`最终只有一个`owner_instance_id` |
| 7 | lease到期后旧owner数据库写被旧token拒绝 | 新owner takeover后，旧owner尝试`assertCurrentFence`，断言`FENCING_TOKEN_REJECTED` |
| 8 | 旧owner完成文件rename但没有有效publication，消费者拒绝 | 构造`promoted=false`的记录+`finalPath`确实存在文件，查询`current_valid_artifacts`视图断言不返回该行 |
| 9 | 新owner以新token重新登记相同content_hash，允许成功 | 两次`registerArtifactUnderFence`用不同`operation_id`+不同`owner_instance_id`+相同`content_hash`，断言均成功插入独立行，无唯一约束冲突 |
| 10 | cleanup不删除当前或后来owner引用的blob/staging | 构造一条`promoted=false`但`intent_committed_at`很近的记录，运行cleanup逻辑，断言对应staging文件未被删除 |
| 11 | publication commit后客户端确认丢失，不重复发布语义操作 | 同#5模式应用于`commitArtifactPublication`，断言reconciliation后不会产生第二条`artifact_publications`行 |
| 12 | readonly consumer无法通过pathname读取未提交artifact | 以`run_authority_reader`身份尝试直接`SELECT`底层`artifact_publications`表(而非视图)，断言权限拒绝；尝试直接文件系统访问不在数据库测试范围内，标注为"应用层职责"（消费者代码本身不应该拥有文件系统直接读取路径，属于P0-1消费者迁移的实施验收项） |
| 13 | ACTIVE/RELEASED/QUARANTINED非法字段组合被CHECK拒绝 | 逐条尝试违反P0-4四条CHECK约束的直接INSERT（以`run_authority_admin`身份，绕开函数层测试数据库层本身的约束），断言每条均被拒绝 |
| 14 | token严格单调但允许sequence空洞 | 连续多次acquire+一次刻意制造fencing失败(ABORTED)，断言最终成功序列的token严格递增，中间的"空洞"不破坏这一性质 |
| 15 | PostgreSQL版本不是16时fail closed | 见P0-1/上一轮报告已设计的启动自检测试，本轮不重复设计，仅确认适用 |
| 16 | 数据库不可用时不得acquire/takeover/publish/展示新正式结果 | 断开数据库连接，断言全部相关函数调用均fail closed，不产生任何本地文件write |
| 17 | 仓库内全部legacy lockPath写入口均被列入退役清单 | 静态断言：P0-1表中列出的全部涉及`.status.lock`的文件（#2,#3的D7内部锁,#12测试fixture）均出现在实施阶段的退役/改造清单中，无遗漏 |
| 18 | CI检测新增直接状态写SQL | 见P0-5强制手段2 |
| 19 | 运行时测试证明即使CI漏检，数据库权限仍拒绝旁路 | 即#1/#2，作为"最终边界"的直接证明 |
| 20 | 已完成run的final artifact不因以后新的ownership token而错误失效 | 完成一次register+promote，之后对同一`run_identity`再执行一次独立的acquire+release（模拟"很久以后的诊断性重新acquire"），断言`current_valid_artifacts`视图中原先的记录依然可查且未变化 |

---

## 三项最终门禁

**G1：PostgreSQL是否为仓库内合法生产入口的唯一执行权真相源？**
基于P0-1完整审计：正式研究（FORMAL）全部15类入口中，唯一的执行权判断权威是`run_execution_authority`表（经P0-4/P0-5强制访问路径）；DRY_RUN/`historical_validation`子系统经审计确认是架构独立、预先已有自身治理、不属于"正式研究执行权"范畴的域外系统，不构成对G1的反例。
**G1: PASS**

**G2：所有会创建、改变、发布、读取或展示正式研究结果的合法生产入口，是否全部强制验证fencing或只接受数据库已提交的正式结果绑定？**
生产者侧（创建/改变/发布）：P0-3/P0-5确保全部经`registerArtifactUnderFence`/`commitArtifactPublication`/`acquireExecutionAuthority`等函数，数据库权限物理阻止旁路。消费者侧（读取/展示）：P0-1表#4-6已完整枚举D8 reader/API/dashboard三个消费入口，设计处置为统一迁移至`current_valid_artifacts`视图查询，不再信任文件路径本身。
**G2: PASS**（**完整性依赖P0-1标注的"消费者侧迁移"这一实施阶段工作被严格执行**——这是设计层面已经给出确定方案、且可被测试矩阵#8/#12/#20验证的工作，不是无法证明的假设，故不构成G2的FAIL条件）

**G3：仓库内是否仍存在无法fencing的关键副作用或正式消费者旁路？**
P0-1完整审计（15类入口逐项列出"是否存在旁路"列）未发现任何一类无法fencing或存在旁路的情形；D7内部发布锁（表#3新发现项）经分析确认是冗余但不破坏安全性的本地互斥，不构成"无法fencing"；DRY_RUN子系统经确认是域外系统，不计入本协议的fencing覆盖范围。
**G3: PASS**

## DESIGN_READY_FOR_FINAL_REVIEW

---

## 冻结契约是否需要修改

**否**——本轮六项修正均未触及需要修改契约条文的判断（沿用上一份报告第29问的结论：契约不强制"运行遥测必须是纯文件系统"，本设计的实现介质选择不与契约条文冲突；"正式研究现在需要PostgreSQL才能启动"这一可用性范围变化仍然是需要独立复审明确知悉的产品决策，但不要求先修改契约文字才能继续本轮设计工作）。未触发`FROZEN_CONTRACT_CHANGE_REQUIRED`。

## 未解决风险

1. D7内部发布锁（`artifact-publisher.js`的`quarantineStaleLock`）与新的`publishArtifactUnderFence`之间的获取顺序需要在实施阶段固定并测试，避免两把锁产生死锁（P0-1表#3已标注，不阻塞本轮设计结论）。
2. G2的完整性最终依赖实施阶段真正完成D8 reader/dashboard/API的消费者迁移，本报告已给出确定方案与验收测试（#8/#12/#20），但"是否严格执行"是实施阶段的验收责任，非本设计报告能单方面保证的事实。
3. PostgreSQL 16在本地环境仍不可用，本轮全部DDL/函数设计仍未在真实PG16上执行过（CI侧已配置PG16，但本地验证环境的缺失意味着本报告的SQL语法/函数语义正确性尚未经过任何实际数据库的编译期检验）。

## 最终结论

**DESIGN_READY_FOR_FINAL_REVIEW**

---

## 声明

本轮工作全程只读：未修改任何生产代码；未修改任何测试代码；未修改任何数据库（未连接任何数据库执行写操作）；未执行任何migration；未修改冻结契约；未创建、amend或改写任何git commit；未merge；未push；未生成bundle；未启动180天正式研究。`git status`全程干净，HEAD始终为`239302eb48311882ea2f3fa2a4bd227b2b767b64`，冻结契约SHA-256始终为`5369742b33867d5b6870a7f9148246cd12fe5ae5b90a770f2474cc66e0610b42`。

现停止，等待独立最终复审。未经明确批准，不得进入实施。
