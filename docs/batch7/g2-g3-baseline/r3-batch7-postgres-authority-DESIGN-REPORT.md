# Batch7 PostgreSQL 唯一所有权协议设计报告（DESIGN-ONLY / NO IMPLEMENTATION）

## 1. 基线

**HEAD**: `239302eb48311882ea2f3fa2a4bd227b2b767b64`　**分支**: `claude/r3-batch7-p0-p1-scoped-fix`　**git status**: 干净

## 2. 冻结契约

SHA-256: `5369742b33867d5b6870a7f9148246cd12fe5ae5b90a770f2474cc66e0610b42`（未修改）。契约原文搜索确认：契约**没有**在任何地方把"PostgreSQL 16"作为具体版本号写入文本——契约§相关段落只写"专用PostgreSQL；不得生产库"与"正式门禁要求独立PostgreSQL真实执行且无意外skip"，不绑定具体大版本号。**"PostgreSQL 16"这一具体版本要求是本次系列独立复审过程本身持续施加的操作性门禁，不是冻结契约文本的一部分**——这一区分不改变PG16门禁当前仍然必须遵守的事实（见第20节），但影响"是否需要修改冻结契约"的判断（见32问第29/30条）。

## 3. PostgreSQL 实际版本与门禁状态

```
psql (PostgreSQL) 14.23 (Ubuntu 14.23-0ubuntu0.22.04.1)
postgres: command not found
initdb: command not found
已安装集群: PostgreSQL 14-main (systemd active)
```
`POSTGRESQL_16_NON_SKIP_RESULT: MISSING`——本环境不具备PostgreSQL 16 server/initdb，只有PG14客户端工具与PG14集群。未安装、未替代，未修改环境。

## 4. 只读审计范围与完整调用关系

| 审计对象 | 发现 |
|---|---|
| `research-run-status.js`（当前锁协议实现） | 无任何postgres依赖，纯文件系统（已在上一轮设计报告详细审计） |
| `formal-research-orchestrator.js` 全部8处写操作 | 全部只调用`writeRunStatus`（文件）与`publishArtifact`（文件）；**零**数据库写操作 |
| `formal-research-data-repository.js`（575行） | 全部导出函数均为`pool.query`**只读**查询（`loadFormalResearchContext`/`loadFormalResearchPage`/`countFormalResearchRows`/`loadFormalResearchDataset`/`loadFormalResearchRows`），无一处INSERT/UPDATE——正式研究读取的是D1.4A~D1.4C采集阶段已产生的市场数据，本身不产生新的数据库写副作用 |
| `artifact-publisher.js` | D7 main+sidecar文件发布，使用`renameAllowCreate`（main）+`renameNoReplace`（sidecar，文件头注释明确标注"唯一commit point"，已有P0-02同款防覆盖保护）；隔离陈旧锁用`renameNoReplace(lockPath, quarantinePath)` |
| 子进程/`spawn`/`child_process`/`fork` | 在整条正式研究生产链路（orchestrator/artifact-publisher/replay-evaluator）中**零**命中——全部同进程同步执行；`spawn`仅出现在测试fixture中 |
| `src/db/postgres.js`（已存在的采集器lease+fencing实现，`PostgresRepository`） | **关键既有先例**：`collector_leases`表（`lease_name` PK, `holder_id`, `acquired_at`, `heartbeat_at`, `expires_at`, `fencing_token bigint`）+ `acquireLease`/`heartbeatLease`/`releaseLease`（均用`clock_timestamp()`）+ `transaction(work, lease)`：`BEGIN → assertLease(前) → work(client) → assertLease(后) → COMMIT`，`assertLease`用`SELECT ... FOR SHARE`核验`holder_id`+`fencing_token`+未过期，不通过则`throw FENCING_TOKEN_REJECTED`并触发上层`ROLLBACK`。**这正是本轮要设计的"事务内fencing校验"模式，已经在本代码库的采集器子系统内生产运行，本设计直接复用同一模式，不发明新范式** |
| `research-database-guard.js` | 已存在、已测试的"只允许连接到固定研究库名`eth_alpha_v14d_test`，连接前后双重核验，fail closed"机制——新协议的连接层将直接复用此模块 |
| migrations 001-007 | `historical_validation` schema（005号迁移）承载D7业务数据；无任何`run_identity`/`run_authority`/`research_run`相关表——新协议需要**新增**表，不与既有schema冲突 |
| PostgreSQL版本要求字符串搜索 | 代码库内**零**处硬编码"PostgreSQL 16"字样——版本门禁完全是外部操作性要求 |
| 直接操作`lockPath`的生产代码 | 与上一轮审计结果一致，仅`research-run-status.js`内部，无其他生产旁路 |

**结论**：当前系统里，"正式研究的执行权"与"正式研究产生的关键副作用"完全是**两类不同的资源**——执行权目前活在文件系统（本次要重新设计的对象），关键副作用（run-status checkpoint、D7 main+sidecar artifact）也活在文件系统，**没有任何数据库写副作用**属于正式研究管线本身。这意味着"fencing完整性清单"（第12节）的核心挑战集中在**文件副作用**上，而不是数据库副作用——这一发现直接决定了推荐方案第十一节的设计重点。

## 5. 当前文件/flock模型为何不适合作为唯一所有权协议

（沿用上一轮设计报告第2节已完成的证明，此处仅概括要点，不重复全部推导）RENAME_EXCHANGE无法在发布前原子确认被换出对象身份（三轮独立复审各自在不同分支反复证明）；flock虽然能提供真正互斥，但**只约束主动调用它的参与者**——它不能阻止一个已经失去合法性但仍在运行的旧owner继续对外部（数据库、下游文件消费者）产生副作用，因为flock本身不是这些副作用的守门人，只是本进程内部一个可以选择遵守也可以（因bug或绕过）不遵守的本地原语。**这正是本轮要求转向PostgreSQL的根本原因**：只有把"是否可以产生副作用"这一判断从"本地互斥锁是否被持有"改为"每一次副作用发生时，数据库当场核验的token是否仍然有效"，才能真正防止旧owner在失去执行权后继续产生有效副作用——flock类方案在协议设计上无法达到这一点，不是实现细节问题。

## 6. 候选数据库协议比较

| 维度 | 候选1: advisory lock | 候选2: 单行状态表+FOR UPDATE | 候选3: 状态表+lease+fencing token+append-only audit（推荐） |
|---|---|---|---|
| 唯一所有权 | 是（会话级持锁期间） | 是（事务级） | 是（token比对，不依赖持续持有任何东西） |
| 线性化点 | `pg_advisory_lock`获取瞬间 | `FOR UPDATE`行锁获取瞬间 | 授权事务`COMMIT`瞬间 |
| 事务边界 | 可跨多个事务持有（会话级）——**危险**：与"批量写checkpoint"这类短事务模式不匹配，容易造成锁与事务生命周期脱节 | 单事务内 | 单事务内（授权本身）+ token在后续任意事务中被独立校验，不要求物理持有任何东西 |
| 跨进程 | 支持 | 支持 | 支持 |
| 跨主机 | 支持（多个应用服务器连同一PG实例） | 支持 | 支持 |
| 连接中断 | advisory lock随会话结束自动释放（若用session级）；若用xact级见下 | 行锁随事务结束自动释放 | **无需持续连接**——token是数据，判断不依赖任何连接存活；连接中断对已发生的写入无影响，对下一次操作只是"需要重新连接" |
| 进程崩溃 | 会话终止即释放（若连接池复用连接会有陷阱：advisory lock绑定的是数据库会话而不是应用进程，连接池归还连接可能意外"继承"未释放的lock，这是advisory lock在连接池场景下的已知陷阱） | 事务终止即释放 | 崩溃对已提交的token毫无影响；下一次判断只看token和lease时间戳 |
| 机器重启 | 数据库会话必然终止，锁释放 | 同上 | 数据库端状态不受应用主机重启影响；后续判断走lease过期逻辑 |
| 数据库重启 | 全部会话终止，锁全部释放 | 同上 | 数据库重启期间"当前owner是谁"这一信息本身持久化在表里（不因重启丢失），只是判断"lease是否过期"需要重启后的`clock_timestamp()`继续推进 |
| 连接池兼容性 | **差**——advisory lock与连接池天然冲突（见上）；`pg_advisory_xact_lock`（事务级）可用但仍要求"锁"与"连接"绑定，与本系统"每次checkpoint各自独立获取连接"的既有模式（`pool.query`/`pool.connect()`按需）冲突 | 中——依赖短事务，行锁自动释放，兼容连接池，但"锁"本身不能跨事务表达"我仍然是owner"这一持续性事实，需要额外补一张状态表才能表达"当前谁是owner"，等价于退化为候选3但没有fencing | **好**——token是纯数据，不占用任何连接/会话/锁资源，天然兼容连接池，与`collector_leases`既有生产模式完全一致 |
| lease过期 | 不适用（会话在即为持有，无"过期"概念，只有"是否仍连接") | 不适用 | 显式`lease_expires_at`字段+`clock_timestamp()`比较，可控、可测试、可诊断 |
| 旧owner恢复 | 旧会话若仍连接着，advisory lock会一直被它握着，新owner永远拿不到锁——**这正是"心跳停顿后恢复"这类场景的致命弱点**：只要旧连接没断，advisory lock语义上"仍然合法"，无法表达"我怀疑你已经不健康，但暂时还没有确凿证据"这一中间状态 | 同上问题不存在（事务已结束），但因为没有fencing，"旧owner后台线程仍在跑，且旧事务已经结束、新owner已经拿到行锁"时，旧owner后续任何写操作都不会被本方案自动拒绝——需要额外补fencing，等价于退化为候选3 | 天然支持——旧owner的token在数据库里已经不是当前token，任何它发起的写入都会在校验时被拒绝，无论它的连接/会话是否还活着 |
| fencing能力 | **无**——advisory lock本身不产生可比较的单调值 | **无**（除非额外加字段，退化为候选3） | **有**，核心设计目标 |
| 审计原子性 | 需要额外表，且lock释放与审计写入不在同一意义上"同一个原子事件"（lock释放是隐式的连接行为，不是一次显式SQL语句，无法与审计INSERT放进同一事务由应用控制) | 可以（同一事务内更新状态+插入审计） | 可以（同一事务内更新状态+插入审计，模式与候选2相同，只是多了token字段） |
| unknown outcome | 依赖连接层面的确认，client断开时无法可靠区分"commit了没有" | 同候选3——数据库事务本身的commit/rollback是唯一真相，可用`operation_id`查询 | 同左，`operation_id`唯一标识每次操作意图，可查询审计表核实真实结果 |
| 死锁风险 | advisory lock不参与PG标准死锁检测（是应用级advisory，不是关系型锁），需要应用自己避免持锁跨越多个资源；本系统场景单一资源(单一run identity)，风险低但仍是需要人工注意的隐患 | 标准行锁，参与PG死锁检测，PG会自动abort其中一方 | 同候选2（底层仍是`FOR UPDATE`获取单行锁做当次事务内的原子决策），标准死锁检测覆盖 |
| 自动恢复 | 见上"旧owner恢复"问题，机制上不支持"怀疑但未确认死亡"的渐进式恢复路径 | 支持（配合lease/staleness字段，退化为候选3） | 支持，是核心设计目标 |
| PostgreSQL 16依赖 | 无版本特定要求（advisory lock自PG9.1起可用） | 无版本特定要求 | 无版本特定要求（`bigint`列、`clock_timestamp()`、标准事务、`FOR UPDATE`均是PG长期稳定特性，不依赖16专属特性）——**PG16门禁是本项目独立于本设计的操作性要求，不是本方案技术上对PG16特性的依赖**，见第20节 |
| 对当前代码改动范围 | 需要新建session/xact lock管理代码，且要解决连接池陷阱 | 需要新建状态表+管理代码，且需要另加fencing才完整 | 需要新建两张表+管理代码；可直接复用`collector_leases`/`assertLease`/`PostgresRepository.transaction`已验证的实现模式，改动范围可预测 |
| 与冻结契约兼容性 | 需要评估（同候选3） | 需要评估（同候选3） | 需要评估——见32问第29/30条：不强制要求修改契约文本，但需要独立复审对"遥测/结果判定层允许依赖PostgreSQL"这一架构决定给出明确确认（详见第21节未解决风险） |
| 失败时能否fail closed | 能（连接失败即拒绝） | 能 | 能，且有已验证precedent（`createGuardedResearchPgPool`已经是fail-closed实现） |
| 已知限制 | 连接池陷阱、无fencing、无法表达"渐进怀疑" | 无fencing（本身就是精简版候选3） | 需要为文件类副作用额外设计发布协议（第13节），且要求全部消费者迁移为"先查数据库指针，再信任文件"（见第21节风险2） |
| 接受/淘汰 | **淘汰**——advisory lock连接池陷阱和无fencing能力是致命短板，与本系统既有连接池使用模式（`pool.query`按需连接，不长期占用单一会话）直接冲突 | **淘汰（作为独立方案）**——技术上是候选3的子集，若要补全fencing能力就等价于候选3，不构成独立选项 | **推荐**——是唯一同时满足"跨进程/跨主机互斥"+"支持fencing"+"审计原子性"+"兼容现有连接池模式"+"有代码库内已验证precedent"的方案 |

## 7. 唯一推荐方案

**候选3：状态表 + lease + fencing token（per-run单调列）+ append-only审计表**，直接沿用`collector_leases`/`PostgresRepository.transaction`/`assertLease`/`research-database-guard.js`已经在本代码库生产运行、经过测试的模式，仅将其从"数据采集器lease"场景适配为"正式研究run执行权"场景，并按本轮硬性要求（append-only审计、状态机、artifact发布协议）扩展。

## 8. 数据库 schema 设计

