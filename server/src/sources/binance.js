import { INTERVALS, SYMBOLS } from '../domain/constants.js';

const allowed = (value, values, label) => { if (!values.includes(value)) throw new Error(`INVALID_${label}`); return value; };
const query = values => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

export class BinancePublicAdapter {
  constructor({ client, spotBaseUrl = 'https://api.binance.com', futuresBaseUrl = 'https://fapi.binance.com' }) {
    this.client = client; this.spotBaseUrl = spotBaseUrl; this.futuresBaseUrl = futuresBaseUrl;
  }
  serverTime(options = {}) { return this.client.getJson(`${this.spotBaseUrl}/api/v3/time`, { weight: 1, endpointId: 'binance-spot-time', signal: options.signal }); }
  spotKlines(symbol, interval, options = {}) {
    return this.client.getJson(`${this.spotBaseUrl}/api/v3/klines?${query({ symbol: allowed(symbol, SYMBOLS, 'SYMBOL'), interval: allowed(interval, INTERVALS, 'INTERVAL'), startTime: options.startTime, endTime: options.endTime, limit: Math.min(options.limit || 500, 1000) })}`, { weight: 2, endpointId: 'binance-spot-klines', signal: options.signal });
  }
  futuresKlines(symbol, interval, options = {}) {
    return this.client.getJson(`${this.futuresBaseUrl}/fapi/v1/klines?${query({ symbol: allowed(symbol, SYMBOLS, 'SYMBOL'), interval: allowed(interval, INTERVALS, 'INTERVAL'), startTime: options.startTime, endTime: options.endTime, limit: Math.min(options.limit || 500, 1500) })}`, { weight: 5, endpointId: 'binance-futures-klines', signal: options.signal });
  }
  fundingRates(symbol, options = {}) {
    return this.client.getJson(`${this.futuresBaseUrl}/fapi/v1/fundingRate?${query({ symbol: allowed(symbol, SYMBOLS, 'SYMBOL'), startTime: options.startTime, endTime: options.endTime, limit: Math.min(options.limit || 100, 1000) })}`, { weight: 1, endpointId: 'binance-futures-funding-rate', signal: options.signal });
  }
  openInterest(symbol, options = {}) { return this.client.getJson(`${this.futuresBaseUrl}/fapi/v1/openInterest?${query({ symbol: allowed(symbol, SYMBOLS, 'SYMBOL') })}`, { weight: 1, endpointId: 'binance-futures-open-interest', signal: options.signal }); }
  longShortRatio(symbol, period = '15m', limit = 30, options = {}) {
    return this.client.getJson(`${this.futuresBaseUrl}/futures/data/globalLongShortAccountRatio?${query({ symbol: allowed(symbol, SYMBOLS, 'SYMBOL'), period: allowed(period, INTERVALS, 'INTERVAL'), limit: Math.min(limit, 500) })}`, { weight: 1, endpointId: 'binance-futures-global-long-short', signal: options.signal });
  }
  takerFlow(symbol, period = '15m', limit = 30, options = {}) {
    return this.client.getJson(`${this.futuresBaseUrl}/futures/data/takerlongshortRatio?${query({ symbol: allowed(symbol, SYMBOLS, 'SYMBOL'), period: allowed(period, INTERVALS, 'INTERVAL'), limit: Math.min(limit, 500) })}`, { weight: 1, endpointId: 'binance-futures-taker-flow', signal: options.signal });
  }
}

export const SOURCE_REGISTRY = Object.freeze({
  spot: { sourceId: 'binance-spot-rest', marketType: 'spot', official: true, auth: 'NONE' },
  futures: { sourceId: 'binance-usdt-futures-rest', marketType: 'usdt_perpetual', official: true, auth: 'NONE' },
  macro: { sourceId: 'macro-adapter-placeholder', marketType: 'macro', status: 'UNAVAILABLE', reason: 'V1.4A未冻结无需密钥的官方宏观来源' }
});
