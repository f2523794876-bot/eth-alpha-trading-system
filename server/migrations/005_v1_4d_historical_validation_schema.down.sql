-- V1_4D_HISTORICAL_REPLAY_SPEC.md §三.0：回滚整个 historical_validation schema。
-- CASCADE 会正确处理八张表之间的外键依赖顺序，等价于且更不易遗漏依赖顺序地完成逆序DROP。
-- 不触碰 public schema 任何对象（生产 market_bars/feature_records/forecast_* 等完全不受影响）。
DROP SCHEMA IF EXISTS historical_validation CASCADE;
