// Thin JS wrapper for the renameat2(RENAME_EXCHANGE) N-API binding.
// See renameat2_exchange.c for why this exists.
//
// Supported production platform/architecture: Linux, any architecture glibc
// (or a raw SYS_renameat2 syscall, as a compatibility fallback for older
// glibc) supports on kernel >= 3.15 -- i.e. x86_64 and arm64 in practice for
// this codebase's deployment targets. binding.gyp does not build the native
// addon at all on non-Linux platforms (`OS=='linux'` gate), so `available`
// below is deterministically false there without attempting and failing a
// load.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let binding = null;
let unavailableReason = null;

if (process.platform !== 'linux') {
  unavailableReason = `renameat2(RENAME_EXCHANGE) is only supported on Linux; current platform is "${process.platform}"`;
} else {
  try {
    binding = require(path.join(here, 'build', 'Release', 'renameat2_exchange.node'));
  } catch (error) {
    unavailableReason = `native renameat2_exchange addon failed to load (build it with: npm run build:renameat2 --prefix server, or check native/renameat2/build for a prior build failure): ${error.message}`;
  }
}

export const available = !!binding;
export const unavailableReason_ = unavailableReason; // exported for diagnostics only

export function getUnavailableReason() {
  return unavailableReason;
}

// Atomically swaps the two existing filesystem objects at pathA and pathB
// (Linux renameat2(2), RENAME_EXCHANGE). Both paths MUST already exist or
// this throws ENOENT (this primitive never creates or removes anything --
// it only ever swaps two already-existing directory entries). Throws
// RUN_STATUS_ATOMIC_EXCHANGE_UNAVAILABLE (not a raw ENOSYS/platform error)
// when the native binding could not be loaded at all, so callers can
// pattern-match this one stable code regardless of the underlying reason.
export function renameExchangeSync(pathA, pathB) {
  if (!binding) {
    throw Object.assign(
      new Error(`renameat2(RENAME_EXCHANGE) unavailable: ${unavailableReason}`),
      { code: 'RUN_STATUS_ATOMIC_EXCHANGE_UNAVAILABLE' }
    );
  }
  binding.renameExchangeSync(pathA, pathB);
}
