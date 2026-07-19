import { loadConfig } from './config.js';
import { PublicHttpClient } from './http/client.js';
import { BinancePublicAdapter } from './sources/binance.js';
import { createPgPool, PostgresRepository } from './db/postgres.js';
import { CollectorService } from './collector/service.js';
import { createApiServer } from './api/server.js';

export async function bootstrap(config=loadConfig()){
  const pool=await createPgPool(config);const repository=new PostgresRepository(pool);
  const client=new PublicHttpClient(config);const adapter=new BinancePublicAdapter({client,spotBaseUrl:config.spotBaseUrl,futuresBaseUrl:config.futuresBaseUrl});
  const collector=new CollectorService({adapter,repository,config});const api=createApiServer({collector,repository,host:config.host,port:config.port});
  await collector.start();await api.start();
  let stopping=false;const stop=async signal=>{if(stopping)return;stopping=true;console.info('graceful shutdown',{signal});await api.stop();await collector.stop();};
  process.once('SIGTERM',()=>stop('SIGTERM'));process.once('SIGINT',()=>stop('SIGINT'));
  return {collector,repository,api,stop};
}

if(import.meta.url===`file://${process.argv[1]}`){bootstrap().catch(error=>{console.error('collector startup failed',{code:error.code||error.message});process.exitCode=1;});}
