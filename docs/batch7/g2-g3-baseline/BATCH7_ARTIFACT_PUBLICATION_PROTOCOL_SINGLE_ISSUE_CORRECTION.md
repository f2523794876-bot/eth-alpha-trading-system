# Batch7 Artifact Publication Protocol — 单点问题修正报告（第二轮：commitArtifactPublication 两处阻塞修正）

范围：仅修正 `commitArtifactPublication` 内部的 ledger 调用顺序（阻塞1）与 fencing/promoted 判断顺序（阻塞2），以及与之直接相关的恢复规则、竞争分析、测试矩阵、前后结论。`registerArtifactUnderFence`、DDL、`publication_id`/`register_operation_id`/`promote_operation_id` 身份模型本身（上一轮已确认正确）不改变。不涉及 execution authority、lease、takeover、PostgreSQL 16 环境、180天研究门槛、冻结契约或其他协议。

环境核验（只读）：HEAD `239302eb48311882ea2f3fa2a4bd227b2b767b64`，git status 干净，冻结契约 SHA-256 `5369742b33867d5b6870a7f9148246cd12fe5ae5b90a770f2474cc66e0610b42`（未变）。

## 1. 本轮唯一问题的精确定义

独立定向复审确认上一轮修正（`publication_id`/`register_operation_id`/`promote_operation_id` 拆分）本身正确，但发现 `commitArtifactPublication` 伪代码存在两处独立的、彼此不依赖的阻塞：

**阻塞1（ledger调用顺序不可执行）**：伪代码在尚未获得真实 `run_identity_sha256` 之前就调用 `ledgerBeginOrInspect(promoteOperationId, runIdentitySha256=null, 'ARTIFACT_PROMOTE', requestHash)`，而 `operation_ledger.run_identity_sha256` 是 `NOT NULL` 列——这个调用本身在到达数据库之前就已经不满足其目标表的列约束，不存在"先插入 NULL、稍后补写"这种退路（`NOT NULL` 约束在 `INSERT` 语句执行的那一刻就会被数据库拒绝，没有"稍后补写"的合法窗口）。

**阻塞2（判断顺序颠倒导致旧token可产出成功记录）**：伪代码原顺序是"先检查 `pubRow.promoted=true` 分支 → 若已发布则直接把本次 `promoteOperationId` 标记为 `COMMITTED` 返回成功 → 之后才做 fencing 核验"。这意味着：一个已经失效（旧）的 `fencingToken`，只要构造一个**全新**的 `promoteOperationId` 对一个**已经被合法新 owner promote 过**的 `publicationId` 发起调用，会在从未经过任何 fencing 核验的情况下，被记成一次"成功"的 `ARTIFACT_PROMOTE` ledger 记录——这直接违反"promote 前必须重新验证当前 ownership 和 fencing_token"这一贯穿全部报告的核心要求。

## 2. 原协议为何必然失败（两处阻塞各自的失败机制）

**阻塞1**：`ledgerBeginOrInspect` 是全部幂等操作（`ARTIFACT_REGISTER`/`ARTIFACT_PROMOTE`/execution authority 侧的 `ACQUIRE`/`HEARTBEAT`/`RELEASE`/`QUARANTINE`）共用的同一入口，其对 `operation_ledger` 的写入（无论是新建 `PENDING` 行还是后续状态转换）都必须满足该表既有的 `NOT NULL` 约束。`run_identity_sha256` 在 `commitArtifactPublication` 的入参里从未直接提供（调用方只知道 `publicationId`/`ownerInstanceId`/`fencingToken`/`promoteOperationId`/`expectedContentHash`），必须从 `artifact_publications` 表中反查才能得到——但反查这张表本身，在上一轮的伪代码里被安排在 `ledgerBeginOrInspect` **之后**（因为定位 `artifact_publications` 行的逻辑此前被写在业务事务内部）。这是一个纯粹的**执行顺序**错误，不是逻辑设计错误：需要的数据在调用点尚未被读取。

**阻塞2**：`pubRow.promoted=true` 分支在原伪代码中被安排为**第一个**判断分支，出现在 fencing 核验（`authRow` 查询）**之前**。这意味着：只要 `artifact_publications` 行已经是 `promoted=true`（无论是谁、用什么 token 促成的），任何后来者——包括一个早已失去合法性的旧 owner，只要它构造一个全新的 `promoteOperationId`——都会在完全跳过 fencing 核验的情况下走到"承认既成事实、ledger 记为 COMMITTED"这条路径。这产生一个可被观察、可被审计工具误读为"该 owner 曾经成功执行过一次 ARTIFACT_PROMOTE"的记录，即使它从未真正持有过合法执行权——这正是本报告体系反复强调的"旧 token 不得产出任何形式的成功副作用记录"这一底线要求的直接违反。

## 3. 修正后的字段和约束

