const integer = (name, fallback, min = 0) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min) throw new Error(`Invalid ${name}`);
  return value;
};
const positiveNumber=(name,fallback)=>{const value=Number(process.env[name]??fallback);if(!Number.isFinite(value)||value<=0)throw new Error(`Invalid ${name}`);return value;};

export function loadConfig() {
  return Object.freeze({
    env: process.env.NODE_ENV || 'development',
    host: process.env.HOST || '127.0.0.1',
    port: integer('PORT', 8787, 1),
    databaseUrl: process.env.DATABASE_URL || '',
    dbSsl: process.env.DB_SSL === 'true',
    collectorId: process.env.COLLECTOR_ID || `collector-${process.pid}`,
    spotBaseUrl: process.env.BINANCE_SPOT_BASE_URL || 'https://api.binance.com',
    futuresBaseUrl: process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com',
    timeoutMs: integer('HTTP_TIMEOUT_MS', 10_000, 100),
    maxRetries: integer('MAX_RETRIES', 3, 0),
    backoffBaseMs: integer('BACKOFF_BASE_MS', 250, 1),
    backoffCapMs: integer('BACKOFF_CAP_MS', 10_000, 1),
    maxClockOffsetMs: integer('MAX_CLOCK_OFFSET_MS', 5_000, 0),
    leaseTtlMs: integer('LEASE_TTL_MS', 60_000, 10_000),
    backfillPollMs: integer('BACKFILL_POLL_MS', 15_000, 1_000),
    backfillMaxAttempts: integer('BACKFILL_MAX_ATTEMPTS', 5, 1),
    featureGeneratorPollMs: integer('FEATURE_GENERATOR_POLL_MS', 15_000, 1_000),
    featureGeneratorBatchSize: integer('FEATURE_GENERATOR_BATCH_SIZE', 32, 1),
    forecastPollMs: integer('FORECAST_POLL_MS', 300_000, 1_000),
    forecastFeatureWaitMs: integer('FORECAST_FEATURE_WAIT_MS', 2_000, 10),
    forecastFeatureWaitAttempts: integer('FORECAST_FEATURE_WAIT_ATTEMPTS', 4, 1),
    outcomePollMs: integer('OUTCOME_POLL_MS', 300_000, 1_000),
    healthRetentionDays: integer('HEALTH_RETENTION_DAYS', 90, 1),
    freshnessGraceMultiplier: positiveNumber('FRESHNESS_GRACE_MULTIPLIER',3),
    logLevel: process.env.LOG_LEVEL || 'info'
  });
}
