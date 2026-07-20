# ETH Alpha V1.4A 测试结果

测试日期：2026-07-20（Asia/Shanghai）
分支：`codex/v1.4a-server-data-foundation`  
基线：`93d9feddab7d0fba01a87d7ea7e14355bf5868d3`

## 自动化测试口径

| 测试组 | 通过 | 失败 | 环境阻塞 |
|---|---:|---:|---:|
| V1.4A离线/Memory/静态约束/HTTP/API行为 | 110 | 0 | 0 |
| V1.4A真实PostgreSQL 14生产仓库集成（`8505f81`第二轮CI） | 13 | 0 | 0 |
| V1.4A真实PostgreSQL生产仓库集成（本机） | 0 | 0 | 13（本机无TEST_DATABASE_URL；CI证据单列） |
| **V1.4A新增非联网已执行合计** | **110** | **0** | **13** |
| V1.1–V1.4既有非联网回归 | 1,354 | 0 | 0 |
| **全部已执行非联网自动化** | **1,464** | **0** | **13** |

V1.4A 110项已执行覆盖此前103项，并新增7项CI分层回归：451精确分类、仅451可转环境阻塞、429/500/超时/JSON错误保持失败、服务器时间守卫fail-closed且保留脱敏451状态、SKIP与PASS分离、PostgreSQL强制门禁独立，以及非451真实链仍调用生产 `CollectorService`与 `PostgresRepository`路径。

数据库迁移测试说明：`8505f81321de21032236da963b180c542e9938fa`第二轮CI已经在真实 PostgreSQL 14中执行13项生产集成测试并全部通过，关闭首轮K线与点状事实写入缺陷。其后的3项REST+PostgreSQL测试因GitHub托管Runner访问Binance收到精确HTTP 451而失败；这是外部地区可达性限制，不是否定前置数据库门禁，也不能表述为真实链通过。本轮将两个阶段拆为独立Job，并只允许精确451显示 `EXTERNAL_REGION_BLOCKED`/SKIP。

## 真实公开 REST

| 测试组 | 通过 | 失败 | 结果 |
|---|---:|---:|---|
| V1.4A Binance服务器时间与六路现货生产标准化 | 7 | 0 | 时间偏差守卫通过；ETH/BTC × 15m/1h/4h均产生已收盘正式事实 |
| V1.4A ETH/BTC永续公开数据组合 | 2 | 0 | 永续K线、资金费率、OI、多空比、主动买卖量均HTTP 200且字段有效 |
| **V1.4A真实REST** | **9** | **0** | **通过** |
| V1.4A真实REST + PostgreSQL生产落库（本机） | 0 | 0 | 3项SKIP：本机无隔离PostgreSQL |
| V1.4A真实REST + PostgreSQL生产落库（`8505f81` CI） | 0 | 3 | HTTP 451；真实链未完成，不能记为通过 |
| V1.4A真实REST + PostgreSQL生产落库（本修复CI语义） | 0 | 0 | 精确451时为 `EXTERNAL_REGION_BLOCKED`，等待推送复验 |
| V1.1–V1.4既有真实REST回归 | 100 | 0 | 八个既有联网测试文件全部通过 |
| **全部真实REST** | **109** | **0** | **通过** |

真实REST形状/Normalizer、PostgreSQL 14生产集成与真实REST+PostgreSQL端到端严格分开记录。前者109项本机通过；数据库13项已有CI实机通过证据；真实链3项在 `8505f81`因HTTP 451未完成。本修复后451只会成为醒目的环境阻塞SKIP，429、500、超时、JSON、数据库或结果不完整仍失败。在可访问Binance的Runner上，三项仍必须使用真实响应写入真实测试PostgreSQL并完成原断言。

## 构建与静态安全

- 既有单文件构建执行两次，SHA-256均为 `fe969b5d76cbecb4a19b47093ee698f12d38bbf01e0fd36b50dc1add3ac2c5c8`。
- 正式 `eth-dynamic-trading-dashboard.html` 与构建产物一致，未产生差异。
- `v1-core.js` SHA-256为 `edc36248440cd53443b798a9aa5ad769904b986068172ecc4590aafbe486ed00`，本分支未修改。
- 五个真实交易入口在 `server/` 中调用数为0：`recordSignalIfEligible`、`evaluateShadowSignals`、`buildTradeProposal`、`tickAutoEngine`、`processTradeGate`。
- V1.4A服务源码语法检查全部通过。
- `server/package-lock.json`已提交；使用官方 npm 11.4.2执行 `npm ci`，安装14个包、审计15个包、0漏洞。
- 现有 V1.4 file:// 与 localhost 人工验收状态沿用正式 v1.4.0 已完成结果；本分支没有修改HTML。人工结果不计入自动化数量。

## 结论

V1.4A非联网110项、真实REST形状9项、既有非联网1,354项和既有真实REST 100项均为0失败；合计1,573项本机已执行自动化通过。PostgreSQL 14生产集成13项已由第二轮CI真实通过。REST+PostgreSQL三项在该CI中为HTTP 451导致的未完成状态；本修复目标状态为 `EXTERNAL_REGION_BLOCKED`而非PASS，最终以推送后的分层CI为准。服务尚未部署，没有把Memory、HTTP形状或SKIP冒充端到端验收。
