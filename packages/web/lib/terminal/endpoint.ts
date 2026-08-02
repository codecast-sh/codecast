// Discovery of the local daemon's terminal endpoint.
//
// The daemon serves the integrated terminal on an OS-assigned loopback port
// guarded by a per-boot token. The browser can't read the port file, so
// discovery goes through the authenticated daemon-command relay: one
// get_terminal_endpoint command per live device, then we probe each returned
// endpoint over 127.0.0.1 — only the machine the browser is physically on
// answers, which resolves multi-device setups with no server-side logic.

import type { ConvexReactClient } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";

export interface TerminalEndpoint {
  port: number;
  token: string;
  deviceId: string;
  tmux: boolean;
}

export interface TerminalSessionInfo {
  name: string;
  path: string;
  command: string;
  created: number;
  attached: number;
}

const CACHE_KEY = "cast_term_endpoint";
// Dev override: `localStorage.CAST_TERM_ENDPOINT = "42871:dev-token"` points
// the panel at a standalone terminal server (packages/cli terminal dev server)
// without a daemon round-trip.
const OVERRIDE_KEY = "CAST_TERM_ENDPOINT";
const RESULT_POLL_MS = 400;
const RESULT_POLL_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 1500;

let inflight: Promise<TerminalEndpoint | null> | null = null;

/** Why the last discovery produced no endpoint. Callers surface cause-specific
 *  guidance: a relay that returned no devices means the daemon isn't running
 *  (or you're signed in as someone else), while candidates that all failed to
 *  probe means the BROWSER blocked the loopback request — on a hosted origin
 *  that's Chrome's local-network permission, which no amount of restarting the
 *  daemon will fix. */
export type DiscoveryFailure = "none" | "no-devices" | "probe-failed";
let lastFailure: DiscoveryFailure = "none";
export function lastDiscoveryFailure(): DiscoveryFailure {
  return lastFailure;
}

function readOverride(): TerminalEndpoint | null {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return null;
    const [port, token] = raw.split(":");
    if (!port || !token) return null;
    return { port: parseInt(port, 10), token, deviceId: "dev-override", tmux: true };
  } catch {
    return null;
  }
}

function readCache(): TerminalEndpoint | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as TerminalEndpoint) : null;
  } catch {
    return null;
  }
}

function writeCache(ep: TerminalEndpoint | null): void {
  try {
    if (ep) sessionStorage.setItem(CACHE_KEY, JSON.stringify(ep));
    else sessionStorage.removeItem(CACHE_KEY);
  } catch {}
}

export function termHttpBase(ep: TerminalEndpoint): string {
  // Literal IPv4: macOS resolves `localhost` to ::1 first and Safari won't
  // fall back when the daemon binds IPv4 only (see auth/cli/page.tsx).
  return `http://127.0.0.1:${ep.port}`;
}

export function termWsUrl(ep: TerminalEndpoint): string {
  return `ws://127.0.0.1:${ep.port}/term/ws`;
}

/** Probe an endpoint: does a daemon with this token answer on loopback? */
export async function probeEndpoint(ep: TerminalEndpoint): Promise<TerminalSessionInfo[] | null> {
  try {
    const res = await fetch(`${termHttpBase(ep)}/term/sessions`, {
      headers: { Authorization: `Bearer ${ep.token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { sessions?: TerminalSessionInfo[]; tmux?: boolean };
    if (!body.tmux) return null;
    return body.sessions ?? [];
  } catch {
    return null;
  }
}

async function discover(convex: ConvexReactClient): Promise<TerminalEndpoint | null> {
  const { commands } = await convex.mutation(api.users.requestTerminalEndpoints, {});
  if (!commands.length) {
    lastFailure = "no-devices";
    return null;
  }
  // Candidates exist; anything that goes wrong from here is the probe.
  lastFailure = "probe-failed";

  const deadline = Date.now() + RESULT_POLL_TIMEOUT_MS;
  const unresolved = new Map(commands.map((c) => [c.command_id, c] as const));

  while (unresolved.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RESULT_POLL_MS));
    const checks = await Promise.all(
      [...unresolved.keys()].map(async (id) => ({
        id,
        res: await convex.query(api.users.getCommandResult, { command_id: id }),
      })),
    );
    for (const { id, res } of checks) {
      if (!res?.executed_at) continue;
      unresolved.delete(id);
      if (!res.result) continue;
      try {
        const parsed = JSON.parse(res.result) as { port: number; token: string; device_id: string; tmux: boolean };
        const ep: TerminalEndpoint = {
          port: parsed.port,
          token: parsed.token,
          deviceId: parsed.device_id,
          tmux: parsed.tmux,
        };
        // First endpoint that actually answers on loopback wins.
        if (ep.port > 0 && (await probeEndpoint(ep)) !== null) {
          lastFailure = "none";
          return ep;
        }
      } catch {}
    }
  }
  return null;
}

/**
 * Resolve the local terminal endpoint: dev override, then session cache
 * (revalidated by probe), then full discovery through the daemon-command relay.
 */
export async function getTerminalEndpoint(
  convex: ConvexReactClient,
  opts?: { force?: boolean },
): Promise<TerminalEndpoint | null> {
  const override = readOverride();
  if (override) return override;

  if (!opts?.force) {
    const cached = readCache();
    if (cached && (await probeEndpoint(cached)) !== null) return cached;
  }
  if (inflight) return inflight;

  inflight = discover(convex)
    .then((ep) => {
      writeCache(ep);
      return ep;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function killTerminalSession(ep: TerminalEndpoint, name: string): Promise<boolean> {
  try {
    const res = await fetch(`${termHttpBase(ep)}/term/kill?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ep.token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
