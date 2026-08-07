import { readFileSync } from 'node:fs';
import {
  acquireResearchRunStatusLock, releaseResearchRunStatusLock,
  readRunStatus, writeRunStatus, withBlocked, withCompleted, withFailed
} from '../research-run-status.js';

const [root, identityPath, action, startAtText] = process.argv.slice(2);
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
