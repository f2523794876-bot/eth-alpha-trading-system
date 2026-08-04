import { Pool } from 'pg';
import { buildIdempotencyAuditReport } from '../src/domain/idempotency-audit.js';
const pool = new Pool({ connectionString: process.env.RESEARCH_DATABASE_URL });
try {
  const report = await buildIdempotencyAuditReport(pool);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
