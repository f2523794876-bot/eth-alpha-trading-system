export const SYMBOLS = Object.freeze(['ETHUSDT', 'BTCUSDT']);
export const INTERVALS = Object.freeze(['15m', '1h', '4h']);
export const MARKET_TYPES = Object.freeze(['spot', 'usdt_perpetual']);
export const HEALTH_STATES = Object.freeze(['HEALTHY', 'WARNING', 'DEGRADED', 'BLOCKED', 'RECOVERING']);
export const DATA_QUALITY = Object.freeze(['NORMAL', 'DEGRADED', 'INVALID']);
export const INTERVAL_MS = Object.freeze({ '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 });
export const FRESHNESS_POLICY = Object.freeze({
  graceMultiplier: 3,
  expectedFrequencyMs: Object.freeze({ '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 })
});
export function freshnessThresholdMs(interval, graceMultiplier=FRESHNESS_POLICY.graceMultiplier){const frequency=FRESHNESS_POLICY.expectedFrequencyMs[interval];if(!frequency||!Number.isFinite(graceMultiplier)||graceMultiplier<=0)throw new Error('INVALID_FRESHNESS_POLICY');return frequency*graceMultiplier;}
export const SCHEMA_VERSION = 'v1.4a-server-schema-1';
export const NORMALIZER_VERSION = 'v1.4a-normalizer-1';
export const MAX_QUERY_ROWS = 1000;
export const MAX_QUERY_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
