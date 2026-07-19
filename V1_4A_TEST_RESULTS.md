# ETH Alpha V1.4A 测试结果

测试日期：2026-07-20（Asia/Shanghai）
分支：`codex/v1.4a-server-data-foundation`  
基线：`93d9feddab7d0fba01a87d7ea7e14355bf5868d3`

## 自动化测试口径

| 测试组 | 通过 | 失败 | 环境阻塞 |
|---|---:|---:|---:|
| V1.4A离线/Memory/静态约束/HTTP/API行为 | 101 | 0 | 0 |
| V1.4A真实PostgreSQL生产仓库集成 | 0 | 0 | 13（本机无TEST_DATABASE_URL） |
| **V1.4A新增非联网已执行合计** | **101** | **0** | **13** |
| V1.1–V1.4既有非联网回归 | 1,354 | 0 | 0 |
| **全部已执行非联网自动化** | **1,455** | **0** | **13** |

V1.4A 101项已执行覆盖：canonical JSON根类型/拒绝路径、脱敏失败审计、修订状态与显式REJECTED、DataVintageRef、四表时间乱序、秒/毫秒、UTC日界、数据库/写入/零数据假健康、端点恢复、真实OPEN熔断隔离、令牌桶重算/取消、fencing旧token、heartbeat停调度、graceful shutdown、回补领取/重试/永久失败、collection run/attempt关联、raw触发器和迁移静态约束、API readiness脱敏等。

数据库迁移测试说明：当前Mac没有 PostgreSQL/`psql`/容器运行时且未配置 `TEST_DATABASE_URL`。13项真实PostgreSQL 14生产仓库套件已提交但本机全部明确SKIP，未计入通过；覆盖up/down/up与并发migration锁、19表、JSONB对象/数组/原语、生产CollectorService落库、五类事实幂等/修订/rollback、孤儿修订回滚、时间CHECK、gap/backfill、旧token拒写/并发lease、raw UPDATE/DELETE和数据库断开readiness。对应CI门禁为 `.github/workflows/v1-4a-postgres-integration.yml`。

## 真实公开 REST

| 测试组 | 通过 | 失败 | 结果 |
|---|---:|---:|---|
| V1.4A Binance服务器时间与六路现货生产标准化 | 7 | 0 | 时间偏差守卫通过；ETH/BTC × 15m/1h/4h均产生已收盘正式事实 |
| V1.4A ETH/BTC永续公开数据组合 | 2 | 0 | 永续K线、资金费率、OI、多空比、主动买卖量均HTTP 200且字段有效 |
| **V1.4A真实REST** | **9** | **0** | **通过** |
| V1.4A真实REST + PostgreSQL生产落库 | 0 | 0 | 3项SKIP：本机无隔离PostgreSQL |
| V1.1–V1.4既有真实REST回归 | 100 | 0 | 八个既有联网测试文件全部通过 |
| **全部真实REST** | **109** | **0** | **通过** |

真实REST形状/Normalizer与真实REST+PostgreSQL端到端严格分开记录。前者109项通过；后者3项因本机数据库环境缺失SKIP，不能称为实机落库通过。接口响应中确认：资金费率可为负数，价格和数量是十进制字符串，所有时间戳为毫秒整数。

## 构建与静态安全

- 既有单文件构建执行两次，SHA-256均为 `fe969b5d76cbecb4a19b47093ee698f12d38bbf01e0fd36b50dc1add3ac2c5c8`。
- 正式 `eth-dynamic-trading-dashboard.html` 与构建产物一致，未产生差异。
- `v1-core.js` SHA-256为 `edc36248440cd53443b798a9aa5ad769904b986068172ecc4590aafbe486ed00`，本分支未修改。
- 五个真实交易入口在 `server/` 中调用数为0：`recordSignalIfEligible`、`evaluateShadowSignals`、`buildTradeProposal`、`tickAutoEngine`、`processTradeGate`。
- V1.4A服务源码语法检查全部通过。
- `server/package-lock.json`已提交；使用官方 npm 11.4.2执行 `npm ci`，安装14个包、审计15个包、0漏洞。
- 现有 V1.4 file:// 与 localhost 人工验收状态沿用正式 v1.4.0 已完成结果；本分支没有修改HTML。人工结果不计入自动化数量。

## 结论

V1.4A非联网101项、真实REST形状9项、既有非联网1,354项和既有真实REST 100项均为0失败；合计1,564项已执行自动化通过。另有真实PostgreSQL 13项与真实REST+PostgreSQL 3项因本机环境缺失SKIP且未计入通过。服务尚未部署，没有把Memory或HTTP形状测试冒充数据库实机验收。
