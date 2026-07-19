import { randomUUID } from 'node:crypto';

export async function createPgPool(config) {
  if (!config.databaseUrl) throw new Error('DATABASE_URL_REQUIRED');
  const { Pool } = await import('pg');
  return new Pool({ connectionString: config.databaseUrl, ssl: config.dbSsl ? { rejectUnauthorized: true } : false, max: 10, idleTimeoutMillis: 30_000 });
}

export class PostgresRepository {
  constructor(pool) { this.pool = pool; }
  async transaction(work) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async acquireLease(name, holderId, ttlMs) {
    const result = await this.pool.query(`INSERT INTO collector_leases(lease_name,holder_id,acquired_at,heartbeat_at,expires_at,fencing_token)
      VALUES($1,$2,now(),now(),now()+($3||' milliseconds')::interval,1)
      ON CONFLICT(lease_name) DO UPDATE SET holder_id=EXCLUDED.holder_id,heartbeat_at=now(),expires_at=EXCLUDED.expires_at,fencing_token=collector_leases.fencing_token+1
      WHERE collector_leases.expires_at<now() OR collector_leases.holder_id=EXCLUDED.holder_id RETURNING *`, [name, holderId, ttlMs]);
    return result.rows[0] || null;
  }
  async heartbeatLease(name, holderId, ttlMs) {
    const result = await this.pool.query(`UPDATE collector_leases SET heartbeat_at=now(),expires_at=now()+($3||' milliseconds')::interval
      WHERE lease_name=$1 AND holder_id=$2 AND expires_at>now() RETURNING *`, [name, holderId, ttlMs]); return result.rows[0] || null;
  }
  async saveRaw(response, meta) {
    const rawPayloadId = meta.rawPayloadId || randomUUID();
    const result = await this.pool.query(`INSERT INTO raw_payloads(raw_payload_id,request_id,source_id,endpoint_id,fetched_at,http_status,response_headers,payload,content_hash,schema_version,quality_state)
      VALUES($1,$2,$3,$4,to_timestamp($5/1000.0),$6,$7,$8,$9,$10,$11) ON CONFLICT(request_id,content_hash) DO NOTHING RETURNING raw_payload_id`,
      [rawPayloadId, response.requestId, meta.sourceId, meta.endpointId, response.receivedAt, response.status, response.headers, response.body, meta.contentHash, meta.schemaVersion, meta.qualityState]);
    return result.rows[0]?.raw_payload_id || rawPayloadId;
  }
  async upsertMarketBars(bars) {
    let inserted = 0;
    await this.transaction(async client => {
      for (const b of bars) {
        const result = await client.query(`INSERT INTO market_bars(source_id,endpoint_id,instrument,market_type,interval_name,open_time,close_time,open,high,low,close,volume,quote_volume,trade_count,taker_buy_base_volume,taker_buy_quote_volume,observation_start,observation_end,published_at,available_at,first_available_at,fetched_at,revision_number,vintage_id,raw_payload_id,request_id,schema_version,normalizer_version,quality_state,content_hash)
          VALUES($1,$2,$3,$4,$5,to_timestamp($6/1000.0),to_timestamp($7/1000.0),$8,$9,$10,$11,$12,$13,$14,$15,$16,to_timestamp($6/1000.0),to_timestamp($7/1000.0),to_timestamp($7/1000.0),to_timestamp($7/1000.0),to_timestamp($17/1000.0),to_timestamp($18/1000.0),$19,$20,$21,$22,$23,$24,$25,$26)
          ON CONFLICT(source_id,market_type,instrument,interval_name,open_time,revision_number) DO NOTHING RETURNING market_bar_id`,
          [b.sourceId,b.endpointId,b.instrument,b.marketType,b.interval,b.openTime,b.closeTime,b.open,b.high,b.low,b.close,b.volume,b.quoteVolume,b.tradeCount,b.takerBuyBaseVolume,b.takerBuyQuoteVolume,b.firstAvailableAt,b.fetchedAt,b.revisionNumber,b.vintageId,b.rawPayloadId,b.requestId,b.schemaVersion,b.normalizerVersion,b.qualityState,b.contentHash]);
        inserted += result.rowCount;
      }
    }); return { inserted, deduped: bars.length - inserted };
  }
  async savePointFacts(table, facts, columns) {
    if (!['funding_rates','open_interest','long_short_ratios','taker_flow'].includes(table)) throw new Error('INVALID_FACT_TABLE');
    let inserted = 0;
    await this.transaction(async client => {
      for (const fact of facts) {
        const names = columns.map(c => c[0]); const values = columns.map(c => c[1](fact));
        const sql = `INSERT INTO ${table}(${names.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT(vintage_id) DO NOTHING`;
        inserted += (await client.query(sql, values)).rowCount;
      }
    }); return { inserted, deduped: facts.length - inserted };
  }
  async listBars({ instrument, marketType='spot', interval, from, to, limit }) {
    const result = await this.pool.query(`SELECT * FROM market_bars WHERE instrument=$1 AND market_type=$2 AND interval_name=$3 AND open_time>=to_timestamp($4/1000.0) AND open_time<=to_timestamp($5/1000.0) ORDER BY open_time LIMIT $6`, [instrument,marketType,interval,from,to,limit]); return result.rows;
  }
  async saveGaps(rows) {
    const saved=[]; for(const g of rows){const result=await this.pool.query(`INSERT INTO data_gaps(gap_id,source_id,instrument,market_type,interval_name,start_open_time,end_open_time,missing_count,status,missing_reason,detected_at)
      VALUES($1,$2,$3,$4,$5,to_timestamp($6/1000.0),to_timestamp($7/1000.0),$8,'OPEN',$9,now()) ON CONFLICT(source_id,instrument,market_type,interval_name,start_open_time,end_open_time) DO UPDATE SET updated_at=now() RETURNING *`,[g.gapId,g.sourceId,g.instrument,g.marketType,g.interval,g.startOpenTime,g.endOpenTime,g.missingCount,g.missingReason||null]);saved.push(result.rows[0]);} return saved;
  }
  async createBackfill(gap) { const jobId=`backfill:${gap.gap_id||gap.gapId}`;return (await this.pool.query(`INSERT INTO backfill_jobs(job_id,gap_id,status,next_attempt_at) VALUES($1,$2,'PENDING',now()) ON CONFLICT(job_id) DO UPDATE SET updated_at=now() RETURNING *`,[jobId,gap.gap_id||gap.gapId])).rows[0]; }
  async resolveGap(id) { return (await this.pool.query(`UPDATE data_gaps SET status='RESOLVED',resolved_at=now(),updated_at=now() WHERE gap_id=$1 RETURNING *`,[id])).rows[0]||null; }
  async listSimple(table, { instrument, from, to, limit }) {
    const allowed = { funding_rates: 'observation_time', open_interest: 'observation_time' }; const time = allowed[table]; if (!time) throw new Error('INVALID_TABLE');
    return (await this.pool.query(`SELECT * FROM ${table} WHERE instrument=$1 AND ${time}>=to_timestamp($2/1000.0) AND ${time}<=to_timestamp($3/1000.0) ORDER BY ${time} DESC LIMIT $4`, [instrument,from,to,limit])).rows;
  }
  async listGaps(limit=100) { return (await this.pool.query('SELECT * FROM data_gaps ORDER BY detected_at DESC LIMIT $1',[limit])).rows; }
  async listSources() { return (await this.pool.query('SELECT * FROM source_registry ORDER BY source_id')).rows; }
  async latestHealth() { return (await this.pool.query('SELECT DISTINCT ON(dataset_key) * FROM data_health_snapshots ORDER BY dataset_key,evaluated_at DESC')).rows; }
  async saveHealth(snapshot) {
    await this.pool.query(`INSERT INTO data_health_snapshots(source_id,dataset_key,health_state,latest_success_at,latest_data_at,data_age_ms,expected_frequency_ms,missing_count,duplicate_count,anomaly_count,consecutive_failures,last_http_status,rate_limited,clock_offset_ms,pending_backfill_count,last_recovered_at,reasons,evaluated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[snapshot.sourceId||'collector',snapshot.datasetKey||'collector:overall',snapshot.state,snapshot.latestSuccessAt?new Date(snapshot.latestSuccessAt):null,snapshot.latestDataAt?new Date(snapshot.latestDataAt):null,snapshot.dataAgeMs||null,snapshot.expectedFrequencyMs||null,snapshot.missingCount||0,snapshot.duplicateCount||0,snapshot.anomalyCount||0,snapshot.consecutiveFailures||0,snapshot.lastHttpStatus||null,!!snapshot.rateLimited,snapshot.clockOffsetMs??null,snapshot.pendingBackfillCount||0,snapshot.lastRecoveredAt?new Date(snapshot.lastRecoveredAt):null,JSON.stringify(snapshot.reasons||[]),new Date(snapshot.evaluatedAt)]);
  }
  async close() { await this.pool.end(); }
}