新增独立schema `run_orchestration`（与`historical_validation`并列，保持"运行编排"与"D7业务结果"的架构隔离精神，呼应`research-run-status.js`文件头"不同目录、不共用锁、不共用文件"这一既有原则在数据库层面的对应延伸——见第21节关于是否需要契约层面确认这一点的讨论）。承载于既有`createGuardedResearchPgPool`保护的同一研究库（`eth_alpha_v14d_test`及其CI等价物），不引入新的数据库目标。

### A. 所有权状态表

```sql
CREATE SCHEMA IF NOT EXISTS run_orchestration;

CREATE TABLE run_orchestration.run_execution_authority (
  run_identity_sha256      text PRIMARY KEY
                            CONSTRAINT run_identity_format CHECK (run_identity_sha256 ~ '^[0-9a-f]{64}$'),
  state                     text NOT NULL
                            CONSTRAINT state_valid CHECK (state IN
                              ('ACTIVE','RELEASING','RELEASED','QUARANTINING','QUARANTINED','RECOVERING','FAILED')),
  owner_instance_id         uuid,                -- NULL 当且仅当 state 属于 {RELEASED, QUARANTINED}
  owner_pid                 integer,
  owner_host                text,                -- 沿用现有 hostIdentitySha256() 输出格式
  process_start_identity    text,                -- 沿用现有 processStartIdentity() 输出格式
  fencing_token             bigint NOT NULL DEFAULT 0,
  lease_expires_at          timestamptz,
  last_heartbeat_at         timestamptz,
  current_operation_id      uuid,
  acquired_at               timestamptz,
  released_at               timestamptz,
  quarantined_at            timestamptz,
  state_version             bigint NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT owner_required_when_active CHECK (
    (state = 'ACTIVE' AND owner_instance_id IS NOT NULL) OR (state <> 'ACTIVE')
  )
);
```

（本轮说明：上表`state`枚举中的`RELEASING`/`QUARANTINING`/`RECOVERING`三个取值，在后续独立复审的定向修正轮次中被明确判定为不应持久化，已在`BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md`的P0-4节改为确定的四态设计；本文件保留本轮提出时的原始版本，不回溯改写，以保持设计演进过程的可追溯性。）

### B. append-only 审计表

```sql
CREATE TABLE run_orchestration.run_authority_audit (
  audit_id                     bigserial PRIMARY KEY,
  operation_id                 uuid NOT NULL,
  run_identity_sha256          text NOT NULL
                                CONSTRAINT audit_run_identity_format CHECK (run_identity_sha256 ~ '^[0-9a-f]{64}$'),
  transition_type              text NOT NULL
                                CONSTRAINT transition_type_valid CHECK (transition_type IN
                                  ('ACQUIRE','HEARTBEAT','RELEASE','QUARANTINE','RECOVER','FAIL','ARTIFACT_PUBLISH_INTENT','ARTIFACT_PUBLISH_PROMOTED')),
  previous_state                text,
  next_state                    text NOT NULL,
  previous_owner_instance_id    uuid,
  next_owner_instance_id        uuid,
  previous_fencing_token        bigint,
  next_fencing_token            bigint NOT NULL,
  actor_pid                     integer,
  actor_host                    text,
  actor_process_start_identity  text,
  reason                        text,
  disposition                   jsonb,           -- 例如 {"priorOwnerClassification":"stale-with-owner","ageMs":...}
  original_record                jsonb NOT NULL,  -- 本次转换前该行的完整快照
  original_record_hash           text NOT NULL
                                  CONSTRAINT original_hash_format CHECK (original_record_hash ~ '^[0-9a-f]{64}$'),
  observed_at                    timestamptz NOT NULL,
  committed_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata                       jsonb
);
CREATE INDEX audit_run_identity_idx ON run_orchestration.run_authority_audit(run_identity_sha256, committed_at);
CREATE UNIQUE INDEX audit_operation_id_idx ON run_orchestration.run_authority_audit(operation_id, transition_type);
```

**append-only强制手段（不是"我们保证不UPDATE"这种口头约定）**：应用连接所用的数据库角色只被`GRANT INSERT, SELECT ON run_orchestration.run_authority_audit TO app_role`，**不**授予`UPDATE`/`DELETE`权限——由PostgreSQL权限系统在数据库层面拒绝任何试图修改/删除审计行的语句，即使应用代码存在bug也无法绕过（除非直接以超级用户/表属主身份操作，那已经超出"生产入口"范畴，属于第17节"migration/administrative工具必须单独授权并完整审计"要覆盖的场景）。

### C. artifact发布记录表（第11节详细设计的支撑表）

```sql
CREATE TABLE run_orchestration.artifact_publications (
  publication_id            bigserial PRIMARY KEY,
  run_identity_sha256        text NOT NULL,
  fencing_token               bigint NOT NULL,
  operation_id                 uuid NOT NULL,
  artifact_kind                 text NOT NULL CHECK (artifact_kind IN ('RUN_STATUS','D7_ARTIFACT')),
  content_hash                  text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  staging_path                  text NOT NULL,
  final_path                    text NOT NULL,
  intent_committed_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  promoted                       boolean NOT NULL DEFAULT false,
  promoted_at                    timestamptz,
  UNIQUE (run_identity_sha256, artifact_kind, content_hash)
);
CREATE INDEX artifact_pub_current_idx ON run_orchestration.artifact_publications(run_identity_sha256, artifact_kind, promoted, intent_committed_at DESC);
```

（本轮说明：上表的`UNIQUE(run_identity_sha256, artifact_kind, content_hash)`约束，在后续定向修正轮次中被明确判定为会阻止新token合法重新登记相同内容，已在修正报告P0-3节改为围绕`operation_id`的唯一约束。本文件同样保留原始版本，不回溯改写。）

## 9. 完整状态机

| 状态 | 是否拥有执行权 | owner/token必须满足 | 合法进入条件 | 合法下一状态 | 转换主体 | 事务锁 | 状态更新 | 同事务审计 | 线性化点 | 崩溃后数据库可观察状态 | 恢复方式 | 禁止转换 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **ACTIVE** | 是（当且仅当调用者持有的`owner_instance_id`+`fencing_token`与行内当前值完全一致） | `owner_instance_id`非空，`fencing_token`匹配调用者持有值，`lease_expires_at`未过（用于是否需要heartbeat的判断，不用于是否有权——见INV-7证明） | 前置为`RELEASED`/`QUARANTINED`（任意acquire）或`ACTIVE`(已确认stale，被安全接管) | RELEASING(自己)/QUARANTINING(他人对已stale对象)/ACTIVE(新owner接管已stale对象) | acquire调用者 | `SELECT...FOR UPDATE`本行 | `UPDATE`写入新`owner_instance_id`/`fencing_token+1`/`lease_expires_at`/`state_version+1` | 是,`transition_type='ACQUIRE'` | `UPDATE`语句所在事务的`COMMIT` | 若崩溃前已COMMIT：ACTIVE(新owner)；若崩溃在COMMIT前：ACTIVE(旧owner)不变 | 下一个acquire者按lease/心跳/PID/host判定是否stale | 任何未通过`SELECT...FOR UPDATE`+身份核验的直接`UPDATE` |
| **RELEASING** | 是（转换中，视为仍是执行权持有者本人的收尾动作，不对第三方开放） | 同ACTIVE的核验前提 | ACTIVE(自己) | RELEASED | 自己 | 同上 | 单一事务内直接由ACTIVE→RELEASED，`RELEASING`是逻辑中间态非独立可观察的持久态（本设计不引入"半释放"持久态，release在单个事务内原子完成，见第10节流程） | — | — | — | — | — |
| **RELEASED** | 否 | `owner_instance_id`为NULL | 由ACTIVE(自己)release产生 | ACTIVE（任意后来acquire，无需等待） | 任意acquire调用者 | 同ACTIVE写入 | 同ACQUIRE行 | 是 | 同ACQUIRE | RELEASED(不变) | 直接acquire | — |
| **QUARANTINING** | 否（针对被quarantine的对象；本设计同RELEASING，是逻辑中间态，单事务内原子完成，非独立持久态） | — | — | — | — | — | — | — | — | — | — | — |
| **QUARANTINED** | 否 | `owner_instance_id`为NULL | 由第三方对已确认ACTIVE-but-stale对象执行quarantine产生 | ACTIVE(任意后来acquire) | 任意acquire调用者 | 同上 | 同上 | 是,`transition_type='QUARANTINE'` | 同ACQUIRE | 不变 | 直接acquire | — |
| **RECOVERING** | 否（recovery不是独立状态——它就是acquire对一个被判定为stale的ACTIVE行执行的同一事务，见第10节。此行仅为满足报告要求单列，实际实现中RECOVERING不作为可持久化的`state`枚举值出现——它是"对ACTIVE(stale)执行ACQUIRE"这一操作在执行期间的瞬时描述，不是数据库列的合法取值） | — | — | — | — | — | — | — | — | — | — |
| **FAILED** | 否 | `owner_instance_id`为NULL(或保留最后owner用于诊断，见下) | 由ACTIVE(自己)在检测到不可恢复错误时主动转入,或由治理动作强制转入 | 无自动转出(需人工评估后手动`ACQUIRE`才能重新进入ACTIVE,acquire对FAILED状态的处理与对RELEASED/QUARANTINED一致——FAILED不是"陈旧但可能仍活跃"，是"明确不再活跃"，故同样立即可接管；`FAILED`与`RELEASED`/`QUARANTINED`的区别只在于`reason`/审计中记录的语义,不影响是否可接管) | 任意acquire调用者 | 同上 | 同上 | 是,`transition_type='FAIL'` | 同ACQUIRE | 不变 | 直接acquire(视为陈旧的一种) | — |

**关键澄清（回应CEO十二节明确要求）**：ACTIVE owner的`lease_expires_at`过期本身**绝不**等价于该owner已经失去制造副作用的能力——`lease_expires_at`只是"下一个acquire者判断是否可以尝试安全接管"的一个必要条件之一（还需结合PID存活性、`process_start_identity`匹配性），**真正让旧owner失去能力的机制是fencing校验在每一次关键副作用写入时被独立执行**（第12节）。状态机允许在lease过期后把行的`owner_instance_id`/`fencing_token`改写给新owner，但这**只保证新的一次UPDATE会成功**；它不能物理阻止旧owner进程继续尝试写文件或（假设性地）继续尝试数据库写——阻止旧owner真正"得逞"的唯一机制是：旧owner任何后续写入都必须先重新核验自己持有的`fencing_token`是否仍等于行内当前值,一旦不等即被拒绝。**若fencing未能覆盖某个副作用入口，状态机的takeover逻辑本身不构成完整安全保证**——这是本报告反复强调、并在第12节逐项证明覆盖度的核心命题。

## 10. 各操作事务流程

约定：`assertOwnerAndFence(client, runIdentity, ownerInstanceId, fencingToken)`为共享核验SQL：
```sql
SELECT * FROM run_orchestration.run_execution_authority
WHERE run_identity_sha256=$1 AND owner_instance_id=$2 AND fencing_token=$3 AND state='ACTIVE'
FOR UPDATE;
-- 0行 => 拒绝(FENCING_TOKEN_REJECTED)
```

