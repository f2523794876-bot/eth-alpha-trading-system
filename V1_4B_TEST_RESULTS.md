# ETH Alpha V1.4B 测试结果

测试日期：2026-07-21（Asia/Shanghai）
分支：`codex/v1.4b-feature-engine-foundation`  
基线：`3b997ee2baddc95ecf3712d533700ecc9b539855`

## 自动化测试

| 测试组 | 通过 | 失败 | 环境阻塞 |
|---|---:|---:|---:|
| V1.4B特征/时间/质量/lineage/幂等/API/保留策略 | 36 | 0 | 0 |
| V1.4A既有服务器非联网回归 | 110 | 0 | 0 |
| **服务器非联网合计** | **146** | **0** | **0** |
| V1.1–V1.4浏览器端非联网回归 | 1,354 | 0 | 0 |
| **全部已执行非联网自动化** | **1,500** | **0** | **0** |
| V1.4A真实PostgreSQL 14生产集成（既有CI证据） | 13 | 0 | 0 |
| V1.4B真实PostgreSQL特征集成（本机） | 0 | 0 | 4（无TEST_DATABASE_URL） |

V1.4B 36项覆盖54项字段、收益/EMA/ATR/成交量/结构/衍生品/BTC/多周期、1h/4h未来bar、资金费率发布时间、OI as-of、BTC对齐、未收盘目标、lineage未来引用、null协议、四级质量、稳定ID、DEDUPED/REVISED、版本隔离、过期fencing、生产FeatureEngine路径、dry-run、resume、动态readiness边界、90天遥测清理、只读API，以及003迁移/生产as-of SQL/原子fencing写入静态检查。本轮新增两项多空比契约回归：合法Binance十进制字符串通过；缺失、无前导零或非数字字段继续返回`LONG_SHORT_INVALID`。

真实PostgreSQL 4项测试直接使用 `PostgresRepository`和 `FeatureEngine`，覆盖003 up/down/up表结构、合法全市场多空比经生产标准化后写入`long_short_ratios`、真实JSONB特征与lineage写读、同输入DEDUPED、源数据修订后追加feature revision、无孤儿引用和过期fencing拒写。它们没有使用MemoryRepository替代；本机因无隔离数据库明确SKIP，已加入PostgreSQL 14 CI强制门禁。

## PostgreSQL 14 CI故障修复记录

失败HEAD `7de62a4a14f61866957da314eca0c27a8bf2954e` 的4项V1.4B PostgreSQL测试均在共享`before`种子阶段以`LONG_SHORT_INVALID`退出，未进入测试主体。精确原因是fixture写成`longAccount: '.52'`、`shortAccount: '.48'`；生产契约要求与Binance正式响应一致的十进制字符串`'0.52'`、`'0.48'`。本次只修正fixture并增加写库断言，没有修改`normalizeLongShort()`、时间红线、未来数据防泄漏、fencing或数据库约束。

修复后本机执行服务器非联网146项、浏览器非联网1,354项和真实REST 110项均0失败。PostgreSQL 17项因本机没有`TEST_DATABASE_URL`明确SKIP；其中V1.4A 13项已有CI真实通过，V1.4B 4项必须以本提交推送后的PostgreSQL 14强制门禁结果为准，本文不把本机SKIP记为PASS。

## 真实公开REST

| 测试组 | 通过 | 失败 | 状态 |
|---|---:|---:|---|
| V1.4B Binance公开数据→as-of特征生产链 | 1 | 0 | PASS |
| V1.4A服务器时间、六路现货与永续公开数据 | 9 | 0 | PASS |
| V1.1–V1.4既有真实REST | 100 | 0 | PASS |
| **本机真实REST合计** | **110** | **0** | **PASS** |
| REST+PostgreSQL真实链 | 0 | 0 | 本机无隔离PostgreSQL；既有GitHub Runner可能精确451，届时只能记EXTERNAL_REGION_BLOCKED |

V1.4B真实链使用当前Binance服务器时间、ETH/BTC三周期现货、资金费率、OI、多空比和taker flow；所有来源在生成前按目标已收盘15m时点过滤，54项特征生成成功，lineage全部满足sourceTime不晚于目标bar且availableAt不晚于asOfTime。

## 构建与安全

- 单文件HTML连续构建两次：SHA-256均为 `fe969b5d76cbecb4a19b47093ee698f12d38bbf01e0fd36b50dc1add3ac2c5c8`；正式HTML与构建产物一致。
- `v1-core.js` SHA-256：`edc36248440cd53443b798a9aa5ad769904b986068172ecc4590aafbe486ed00`，未修改。
- `v1_2-forecast-core.js` SHA-256：`5cd29546ceae417c816bf7056c9fe4ddfc434548be90d1f2679fdb11f1dc250e`，未修改。
- `recordSignalIfEligible`、`evaluateShadowSignals`、`buildTradeProposal`、`tickAutoEngine`、`processTradeGate`在 `server/src`直接调用数全部为0。
- 真实PostgreSQL、真实REST与人工验收口径分离；没有把SKIP或环境阻塞写成PASS。

## 结论

当前可执行的非联网1,500项与真实REST 110项均0失败。V1.4A PostgreSQL 13项已有CI真实通过；V1.4B 4项的hook根因已修复并等待本提交触发PostgreSQL 14 CI重新执行。未部署服务、未连接生产数据库、未接入真实交易。

初始实现提交为 `8a7e0112f98308ea95e7e76018bf6a1b9ebf8580`；本轮CI fixture修复提交以Git最终记录为准。没有创建PR、合并main或创建Release。
