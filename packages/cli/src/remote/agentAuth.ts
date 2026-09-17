/**
 * The agent auth bundle: every agent login this laptop holds, gated per
 * harness, carried to a host in ONE ssh round trip (remote/session-move.ts
 * copyAgentAuthToRemote*) and applied there by the python receiver
 * (remote/agentAuthReceiver.py.ts).
 *
 * Pure planners live here so they can be unit-tested without ssh: what to
 * ship (`collectAgentAuthBundle`), whether a blob is worth shipping (the
 * `*AuthHealth` gates), the content hash the daemon dedupes on
 * (`bundleHash`), which hosts a tick should push to (`planAgentAuthPush`),
 * and the allow-listed slice of ~/.claude/settings.json env
 * (`readClaudeSettingsEnvForMirror`).
 *
 * One-way by design, like the Claude credential push: the laptop is
 * canonical, the host never originates a login. Each gate mirrors what the
 * harness does with the grant — codex rotates its refresh token on refresh
 * (so only a live access-token JWT ships), Google does not rotate gemini's
 * refresh token (so `refresh_token` present is the whole test), grok's file
 * is a scope-keyed map with no expiry, opencode/pi carry per-provider
 * entries with their own `expires`.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { PROVIDER_KEYS, type AgentClientId } from "@codecast/shared/contracts";
import { MIRROR_EXCLUDED_ENV_VARS } from "../agentEnv.js";
import { agentSpawnPath } from "../agentSpawnPath.js";
import { decodeCodexAuth } from "../codexAuthDecode.js";
import type { RemoteHost } from "./session-move.js";

// ---------------------------------------------------------------------------
// Bundle shape (the ssh stdin payload; never Convex)
// ---------------------------------------------------------------------------

export interface AgentAuthFile {
  /** `~/`-relative path on the host. */
  path: string;
  content: string;
  mode: number;
  /** codex only: epoch ms of the blob's `last_refresh`, for the host-fresher rule. */
  last_refresh?: number;
}

export interface AgentAuthBundle {
  origin: { user_id: string; device_id: string; pushed_at: string };
  files: AgentAuthFile[];
  /** `~/`-relative paths the laptop no longer has — deleted on the host. */
  absent: string[];
  /** Present = merge these keys into the host's ~/.claude/settings.json env (and drop the ones it mirrored before). */
  claudeEnv?: Record<string, string>;
  /** Repo checkouts / move dirs to append `[projects."<path>"] trust_level = "trusted"` for in the host's ~/.codex/config.toml. */
  codexTrustPaths: string[];
}

export interface AuthGate {
  /** The bytes to ship, or null when the blob must not leave the laptop. */
  ship: string | null;
  reason?: string;
  /** codex: epoch ms of `last_refresh`. */
  lastRefresh?: number;
}

// ---------------------------------------------------------------------------
// Per-harness gates
// ---------------------------------------------------------------------------

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The payload of a JWT, or undefined when it is not one (base64url padding as decodeCodexAuth does for id_token). */
export function jwtPayload(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const pad = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(pad, "base64url").toString("utf-8"));
    return isObject(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

/**
 * codex ~/.codex/auth.json: ship iff the access token is a JWT whose `exp`
 * is in the future (codex's refresh rotates the refresh token, so an expired
 * blob pushed to the host would make the host refresh and orphan the
 * laptop's copy). An API-key login (no usable tokens, `OPENAI_API_KEY` a
 * non-empty string) has no rotating grant and ships as is. Note the
 * ChatGPT-mode blob carries `OPENAI_API_KEY: null` BESIDE its tokens, so the
 * JWT decides whenever tokens are present.
 */
export function codexAuthHealth(raw: string | null, now = Date.now()): AuthGate {
  if (raw === null) return { ship: null, reason: "no codex login" };
  const parsed = parseJson(raw);
  if (!isObject(parsed)) return { ship: null, reason: "malformed" };
  const summary = decodeCodexAuth(raw);
  const lastRefresh = summary.last_refresh;
  const tokens = isObject(parsed.tokens) ? parsed.tokens : undefined;
  if (summary.usable && tokens) {
    const claims = jwtPayload(tokens.access_token);
    const exp = typeof claims?.exp === "number" ? claims.exp * 1000 : undefined;
    if (exp === undefined) return { ship: null, reason: "malformed", ...(lastRefresh !== undefined ? { lastRefresh } : {}) };
    if (exp <= now) return { ship: null, reason: "access token expired", ...(lastRefresh !== undefined ? { lastRefresh } : {}) };
    return { ship: raw, ...(lastRefresh !== undefined ? { lastRefresh } : {}) };
  }
  if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY) return { ship: raw, ...(lastRefresh !== undefined ? { lastRefresh } : {}) };
  return { ship: null, reason: "logged-out stub" };
}

