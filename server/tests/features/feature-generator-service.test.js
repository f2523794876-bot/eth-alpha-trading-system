import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MemoryRepository } from '../../src/db/memory.js';
import { FeatureGeneratorService, FEATURE_GENERATOR_LEASE } from '../../src/features/generator-service.js';
import { FEATURE_SET_VERSION } from '../../src/features/feature-version.js';

const BAR = 1_784_400_000_000;
const quietLogger = { info() {}, warn() {}, error() {} };
const time = value => async () => ({ ok: true, sourceServerTime: value });

function formalBar(closeTime) {
  return {
    natural: `binance-spot-rest:spot:ETHUSDT:15m:${closeTime - 899_999}`,
    instrument: 'ETHUSDT', marketType: 'spot', interval: '15m',
    openTime: closeTime - 899_999, closeTime, availableAt: closeTime, fetchedAt: closeTime,
    sourceId: 'binance-spot-rest', contentHash: `hash-${closeTime}`, vintageId: `bar-${closeTime}`,
    revisionNumber: 0
  };
}

function makeHarness({ now = BAR + 1000, generate = null } = {}) {
  const repository = new MemoryRepository({ requireLease: true, now: () => now });
  repository.bars.push(formalBar(BAR));
  const engine = {
    async generatePoint(input, lease) {
      repository.leaseOk(lease);
      if (generate) return generate(input, lease, repository);
      const record = {
        featureId: `feature-${input.targetBarCloseTime}`, symbol: input.symbol, targetInterval: input.targetInterval,
        targetBarCloseTime: input.targetBarCloseTime, featureSetVersion: input.featureSetVersion,
        contentHash: `feature-hash-${input.targetBarCloseTime}`, qualityState: 'HEALTHY',
        missingFeatures: [], degradedReasons: []
      };
      return repository.saveFeatureRecord(record, lease);
    }
  };
  const service = new FeatureGeneratorService({
    repository, engine, holderId: 'feature-worker-a', serverTimeProvider: time(now),
    now: () => now, leaseTtlMs: 60_000, pollMs: 60_000, logger: quietLogger
  });
  return { repository, service };
}

test('新正式15分钟K线入库后服务立即自动生成对应时间键特征', async () => {
  const { repository, service } = makeHarness();
  await service.start();
  assert.equal(repository.featureRecords.length, 1);
  assert.equal(repository.featureRecords[0].targetBarCloseTime, BAR);
  assert.equal(repository.featureRecords[0].featureSetVersion, FEATURE_SET_VERSION);
  await service.stop();
});

test('同一时间键重复执行不重复写入', async () => {
  const { repository, service } = makeHarness();
  await service.start();
  const second = await service.runOnce();
  assert.equal(second.generated, 0);
  assert.equal(repository.featureRecords.length, 1);
  await service.stop();
});

test('缺失正式K线时安全空转，不伪造特征', async () => {
  const { repository, service } = makeHarness();
  repository.bars.length = 0;
  await service.start();
  assert.equal(repository.featureRecords.length, 0);
  assert.equal(repository.featureRuns.length, 0);
  await service.stop();
});

test('租约被占用时第二实例不并发写入', async () => {
  const { repository, service } = makeHarness();
  await repository.acquireLease(FEATURE_GENERATOR_LEASE, 'other-worker', 60_000, BAR);
  await assert.rejects(service.start(), error => error.code === 'FEATURE_GENERATOR_LEASE_HELD');
  assert.equal(repository.featureRecords.length, 0);
});

test('过期租约可由新实例以更高fencing token接管', async () => {
  let now = BAR;
  const repository = new MemoryRepository({ requireLease: true, now: () => now });
  const first = await repository.acquireLease(FEATURE_GENERATOR_LEASE, 'old-worker', 10, now);
  now += 11;
  const service = new FeatureGeneratorService({
    repository, engine: { async generatePoint() { throw new Error('unexpected'); } },
    holderId: 'new-worker', serverTimeProvider: time(now), now: () => now, leaseTtlMs: 60_000, logger: quietLogger
  });
  await service.start();
  assert.ok(service.lease.fencingToken > first.fencingToken);
  await service.stop();
});

