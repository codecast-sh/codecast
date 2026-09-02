// The guarded require pattern for Expo OTA updates.
//
// An OTA ships JavaScript only and can land on an older binary that does not
// bundle a native module. A top level `import` of that module throws at module
// evaluation, expo-updates marks the update as failed, and the app silently
// rolls back. A dynamic `import()` does not help: a production bundle resolves
// it differently and Metro still links the module. The only safe shape is a
// synchronous `require` inside try/catch that falls back to a no-op, called at
// first use and never at module load.
//
// Codecast follows this in packages/mobile/lib/analytics.ts (Sentry, PostHog)
// and lib/dispatchOutbox.ts. Copy this file into the app; it has no deps.

/**
 * Load a native module if the running binary bundles it. Returns `fallback`
 * otherwise. The loader is a function so Metro's static analysis still sees a
 * literal `require("...")` inside it (write `() => require("expo-foo")`), and
 * it is called lazily, so a missing module never throws at import time.
 */
export function guardedRequire<T>(load: () => T, fallback: T, onMissing?: (err: unknown) => void): T {
  try {
    return load();
  } catch (err) {
    onMissing?.(err);
    return fallback;
  }
}

/**
 * Memoized variant: resolve once on first use, cache the result. Use this for
 * SDKs that must be initialized once (analytics, crash reporting).
 */
export function lazyGuardedRequire<T>(load: () => T, fallback: T, onMissing?: (err: unknown) => void): () => T {
  let resolved = false;
  let value: T = fallback;
  return () => {
    if (!resolved) {
      resolved = true;
      value = guardedRequire(load, fallback, onMissing);
    }
    return value;
  };
}
