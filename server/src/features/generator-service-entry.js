import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { measureServerTime } from '../collector/time-guard.js';
import { createPgPool, PostgresRepository } from '../db/postgres.js';
import { PublicHttpClient } from '../http/client.js';
import { BinancePublicAdapter } from '../sources/binance.js';
import { FeatureGeneratorService } from './generator-service.js';

export async function bootstrapFeatureGenerator(config = loadConfig()) {
  const pool = await createPgPool(config);
  const repository = new PostgresRepository(pool);
  const client = new PublicHttpClient(config);
  const adapter = new BinancePublicAdapter({ client, spotBaseUrl: config.spotBaseUrl, futuresBaseUrl: config.futuresBaseUrl });
  const serverTimeProvider = signal => measureServerTime(adapter, { maxClockOffsetMs: config.maxClockOffsetMs, signal });
  const service = new FeatureGeneratorService({
    repository,
    holderId: `${config.collectorId}-feature-generator`,
    serverTimeProvider,
    leaseTtlMs: config.leaseTtlMs,
    pollMs: config.featureGeneratorPollMs,
    batchSize: config.featureGeneratorBatchSize
  });
  await service.start();
  let stopping = false;
  const stop = async signal => {
    if (stopping) return;
    stopping = true;
    console.info('feature generator graceful shutdown', { signal });
    await service.stop();
    await repository.close();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  return { service, repository, stop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  bootstrapFeatureGenerator().catch(error => {
    console.error('feature generator startup failed', { code: error.code || error.message });
    process.exitCode = 1;
  });
}