本轮**不修改**任何表结构、任何列、任何 CHECK 约束——`artifact_publications`（`publication_id`/`register_operation_id`/`fencing_token_at_register`/`promote_operation_id`/`fencing_token_at_promote`/`content_hash`/`staging_path`/`final_path`/`promoted`/`promoted_at`/`ap_promoted_field_consistency` CHECK）与 `operation_ledger`（含其 `run_identity_sha256 NOT NULL` 约束）均维持上一轮已确认正确的定义不变。本轮修正的**只是函数内部的执行顺序**，不是数据模型。

新增两个应用层错误码（不涉及 schema 变更，纯粹是函数返回值的分类）：

- `ARTIFACT_PUBLICATION_IDENTITY_DRIFT`：事务内以 `FOR UPDATE` 重读得到的 `run_identity_sha256` 与用于 `ledgerBeginOrInspect` 调用的值不一致时触发。本设计中 `run_identity_sha256` 在 `INSERT` 之后永不 `UPDATE`，正常运行下此分支不可达；触发即视为协议不变量被破坏（数据篡改或严重实现 bug），必须中止，不得静默继续。
- （沿用上一轮已定义、未修改）`ARTIFACT_PUBLICATION_NOT_FOUND`、`ARTIFACT_CONTENT_HASH_MISMATCH`、`FENCING_TOKEN_REJECTED`、`OPERATION_ID_PAYLOAD_MISMATCH`。

## 4. `publication_id`、`register_operation_id`、`promote_operation_id`、`content_hash`、`fencing_token` 各自的唯一语义

（与上一轮完全一致，未修改，此处完整重述以保持本报告自包含）

- **`publication_id`**：命名"这一次具体的、从 register 到 promote 的发布尝试"本身。由调用方在发起 register 之前生成（`randomUUID()`），全流程唯一识别该次发布意图，是 register 与 promote 之间**唯一**允许用于定位记录的关联键。不参与 ledger 幂等判定。
- **`register_operation_id`**：命名"这一次调用 `registerArtifactUnderFence` 的幂等尝试"。对同一 `register_operation_id` 的重复调用（相同载荷）必须幂等返回同一结果。
- **`promote_operation_id`**：命名"这一次调用 `commitArtifactPublication` 的幂等尝试"。与 `register_operation_id` 完全独立，允许在 register 之后的任意时间、由任意持有效 token 的进程生成一个全新值发起。**本轮强调**：一个"全新的" `promote_operation_id` 不代表调用方自动获得任何特权——它仍然必须在业务事务内重新通过 fencing 核验才能产生任何有意义的结果（无论是"完成发布"还是"确认既成状态"）。
- **`content_hash`**：register 时确定并写入的、该次发布内容的 sha256，promote 时被要求重新提供并核对一致，全流程不可变。
- **`fencing_token`**：拆分为 `fencing_token_at_register`（永久历史事实）与 `fencing_token_at_promote`（真正完成发布那一次核验通过的值，只在"本次调用真正完成发布"时被写入，"确认既成状态"的调用**不会**改写它）。

## 5. 修正后的 DDL 完整片段（与上一轮相同，未修改，完整重述保持自包含）

```sql
CREATE TABLE run_orchestration.artifact_publications (
  publication_id              uuid PRIMARY KEY,
  run_identity_sha256           text NOT NULL
                                 CONSTRAINT ap_run_identity_format CHECK (run_identity_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_kind                   text NOT NULL CHECK (artifact_kind IN ('RUN_STATUS','D7_ARTIFACT')),
  owner_instance_id                 uuid NOT NULL,

  register_operation_id               uuid NOT NULL
                                       CONSTRAINT ap_register_op_unique UNIQUE
                                       REFERENCES run_orchestration.operation_ledger(operation_id),
  fencing_token_at_register             bigint NOT NULL CHECK (fencing_token_at_register >= 0),

  promote_operation_id                   uuid
                                         REFERENCES run_orchestration.operation_ledger(operation_id),
  fencing_token_at_promote                 bigint CHECK (fencing_token_at_promote IS NULL OR fencing_token_at_promote >= 0),

  content_hash                              text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  staging_path                               text NOT NULL,
  final_path                                  text NOT NULL,

  registered_at                                timestamptz NOT NULL DEFAULT clock_timestamp(),
  promoted                                      boolean NOT NULL DEFAULT false,
  promoted_at                                    timestamptz,

  CONSTRAINT ap_promoted_field_consistency CHECK (
    (promoted = false AND promote_operation_id IS NULL
                       AND fencing_token_at_promote IS NULL
                       AND promoted_at IS NULL)
    OR
    (promoted = true AND promote_operation_id IS NOT NULL
                      AND fencing_token_at_promote IS NOT NULL
                      AND promoted_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX ap_promote_op_unique_idx
  ON run_orchestration.artifact_publications(promote_operation_id)
  WHERE promote_operation_id IS NOT NULL;

CREATE INDEX ap_run_kind_promoted_idx
  ON run_orchestration.artifact_publications(run_identity_sha256, artifact_kind, promoted, promoted_at DESC);

CREATE VIEW run_orchestration.current_valid_artifacts AS
SELECT DISTINCT ON (run_identity_sha256, artifact_kind)
  publication_id, run_identity_sha256, artifact_kind, content_hash, final_path,
  owner_instance_id, register_operation_id, promote_operation_id,
  fencing_token_at_register, fencing_token_at_promote, promoted_at
FROM run_orchestration.artifact_publications
WHERE promoted = true
ORDER BY run_identity_sha256, artifact_kind, promoted_at DESC;
```

