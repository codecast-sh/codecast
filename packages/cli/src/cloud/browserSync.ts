/**
 * Carrying the laptop's browser logins into the cloud host's Chrome.
 *
 * On the host `cast browser sync <site>` is a request, not a carry: the host
 * has no Keychain (credentials.ts `chromeEncryptionKey` is null off macOS),
 * so the verb asks the owner's laptop daemon to run the decrypt-and-inject it
 * already does for the laptop's own browser. The request rides the targeted
 * daemon_commands rail (`cloud_browser_sync`, cloud.requestBrowserSync); the
 * laptop daemon runs `cast cloud browser-sync` in a child, which is this
 * module: resolve the host from the registry, open a short-lived SSH port
 * forward to the host Chrome's loopback CDP port, and call the unchanged
 * `provisionLocalLogins` through it.
 *
 * Cookies cross exactly one wire — laptop -> host inside the SSH forward,
 * into Chrome's memory — and Chrome alone persists them in its own profile.
 * The Convex row carries ids, a port, an ORIGIN and a flag; the result carries
 * counts. Nothing cookie-shaped touches Convex, the daemon log or the host
 * disk outside Chrome's profile, and `carrySummaryLine` is the only thing the
 * child prints on stdout.
 *
 * The laptop never wakes a host for cookies: the request came from a process
 * on the host, so it was up; a registry address gone stale after a
 * server-side wake is refreshed from AWS (describe only, never start).
 */

import { AwsCliFailed, hostForDevice, hostState, patchHost, sshReachable, toRemoteHost, type CloudHost } from "../browser/cloudHost.js";
import { OWN_LOGIN_REASON, provisionLocalLogins, type ProvisionResult } from "../browser/credentials.js";
import { readState, type InstanceState } from "../browser/instance.js";
import { checkUrl, loadMachinePolicy } from "../browser/policy.js";
import { keepsOwnLogin, listRealProfiles, type ChromeChannel, type RealProfile } from "../browser/profile.js";
import { withCdpTunnel } from "../browser/remote.js";
import { signInHost } from "../browser/siteGuard.js";
import type { RemoteHost } from "../remote/session-move.js";

// ---------------------------------------------------------------------------
// The command's args
// ---------------------------------------------------------------------------

export interface BrowserSyncArgs {
  /** The cloud host's device id (the requester). */
  hostDeviceId: string;
  /** The host Chrome's loopback CDP port. */
  cdpPort: number;
  /** The site origin, or null for the whole jar (`all`). */
  origin: string | null;
  all: boolean;
  /** Attribution only. */
  conversationId?: string;
}

/**
 * The daemon command's args JSON, validated the way the mutation validated
 * it: a host device, a port, and exactly one of an http(s) origin or `all`.
 * The child re-parses the same shape so it validates exactly what the daemon
 * validated (cloud/cli.ts builds the JSON back from its flags).
 */
export function parseBrowserSyncArgs(json: string | undefined): BrowserSyncArgs {
  let parsed: any;
  try {
    parsed = json ? JSON.parse(json) : {};
  } catch {
    throw new Error("args are not JSON");
  }
  const hostDeviceId = parsed.host_device_id;
  if (typeof hostDeviceId !== "string" || !hostDeviceId) throw new Error("missing host_device_id");
  const cdpPort = parsed.cdp_port;
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) throw new Error(`cdp_port ${cdpPort} is not a port`);
  const origin = parsed.origin ?? null;
  const all = parsed.all === true;
  if (origin !== null && all) throw new Error("origin and all are exclusive");
  if (origin === null && !all) throw new Error("name an origin or all");
  if (origin !== null) {
    if (typeof origin !== "string") throw new Error("origin must be a string");
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      throw new Error(`${origin} is not an http(s) origin`);
    }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin !== origin) throw new Error(`${origin} is not an http(s) origin`);
  }
  const conversationId = typeof parsed.conversation_id === "string" && parsed.conversation_id ? parsed.conversation_id : undefined;
  return { hostDeviceId, cdpPort, origin, all, ...(conversationId ? { conversationId } : {}) };
}

/** The `cast cloud browser-sync` argv the daemon runs for these args. */
export function browserSyncArgv(a: BrowserSyncArgs): string[] {
  return [
    "cloud", "browser-sync", a.hostDeviceId,
    "--port", String(a.cdpPort),
    ...(a.origin ? ["--origin", a.origin] : ["--all"]),
    ...(a.conversationId ? ["--conversation", a.conversationId] : []),
  ];
}

// ---------------------------------------------------------------------------
// Which laptop Chrome profile, and which host
// ---------------------------------------------------------------------------

