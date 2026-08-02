#!/usr/bin/env node
import { createPgPool, PostgresRepository } from '../db/postgres.js';
import { createGuardedResearchPgPool } from '../db/research-database-guard.js';
import { exitCodeForHistoricalBackfill, redactHistoricalBackfillText, runHistoricalFeatureBackfill, validateHistoricalBackfillOptions } from './historical-feature-backfill.js';

export function parseHistoricalBackfillArgs(argv){const values={symbol:null,from:null,to:null,interval:null,featureVersion:null,algorithmVersion:null,datasetVersion:null,dryRun:false,batchSize:25,resumeAfter:null};for(let i=0;i<argv.length;i++){const arg=argv[i];if(arg==='--dry-run'){values.dryRun=true;continue;}const map={'--symbol':'symbol','--from':'from','--to':'to','--interval':'interval','--feature-version':'featureVersion','--algorithm-version':'algorithmVersion','--dataset-version':'datasetVersion','--batch-size':'batchSize','--resume-after':'resumeAfter'};const key=map[arg];if(!key||argv[i+1]==null)throw Object.assign(new Error(`Unknown or incomplete argument: ${arg}`),{code:'INVALID_ARGUMENT'});values[key]=key==='batchSize'?Number(argv[++i]):argv[++i];}return values;}
export const sanitizeHistoricalBackfillError=redactHistoricalBackfillText;
// 数据库目标保护统一委托给research-database-guard.js（与backfill-cli-entry.js/dataset-manifest-cli-entry.js/
// validation-replay/cli-entry.js共用同一份实现）——本CLI仍然只读env.TEST_DATABASE_URL（不接受通用DATABASE_URL
// 回退，这一区别本身不变，只是"格式+库名校验"与"建连后current_database()二次核验"这两步的具体判定逻辑不再
// 各自实现一份）。
export async function main(argv=process.argv.slice(2),env=process.env,{stdout=console.log,stderr=console.error,createPgPool:createPgPoolOverride=createPgPool}={}){let repository;try{const options=parseHistoricalBackfillArgs(argv);validateHistoricalBackfillOptions(options);const pool=await createGuardedResearchPgPool({databaseUrl:env.TEST_DATABASE_URL,dbSsl:false},{createPgPool:createPgPoolOverride});repository=new PostgresRepository(pool);const summary=await runHistoricalFeatureBackfill({repository,options});stdout(JSON.stringify(summary));return 0;}catch(error){stderr(JSON.stringify({status:error.summary?.status||'FAILED',errorCode:error.code||'FEATURE_BACKFILL_FAILED',message:sanitizeHistoricalBackfillError(error.message),summary:error.summary||null}));return exitCodeForHistoricalBackfill(error);}finally{await repository?.close();}}
if(import.meta.url===`file://${process.argv[1]}`)process.exitCode=await main();