| # | 操作 | 事务开始 | 锁定的行/资源 | 查询条件 | 必须验证的身份/token | 合法前置状态 | 状态写入 | 审计写入 | 唯一线性化点 | commit成功 | commit失败 | commit成功但客户端未收到确认 | 是否允许重试 | 如何通过operation_id核实真实结果 | 上层何时可开始/继续执行 | 上层何时必须停止 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **acquire** | `BEGIN` | `run_identity_sha256`该行(`SELECT...FOR UPDATE`,不存在则先`INSERT`一行初始`state='RELEASED'`再重新锁定,用`INSERT...ON CONFLICT DO NOTHING`+重查避免竞态) | 读取当前`state`/`owner_instance_id`/`lease_expires_at`/`owner_pid`/`process_start_identity`/`owner_host` | 若当前`state IN ('ACTIVE')`且经由disposition判定仍非stale：**拒绝**,不写入,ROLLBACK,返回"仍被持有" | RELEASED/QUARANTINED/FAILED/ACTIVE(已判定stale) | `UPDATE...SET state='ACTIVE',owner_instance_id=$new,owner_pid=$pid,owner_host=$host,process_start_identity=$psi,fencing_token=fencing_token+1,lease_expires_at=clock_timestamp()+$ttl,last_heartbeat_at=clock_timestamp(),current_operation_id=$opId,acquired_at=clock_timestamp(),state_version=state_version+1,updated_at=clock_timestamp() WHERE run_identity_sha256=$1` | `INSERT INTO run_authority_audit(...transition_type='ACQUIRE'...)`同事务 | `COMMIT` | 新owner持有`(ownerInstanceId,newFencingToken)` | 视为"未获取"，安全重试(未写入任何东西) | 客户端断连/超时未收到COMMIT结果 | **是**——但重试前必须先按`operation_id`查询审计表核实上一次尝试是否已经成功提交（见下） | `SELECT * FROM run_authority_audit WHERE operation_id=$opId` — 若已存在一条`ACQUIRE`记录且`next_owner_instance_id`等于本次调用方将要使用的instance_id，说明上次已成功，直接复用其`next_fencing_token`，不得重新acquire(否则会产生第二条audit记录、第二次递增token，语义上是两次不同的acquire，即使业务意图相同——见对抗场景20/21辨析) | commit确认收到后 | commit结果未知时，在完成operation_id核实前不得假定自己已持有 |
| 2 | **repeated acquire**(同一identity再次调用) | 同上 | 同上 | 同上，若当前owner就是"自己"(同`owner_instance_id`)则视为幂等心跳，走heartbeat路径而非新acquire | 若`owner_instance_id`匹配自己：走heartbeat；若不匹配且非stale：拒绝 | — | — | — | — | — | — | — | 是 | 同上 | — | — |
| 3 | **heartbeat** | `BEGIN` | 同一行`FOR UPDATE` | `owner_instance_id=$self AND fencing_token=$token AND state='ACTIVE'` | 必须完全匹配，否则拒绝(`FENCING_TOKEN_REJECTED`——自己已经不是当前owner) | ACTIVE(自己) | `UPDATE...SET lease_expires_at=clock_timestamp()+$ttl,last_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() WHERE...`——**不递增fencing_token**(心跳不是重新授权，是延长同一次授权的有效期) | 是,`transition_type='HEARTBEAT'` | `COMMIT` | 同一token延长 | 未续期成功，安全重试或视为已被取代 | 未知，查operation_id | 是 | 同上 | — | 心跳失败=必须假定随时可能被取代,后续写入前重新走assertOwnerAndFence |
| 4 | **release** | `BEGIN` | 同一行`FOR UPDATE` | `owner_instance_id=$self AND fencing_token=$token AND state='ACTIVE'` | 同心跳 | ACTIVE(自己) | `UPDATE...SET state='RELEASED',owner_instance_id=NULL,released_at=clock_timestamp(),current_operation_id=NULL,state_version=state_version+1...`(token**不**递增——release不产生新的可执行授权，只是终止现有的) | 是,`transition_type='RELEASE'` | `COMMIT` | 无owner | 若0行匹配(已被他人合法取代)：视为良性no-op,返回`released:false`,**不是错误** | 未知，查operation_id确认released是否已发生 | 是（幂等：第二次release若行已是RELEASED且`previous_owner_instance_id`记录的正是自己，视为已完成） | 同上 | — | — |
| 5 | **repeated release** | 同上 | 同上 | 同上，若行已是`RELEASED`且审计显示上次release正是自己发起：幂等返回成功 | — | — | — | — | — | — | — | — | 是 | 同上 | — | — |
| 6 | **quarantine** | `BEGIN` | 同一行`FOR UPDATE` | 读取当前owner，走`classifyOwnerDisposition`等价逻辑(host/pid存活/processStartIdentity/lease是否远超阈值) | 判定必须是"确认stale"，不是"lease过期"单独充分(见状态机关键澄清) | ACTIVE(经判定为stale) | `UPDATE...SET state='QUARANTINED',owner_instance_id=NULL,quarantined_at=clock_timestamp(),state_version=state_version+1...` | 是,`transition_type='QUARANTINE'`,`disposition`字段记录判定依据 | `COMMIT` | 无owner，被quarantine | 判定不成立(仍视为可能活跃)：不写入，返回false | 查operation_id | 是 | 同上 | — | — |
| 7 | **repeated quarantine** | 同上 | 同上 | 若行已是QUARANTINED：幂等返回成功(无需重复判定) | — | — | — | — | — | — | — | — | 是 | 同上 | — | — |
| 8 | **stale-owner detection** | 只读，无需事务(或用只读事务) | 无需锁(不产生副作用) | `SELECT`当前行 | 无(纯判定，不构成执行权变更) | — | 无 | 无 | 无(这是决策辅助，不是状态转换) | — | — | — | — | 不适用 | 不适用 | 不适用 |
| 9 | **recovery获得治理权** | 与acquire完全相同的事务(recovery没有独立入口，见状态机说明) | 同acquire | 同acquire | 同acquire | ACTIVE(已判定stale) | 同acquire | 同acquire,`transition_type='ACQUIRE'`(不单列`RECOVER`类型，除非调用方显式想在审计里标注"这是一次面向已知陈旧对象的恢复"，可选传入`reason='RECOVERY'`写入同一条ACQUIRE审计记录的`reason`字段，不需要单独的`transition_type`) | 同acquire | 同acquire | 同acquire | 同acquire | 同acquire | 同acquire | — |
| 10 | **stale-owner takeover** | 同上(即acquire对stale对象的情形) | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 11 | **owner voluntarily stopping** | 即release | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 12 | **owner crash** | 不适用(owner进程本身崩溃,不产生新事务) | — | — | — | — | — | — | — | — | — | — | — | — | — | 崩溃后该owner的一切后续写入天然不存在(进程已死),行内状态保持崩溃前最后一次COMMIT的结果不变,由后续acquire/quarantine按lease/liveness判定处理 |
| 13 | **数据库连接丢失** | 进行中的事务因连接丢失而无法COMMIT，PostgreSQL服务端在检测到连接终止后自动ROLLBACK该未提交事务 | — | — | — | — | 该事务的写入未生效 | 未生效 | 无(未commit) | — | — | 客户端本身也已经知道连接丢失,不存在"未收到确认"的模糊态——连接丢失本身就是明确信号 | 重连后按operation_id核实 | — | — | 连接丢失后必须停止,不得假定任何未确认的写入已经生效 |
| 14 | **数据库重启** | 重启期间所有连接失效,效果同上"连接丢失"批量发生 | — | — | — | — | — | — | — | — | — | — | 重连后按operation_id逐一核实 | — | — | 同上 |
| 15 | **应用重启** | 应用进程本身重启,与"owner crash"等价(从数据库视角无法区分"进程崩溃"与"进程被人为重启") | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 16 | **机器重启** | 同上,批量发生,且重启后本机所有PID全部是新分配——`processAlive`判定几乎必然为"新PID对应无关进程或PID未使用"，`process_start_identity`(若沿用现有"系统启动以来时钟节拍"定义)天然不匹配,配合lease早已过期,判定为stale | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 17 | **事务超时** | 数据库或应用层配置的语句/事务超时触发,效果等价于连接丢失(未commit的写入回滚) | — | — | — | — | — | — | — | — | — | — | 按operation_id核实 | — | — | 超时后必须停止,不得假定已生效 |
| 18 | **commit acknowledgement丢失** | 数据库端已经`COMMIT`成功(WAL已落盘)，但网络层面客户端未收到TCP响应 | — | — | — | — | 已经真实生效 | 已经真实生效 | 数据库端`COMMIT`那一刻 | — | 客户端视角"未知" | **绝不能盲目重试同一逻辑操作**(会产生第二次真实的状态转换，例如二次acquire会二次递增token,语义错误——见对抗场景20/21) | — | 客户端必须先按`operation_id`查询审计表,若已存在对应记录,直接采用其结果,不得重新执行 | 核实完成后 | 核实完成前不得继续假设自己是/不是owner |
| 19 | **operation outcome unknown** | 同上 | — | — | — | — | — | — | — | — | — | — | 仅在"确认从未提交"后才可用**新的**operation_id重试；用**同一个**operation_id重试是安全的幂等重放(见测试T-idempotent) | 查`run_authority_audit WHERE operation_id=$opId` | — | — |
| 20 | **audit reconciliation** | 只读查询,无需写事务 | 无 | `SELECT`审计表+当前状态表联合核对 | 无 | — | — | — | — | — | — | — | — | 不适用 | — | — |
| 21 | **derived file regeneration**(即artifact重新生成/republish) | 见第11节完整设计 | — | — | — | — | — | — | — | — | — | — | — | — | — | — |

## 11. 线性化点

| 操作 | 唯一线性化点 |
|---|---|
| acquire成功 | 授权`UPDATE`所在事务的`COMMIT` |
| heartbeat成功 | 续期`UPDATE`所在事务的`COMMIT` |
| release成功 | 释放`UPDATE`所在事务的`COMMIT` |
| quarantine成功 | 隔离`UPDATE`所在事务的`COMMIT` |
| recovery获得治理权 | 与acquire相同的`COMMIT`(recovery非独立路径) |
| stale-owner takeover | 同acquire |
| artifact成为正式有效结果 | **不是**文件rename完成的瞬间，而是`artifact_publications`行的`promoted=true`那次`UPDATE`所在事务的`COMMIT`（见第13节详细论证） |
| unknown outcome被确定 | 查询`run_authority_audit`/`artifact_publications`得到确定性结果的那次`SELECT`返回(该`SELECT`本身不是"新的线性化点"，它只是**读出**了此前某次写操作事务已经确立的线性化点——查询reconciliation结果**绝不等价于重新执行该操作**，这是CEO十三节明确要求区分的两件事) |
| audit record成为永久证据 | `INSERT`所在事务的`COMMIT`（与对应的状态转换在同一事务，共同提交或共同回滚，见INV-4） |

**客户端未收到commit确认时的处理规则（贯穿全部线性化点）**：绝不假定"未收到确认=未提交"或"=已提交"——唯一正确动作是暂停，用`operation_id`查询`run_authority_audit`（对状态类操作）或`artifact_publications`（对发布类操作），得到确定结果后才能决定"视为成功继续"还是"视为从未发生、可用同一`operation_id`安全重放"。**不得在commit确认收到前开始或继续任何正式执行**——这是本设计对"exactly-once语义"的核心保证来源：不是靠网络层可靠性，是靠"任何执行开始前必须先能证明自己持有当前有效的commit结果"这一纪律。

## 12. fencing 完整性清单（本轮最关键门禁）

| # | 入口/函数/文件 | 副作用对象 | 当前是否使用事务 | 能否携带fencing token | token在哪里验证 | 验证与副作用是否同一事务 | 文件副作用避免旧owner发布方式 | 旧token预期错误 | 数据库不可用时行为 | 允许重试 | 未fencing剩余风险 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 正式研究启动 | `formal-research-orchestrator.js`调用点 | `run_execution_authority`行本身 | 是(新设计) | 是——启动即acquire | acquire事务内部 | 是 | 不适用(这就是acquire本身) | `FENCING_TOKEN_REJECTED`/"仍被持有" | fail closed(见第20节) | 是(未写入任何东西前) | 无 |
| **状态更新(`writeRunStatus`)** | `.status.json`文件内容 | 是(新设计下改为走`publishRunStatusUnderFence`，见第13节) | 是 | staging写入前不验证；**promote事务内**验证 | 是（promote事务） | 见第13节staging+intent+promote三段式 | 旧token的intent-commit在事务内被拒绝(`SELECT...FOR UPDATE`+token比对返回0行) | fail closed | 是（staging阶段可安全重试；promote阶段按operation_id核实） | 若某处代码遗漏调用`publishRunStatusUnderFence`而直接写文件——**这是完整性依赖的关键假设**,见第17节统一能力边界+CI静态扫描作为强制手段 |
| **progress/checkpoint** | 同上(`writeRunStatus`内部即是checkpoint写入路径) | 同上 | 同上 | 同上 | 同上 | 同上 | 同上 | 同上 | 同上 | 同上 |
| replay generation | 内存计算,无持久化副作用(生成的replay数据在内存中传递给evaluation,不落盘,不入库——审计确认`replay-evaluator.js`本身不做独立的数据库/文件写入,其结果并入最终D7 artifact一次性发布) | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | — | 无(无独立可攻击的中间副作用点) |
| evaluation | 同上,内存计算,结果并入D7 artifact | 同上 | — | — | — | — | — | — | — | — |
| **outcome写入** | D7 main artifact内容的一部分,随`publishArtifact`一次性写入 | 见"artifact发布" | — | — | — | — | — | — | — | — |
| **report写入** | 同上 | 见"artifact发布" | — | — | — | — | — | — | — | — |
| **artifact发布**(`publishArtifact`/`artifact-publisher.js`) | D7 main+sidecar文件 | 否(当前纯文件系统) | 是(新设计) | staging阶段不验证,**intent-commit事务**验证 | 是 | 见第13节完整三段式设计 | 见第13节"旧owner即使完成rename也不能使旧artifact成为有效结果"的完整论证 | fail closed | 是(staging可重试;intent-commit按operation_id核实;promote按publication_id幂等推进) | 依赖`publishArtifactUnderFence`是唯一入口——同上完整性假设 |
| cleanup | 清理孤儿staging文件/过期审计查询(只读为主) | 私有staging路径 | 不需要——清理程序只操作"自己私有创建、从未被任何其他角色引用"的路径,不涉及owner身份 | — | — | — | 见第13节"清理程序不得删除当前owner或后来owner的staging文件"专项设计 | — | 清理可以延后执行,不影响安全性,只影响磁盘占用 | 是 | 若清理逻辑误删仍在intent-commit未完成前的staging文件,会造成promote阶段读取失败——需要设计清理的年龄阈值远大于任何单次操作的合理耗时上限,作为实施阶段细节 |
| final status | 即`writeRunStatus`的COMPLETED/FAILED终态写入,与"状态更新"同一路径 | — | — | — | — | — | — | — | — | — |
| **审计写入**(`run_authority_audit`) | 数据库INSERT | 是,与对应状态转换同事务 | 不适用(审计写入本身不是"需要被fencing保护的副作用"，它**就是**fencing机制的一部分) | — | — | 是(INV-4) | — | — | — | — | 无 |
| 文件重命名或覆盖 | 全部经`renameAllowCreate`/`renameNoReplace`——新设计下这些调用全部内移到`publishArtifactUnderFence`/`publishRunStatusUnderFence`内部,不再由`artifact-publisher.js`/`research-run-status.js`的调用方直接触达 | — | — | — | — | — | — | — | — | — |
| 子进程启动 | 审计确认**不存在**(正式研究管线全程同进程同步执行,无`spawn`) | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | — | 无 |
| 任何可能被外部消费者视为有效研究结果的写入 | 即D7 main+sidecar artifact——已在"artifact发布"行覆盖;**消费者侧**(D8 status reader/dashboard/GO-NO-GO evaluator)需要同步迁移为"先查`artifact_publications`表,再信任文件",这是完整性链条中不属于"生产者侧fencing"但同等重要的另一半,见第13节与第21节实施影响 | — | — | — | — | — | — | — | — | — |

