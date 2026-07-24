import { randomUUID } from 'node:crypto';
import { FeatureEngine } from './feature-engine.js';
import { FEATURE_SET_VERSION } from './feature-version.js';

export const FEATURE_GENERATOR_LEASE = 'feature-generator';
export const DEFAULT_FEATURE_TARGET = Object.freeze({ symbol: 'ETHUSDT', targetInterval: '15m' });

export class FeatureGeneratorService {
  constructor({
    repository,
    engine = null,
    holderId,
    serverTimeProvider,
    now = Date.now,
    leaseTtlMs = 60_000,
    pollMs = 15_000,
    batchSize = 32,
    logger = console
  }) {
    if (!repository || !holderId || typeof serverTimeProvider !== 'function') throw new Error('FeatureGeneratorService requires repository/holderId/serverTimeProvider');
    this.repository = repository;
    this.now = now;
    this.engine = engine || new FeatureEngine({ repository, now: () => Math.max(this.now(), this.activeAsOfTime || 0) });
    this.holderId = holderId;
    this.serverTimeProvider = serverTimeProvider;
    this.leaseTtlMs = leaseTtlMs;
    this.pollMs = pollMs;
    this.batchSize = batchSize;
    this.logger = logger;
    this.lease = null;
    this.running = false;
    this.leaseLost = false;
    this.timer = null;
    this.heartbeatTimer = null;
    this.inflight = new Set();
    this.abortController = new AbortController();
    this.activeAsOfTime = null;
  }

  async acquireLease() {
    const lease = await this.repository.acquireLease(FEATURE_GENERATOR_LEASE, this.holderId, this.leaseTtlMs);
    this.lease = lease || null;
    return this.lease;
  }

  requireLease() {
    if (!this.running || this.leaseLost || !this.lease) throw Object.assign(new Error('Feature generator is not an active lease holder'), { code: this.leaseLost ? 'LEASE_LOST' : 'FEATURE_GENERATOR_NOT_RUNNING' });
    return this.lease;
  }

  async start({ pollMs = this.pollMs, heartbeatIntervalMs = Math.floor(this.leaseTtlMs / 3) } = {}) {
    if (this.running) throw Object.assign(new Error('Feature generator already running'), { code: 'FEATURE_GENERATOR_ALREADY_RUNNING' });
    this.abortController = new AbortController();
    const lease = await this.acquireLease();
    if (!lease) throw Object.assign(new Error('Feature generator lease held'), { code: 'FEATURE_GENERATOR_LEASE_HELD' });
    this.running = true;
    this.leaseLost = false;
    this.scheduleHeartbeat(heartbeatIntervalMs);
    try {
      await this.runOnce();
      if (this.running) this.schedule(pollMs);
    } catch (error) {
      this.running = false;
      this.clearSchedulers();
      this.abortController.abort('startup-failed');
      if (this.lease && !this.leaseLost) await this.repository.releaseLease?.(this.lease).catch(() => {});
      this.lease = null;
      throw error;
    }
    return this.status();
  }

  schedule(intervalMs = this.pollMs) {
    const tick = async () => {
      if (!this.running) return;
      await this.runOnce().catch(error => this.logger?.error?.('feature generator scheduled cycle failed', { code: error.code || error.message }));
      if (this.running) this.timer = setTimeout(tick, intervalMs);
    };
    this.timer = setTimeout(tick, intervalMs);
  }

  scheduleHeartbeat(intervalMs = Math.floor(this.leaseTtlMs / 3)) {
    const tick = async () => {
      if (!this.running) return;
      try { await this.heartbeat(); }
      catch (error) { this.logger?.error?.('feature generator heartbeat failed', { code: error.code || error.message }); }
      if (this.running) this.heartbeatTimer = setTimeout(tick, intervalMs);
    };
    this.heartbeatTimer = setTimeout(tick, intervalMs);
  }

  async heartbeat() {
    const lease = this.requireLease();
    const renewed = await this.repository.heartbeatLease(lease.leaseName, lease.holderId, lease.fencingToken, this.leaseTtlMs);
    if (!renewed) {
      this.loseLease('LEASE_LOST');
      throw Object.assign(new Error('Feature generator lease lost'), { code: 'LEASE_LOST' });
    }
    this.lease = renewed;
    return renewed;
  }

  track(promise) {
    this.inflight.add(promise);
    promise.then(
      () => this.inflight.delete(promise),
      () => this.inflight.delete(promise)
    );
    return promise;
  }

  runOnce(options = {}) {
    return this.track(this.executeCycle(options));
  }

