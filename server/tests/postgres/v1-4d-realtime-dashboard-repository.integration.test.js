// 实时看板新增只读仓储方法（PostgresRepository.latestBars/latestProvisionalBar/latestForecastSnapshot）
// 针对真实schema的最小回归——MemoryRepository版本的等价单元测试无法发现SQL语法/列名与真实表结构
// 不匹配的问题，本文件专门补齐这一层。使用隔离测试库（TEST_DATABASE_URL），绝不指向生产数据库；
// 每个用例单独BEGIN/ROLLBACK，测试结束不残留任何数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresRepository } from '../../src/db/postgres.js';
import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(TEST_DATABASE_URL);

async function withTxClient(fn) {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

async function insertRawPayload(client, { fetchedAt }) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO raw_payloads(raw_payload_id,request_id,source_id,endpoint_id,fetched_at,http_status,response_headers,payload,content_hash,schema_version,quality_state)
     VALUES($1,$2,'binance-spot-rest','binance-spot-klines',to_timestamp($3/1000.0),200,'{}'::jsonb,'[]'::jsonb,$4,'binance-kline-v1','NORMAL')`,
    [id, randomUUID(), fetchedAt, 'a'.repeat(64)]
  );
  return id;
}

test('PostgresRepository.latestBars：真实schema下按close_time倒序返回最近N根已完成K线并映射为camelCase毫秒时间戳', { skip }, async () => {
  await withTxClient(async client => {
    const rawPayloadId = await insertRawPayload(client, { fetchedAt: Date.UTC(2099, 0, 1) });
    const openTime = Date.UTC(2099, 0, 1, 0, 0, 0), closeTime = openTime + 900000 - 1;
    const openTime2 = openTime + 900000, closeTime2 = openTime2 + 900000 - 1;
    for (const [o, c, close] of [[openTime, closeTime, '3000.00'], [openTime2, closeTime2, '3010.00']]) {
      await client.query(
        `INSERT INTO market_bars(source_id,endpoint_id,instrument,market_type,interval_name,open_time,close_time,open,high,low,close,volume,quote_volume,
          observation_start,observation_end,published_at,available_at,first_available_at,fetched_at,revision_number,vintage_id,raw_payload_id,request_id,
          schema_version,normalizer_version,quality_state,content_hash)
         VALUES('binance-spot-rest','binance-spot-klines','ETHUSDT','spot','15m',to_timestamp($1/1000.0),to_timestamp($2/1000.0),$3,$3,$3,$3,'1','1',
          to_timestamp($1/1000.0),to_timestamp($2/1000.0),to_timestamp($2/1000.0),to_timestamp($2/1000.0),to_timestamp($2/1000.0),to_timestamp($2/1000.0),
          0,$4,$5,$6,'v1.4a-server-schema-1','v1.4a-normalizer-1','NORMAL',$7)`,
        [o, c, close, `latest-bars-test-${o}`, rawPayloadId, randomUUID(), `${'b'.repeat(63)}${o % 10}`]
      );
    }
    const repo = new PostgresRepository(client);
    const rows = await repo.latestBars({ instrument: 'ETHUSDT', marketType: 'spot', interval: '15m', limit: 2 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].closeTime, closeTime2, '倒序返回，第一条应为最新收盘K线');
    assert.equal(rows[0].close, 3010);
    assert.equal(rows[1].close, 3000);
    assert.equal(rows[0].openTime, openTime2);
  });
});

test('PostgresRepository.latestProvisionalBar：真实schema下只返回未被促升（promoted_market_bar_id IS NULL）的最新进行中K线', { skip }, async () => {
  await withTxClient(async client => {
    const rawPayloadId = await insertRawPayload(client, { fetchedAt: Date.UTC(2099, 0, 2) });
    const openTime = Date.UTC(2099, 0, 2, 0, 0, 0), closeTime = openTime + 900000 - 1;
    for (const [fetchedAt, close, hash] of [[openTime + 30000, '3050.00', 'c'.repeat(64)], [openTime + 60000, '3055.00', 'd'.repeat(64)]]) {
      await client.query(
        `INSERT INTO provisional_market_bars(source_id,endpoint_id,instrument,market_type,interval_name,open_time,close_time,open,high,low,close,volume,quote_volume,fetched_at,raw_payload_id,content_hash,expires_at)
         VALUES('binance-spot-rest','binance-spot-klines','ETHUSDT','spot','15m',to_timestamp($1/1000.0),to_timestamp($2/1000.0),$3,$3,$3,$3,'1','1',to_timestamp($4/1000.0),$5,$6,to_timestamp($4/1000.0)+interval '1 day')`,
        [openTime, closeTime, close, fetchedAt, rawPayloadId, hash]
      );
    }
    const repo = new PostgresRepository(client);
    const row = await repo.latestProvisionalBar({ instrument: 'ETHUSDT', marketType: 'spot', interval: '15m' });
    assert.ok(row);
    assert.equal(row.close, 3055, '同一open_time多条快照中应取fetched_at最新一条');
    assert.equal(row.openTime, openTime);
  });
});

test('PostgresRepository.latestProvisionalBar：已促升（promoted_market_bar_id已回填）的行不作为当前进行中K线返回', { skip }, async () => {
  await withTxClient(async client => {
    const rawPayloadId = await insertRawPayload(client, { fetchedAt: Date.UTC(2099, 0, 3) });
    const openTime = Date.UTC(2099, 0, 3, 0, 0, 0), closeTime = openTime + 900000 - 1;
    await client.query(
      `INSERT INTO market_bars(source_id,endpoint_id,instrument,market_type,interval_name,open_time,close_time,open,high,low,close,volume,quote_volume,
        observation_start,observation_end,published_at,available_at,first_available_at,fetched_at,revision_number,vintage_id,raw_payload_id,request_id,
        schema_version,normalizer_version,quality_state,content_hash)
       VALUES('binance-spot-rest','binance-spot-klines','ETHUSDT','spot','15m',to_timestamp($1/1000.0),to_timestamp($2/1000.0),'3000','3000','3000','3000','1','1',
        to_timestamp($1/1000.0),to_timestamp($2/1000.0),to_timestamp($2/1000.0),to_timestamp($2/1000.0),to_timestamp($2/1000.0),to_timestamp($2/1000.0),
        0,'promoted-test-vintage',$3,$4,'v1.4a-server-schema-1','v1.4a-normalizer-1','NORMAL',$5)
       RETURNING market_bar_id`,
      [openTime, closeTime, rawPayloadId, randomUUID(), 'e'.repeat(64)]
    );
    const marketBarId = (await client.query('SELECT market_bar_id FROM market_bars WHERE vintage_id=$1', ['promoted-test-vintage'])).rows[0].market_bar_id;
    await client.query(
      `INSERT INTO provisional_market_bars(source_id,endpoint_id,instrument,market_type,interval_name,open_time,close_time,open,high,low,close,volume,quote_volume,fetched_at,raw_payload_id,content_hash,expires_at,promoted_market_bar_id)
       VALUES('binance-spot-rest','binance-spot-klines','ETHUSDT','spot','15m',to_timestamp($1/1000.0),to_timestamp($2/1000.0),'3000','3000','3000','3000','1','1',to_timestamp($1/1000.0),$3,$4,to_timestamp($1/1000.0)+interval '1 day',$5)`,
      [openTime, closeTime, rawPayloadId, 'f'.repeat(64), marketBarId]
    );
    const repo = new PostgresRepository(client);
    const row = await repo.latestProvisionalBar({ instrument: 'ETHUSDT', marketType: 'spot', interval: '15m' });
    assert.equal(row, null, '已促升为正式K线的进行中快照不应再被当作"当前进行中K线"返回');
  });
});

test('PostgresRepository.latestForecastSnapshot：真实schema下按generated_at取instrument+horizon最新一条并完整映射三向概率/目标区间/触发失效条件', { skip }, async () => {
  await withTxClient(async client => {
    const runId = randomUUID();
    await client.query(
      `INSERT INTO forecast_generation_runs(generation_run_id,lease_name,status,instrument,horizon,generated_count,started_at,finished_at)
       VALUES($1,'forecast-generator','SUCCEEDED','ETHUSDT','24h',1,to_timestamp($2/1000.0),to_timestamp($2/1000.0))`,
      [runId, Date.UTC(2099, 0, 4)]
    );
    const generatedAtOld = Date.UTC(2099, 0, 4, 0, 0, 0), generatedAtNew = Date.UTC(2099, 0, 4, 4, 0, 0);
    for (const [generatedAt, predictionId, referencePrice] of [[generatedAtOld, 'GMKG-SRV-ETHUSDT-24h-old', '3000'], [generatedAtNew, 'GMKG-SRV-ETHUSDT-24h-new', '3100']]) {
      const targetStart = generatedAt, targetEnd = targetStart + 96 * 900000;
      await client.query(
        `INSERT INTO forecast_snapshots(
          prediction_id,instrument,horizon,generated_at,data_cutoff_time,target_start_time,target_end_time,reference_price,reference_bar_ref,target_bar_ref,
          expected_bar_count,expected_direction,direction_threshold,raw_threshold,threshold_floor,threshold_ceiling,threshold_formula_version,
          atr14_four_hour_at_generation,target_state_at_generation,proxy_state_at_generation,fusion_state_at_generation,candidate_trajectories,
          scenario_weight_baseline,scenario_weight_upside,scenario_weight_downside,probability_status,calibrated_probabilities,expected_price_zones,
          trigger_conditions,invalidation_conditions,algorithm_version,weight_version,dataset_version,data_vintage_refs,feature_values_used,
          feature_record_ids,feature_engine_version,content_hash,auxiliary_evidence,source_origin,generation_run_id,lease_name,fencing_token
        ) VALUES($1,'ETHUSDT','24h',to_timestamp($2/1000.0),to_timestamp($2/1000.0),to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,'{}'::jsonb,'{}'::jsonb,
          96,'UP',0.02,0.02,0.008,0.05,'v1',10,'UNKNOWN','PO_TREND_UP_STRUCTURE','UNKNOWN','{}'::jsonb,
          30,50,20,'rule_based',null,$6::jsonb,
          $7::jsonb,$8::jsonb,'v1','v1','v1','[]'::jsonb,'{}'::jsonb,
          '[]'::jsonb,'v1',$9,'{}'::jsonb,'SERVER',$10,'forecast-generator',1)`,
        [
          predictionId, generatedAt, targetStart, targetEnd, referencePrice,
          JSON.stringify({ baseline: [Number(referencePrice) * 0.99, Number(referencePrice) * 1.01], upside: [Number(referencePrice) * 1.02, Number(referencePrice) * 1.04], downside: [Number(referencePrice) * 0.96, Number(referencePrice) * 0.98] }),
          JSON.stringify(['upside触发确认']), JSON.stringify(['baseline/upside证据减弱']),
          'g'.repeat(64),
          runId
        ]
      );
    }
    const repo = new PostgresRepository(client);
    const snapshot = await repo.latestForecastSnapshot({ instrument: 'ETHUSDT', horizon: '24h' });
    assert.equal(snapshot.predictionId, 'GMKG-SRV-ETHUSDT-24h-new', '必须取generated_at最新一条，不是插入顺序最后一条恰好相同的巧合');
    assert.equal(snapshot.referencePrice, 3100);
    assert.deepEqual(snapshot.scenarioWeights, { baseline: 30, upside: 50, downside: 20 });
    assert.equal(snapshot.probabilityStatus, 'rule_based');
    assert.deepEqual(snapshot.expectedPriceZones.upside, [3100 * 1.02, 3100 * 1.04]);
    assert.deepEqual(snapshot.triggerConditions, ['upside触发确认']);
    assert.deepEqual(snapshot.invalidationConditions, ['baseline/upside证据减弱']);
  });
});

test('PostgresRepository.latestForecastSnapshot：instrument或horizon不匹配的历史快照不会误串', { skip }, async () => {
  await withTxClient(async client => {
    const runId = randomUUID();
    await client.query(
      `INSERT INTO forecast_generation_runs(generation_run_id,lease_name,status,instrument,horizon,generated_count,started_at,finished_at)
       VALUES($1,'forecast-generator','SUCCEEDED','ETHUSDT','72h',1,to_timestamp($2/1000.0),to_timestamp($2/1000.0))`,
      [runId, Date.UTC(2099, 0, 5)]
    );
    const generatedAt = Date.UTC(2099, 0, 5), targetStart = generatedAt, targetEnd = targetStart + 288 * 900000;
    await client.query(
      `INSERT INTO forecast_snapshots(
        prediction_id,instrument,horizon,generated_at,data_cutoff_time,target_start_time,target_end_time,reference_price,reference_bar_ref,target_bar_ref,
        expected_bar_count,expected_direction,direction_threshold,raw_threshold,threshold_floor,threshold_ceiling,threshold_formula_version,
        atr14_four_hour_at_generation,target_state_at_generation,proxy_state_at_generation,fusion_state_at_generation,candidate_trajectories,
        scenario_weight_baseline,scenario_weight_upside,scenario_weight_downside,probability_status,calibrated_probabilities,expected_price_zones,
        trigger_conditions,invalidation_conditions,algorithm_version,weight_version,dataset_version,data_vintage_refs,feature_values_used,
        feature_record_ids,feature_engine_version,content_hash,auxiliary_evidence,source_origin,generation_run_id,lease_name,fencing_token
      ) VALUES('GMKG-SRV-ETHUSDT-72h-only','ETHUSDT','72h',to_timestamp($1/1000.0),to_timestamp($1/1000.0),to_timestamp($2/1000.0),to_timestamp($3/1000.0),3200,'{}'::jsonb,'{}'::jsonb,
        288,'RANGE',0.03,0.03,0.015,0.08,'v1',10,'UNKNOWN','PO_UNKNOWN','UNKNOWN','{}'::jsonb,
        50,25,25,'rule_based',null,'{"baseline":[3168,3232],"upside":[3264,3328],"downside":[3072,3136]}'::jsonb,
        '["t"]'::jsonb,'["i"]'::jsonb,'v1','v1','v1','[]'::jsonb,'{}'::jsonb,
        '[]'::jsonb,'v1',$4,'{}'::jsonb,'SERVER',$5,'forecast-generator',1)`,
      [generatedAt, targetStart, targetEnd, 'h'.repeat(64), runId]
    );
    const repo = new PostgresRepository(client);
    assert.equal(await repo.latestForecastSnapshot({ instrument: 'ETHUSDT', horizon: '24h' }), null, '不同horizon不得误返回');
    assert.equal(await repo.latestForecastSnapshot({ instrument: 'BTCUSDT', horizon: '72h' }), null, '不同instrument不得误返回');
    const own = await repo.latestForecastSnapshot({ instrument: 'ETHUSDT', horizon: '72h' });
    assert.equal(own.predictionId, 'GMKG-SRV-ETHUSDT-72h-only');
  });
});