`operation_ledger` 的既有定义（含 `run_identity_sha256 text NOT NULL`）不在本轮修改范围内，也**未**被本轮任何改动削弱或绕过——本轮的修正恰恰是让调用方在到达该约束之前，先合法地准备好一个满足约束的真实值。

## 6. `registerArtifactUnderFence` 完整伪代码（与上一轮相同，未修改，完整重述保持自包含）

```
function registerArtifactUnderFence(pool, runIdentitySha256, ownerInstanceId, fencingToken,
                                     publicationId, registerOperationId,
                                     artifactKind, contentHash, stagingPath, finalPath):

  requestPayload = canonicalJson({
    operationType: 'ARTIFACT_REGISTER', runIdentitySha256, publicationId,
    ownerInstanceId, fencingToken, artifactKind, contentHash, stagingPath, finalPath
  })
  requestHash = sha256(requestPayload)

  ledgerState = ledgerBeginOrInspect(registerOperationId, runIdentitySha256,
                                      'ARTIFACT_REGISTER', requestHash)
  match ledgerState.case:
    PAYLOAD_MISMATCH:
      throw OPERATION_ID_PAYLOAD_MISMATCH
    ALREADY_COMMITTED:
      return ledgerState.resultPayload
    ALREADY_PENDING:
      return reconcileOperationOutcome(registerOperationId)
    FRESH_OR_ABORTED_RETRYABLE:
      pass

  BEGIN TRANSACTION

    authRow = SELECT * FROM run_execution_authority
              WHERE run_identity_sha256 = runIdentitySha256
                AND owner_instance_id   = ownerInstanceId
                AND fencing_token       = fencingToken
                AND state = 'ACTIVE'
              FOR UPDATE

    IF authRow IS NULL:
      UPDATE operation_ledger SET status='ABORTED', aborted_at=clock_timestamp()
        WHERE operation_id = registerOperationId
      COMMIT TRANSACTION
      throw FENCING_TOKEN_REJECTED

    INSERT INTO artifact_publications (
      publication_id, run_identity_sha256, artifact_kind, owner_instance_id,
      register_operation_id, fencing_token_at_register,
      content_hash, staging_path, final_path, promoted
    ) VALUES (
      publicationId, runIdentitySha256, artifactKind, ownerInstanceId,
      registerOperationId, fencingToken,
      contentHash, stagingPath, finalPath, false
    )
    # 主键冲突 -> ARTIFACT_PUBLICATION_ID_COLLISION（不静默吞掉）

    resultPayload = { publicationId, fencingTokenAtRegister: fencingToken }
    UPDATE operation_ledger SET status='COMMITTED', result_payload=resultPayload,
      committed_at=clock_timestamp() WHERE operation_id = registerOperationId

  COMMIT TRANSACTION
  return { publicationId, registered: true }
```

## 7. `commitArtifactPublication` 完整伪代码（本轮修正核心）