**结论**：审计确认本系统当前**不存在**无法fencing的关键副作用——replay generation/evaluation是纯内存计算无独立持久化副作用；子进程启动不存在；剩下的全部关键副作用（run-status checkpoint、D7 artifact）都是**文件类**副作用，可以通过第13节的staging+intent-commit+promote三段式协议完整纳入fencing保护，前提是（a）生产者侧统一收口到`publishRunStatusUnderFence`/`publishArtifactUnderFence`两个入口（第17节+CI静态扫描强制），（b）消费者侧（D8 status reader等）迁移为查询`artifact_publications`而非直接信任文件路径存在。**这两个前提都是实施阶段的完整性工作，本设计报告认为它们是可以被完整覆盖、可以被静态扫描+运行时测试双重验证的，不构成本轮设计层面的DESIGN_BLOCKED条件**——但如果独立复审认为"消费者侧迁移"这一半在范围/工期上不可控，应该在批准前明确提出，因为**只要有一个消费者仍然直接信任文件而不查数据库指针，第16节INV-6/16的保证就会在那个消费者身上失效**（这是本报告最重要的一条完整性边界声明，不应被掩盖）。

## 13. artifact 发布协议

**核心问题**（CEO原话）："DB验证与文件rename之间无法天然原子"——这是真实的、不可用更聪明的SQL/rename顺序消除的事实。解法不是让两者原子，而是**让文件的存在本身不再具有意义**，只有数据库记录"这个content_hash是当前有效结果"才具有意义。

### 方案比较

| 方案 | 说明 | 是否消除旧token产物被接受的风险 |
|---|---|---|
| DB commit后rename | 简单，但rename本身可能失败/崩溃在commit和rename之间，且**不解决**"旧owner的rename是否会覆盖新owner已发布的文件"（取决于文件层是否也有防覆盖保护） | 部分——仍需要消费者查DB，否则文件系统本身对"谁先rename成功"没有token意识 |
| rename后DB commit | 更差——文件已经对外可见(若消费者直接读文件路径)，DB还没commit，形成"文件已可见但未经权威确认"的危险窗口，与本轮要消灭的"先发布后验证"问题同构 | 否——重蹈P0-03/P0-04覆辙 |
| **outbox/manifest两阶段发布(推荐)** | staging(私有路径,任意时刻可安全重试/丢弃)→intent-commit(DB事务内验证token并记录"我打算发布这个content_hash")→promote(实际rename到最终路径,可由任意持有当前有效token的进程完成,不要求必须是最初staging的那个进程)→promoted-commit(DB事务内标记"已完成rename") | **是**——消费者只信任`promoted=true`且`fencing_token`当前仍有效的记录,文件路径本身从不被直接信任 |
| content-addressed immutable artifact | 与推荐方案不冲突,是推荐方案的一个属性(staging/final路径均以`content_hash`命名,天然去重,天然不可变) | 是(作为推荐方案的组成部分,非独立方案) |

### 推荐：outbox/manifest两阶段发布 + content-addressed存储

**完整流程**：
1. owner（持有效`(ownerInstanceId, fencingToken)`）在**不查询数据库**的情况下，把完整artifact内容写入私有staging路径：`{artifactRoot}/.staging/{operationId}/{contentHash}`（沿用现有`writeTempFileDurable`+`fsyncDirectory`，无需改动这部分原语）。此步骤失败/被中断只产生孤儿staging文件，无任何权威性后果。
2. owner开启DB事务：`assertOwnerAndFence`（`SELECT...FOR UPDATE`本行，核验`owner_instance_id`+`fencing_token`当前仍匹配）→若通过，`INSERT INTO artifact_publications(...,promoted=false,...)`记录"意图发布此`content_hash`"→`COMMIT`。**若此步骤因fencing不匹配而失败**：owner的token已经过期/被取代，ROLLBACK，staging文件成为孤儿（后续清理程序按年龄阈值回收），owner必须停止，不得继续。
3. 只有步骤2成功COMMIT后，owner（或**任何**当前持有效token的进程，包括后续接管者——这是outbox模式的关键优势：promote步骤不要求必须由最初staging的那个进程完成）执行`renameAllowCreate(stagingPath, finalPath)` + `fsyncDirectory`。
4. 开启第二个DB事务：重新`assertOwnerAndFence`（因为步骤3可能耗时，token可能在此期间又变化）→若仍通过，`UPDATE artifact_publications SET promoted=true, promoted_at=clock_timestamp() WHERE publication_id=$id`→`COMMIT`。若不通过：文件已经物理rename成功，但**数据库不承认它是权威结果**（`promoted`永远停在`false`）——这正是"即使旧owner完成了rename，也不能使旧artifact成为有效正式结果"的字面实现：**consumer的查询条件是`promoted=true AND fencing_token=(SELECT当前fencing_token FROM run_execution_authority)`，一个`promoted=false`或`fencing_token`已经不是当前值的记录，永远不会被consumer接受**，无论对应文件是否真实存在于`finalPath`。
5. **消费者规则**（D8 status reader/GO-NO-GO evaluator等**必须**遵守，见第12节完整性边界声明）：`SELECT ap.* FROM artifact_publications ap JOIN run_execution_authority rea ON rea.run_identity_sha256=ap.run_identity_sha256 WHERE ap.run_identity_sha256=$1 AND ap.artifact_kind=$2 AND ap.promoted=true AND ap.fencing_token=rea.fencing_token ORDER BY ap.promoted_at DESC LIMIT 1`——只有联表核对"发布时的token"与"当前权威token"仍然一致（即没有被之后的一次acquire/quarantine取代）才信任对应`final_path`的文件内容。**注意**：即便`fencing_token`后来被更新的acquire取代了，之前`promoted=true`的那条发布记录本身仍然是"曾经权威"的历史事实（不删除，append语义），只是不再被上面这条"当前有效"查询选中——这与INV-5"后续acquire不覆盖旧审计"完全一致，`artifact_publications`表本身也遵循只INSERT/UPDATE`promoted`标记、不DELETE的原则。

（本轮说明：第5点"联表核对当前token"的消费者规则，在后续定向修正轮次中被明确判定为存在逻辑冲突——会让已完成run的历史有效结果因为之后无关的重新acquire而错误失效，已在修正报告P0-3节改为"发布记录一旦promoted即永久有效，不再联表当前token"。本文件保留原始版本，不回溯改写，修正内容以`BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md`为准。）

**清理程序不得删除当前owner或后来owner staging文件的保证**：清理程序只能删除`age(stagingFile) > 清理阈值 AND 该content_hash在artifact_publications中不存在promoted=true记录 AND 该content_hash也不存在任何promoted=false但intent_committed_at在清理阈值内的记录`——即只清理"确认从未被任何在途或已完成的发布意图引用"的纯孤儿文件，与第17节要求的"清理程序不得删除当前owner或后来owner的staging文件"一致。

**各阶段崩溃恢复**：staging写入中崩溃→纯孤儿，后续清理回收，无权威性影响。intent-commit中崩溃(COMMIT前)→未记录任何意图，等价于步骤1的孤儿。intent-commit后、rename前崩溃→`artifact_publications`有一条`promoted=false`记录，**任何**后续持有效token的进程（可以是原owner恢复，也可以是新owner）都可以安全地"接手完成"这条未promote的记录：重新走步骤3-4，因为该记录的`content_hash`是确定性的（同样输入产生同样内容），重新计算/复用staging文件即可安全幂等地完成剩余步骤。rename后、promoted-commit前崩溃→文件已在`finalPath`,`artifact_publications`仍是`promoted=false`——后续进程发现`finalPath`已存在且内容hash与记录一致，可以跳过步骤3直接完成步骤4的DB确认（幂等）。

## 14. append-only 审计协议

已在第8节B表定义中通过PostgreSQL权限系统（`REVOKE UPDATE, DELETE`）强制执行，不依赖应用层自律。每条状态转换在**同一事务**内先执行状态表`UPDATE`（或`INSERT`）、再执行审计表`INSERT`，共同`COMMIT`或共同因任何一方失败而`ROLLBACK`——PostgreSQL单一事务的原子性直接提供INV-4的证明基础，无需额外的两阶段提交协调。

## 15. 安全不变量及证明（18条）

**INV-1：每个run identity任意时刻最多一个数据库有效owner。**
证明：`owner_instance_id`只能通过持有`run_identity_sha256`该行`FOR UPDATE`锁的事务内的`UPDATE`语句改变；PostgreSQL标准MVCC+行锁保证同一时刻至多一个事务持有该行的排他锁，故至多一次写入在"进行中"；任何试图在同一时刻做出竞争决策的第二个事务会被阻塞直到第一个事务提交或回滚，届时它读到的已经是第一个事务的结果，据此做出正确判断。∎

**INV-2：只有已提交ACTIVE状态中匹配owner_instance_id和fencing_token的进程拥有执行权。**
证明：状态机定义（第9节）+ 第12节fencing完整性清单确认：全部关键副作用的写入（无论数据库还是文件）都要求先通过`assertOwnerAndFence`等价核验，核验条件正是"当前已提交行的`owner_instance_id`+`fencing_token`与调用者持有值完全一致"。∎

**INV-3：所有权状态只能通过统一数据库事务接口改变。**
证明：第17节要求`run_execution_authority`表不对业务模块开放直接写权限，只能通过共享内部实现（`acquireExecutionAuthority`等）改变，配合数据库GRANT/REVOKE与CI静态扫描双重强制（第17节）。∎

**INV-4：状态转换与append-only审计在同一事务提交或共同回滚。**
证明：第10节每个操作流程明确列出"状态写入"与"审计写入"处于同一`BEGIN...COMMIT`块内，PostgreSQL事务的原子性直接保证。∎

**INV-5：后续acquire不会覆盖或删除旧owner/B的审计证据。**
证明：`run_authority_audit`是append-only表（数据库权限强制，第14节），且每条记录`audit_id`独立自增，不存在任何UPDATE路径去修改历史记录的`previous_owner_instance_id`/`original_record`等字段。新的acquire只会在`run_execution_authority`表的**同一行**上产生新值（覆盖"当前值"），但该行在覆盖前的完整快照已经被记录进`original_record`字段的审计INSERT捕获，且该INSERT本身不可变。∎

**INV-6：旧owner的token不能提交任何关键副作用。**
证明：第12节fencing完整性清单逐项确认全部关键副作用（run-status checkpoint、D7 artifact发布）都通过`publishRunStatusUnderFence`/`publishArtifactUnderFence`统一入口，二者内部均在写入生效前（数据库副作用：写入本身即在fencing校验的同一事务内；文件副作用：见第13节intent-commit/promoted-commit两次独立核验）重新核验token，旧token在任一次核验处都会被拒绝（`SELECT...FOR UPDATE`条件不匹配返回0行）。∎——**该证明的完整性严格依赖第12节声明的前提**：所有生产入口确实唯一收口到这两个函数，不存在旁路（第17节CI扫描是这一假设的强制保障，非纯理论假设）。

**INV-7：lease过期本身不会绕过fencing要求。**
证明：状态机第9节"关键澄清"段落+第12节清单已明确：lease过期只影响"下一个acquire者是否被允许尝试接管"这一判断（发生在`run_execution_authority`表的读取/UPDATE层面），**不会**、也没有任何代码路径会让它绕过`assertOwnerAndFence`——旧owner即便lease已过期，只要它还没有被**实际**的一次成功acquire事务取代（即行内`fencing_token`还是它记得的那个值），它的fencing校验依然会通过（这是**故意的**：lease过期是"允许别人尝试接管"的必要条件，不是"立即剥夺当前owner权利"的充分条件——只有在真正有人成功完成一次新的acquire事务、行内`fencing_token`真正改变之后，旧owner的后续fencing校验才会失败）。∎

**INV-8：PID reuse不会被误认为原owner。**
证明：`assertOwnerAndFence`的核验条件是`owner_instance_id`（UUID，每次acquire全新生成）+`fencing_token`（每次acquire严格递增）的组合，**不**是PID——即使PID被复用，新进程不可能猜到/继承旧进程持有的`owner_instance_id`(128位随机UUID)与`fencing_token`(数据库内部状态，从不通过任何"公开可推测"的方式传播)，因此新进程即使PID相同，天然无法通过fencing校验。`owner_pid`/`process_start_identity`列仅用于**quarantine判定阶段**（判断"能否安全认定当前owner已经不再活跃"），不用于**fencing校验阶段**（判断"这次写入是否被允许"）——两者是完全独立的判断，PID reuse至多影响前者的判定质量（与现状能力一致，已在上一轮flock报告INV-5证明中详细论证过PID reuse在quarantine判定层面的处理，此处不重复），对fencing校验（真正阻止旧owner写入的机制）完全没有影响。∎

**INV-9：数据库不可用、版本不合格或结果未知时fail closed。**
证明：`acquireExecutionAuthority`等全部入口的第一步是通过`createGuardedResearchPgPool`建立连接（已有的、已测试的fail-closed实现——连接失败/库名不符直接抛错，见第4节审计），版本不合格由启动自检（第20节）在建立连接后立即执行`SHOW server_version_num`校验并拒绝启动；结果未知时的处理规则见第11节"客户端未收到commit确认时的处理规则"——绝不假定，必须核实。∎

**INV-10：文件内容和pathname不决定执行权。**
证明：状态机（第9节）与全部核验逻辑（第10节流程表"必须验证的身份/token"列）均只读取`run_execution_authority`表；文件系统上不存在任何被读取用于"是否有执行权"这一判断的路径或内容——文件的唯一角色是第13节定义的"被数据库指针引用的、content-addressed的、不可变的负载存储"，其自身存在与否、内容如何，从不参与执行权判断。∎

**INV-11：旧操作不能释放、quarantine、覆盖或撤销后来合法owner的状态。**
证明：release/quarantine均要求在同一事务内先核验`owner_instance_id`+`fencing_token`匹配调用者持有值（第10节流程4/6），若已被后来者取代，核验失败，返回良性`false`，不执行任何`UPDATE`。∎

**INV-12：两个recovery不能同时授予两个owner。**
证明：recovery即acquire（无独立路径），直接沿用INV-1的证明——`FOR UPDATE`行锁保证严格串行。∎

