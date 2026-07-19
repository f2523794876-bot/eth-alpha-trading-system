# ETH Alpha V1.4A 服务器数据基础

这是独立于浏览器页面运行的公开市场数据采集器。它只读取 Binance 公开 REST 行情，绝不读取交易密钥、连接账户或发送订单。现有单文件 HTML 不依赖本服务，页面关闭不会停止服务器进程。

## 环境

- Ubuntu 22.04 LTS
- Node.js 22 LTS
- PostgreSQL 14 或更高版本（CI固定使用 PostgreSQL 14）
- UTC 系统时区与正常工作的 NTP

本项目不要求 Docker。首先建立专用数据库与最低权限用户，然后复制 `.env.example` 到服务器外部的 `/etc/eth-alpha/collector.env`，填入强密码。不要提交 `.env`。

```bash
cd /opt/eth-alpha/eth-alpha-trading-system/server
npm ci --omit=dev
node src/db/migrate.js up
node src/index.js
```

迁移回滚脚本是破坏性的，只允许用于空的临时测试数据库。正式历史只归档、不静默删除。

## 采集源与频率

| 数据 | 官方公开接口 | 调度 |
|---|---|---|
| Binance服务器时间 | `GET /api/v3/time` | 每30秒采集周期强制检查 |
| 现货K线 | `GET /api/v3/klines` | ETH/BTC × 15m/1h/4h，每30秒 |
| USDⓈ-M永续K线 | `GET /fapi/v1/klines` | ETH/BTC × 15m/1h/4h，每60秒 |
| 资金费率 | `GET /fapi/v1/fundingRate` | 每60秒拉取并按vintage去重 |
| Open Interest | `GET /fapi/v1/openInterest` | 每60秒 |
| 全市场账户多空比 | `GET /futures/data/globalLongShortAccountRatio` | 每60秒拉取15m序列并去重 |
| 主动买卖量 | `GET /futures/data/takerlongshortRatio` | 每60秒拉取15m序列并去重 |

端点、字段和当前响应在实现时已用 Binance 官方文档及真实响应核对。宏观适配器本阶段为 `UNAVAILABLE`：规范没有冻结无需密钥的官方宏观来源，因此不接入非官方聚合数据。

## 时间与安全

每个正式采集周期记录交易所服务器时间、请求开始/结束、本地网络中点、往返延迟和时钟偏差。偏差超过 `MAX_CLOCK_OFFSET_MS` 或服务器时间不可用时 fail closed：不写正式事实；失败响应仍可进入审计/原始降级路径。正式 `market_bars` 只接受 `closeTime <= sourceServerTime` 的K线，未收盘数据进入 provisional 层或仅保留在原始层。

重试采用有上限和抖动的指数退避；429优先服从 `Retry-After`；等待后会重新核算并扣减令牌。七类端点分别维护熔断、连续失败、半开探测和恢复状态，单个端点失败不会阻断其他端点。单实例租约带 fencing token；所有采集写入都在同一数据库事务的开始与提交前，用 PostgreSQL 当前时间复核 holder、token 和有效期。续约失败会清除调度器、取消在途 HTTP 并进入 `BLOCKED`，旧实例不能自行恢复写入。

事实修订自然键如下：K线为 `source + marketType + instrument + interval + openTime`；资金费率和 OI 为 `source + instrument + observationTime`；多空比和主动买卖量再加入 `interval`。同键同内容返回 `DEDUPED`；同键不同内容在事务内追加 revision 与 `DataRevisionEvent`，保留首个 `firstAvailableAt`，不覆盖旧版本。OI 是连续时点快照；只有相同 observationTime 的更正才属于修订。

缺口任务由采集服务内置 worker 定时领取，使用 `FOR UPDATE SKIP LOCKED` 防止多实例重复执行，状态为 `PENDING → RUNNING → RETRY_WAIT/SUCCEEDED/FAILED_PERMANENT`。回补继续使用 Binance 服务器时间确认收盘；未完整补齐时不会关闭 gap。

