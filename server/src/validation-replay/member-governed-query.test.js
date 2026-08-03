import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRepository } from '../db/postgres.js';

test('R28.15/R28.16/R28.22 historical bar SQL is parameterized and manifest-governed before rows reach JavaScript', async () => {
  const calls = [];
  const pool = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
  const manifest = { memberVintageIds: ['btc-vintage', 'eth-vintage'], dataFrom: 1_700_000_000_000, dataTo: 1_700_100_000_000, fixedAsOf: 1_700_099_999_999 };
  await new PostgresRepository(pool).loadHistoricalFeatureInputs({ targetBarCloseTime: manifest.fixedAsOf, historicalAsOfTime: manifest.fixedAsOf, replayNowMs: manifest.fixedAsOf + 1, manifest });
  const barQueries = calls.filter(call => /FROM public\.market_bars/.test(call.sql));
  assert.equal(barQueries.length, 4);
  for (const { sql, values } of barQueries) {
    assert.match(sql, /instrument=\$1/);
    assert.match(sql, /interval_name=\$2/);
    assert.match(sql, /market_type=\$7/);
    assert.match(sql, /source_id=\$8/);
    assert.match(sql, /open_time>=to_timestamp\(\$9\/1000\.0\)/);
    assert.match(sql, /open_time<to_timestamp\(\$10\/1000\.0\)/);
    assert.match(sql, /close_time<=to_timestamp\(\$11\/1000\.0\)/);
    assert.match(sql, /vintage_id=ANY\(\$6::text\[\]\)/);
    assert.deepEqual(values[5], manifest.memberVintageIds);
    assert.equal(values[6], 'spot');
    assert.equal(values[7], 'binance-spot-rest');
  }
});

test('empty member identity array fails before any repository query', async () => {
  let queried = false;
  const repository = new PostgresRepository({ query: async () => { queried = true; return { rows: [] }; } });
  await assert.rejects(() => repository.loadHistoricalFeatureInputs({ manifest: { memberVintageIds: [] } }), error => error.code === 'DATASET_MANIFEST_MEMBERS_MISSING');
  assert.equal(queried, false);
});