/**
 * The real Chrome profile whose cookies are carried: the one the laptop's
 * managed browser was cloned from when there is one (a `remote` state has no
 * sourceProfile), else Chrome's last-used profile, else Default — the same
 * choice startLocalBrowser makes.
 */
export function pickLaptopProfile(
  state: InstanceState | null,
  profiles: RealProfile[],
): { profileDir: string; channel: ChromeChannel } {
  if (state?.sourceProfile) return { profileDir: state.sourceProfile, channel: state.channel };
  return { profileDir: profiles.find((p) => p.lastUsed)?.dir ?? "Default", channel: "chrome" };
}

export interface CarryHostDeps {
  hostForDevice: (deviceId: string) => CloudHost | undefined;
  toRemoteHost: (host: CloudHost) => RemoteHost;
  sshReachable: (host: RemoteHost) => Promise<boolean>;
  hostState: (host: CloudHost) => { state: string; address?: string };
  patchHost: (id: string, patch: Partial<CloudHost>) => CloudHost | undefined;
}

const defaultHostDeps: CarryHostDeps = { hostForDevice, toRemoteHost, sshReachable, hostState, patchHost };

export type ResolvedCarryHost = { ok: true; host: RemoteHost; cloud: CloudHost } | { ok: false; reason: string };

/** The reason a laptop without the host in its registry cannot carry, with the way out. */
export function noRegistryEntryReason(hostDeviceId: string): string {
  return (
    `this laptop's host registry has no entry for device ${hostDeviceId.slice(0, 8)} — run the sync via the laptop ` +
    `that provisioned the host (cast browser sync <site> --via <that laptop's device id>)`
  );
}

/**
 * The ssh target for a host device id, from this laptop's registry. Tries the
 * last-known address; when that is dead, asks AWS for the instance's state
 * and CURRENT address (describe only) — a server-side wake boots the box
 * without any laptop contact, and the new public IP only ever reached the
 * registry through a laptop-side wake. A running host at a new address is
 * recorded through patchHost and probed again. A stopped, pending or missing
 * host is a refusal: nothing here ever starts an instance.
 */
export async function resolveCarryHost(hostDeviceId: string, deps: CarryHostDeps = defaultHostDeps): Promise<ResolvedCarryHost> {
  const cloud = deps.hostForDevice(hostDeviceId);
  if (!cloud) return { ok: false, reason: noRegistryEntryReason(hostDeviceId) };
  if (cloud.browserSync === false) {
    return { ok: false, reason: `cookie carries into host ${cloud.id} are disabled in ~/.codecast/browser/hosts.json (browserSync: false)` };
  }
  if (cloud.address) {
    const remote = deps.toRemoteHost(cloud);
    if (await deps.sshReachable(remote)) return { ok: true, host: remote, cloud };
  }
  let st: { state: string; address?: string };
  try {
    st = deps.hostState(cloud);
  } catch (err) {
    const why = (err as Error).message;
    return {
      ok: false,
      reason: err instanceof AwsCliFailed
        ? `host ${cloud.id} is not reachable at ${cloud.address ?? "its last address"} and the aws CLI could not check its state: ${why}`
        : `host ${cloud.id} is not reachable at ${cloud.address ?? "its last address"} (${why})`,
    };
  }
  if (st.state !== "running") {
    return { ok: false, reason: `host ${cloud.id} is ${st.state} — nothing was carried (a sleeping host is never woken for cookies)` };
  }
  if (st.address && st.address !== cloud.address) {
    const fresh: CloudHost = { ...cloud, address: st.address };
    deps.patchHost(cloud.id, { address: st.address });
    const remote = deps.toRemoteHost(fresh);
    if (await deps.sshReachable(remote)) return { ok: true, host: remote, cloud: fresh };
    return { ok: false, reason: `host ${cloud.id} is running at ${st.address} but not reachable over ssh — nothing was carried` };
  }
  return { ok: false, reason: `host ${cloud.id} is running but not reachable at ${cloud.address ?? "its address"} — nothing was carried` };
}

// ---------------------------------------------------------------------------
// The carry
// ---------------------------------------------------------------------------

export type CarryOutcome = ({ ok: true } & ProvisionResult) | { ok: false; reason: string };

export interface CarryDeps {
  resolveCarryHost: (hostDeviceId: string) => Promise<ResolvedCarryHost>;
  withCdpTunnel: <T>(host: RemoteHost, remotePort: number, fn: (localPort: number) => Promise<T>) => Promise<T>;
  provisionLocalLogins: typeof provisionLocalLogins;
  loadMachinePolicy: typeof loadMachinePolicy;
  readState: () => InstanceState | null;
  listRealProfiles: (channel: ChromeChannel) => RealProfile[];
}