test('服务重启自动补生成停机期间遗漏的正式时间键', async () => {
  const { repository, service } = makeHarness();
  await service.start();
  await service.stop();
  repository.bars.push(formalBar(BAR + 900_000));
  const restarted = new FeatureGeneratorService({
    repository,
    engine: {
      async generatePoint(input, lease) {
        return repository.saveFeatureRecord({
          featureId: `feature-${input.targetBarCloseTime}`, symbol: input.symbol, targetInterval: input.targetInterval,
          targetBarCloseTime: input.targetBarCloseTime, featureSetVersion: input.featureSetVersion,
          contentHash: `feature-hash-${input.targetBarCloseTime}`, qualityState: 'HEALTHY',
          missingFeatures: [], degradedReasons: []
        }, lease);
      }
    },
    holderId: 'feature-worker-restarted', serverTimeProvider: time(BAR + 901_000),
    now: () => BAR + 901_000, leaseTtlMs: 60_000, pollMs: 60_000, logger: quietLogger
  });
  await restarted.start();
  assert.deepEqual(repository.featureRecords.map(row => row.targetBarCloseTime), [BAR, BAR + 900_000]);
  await restarted.stop();
});

test('单个特征失败记录blocked_count且调度服务保持运行', async () => {
  const { repository, service } = makeHarness({
    generate: async () => { throw Object.assign(new Error('missing inputs'), { code: 'CRITICAL_ETH_WINDOW_INSUFFICIENT' }); }
  });
  try {
    await service.start();
    assert.equal(repository.featureRuns[0].status, 'SUCCEEDED');
    assert.equal(repository.featureRuns[0].results.filter(result => result.status === 'BLOCKED').length, 1);
    assert.equal(service.running, true);
  } finally {
    await service.stop();
  }
});

test('心跳丢失后立即停止调度并拒绝后续生成', async () => {
  const { repository, service } = makeHarness();
  await service.start();
  repository.leases.get(FEATURE_GENERATOR_LEASE).holderId = 'replacement';
  await assert.rejects(service.heartbeat(), error => error.code === 'LEASE_LOST');
  assert.equal(service.running, false);
  await assert.rejects(service.runOnce(), error => error.code === 'LEASE_LOST');
});

test('SIGTERM使用的stop会等待在途生成并释放租约', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { repository, service } = makeHarness({ generate: async (input, lease, repo) => {
    await pending;
    return repo.saveFeatureRecord({
      featureId: `feature-${input.targetBarCloseTime}`, symbol: input.symbol, targetInterval: input.targetInterval,
      targetBarCloseTime: input.targetBarCloseTime, featureSetVersion: input.featureSetVersion,
      contentHash: `feature-hash-${input.targetBarCloseTime}`, qualityState: 'HEALTHY',
      missingFeatures: [], degradedReasons: []
    }, lease);
  } });
  const start = service.start();
  await new Promise(resolve => setImmediate(resolve));
  const stopped = service.stop();
  release();
  await Promise.allSettled([start, stopped]);
  assert.equal(service.running, false);
  assert.equal(repository.leases.get(FEATURE_GENERATOR_LEASE).expiresAt, BAR + 1000);
});

test('生产systemd以独立服务运行特征生成器且collector仅Wants依赖', async () => {
  const featureUnit = await readFile(new URL('../../../deploy/systemd/eth-alpha-feature-generator.service', import.meta.url), 'utf8');
  const collectorUnit = await readFile(new URL('../../../deploy/systemd/eth-alpha-collector.service', import.meta.url), 'utf8');
  const entry = await readFile(new URL('../../src/features/generator-service-entry.js', import.meta.url), 'utf8');
  assert.match(featureUnit, /ExecStart=.*features\/generator-service-entry\.js/);
  assert.match(featureUnit, /KillSignal=SIGTERM/);
  assert.match(collectorUnit, /Wants=.*eth-alpha-feature-generator\.service/);
  assert.doesNotMatch(collectorUnit, /Requires=.*eth-alpha-feature-generator\.service/);
  assert.match(entry, /process\.once\('SIGTERM'/);
  assert.match(entry, /await service\.stop\(\)/);
});
