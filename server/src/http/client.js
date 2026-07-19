import { requestId as makeRequestId } from '../domain/hash.js';
import { CircuitBreaker, RateLimiter, retryAfterMs, retryDelay } from './resilience.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(message, { status = null, retryable = false, code = 'HTTP_ERROR', detail = null } = {}) {
    super(message); this.name = 'HttpError'; this.status = status; this.retryable = retryable; this.code = code; this.detail = detail;
  }
}

export class PublicHttpClient {
  constructor(config = {}, dependencies = {}) {
    this.fetch = dependencies.fetch || globalThis.fetch;
    this.sleep = dependencies.sleep || sleep;
    this.now = dependencies.now || Date.now;
    this.timeoutMs = config.timeoutMs ?? 10_000; this.maxRetries = config.maxRetries ?? 3;
    this.backoffBaseMs = config.backoffBaseMs ?? 250; this.backoffCapMs = config.backoffCapMs ?? 10_000;
    this.limiter = dependencies.limiter || new RateLimiter(); this.breakers = dependencies.breakers || new Map(); this.breakerFactory = dependencies.breakerFactory || (() => new CircuitBreaker());
  }
  breakerFor(endpointId = 'default') { if (!this.breakers.has(endpointId)) this.breakers.set(endpointId, this.breakerFactory(endpointId)); return this.breakers.get(endpointId); }
  breakerStates() { return Object.fromEntries([...this.breakers].map(([id, breaker]) => [id, { state: breaker.state, failures: breaker.failures, openedAt: breaker.openedAt }])); }
  async getJson(url, { weight = 1, requestId = makeRequestId(), endpointId = 'default', signal } = {}) {
    const breaker = this.breakerFor(endpointId);
    if (!breaker.allow()) throw new HttpError('Circuit open', { retryable: true, code: 'CIRCUIT_OPEN' });
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal?.aborted) throw new HttpError('Request aborted', { retryable: false, code: 'ABORTED' });
      await this.limiter.acquire(weight, { signal, sleep: this.sleep });
      if (signal?.aborted) throw new HttpError('Request aborted', { retryable: false, code: 'ABORTED' });
      const startedAt = this.now(); const controller = new AbortController(); let timedOut=false; const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); const timeout = setTimeout(() => {timedOut=true;controller.abort();}, this.timeoutMs);
      try {
        const response = await this.fetch(url, { method: 'GET', signal: controller.signal, headers: { accept: 'application/json', 'user-agent': 'eth-alpha-v1.4a-collector' } });
        const receivedAt = this.now(); const text = await response.text();
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          const error = new HttpError(`Upstream HTTP ${response.status}`, { status: response.status, retryable, code: response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_HTTP', detail: text.slice(0, 500) });
          if (!retryable || attempt === this.maxRetries) throw error;
          await this.sleep(response.status === 429 ? retryAfterMs(response.headers, retryDelay(attempt, { baseMs: this.backoffBaseMs, capMs: this.backoffCapMs })) : retryDelay(attempt, { baseMs: this.backoffBaseMs, capMs: this.backoffCapMs }));
          continue;
        }
        let body; try { body = JSON.parse(text); } catch { throw new HttpError('Invalid upstream JSON', { code: 'INVALID_JSON' }); }
        breaker.success();
        return { body, requestId, status: response.status, headers: Object.fromEntries(response.headers.entries()), startedAt, receivedAt, roundTripMs: receivedAt - startedAt };
      } catch (error) {
        const normalized = error.name === 'AbortError' ? timedOut ? new HttpError('Request timeout', { retryable: true, code: 'TIMEOUT' }) : new HttpError('Request aborted', { retryable: false, code: 'ABORTED' }) : error;
        if (attempt === this.maxRetries || !normalized.retryable) { breaker.failure(); throw normalized; }
        await this.sleep(retryDelay(attempt, { baseMs: this.backoffBaseMs, capMs: this.backoffCapMs }));
      } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
    }
    throw new HttpError('Retry exhausted', { retryable: true, code: 'RETRY_EXHAUSTED' });
  }
}