const defaultCarryDeps: CarryDeps = {
  resolveCarryHost: (id) => resolveCarryHost(id),
  withCdpTunnel: (host, port, fn) => withCdpTunnel(host, port, fn, { deadlineMs: BROWSER_SYNC_CARRY_DEADLINE_MS }),
  provisionLocalLogins,
  loadMachinePolicy,
  readState,
  listRealProfiles: (channel) => listRealProfiles(channel),
};

/**
 * Carry this laptop's login for `a.origin` (or the whole jar) into the host
 * Chrome named by the args. The order is the security order: Google is
 * refused before anything, the laptop's own `browser_allow` bounds what its
 * Keychain-decrypted cookies may be sent to (the host applied its project +
 * machine policy before asking), and only then does anything reach ssh. The
 * injection is provisionLocalLogins itself, through the tunnel: the same
 * own-login exclusion, the same "already has the same cookies" idempotency
 * and the same Storage.setCookies the laptop's own browser gets.
 */
export async function carryLoginsToHost(a: BrowserSyncArgs, deps: CarryDeps = defaultCarryDeps): Promise<CarryOutcome> {
  const hostname = a.origin ? new URL(a.origin).hostname : null;
  if (hostname && keepsOwnLogin(hostname)) return { ok: true, injected: 0, host: hostname, reason: OWN_LOGIN_REASON };

  const policy = deps.loadMachinePolicy();
  if (policy) {
    if (a.all) return { ok: false, reason: "with browser_allow set on this laptop, name the site (a whole-jar carry is refused under a site allowlist)" };
    const verdict = checkUrl(policy, a.origin!);
    if (!verdict.allowed) return { ok: false, reason: `this laptop refuses to carry its login: ${verdict.reason}` };
  }

  const resolved = await deps.resolveCarryHost(a.hostDeviceId);
  if (!resolved.ok) return resolved;

  const state = deps.readState();
  const source = pickLaptopProfile(state, state?.sourceProfile ? [] : deps.listRealProfiles("chrome"));
  try {
    const r = await deps.withCdpTunnel(resolved.host, a.cdpPort, (localPort) => deps.provisionLocalLogins(localPort, a.origin, source));
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * The one line the child prints: counts and a reason, never a cookie. Picks
 * the allowed keys explicitly so a widened ProvisionResult can never leak
 * names, domains or values through here.
 */
export function carrySummaryLine(r: CarryOutcome): string {
  if (!r.ok) return JSON.stringify({ ok: false, reason: r.reason });
  return JSON.stringify({
    ok: true,
    injected: r.injected,
    ...(r.sites !== undefined ? { sites: r.sites } : {}),
    ...(r.rejected !== undefined ? { rejected: r.rejected } : {}),
    host: r.host,
    ...(r.reason ? { reason: r.reason } : {}),
  });
}

// ---------------------------------------------------------------------------
// The daemon's handler
// ---------------------------------------------------------------------------

/** The child's cap: poll latency + an ssh handshake on a lossy link + the Keychain read + CDP. */
export const BROWSER_SYNC_CHILD_TIMEOUT_MS = 3 * 60 * 1000;
/**
 * The child's OWN deadline for the whole carry (tunnel up, cookies read,
 * cookies injected), shorter than the daemon's cap by a margin: the daemon's
 * timeout is a SIGKILL, under which the child's `finally` never runs and its
 * `ssh -N` forward would outlive it. One established :22 connection keeps the
 * host's idle watchdog from ever sleeping the box, so the child must close
 * the tunnel itself, before the daemon gives up on it.
 */
export const BROWSER_SYNC_CARRY_DEADLINE_MS = BROWSER_SYNC_CHILD_TIMEOUT_MS - 30_000;

export interface BrowserSyncHandlerDeps {
  isRemoteDevice: () => boolean;
  /**
   * `killGroup` asks for the child to run in its own process group and for the
   * cap to kill that whole group, so the ssh forward dies with the child even
   * when the child's own deadline did not fire (the second layer).
   */
  runCastCommand: (args: string[], opts: { timeoutMs?: number; killGroup?: boolean }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  log: (message: string, level?: "info" | "warn" | "error") => void;
  childErrorDetail: (stderr: string, stdout?: string) => string;
  /** Per-host carries in flight; module-level by default, injectable for tests. */
  inFlight?: Map<string, Promise<unknown>>;
}

// Concurrent requests for one host serialize behind the running carry
// instead of opening a second tunnel: the daemon's poll, subscription and
// heartbeat batches run concurrently, so two host sessions asking at once
// would otherwise both open a forward. The second request then finds the
// first's cookies already there ("already has the same cookies").
const browserSyncInFlight = new Map<string, Promise<unknown>>();

/** The last stdout line that is a JSON object, or null. */
function lastJsonLine(stdout: string): string | null {
  return stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{")) ?? null;
}

/**
 * The daemon's `cloud_browser_sync` case: a laptop-only, command-driven
 * handler with no timer and no retry — a failed carry is reported once, and
 * only a new `sync` on the host makes another ssh connection. Returns the
 * command's result or error string; never a cookie in either.
 */
export async function handleBrowserSyncCommand(
  commandArgs: string | undefined,
  deps: BrowserSyncHandlerDeps,
): Promise<{ result?: string; error?: string }> {
  if (deps.isRemoteDevice()) return { error: "cloud_browser_sync: a cloud host holds no logins to carry" };
  let a: BrowserSyncArgs;
  try {
    a = parseBrowserSyncArgs(commandArgs);
  } catch (err) {
    return { error: `cloud_browser_sync: ${(err as Error).message}` };
  }
  const inFlight = deps.inFlight ?? browserSyncInFlight;
  const prev = inFlight.get(a.hostDeviceId);
  if (prev) deps.log(`[BROWSER-SYNC] a carry into device ${a.hostDeviceId.slice(0, 8)} is running — waiting for it first`);
  const carry = async () => {
    deps.log(`[BROWSER-SYNC] carrying ${a.origin ?? "every site"} to device ${a.hostDeviceId.slice(0, 8)}:${a.cdpPort} (async child)`);
    const res = await deps.runCastCommand(browserSyncArgv(a), { timeoutMs: BROWSER_SYNC_CHILD_TIMEOUT_MS, killGroup: true });
    const line = lastJsonLine(res.stdout);
    if (res.code === 0 && line) {
      deps.log(`[BROWSER-SYNC] done for device ${a.hostDeviceId.slice(0, 8)}: ${line}`);
      return { result: line };
    }
    let refused: string | undefined;
    if (line) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.ok === false && typeof parsed.reason === "string") refused = parsed.reason;
      } catch { /* not the child's line */ }
    }
    const detail = deps.childErrorDetail(res.stderr, res.stdout);
    const error = refused ?? `login carry failed (exit ${res.code})${detail ? `: ${detail}` : ""}`;
    deps.log(`[BROWSER-SYNC] FAILED for device ${a.hostDeviceId.slice(0, 8)}: ${error}`, "warn");
    return { error };
  };
  // Chain onto the running carry and claim the slot SYNCHRONOUSLY: a
  // wait-then-claim would let every request parked on the same predecessor
  // wake together and each open its own tunnel.
  const run = (prev ?? Promise.resolve()).catch(() => {}).then(carry);
  inFlight.set(a.hostDeviceId, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(a.hostDeviceId) === run) inFlight.delete(a.hostDeviceId);
  }
}

