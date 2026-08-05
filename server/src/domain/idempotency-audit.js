// V1.4D unified fix: read-only idempotency-conflict detection.
// market_bars uses vintage_id = `${instrument}-${marketType}-${interval}-${closeTime}-rev0`
// (deterministic from identity, NOT from content) with `ON CONFLICT(vintage_id) DO NOTHING`.
// That means a second write for the same logical bar with *different* OHLCV content is silently
// dropped today, with no signal. This module finds any such case after the fact by grouping on
// the logical bar identity and checking whether more than one distinct content_hash exists for it.
// feature_records already has an application-level guard (saveHistoricalFeatureRecord throws
// HISTORICAL_FEATURE_CONFLICT on mismatch) — this module re-verifies that guarantee held by
// scanning for any residual same-key/different-hash rows regardless of how they got there.

export async function findMarketBarContentConflicts(pool, { instrument, marketType, intervalName } = {}) {
  const conditions = [];
  const params = [];
  if (instrument) { params.push(instrument); conditions.push(`instrument=$${params.length}`); }
  if (marketType) { params.push(marketType); conditions.push(`market_type=$${params.length}`); }
  if (intervalName) { params.push(intervalName); conditions.push(`interval_name=$${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT instrument, market_type, interval_name, open_time, close_time,
            count(*) AS row_count, count(DISTINCT content_hash) AS distinct_hashes,
            array_agg(DISTINCT vintage_id) AS vintage_ids, array_agg(DISTINCT content_hash) AS content_hashes
     FROM public.market_bars
     ${where}
     GROUP BY instrument, market_type, interval_name, open_time, close_time
     HAVING count(DISTINCT content_hash) > 1
     ORDER BY instrument, interval_name, open_time`,
    params
  );
  return result.rows.map(row => ({
    instrument: row.instrument, marketType: row.market_type, intervalName: row.interval_name,
    openTime: row.open_time, closeTime: row.close_time, rowCount: Number(row.row_count),
    distinctContentHashes: Number(row.distinct_hashes), vintageIds: row.vintage_ids, contentHashes: row.content_hashes
  }));
}

export async function findFeatureRecordContentConflicts(pool, { symbol, targetInterval, featureSetVersion } = {}) {
  const conditions = [];
  const params = [];
  if (symbol) { params.push(symbol); conditions.push(`symbol=$${params.length}`); }
  if (targetInterval) { params.push(targetInterval); conditions.push(`target_interval=$${params.length}`); }
  if (featureSetVersion) { params.push(featureSetVersion); conditions.push(`feature_set_version=$${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT symbol, target_interval, target_bar_close_time, feature_set_version,
            count(*) AS row_count, count(DISTINCT content_hash) AS distinct_hashes,
            array_agg(DISTINCT feature_record_id) AS feature_record_ids, array_agg(DISTINCT content_hash) AS content_hashes
     FROM public.feature_records
     ${where}
     GROUP BY symbol, target_interval, target_bar_close_time, feature_set_version
     HAVING count(DISTINCT content_hash) > 1
     ORDER BY symbol, target_interval, target_bar_close_time`,
    params
  );
  return result.rows.map(row => ({
    symbol: row.symbol, targetInterval: row.target_interval, targetBarCloseTime: row.target_bar_close_time,
    featureSetVersion: row.feature_set_version, rowCount: Number(row.row_count),
    distinctContentHashes: Number(row.distinct_hashes), featureRecordIds: row.feature_record_ids, contentHashes: row.content_hashes
  }));
}

export async function buildIdempotencyAuditReport(pool, scope = {}) {
  const [marketBarConflicts, featureRecordConflicts] = await Promise.all([
    findMarketBarContentConflicts(pool, scope),
    findFeatureRecordContentConflicts(pool, scope)
  ]);
  return Object.freeze({
    generatedAt: new Date().toISOString(),
    marketBarConflictGroupCount: marketBarConflicts.length,
    marketBarConflictRecordCount: marketBarConflicts.reduce((sum, g) => sum + g.rowCount, 0),
    featureRecordConflictGroupCount: featureRecordConflicts.length,
    featureRecordConflictRecordCount: featureRecordConflicts.reduce((sum, g) => sum + g.rowCount, 0),
    sameIdDifferentContentCount: marketBarConflicts.reduce((sum, g) => sum + g.rowCount, 0)
      + featureRecordConflicts.reduce((sum, g) => sum + g.rowCount, 0),
    marketBarConflicts,
    featureRecordConflicts
  });
}