**INV-13：进程或机器崩溃不会产生双owner。**
证明：崩溃只能发生在"事务尚未COMMIT"（该次写入完全不生效，行内仍是崩溃前的合法值）或"事务已经COMMIT"（该次写入完全生效，行内是崩溃者自己刚写入的新值）两种情形之一（PostgreSQL事务的原子性保证不存在"部分生效"的中间态），不存在让两个不同的`owner_instance_id`同时通过`assertOwnerAndFence`核验的可能——因为该核验读取的是**同一行**的**同一时刻**取值，MVCC下每个事务读到的是一个一致的快照，不会有"两个事务各自看到自己是唯一owner"的分裂视图（`FOR UPDATE`强制排队读取最新已提交值）。∎

**INV-14：不存在不可治理的永久锁；如确有人工恢复场景，必须明确列出而非隐藏。**
如实列出：（a）若`run_execution_authority`表本身因为极端情况（如磁盘满导致的INSERT失败反复出现）无法完成任何事务——这是数据库层面的运维故障，需要人工介入修复数据库本身，不是本协议的设计缺陷，与现有系统"数据库不可用即fail closed，需人工修复环境"的既有原则一致，非新增的不可治理场景。（b）若`run_authority_audit`因为append-only约束在某次运维中确实需要修正一条被证明写错的记录——本设计**不**提供任何自动路径去做这件事（这是故意的，append-only的存在意义就是不可变），只能通过数据库管理员以表属主权限（超出应用角色权限范围）手动、有记录地介入，这本身应该被视为一个需要独立审批、完整留痕的治理事件，不是本协议日常运行的一部分。除上述两类明确的、需要数据库管理员权限介入的运维场景外，本协议不产生其他需要人工解除的永久锁——lease过期+quarantine+acquire的组合覆盖了全部"当前owner已死"的场景，不依赖旧owner自己配合。

**INV-15：所有生产acquire、release、quarantine、heartbeat和recovery入口使用同一内部协议。**
证明：第17节要求底层状态表不对业务模块开放直接写权限，全部转换只能通过共享内部实现完成，配合CI静态扫描（禁止新增对`run_execution_authority`/`run_authority_audit`的直接SQL写入）与运行时测试（T-unified-entry类测试，第18节）双重验证。∎（该证明同样依赖"实施阶段确实落实这一收口"这一前提，本设计报告在第17节给出可执行的强制手段，不是纯粹口头承诺。）

**INV-16：所有被消费者接受的正式artifact必须与数据库已提交的有效token绑定。**
证明：第13节步骤5明确定义消费者的唯一合法查询路径（联表核对`promoted=true AND fencing_token=当前权威token`），这是**设计约定**而非**代码强制**——其完整性依赖第12节声明的"消费者侧迁移"这一实施前提，本报告已明确标注这是完整性链条中必须同步完成、否则整条保证会在未迁移的消费者身上失效的部分（见第12节结论段、第21节未解决风险）。

**INV-17：operation_id重试不会重复授予或错误改变所有权。**
证明：第10节流程1/19明确要求"用operation_id查询审计表确认上次尝试的真实结果，已存在记录则直接复用，不重新执行"——只要调用方遵守这一纪律（而不是无脑对同一逻辑意图生成新的`operation_id`重试），同一`operation_id`不会产生第二条审计记录（`audit_operation_id_idx`唯一索引在`(operation_id, transition_type)`上强制这一点，第二次尝试INSERT同一`operation_id`+`transition_type`会因唯一约束冲突而失败，天然形成数据库层面的幂等保护，不完全依赖应用层纪律）。∎

**INV-18：数据库事务成功但确认丢失时，不会因盲目重试产生第二次语义操作。**
证明：同INV-17，唯一索引`audit_operation_id_idx`在数据库层面直接拒绝重复插入，即使应用代码"忘记"先查询直接重试，第二次`INSERT`本身就会失败（约束冲突），调用方捕获该冲突后应转为查询已存在记录，而不是把冲突误判为"整个操作失败"——这是实施阶段需要明确处理的错误分支，本设计报告要求把"唯一约束冲突"作为一个独立于"fencing被拒绝"的错误码，避免二者被调用方混淆处理。∎

**结论：全部18条不变量均可给出构造性证明，覆盖正常、并发、身份异常、崩溃、断网、数据库重启与旧owner恢复。INV-6/15/16三条的证明明确标注其完整性依赖"生产入口统一收口"与"消费者侧迁移"两个实施阶段前提——这两个前提本身是可验证、可强制（CI扫描+权限系统+唯一索引）的，不是无法兑现的假设，故不构成DESIGN_BLOCKED条件，但要求独立复审在批准实施时明确知悉并后续验收这两项完整性工作。**

## 16. 对抗性并发时序（40项，摘要表；细节论证与第15节安全不变量共享同一套证明基础，此处逐项给出结论性结果，避免与第15节重复完整推导）