```
function commitArtifactPublication(pool, publicationId, ownerInstanceId, fencingToken,
                                    promoteOperationId, expectedContentHash):

  # ============================================================================
  # STEP 0：只读预查询（不加锁），先于任何 ledger 操作，目的仅为取得 run_identity_sha256。
  #         这是阻塞1的修正点：绝不在没有真实 run_identity_sha256 的情况下调用
  #         ledgerBeginOrInspect（operation_ledger.run_identity_sha256 是 NOT NULL）。
  # ============================================================================
  precheck = SELECT run_identity_sha256 FROM artifact_publications
             WHERE publication_id = publicationId

  IF precheck IS NULL:
    # 不得为一个不存在的 publication 创建任何 ledger 行——不存在"无归属"的
    # ARTIFACT_PROMOTE 记录。直接返回，不触碰 operation_ledger。
    throw ARTIFACT_PUBLICATION_NOT_FOUND

  runIdentitySha256 = precheck.run_identity_sha256

  # ============================================================================
  # STEP 1：用刚取得的真实 run_identity_sha256 执行 ledger 幂等前置检查。
  # ============================================================================
  requestPayload = canonicalJson({
    operationType: 'ARTIFACT_PROMOTE', publicationId,
    ownerInstanceId, fencingToken, expectedContentHash
  })
  requestHash = sha256(requestPayload)

  ledgerState = ledgerBeginOrInspect(promoteOperationId, runIdentitySha256,
                                      'ARTIFACT_PROMOTE', requestHash)
  match ledgerState.case:
    PAYLOAD_MISMATCH:
      throw OPERATION_ID_PAYLOAD_MISMATCH
    ALREADY_COMMITTED:
      # 同一 promoteOperationId 的完全相同重试——直接返回历史终态结果，
      # 不重新执行任何业务逻辑，不重新核验fencing（该次操作的裁决已经终态化于过去）。
      return ledgerState.resultPayload
    ALREADY_PENDING:
      return reconcileOperationOutcome(promoteOperationId)
    FRESH_OR_ABORTED_RETRYABLE:
      pass   # 进入下方业务事务

  # ============================================================================
  # STEP 2 起：业务事务。以下每一步顺序固定，不得重排——这是阻塞2的修正点：
  # fencing 核验（STEP 4）必须先于 promoted 状态判断（STEP 6）执行，
  # 对任何"全新的" promoteOperationId 无条件适用。
  # ============================================================================
  BEGIN TRANSACTION

    # STEP 2：以 FOR UPDATE 重新读取——不信任 STEP 0 的非加锁读结果，
    #         这是唯一的权威存在性判据（覆盖"预查询后、加锁前记录被删除"的理论情形）。
    pubRow = SELECT * FROM artifact_publications
             WHERE publication_id = publicationId
             FOR UPDATE

    IF pubRow IS NULL:
      UPDATE operation_ledger SET status='ABORTED', aborted_at=clock_timestamp()
        WHERE operation_id = promoteOperationId
      COMMIT TRANSACTION
      throw ARTIFACT_PUBLICATION_NOT_FOUND

    # STEP 3：重新确认事务内读到的 run_identity_sha256 与 STEP 1 使用的值完全一致。
    #         本设计中该列 INSERT 后永不 UPDATE，正常运行下不可能不一致；
    #         触发即视为不变量被破坏，必须中止。
    IF pubRow.run_identity_sha256 != runIdentitySha256:
      UPDATE operation_ledger SET status='ABORTED', aborted_at=clock_timestamp()
        WHERE operation_id = promoteOperationId
      COMMIT TRANSACTION
      throw ARTIFACT_PUBLICATION_IDENTITY_DRIFT

    # STEP 4：核验当前 ownership 和 fencing_token —— 必须先于 STEP 6 的 promoted
    #         状态判断执行，对 pubRow.promoted 为 true 或 false 都无条件适用。
    authRow = SELECT * FROM run_execution_authority
              WHERE run_identity_sha256 = runIdentitySha256
                AND owner_instance_id   = ownerInstanceId
                AND fencing_token       = fencingToken
                AND state = 'ACTIVE'
              FOR UPDATE

    IF authRow IS NULL:
      # 无论 pubRow 当前是否已经 promoted，旧/无效 token 在这里被无条件拒绝——
      # 不产生 promote 成功、不覆盖任何既有字段、不返回 ALREADY_PROMOTED、
      # ledger 该次尝试标记 ABORTED（不是 COMMITTED）。
      UPDATE operation_ledger SET status='ABORTED', aborted_at=clock_timestamp()
        WHERE operation_id = promoteOperationId
      COMMIT TRANSACTION
      throw FENCING_TOKEN_REJECTED

    # STEP 5：fencing 通过后（调用方已证明是当前合法 owner），才校验 content_hash。
    IF pubRow.content_hash != expectedContentHash:
      UPDATE operation_ledger SET status='ABORTED', aborted_at=clock_timestamp()
        WHERE operation_id = promoteOperationId
      COMMIT TRANSACTION
      throw ARTIFACT_CONTENT_HASH_MISMATCH

    # STEP 6：fencing 与 content_hash 都通过后，才判断是否已经 promoted。
    IF pubRow.promoted = true:
      # "本次操作确认既成状态"——不是"本次操作完成了发布"。
      # 不覆盖 promote_operation_id / fencing_token_at_promote / promoted_at 任一字段。
      resultPayload = {
        publicationId, promoted: true, alreadyPromoted: true,
        promotedBy: pubRow.promote_operation_id,        # 真正完成发布的原 operation_id
        confirmedByOperationId: promoteOperationId       # 本次仅确认，未改变任何状态
      }
      UPDATE operation_ledger SET status='COMMITTED', result_payload=resultPayload,
        committed_at=clock_timestamp() WHERE operation_id = promoteOperationId
      COMMIT TRANSACTION
      return { publicationId, promoted: true, promotedByThisCall: false, alreadyPromoted: true }

    # STEP 7：尚未 promoted，且本次调用已合法通过 fencing 与 content_hash 校验——
    #         真正完成发布，本次是"完成了发布"，不是"确认既成状态"。
    UPDATE artifact_publications SET
      promoted = true,
      promoted_at = clock_timestamp(),
      promote_operation_id = promoteOperationId,
      fencing_token_at_promote = fencingToken
    WHERE publication_id = publicationId

    resultPayload = { publicationId, promoted: true, promotedByThisCall: true }
    UPDATE operation_ledger SET status='COMMITTED', result_payload=resultPayload,
      committed_at=clock_timestamp() WHERE operation_id = promoteOperationId

  COMMIT TRANSACTION
  return { publicationId, promoted: true, promotedByThisCall: true }
```

