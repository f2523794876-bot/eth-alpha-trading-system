import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createPgPool, PostgresRepository } from '../db/postgres.js';
import { FeatureEngine } from './feature-engine.js';

const arg=name=>{const prefix=`--${name}=`;return process.argv.find(x=>x.startsWith(prefix))?.slice(prefix.length);};
export async function runFeatureGeneration({repository,from,to,targetBarCloseTime,asOfTime=Date.now(),dryRun=false,symbol='ETHUSDT',targetInterval='15m',holderId=`feature-generator-${randomUUID()}`}={}){
  const lease=await repository.acquireLease('feature-generator',holderId,60000);if(!lease)throw Object.assign(new Error('Feature generator lease held'),{code:'FEATURE_GENERATOR_LEASE_HELD'});const engine=new FeatureEngine({repository});
  return Number.isFinite(targetBarCloseTime)?engine.generatePoint({symbol,targetInterval,targetBarCloseTime,asOfTime,dryRun},lease):engine.generateRange({symbol,targetInterval,from,to,dryRun},lease);
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const config=loadConfig(),pool=await createPgPool(config),repository=new PostgresRepository(pool);
  try{const point=Number(arg('target')),from=Number(arg('from')),to=Number(arg('to'));if(!Number.isFinite(point)&&(!Number.isFinite(from)||!Number.isFinite(to)))throw new Error('Use --target=<epoch-ms> or --from=<epoch-ms> --to=<epoch-ms>');const result=await runFeatureGeneration({repository,targetBarCloseTime:Number.isFinite(point)?point:undefined,from,to,asOfTime:Number(arg('as-of'))||Date.now(),targetInterval:arg('interval')||'15m',dryRun:process.argv.includes('--dry-run')});console.log(JSON.stringify({status:result.status,runId:result.runId||null,count:result.results?.length??1}));}
  finally{await repository.close();}
}
