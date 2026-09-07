/**
 * Named port allocator.
 *
 * Maps named ports (e.g., "web", "api", "db") in a manifest to concrete port
 * numbers using the existing AGENT_RESOURCE_INDEX scheme:
 *
 *   actualPort = spec.base + (resourceIndex * spec.range)
 *
 * Validates each computed port is actually free (TCP probe). If any port in
 * the set is taken, tries the next resourceIndex. The first `maxIndices`
 * indices are the pool the project declared; when every one of them is taken
 * the search extends the range upward by the pool's own size, `maxExtensions`
 * times, and reports the window it ended up in as `extendedRange`.
 *
 * Returns:
 *   - ports: { name → port number }
 *   - env:   { PORT_<NAME_UPPER> → string }
 *   - resourceIndex: the index actually used (may differ from requested if
 *     collision-avoidance bumped it)
 */

import { createServer, type Server } from "node:net";
import type { WorkspaceManifest } from "./types.js";

export interface PortAllocation {
  ports: Record<string, number>;
  env: Record<string, string>;
  resourceIndex: number;
  /**
   * The extended index window this allocation came from. Absent when the
   * declared pool had a free slot. Callers report it so the operator knows
   * the range no longer holds every workspace.
   */
  extendedRange?: { poolSize: number; from: number; to: number };
}

export interface AllocateOptions {
  /** Starting resource index. Default 0. */
  startIndex?: number;
  /** Size of the pool: how many indices one pass tries. Default 10. */
  maxIndices?: number;
  /**
   * How many times to extend the range by the pool's own size when the pool
   * is full. Default 3, so a pool of 10 stretches to 40 indices before
   * acquire gives up. Set 0 to fail at the pool boundary.
   */
  maxExtensions?: number;
  /**
   * Skip the TCP probe (purely arithmetic allocation). Used by tests and by
   * callers that want a stable mapping regardless of live port state.
   */
  noProbe?: boolean;
  reservedPorts?: ReadonlySet<number>;
}

export class PortAllocationError extends Error {
  constructor(
    message: string,
    public readonly conflicts?: Array<{ name: string; port: number }>,
    /** Inclusive index range the allocator tried, for the caller's message. */
    public readonly searched?: { from: number; to: number },
  ) {
    super(message);
    this.name = "PortAllocationError";
  }
}

/** Compute ports for a manifest at a specific index (no probing). */
export function computePorts(
  manifest: WorkspaceManifest,
  resourceIndex: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, spec] of Object.entries(manifest.ports)) {
    out[name] = spec.base + resourceIndex * spec.range;
  }
  return out;
}

/** Build the env-var map for a port allocation. */
export function portsToEnv(ports: Record<string, number>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, port] of Object.entries(ports)) {
    env[`PORT_${name.toUpperCase()}`] = String(port);
  }
  return env;
}

/**
 * Allocate ports for a manifest, validating each is free.
 * Returns the chosen resourceIndex (may bump up if collisions detected).
 */
export async function allocatePorts(
  manifest: WorkspaceManifest,
  opts: AllocateOptions = {},
): Promise<PortAllocation> {
  const startIndex = opts.startIndex ?? 0;
  const poolSize = opts.maxIndices ?? 10;
  const maxExtensions = opts.maxExtensions ?? 3;
  const lastIndex = startIndex + poolSize * (maxExtensions + 1) - 1;

  // Trivial case: no ports declared.
  if (Object.keys(manifest.ports).length === 0) {
    return { ports: {}, env: {}, resourceIndex: startIndex };
  }

  let lastConflicts: Array<{ name: string; port: number }> = [];

  for (let block = 0; block <= maxExtensions; block++) {
    const from = startIndex + block * poolSize;
    const to = from + poolSize - 1;
    for (let i = from; i <= to; i++) {
      const ports = computePorts(manifest, i);
      const reserved = Object.entries(ports)
        .filter(([, port]) => opts.reservedPorts?.has(port))
        .map(([name, port]) => ({ name, port }));
      const conflicts = reserved.length > 0 || opts.noProbe ? reserved : await findConflicts(ports);
      if (conflicts.length === 0) {
        return {
          ports,
          env: portsToEnv(ports),
          resourceIndex: i,
          ...(block > 0 ? { extendedRange: { poolSize, from, to } } : {}),
        };
      }
      lastConflicts = conflicts;
    }
  }

  throw new PortAllocationError(
    `unable to allocate free ports: indices ${startIndex}-${lastIndex} are all taken ` +
      `(pool of ${poolSize}, extended ${maxExtensions} times); ` +
      `last conflicts: ${lastConflicts.map((c) => `${c.name}=${c.port}`).join(", ")}`,
    lastConflicts,
    { from: startIndex, to: lastIndex },
  );
}

/** Identify which of the requested ports are currently in use. */
async function findConflicts(
  ports: Record<string, number>,
): Promise<Array<{ name: string; port: number }>> {
  const checks = await Promise.all(
    Object.entries(ports).map(async ([name, port]) => {
      const free = await isPortFree(port);
      return free ? null : { name, port };
    }),
  );
  return checks.filter((c): c is { name: string; port: number } => c !== null);
}

/**
 * Probe a port by trying to bind it briefly on 127.0.0.1.
 * Free = bind succeeds; we then close immediately. Result is racy under heavy
 * concurrency (TOCTOU), but that's acceptable for workspace setup.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server: Server = createServer();
    let resolved = false;
    const done = (free: boolean) => {
      if (resolved) return;
      resolved = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(free);
    };
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        done(false);
      } else {
        // Unexpected error — treat as not-free conservatively.
        done(false);
      }
    });
    server.once("listening", () => done(true));
    try {
      server.listen(port, "127.0.0.1");
    } catch {
      done(false);
    }
  });
}
