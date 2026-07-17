# ETH Alpha V1.3.1 测试结果

## 自动化测试

- V1.1非联网回归：93项通过，0失败。
- V1.2非联网回归：299项通过，0失败。
- V1.3既有非联网测试：483项通过，0失败，其中284项是结构性验收矩阵。
- V1.3.1非联网行为/UI测试：75项通过，0失败。
- 非联网合计：950项通过，0失败。

## 真实Binance REST测试

- V1.1真实REST：8项通过，0失败。
- V1.2真实REST：24项通过，0失败。
- V1.3既有真实REST：30项通过，0失败。
- V1.3.1自然生产链诊断REST：11项通过，0失败。
- 真实REST合计：73项通过，0失败。

## 总计

自动化记录合计：1023项通过，0失败。其中284项为结构性矩阵检查，不表述为独立业务行为测试。

新增测试覆盖：OBSERVATION、WATCHLIST、EXECUTABLE、拒绝原因、枚举漂移、秒/毫秒有效期、倒序入场区、跨K线去重、自定义事件生产接线、成功/失败/恢复失效、诊断容量、损坏JSON、导出、旧schema迁移，以及不覆盖真实 `worthBetting`、`opportunityScores`、`signalPermission`、`triggerPlans` 的自然REST生产链。

最终安全修复新增21项断言，覆盖两类OBSERVATION跨tick许可穿透、合法WATCHLIST触发及幂等开仓、PAUSED/RISK_LOCKED/DATA_BLOCKED、旧schema默认拒绝、OBSERVATION与未触发/过期/未验证/缺口信号的统计隔离、反向冷却门控、已有EXECUTABLE的防御性降级，以及关键许可对象缺失、类型错误和未知枚举。
