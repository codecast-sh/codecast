/**
 * Backend registry. Default registry contains only LocalBackend.
 * Cloud backends register themselves with `defaultRegistry.register(...)`
 * after dynamic import (so we don't pay the cost of cloud SDK imports
 * unless they're actually used).
 */

import { LocalBackend } from "./local.js";
import type { BackendRegistry, SandboxBackend } from "./types.js";

class Registry implements BackendRegistry {
  private backends = new Map<string, SandboxBackend>();

  register(backend: SandboxBackend): void {
    this.backends.set(backend.name, backend);
  }

  get(name: string): SandboxBackend {
    const b = this.backends.get(name);
    if (!b) {
      throw new Error(
        `unknown backend '${name}'. Registered: [${[...this.backends.keys()].join(", ")}]`,
      );
    }
    return b;
  }

  has(name: string): boolean {
    return this.backends.has(name);
  }

  list(): string[] {
    return [...this.backends.keys()];
  }
}

/** Default singleton. LocalBackend is always available. */
export const defaultRegistry = new Registry();
defaultRegistry.register(LocalBackend);

/**
 * Register cloud backends. Their constructors do not eagerly load their
 * SDKs/credentials — those happen at first method call, so importing them
 * here is cheap.
 */
async function maybeRegisterCloud(): Promise<void> {
  // Dynamic imports so a misbehaving cloud module can't break the local
  // path. Each load is best-effort.
  try {
    const { E2bBackend } = await import("./e2b.js");
    defaultRegistry.register(E2bBackend);
  } catch { /* e2b module load failed — local still works */ }
  try {
    const { MacMiniBackend } = await import("./mac-mini.js");
    defaultRegistry.register(MacMiniBackend);
  } catch { /* mac module load failed — local still works */ }
}
// Kick off async cloud registration; if anything throws it's caught above.
void maybeRegisterCloud();

/** Convenience: get a backend or fall back to local. */
export function getBackend(name?: string): SandboxBackend {
  return defaultRegistry.get(name ?? "local");
}

/**
 * Wait until cloud-backend imports finish. Useful in tests that need to
 * assert the cloud backends are registered. Production callers don't need
 * this — they hit the registry directly and either the backend exists or
 * they get a clean error.
 */
export async function ensureCloudBackendsLoaded(): Promise<void> {
  await maybeRegisterCloud();
}