/**
 * gemini ~/.gemini/oauth_creds.json: ship iff it carries a refresh_token.
 * `expiry_date` is the one-hour Google access token, refreshed with a refresh
 * token Google does not rotate — an expiry gate would almost never ship.
 */
export function geminiAuthHealth(raw: string | null): AuthGate {
  if (raw === null) return { ship: null, reason: "no gemini login" };
  const parsed = parseJson(raw);
  if (!isObject(parsed)) return { ship: null, reason: "malformed" };
  if (typeof parsed.refresh_token === "string" && parsed.refresh_token) return { ship: raw };
  return { ship: null, reason: "no refresh token" };
}

/** `expires`/`expires_at` in seconds or milliseconds → epoch ms, or undefined when absent/unparseable. */
function expiryMs(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * grok ~/.grok/auth.json: `{ "<scope url>": { "key": "<token>" }, … }` per
 * xAI's installer — no expiry field. Ship iff some scope entry has a
 * non-empty string `key`; an entry that does carry `expires`/`expires_at`
 * (seconds or ms) is honored.
 */
export function grokAuthHealth(raw: string | null, now = Date.now()): AuthGate {
  if (raw === null) return { ship: null, reason: "no grok login" };
  const parsed = parseJson(raw);
  if (!isObject(parsed)) return { ship: null, reason: "malformed" };
  let expired = false;
  for (const entry of Object.values(parsed)) {
    if (!isObject(entry) || typeof entry.key !== "string" || !entry.key) continue;
    const exp = expiryMs(entry.expires_at ?? entry.expires);
    if (exp !== undefined && exp <= now) { expired = true; continue; }
    return { ship: raw };
  }
  return { ship: null, reason: expired ? "every key expired" : "no key" };
}

/**
 * opencode / pi auth.json: a provider-keyed map. Drop `type:"oauth"` entries
 * whose `expires` is past (their refresh may rotate), keep api/api_key/
 * wellknown entries; null when nothing remains. Returns the filtered blob.
 */
export function filterProviderAuthMap(raw: string | null, now = Date.now()): AuthGate {
  if (raw === null) return { ship: null, reason: "no login" };
  const parsed = parseJson(raw);
  if (!isObject(parsed)) return { ship: null, reason: "malformed" };
  const kept: Record<string, unknown> = {};
  let dropped = 0;
  for (const [provider, entry] of Object.entries(parsed)) {
    if (!isObject(entry)) continue;
    if (entry.type === "oauth") {
      const exp = expiryMs(entry.expires);
      if (exp !== undefined && exp <= now) { dropped++; continue; }
    }
    kept[provider] = entry;
  }
  if (!Object.keys(kept).length) return { ship: null, reason: dropped ? "every entry expired" : "no entries" };
  return { ship: JSON.stringify(kept, null, 2) + "\n" };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface AgentAuthSource {
  id: string;
  client: AgentClientId;
  /** Where the file lives on THIS machine (honours the harness's own env overrides). */
  localPath: (home: string, env: NodeJS.ProcessEnv) => string;
  /** Where it lives on the host, `~/`-relative (the harness's default there). */
  remotePath: string;
  gate: (raw: string | null, now: number) => AuthGate;
  /** Ships only alongside this source (google_accounts.json beside live gemini creds). */
  requires?: string;
}

const xdgData = (home: string, env: NodeJS.ProcessEnv) => env.XDG_DATA_HOME || path.join(home, ".local", "share");

export const AGENT_AUTH_SOURCES: readonly AgentAuthSource[] = [
  { id: "codex", client: "codex", localPath: (h, e) => path.join(e.CODEX_HOME || path.join(h, ".codex"), "auth.json"), remotePath: "~/.codex/auth.json", gate: codexAuthHealth },
  { id: "grok", client: "grok", localPath: (h, e) => path.join(e.GROK_HOME || path.join(h, ".grok"), "auth.json"), remotePath: "~/.grok/auth.json", gate: grokAuthHealth },
  { id: "gemini", client: "gemini", localPath: (h) => path.join(h, ".gemini", "oauth_creds.json"), remotePath: "~/.gemini/oauth_creds.json", gate: (raw) => geminiAuthHealth(raw) },
  { id: "gemini-accounts", client: "gemini", localPath: (h) => path.join(h, ".gemini", "google_accounts.json"), remotePath: "~/.gemini/google_accounts.json", gate: (raw) => (raw === null ? { ship: null, reason: "absent" } : { ship: raw }), requires: "gemini" },
  { id: "opencode", client: "opencode", localPath: (h, e) => path.join(xdgData(h, e), "opencode", "auth.json"), remotePath: "~/.local/share/opencode/auth.json", gate: filterProviderAuthMap },
  { id: "pi", client: "pi", localPath: (h) => path.join(h, ".pi", "agent", "auth.json"), remotePath: "~/.pi/agent/auth.json", gate: filterProviderAuthMap },
];

/** The exact filenames the daemon's fs.watch reacts to, per source directory. */
export const AGENT_AUTH_WATCH_FILES: ReadonlySet<string> = new Set(["auth.json", "oauth_creds.json", "google_accounts.json", "settings.json"]);

/** The directories the daemon watches for a login change (existing ones only). */
export function agentAuthWatchDirs(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = new Set<string>();
  for (const s of AGENT_AUTH_SOURCES) dirs.add(path.dirname(s.localPath(home, env)));
  dirs.add(path.join(home, ".claude"));
  return [...dirs];
}

// ---------------------------------------------------------------------------
// settings.json env allow-list
// ---------------------------------------------------------------------------

const PROVIDER_ENV_NAMES: ReadonlySet<string> = new Set(PROVIDER_KEYS.flatMap((p) => p.envVars));
const API_KEY_NAME = /^[A-Z][A-Z0-9_]*_API_KEY$/;

export interface MirrorEnvRead {
  env: Record<string, string>;
  skipped: Array<{ key: string; reason: string }>;
}

/** Why a settings.json env key must not reach the host, or null when it may. */
export function mirrorEnvSkipReason(key: string, value: unknown, home: string): string | null {
  if (key === "ANTHROPIC_API_KEY") return "never mirrored (it would move every claude on the host off the subscription)";
  if (MIRROR_EXCLUDED_ENV_VARS.includes(key)) return "codecast-owned";
  if (key === "CLAUDE_CONFIG_DIR") return "laptop path";
  if (/_BASE_URL$/.test(key)) return "routing";
  if (/PROXY/i.test(key)) return "proxy";
  if (!API_KEY_NAME.test(key) && !PROVIDER_ENV_NAMES.has(key)) return "not a provider key";
  if (typeof value !== "string") return "not a string";
  if (!value) return "empty";
  if (home && value.includes(home)) return "contains the laptop home";
  if (value.startsWith("/")) return "a path";
  if (/localhost|127\.0\.0\.1/.test(value)) return "loopback";
  return null;
}

/**
 * The provider-key slice of the laptop's ~/.claude/settings.json env: keys
 * named `*_API_KEY` or listed in the provider-key registry, minus
 * ANTHROPIC_API_KEY (providerKeyLaunch.ts: it silently moves a claude off
 * the subscription), base URLs, proxies, config dirs and codecast's own
 * vars; values that are paths, loopback or contain the laptop home stay.
 * `{}` for an absent or unparseable file.
 */
export function readClaudeSettingsEnvForMirror(home: string): MirrorEnvRead {
  const out: MirrorEnvRead = { env: {}, skipped: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf-8"));
  } catch {
    return out;
  }
  if (!isObject(parsed) || !isObject(parsed.env)) return out;
  for (const [key, value] of Object.entries(parsed.env)) {
    const reason = mirrorEnvSkipReason(key, value, home);
    if (reason) out.skipped.push({ key, reason });
    else out.env[key] = value as string;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

export interface CollectOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  userId: string;
  deviceId: string;
  codexTrustPaths?: string[];
  /** Leave the settings.json env out (a trust-only bundle). */
  withClaudeEnv?: boolean;
}

export interface CollectedBundle {
  bundle: AgentAuthBundle;
  skipped: Array<{ id: string; reason: string }>;
  /** settings.json env keys left behind, with why. */
  envSkipped: Array<{ key: string; reason: string }>;
}

/** The file's text (through a symlink: a dotfile-managed auth file is still the login), "missing", or "not a regular file". */
function readIfFile(file: string): { text: string } | "missing" | "not a regular file" {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return "not a regular file";
    return { text: fs.readFileSync(file, "utf-8") };
  } catch {
    return "missing";
  }
}

/**
 * Everything worth pushing right now. A source with no local file lands in
 * `absent`: the receiver removes the host's copy only when THIS device was
 * the one that pushed it (the host's agent-auth-origin.json records the
 * pushing device per path), so a laptop `codex logout` logs the host out of
 * the grant it pushed, while a second laptop of the same user, or a login
 * made on the host itself, is never deleted by a laptop that lacks the file.
 * A present file its gate refuses is SKIPPED — reported, and the host keeps
 * whatever it has.
 */
export function collectAgentAuthBundle(opts: CollectOptions): CollectedBundle {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const files: AgentAuthFile[] = [];
  const absent: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const shipped = new Set<string>();
  for (const source of AGENT_AUTH_SOURCES) {
    const read = readIfFile(source.localPath(opts.home, env));
    if (read === "missing") { absent.push(source.remotePath); continue; }
    if (typeof read === "string") { skipped.push({ id: source.id, reason: read }); continue; }
    const raw = read.text;
    if (source.requires && !shipped.has(source.requires)) { skipped.push({ id: source.id, reason: `${source.requires} not shipped` }); continue; }
    const gate = source.gate(raw, now);
    if (gate.ship === null) { skipped.push({ id: source.id, reason: gate.reason ?? "not pushable" }); continue; }
    shipped.add(source.id);
    files.push({ path: source.remotePath, content: gate.ship, mode: 0o600, ...(gate.lastRefresh !== undefined ? { last_refresh: gate.lastRefresh } : {}) });
  }
  const bundle: AgentAuthBundle = {
    origin: { user_id: opts.userId, device_id: opts.deviceId, pushed_at: new Date(now).toISOString() },
    files,
    absent,
    codexTrustPaths: [...(opts.codexTrustPaths ?? [])],
  };
  let envSkipped: Array<{ key: string; reason: string }> = [];
  if (opts.withClaudeEnv !== false) {
    const read = readClaudeSettingsEnvForMirror(opts.home);
    bundle.claudeEnv = read.env;
    envSkipped = read.skipped;
  }
  return { bundle, skipped, envSkipped };
}

/** A trust-only bundle: no files, no env, no stamp on the host — just the trust table(s). */
export function trustOnlyBundle(origin: { userId: string; deviceId: string }, paths: string[], now = Date.now()): AgentAuthBundle {
  return { origin: { user_id: origin.userId, device_id: origin.deviceId, pushed_at: new Date(now).toISOString() }, files: [], absent: [], codexTrustPaths: [...paths] };
}

/** sha256 of a canonical serialization (sorted, without pushed_at) — the daemon's change signal. */
export function bundleHash(bundle: AgentAuthBundle): string {
  const canonical = {
    user_id: bundle.origin.user_id,
    device_id: bundle.origin.device_id,
    files: [...bundle.files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ path: f.path, content: f.content, mode: f.mode, last_refresh: f.last_refresh ?? null })),
    absent: [...bundle.absent].sort(),
    claudeEnv: bundle.claudeEnv ? Object.keys(bundle.claudeEnv).sort().map((k) => [k, bundle.claudeEnv![k]]) : null,
    codexTrustPaths: [...bundle.codexTrustPaths].sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Defense in depth behind the env allow-list: no laptop home path may leave
 * in an env value or a file body. Trust paths are host paths by
 * construction and are not checked (a Linux laptop and the host can share
 * `/home/<user>`).
 */
export function assertNoLaptopPaths(bundle: AgentAuthBundle, home: string): void {
  if (!home || home === "/") return;
  for (const [k, v] of Object.entries(bundle.claudeEnv ?? {})) {
    if (v.includes(home)) throw new Error(`env ${k} carries the laptop home path`);
  }
  for (const f of bundle.files) {
    if (f.content.includes(home)) throw new Error(`${f.path} carries the laptop home path`);
  }
}

/** The bundle's one-line description for logs: which harnesses ship. */
export function describeBundle(bundle: AgentAuthBundle): string {
  const ids = bundle.files.map((f) => AGENT_AUTH_SOURCES.find((s) => s.remotePath === f.path)?.id ?? f.path).filter((id) => id !== "gemini-accounts");
  const env = bundle.claudeEnv ? Object.keys(bundle.claudeEnv).length : 0;
  return `${ids.length ? ids.join(", ") : "no logins"}${env ? `, ${env} env key${env === 1 ? "" : "s"}` : ""}${bundle.codexTrustPaths.length ? `, trust ${bundle.codexTrustPaths.length}` : ""}`;
}

// ---------------------------------------------------------------------------
// The daemon's per-host plan
// ---------------------------------------------------------------------------

export function agentAuthHostKey(host: RemoteHost): string {
  return `${host.user}@${host.address}`;
}

/**
 * Which hosts a tick pushes to. `lastByHost` is keyed by user@address and
 * holds the hash LAST ATTEMPTED per host (success or failure): a hash-gated
 * tick skips hosts that already got this bundle (and hosts whose last try
 * of this very bundle failed — a push that retried every minute would keep
 * a broken box awake); a periodic tick pushes to every host. A host that
 * came back on a new address has no entry and is pushed.
 */
export function planAgentAuthPush(hosts: RemoteHost[], hash: string, lastByHost: ReadonlyMap<string, string>, opts: { onlyIfChanged?: boolean } = {}): RemoteHost[] {
  if (!opts.onlyIfChanged) return [...hosts];
  return hosts.filter((h) => lastByHost.get(agentAuthHostKey(h)) !== hash);
}

// ---------------------------------------------------------------------------
// Installed client versions (for provisioning the same CLIs on the host)
// ---------------------------------------------------------------------------

/**
 * Every launchable agent whose login the bundle ships gets its CLI too: a
 * cloud session with `--agent opencode` must not find an auth file and no binary.
 */
export type InstallableClient = "claude" | "codex" | "gemini" | "grok" | "opencode" | "pi";
export const INSTALLABLE_CLIENTS: readonly InstallableClient[] = ["claude", "codex", "gemini", "grok", "opencode", "pi"];

/** The first `x.y.z` in a `--version` output ("2.1.263 (Claude Code)", "codex-cli 0.153.4"). */
export function parseClientVersion(out: string): string | undefined {
  return /\d+\.\d+\.\d+/.exec(out)?.[0];
}

/**
 * `<bin> --version` for each agent CLI on this laptop's spawn PATH
 * (agentSpawnPath: the daemon's launchd PATH lacks every install dir; opencode
 * and grok install into their own ~/.opencode/bin and ~/.grok/bin);
 * absent binaries are left out. `opts.path` replaces the PATH entirely
 * (tests: a dir of stubs).
 */
export function readInstalledClientVersions(opts: { path?: string; env?: NodeJS.ProcessEnv } = {}): Partial<Record<InstallableClient, string>> {
  const out: Partial<Record<InstallableClient, string>> = {};
  const home = (opts.env ?? process.env).HOME;
  const spawnEnv = { ...(opts.env ?? process.env), PATH: opts.path ?? agentSpawnPath(home && `${home}/.opencode/bin`, home && `${home}/.grok/bin`) };
  for (const bin of INSTALLABLE_CLIENTS) {
    const which = spawnSync("which", [bin], { encoding: "utf-8", env: spawnEnv });
    const found = which.status === 0 ? which.stdout.trim() : "";
    if (!found) continue;
    const r = spawnSync(found, ["--version"], { encoding: "utf-8", env: spawnEnv, timeout: 15_000 });
    const version = parseClientVersion(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
    if (version) out[bin] = version;
  }
  return out;
}

/** The laptop's home for the bundle: $HOME first (bun caches os.homedir() at startup). */
export function laptopHome(): string {
  return process.env.HOME || os.homedir();
}