// ---------------------------------------------------------------------------
// Host-side words
// ---------------------------------------------------------------------------

export const DATACENTER_IP_NOTE =
  "this host's address is a datacenter IP: Google and DuckDuckGo may show a bot challenge or CAPTCHA regardless of login (Bing works); a carried login does not lift those walls";

/**
 * The sign-in landing note on the cloud host, replacing the laptop one: the
 * laptop's note promises a carry that already happened and a `cast browser
 * login` the host does not have. Null when the URL is not a sign-in page.
 */
export function cloudHostSignInHint(url: string): string | null {
  const host = signInHost(url);
  if (!host) return null;
  return (
    `landed on a sign-in page (${host}) — this session runs on the cloud host, whose browser starts signed out: ` +
    `\`cast browser sync ${host}\` asks your laptop to carry its login here over SSH ` +
    `(Google excepted — never carried, and this host has no Google account). ${DATACENTER_IP_NOTE}`
  );
}

/** One actionable line for a request that came back with an error. */
export function explainSyncFailure(error: string): { message: string; hint?: string } {
  if (error === "expired_ttl") {
    return {
      message: "your laptop never picked the request up within 5 minutes (asleep, or its daemon stopped)",
      hint: "wake the laptop (or `cast daemon start` there) and rerun `cast browser sync <site>`",
    };
  }
  if (/Unknown command/.test(error)) {
    return { message: "your laptop's cast is older than this host's — update it there", hint: "on the laptop: `cast update`, then rerun the sync" };
  }
  if (/no entry for device/.test(error)) {
    return { message: error, hint: "cast browser sync <site> --via <device id of the laptop that provisioned this host>" };
  }
  if (/Keychain/.test(error)) {
    return {
      message: error,
      hint: "on the laptop run `cast browser sync <site>` once in a terminal and click Always Allow on the Keychain prompt",
    };
  }
  return { message: error };
}
