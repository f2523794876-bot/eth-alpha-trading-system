# V1 测试结果

执行日期：2026-07-12（Asia/Shanghai）

## 汇总

| 类别 | 通过 | 失败 | 阻塞 |
|---|---:|---:|---:|
| 合成行情与纯函数 | 28 | 0 | 0 |
| Binance 六路真实 REST | 7 | 0 | 0 |
| 单文件内嵌脚本语法 | 1 | 0 | 0 |
| 真实浏览器 `file://` 双击形态 | 0 | 0 | 1 |
| 合计 | 36 | 0 | 1 |

V2/V3 项目 T16、T21、T22、T23 以及 T24.2-T24.5 按规范标记为不适用，未计入通过率。

## 关键结果

- P0 旧算法复现成功：包含当前突破K线的 high20 判定返回 false。
- 修复后冻结结构测试通过：确认K线排除在 priorStructureHigh20/Low20 之外，正式突破可进入 `BULL_CONFIRMATION`。
- 未收盘插针仅产生“盘中预警（未收盘，仅供参考）”，不改变正式状态；收盘回区间后仍不算突破。
- 三周期同向、15分钟逆4小时、BTC任一周期冲突、数据失效阻断均通过。
- 净盈亏比确认包含手续费、半价差与滑点，且小于毛盈亏比。
- 真实 Binance API：ETH/BTC × 15m/1h/4h 各返回120根K线，三周期决策成功生成，健康状态 `normal`。
- HTML 两段内嵌脚本均可被 JavaScript 编译器解析。

## 浏览器测试条件

尝试使用 Codex 内置真实浏览器直接打开：

`file:///Users/penn/Documents/GitHub/eth-alpha-trading-system/eth-dynamic-trading-dashboard.html`

浏览器安全策略拒绝本地 `file://` 导航。按安全规则未改用绕过手段，也未把 Node/API 成功冒充为浏览器双击成功。因此该项保持“阻塞”，需要董事长在 Chrome 或 Safari 中人工双击文件确认页面渲染与 CORS 表现。

## 可复现命令

使用 Codex bundled Node：

```sh
node tests/v1-tests.js
node tests/live-rest-test.js
```
