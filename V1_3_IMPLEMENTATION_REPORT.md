# ETH Alpha V1.3 实施报告

版本：`v1.3-draft-4-final`  
实现分支：`codex/v1.3-auto-paper-trading`

## 实现结果

V1.3 在不修改 `v1-core.js` 的前提下，以三个隔离模块追加实现：

- `v1_3-paper-trading-core.js`：500 USDT 模拟账户、会计恒等式、风险预算、双向虚拟撮合、手续费/滑点、分批止盈、专业加仓、数据缺口和两类人工结算。
- `v1_3-signal-archive-core.js`：不可变建议快照、已收盘K线指纹去重、事件投影、影子验证、分母过滤、独立导出和存储迁移。
- `v1_3-auto-engine-core.js`：六态自动引擎、十四项开仓许可、一次加仓、反向冷却、心跳、离线/行情缺口回放和统一幂等键。

正式成交仅使用已收盘15分钟K线。实时价格只用于持仓估值。所有成交均为浏览器本地虚拟成交，不连接交易所账户、不读取密钥、不发送订单。

## 安全与会计

- 初始资金：500 USDT。
- 单笔最大风险：当前净值1%；试仓：当前净值0.5%。
- 杠杆仅换算保证金，范围1–3倍，不改变风险预算。
- `cash = initialCapital + realizedPnlGross - feesTotal`。
- `equity = cash + unrealizedPnl`。
- `availableBalance = equity - marginUsed`。
- 总回撤达到10%进入强制观察；UTC当日已实现损失达到3%进入当日锁定。
- UTC日期切换由自动引擎生产tick与页面账户渲染共同执行；昨日当日锁会重置，并按新UTC日成交重建当日起始净值。
- 完整三周期同向使用1%风险预算；部分同向和其他非完整同向许可仅使用0.5%试仓预算。方案数量统一复用V1.1 `calcRiskBudget` 成本风险公式。
- 每笔最多自动加仓一次，必须已有浮盈、V1.1许可有效、专业加仓许可、统一止损已达到含成本保本位，且统一止损下最坏损失不超过当前净值1%。
- 分批止盈按初始数量50%/30%/最终全部剩余，最后一次强制清零尾差。

## 撮合与恢复

- 同一根K线同时触发止损和止盈时止损优先。
- 不利跳空止损使用首个可获得的不利开盘价；有利跳空止盈不改善计划目标成交价。
- 所有自动动作使用稳定幂等键，重复REST刷新不重复成交。
- `lastEngineHeartbeat`与`lastProcessedBarTime`持久化在`PaperAccount` schema中，符合规范“不新增引擎独立key”的最终定义。
- 页面休眠/关闭期间不声称持续运行；恢复后按15分钟时间顺序检查连续性并回放。不能完整回补时进入`UNRESOLVED_DATA_GAP`。
- 回补不连续但已有新收盘K线时，生产回放链自动保存第一根可得K线开盘参考价及按方向计算的一次性不利成交价，保守结算不再依赖手工构造字段，也不会重复叠加滑点。
- 紧急模拟平仓与数据缺口保守结算是两个独立命令，分别使用`USER_EMERGENCY_CLOSE/false/true`与`DATA_GAP_CONSERVATIVE/true/false`语义。

## 存储

独立使用：

- `ethAlphaPaperAccount`
- `ethAlphaPaperTrades`
- `ethAlphaPaperLog`
- `ethAlphaSignalArchive`
- `ethAlphaSignalEvents`
- `ethAlphaShadowResults`

引擎状态按四份最终规范保存在`ethAlphaPaperAccount`，不另设重复事实源。全部存储具有schema版本、损坏JSON恢复、容量裁剪和幂等保护；建议/影子数据不会写入模拟账户会计。

## 构建与兼容

- 正式页面仍是单文件 `eth-dynamic-trading-dashboard.html`，可双击运行。
- 无React、Vite、npm运行时、WebSocket、真实账户或外部CDN。
- V1.3核心按 V1.1 → V1.2 → Paper → Signal → Auto 顺序嵌入既有脚本块，以保持V1.2已验收的四个脚本标签结构。
- 开工前后 `v1-core.js` SHA-256均为 `0a4d9e712859d79ecae592aacffe371abfba29a2c6b7b76119a68c49e0471a97`。

## 保守解释记录

用户需求中的“AutoPaperEngineState独立localStorage键”与四份draft-4-final规范“AutoEngineState字段落在PaperAccount内，不新增key”冲突。采用规范的单一事实源方案：引擎状态持久化在`ethAlphaPaperAccount`，避免账户状态与独立键漂移。

## 尚存风险

- 浏览器页面不是24小时常驻服务；关闭、休眠和超出120根REST窗口的缺口可能只能进入未解决状态，不能伪造历史成交。
- localStorage容量和浏览器清理策略由本机环境控制；写入失败会安全阻断并保留非交易警告。
- 本次环境无法连接ChatGPT Chrome Extension，因此真实Chrome双击人工验收未完成；详见测试报告。该项不计入自动化测试。
- 规范中的284条明细目前用于结构可追踪检查，不是284套相互独立的业务行为测试；实际独立覆盖以聚焦业务测试和安全复审针对性测试为准。
- 真实REST测试中的强制开仓段是“真实行情输入 + 确定性许可夹具”，用于稳定验证撮合、日志、幂等和会计路径；它不声称V1.1在测试时刻自然给出了交易许可。另有未改写原始决策路径专门验证许可不会被绕过。
