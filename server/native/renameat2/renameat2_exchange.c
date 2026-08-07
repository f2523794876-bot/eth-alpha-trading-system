// Minimal N-API binding exposing exactly one operation: Linux's
// renameat2(2) with RENAME_EXCHANGE. This is the sole reason this native
// addon exists -- no other syscalls are wrapped.
//
// Why this exists (see server/src/validation-replay/research-run-status.js,
// P0-03/P0-04 fix, CEO-authorized "方案B"): closing the quarantine/release
// TOCTOU race requires a filesystem operation that atomically swaps two
// existing directory entries, so that (a) the well-known lock path is never
// observably absent, and (b) the caller can synchronously read back exactly
// what it displaced through its own private path and prove that path was
// never touched by anyone else. Neither property is achievable with the
// primitives Node's `fs` module exposes (rename() replaces unconditionally
// with no atomic feedback about what was replaced; link()+unlink() requires
// the destination to be absent, which is the opposite of what an exchange
// needs). renameat2(RENAME_EXCHANGE) is the POSIX-adjacent (Linux-specific)
// primitive that provides both properties in one atomic kernel operation.
//
// Supported platform: Linux only (kernel >= 3.15, universal on any kernel
// this codebase's Linux/macOS POSIX design already targets -- see
// artifact-fs-primitives.js's own header comment on platform scope).
// binding.gyp only attempts to build this addon when OS=="linux". On any
// other platform, or if the build/load fails for any reason, the JS loader
// (native/renameat2/index.js) reports unavailability explicitly; callers in
// research-run-status.js fail closed rather than silently using a weaker,
// racy fallback.
#define _GNU_SOURCE
#include <node_api.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/syscall.h>

#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif

// glibc >= 2.28 declares renameat2() directly; on older glibc fall back to
// the raw syscall so the addon still builds/works on any Linux kernel that
// implements it (kernel 3.15+, i.e. effectively all supported kernels).
#if !defined(__GLIBC__) || (__GLIBC__ < 2) || (__GLIBC__ == 2 && __GLIBC_MINOR__ < 28)
static int renameat2_compat(int oldfd, const char *oldpath, int newfd, const char *newpath, unsigned int flags) {
  return (int) syscall(SYS_renameat2, oldfd, oldpath, newfd, newpath, flags);
}
#define RENAMEAT2 renameat2_compat
#else
#define RENAMEAT2 renameat2
#endif

static const char *ErrnoCode(int err) {
  switch (err) {
    case ENOENT: return "ENOENT";
    case EEXIST: return "EEXIST";
    case EINVAL: return "EINVAL";
    case ENOSYS: return "ENOSYS";
    case EXDEV: return "EXDEV";
    case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR";
    case EPERM: return "EPERM";
    case EACCES: return "EACCES";
    case ELOOP: return "ELOOP";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case EBUSY: return "EBUSY";
    case ENOTEMPTY: return "ENOTEMPTY";
    default: return "UNKNOWN";
  }
}

static void ThrowErrnoError(napi_env env, int err, const char *pathA, const char *pathB) {
  char message[8300]; // fits two 4096-byte paths plus the surrounding fixed text with headroom
  snprintf(message, sizeof(message), "renameat2(RENAME_EXCHANGE) failed: %s (errno %d) exchanging \"%s\" <-> \"%s\"",
            strerror(err), err, pathA, pathB);
  napi_value error, code_str, message_str, errno_num;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_str);
  napi_create_string_utf8(env, ErrnoCode(err), NAPI_AUTO_LENGTH, &code_str);
  napi_create_error(env, code_str, message_str, &error);
  napi_create_int32(env, err, &errno_num);
  napi_set_named_property(env, error, "code", code_str);
  napi_set_named_property(env, error, "errno", errno_num);
  napi_throw(env, error);
}

static napi_value RenameExchangeSync(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_status status = napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (status != napi_ok || argc < 2) {
    napi_throw_type_error(env, "EINVAL", "renameExchangeSync(pathA, pathB) requires two string arguments");
    return NULL;
  }

  char pathA[4096];
  char pathB[4096];
  size_t lenA = 0, lenB = 0;
  if (napi_get_value_string_utf8(env, args[0], pathA, sizeof(pathA), &lenA) != napi_ok ||
      napi_get_value_string_utf8(env, args[1], pathB, sizeof(pathB), &lenB) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "renameExchangeSync(pathA, pathB) requires two string path arguments");
    return NULL;
  }

  int rc = RENAMEAT2(AT_FDCWD, pathA, AT_FDCWD, pathB, RENAME_EXCHANGE);
  if (rc != 0) {
    ThrowErrnoError(env, errno, pathA, pathB);
    return NULL;
  }

  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value IsSupported(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, 1, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value renameExchangeFn, isSupportedFn;
  napi_create_function(env, "renameExchangeSync", NAPI_AUTO_LENGTH, RenameExchangeSync, NULL, &renameExchangeFn);
  napi_create_function(env, "isSupported", NAPI_AUTO_LENGTH, IsSupported, NULL, &isSupportedFn);
  napi_set_named_property(env, exports, "renameExchangeSync", renameExchangeFn);
  napi_set_named_property(env, exports, "isSupported", isSupportedFn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
