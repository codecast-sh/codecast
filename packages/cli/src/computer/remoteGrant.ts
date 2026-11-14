/**
 * Whether a cloud host's session may drive this laptop's apps
 * (docs/architecture/computer-remote.md). Off by default; the grant lives on
 * the laptop, on the host's entry in hosts.json beside `laptopBrowser`, so the
 * host can never write its own.
 *
 * Scope, expiry and an app list are separate checks on purpose: the grant
 * model is the person's decision, and each rule can be switched alone.
 */

import type { CloudHost } from "../browser/cloudHost.js";
import { askToRun, RUN_ON_LAPTOP } from "@codecast/shared/contracts/commandRun";
import type { ComputerMethod } from "./types.js";

export interface ComputerHostGrant {
  grantedAt: number;
  /** Only these sessions on the host; absent = every session on it. */
  sessions?: string[];
  /** Ends on its own at this time; absent = until revoked. */
  expiresAt?: number;
  /** Only these apps (bundle ids or names, case-insensitive); absent = all apps. */
  apps?: string[];
}

export interface RemoteRequest {
  host: string;
  session: string | null;
  method: string;
  params: Record<string, unknown>;
}

export const grantCommand = (hostId: string): string => `cast computer remote grant --host ${hostId}`;

export const askForGrant = (hostId: string, laptop: string): string =>
  askToRun(`Let this cloud host drive the apps on ${laptop}?`, grantCommand(hostId), RUN_ON_LAPTOP);

type Check = (g: ComputerHostGrant, r: RemoteRequest, now: number, laptop: string) => string | null;

const scopeCheck: Check = (g, r, _now, laptop) =>
  !g.sessions?.length || (r.session && g.sessions.includes(r.session))
    ? null
    : `${laptop} let ${g.sessions.length === 1 ? `session ${g.sessions[0]}` : `sessions ${g.sessions.join(", ")}`} on this host drive its apps, not ${r.session ? `session ${r.session}` : "a process outside a session"}`;

const expiryCheck: Check = (g, _r, now) =>
  g.expiresAt === undefined || now < g.expiresAt ? null : `this host's access to the laptop's apps expired ${new Date(g.expiresAt).toISOString()}`;

const appCheck: Check = (g, r) => {
  if (!g.apps?.length || r.method === "listApps") return null;
  const app = typeof r.params.app === "string" ? r.params.app.toLowerCase() : "";
  return g.apps.some((a) => a.toLowerCase() === app) ? null : `this host may drive only ${g.apps.join(", ")} on the laptop${app ? `, not ${r.params.app}` : ""}`;
};

/** Every rule a grant is held to; each is one entry, so a decision moves one line. */
export const GRANT_CHECKS: Record<"scope" | "expiry" | "apps", Check> = { scope: scopeCheck, expiry: expiryCheck, apps: appCheck };

/** What the laptop forwards for a host. Never terminate, never the permission or setup flows. */
export const REMOTE_METHODS: ReadonlySet<ComputerMethod | "capabilities"> = new Set([
  "capabilities", "listApps", "listWindows", "getAppState",
  "click", "performSecondaryAction", "scroll", "drag", "typeText", "pressKey", "hotkey", "pasteText", "setValue",
]);

/** Why the request may not reach the helper, or null. */
export function remoteRefusal(host: CloudHost | undefined, r: RemoteRequest, laptop: string, now = Date.now()): string | null {
  if (!host) return `${laptop} no longer lets host ${r.host} in (its key was revoked, its link ended, or the host was removed)`;
  if (host.shared) return `${laptop} never shares its apps with a host shared with teammates`;
  const g = host.laptopComputer;
  if (!g) return `${laptop} has not let this host drive its apps. Ask your person: ${askForGrant(r.host, laptop)}`;
  for (const check of Object.values(GRANT_CHECKS)) {
    const why = check(g, r, now, laptop);
    if (why) return `${why}. Ask your person: ${askForGrant(r.host, laptop)}`;
  }
  if (!REMOTE_METHODS.has(r.method as ComputerMethod)) return `${r.method} is not available from a cloud host`;
  // A cloud session never pulls a window over the person's work.
  if (r.params.restoreWindow === true) return "--restore-window is not available from a cloud host: it would take the person's screen";
  return null;
}

/** "8h", "30m", "2d" to milliseconds. */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)\s*(m|h|d)$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

/**
 * The grant a person's `remote grant` writes. Inside an agent session it
 * refuses: the agent asks with the card, and the person's Run executes it
 * with the session env stripped (daemon run_cast, personEnv).
 */
export function newGrant(o: { session?: string[]; forMs?: number; apps?: string[] }, now = Date.now()): ComputerHostGrant {
  return {
    grantedAt: now,
    ...(o.session?.length ? { sessions: o.session } : {}),
    ...(o.forMs ? { expiresAt: now + o.forMs } : {}),
    ...(o.apps?.length ? { apps: o.apps } : {}),
  };
}

/** One notice per host per local day, the first time a grant is used. */
export function noticeDue(seen: Record<string, string>, host: string, now = new Date()): boolean {
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (seen[host] === day) return false;
  seen[host] = day;
  return true;
}
