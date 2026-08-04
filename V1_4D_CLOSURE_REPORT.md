# ETH Alpha V1.4D 工程收尾封存报告

状态日期：2026-08-04
封存基线：`main@3b88589e801945fddc170a7f15c265fd79f9f3db`

## 1. 封存结论与边界

V1.4D的基础设施和代码闭环已经完成。本结论表示当前代码库已经具备受治理的历史数据回填、Dataset Manifest V1/V2、多symbol Manifest、历史Feature输入、历史回放与验证、研究数据库身份门禁及持续集成验收能力。

本封存不表示180天推荐窗口的正式历史研究已经执行，不表示任何研究成绩或交易结论已经产生，也不授权V1.5、生产部署、自动交易或任何生产数据库操作。130天为不推荐的严格最低窗口，仅用于pipeline smoke test，不满足正式历史研究要求；365天仅是可选的长周期稳健性升级窗口。

## 2. 已完成的工程能力

| 领域 | 封存状态 | 当前仓库证据 |
|---|---|---|
| Dataset Manifest V1 | 保持兼容 | `server/src/validation-replay/dataset-manifest-builder.js`、`dataset-manifest-verifier.js`及既有回归测试 |
| Dataset Manifest V2与多symbol治理 | 已实现并合入main | `V1_4D_MULTI_SYMBOL_MANIFEST_ADDENDUM.md`、Migration 007、`dataset-manifest-v2.js`、`dataset-manifest-verifier-v2.js`及R28测试 |
| 成员与内容哈希绑定 | 已实现并合入main | `compareCanonicalV2ManifestMembers()`及真实PostgreSQL成员替换回归测试 |
| 历史market bar回填 | 工程路径已具备 | `server/src/backfill/`、相关单元及PostgreSQL集成测试 |
| 历史Feature Backfill | 工程路径已具备 | `server/src/features/historical-feature-backfill.js`及相关单元、PostgreSQL集成测试 |
| 历史回放、Outcome与验证报告 | 工程路径已具备 | `server/src/validation-replay/`及离线、PostgreSQL测试 |
| 研究数据库治理 | 已实现并合入main | `research-database-guard.js`、Manifest inventory CLI、单元与真实PostgreSQL拒绝路径测试 |
| CI治理 | 本封存变更完成触发范围闭环 | `.github/workflows/v1-4d-full-verification.yml`覆盖所有以`main`为base的普通PR，并保留手动触发、冻结文档保护和PostgreSQL阻断性验收 |

## 3. 合并与不可变基线

- PR #20（Multi-Symbol Manifest实现及修复）已通过merge commit `3fc3309dffa2d7e15e21969ca19478488cf6a005`进入`main`。
- PR #21（Manifest inventory数据库身份治理）已通过merge commit `3b88589e801945fddc170a7f15c265fd79f9f3db`进入`main`。
- 五份draft-4冻结文档保持未修改：
  - `V1_4D_DATA_BACKFILL_SPEC.md`
  - `V1_4D_HISTORICAL_REPLAY_SPEC.md`
  - `V1_4D_CODEX_IMPLEMENTATION_TASK.md`
  - `V1_4D_ACCEPTANCE_TESTS.md`
  - `V1_4D_ARCHITECTURE_REVIEW.md`
- Migration 001–007在本次封存中保持未修改。
- 本次封存没有修改任何生产代码、Manifest算法、Dataset Version算法、Feature查询、API契约或ETHUSDT默认行为。

## 4. 验证证据口径

当前仓库包含覆盖Manifest V1/V2、R28、PostgreSQL集成、Historical Feature Backfill、validation-replay、Forecast、API和server回归的自动化测试及CI命令。PR #20和PR #21已经合入的结论以各自通过的代码复审和CI为工程证据；本封存分支只验证错误码治理文档、workflow触发/保护语义、轻量验收及禁止范围零diff。

任何因当前执行环境缺少安全隔离PostgreSQL而未在本地重新运行的数据库测试，必须记为`NOT_RUN`或`skip`，不得由本报告改写为本地通过。工程验证使用的7/90天回放和130天严格最低窗口pipeline smoke test均不得替代180天推荐窗口的正式历史研究数据与成绩。

## 5. 尚未开始或尚未授权

| 项目 | 状态 |
|---|---|
| 130天严格最低窗口pipeline smoke test | `NOT_FORMAL_RESEARCH` |
| 180天推荐窗口正式历史研究 | `NOT_STARTED` |
| 365天长周期稳健性升级 | `OPTIONAL_NOT_STARTED` |
| 正式研究结论与成绩单 | `NOT_PRODUCED` |
| V1.5 | `NOT_AUTHORIZED` |
| 生产部署 | `NOT_AUTHORIZED` |
| 自动交易 | `NOT_AUTHORIZED` |
| 生产数据库读写或Migration | `NOT_AUTHORIZED` |

冻结治理状态：

```text
FORMAL_180_DAY_RESEARCH_STATUS = NOT_STARTED
FORMAL_180_DAY_RESEARCH_AUTHORIZED = NO
V1_5_AUTHORIZED = NO
PRODUCTION_DEPLOYMENT_AUTHORIZED = NO
AUTOMATIC_TRADING_AUTHORIZED = NO
```

## 6. 封存语义

“V1.4D工程基础设施完成”仅表示受版本、数据血缘、Manifest、数据库身份和CI门禁约束的实现基础已闭环。它不等于策略有效性已经被180天推荐窗口的正式历史研究证明，不构成投资建议、上线批准或自动交易授权。任何后续180天正式历史研究、可选365天稳健性升级、V1.5设计或生产操作都需要新的、明确的授权与独立验收。