**顺序为何是唯一正确的顺序**：STEP 0→1 解决阻塞1（数据可用性必须先于 ledger 调用）；STEP 2→3 解决"预查询与加锁读之间的证据陈旧"问题（不信任非加锁读，独立于 STEP 0 重新裁决）；STEP 4 必须先于 STEP 6（解决阻塞2）——因为 STEP 6 的分支（无论走"确认既成状态"还是"完成发布"）都会导致 ledger 记录为 `COMMITTED`，而"COMMITTED 的 ARTIFACT_PROMOTE 记录"本身就是一种需要被 fencing 保护的、有意义的执行结果证据——只要 STEP 6 在 STEP 4 之前，就存在"未经 fencing 核验产出 COMMITTED 记录"的可能，这正是阻塞2的本质，因此 STEP 4 必须是 STEP 6 严格的前置条件，中间不能插入任何会导向 `COMMITTED` 状态的分支。

## 8. register 与 promote 的 ledger payload 定义（与上一轮相同，未修改）

```json
// ARTIFACT_REGISTER
{
  "operationType": "ARTIFACT_REGISTER",
  "runIdentitySha256": "<64 hex>",
  "publicationId": "<uuid>",
  "ownerInstanceId": "<uuid>",
  "fencingToken": <bigint>,
  "artifactKind": "RUN_STATUS | D7_ARTIFACT",
  "contentHash": "<64 hex>",
  "stagingPath": "<string>",
  "finalPath": "<string>"
}
```

```json
// ARTIFACT_PROMOTE
{
  "operationType": "ARTIFACT_PROMOTE",
  "publicationId": "<uuid>",
  "ownerInstanceId": "<uuid>",
  "fencingToken": <bigint>,
  "expectedContentHash": "<64 hex>"
}
```

`ARTIFACT_PROMOTE` 的载荷本轮未新增字段——`runIdentitySha256` 虽然现在需要在调用 `ledgerBeginOrInspect` 前被取得（STEP 0/1），但它是从 `publicationId` **派生**的只读事实，不是调用方独立提供的输入，因此不需要也不应该参与 `requestHash` 的计算（参与计算会导致同一 `promoteOperationId` 因为"派生值"而非"调用方输入"的差异被误判为载荷冲突，这本身会是一个新的、不必要的脆弱点，本轮设计刻意避免）。

## 9. 幂等重试和载荷冲突处理

| 场景 | 处理 |
|---|---|
| 同一 `register_operation_id`，完全相同载荷，重试 | `ALREADY_COMMITTED` → 直接返回，不重新 `INSERT` |
| 同一 `register_operation_id`，载荷不同 | `OPERATION_ID_PAYLOAD_MISMATCH`，无写入 |
| 同一 `promote_operation_id`，完全相同载荷，重试 | `ALREADY_COMMITTED` → 直接返回历史结果（STEP 1），**不重新执行 STEP 2-7**，不重新核验 fencing |
| 同一 `promote_operation_id`，载荷不同 | `OPERATION_ID_PAYLOAD_MISMATCH` |
| **（本轮修正）** 全新 `promote_operation_id`，`pubRow.promoted` 当前为 `false` | 必须先通过 STEP 4 fencing 核验才能到达 STEP 7 完成发布；fencing 不通过则 STEP 4 直接 `ABORTED`，不产生任何 promote 成功记录 |
| **（本轮修正）** 全新 `promote_operation_id`，`pubRow.promoted` 当前已为 `true` | 必须**同样**先通过 STEP 4 fencing 核验才能到达 STEP 6 的"确认既成状态"分支；fencing 不通过则在 STEP 4 直接 `ABORTED`，**绝不会**因为"反正已经 promoted 了"而跳过 fencing、直接返回 `ALREADY_PROMOTED` 成功——这正是阻塞2修正前后的关键区别 |

## 10. fencing_token 失效时的处理

- **register 阶段**：`authRow IS NULL` → ledger `ABORTED`，抛 `FENCING_TOKEN_REJECTED`，不创建 `artifact_publications` 行（与上一轮一致，未改变）。
- **promote 阶段（本轮修正后的行为）**：无论 `pubRow.promoted` 是 `true` 还是 `false`，STEP 4 的 `authRow IS NULL` 都会立即导致：
  1. `operation_ledger` 该次尝试标记 `ABORTED`（不是 `COMMITTED`）；
  2. 抛出 `FENCING_TOKEN_REJECTED`；
  3. `artifact_publications` 行的任何字段（含 `promoted`/`promote_operation_id`/`fencing_token_at_promote`/`promoted_at`）保持不变，**不会**因为这次被拒绝的尝试而产生任何写入。
- 两个阶段的核验完全独立：register 时持有效 token 不代表 promote 时依然有效（可能已被后续 acquire 取代）——这是既有设计，本轮未改变，只是修正了 promote 阶段"先核验 fencing、再判断 promoted 状态"这一执行顺序上的 bug。

## 11. register成功但promote未知或失败时的恢复规则

