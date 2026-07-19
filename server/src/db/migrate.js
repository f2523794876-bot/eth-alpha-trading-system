import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createPgPool } from './postgres.js';

export async function runMigrations(pool, direction='up', root=resolve(dirname(fileURLToPath(import.meta.url)),'../../migrations')) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const suffix=direction==='down'?'.down.sql':'.up.sql'; const files=(await readdir(root)).filter(x=>x.endsWith(suffix)).sort(); if(direction==='down')files.reverse();
  for(const file of files){const version=file.split('_').slice(0,1).join('_'); const sql=await readFile(resolve(root,file),'utf8'); const checksum=createHash('sha256').update(sql).digest('hex');
    const found=(await pool.query('SELECT checksum FROM schema_migrations WHERE version=$1',[version])).rows[0];
    if(direction==='up'&&found){if(found.checksum!==checksum)throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${version}`);continue;}
    if(direction==='down'&&!found)continue; const client=await pool.connect(); try{await client.query('BEGIN');await client.query(sql);if(direction==='up')await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2) ON CONFLICT DO NOTHING',[version,checksum]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const pool=await createPgPool(loadConfig());try{await runMigrations(pool,process.argv[2]||'up');}finally{await pool.end();}}
