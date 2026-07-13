# V1 测试结果

执行日期：2026-07-12（Asia/Shanghai）

## 汇总

| 类别 | 通过 | 失败 | 阻塞 |
|---|---:|---:|---:|
| 合成行情与纯函数 | 38 | 0 | 0 |
| Binance 六路真实 REST | 7 | 0 | 0 |
| 单文件内嵌脚本语法 | 1 | 0 | 0 |
| 真实浏览器 `file://` 双击形态 | 1 | 0 | 0 |
| 合计 | 47 | 0 | 0 |

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

Codex执行环境曾因安全策略拒绝本地 `file://` 导航。随后CEO已根据真实Chrome双击运行截图完成V1验收，确认六路REST、浏览器CORS与页面渲染通过。本轮不重复浏览器验收。

## 2026-07-13 验收修复回归

- 新增10项纯函数回归测试：支撑/压力Swing来源语义、历史压力转支撑标签、无交易方案RR文案、4小时过渡评分、1小时震荡评分、反向周期评分、靠近压力/支撑/区间中部拦截判断。
- 纯函数测试由28项增至38项，全部通过。
- 单文件中文映射与内嵌脚本编译检查通过。
- 六路真实REST再次通过7/7，健康状态 `normal`。

## 可复现命令

使用 Codex bundled Node：

```sh
node tests/v1-tests.js
node tests/live-rest-test.js
```
