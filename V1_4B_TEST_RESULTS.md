# ETH Alpha V1.4B 测试结果

测试日期：2026-07-21（Asia/Shanghai）
分支：`codex/v1.4b-feature-engine-foundation`
基线：`3b997ee2baddc95ecf3712d533700ecc9b539855`

## Revision持久化缺陷修复验证（本轮新增）

独立复审发现：真实时间推进场景下（而非既有测试复用同一时间戳的场景），`market_bars`及全部4张衍生品事实表的revision追加会触发数据库CHECK约束冲突而写入失败。根因、复现与修复详见 `V1_4B_IMPLEMENTATION_REPORT.md` 第9节。本轮在本机隔离PostgreSQL 14（`eth_alpha_v14b_fix_test_db`，非生产、复审结束后已删除）中真实执行：

| 验证项 | 结果 |
|---|---|
| 修复前复现：5张表revision写入均触发CHECK 23514 | 已确认（约束名逐表记录于实施报告） |
| 修复后回归：5张表revision写入全部成功，旧revision不被覆盖 | 全部通过 |
| 新增 `v1-4b-revision-time-progression.integration.test.js`（真实PostgreSQL） | **9/9 PASS** |
| 既有13项V1.4A真实PostgreSQL测试（含同构revision用例）修复后仍通过 | **13/13 PASS** |
| 既有4项V1.4B真实PostgreSQL特征测试修复后仍通过 | **4/4 PASS** |

## 自动化测试（本轮真实执行，非引用历史文档）

| 测试组 | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|
| V1.4B特征/时间/质量/lineage/幂等/API/保留策略（`test:features`） | 34 | 0 | 0 |
| V1.4A既有服务器非联网回归 + 多空比fixture/CI接线回归（顶层`test`） | 113 | 0 | 0 |
| **服务器非联网合计** | **147** | **0** | **0** |
| V1.1–V1.4浏览器端非联网回归（本轮逐文件真实执行，排除8个真实REST文件） | 1,223 | 0 | 0 |
| **全部已执行非联网自动化** | **1,370** | **0** | **0** |
| V1.4A真实PostgreSQL 14生产集成 | 13 | 0 | 0 |
| V1.4B真实PostgreSQL特征集成 | 4 | 0 | 0 |
| V1.4B revision时间推进真实PostgreSQL集成（本轮新增） | 9 | 0 | 0 |
| **真实PostgreSQL 14合计** | **26** | **0** | **0** |

以上PostgreSQL 26项测试本轮均在本机新建的隔离临时数据库中真实连接、真实执行，非本机SKIP、非仅引用CI证据；数据库与角色已在复审结束后删除。

强制门禁接线修复后，`npm run test:postgres`明确顺序执行13项V1.4A、4项V1.4B特征集成和9项revision时间推进集成，共26项。新增非联网结构性回归会读取`server/package.json`与workflow，确保独立revision脚本、组合命令和GitHub Actions调用点同时存在，且强制Job未设置`continue-on-error`。本机当前没有`TEST_DATABASE_URL`时，26项会明确SKIP而非伪报PASS；真实26项结果沿用上表已完成的隔离PostgreSQL 14执行证据，并须由本提交触发的GitHub Actions再次独立确认。

## 真实公开REST（本轮真实执行）

| 测试组 | 通过 | 失败 | 阻塞 | 状态 |
|---|---:|---:|---:|---|
| V1.4A REST+PostgreSQL真实链（`test:postgres:live`，真实Binance写入真实隔离库） | 3 | 0 | 0 | PASS |
| V1.4B Binance公开数据→as-of特征生产链（`v1-4b-feature-live.test.js`） | 1 | 0 | 0 | PASS |
| 独立探针：真实Binance六路K线+四类衍生数据→真实PostgreSQL→真实FeatureEngine完整链路 | 1 | 0 | 0 | PASS，54项特征、持久化确认 |

本沙箱具备出网能力，451/EXTERNAL_REGION_BLOCKED相关代码本轮未改动，语义沿用既有实现（见独立复审报告第9节）。

## 构建与安全（本轮真实执行）

- 单文件HTML重新构建：SHA-256 = `fe969b5d76cbecb4a19b47093ee698f12d38bbf01e0fd36b50dc1add3ac2c5c8`，与修复前基线完全一致。
- `v1-core.js` SHA-256：`edc36248440cd53443b798a9aa5ad769904b986068172ecc4590aafbe486ed00`，未修改。
- `git status --short`确认本次修复的完整改动范围仅为：`server/src/db/postgres.js`、`server/src/db/memory.js`、新增`server/tests/postgres/v1-4b-revision-time-progression.integration.test.js`，零浏览器文件改动。
- `recordSignalIfEligible`、`evaluateShadowSignals`、`buildTradeProposal`、`tickAutoEngine`、`processTradeGate`在`server/`、`deploy/`、`.github/`全树调用数为0；`X-MBX-APIKEY`/`createOrder`/`placeOrder`/`BINANCE_API_KEY`/`BINANCE_SECRET`/`apiSecret`等模式零命中。

## 结论

Revision持久化缺陷（P1）已定位并修复：根因为`saveMarketBar()`/`savePointFact()`在构造revision行时错误地将`available_at`重新赋值为本次抓取时间，而非保持为随自然键固定不变的来源侧可用时间，导致与被正确保留的旧`first_available_at`产生矛盾。修复后5张表在真实时间推进下均能正确追加revision，旧记录不被覆盖，as-of查询在修订可见前后正确返回相应版本，原子回滚、时间红线与fencing保护均未被削弱。全部验证在本机隔离PostgreSQL 14中真实执行，非SKIP、非引用历史证据。未部署服务、未连接生产数据库、未接入真实交易。

修复提交紧随初始实现提交`8a7e0112f98308ea95e7e76018bf6a1b9ebf8580`与fixture修复提交`baa6cbeafd7553e882b15a44e6a811d654edf77a`之后，完整commit编号见Git提交记录。未创建PR、未合并main、未创建Release。