- **promote 从未尝试**（register 成功后 owner 直接崩溃）：`artifact_publications` 行保持 `promoted=false`。任意后续持有效 token 的进程可以直接调用 `commitArtifactPublication(publicationId, ..., 一个全新的 promoteOperationId, expectedContentHash)`——STEP 0-7 天然正确处理这一情形，STEP 4 会验证调用方当前是否持有效 token，通过后 STEP 7 完成发布。
- **promote 已尝试但结果未知**（调用方发出 `COMMIT` 后连接中断）：调用方必须先用**原** `promoteOperationId` 调用 `reconcileOperationOutcome`（复用既有 P0-2 规则，未修改）：
  - ledger 显示 `COMMITTED` → 直接采用该结果（可能是 `promotedByThisCall:true` 也可能是 `alreadyPromoted:true`，取决于当时业务事务实际走到 STEP 6 还是 STEP 7）。
  - ledger 显示 `ABORTED` → 可安全用**同一** `promoteOperationId` 重新调用（会重新完整走一遍 STEP 0-7，包括重新核验 fencing——这也是本轮修正后新增的重要性质：即使是"重试"，只要走到全新业务事务，fencing 就会被重新核验，不存在"因为是重试所以跳过 fencing"的路径）。
  - ledger 仍是 `PENDING` 超过合理阈值 → 按 P0-2 规则直接查询业务表本身（`SELECT promoted, promote_operation_id, fencing_token_at_promote FROM artifact_publications WHERE publication_id=$1`）判定真实结果，修复 ledger 行状态，不产生第二次语义操作。
- 若换成一个**全新** `promoteOperationId` 直接重试（不做 reconcile）：**本轮修正后的关键保证**——即使此时该 publication 早已被别人（也可能是自己更早一次成功的尝试）合法 promoted，这次全新调用仍然**必须先通过 fencing 核验**才能到达 STEP 6 确认既成状态；若调用方此时持有的 token 已经不是当前有效 token（例如它自己也已经被更后来的 owner 取代），会在 STEP 4 被拒绝，**不会**产出任何形式的"成功"记录——消除了"旧 owner 可以用一个新 operation_id 蹭到一次成功记录"的可能性。

## 12. 两个owner竞争同一publication时的处理

场景：owner A（`fencing_token=5`）完成 register 后，B 成为新的当前 owner（`fencing_token=6`）。以下逐一分析 A、B 对同一 `publicationId` 调用 `commitArtifactPublication` 的全部时序组合：

1. **B 先合法 promote 成功，A 随后（用全新 `promoteOperationId`）尝试**：A 到达 STEP 4 时，`authRow` 查询条件里的 `fencing_token=5` 已经不匹配 `run_execution_authority` 当前值（`6`）→ `authRow IS NULL` → STEP 4 直接 `ABORTED` + `FENCING_TOKEN_REJECTED`。**A 从未到达 STEP 6，不会看到、也不会产出 `ALREADY_PROMOTED`**——这是本轮修正相对上一轮的核心行为差异（上一轮里 A 会在这一情形下错误地拿到一次"成功"记录）。
2. **A 先到达 STEP 2-3（拿到行锁、确认身份一致），但在 STEP 4 之前 B 已经完成了自己的 promote**：A 的 STEP 4 查询读到的是 B 完成后的最新 `run_execution_authority` 行（`fencing_token=6`），A 的 `fencing_token=5` 依旧不匹配 → 同上，`ABORTED` + `FENCING_TOKEN_REJECTED`。
3. **A 先拿到 `artifact_publications` 行的 `FOR UPDATE` 锁并试图 promote（此时 B 尚未接管，A 的 token 仍然有效）**：A 正常走完 STEP 4-7，成功 promote，`fencing_token_at_promote=5`。之后 B 接管、B 也调用 `commitArtifactPublication`：B 的 STEP 4 用自己的 `fencing_token=6` 核验，通过（因为此刻它才是当前值）；STEP 6 发现 `pubRow.promoted=true`（A 已完成）→ B 走"确认既成状态"分支，`resultPayload.promotedBy` 指向 A 的 `promote_operation_id`，**不覆盖**任何既有字段。
4. **当前合法 owner（假设就是 B，token=6）自己用一个新的 `promoteOperationId` 再次调用，且此时 publication 已经是自己更早一次调用促成的 `promoted=true`**：STEP 4 fencing 核验通过（B 依然是当前 owner）；STEP 6 发现已 promoted → 返回 `ALREADY_PROMOTED`，`promotedBy` 指向 B 自己更早那次的 `promote_operation_id`。这是"当前合法 owner 确认既成状态"的正常情形，不是竞争，但同样必须先过 fencing（本轮修正后对**所有**全新 `promoteOperationId` 无差别适用，无论调用方是不是"看起来仍然合法"）。

**结论**：无论旧 token 的尝试早于还是晚于合法 promote 到达，STEP 4 fencing 核验作为 STEP 6/7 的无条件前置条件，保证旧 token **永远不会**在 `operation_ledger` 中留下一条 `status='COMMITTED'` 的 `ARTIFACT_PROMOTE` 记录——它能留下的只有 `ABORTED`。`artifact_publications` 该行最终恰好被**一次**真正合法的 promote 尝试改变，`promote_operation_id` 唯一确定地指向那一次。

## 13. 正式消费者完整读取条件（与上一轮相同，未修改）

```sql
SELECT * FROM run_orchestration.current_valid_artifacts
WHERE run_identity_sha256 = $1 AND artifact_kind = $2;
```