  async executeCycle({ symbol = DEFAULT_FEATURE_TARGET.symbol, targetInterval = DEFAULT_FEATURE_TARGET.targetInterval, batchSize = this.batchSize } = {}) {
    const lease = this.requireLease();
    const serverTime = await this.serverTimeProvider(this.abortController.signal);
    if (!serverTime?.ok || !Number.isFinite(serverTime.sourceServerTime)) {
      this.logger?.warn?.('feature generator blocked', { code: 'SERVER_TIME_UNAVAILABLE' });
      return { status: 'BLOCKED', reason: 'SERVER_TIME_UNAVAILABLE', results: [] };
    }
    const asOfTime = serverTime.sourceServerTime;
    this.activeAsOfTime = asOfTime;
    const targets = await this.repository.listPendingFeatureTargets({ symbol, targetInterval, asOfTime, featureSetVersion: FEATURE_SET_VERSION, limit: batchSize });
    if (!targets.length) return { status: 'SUCCEEDED', generated: 0, deduped: 0, revised: 0, blocked: 0, results: [] };

    const runId = randomUUID();
    const closeTimes = targets.map(target => Number(target.closeTime)).filter(Number.isFinite);
    const startedAt = Math.max(this.now(), asOfTime);
    const run = { runId, symbol, targetInterval, from: Math.min(...closeTimes), to: Math.max(...closeTimes), featureSetVersion: FEATURE_SET_VERSION, startedAt };
    await this.repository.startFeatureRun?.(run, lease);
    const results = [];
    try {
      for (const targetBarCloseTime of closeTimes) {
        if (!this.running || this.abortController.signal.aborted) break;
        try {
          results.push(await this.engine.generatePoint({ symbol, targetInterval, targetBarCloseTime, asOfTime, featureSetVersion: FEATURE_SET_VERSION }, lease));
        } catch (error) {
          if (error.code === 'FENCING_TOKEN_REJECTED' || error.code === 'LEASE_LOST') throw error;
          results.push({ status: 'BLOCKED', reason: error.code || 'FEATURE_GENERATION_FAILED' });
          this.logger?.warn?.('feature target blocked', { targetBarCloseTime, code: error.code || error.message });
        }
      }
      const blocked = results.filter(result => result.status === 'BLOCKED').length;
      // feature_generation_runs冻结枚举没有PARTIAL；本轮完成即SUCCEEDED，单目标阻断由blocked_count与results保留。
      const summary = { status: 'SUCCEEDED', results, cursorCloseTime: closeTimes.at(-1) };
      await this.repository.finishFeatureRun?.(runId, summary, lease);
      const count = status => results.filter(result => result.status === status).length;
      const output = { status: summary.status, generated: count('INSERTED'), deduped: count('DEDUPED'), revised: count('REVISED'), blocked, results };
      this.logger?.info?.('feature generator cycle completed', { runId, asOfTime, targetCount: closeTimes.length, status: output.status, generated: output.generated, deduped: output.deduped, revised: output.revised, blocked });
      return output;
    } catch (error) {
      await this.repository.finishFeatureRun?.(runId, { status: 'FAILED', errorCode: error.code || 'FEATURE_GENERATION_FAILED', results, cursorCloseTime: closeTimes.at(Math.max(0, results.length - 1)) }, lease).catch(() => {});
      if (error.code === 'FENCING_TOKEN_REJECTED' || error.code === 'LEASE_LOST') this.loseLease(error.code);
      throw error;
    } finally {
      this.activeAsOfTime = null;
    }
  }

  clearSchedulers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.timer = null;
    this.heartbeatTimer = null;
  }

  loseLease(reason = 'LEASE_LOST') {
    if (this.leaseLost) return;
    this.leaseLost = true;
    this.running = false;
    this.clearSchedulers();
    this.abortController.abort(reason);
  }

  async stop() {
    this.running = false;
    this.clearSchedulers();
    this.abortController.abort('shutdown');
    await Promise.allSettled([...this.inflight]);
    if (this.lease && !this.leaseLost) await this.repository.releaseLease?.(this.lease).catch(error => this.logger?.warn?.('feature generator lease release failed', { code: error.code || error.message }));
    this.lease = null;
  }

  status() {
    return {
      running: this.running,
      holderId: this.holderId,
      leaseLost: this.leaseLost,
      pendingOperations: this.inflight.size,
      lease: this.lease ? { leaseName: this.lease.leaseName, holderId: this.lease.holderId, fencingToken: this.lease.fencingToken, expiresAt: this.lease.expiresAt } : null
    };
  }
}
