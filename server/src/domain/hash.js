import { createHash, randomUUID } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
export const requestId = () => randomUUID();
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function canonicalJsonStringify(value) {
  const seen = new Set();
  const encode = current => {
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw Object.assign(new TypeError('JSON number must be finite'), { code: 'RAW_JSON_UNSERIALIZABLE' });
      return JSON.stringify(current);
    }
    if (typeof current === 'undefined' || typeof current === 'bigint' || typeof current === 'function' || typeof current === 'symbol') {
      throw Object.assign(new TypeError(`Unsupported JSON type: ${typeof current}`), { code: 'RAW_JSON_UNSERIALIZABLE' });
    }
    if (seen.has(current)) throw Object.assign(new TypeError('Circular JSON value'), { code: 'RAW_JSON_CIRCULAR' });
    if (Array.isArray(current)) {
      seen.add(current); const result = `[${current.map(encode).join(',')}]`; seen.delete(current); return result;
    }
    if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      throw Object.assign(new TypeError('Only plain JSON objects are supported'), { code: 'RAW_JSON_UNSERIALIZABLE' });
    }
    seen.add(current);
    const result = `{${Object.keys(current).sort().map(key => `${JSON.stringify(key)}:${encode(current[key])}`).join(',')}}`;
    seen.delete(current); return result;
  };
  return encode(value);
}
export const canonicalJsonHash = value => sha256(canonicalJsonStringify(value));