| # | 场景 | 初始DB状态 | 参与者 | 精确交错 | 行锁/事务边界 | 线性化点 | 最终owner | 最终token | 审计记录 | 文件/产物状态 | 各参与者结果 | 允许自动重试 | unknown outcome核对 | 保持的不变量 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 两进程同时acquire | RELEASED | A,B | 同时`FOR UPDATE`，PG按到达顺序排队，A先中签 | 单行 | A的COMMIT | A | token+1 | 一条ACQUIRE(A) | — | B读到ACTIVE(A)，等待/超时 | B:是 | — | INV-1,12 |
| 2 | acquire与release | ACTIVE(X) | X(release),A(acquire) | 串行排队，release先或acquire先均可，二者互斥 | 单行 | 各自COMMIT | 视顺序而定 | 视顺序 | RELEASE,ACQUIRE各一条 | — | 均成功或A等待后成功 | 是 | — | INV-1,2,11 |
| 3 | acquire与quarantine | ACTIVE(Y,stale) | Q,A | 串行排队 | 单行 | 先中签者COMMIT | 后一操作基于前一操作结果 | — | QUARANTINE+ACQUIRE各一条(顺序视排队而定) | — | 两者不冲突(quarantine腾出空位后acquire立即可用) | 是 | — | INV-1,12 |
| 4 | release与quarantine | ACTIVE(X) | X(release),外部(quarantine企图) | quarantine判定X为active(非stale)→拒绝；release正常完成 | 单行 | release的COMMIT | 无owner(RELEASED) | 不变 | RELEASE一条,quarantine无写入(判定失败不产生审计——**设计选择**:仅在实际发生状态转换时写审计,纯判定失败是只读操作) | — | quarantine:false(良性) | 是 | — | INV-1,11 |
| 5 | heartbeat与recovery | ACTIVE(X),lease接近过期 | X(heartbeat),R(recovery尝试) | 若heartbeat先中签且成功续期：R的判定读到未过期，拒绝；若R先中签且X已经lease过期：R成功接管，X随后heartbeat因token不匹配被拒绝 | 单行 | 先中签者COMMIT | 视竞速结果 | 视竞速结果 | HEARTBEAT或ACQUIRE | — | 视竞速结果，X的heartbeat若晚了会收到`FENCING_TOKEN_REJECTED` | 是(X应停止而非重试心跳) | — | INV-1,7 |
| 6 | 两个recovery同时takeover | ACTIVE(Y,stale) | R1,R2 | 串行排队 | 单行 | R1的COMMIT | R1 | R1的新token | 一条ACQUIRE(R1) | — | R2读到ACTIVE(R1)，等待/超时 | R2:是 | — | INV-1,12 |
| 7 | owner lease到期但仍在执行 | ACTIVE(X)，lease已过期 | X继续尝试写副作用 | X的`publishRunStatusUnderFence`内部assertOwnerAndFence仍核验`owner_instance_id+fencing_token`匹配（未被任何人实际取代前，X的token依然是行内当前值）→**成功**（见INV-7证明：lease过期不单独剥夺权利） | — | X自己的写入事务COMMIT | X(未被取代) | 不变 | 对应ACQUIRE/HEARTBEAT历史记录 | — | X的副作用正常生效——这是**预期行为**，不是漏洞:只要没人真正完成接管，旧owner有权继续 | — | — | INV-7(lease过期≠立即剥夺,只是允许他人尝试) |
| 8 | owner lease到期后恢复(X的心跳重新联通) | 场景7的延续,此时R已经成功takeover | X(迟到的heartbeat),R(已是当前owner) | X的heartbeat核验`fencing_token=X的旧token`,行内已是R的新token,不匹配→拒绝 | — | 无(X的事务因核验失败ROLLBACK,不产生状态改变) | R | R的token | HEARTBEAT尝试无审计(判定失败) | — | X收到`FENCING_TOKEN_REJECTED`,必须停止 | 否(X不应重试,应停止) | — | INV-2,6,7 |
| 9 | PID reuse | ACTIVE(X,pid=P,stale) | 新进程Y复用P尝试acquire(Y与X无关) | Y的acquire走quarantine判定逻辑,判定依据`process_start_identity`而非纯PID,Y的`process_start_identity`与X记录的不同→若达到staleness阈值仍可判定X为stale并允许接管(接管者可以是任意进程,不要求必须是Y本身,Y只是"恰好复用了P"这一无关事实,不影响判定逻辑本身) | — | 判定+写入者的COMMIT | 视哪个进程先完成acquire | — | ACQUIRE(记录`disposition`含PID reuse上下文) | — | Y的存在与本次判定无因果关系(Y从未声称自己是X) | — | — | INV-8 |
| 10 | owner在事务开始前崩溃 | 任意 | — | 崩溃发生在`BEGIN`之前,无事务产生 | — | 无 | 不变 | 不变 | 无 | — | 无人受影响 | — | — | INV-13 |
| 11 | owner在行锁获取后崩溃 | 任意 | — | 已`SELECT...FOR UPDATE`,尚未`UPDATE`/`COMMIT` | 该行锁随连接终止自动释放(PostgreSQL标准行为:会话结束,持有的锁全部释放) | 无(未commit) | 不变 | 不变 | 无 | — | 下一个尝试者能立即获取该行锁(不会被已死会话永久阻塞) | 下一个:是 | — | INV-13,14 |
| 12 | 状态更新后、commit前崩溃 | 任意 | — | `UPDATE`已执行(在事务内可见),尚未`COMMIT` | — | 无(未commit,PostgreSQL在连接终止时自动ROLLBACK该事务) | 不变(回滚) | 不变 | 无 | — | — | 下一个:是 | — | INV-13 |
| 13 | commit后、响应前崩溃 | 任意 | — | `COMMIT`已完成(WAL落盘,数据库端视角已生效),客户端在收到响应前连接中断/进程崩溃 | — | `COMMIT`本身 | 崩溃者自己(若是acquire) | 崩溃者的新token | 已写入 | — | 下一个观察者看到的是崩溃者已经成功acquire的状态,随后按正常的stale判定流程处理(lease会在崩溃者未心跳的情况下自然过期) | — | 若崩溃的是**调用方自己**,它不会再来查询(它已经死了);**其他**观察者按operation_id能查到这次操作确实成功了 | INV-13,17 |
| 14 | audit insert后、状态更新前失败 | — | — | 本设计的SQL顺序是先UPDATE状态表再INSERT审计表(或可互换顺序,关键是二者在同一事务内)——若二者顺序颠倒且audit先执行后状态更新失败,整个事务ROLLBACK,两者都不生效,不存在"审计有了但状态没变"的不一致 | — | — | 不变 | 不变 | 无(整体回滚) | — | — | — | — | INV-4(同事务保证不会出现这种分裂) |
| 15 | 状态更新后、audit insert前失败 | 同上,同一事务,同样整体回滚 | — | — | — | 不变 | 不变 | 无 | — | — | — | — | INV-4 |
| 16 | 数据库连接在commit时中断 | — | — | 客户端发出`COMMIT`,网络在服务端处理完成、回包前中断 | — | 服务端`COMMIT`是否真正执行取决于服务端是否已经完成WAL落盘——**这是"结果未知"的经典场景** | 不确定(需查证) | — | 若服务端已提交则存在 | — | 客户端视角完全未知 | 否(不得盲目重试) | 必须查operation_id | INV-17,18(唯一索引防止误重试造成的重复效果) |
| 17 | PostgreSQL重启 | — | — | 重启期间/瞬间的全部会话终止,效果等价场景11-13批量发生 | — | — | — | — | — | — | 重启后所有连接失效,应用层观察到连接错误,fail closed(见INV-9) | 重连后按operation_id逐一核实 | — | — | INV-9,13,17 |
| 18 | 应用与数据库网络分区 | — | — | 应用侧认为"我可能仍是owner",但无法验证(无法连接数据库) | — | — | 数据库侧状态不变(无新事务发生) | 不变 | — | — | 应用侧**必须**停止任何"假设自己仍是owner"的副作用行为——网络分区期间应用无法完成`assertOwnerAndFence`,任何试图跳过这一核验的写入都违反INV-6,fail closed的唯一正确姿态是"分区期间不产生任何关键副作用" | 分区恢复后重新查询确认 | — | INV-6,9 |
| 19 | 客户端超时,结果未知 | 同场景16-18 | — | — | — | — | — | — | — | — | — | 否,先查operation_id | 是 | INV-17,18 |
| 20 | 重复operation_id | 已存在一条`(operationId,'ACQUIRE')`审计记录 | 同一调用方重试 | 第二次`INSERT`因唯一约束冲突失败 | — | 第一次的COMMIT(唯一有效的一次) | 与第一次相同 | 与第一次相同 | 仍只有一条(第二次INSERT失败) | — | 调用方捕获唯一约束冲突,转为查询,得到与第一次相同结果 | 是(这正是"安全重试"的定义) | — | INV-17,18 |
| 21 | 不同operation_id重试同一逻辑操作 | 无对应审计记录(调用方误用了新operationId) | — | 会被当作**全新**的一次acquire尝试处理,不是幂等重放 | — | 新的COMMIT(若成功) | 可能与"预期的"不同(例如若第一次其实已经默默成功了,这次会尝试对一个ACTIVE(自己)的行重新acquire,走heartbeat路径而非报错——见流程2"repeated acquire") | 递增(若真的产生了新的acquire事务) | 新增一条 | — | 若调用方本意是"重试同一次意图"但生成了新operationId,语义上等价于"我自愿再发起一次新操作",不构成安全问题但可能不是调用方本意——**这是调用方责任范畴,不是协议本身的漏洞**,协议本身对"新operationId"的处理是完全良定义、安全的,只是不再是"幂等重放"的语义 | 是,但语义是"新操作"而非"重放" | — | INV-17(区分"同operationId幂等"与"新operationId新操作"这两种不同意图) |
| 22 | 旧owner使用旧token写数据库 | ACTIVE(new owner) | 旧owner尝试任意write路径 | `assertOwnerAndFence`核验失败(0行匹配) | — | 无(ROLLBACK) | 不变(new owner) | 不变 | 无 | — | 旧owner收到`FENCING_TOKEN_REJECTED` | 否(旧owner应停止) | — | INV-6 |
| 23 | 旧owner使用旧token写文件 | 同上 | — | 旧owner可以**物理上**完成staging写入(staging本身不需要token核验),但intent-commit事务会失败(同场景22) | — | 无 | — | — | 无 | staging文件成为孤儿,后续被清理 | 旧owner的intent-commit被拒绝,不得继续rename | 否 | — | INV-6,16 |
| 24 | 新owner已取得token后旧owner恢复 | ACTIVE(new) | 旧owner(网络分区恢复/心跳延迟解除) | 旧owner尝试任意fencing校验路径,一律因token不匹配被拒绝 | — | — | new | new的token | — | — | 旧owner后续一切尝试均失败,必须自行停止(应用层应该在收到`FENCING_TOKEN_REJECTED`时终止自己的执行循环,而不是无限重试——这是实施阶段对调用方错误处理的明确要求) | 否 | — | INV-2,6,7 |
| 25 | 文件已写但数据库未发布 | intent-commit未完成或失败 | — | 见场景13类似的staging孤儿情形 | — | — | — | — | `artifact_publications`无记录或`promoted=false`且早已超期 | 文件存在于staging但未被任何权威指针引用 | 消费者不会看到/信任它(消费者只查`promoted=true`记录) | — | — | INV-10,16 |
| 26 | 数据库已发布但文件rename未完成 | `artifact_publications`一条`promoted=false`记录 | 任意持有效token的进程 | 可以安全地代为完成rename+第二次DB确认(第13节"各阶段崩溃恢复"已详述) | — | 第二次UPDATE的COMMIT | — | — | 更新为`promoted=true` | rename完成 | — | 是(幂等) | — | INV-16 |
| 27 | manifest(即`artifact_publications`记录)写入后崩溃 | 同场景26 | — | — | — | — | — | — | — | — | — | 是 | — | INV-13,16 |
| 28 | cleanup与artifact publish并发 | — | 清理程序,发布中的owner | 清理程序的删除条件严格排除"存在任何intent-commit记录（无论promoted与否）引用的content_hash"（第13节清理条件），二者不冲突 | — | — | — | — | — | — | 清理程序不会删除正在发布中的文件 | — | — | 第13节专项设计 |
| 29 | quarantine与artifact publish并发 | ACTIVE(X,进行中的publish) | quarantine企图(误判X为stale) | quarantine判定逻辑本身若正确(基于lease+PID+processStartIdentity)不会在X真实活跃时判定为stale;若判定确实成立(X真的已经停止响应),quarantine成功后X的后续publish步骤(intent-commit或promoted-commit)会因token不匹配被拒绝,与场景22-24同构 | — | — | — | — | — | — | X的publish若在quarantine之后才走到fencing校验:被拒绝(安全,不会产生无效发布);若已经在quarantine**之前**完成了intent-commit+promoted-commit(即真正的、经过校验的publish早已完成):该次发布本身是在X仍持有效token时完成的,合法有效,不受之后quarantine影响(quarantine只影响X**之后**的行为,不追溯撤销X在合法期间内已经完成的发布) | — | — | INV-6,11,16的精确边界(quarantine不追溯撤销之前的合法发布,只阻止之后的) |
| 30 | release与最终状态写入并发 | ACTIVE(X,即将release,同时在写COMPLETED状态) | X自己 | X的最终状态写入(`publishRunStatusUnderFence`)与显式`release`调用若都是X自己发起,顺序由调用方代码决定(应设计为:先完成最终状态发布的完整fencing流程,确认`promoted=true`后,再显式release——这是实施阶段的调用顺序建议,不是协议本身强制,但协议本身对乱序调用也是安全的:若X先release再尝试发布,发布会因fencing失败而被拒绝,X会收到明确错误,不会产生"发布了一个陈旧token的结果"这一后果) | — | — | — | — | — | — | 顺序正确时两者都成功;顺序错误时发布会被拒绝(安全但需要X的调用代码正确处理这一错误,不能忽略) | — | — | INV-6 |
| 31 | 同一run重复调用 | — | 同一调用方连续多次acquire/release | 见流程2"repeated acquire"/流程5"repeated release" | — | — | — | — | — | — | 幂等处理,不产生错误的双重效果 | 是 | — | INV-17 |
| 32 | 不同run并行调用 | 不同`run_identity_sha256`各自的行 | — | 不同主键,天然不互相阻塞(`FOR UPDATE`只锁本行) | — | — | — | — | — | — | 互不影响 | — | — | 所有INV按run identity独立成立 |
| 33 | 数据库时钟跳跃 | — | — | `clock_timestamp()`若跳跃(极端情况,如管理员手动调整服务器时钟或NTP大幅校正),影响`lease_expires_at`比较结果 | — | — | — | — | — | — | 保守分析同上一轮flock报告场景19:方向不确定,但只影响"是否判定为stale"这一**活性**判断,不影响"fencing校验是否通过"这一**安全性**判断(后者是精确值比对,不受时间跳跃影响) | — | — | INV-2,6不受影响;INV-7/8可能受活性(而非安全性)影响,可接受 |
| 34 | sequence出现空洞 | — | — | 本设计**不使用**全局sequence,`fencing_token`是per-run行内`+1`,该值本身若因ROLLBACK而"跳过某次尝试"是正常且安全的(下一次成功的acquire无论如何都会拿到严格大于当前值的新值,空洞不影响单调性,只影响连续性——fencing校验从不要求连续,只要求"等于当前值") | — | — | — | — | — | — | 无影响 | — | — | INV-2(比对的是"相等",不是"连续") |
| 35 | 数据库恢复到旧备份 | 恢复后的表内容是备份时间点的快照,晚于备份时间点的全部acquire/release历史丢失 | — | 恢复后行内`fencing_token`可能"倒退"到一个更早的值,而某些持有**更大**token的进程(在备份之后、故障之前完成过acquire)会发现自己的token反而**大于**行内当前值——本设计的核验条件是"完全相等"(`fencing_token=$token`),不是"大于等于",因此这些进程的fencing校验同样会**失败**(不匹配),它们会被拒绝,不会被误判为仍然有效——**这是安全的**(宁可拒绝原本合法的请求,也不会让一个基于恢复前状态的过期决策被误当作当前有效) | — | — | 备份时间点的最后一个已提交owner | 备份时间点的token | 审计表同样回退到备份时间点(备份之后的审计记录一并丢失,这是数据库备份/恢复的固有性质,不是本协议的缺陷) | — | 所有在故障前、备份后完成过操作的进程,其后续fencing校验全部失败,必须重新走acquire流程 | 否,视为环境异常需要人工评估 | 需要人工核实备份丢失的操作范围(这属于数据库灾难恢复的标准运维流程,超出本协议日常运行范围,如实记录为已知限制) | INV-2(相等比对保证不会误判) |
| 36 | 主从切换 | — | — | 若使用只读副本/主从架构,写入必须严格落在主库;若应用在切换窗口期间错误地对旧主(现为只读或已降级)发起写入,写入本身会失败(只读副本拒绝写入,或旧主已不可达) | — | — | — | — | — | — | 应用应在检测到写入失败时fail closed而非静默降级为"假设成功",与INV-9一致——**本设计未展开主从复制延迟对读取一致性的影响**(如"从库读到的是否是最新值"),因为本方案的全部权威判断(`assertOwnerAndFence`)统一走`FOR UPDATE`,必须落在主库,不允许任何从库参与决策路径,规避了复制延迟带来的一致性问题,但要求实施阶段的连接池配置明确保证这一点(标注为实施阶段配置要求,非本设计的缺陷) | — | — | — | INV-1,2(通过强制单一权威写入点规避复制一致性问题) |
| 37 | PostgreSQL版本不是16 | 本环境现状:仅PG14 | — | 见第20节:启动自检拒绝,不进入任何acquire流程 | — | — | — | — | — | — | 系统整体拒绝启动(fail closed) | — | — | INV-9 |
| 38 | 数据库完全不可用 | — | — | 任何`createGuardedResearchPgPool`调用失败 | — | — | — | — | — | — | fail closed,不进入任何执行 | — | — | INV-9 |
| 39 | B、C、recovery三方竞争 | ACTIVE(B,stale) | B(仍以为自己活跃),C(acquire),R(recovery=acquire) | 三者的写入尝试全部竞争同一行`FOR UPDATE`,PostgreSQL严格串行化;假设R先中签:R读到B为stale,写入ACTIVE(R);B随后任何写入尝试(心跳/发布)因token不匹配被拒绝;C随后尝试acquire,读到ACTIVE(R)非stale,等待/超时 | 单行 | R的COMMIT | R | R的token | 一条ACQUIRE(R) | — | B收到拒绝(良性停止);C等待/超时 | B:否(停止);C:是(可重试) | — | INV-1,2,6,7,12 |
| 40 | 不可fencing的外部副作用仍在进行 | — | — | 审计(第12节)确认本系统**不存在**这类副作用(无子进程、无第三方webhook/外部API发布等)——若未来新增此类副作用且无法设计撤销/暂存/接收方验证token的机制,按第13节要求必须输出该副作用的DESIGN_BLOCKED,本次设计范围内不存在这一情形 | — | — | — | — | — | — | 不适用 | — | — | 不适用(本轮无此类副作用) |

## 17. 崩溃与unknown-outcome恢复矩阵

已完整并入第10节各操作流程表的"commit失败/commit成功但客户端未收到确认/是否允许重试/如何通过operation_id核实"各列，以及第16节场景10-21的逐项分析，不再重复独立成表，避免与已有内容冗余。核心规则概括：**任何不确定性最终都归约为"用operation_id查询审计表/发布记录表得到确定性事实"这一个动作**，不存在需要"猜测"或"假设"的分支。

## 18. 确定性测试矩阵

通用注入点（对应CEO要求的全部位点）：`beforeTxBegin`/`beforeRowLock`/`afterRowLock`/`afterOwnerTokenValidation`/`beforeStateUpdate`/`afterStateUpdate`/`beforeAuditInsert`/`afterAuditInsert`/`beforeCommit`/`afterServerCommitBeforeClientAck`（模拟"commit已发生但客户端未收到确认"，可通过在测试驱动的连接上于`COMMIT`发出后、`await`返回前人为杀死连接模拟）/`afterClientAck`/`beforeSideEffectTokenValidation`/`afterSideEffectTokenValidation`/`afterStagingWrite`/`beforeArtifactPromote`/`afterArtifactPromote`/`beforeCleanup`/`beforeRecoveryTakeover`/`afterRecoveryTakeover`。全部通过真实独立Node子进程+同进程hook组合注入（与上一轮flock设计报告相同的成熟测试基础设施风格），不依赖概率性sleep。

