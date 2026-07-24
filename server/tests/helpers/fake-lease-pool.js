// 测试专用：内存版collector_leases表 + 最小事务客户端，供ForecastGenerator/OutcomeEvaluator的
// 生命周期(start/heartbeat/release)与graceful shutdown测试直接复用，不接触真实PostgreSQL。
// 支持同表多行（按lease_name区分），与真实表结构语义一致：acquire在冲突时要求EXCLUDED.expires_at已过期
// 或holder_id相同才能抢占；release/heartbeat/assertLease均严格按lease_name+holder_id+fencing_token匹配。
export function createFakeLeasePool({ now = () => Date.now() } = {}) {
  const leases = new Map();

  async function query(sql, params = []) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };

    if (/^\s*INSERT INTO collector_leases/.test(sql)) {
      const [leaseName, holderId, ttlMs] = params;
      const current = leases.get(leaseName);
      const t = now();
      if (current && current.expiresAt > t && current.holderId !== holderId) return { rowCount: 0, rows: [] };
      const fencingToken = (current?.fencingToken || 0) + 1;
      const row = { leaseName, holderId, fencingToken, expiresAt: t + Number(ttlMs) };
      leases.set(leaseName, row);
      return { rowCount: 1, rows: [{ leaseName: row.leaseName, holderId: row.holderId, fencingToken: row.fencingToken, expiresAt: new Date(row.expiresAt) }] };
    }

    if (/^\s*UPDATE collector_leases SET heartbeat_at=clock_timestamp\(\),expires_at=clock_timestamp\(\)/.test(sql)) {
      const [leaseName, holderId, token, ttlMs] = params;
      const row = leases.get(leaseName);
      if (!row || row.holderId !== holderId || row.fencingToken !== Number(token) || row.expiresAt <= now()) return { rowCount: 0, rows: [] };
      row.expiresAt = now() + Number(ttlMs);
      return { rowCount: 1, rows: [{ leaseName, holderId, fencingToken: row.fencingToken, expiresAt: new Date(row.expiresAt) }] };
    }

    if (/^\s*UPDATE collector_leases SET expires_at=clock_timestamp\(\),heartbeat_at=clock_timestamp\(\)/.test(sql)) {
      const [leaseName, holderId, token] = params;
      const row = leases.get(leaseName);
      if (!row || row.holderId !== holderId || row.fencingToken !== Number(token)) return { rowCount: 0, rows: [] };
      row.expiresAt = now();
      row.released = (row.released || 0) + 1;
      return { rowCount: 1, rows: [{ leaseName, holderId, fencingToken: row.fencingToken, expiresAt: new Date(row.expiresAt) }] };
    }

    if (/SELECT fencing_token FROM collector_leases/.test(sql)) {
      const [leaseName, holderId, token] = params;
      const row = leases.get(leaseName);
      const ok = row && row.holderId === holderId && row.fencingToken === Number(token) && row.expiresAt > now();
      return { rowCount: ok ? 1 : 0, rows: ok ? [{ fencing_token: row.fencingToken }] : [] };
    }

    if (/^\s*INSERT INTO forecast_generation_runs/.test(sql)) return { rowCount: 1, rows: [] };
    if (/^\s*INSERT INTO forecast_evaluation_runs/.test(sql)) return { rowCount: 1, rows: [] };

    return { rowCount: 0, rows: [] };
  }

  return {
    query,
    connect: async () => ({ query, release() {} }),
    seedLease(leaseName, { holderId, fencingToken = 1, expiresAt }) {
      leases.set(leaseName, { leaseName, holderId, fencingToken, expiresAt });
    },
    getLease(leaseName) {
      return leases.get(leaseName) || null;
    },
    releaseCallCount(leaseName) {
      return leases.get(leaseName)?.released || 0;
    }
  };
}
