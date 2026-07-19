import { createHash, randomUUID } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
export const requestId = () => randomUUID();
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