| 测试名称 | 初始DB记录 | 初始审计记录 | 初始文件状态 | 参与进程 | barrier/hook | 固定交错 | SQL/事务范围 | 唯一预期返回值 | 最终owner | 最终token | 最终状态 | 审计行 | artifact状态 | 是否存在执行权 | 允许重试 | 验证的不变量 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| T1 acquire/acquire | RELEASED | — | — | A,B真实子进程 | 无需hook | 见场景1 | 各自独立事务 | 恰一个成功 | 先中签者 | +1 | ACTIVE | 一条ACQUIRE | — | 唯一 | 后者是 | INV-1,12 |
| T2 acquire/release | ACTIVE(X) | 一条ACQUIRE(X) | — | X,A | 无 | 见场景2 | — | 视顺序 | 视顺序 | 视顺序 | — | 新增RELEASE和/或ACQUIRE | — | — | 是 | INV-1,2,11 |
| T3 acquire/quarantine | ACTIVE(Y,stale) | 一条ACQUIRE(Y) | — | Q,A | 无 | 见场景3 | — | — | — | — | — | — | — | — | — | INV-1,12 |
| T4 release/quarantine | ACTIVE(X) | — | — | X,外部 | `beforeStateUpdate`(quarantine侧)确保先完成判定后X的release才提交,验证顺序不影响X release成功 | 见场景4 | — | quarantine:false;X release:true | 无owner | — | RELEASED | 一条RELEASE | — | 无 | 是 | INV-1,11 |
| T5 B无C(旧owner恢复,无第三方) | ACTIVE(new,已取代旧owner B) | — | — | B(迟到心跳) | `afterOwnerTokenValidation`前人为延迟B的请求至new owner已确立后才送达 | B的heartbeat/发布尝试到达时token已不匹配 | — | `FENCING_TOKEN_REJECTED` | new不变 | new不变 | — | 无新增(判定失败不写审计) | — | new | 否(B应停止) | INV-2,6,7 |
| T6 B+C quarantine | ACTIVE(B,stale) | — | — | Q(quarantine),C(acquire) | `afterStateUpdate`(Q侧,尚未COMMIT)人为延迟,验证C必须等待Q的行锁释放才能继续 | 见场景3变体,C必须排在Q之后 | — | Q:true(quarantined);C:成功claim | C | 递增两次(quarantine不递增,acquire递增一次) | ACTIVE(C) | QUARANTINE+ACQUIRE两条 | — | C | — | INV-1,12 |
| T7 B+C release | ACTIVE(X) | — | — | X(release),C(acquire) | 同T6模式 | — | — | C成功 | C | — | ACTIVE(C) | RELEASE+ACQUIRE | — | C | — | INV-1,2 |
| T8 identity read failure(等价:数据库连接失败) | — | — | — | 单进程 | `beforeTxBegin`前断开数据库连接(通过临时修改连接目标为不可达端口模拟) | — | — | 抛`DATABASE_GUARD_CONNECTION_FAILED`等价新错误码 | 不变 | 不变 | — | 无 | — | 无 | 否 | INV-9 |
| T9 owner crash | ACTIVE(new,来自crash owner) | 一条ACQUIRE | — | 真实子进程acquire后`process.exit(77)` | 无需hook | — | — | 崩溃前的acquire事务已提交(可查) | crash owner(直到被下一个acquire取代) | — | — | 一条ACQUIRE | — | 视后续判定 | — | INV-13,14 |
| T10 recovery crash | ACTIVE(R1,来自recovery) | — | — | R1(recovery后崩溃),R2(后续recovery) | R1在`afterStateUpdate`后、`afterAuditInsert`前退出(验证同一事务内二者要么都生效要么都不生效——若R1的进程崩溃发生在同一未提交事务内,PostgreSQL服务端本身会在连接终止时整体回滚,不存在只有UPDATE没有INSERT的中间态) | — | — | — | R2(在staleLockMs后) | — | ACTIVE(R2) | 一条ACQUIRE(R2)(R1若真的崩溃在commit前,不留痕迹) | — | R2 | — | INV-4,13 |
| T11 事务各阶段崩溃点(合并,共6子测试对应6个注入点:beforeRowLock/afterRowLock/afterOwnerTokenValidation/beforeStateUpdate/afterStateUpdate/beforeCommit) | 各异 | — | — | 单/多真实子进程,每个注入点各自令连接被强制断开 | 逐一注入 | — | — | 每种情形下下一个尝试者应能确定性得到唯一合法结果 | — | — | — | — | — | — | — | INV-13 |
| T12 renameat2/flock不可用等价:数据库版本不合格 | — | — | — | 单进程 | 启动自检读取`server_version_num`,构造为非16 | — | — | 拒绝启动,`POSTGRESQL_VERSION_REJECTED` | — | — | — | — | — | — | 否 | INV-9 |
| T13 stale owner | ACTIVE(X,pid存活但process_start_identity不匹配) | — | — | 单进程 | 无 | — | — | 成功接管 | 新 | +1 | ACTIVE(新) | ACQUIRE | — | 新 | — | INV-8 |
| T14 PID reuse | 同上 | — | — | 单进程(模拟复用PID的无关进程) | 无 | — | — | 判定逻辑基于process_start_identity,不受PID巧合影响 | — | — | — | — | — | — | — | INV-8 |
| T15 timeout/unknown outcome | ACTIVE(X) | — | — | A(短超时acquire) | `afterServerCommitBeforeClientAck`模拟连接中断 | — | — | 客户端侧超时/连接错误 | 需查operation_id确认 | — | — | — | — | — | 是(仅同operationId) | INV-17,18 |
| T16 cleanup重入 | `artifact_publications`一条`promoted=false`(intent-commit已完成但promote未完成) | — | staging文件存在 | 单/多进程 | `beforeArtifactPromote`前重复调用promote | — | — | 第二次调用应幂等完成(检测final_path已存在且hash匹配则跳过rename,直接补齐DB确认) | — | — | promoted=true | 一条ARTIFACT_PUBLISH_PROMOTED | 已发布 | — | 是 | INV-16 |
| T17 quarantine和release使用同一生产实现 | — | — | — | 静态断言 | — | — | — | 断言二者共享同一内部`transitionExecutionState`调用,非仅行为相似 | — | — | — | — | — | — | — | INV-15 |
| T18 所有生产入口不可绕过统一状态事务模块 | — | — | — | 静态审计(grep) | — | — | — | 扫描确认除共享内部实现文件外,无其他文件包含对`run_execution_authority`/`run_authority_audit`的直接SQL字符串 | — | — | — | — | — | — | — | INV-3,15 |
| T19 数据库版本门禁 | — | — | — | 单进程 | — | — | — | 见T12 | — | — | — | — | — | — | 否 | INV-9 |
| T20 数据库不可用fail closed | — | — | — | 单进程 | — | — | — | 见T8 | — | — | — | — | — | — | 否 | INV-9 |
| T21 文件状态不能授予执行权 | 任意 | — | 直接在最终路径伪造一个"看起来合法"的文件(不经过staging/DB流程) | 单进程尝试消费 | — | — | — | 消费者查询`artifact_publications`找不到匹配`promoted=true`记录,拒绝该文件 | — | — | — | — | 伪造文件存在但不被信任 | — | — | INV-10,16 |
| T22 旧token的数据库写被拒绝 | ACTIVE(new) | — | — | 持旧token的进程 | — | — | — | `FENCING_TOKEN_REJECTED` | new不变 | — | — | — | — | — | 否 | INV-6 |
| T23 旧token的artifact不被消费者接受 | 见场景25 | — | — | — | — | — | — | 见T21 | — | — | — | — | — | — | — | INV-16 |
| T24 相同operation_id幂等重试 | — | 已有一条对应记录 | — | 同调用方两次调用 | — | — | — | 第二次直接返回第一次结果,不产生新事务效果 | — | — | — | 仍一条 | — | — | 是 | INV-17,18 |
| T25 不同operation_id不得伪装成幂等 | — | 已有一条**不同**operationId的记录 | — | — | — | — | — | 被当作全新操作处理,产生第二条记录 | — | — | — | 两条 | — | — | 是(但语义是新操作) | INV-17 |
| T26 token单调性 | 连续多次acquire | — | — | — | — | — | — | 每次严格大于前一次 | — | 严格递增 | — | — | — | — | — | — |
| T27 token回滚空洞 | 一次acquire尝试因并发冲突ROLLBACK,随后另一次成功 | — | — | — | — | — | — | 成功那次的token值允许不连续(如从5跳到7,中间6对应回滚的尝试) | — | — | — | — | — | — | — | 场景34分析 |
| T28 append-only审计禁止UPDATE/DELETE | — | 任意已有记录 | — | 以应用角色权限尝试UPDATE/DELETE | — | — | — | 数据库拒绝(权限错误,`42501`) | — | — | — | 不变 | — | — | — | INV-5 |
| T29 既有P0-01/P0-02/P1-01/P1-02不回归 | — | — | — | 复用现有测试(D8显示层/D7 artifact防覆盖等与run-status锁协议本身独立的既有保护) | — | — | — | 全部既有断言应无需修改即通过(D7的`renameNoReplace`sidecar防覆盖等既有保护不受本轮改动影响,除非实施阶段确实改动了`artifact-publisher.js`的调用方式——若改动,需要相应更新调用点但不改变其安全语义) | — | — | — | — | — | — | — | 全部既有INV |

## 19. 统一能力边界

```
acquireExecutionAuthority(pool, runIdentitySha256, ownerContext, { leaseTtlMs, operationId })
renewExecutionAuthority(pool, runIdentitySha256, ownerInstanceId, fencingToken, { leaseTtlMs, operationId })   // heartbeat
releaseExecutionAuthority(pool, runIdentitySha256, ownerInstanceId, fencingToken, { operationId })
quarantineExecutionAuthority(pool, runIdentitySha256, staleLockMs, { operationId })
recoverExecutionAuthority === acquireExecutionAuthority   // 别名,非独立实现,见第9节状态机说明
assertCurrentFence(client, runIdentitySha256, ownerInstanceId, fencingToken)   // 供publishXUnderFence内部复用,不单独导出给业务模块
publishRunStatusUnderFence(pool, runIdentitySha256, ownerInstanceId, fencingToken, statusContent, { operationId })
publishArtifactUnderFence(pool, runIdentitySha256, ownerInstanceId, fencingToken, artifactContent, { operationId })
```

**强制手段（回应CEO"不得只依赖字符串相似性证明统一协议"）**：
1. 数据库权限：应用角色对`run_execution_authority`/`run_authority_audit`/`artifact_publications`三张表只被授予通过**存储过程/函数**（或严格审查的、唯一实现文件内的参数化查询）访问的路径——**实施阶段建议**进一步收紧为PostgreSQL端`SECURITY DEFINER`函数封装核心转换逻辑，使得即便应用代码出现bug拼出任意SQL，也无法绕过函数内部的核验逻辑（比"只在JS层收口"更强的边界，供独立复审判断是否纳入实施范围）。
2. CI静态扫描：新增CI步骤，扫描全部生产`.js`/`.mjs`文件，禁止出现`run_execution_authority`/`run_authority_audit`/`artifact_publications`字面表名的SQL字符串，唯一豁免路径是本设计新增的单一共享实现文件。
3. 运行时测试：T17/T18（第18节）在真实数据库连接上验证quarantine与release确实调用同一内部函数、且扫描不到旁路。
4. migration/administrative工具单独授权：任何需要直接操作这三张表的运维工具（如INV-14提到的人工修正）必须使用**独立的数据库角色**（不同于应用角色），该角色的每次使用都要求独立记录（谁、何时、为何），不纳入应用日常运行路径。

（本轮说明：上方第1条"SECURITY DEFINER函数或唯一JS文件二选一"的表述，在后续定向修正轮次中被明确判定为不得保留二选一，已在修正报告P0-5节改为唯一确定的"SECURITY DEFINER受控函数+最小权限应用角色"设计。本文件保留原始版本，不回溯改写。）

## 20. PostgreSQL 16 独立门禁

| 项 | 结果 |
|---|---|
| 当前实际server version | 14.23 (Ubuntu 14.23-0ubuntu0.22.04.1) |
| 当前client version | psql 14.23（同一集群自带） |
| 项目要求版本 | 16（操作性要求，见第2节：不在冻结契约文本内，是独立复审过程持续施加的门禁） |
| PostgreSQL 16是否已安装 | 否——`postgres`/`initdb`二进制均不存在，`/usr/lib/postgresql/`下只有`14` |
| PostgreSQL 16是否实际运行 | 否 |
| 测试数据库是否为PostgreSQL 16 | 否，本环境无法运行PG16测试数据库 |
| CI是否使用PostgreSQL 16 | 本次审计范围内未见CI配置文件声明具体PG版本（不在本轮审计的必要路径内，如需可另行审计`.github/workflows`等，本报告未展开） |
| migration是否在PostgreSQL 16上验证 | 否——本环境从未有机会在PG16上运行过`migrations/*.sql`，包括本设计新提出的`run_orchestration` schema |
| 生产配置是否可能连接到PostgreSQL 14 | 是——`.env.example`未声明版本约束，`research-database-guard.js`当前也**未**校验`server_version`（仅校验库名），这是本设计新增"启动自检读取`server_version_num`并拒绝非16"的动机来源，弥补现状空白 |
| 版本不符时的错误码与fail-closed行为 | **本设计新增建议**：`RESEARCH_DATABASE_VERSION_REJECTED`，在`createGuardedResearchPgPool`建立连接后紧接着执行`SHOW server_version_num`（或`SELECT current_setting('server_version_num')`），非精确匹配16.x主版本号即拒绝，连接需被关闭（复用`research-database-guard.js`已有的"校验失败必须关闭已建立连接"模式） |

**结论**：`POSTGRESQL_16_NON_SKIP_RESULT: MISSING`。不得执行本设计涉及的任何migration；不得宣称Batch7可实施；不得启动180天正式研究。这与本轮设计报告的产出（一份未经验证的设计）完全一致——**本设计报告本身不构成"已在PG16上验证"的证据**，第21节实施影响清单中的migration/schema变更全部标注为"未来实施阶段需要在真实PostgreSQL 16环境完成，本报告不改变这一前提"。

（本轮说明：后续定向修正轮次中新增了对CI workflow文件的实际审计，发现`v1-4c-postgres16-lifecycle-validation.yml`等已声明`image: postgres:16`——补充事实，不改变本节MISSING结论。）

## 21. 实施影响清单

