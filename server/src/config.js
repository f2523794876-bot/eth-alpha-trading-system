import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));

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
    logLevel: process.env.LOG_LEVEL || 'info',
    // D8只读展示（GET /api/v1/research/d8/status）读取D7已发布产物的根目录，与
    // 编排/发布运行状态遥测的根目录——本轮新增，两者物理隔离，见d8-status-reader.js/
    // research-run-status.js头部说明。未显式配置时默认指向仓库内var/子目录（首次启动前
    // 该目录尚不存在也不影响服务启动——reader对"root不存在"降级为NOT_RUN，不抛出）。
    d8ArtifactRoot: process.env.D7_ARTIFACT_ROOT || path.join(SERVER_ROOT, 'var', 'research-artifacts'),
    d8RunStatusRoot: process.env.D7_RUN_STATUS_ROOT || path.join(SERVER_ROOT, 'var', 'research-run-status')
  });
}
