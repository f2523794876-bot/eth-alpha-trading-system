// Best-effort build step for the renameat2(RENAME_EXCHANGE) native addon
// (native/renameat2/), run via `npm run build:renameat2` and automatically
// from `postinstall`. Deliberately non-fatal: on a non-Linux platform, or if
// the build toolchain is unavailable, this must NOT block `npm install` for
// the rest of the project -- the JS wrapper (native/renameat2/index.js)
// reports unavailability explicitly at the one call site that needs it
// (research-run-status.js's lock reclaim/release paths), which fail closed
// there rather than silently using a weaker protocol. This script only
// improves the odds that the fast, safe path is available; its absence is
// handled correctly, not ignored.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeDir = path.join(here, '..', 'native', 'renameat2');

if (process.platform !== 'linux') {
  console.log(`[build-renameat2-addon] skipping: platform "${process.platform}" is not Linux (renameat2 is Linux-only). ` +
    'Atomic lock exchange will report RUN_STATUS_ATOMIC_EXCHANGE_UNAVAILABLE and fail closed at the reclaim/release call sites.');
  process.exit(0);
}

const nodeGyp = path.join(here, '..', 'node_modules', '.bin', 'node-gyp');
const result = spawnSync(nodeGyp, ['rebuild'], { cwd: nativeDir, stdio: 'inherit' });

if (result.status !== 0) {
  console.warn('[build-renameat2-addon] node-gyp build failed (non-fatal to npm install). ' +
    'Atomic lock exchange will report RUN_STATUS_ATOMIC_EXCHANGE_UNAVAILABLE and fail closed at the reclaim/release call sites ' +
    'until this is built successfully (re-run: npm run build:renameat2).');
  process.exit(0);
}

console.log('[build-renameat2-addon] renameat2(RENAME_EXCHANGE) native addon built successfully.');