| 类别 | 预计变更 |
|---|---|
| production files | 新增共享实现（`server/src/db/run-authority.js`或类似，承载`acquireExecutionAuthority`等）；`research-run-status.js`大部分文件级函数（quarantine/acquire/release相关）预计**移除**，替换为对新实现的调用；`formal-research-orchestrator.js`/`artifact-publisher.js`的写入调用点改为`publishRunStatusUnderFence`/`publishArtifactUnderFence`；`d8-status-reader.js`及dashboard相关消费者需要迁移为查询`artifact_publications`（见第12节完整性边界声明，这是范围较大的一块工作，需要独立评估） |
| database migration | 新增一份migration（如`008_v1_4d_run_orchestration_authority.up/down.sql`），创建`run_orchestration` schema+三张表+索引+权限GRANT/REVOKE |
| schema/table/index/constraint | 见第8节完整DDL |
| transaction helper | 复用/扩展`PostgresRepository`风格的`transaction(work, ...)`包装，或新建专属的`withExecutionAuthorityTransaction` |
| connection pool | 复用现有`createGuardedResearchPgPool`，新增启动时`server_version_num`校验 |
| error codes | 新增`FENCING_TOKEN_REJECTED`（已在`postgres.js`的`assertLease`场景中先例存在，此处沿用同名语义扩展到run authority场景）、`RESEARCH_DATABASE_VERSION_REJECTED`、`RUN_AUTHORITY_OPERATION_ID_CONFLICT`（唯一索引冲突时的分类错误） |
| configuration | `.env`新增/复用`DATABASE_URL`指向研究库；无需新增额外配置项（复用既有guard机制） |
| heartbeat/lease | `leaseTtlMs`作为调用参数，默认值建议与现有`staleLockMs`（30秒）保持数量级一致，具体数值留待实施阶段结合真实运行时checkpoint间隔评估 |
| recovery | 无独立代码（=acquire），见第9节 |
| audit | `run_authority_audit`表+CI/权限强制的append-only |
| artifact publication | 见第13节完整three-phase协议，`artifact_publications`表 |
| side-effect consumers | **需要单独立项**：`d8-status-reader.js`、任何dashboard/CLI读取D7 artifact或run-status的路径，全部需要改为"先查数据库指针" |
| test files | `research-run-status-concurrency.test.js`绝大部分内容需要重写为数据库集成测试（依赖真实PostgreSQL，不再是纯文件系统单测）；新增`run-authority-fencing.integration.test.js`等对应第18节测试矩阵 |
| CI | 新增静态扫描步骤（第19节强制手段2）；PostgreSQL集成测试门禁需要在CI环境提供真实PG16（当前CI配置是否已经是PG16超出本轮审计范围，需要实施阶段单独确认） |
| deployment | 需要在部署流程中加入migration执行步骤，并确保生产/研究库版本为PostgreSQL 16 |
| rollback strategy | migration本身提供`.down.sql`；应用层回滚需要谨慎处理"回滚后旧的文件锁协议是否还能正确识别数据库侧遗留的状态"——**建议**：回滚窗口内不产生新的run-status活动，或提供一次性数据迁移脚本把数据库状态"投影"回文件锁能理解的格式（如需要，属于实施阶段的详细设计，本报告只标注需求，不展开具体脚本） |
| compatibility strategy | 见下方"如何从旧状态文件协议迁移" |
| legacy lockPath retirement | 见下 |
| operational runbook | 需要新增：如何解读`run_authority_audit`审计记录、如何执行INV-14描述的人工治理动作 |

**特别说明（CEO明确要求）**：

- **如何从旧状态文件协议迁移**：不建议"渐进式双写"（同时维护文件锁和数据库权威——这正是CEO明确禁止的"数据库状态与文件状态两套真相"，第20节禁止事项第11条）。建议**一次性切换**：选定一个部署窗口，确认当时没有任何正在进行中的run（`run_execution_authority`表初始为空，或从现有文件系统扫描出的"当前活跃run列表"一次性导入为初始行，全部标记为`RELEASED`/`FAILED`视具体情况，不还原为`ACTIVE`——即迁移窗口内不尝试"恢复"任何进行中的run的执行权，只是把它们的存在记录下来供审计参照），此后所有`acquireResearchRunStatusLock`等旧函数的生产调用点被替换为新函数，旧文件锁代码整体移除（不是保留一个开关切换，那本身就会制造双重真相）。
- **迁移期间如何避免双重真相**：唯一安全做法是"迁移窗口内暂停新acquire请求，完成代码替换后再放行"——这天然要求一次短暂的停机/维护窗口（见下条）。
- **是否需要一次性停机门禁**：**是**——本报告明确建议需要，理由是避免双写期间任何窗口出现"文件说A拥有执行权，数据库说B拥有执行权"的分裂状态，这与本轮禁止事项第11条"不得形成数据库owner和文件owner两套真相"直接对应。
- **旧代码何时彻底禁止写lockPath**：切换完成后立即从代码库移除，不保留可通过配置重新启用的路径（否则"回滚可能重新启用不安全协议"，见下条）。
- **回滚是否可能重新启用不安全协议**：若旧代码被物理移除（而非配置开关关闭），回滚需要`git revert`到旧commit才能重新获得旧代码——这是**故意设计**，比"配置开关"更安全，因为配置开关容易被误操作意外打开，而代码级移除要求一次明确的、可审查的revert操作。
- **数据库schema回滚如何保留审计证据**：`.down.sql`不应该物理`DROP TABLE run_authority_audit`（即使是"回滚"场景，审计数据本身仍有价值）——建议`.down.sql`只回滚`run_execution_authority`/`artifact_publications`（这两张是"当前状态"表，回滚可接受），审计表建议保留或改为`RENAME TO run_authority_audit_archived_{date}`而非删除，具体策略留待实施阶段结合数据保留政策确定。

## 22. 32个关键问题（逐项是/否+理由）

1. **PostgreSQL是否是唯一所有权真相源？** 是——`run_execution_authority`表的已提交内容是判断执行权的唯一依据（INV-10）。
2. **文件状态是否完全不能授予执行权？** 是——全部核验路径只读数据库（INV-10证明），文件仅作为content-addressed负载存储。
3. **acquire、release、quarantine、heartbeat、recovery是否都使用同一事务协议？** 是——共享`assertOwnerAndFence`+同一张状态表+同一套`SELECT...FOR UPDATE`模式（recovery非独立路径）。
4. **状态转换与审计是否同事务提交？** 是（INV-4）。
5. **审计记录是否append-only且不会被下一次acquire覆盖？** 是——数据库权限强制（GRANT/REVOKE）+ INV-5证明。
6. **每次重新授予所有权是否产生更大的fencing token？** 是——per-run行内`fencing_token+1`，严格单调（对"更大"的证明依赖"相等比对"而非"连续"，见场景34分析，回滚空洞不破坏单调性）。
7. **PID是否不是唯一身份？** 是——身份是`owner_instance_id`（UUID）+`fencing_token`的组合；PID/host/processStartIdentity只用于quarantine阶段的活性判定，不用于fencing核验（INV-8）。
8. **PID reuse是否不会导致错误接管？** 是（INV-8证明；quarantine判定层面的残余限制与现有`processStartIdentity`机制一致，非新增缺口）。
9. **lease是否基于数据库时间？** 是——全部使用`clock_timestamp()`，不使用应用服务器本地时钟（第8节DDL、第10节流程）。
10. **lease到期是否不会单独绕过fencing？** 是（INV-7证明——lease过期只放开"允许他人尝试"，不单独剥夺旧owner在真正被取代前的fencing校验通过资格）。
11. **所有数据库关键副作用是否验证token？** 是——本系统当前无独立于run authority之外的数据库写副作用（第4节审计确认），run authority自身的写入即是fencing机制本体。
12. **所有文件关键副作用是否能被有效fencing？** 是——通过第13节outbox两阶段发布协议，前提是生产者侧统一收口+消费者侧迁移（第12节已明确标注这一完整性依赖，非隐藏假设）。
13. **所有外部关键副作用是否能被有效fencing？** 不适用——第4节/第12节审计确认本系统当前**没有**外部副作用消费者（无webhook、无第三方API发布、无子进程），故不构成需要额外设计的类别。
14. **是否存在任何不能验证token的关键副作用？** 否——第12节逐项清单确认全部关键副作用（数据库/文件两类）均可被fencing覆盖。
15. **如果存在，是否明确报告DESIGN_BLOCKED？** 不适用（第14问已回答"否"，未触发该条件）。
16. **旧owner恢复后是否无法提交有效结果？** 是——旧owner的任何后续fencing校验（无论数据库写入还是文件intent-commit/promoted-commit）都会因token不匹配被拒绝（INV-6/16）。
17. **commit结果未知时是否通过operation_id核对，而不是盲目重试？** 是——第10/11/16节反复强调的核心纪律，且有数据库唯一索引作为兜底强制（INV-17/18）。
18. **数据库不可用时是否fail closed？** 是（INV-9，复用`createGuardedResearchPgPool`已验证的fail-closed实现）。
19. **PostgreSQL版本不是16时是否fail closed？** 是——本设计新增启动自检（第20节），非16即拒绝启动。
20. **PostgreSQL 16是否仍是实施前独立必要门禁？** 是（第20节结论）。
21. **是否支持跨进程？** 是——数据库事务天然跨进程。
22. **是否支持跨主机？** 是——只要多主机共享同一PostgreSQL实例，这是相对上一轮flock方案（仅限单机本地文件系统）的关键能力提升，尽管本系统当前实际部署是否需要跨主机不在本轮审计范围内。
23. **两个recovery是否无法同时授予两个owner？** 是（INV-12）。
24. **状态文件被任意替换是否不影响数据库所有权？** 是（INV-10；文件从不参与执行权判断，第21节T21测试专门验证伪造文件不被信任）。
25. **B的完整证据是否被永久保留？** 是——`original_record`+`original_record_hash`字段在每次转换前捕获完整快照，append-only表永久保留（INV-5/6）。
26. **下一次acquire后是否仍能查询B的证据？** 是——审计表按`run_identity_sha256`+`committed_at`索引，历史记录不因后续acquire而不可查询。
27. **artifact消费者是否拒绝旧token产物？** 是——**前提**是消费者确实迁移为查询`artifact_publications`联表条件（第12/13节反复强调的完整性依赖，第21节已列为独立实施事项，不是自动生效的）。
28. **是否消除了数据库与文件的双重真相？** 是——设计层面消除（文件从不参与真相判断，第13节outbox模式的核心目的）；**实施层面**取决于第21节"一次性切换、不保留双写窗口"这一迁移策略被严格执行，本报告已明确该前提不是自动满足的。
29. **是否需要修改冻结契约？** **否，但需要独立复审明确确认一项架构判断**：契约文本本身不强制"运行遥测必须是纯文件系统"（这是`research-run-status.js`文件头注释记录的**设计选择**，不是契约条文的直接要求——契约条文只规定行为性质，不规定实现介质，参见上一轮flock设计报告第3节同样的结论），本设计把执行权真相从文件迁移到PostgreSQL，技术上不与契约条文冲突；但这**确实**改变了"正式研究能否在完全没有可用PostgreSQL的环境下至少启动/记录一次尝试"这一运行时前提（从"可以"变为"不可以，因为PostgreSQL现在是启动的硬依赖"）——这是一个**产品/运维层面的可用性范围变化**，建议独立复审在批准实施前明确知悉并认可这一变化，即使它不要求改写契约文字本身。
30. **如果需要修改冻结契约，是否停止而不自行修改？** 是——本设计报告未修改契约（第2节确认哈希不变），且已在第29问中明确不需要修改契约文字；若独立复审认为第29问的架构判断实质上超出了契约原意、必须先修改契约条文才能继续，本报告承诺**停止**，不自行修改。
31. **当前是否仍禁止写代码？** 是——本轮全程只读，未修改任何生产/测试代码（第4节审计+全程`git status`确认）。
32. **当前是否仍禁止180天正式研究？** 是——PostgreSQL 16门禁未通过（第20节），且本设计本身尚未获批准进入实施，180天正式研究、GO/NO_GO发布继续被禁止。

## 23. 未解决风险

1. **消费者侧迁移的完整性无法仅靠本设计报告自证**（第12节已明确标注）：D8 status reader、dashboard、任何人工诊断脚本，只要有一个继续直接信任D7文件路径而不查`artifact_publications`，INV-16在那个消费者身上就会失效。这不是设计缺陷，是"设计正确性"与"实施完整性"之间的边界——建议实施阶段把"消费者审计+迁移"作为与"生产者fencing实现"同等优先级的独立验收项，而不是隐含在"顺便做一下"里。
2. **一次性停机迁移窗口的运维可行性**未在本报告评估（超出DESIGN-ONLY范围，需要运维/产品侧确认可接受的维护窗口）。
3. **主从复制/连接池在多主机部署下的具体拓扑**未展开（第16节场景36已标注为实施阶段配置要求），若未来确实需要跨主机部署，需要专项设计连接路由确保写入严格落在主库。
4. **PostgreSQL 16在本环境完全不可用**，本设计的全部SQL/DDL从未在真实PostgreSQL 16环境执行过，不能排除16特有的行为差异（虽然本设计刻意只使用长期稳定的标准特性，未使用16专属新特性，但"从未实测"本身就是残余风险，需要在PG16环境可用后作为实施第一步验证）。
5. **`SECURITY DEFINER`函数封装**（第19节强制手段1的"建议进一步收紧"部分）是否纳入实施范围尚未决定，若不采纳，INV-3/15的强制力相应减弱为"CI扫描+代码审查"级别而非"数据库层面绝对拒绝"级别，这是一个需要独立复审明确取舍的权衡点。

（本轮说明：风险1、5在后续定向修正轮次中已被处理——消费者清单在P0-1完成完整枚举，权限方案在P0-5确定为唯一的"SECURITY DEFINER+最小权限角色"，不再是待定项。风险2/3/4仍然成立，未在修正轮次中处理，因为它们不属于独立复审当时列出的六项阻塞范围。）

## 24. 最终结论

**DESIGN_READY_FOR_REVIEW**

未触发DESIGN_BLOCKED——第4/12节审计确认本系统当前不存在无法fencing的关键副作用类别；第13节证明artifact发布协议能够保证旧token产物不被消费者接受（前提明确标注，非隐藏假设）；第15节18条不变量均给出构造性证明；未发现必须修改冻结契约才能实施的情形。第23节列出的5项未解决风险均是"需要实施阶段验证/决策"性质，不是"设计层面无法证明安全"性质，故不满足第21节规定的DESIGN_BLOCKED触发条件。

## 25. 声明

本轮工作全程只读：未修改任何生产代码；未修改任何测试代码；未修改任何数据库（未连接到任何数据库执行写操作，`research-database-guard.js`等模块均通过静态代码阅读完成审计，未发起任何实际数据库连接尝试）；未修改冻结契约；未创建、amend或改写任何git commit；未merge；未push；未生成bundle；未启动180天正式研究。`git status`在设计工作前后保持一致的干净状态，HEAD始终为`239302eb48311882ea2f3fa2a4bd227b2b767b64`，冻结契约SHA-256始终为`5369742b33867d5b6870a7f9148246cd12fe5ae5b90a770f2474cc66e0610b42`。

现停止，等待独立协议复审。未经明确批准，不开始实施阶段的任何代码/schema修改。