条件：`promoted = true`（由 `ap_promoted_field_consistency` 约束保证内部一致）；`content_hash` 全程不可变；取该 `(run_identity_sha256, artifact_kind)` 组合下 `promoted_at` 最新一条；未引入撤销/失效机制（继承既有设计，非本轮范围）。消费者角色只被授予对 `current_valid_artifacts` 视图的 `SELECT` 权限，不接触底层表、staging 目录、`register_operation_id`、`promote_operation_id` 或 pathname。

## 14. 设计级测试矩阵

### 14.1 沿用上一轮、行为不变的场景（简述，完整定义见上一轮报告，不重复）

首次register成功；相同register重试；register operation_id载荷冲突；首次promote成功（当前无竞争、无既成状态时，STEP 4→7 正常路径）；相同promote重试；promote operation_id载荷冲突；register完成但未promote；消费者尝试读取未发布artifact。

### 14.2 本轮新增/修正的场景（直接对应两处阻塞与复审要求的4个补充测试点）

| # | 场景 | 初始状态 | 操作 | 预期结果 |
|---|---|---|---|---|
| N1 | **新owner先成功promote，旧owner随后用新promoteOperationId调用** | publication 已被当前 owner（token=6）合法 promote；调用方持有旧 token（=5） | 用**全新** `promoteOperationId` + 旧 token 调用 `commitArtifactPublication` | STEP 4 `authRow IS NULL` → `ABORTED` + `FENCING_TOKEN_REJECTED`；`artifact_publications` 行不变；ledger **无** `COMMITTED` 记录产生于本次调用（这是阻塞2的直接回归测试） |
| N2 | **当前合法owner对已promoted publication使用新promoteOperationId确认状态** | publication 已被同一（或另一合法）当前 owner promote；调用方持有**当前有效**token | 用全新 `promoteOperationId` 调用 | STEP 4 通过 → STEP 6 → 返回 `{promoted:true, promotedByThisCall:false, alreadyPromoted:true}`，`resultPayload.promotedBy` 指向原 `promote_operation_id`；`artifact_publications` 行的 `promote_operation_id`/`fencing_token_at_promote`/`promoted_at` 均**未被覆盖** |
| N3 | **相同原promoteOperationId的正常幂等重试** | 场景N2（或首次promote成功）已发生 | 用**同一** `promoteOperationId`+相同参数再次调用 | STEP 1 `ALREADY_COMMITTED` → 直接返回原 `resultPayload`，**不进入STEP 2-7**，不重新核验fencing，不产生新的数据库写入 |
| N4 | **publication预查询后、业务事务加锁前记录被删除或改变的处理** | STEP 0 预查询时 publication 存在（返回 `runIdentitySha256`），但在 STEP 2 的 `FOR UPDATE` 执行前该行被移除（本设计当前无生产删除路径，此为纯防御性测试，通过测试专用 hook 在 STEP 1 与 STEP 2 之间人为删除该行来构造） | 继续调用流程 | STEP 2 `pubRow IS NULL` → ledger `ABORTED` + `ARTIFACT_PUBLICATION_NOT_FOUND`，不依赖 STEP 0 的陈旧证据继续执行任何后续逻辑 |
| N5（阻塞1回归） | **ledger调用发生在run_identity_sha256可用之后** | 全新 `publicationId`（不存在） | 直接调用 `commitArtifactPublication` | STEP 0 `precheck IS NULL` → 立即 `throw ARTIFACT_PUBLICATION_NOT_FOUND`，**验证 `operation_ledger` 中未产生任何该 `promoteOperationId` 对应的行**（不存在的publication不得创建无归属ledger记录） |
| N6（阻塞1回归） | **事务内run_identity_sha256一致性核验** | 通过测试专用 hook，在 STEP 1 与 STEP 2 之间修改（若测试环境允许的防御性构造）或模拟 `pubRow.run_identity_sha256` 与 STEP 0 读到的值不同 | 继续调用流程 | STEP 3 检测到不一致 → ledger `ABORTED` + `ARTIFACT_PUBLICATION_IDENTITY_DRIFT`，不继续执行 STEP 4 及之后任何逻辑 |
| N7 | **两个owner竞争，旧token在合法promote"之前"到达但被后来者超越** | A（token=5）持有 `artifact_publications` 行锁准备 promote，尚未到达 STEP 4；B（token=6）已成为当前owner | A 到达 STEP 4 | `authRow IS NULL`（此刻权威值已是6）→ A 被拒绝，与 N1 结论一致，不因"先来后到"而获得豁免 |
| N8 | **旧owner在合法promote"之后"到达（原始复审示例场景）** | 与 N1 相同，验证时序覆盖"之后"这一具体措辞 | 同 N1 | 同 N1，确认"之前"与"之后"两种到达顺序结论一致，无时序依赖的漏洞 |

## 15. 修复前后协议对照（本轮：commitArtifactPublication 内部顺序）

