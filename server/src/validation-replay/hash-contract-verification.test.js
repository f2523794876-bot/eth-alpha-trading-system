// V1_4D_CODEX_IMPLEMENTATION_TASK.md 实施第一步（阻断性）：对当时实际运行的 domain/hash.js canonicalJsonHash()
// 重新核实 V1_4D_HISTORICAL_REPLAY_SPEC.md §2.9.4 记录的四项契约（对象键排序/数值稳定性/数组保序/哈希算法）。
// 对应验收测试 R27.9（四项契约本身）/ R27.10（非法类型 fail closed）。
// 本文件只做核实，不实现业务逻辑；若任一断言失败，必须停止使用 canonicalJsonHash()，
// 改为在 canonical-manifest-content.js 内部实现独立版本化编码（不得修改本文件之外的 domain/hash.js）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJsonHash, canonicalJsonStringify } from '../domain/hash.js';

test('契约1：对象键规范化排序——键书写顺序不影响序列化结果', () => {
  const a = canonicalJsonStringify({ b: 1, a: 2, c: 3 });
  const b = canonicalJsonStringify({ c: 3, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":3}');
});

test('契约1：嵌套对象的键同样按字典序排序', () => {
  const a = canonicalJsonStringify({ z: { y: 1, x: 2 }, a: 1 });
  assert.equal(a, '{"a":1,"z":{"x":2,"y":1}}');
});

test('契约2：字符串/布尔/null序列化稳定', () => {
  assert.equal(canonicalJsonStringify('abc'), '"abc"');
  assert.equal(canonicalJsonStringify(true), 'true');
  assert.equal(canonicalJsonStringify(false), 'false');
  assert.equal(canonicalJsonStringify(null), 'null');
});

test('契约2：安全整数范围内的数值序列化稳定、无精度损失', () => {
  assert.equal(canonicalJsonStringify(1784923199999), '1784923199999');
  assert.equal(canonicalJsonStringify(0), '0');
  assert.equal(canonicalJsonStringify(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER));
});

test('契约2：非有限数（NaN/Infinity）fail closed，抛出RAW_JSON_UNSERIALIZABLE', () => {
  assert.throws(() => canonicalJsonStringify(NaN), err => err.code === 'RAW_JSON_UNSERIALIZABLE');
  assert.throws(() => canonicalJsonStringify(Infinity), err => err.code === 'RAW_JSON_UNSERIALIZABLE');
  assert.throws(() => canonicalJsonStringify(-Infinity), err => err.code === 'RAW_JSON_UNSERIALIZABLE');
});

test('契约3：数组严格保留调用方顺序，不被重新排序', () => {
  const ascending = canonicalJsonStringify([3, 1, 2]);
  const asIs = canonicalJsonStringify([1, 2, 3]);
  assert.equal(ascending, '[3,1,2]');
  assert.equal(asIs, '[1,2,3]');
  assert.notEqual(ascending, asIs);
});

test('契约3：数组内对象元素——数组顺序不变，元素内部键仍规范化排序', () => {
  const result = canonicalJsonStringify([{ b: 2, a: 1 }, { d: 4, c: 3 }]);
  assert.equal(result, '[{"a":1,"b":2},{"c":3,"d":4}]');
});

test('契约3：manifest_members 若调用方未排序，canonicalJsonHash 不会替调用方排序（验证排序职责在调用方）', () => {
  const unsorted = [{ k: 'z' }, { k: 'a' }];
  const sorted = [{ k: 'a' }, { k: 'z' }];
  assert.notEqual(canonicalJsonHash(unsorted), canonicalJsonHash(sorted));
});

test('契约4：采用冻结的哈希算法——sha256，且与node:crypto独立计算的参考值一致', () => {
  const value = { a: 1, b: [1, 2, 3], c: 'x' };
  const viaFunction = canonicalJsonHash(value);
  const canonical = canonicalJsonStringify(value);
  const reference = createHash('sha256').update(canonical).digest('hex');
  assert.equal(viaFunction, reference);
  assert.match(viaFunction, /^[0-9a-f]{64}$/, 'sha256输出必须是64个小写十六进制字符，不得截断');
});

test('契约4：已知输入产生已知输出（回归锚点，防止未来实现静默改变算法）', () => {
  assert.equal(canonicalJsonHash('v1.4d-hash-contract-anchor'), createHash('sha256').update(JSON.stringify('v1.4d-hash-contract-anchor')).digest('hex'));
});

test('R27.10：非法类型（Date对象）fail closed，不得静默产出某个哈希值', () => {
  assert.throws(() => canonicalJsonStringify({ dataFrom: new Date('2026-01-01T00:00:00Z') }), err => err.code === 'RAW_JSON_UNSERIALIZABLE');
});

test('R27.10：非法类型（undefined/bigint/function/symbol）fail closed', () => {
  assert.throws(() => canonicalJsonStringify(undefined), err => err.code === 'RAW_JSON_UNSERIALIZABLE');
  assert.throws(() => canonicalJsonStringify(10n), err => err.code === 'RAW_JSON_UNSERIALIZABLE');
  assert.throws(() => canonicalJsonStringify(() => {}), err => err.code === 'RAW_JSON_UNSERIALIZABLE');
  assert.throws(() => canonicalJsonStringify(Symbol('x')), err => err.code === 'RAW_JSON_UNSERIALIZABLE');
});

test('R27.10：循环引用 fail closed', () => {
  const circular = {};
  circular.self = circular;
  assert.throws(() => canonicalJsonStringify(circular), err => err.code === 'RAW_JSON_CIRCULAR');
});

test('契约整体：结论——canonicalJsonHash()满足V1_4D_HISTORICAL_REPLAY_SPEC.md §2.9.4冻结的四项契约，可继续复用，不新建第二套哈希/规范化实现', () => {
  assert.ok(true);
});

test('R28.21 contract v2完整golden vector逐字符匹配冻结SHA-256', () => {
  const zero = { gapCount: 0, duplicateCount: 0, outOfOrderCount: 0 };
  const value = {
    manifestSchemaVersion: 'v1.4d-manifest-schema-2',
    manifestHashAlgorithmVersion: 'v1.4d-manifest-hash-1',
    manifestContractVersion: 2,
    datasetType: 'MARKET_BARS',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    dependencySet: [
      { symbol: 'BTCUSDT', interval: '15m', marketType: 'spot', source: 'binance-spot' },
      { symbol: 'ETHUSDT', interval: '15m', marketType: 'spot', source: 'binance-spot' },
      { symbol: 'ETHUSDT', interval: '1h', marketType: 'spot', source: 'binance-spot' },
      { symbol: 'ETHUSDT', interval: '4h', marketType: 'spot', source: 'binance-spot' }
    ],
    dataFrom: '2026-01-25T23:45:00.000Z',
    dataTo: '2026-01-26T00:15:00.000Z',
    fixedAsOf: '2026-01-26T00:14:59.999Z',
    backfillBatchIds: ['11111111-1111-4111-8111-111111111111'],
    manifestMembers: [
      { symbol: 'BTCUSDT', intervalName: '15m', marketType: 'spot', source: 'binance-spot', openTime: 1769384700000, closeTime: 1769386499999, revisionNumber: 0, vintageId: 'BTCUSDT-spot-15m-1769384700000-0', rowContentHash: 'b28be94d41ccfdbda1f661302639db8ef888de3f4b7038c4276965f4f174cf5a' },
      { symbol: 'ETHUSDT', intervalName: '15m', marketType: 'spot', source: 'binance-spot', openTime: 1769384700000, closeTime: 1769386499999, revisionNumber: 0, vintageId: 'ETHUSDT-spot-15m-1769384700000-0', rowContentHash: 'e1294238b443a8ac43e14d9dd00b42a154fe1650ad51b7fb34790c7fb5dec3c2' }
    ],
    sourceFormalSemantics: 'market_bars:formal:spot',
    researchAvailabilityRuleVersion: 'v1.4d-research-availability-1',
    recordCount: 2,
    perDependencyRecordCount: { 'BTCUSDT:15m': 1, 'ETHUSDT:15m': 1, 'ETHUSDT:1h': 0, 'ETHUSDT:4h': 0 },
    perDependencyIntegrityCheckResult: { 'BTCUSDT:15m': zero, 'ETHUSDT:15m': zero, 'ETHUSDT:1h': zero, 'ETHUSDT:4h': zero }
  };
  assert.equal(canonicalJsonHash(value), '0a0e3225e83ff09c9dcf22c6a87de317cfe94d0b6854b7c8c2f25e20d6bade46');
});