## 只读 API

服务默认只监听 `127.0.0.1:8787`：

```text
GET /health/live
GET /health/ready
GET /api/v1/collector/status
GET /api/v1/data-health
GET /api/v1/gaps
GET /api/v1/sources
GET /api/v1/bars?instrument=ETHUSDT&marketType=spot&interval=15m&from=...&to=...&limit=500
GET /api/v1/derivatives/funding?instrument=ETHUSDT&from=...&to=...&limit=100
GET /api/v1/derivatives/open-interest?instrument=ETHUSDT&from=...&to=...&limit=100
```

参数使用白名单，单次最多1000行、最大366天。错误响应不暴露堆栈、环境变量或数据库信息。若对外提供，应在反向代理增加 TLS、来源控制和只读访问策略。

## 运维

```bash
curl -fsS http://127.0.0.1:8787/health/live
curl -fsS http://127.0.0.1:8787/health/ready
sudo -u postgres pg_dump --format=custom eth_alpha > eth_alpha-$(date -u +%Y%m%dT%H%M%SZ).dump
sudo -u postgres pg_restore --clean --if-exists --dbname=eth_alpha_restore eth_alpha-*.dump
```

systemd模板位于 `deploy/systemd/eth-alpha-collector.service`，本提交不会自动安装或启用它。部署顺序固定为：创建最低权限数据库与用户 → `npm ci --omit=dev` → `node src/db/migrate.js up` → 核对 `/health/ready` → 再启用服务。unit 的 `ExecStartPre` 会再次执行仅向上的幂等迁移检查，checksum或迁移失败会阻止服务启动，绝不自动执行破坏性 down。建议 journald 限额或 logrotate 每日轮转、保留30天运行日志。原始响应数据库层拒绝 UPDATE/DELETE；受控归档应先使用 `pg_dump`/对象存储保留完整JSON与哈希，当前版本不提供在线删除入口。正式事实和修订事件不得静默删除。

磁盘预算应根据真实采集一周后测量。初始规划可按原始JSON压缩后每日100–300MB、数据库事实每日50–150MB预留，并保持至少30%磁盘余量；达到70%告警、85%停止新增非关键缓存，正式历史只能先备份再归档。

常见故障：

- `BLOCKED / SERVER_TIME_UNAVAILABLE`：检查DNS、HTTPS出口和 Binance 可达性，不得用本机时间代替。
- `CLOCK_OFFSET_EXCEEDED`：执行 `timedatectl status` 检查UTC/NTP；修复系统时钟后等待健康校验。
- `RATE_LIMITED`：检查响应头、降低调度并等待 `Retry-After`，不可紧密重试。
- `COLLECTOR_LEASE_HELD`：确认是否已有健康实例；租约到期前不要强制启动第二实例。
- 未解决缺口：检查 `data_gaps` 与 `backfill_jobs`，保留错误原因后重试，禁止伪造K线。
- 数据库失败：服务 readiness 应失败；恢复数据库并验证迁移checksum、自然键和最新健康快照。

## 测试

```bash
npm test
RUN_LIVE_TESTS=1 npm run test:live
TEST_DATABASE_URL=postgresql://... npm run test:postgres
TEST_DATABASE_URL=postgresql://... RUN_LIVE_REST=1 npm run test:postgres:live
```

`TEST_DATABASE_URL`必须指向名称含 `test`、`ci` 或 `v14a` 的隔离数据库；PostgreSQL套件会执行破坏性的 up/down/up，绝不能指向生产。`.github/workflows/v1-4a-postgres-integration.yml`使用 PostgreSQL 14 service container运行生产仓库与生产采集链。真实REST形状测试、真实PostgreSQL测试和真实REST+PostgreSQL端到端测试分别统计；环境缺失时明确SKIP，不计入通过。
