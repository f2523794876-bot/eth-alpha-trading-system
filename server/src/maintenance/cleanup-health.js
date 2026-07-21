import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createPgPool, PostgresRepository } from '../db/postgres.js';

export async function cleanupHealthTelemetry(repository,{retentionDays=90,dryRun=false}={}){
  return repository.cleanupHealthSnapshots({retentionDays,dryRun});
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const config=loadConfig(),pool=await createPgPool(config),repository=new PostgresRepository(pool);
  try{const dryRun=process.argv.includes('--dry-run');const result=await cleanupHealthTelemetry(repository,{retentionDays:config.healthRetentionDays,dryRun});console.log(JSON.stringify({dataset:'data_health_snapshots',retentionDays:config.healthRetentionDays,dryRun,...result}));}
  finally{await repository.close();}
}
