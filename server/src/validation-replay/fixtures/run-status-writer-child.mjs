import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  acquireResearchRunStatusLock, releaseResearchRunStatusLock,
  readRunStatus, writeRunStatus, withBlocked, withCompleted, withFailed
} from '../research-run-status.js';
import {
  writeTempFileDurable, renameNoReplace, fsyncDirectory, ensureDirectorySafe,
  newOwnerToken, processStartIdentity, hostIdentitySha256
} from '../artifact-fs-primitives.js';
import { canonicalJson } from '../../formal-research/canonical-json.js';

const [root, identityPath, action, startAtText, delayMsText] = process.argv.slice(2);
const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
const startAt = Number(startAtText);
while (Date.now() < startAt) { /* synchronize independent processes */ }
if (action === 'LOCK_HOLD' || action === 'LOCK_CRASH') {
  const lock = acquireResearchRunStatusLock(root, identity, { lockTimeoutMs: 2_000, staleLockMs: 50 });
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, lockPath: lock.lockPath })}\n`);
  if (action === 'LOCK_CRASH') process.exit(77);
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', () => {
    process.stdout.write(`${JSON.stringify({ released: releaseResearchRunStatusLock(lock) })}\n`);
    process.exit(0);
  });
} else if (action === 'SLOW_PUBLISH') {
  // Genuinely alive the entire time -- composes exactly the same public
  // primitives (writeTempFileDurable/renameNoReplace/...) and the same
  // temp/lock naming convention that production acquireStatusLock() uses
  // internally, with an explicit test-controlled delay inserted between
  // "temp evidence fully durable" and "atomic publish". No unexported
  // production internal is touched.
  const delayMs = Number(delayMsText);
  const dir = path.join(root, 'run-status', identity.artifactMode === 'FORMAL' ? 'formal' : 'dry-run', identity.validationRunId);
  ensureDirectorySafe(dir, root);
  const lockPath = path.join(dir, `.${identity.runIdentitySha256}.status.lock`);
  const ownerToken = newOwnerToken();
  const tempPath = path.join(dir, `.${identity.runIdentitySha256}.status.lock.tmp.${ownerToken}`);
  const owner = {
    ownerToken, pid: process.pid, processStartIdentity: processStartIdentity(),
    hostIdentitySha256: hostIdentitySha256(), createdAt: new Date().toISOString()
  };
  writeTempFileDurable(tempPath, Buffer.from(canonicalJson(owner), 'utf8'));
  process.stdout.write(`${JSON.stringify({ tempReady: true, pid: process.pid, lockPath, tempPath })}\n`);
  await new Promise(resolve => setTimeout(resolve, delayMs));
  let published = false, publishError = null;
  try {
    renameNoReplace(tempPath, lockPath);
    fsyncDirectory(dir);
    published = true;
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best effort */ }
    publishError = error?.code || 'ERROR';
  }
  process.stdout.write(`${JSON.stringify({ published, publishError })}\n`);
  process.exit(published ? 0 : 78);
} else try {
  const current = readRunStatus(root, identity);
  const next = action === 'COMPLETED' ? withCompleted(current, { publishedArtifactSha256: 'a'.repeat(64) })
    : action === 'BLOCKED' ? withBlocked(current, 'CHILD_BLOCKED')
      : withFailed(current, 'CHILD_FAILED');
  const written = writeRunStatus(root, next, { lockTimeoutMs: 2_000, staleLockMs: 100 });
  process.stdout.write(JSON.stringify({ ok: true, state: written.runState }));
} catch (error) {
  if (['RUN_STATUS_STALE_UPDATE', 'RUN_STATUS_ILLEGAL_TRANSITION'].includes(error?.code)) {
    process.stdout.write(JSON.stringify({ ok: true, rejected: error.code }));
  } else {
    process.stderr.write(JSON.stringify({ code: error?.code || 'ERROR' }));
    process.exitCode = 1;
  }
}
