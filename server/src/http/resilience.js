export class RateLimiter {
  constructor({ capacity = 120, refillPerSecond = 2, now = Date.now } = {}) {
    this.capacity = capacity; this.tokens = capacity; this.refillPerSecond = refillPerSecond; this.now = now; this.last = now();
  }
  take(cost = 1) {
    const current = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (current - this.last) * this.refillPerSecond / 1000);
    this.last = current;
    if (this.tokens < cost) return false;
    this.tokens -= cost; return true;
  }
  waitMs(cost = 1) {
    if (this.refillPerSecond <= 0) return Infinity;
    const missing = Math.max(0, cost - this.tokens);
    return Math.ceil(missing / this.refillPerSecond * 1000);
  }
  async acquire(cost = 1, { signal, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('Rate limit wait aborted'), { name: 'AbortError', code: 'ABORTED' });
    while (!this.take(cost)) {
      if (signal?.aborted) throw Object.assign(new Error('Rate limit wait aborted'), { name: 'AbortError', code: 'ABORTED' });
      const delay = Math.max(1, this.waitMs(cost));
      await Promise.race([sleep(delay), signal ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Rate limit wait aborted'), { name: 'AbortError', code: 'ABORTED' })), { once: true })) : new Promise(() => {})]);
    }
    if (signal?.aborted) throw Object.assign(new Error('Rate limit wait aborted'), { name: 'AbortError', code: 'ABORTED' });
    return true;
  }
}

export class CircuitBreaker {
  constructor({ threshold = 5, coolDownMs = 30_000, now = Date.now } = {}) {
    this.threshold = threshold; this.coolDownMs = coolDownMs; this.now = now; this.failures = 0; this.openedAt = null; this.state = 'CLOSED';
  }
  allow() {
    if (this.state !== 'OPEN') return true;
    if (this.now() - this.openedAt >= this.coolDownMs) { this.state = 'HALF_OPEN'; return true; }
    return false;
  }
  success() { this.failures = 0; this.openedAt = null; this.state = 'CLOSED'; }
  failure() { this.failures += 1; if (this.failures >= this.threshold) { this.state = 'OPEN'; this.openedAt = this.now(); } }
}

export function retryDelay(attempt, { baseMs = 250, capMs = 10_000, jitter = Math.random } = {}) {
  const raw = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(raw * (0.5 + jitter() * 0.5));
}

export function retryAfterMs(headers, fallback) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : fallback;
}
