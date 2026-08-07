import { readFileSync } from 'node:fs';
import {
  readRunStatus, writeRunStatus, withBlocked, withCompleted, withFailed
} from '../research-run-status.js';

const [root, identityPath, action, startAtText] = process.argv.slice(2);
const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
const startAt = Number(startAtText);
while (Date.now() < startAt) { /* synchronize independent processes */ }
try {
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