| 维度 | 本轮修正前（上一轮交付版本） | 本轮修正后 |
|---|---|---|
| `ledgerBeginOrInspect` 调用时机 | 在拿到真实 `run_identity_sha256` **之前**调用，传入 `null`，违反 `operation_ledger.run_identity_sha256 NOT NULL` | 先做只读预查询（STEP 0）取得真实值，再调用（STEP 1）——顺序上可执行 |
| publication不存在时的ledger影响 | 未明确定义前置检查，可能在业务事务内才发现不存在，此前已经尝试用 `null` 调用ledger | STEP 0 直接短路返回，**不创建任何ledger行** |
| run_identity_sha256一致性 | 无校验 | STEP 3 在事务内以 `FOR UPDATE` 重读后强制核验，防止陈旧/篡改数据被使用 |
| fencing核验 vs promoted状态判断的顺序 | 先判断 `promoted=true`（STEP对应旧版更早分支），后核验fencing——旧token可能在从未被核验的情况下拿到"成功"记录 | fencing核验（STEP 4）严格前置于promoted状态判断（STEP 6），对任何全新 `promoteOperationId` 无差别适用 |
| 旧token对已promoted publication的行为 | 错误地返回成功（`ALREADY_PROMOTED`风格结果），且ledger记为`COMMITTED` | 在STEP 4被无条件拒绝，`FENCING_TOKEN_REJECTED`，ledger记为`ABORTED`，不产生任何成功语义的记录 |
| "确认既成状态"与"完成发布"的区分 | 未做区分，两者都可能被笼统地当作"promote成功" | `promotedByThisCall:true`（STEP 7，真正完成）与`promotedByThisCall:false, alreadyPromoted:true`（STEP 6，仅确认）显式区分 |

## 16. 本轮是否完全消除了已确认的两处阻塞

**是。**

- **阻塞1**：`ledgerBeginOrInspect` 现在只在 STEP 1 被调用，此时 `runIdentitySha256` 已经在 STEP 0 通过一次独立的只读查询确定为真实、非空值——不再存在"用 `null` 调用一个要求 `NOT NULL` 的接口"这一不可执行的语句。`operation_ledger.run_identity_sha256 NOT NULL` 约束全程未被修改、未被绕过、未被延后满足——它在每一次实际写入时都已经拿到了合法值。
- **阻塞2**：fencing 核验（STEP 4）现在无条件地位于 promoted 状态判断（STEP 6）之前，对"全新的 `promoteOperationId`"这一类别（不区分 `pubRow.promoted` 当前是 `true` 还是 `false`）统一适用。旧/无效 token 无法再通过"目标已经被promote过"这一事实绕过核验——它会在 STEP 4 被直接拒绝，产出的 ledger 记录状态是 `ABORTED` 而不是 `COMMITTED`。

## 17. 是否发现该单点修复自身引入新的直接矛盾

**否。** 逐项复核：

- STEP 0 的非加锁预查询与 STEP 2 的加锁重读之间可能出现的数据陈旧（N4 场景），已通过"STEP 2 独立、权威地重新判断存在性，不依赖 STEP 0 结果"这一设计原则完全吸收，不产生依赖陈旧数据做出错误裁决的路径。
- STEP 3 的一致性核验只可能因不变量被破坏而触发（正常运行下不可达），不影响任何正常路径的行为，是纯粹的防御性加固，不引入新的正常路径分支复杂度。
- fencing 核验前置（STEP 4 先于 STEP 6）没有改变 STEP 4 本身的核验逻辑（仍是既有的 `assertOwnerAndFence` 等价查询），只是调整了它相对 STEP 6 的先后顺序，不引入新的核验条件或新的表访问。
- "确认既成状态"（STEP 6）与"完成发布"（STEP 7）的显式区分，只是让 `resultPayload`/返回值携带更精确的信息，不改变 `artifact_publications` 表本身可能出现的状态集合（仍然只有 `promoted=false` 与 `promoted=true` 两种，且转换只能通过 STEP 7 一条路径发生）。
- 幂等边界（`register_operation_id`/`promote_operation_id` 各自独立）、竞争场景下的行锁串行化、消费者读取条件，均未被本轮改动触及，与上一轮的证明保持一致。

未发现新的阻塞性矛盾。

## 18. 最终结论

**ARTIFACT_PROTOCOL_CORRECTION_READY_FOR_REVIEW**

## 19. 明确声明

本轮工作全程只读+文档撰写：未修改任何生产代码；未修改任何测试代码；未修改任何数据库；未执行任何migration；未修改冻结契约；未重新设计execution authority、lease或takeover；未处理PostgreSQL 16环境问题；未处理180天样本门槛；未修改本轮范围以外的任何协议；未创建commit；未merge；未push；未生成bundle；未启动180天正式研究；未重新宣称整个Batch7或G1–G3已经通过（本报告结论仅限于本轮定义的`commitArtifactPublication`内部两处阻塞本身）。`git status`全程干净，HEAD始终为`239302eb48311882ea2f3fa2a4bd227b2b767b64`，冻结契约SHA-256始终为`5369742b33867d5b6870a7f9148246cd12fe5ae5b90a770f2474cc66e0610b42`。

现停止，等待独立定向复审。
