// Claude Code account profiles: save and swap the machine-global CC login
// without the OAuth browser flow. An "account" is exactly two artifacts:
//   1. the credential blob — macOS Keychain item "Claude Code-credentials"
//      (Linux/older CC: ~/.claude/.credentials.json): OAuth access + refresh
//      tokens, subscription tier
//   2. the oauthAccount identity block in ~/.claude.json (email/org/uuid —
//      what /status displays)
// A profile snapshots both. Secrets live where CC's own secret lives (keychain
// item codecast-cc-account-<name> on darwin, 0600 file on linux);
// ~/.codecast/cc-accounts.json is a NON-SECRET index (names/emails/tiers) so
// listing never touches the keychain.
//
// Two rules this module exists to enforce:
//   - save-on-switch: re-snapshot the OUTGOING account at switch time. CC
//     rotates tokens continuously, so the active credential is the only fresh
//     copy of that grant; a dormant profile never rots because nothing
//     refreshes it. Restoring a stale snapshot hands CC revoked tokens.
//   - a swap takes effect for NEW claude processes only: running ones hold
//     their token in memory, so blocked sessions must be killed + resumed to
//     adopt the new account (the daemon's switch_account command does this).

import { execFileSync } from "./proc.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readLocalCredential } from "./remote/session-move.js";
import { readProfileIndexFile } from "./readForUpdate.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { renderProviderEnvFile, sourceFilePrefix } from "./providerKeyLaunch.js";

const ACTIVE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const PROFILE_KEYCHAIN_PREFIX = "codecast-cc-account-";

export interface CcProfile {
  credentials: any; // parsed credential JSON ({ claudeAiOauth: {...} })
  oauthAccount: Record<string, any>;
  saved_at: number;
}

export interface CcProfileMeta {
  name: string;
  email?: string;
  uuid?: string;
  tier?: string;
  subscription?: string;
  saved_at?: number;
  active: boolean;
}

export class CcAccountError extends Error {}

const VALID_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/i;

export function assertValidProfileName(name: string): void {
  if (!VALID_PROFILE_NAME.test(name)) {
    throw new CcAccountError(
      `Invalid profile name "${name}" (use letters/digits/dot/dash/underscore, max 41 chars)`,
    );
  }
}

function useFileStore(): boolean {
  return process.platform !== "darwin" || process.env.CC_ACCOUNTS_FORCE_FILE === "1";
}

/** $HOME first (bun's os.homedir() caches at startup and ignores later env
 * changes, which breaks $HOME-sandboxed tests), os.homedir() as fallback. */
function homeDir(): string {
  return process.env.HOME || os.homedir();
}

function codecastDir(): string {
  return path.join(homeDir(), ".codecast");
}

function profileFileDir(): string {
  return path.join(codecastDir(), "cc-accounts");
}

function indexPath(): string {
  return path.join(codecastDir(), "cc-accounts.json");
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Build a profile snapshot from the raw credential string + identity block. */
export function buildProfile(
  credentialJson: string,
  oauthAccount: Record<string, any> | null,
  now: number,
): CcProfile {
  let credentials: any;
  try {
    credentials = JSON.parse(credentialJson);
  } catch {
    throw new CcAccountError("Active Claude Code credential is not valid JSON");
  }
  if (!credentials || typeof credentials !== "object" || !credentials.claudeAiOauth) {
    throw new CcAccountError(
      "Active Claude Code credential has no claudeAiOauth block (API-key logins have no profile to save)",
    );
  }
  return { credentials, oauthAccount: oauthAccount ?? {}, saved_at: now };
}

/** Parse + validate a stored profile blob (tolerates hand-saved variants). */
export function parseProfile(raw: string): CcProfile {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CcAccountError("Stored profile is not valid JSON");
  }
  if (!parsed?.credentials?.claudeAiOauth) {
    throw new CcAccountError("Stored profile has no credentials.claudeAiOauth block");
  }
  return {
    credentials: parsed.credentials,
    oauthAccount: parsed.oauthAccount ?? {},
    saved_at: typeof parsed.saved_at === "number" ? parsed.saved_at : 0,
  };
}

export interface CredentialHealth {
  /** Real tokens present — a login that can work (possibly after a refresh). */
  usable: boolean;
  /** Usable AND the access token is still live — safe to copy to a remote,
   * which must never refresh on its own (a rotated refresh token would
   * invalidate the primary's). */
  pushable: boolean;
  expiresAt: number | null;
  reason?: string;
}

/**
 * Classify a credential blob before trusting it anywhere. The dangerous shape
 * is the logged-out stub CC leaves behind after /logout: intact metadata
 * (scopes, tier, refreshTokenExpiresAt) but EMPTY tokens and expiresAt 0.
 * Snapshotting that stub silently overwrites a good profile with a broken one;
 * activating or pushing it turns every session on the machine (and any remote
 * running a pushed copy) into "Login expired · run /login". An expired blob
 * with a refresh token is still usable locally (CC refreshes on first use) but
 * never pushable — a live access token is the only thing worth shipping.
 */
export function credentialHealth(raw: string | null, now: number = Date.now()): CredentialHealth {
  if (!raw) return { usable: false, pushable: false, expiresAt: null, reason: "no credential" };
  let oauth: any;
  try {
    oauth = JSON.parse(raw)?.claudeAiOauth;
  } catch {
    return { usable: false, pushable: false, expiresAt: null, reason: "credential is not valid JSON" };
  }
  if (!oauth || typeof oauth !== "object") {
    return { usable: false, pushable: false, expiresAt: null, reason: "no claudeAiOauth block (API-key login?)" };
  }
  const accessToken = typeof oauth.accessToken === "string" ? oauth.accessToken : "";
  const refreshToken = typeof oauth.refreshToken === "string" ? oauth.refreshToken : "";
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : null;
  if (!accessToken && !refreshToken) {
    return { usable: false, pushable: false, expiresAt, reason: "logged-out stub (empty tokens)" };
  }
  if (!accessToken || expiresAt == null || expiresAt <= now) {
    return { usable: true, pushable: false, expiresAt, reason: "access token expired (locally refreshable, not pushable)" };
  }
  return { usable: true, pushable: true, expiresAt };
}

/** Non-secret metadata for the index / heartbeat / UI. */
export function profileMeta(profile: CcProfile): Omit<CcProfileMeta, "name" | "active"> {
  const oauth = profile.credentials?.claudeAiOauth ?? {};
  return {
    email: profile.oauthAccount?.emailAddress,
    uuid: profile.oauthAccount?.accountUuid,
    tier: oauth.rateLimitTier,
    subscription: oauth.subscriptionType,
    saved_at: profile.saved_at,
  };
}

// ---------------------------------------------------------------------------
// Active credential + identity (the machine-global login)
// ---------------------------------------------------------------------------

export function readActiveCredential(): string | null {
  // Mirror writeActiveCredential's store selection so reads and writes always
  // hit the SAME place. Without this the file-store gate (non-darwin, or
  // CC_ACCOUNTS_FORCE_FILE) would write the file while reads still probed the
  // keychain — the source of the sandbox reading the machine's real login.
  if (useFileStore()) {
    const f = path.join(homeDir(), ".claude", ".credentials.json");
    if (!fs.existsSync(f)) return null;
    return fs.readFileSync(f, "utf-8");
  }
  return readLocalCredential();
}

/** The keychain item's account attribute ("acct"). CC created the item, so
 * match whatever it used; fall back to the unix username (observed value). */
function keychainAcct(): string {
  try {
    const meta = execFileSync("security", ["find-generic-password", "-s", ACTIVE_KEYCHAIN_SERVICE], {
      encoding: "utf-8",
    });
    const m = meta.match(/"acct"<blob>="([^"]*)"/);
    if (m?.[1]) return m[1];
  } catch {}
  return os.userInfo().username;
}

export function writeActiveCredential(credentialJson: string): void {
  if (useFileStore()) {
    // 0600 is stated, not defaulted: the shared helper keeps whatever mode the
    // file already has, so an existing world-readable credential file would
    // stay world-readable. This is an OAuth token — narrow it on every write.
    atomicWriteFile(path.join(homeDir(), ".claude", ".credentials.json"), credentialJson, {
      mode: 0o600,
    });
    return;
  }
  // -U updates in place, preserving the item (and its ACL) so claude keeps
  // reading it without a keychain prompt — never delete+recreate.
  execFileSync("security", [
    "add-generic-password",
    "-U",
    "-a",
    keychainAcct(),
    "-s",
    ACTIVE_KEYCHAIN_SERVICE,
    "-w",
    credentialJson,
  ]);
}

function claudeJsonPath(): string {
  return path.join(homeDir(), ".claude.json");
}

export function readOauthAccount(): Record<string, any> | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(claudeJsonPath(), "utf-8"));
    return cfg?.oauthAccount ?? null;
  } catch {
    return null;
  }
}

/**
 * Patch ONLY the oauthAccount key in ~/.claude.json.
 *
 * This is a read-modify-write over someone else's file: CC keeps per-project
 * history, MCP servers and settings in it (megabytes on an established machine)
 * and rewrites it non-atomically from every running claude process. So a read
 * that fails is NOT the same as an empty config — it is a config we cannot see.
 * Writing then would publish `{oauthAccount}` alone and destroy every other key,
 * turning a transient torn read into permanent loss. Fail instead: the account
 * switch that calls this is repeatable, the history is not.
 */
export function patchOauthAccount(oauthAccount: Record<string, any>): void {
  const p = claudeJsonPath();

  let raw: string | undefined;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Absent is the ordinary first-run case: nothing to preserve, so create it.
    if (code !== "ENOENT") {
      throw new CcAccountError(
        `Cannot read ${p} (${code}) — refusing to rewrite it, because writing a ` +
          `config we could not read would drop the history and settings in it. ` +
          `Fix the file's permissions, then re-run the switch.`,
      );
    }
  }

  let cfg: Record<string, any> = {};
  // A zero-byte file holds nothing to lose — something else already truncated
  // it — so it starts fresh rather than blocking the switch forever.
  if (raw !== undefined && raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CcAccountError(
        `${p} is not valid JSON — refusing to rewrite it, because writing over ` +
          `it would drop the history and settings in it. A claude process may ` +
          `have been mid-write: re-run the switch, and if it fails again repair ` +
          `or move the file.`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // `typeof null` is "object", so name the shape rather than report it.
      const shape = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
      throw new CcAccountError(
        `${p} parsed as ${shape}, not a config object — refusing to rewrite it. ` +
          `Repair or move the file, then re-run the switch.`,
      );
    }
    cfg = parsed as Record<string, any>;
  }

  cfg.oauthAccount = oauthAccount;
  // No `mode`: we own one key in CC's file, not its permissions. The helper
  // keeps whatever the file has and only falls back to 0600 when creating it.
  atomicWriteFile(p, JSON.stringify(cfg, null, 2));
}

// ---------------------------------------------------------------------------
// Profile secret store (keychain on darwin, 0600 files elsewhere)
// ---------------------------------------------------------------------------

function readProfileSecret(name: string): string | null {
  if (useFileStore()) {
    const f = path.join(profileFileDir(), `${name}.json`);
    if (!fs.existsSync(f)) return null;
    return fs.readFileSync(f, "utf-8");
  }
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", `${PROFILE_KEYCHAIN_PREFIX}${name}`, "-w"],
      { encoding: "utf-8" },
    ).trim();
  } catch {
    return null;
  }
}

function deleteProfileSecret(name: string): void {
  if (useFileStore()) {
    fs.rmSync(path.join(profileFileDir(), `${name}.json`), { force: true });
    return;
  }
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-s", `${PROFILE_KEYCHAIN_PREFIX}${name}`],
      { stdio: "ignore" },
    );
  } catch {
    // Keychain item already gone (index-only entry) — nothing to delete.
  }
}

function writeProfileSecret(name: string, content: string): void {
  if (useFileStore()) {
    // Same reason as writeActiveCredential: a saved profile holds the same
    // token, so the mode is stated rather than inherited from the old file.
    atomicWriteFile(path.join(profileFileDir(), `${name}.json`), content, { mode: 0o600 });
    return;
  }
  execFileSync("security", [
    "add-generic-password",
    "-U",
    "-a",
    os.userInfo().username,
    "-s",
    `${PROFILE_KEYCHAIN_PREFIX}${name}`,
    "-w",
    content,
  ]);
}

// ---------------------------------------------------------------------------
// Non-secret index (~/.codecast/cc-accounts.json) — listing without keychain
// ---------------------------------------------------------------------------

interface ProfileIndex {
  profiles: Record<string, Omit<CcProfileMeta, "name" | "active">>;
}

export function readProfileIndex(): ProfileIndex {
  return readProfileIndexFile<Omit<CcProfileMeta, "name" | "active">>(
    indexPath(),
    (message) => new CcAccountError(message),
  );
}

function writeProfileIndex(index: ProfileIndex): void {
  atomicWriteFile(indexPath(), JSON.stringify(index, null, 2), { mode: 0o644 });
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export function activeAccountSummary(): { email?: string; uuid?: string } | null {
  const acct = readOauthAccount();
  if (!acct) return null;
  return { email: acct.emailAddress, uuid: acct.accountUuid };
}

export function saveProfile(name: string): CcProfileMeta {
  assertValidProfileName(name);
  const cred = readActiveCredential();
  if (!cred) {
    throw new CcAccountError(
      "No active Claude Code credential found — run claude and /login first",
    );
  }
  // Never snapshot an unusable credential: a save-on-switch that runs while
  // the machine is logged out would overwrite the profile's good tokens with
  // the blank stub, and the poison resurfaces on the next switch back.
  const health = credentialHealth(cred);
  if (!health.usable) {
    throw new CcAccountError(
      `Active credential is unusable (${health.reason}) — refusing to snapshot it. Run /login first.`,
    );
  }
  const profile = buildProfile(cred, readOauthAccount(), Date.now());
  writeProfileSecret(name, JSON.stringify(profile));
  const meta = profileMeta(profile);
  const index = readProfileIndex();
  index.profiles[name] = meta;
  writeProfileIndex(index);
  invalidateAccountsCache();
  return { name, ...meta, active: true };
}

export function listProfiles(): CcProfileMeta[] {
  const index = readProfileIndex();
  const activeUuid = activeAccountSummary()?.uuid;
  return Object.entries(index.profiles)
    .map(([name, meta]) => ({
      name,
      ...meta,
      active: !!activeUuid && meta.uuid === activeUuid,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Forget a saved profile: delete its secret snapshot (keychain item / file)
 * and drop it from the index. The account itself is untouched — re-enrolling
 * it later takes one /login. Refuses to remove the profile covering the
 * ACTIVE login: the daemon auto-enrolls any unsaved active login on its next
 * heartbeat, so that removal would silently undo itself within ~30s. */
export function deleteProfile(name: string): CcProfileMeta {
  assertValidProfileName(name);
  const index = readProfileIndex();
  const meta = index.profiles[name];
  if (!meta) {
    throw new CcAccountError(`No saved profile "${name}" on this machine`);
  }
  const active = activeAccountSummary();
  if (
    active &&
    ((active.uuid && meta.uuid === active.uuid) || (active.email && meta.email === active.email))
  ) {
    throw new CcAccountError(
      `Profile "${name}" covers this machine's active login — switch to another account first ` +
        `(the daemon re-saves the active login automatically, so removing it wouldn't stick)`,
    );
  }
  deleteProfileSecret(name);
  removeAccountToken(name);
  delete index.profiles[name];
  writeProfileIndex(index);
  invalidateAccountsCache();
  return { name, ...meta, active: false };
}

// ---------------------------------------------------------------------------
// Per-account launch token (`claude setup-token`)
//
// A setup-token is a static one-year OAuth token that Claude Code reads from
// CLAUDE_CODE_OAUTH_TOKEN, which outranks the keychain login. Nothing about it
// rotates, so none of the refresh / save-on-switch / split-grant machinery
// above applies: it is a string in a 0600 file, sourced into ONE session's env
// at launch. That makes the account a per-session choice instead of the
// machine-global swap `useProfile` performs. The token can only make model
// requests (no profile/usage scope), so identity and usage still come from the
// keychain snapshot — the two live side by side under one profile name.
// ---------------------------------------------------------------------------

const SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
/** Anthropic mints setup-tokens for one year and never warns before expiry;
 *  the file mtime (written at store time) is the only clock we have. */
export const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export function accountTokenFilePath(name: string): string {
  assertValidProfileName(name);
  return path.join(codecastDir(), `cc-account-${name}.env`);
}

/** Store a setup-token for a profile as a 0600 `export` file (same shape and
 *  quoting as the provider-key file, so the launch line only ever carries the
 *  PATH). Rejects anything that isn't a setup-token so a pasted keychain
 *  access token or API key can't be sourced into a session by mistake. */
export function writeAccountToken(name: string, token: string): string {
  const t = token.trim();
  if (!t.startsWith(SETUP_TOKEN_PREFIX) || /\s/.test(t) || t.length < SETUP_TOKEN_PREFIX.length + 20) {
    throw new CcAccountError(`Not a Claude setup-token (expected ${SETUP_TOKEN_PREFIX}…) — mint one with: claude setup-token`);
  }
  const file = accountTokenFilePath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFile(file, renderProviderEnvFile({ CLAUDE_CODE_OAUTH_TOKEN: t }), { mode: 0o600 });
  return file;
}

export function removeAccountToken(name: string): boolean {
  const file = accountTokenFilePath(name);
  const existed = fs.existsSync(file);
  try { fs.rmSync(file, { force: true }); } catch {}
  return existed;
}

export interface AccountTokenInfo {
  file: string;
  stored_at: number;
  expires_at: number;
}

/** Non-secret facts about a stored token, or null when the profile has none. */
export function accountTokenInfo(name: string): AccountTokenInfo | null {
  let file: string;
  try { file = accountTokenFilePath(name); } catch { return null; }
  try {
    const stored_at = fs.statSync(file).mtimeMs;
    return { file, stored_at, expires_at: stored_at + SETUP_TOKEN_LIFETIME_MS };
  } catch {
    return null;
  }
}

/** The token as it appears in `claude setup-token`'s output (or any pane /
 *  clipboard text). Tokens are ~100 chars of URL-safe base64. */
export function extractSetupToken(text: string): string | null {
  const m = /sk-ant-oat01-[A-Za-z0-9_-]{40,}/.exec(text);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Account attribution for a scope-less token. A setup-token can't read its own
// profile or usage, but every model response carries the account's unified
// rate-limit windows. Two credentials whose 5h AND 7d reset timestamps match
// to the second belong to the same account — that is how a freshly minted
// token is proven to belong to the machine's login before it is stored under
// that profile (the browser may have been signed into a different account).
// ---------------------------------------------------------------------------

export interface RateLimitFingerprint {
  five_hour_reset: number | null;
  seven_day_reset: number | null;
  five_hour_utilization: number | null;
  seven_day_utilization: number | null;
}

export function parseRateLimitFingerprint(headers: { get(name: string): string | null }): RateLimitFingerprint {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    five_hour_reset: num("anthropic-ratelimit-unified-5h-reset"),
    seven_day_reset: num("anthropic-ratelimit-unified-7d-reset"),
    five_hour_utilization: num("anthropic-ratelimit-unified-5h-utilization"),
    seven_day_utilization: num("anthropic-ratelimit-unified-7d-utilization"),
  };
}

/** Same account iff both reset timestamps are known and identical. Utilization
 *  is deliberately ignored — it moves between two probes seconds apart. */
export function sameAccountFingerprint(a: RateLimitFingerprint, b: RateLimitFingerprint): boolean {
  return (
    a.five_hour_reset != null &&
    a.seven_day_reset != null &&
    a.five_hour_reset === b.five_hour_reset &&
    a.seven_day_reset === b.seven_day_reset
  );
}

/** Which SAVED profile a scope-less token belongs to, judged from the usage
 *  snapshots (each carries that account's window reset times, fetched with the
 *  profile's own token). The 7d reset is stable for a week and must match; the
 *  5h reset must match too while the snapshot's window is still open (a closed
 *  window has rolled since, so its stale reset proves nothing). Exactly one
 *  hit names the owner; none or several = unknown. This is how a token minted
 *  while the browser was signed into a NON-active account still lands under
 *  the right profile instead of being thrown away. */
export function attributeFingerprint(
  fp: RateLimitFingerprint,
  profiles: Record<string, { uuid?: string; email?: string }>,
  usage: Record<string, CcUsageSnapshot>,
  now: number,
): string | null {
  if (fp.seven_day_reset == null) return null;
  const near = (ms: number | undefined, s: number | null): boolean =>
    ms != null && s != null && Math.abs(ms / 1000 - s) <= 2;
  const hits: string[] = [];
  for (const [name, meta] of Object.entries(profiles)) {
    const snap = usage[meta.uuid || meta.email || ""];
    if (!snap || !near(snap.weekly?.resets_at, fp.seven_day_reset)) continue;
    const sessionOpen = snap.session?.resets_at != null && snap.session.resets_at > now;
    if (sessionOpen && !near(snap.session?.resets_at, fp.five_hour_reset)) continue;
    hits.push(name);
  }
  return hits.length === 1 ? hits[0] : null;
}

export function attributeFingerprintToProfile(fp: RateLimitFingerprint, now: number = Date.now()): string | null {
  return attributeFingerprint(fp, readProfileIndex().profiles, readUsageCache().accounts, now);
}

const CC_MESSAGES_URL = process.env.CODECAST_CC_MESSAGES_URL || "https://api.anthropic.com/v1/messages";
const CC_PROBE_MODEL = process.env.CODECAST_CC_PROBE_MODEL || "claude-haiku-4-5-20251001";

/** One-token model call whose only purpose is the rate-limit headers. Costs a
 *  handful of input tokens on the account; never touches the credential store. */
export async function fetchRateLimitFingerprint(bearerToken: string): Promise<RateLimitFingerprint> {
  const res = await fetch(CC_MESSAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "user-agent": "codecast-account-probe",
    },
    body: JSON.stringify({ model: CC_PROBE_MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(20000),
  });
  const fp = parseRateLimitFingerprint(res.headers);
  // A limit-parked account answers 429 — with the same window headers, which
  // is all the fingerprint needs (2026-09-01: a mint for an exhausted account
  // was thrown away because the probe treated its 429 as a failure).
  if (!res.ok && !(fp.five_hour_reset != null && fp.seven_day_reset != null)) {
    const body = await res.text().catch(() => "");
    throw new CcAccountError(`Account probe failed: HTTP ${res.status} ${body.slice(0, 160)}`);
  }
  return fp;
}

/** Launch-line prefix that sources the profile's token file, or "" when no
 *  account was requested. A requested account with no stored token is reported
 *  through `warn` and falls back to the keychain login rather than failing the
 *  launch — the session still starts, on the machine's default account. */
export function accountSourcePrefix(name: string | undefined, warn?: (msg: string) => void): string {
  if (!name) return "";
  const info = accountTokenInfo(name);
  if (!info) {
    warn?.(`cc_account "${name}" requested but no setup-token stored (cast accounts token ${name}) — launching on the keychain login`);
    return "";
  }
  if (info.expires_at <= Date.now()) {
    warn?.(`cc_account "${name}" setup-token is past its one-year lifetime — re-mint with: claude setup-token | cast accounts token ${name}`);
  }
  return sourceFilePrefix(info.file);
}

/** Re-snapshot the ACTIVE account into whichever saved profile matches its
 * uuid. Called before every switch-away so the stored copy carries the freshest
 * (rotated) tokens. Best-effort: an active account with no saved profile is
 * simply skipped (nothing to keep fresh). */
export function resnapshotActiveProfile(): string | null {
  const activeUuid = activeAccountSummary()?.uuid;
  if (!activeUuid) return null;
  const index = readProfileIndex();
  const match = Object.entries(index.profiles).find(([, meta]) => meta.uuid === activeUuid);
  if (!match) return null;
  try {
    saveProfile(match[0]);
    return match[0];
  } catch {
    return null;
  }
}

export interface SwitchResult {
  from: string | null; // profile name the outgoing account was re-saved as
  fromEmail?: string;
  to: string;
  toEmail?: string;
}

export function useProfile(name: string): SwitchResult {
  assertValidProfileName(name);
  const raw = readProfileSecret(name);
  if (!raw) {
    throw new CcAccountError(
      `No saved profile "${name}" on this machine — log into that account once and run: cast accounts save ${name}`,
    );
  }
  const target = parseProfile(raw);
  // Activating a logged-out snapshot guarantees "Login expired" everywhere the
  // credential lands (this machine AND any remote it's pushed to) — fail the
  // switch instead, with the fix in hand.
  const targetHealth = credentialHealth(JSON.stringify(target.credentials));
  if (!targetHealth.usable) {
    throw new CcAccountError(
      `Profile "${name}" holds an unusable credential (${targetHealth.reason}) — ` +
        `log into that account once and re-save it: cast accounts save ${name}`,
    );
  }
  const fromEmail = activeAccountSummary()?.email;
  const from = resnapshotActiveProfile();
  writeActiveCredential(JSON.stringify(target.credentials));
  if (target.oauthAccount && Object.keys(target.oauthAccount).length > 0) {
    patchOauthAccount(target.oauthAccount);
  }
  invalidateAccountsCache();
  return { from, fromEmail, to: name, toEmail: target.oauthAccount?.emailAddress };
}

// ---------------------------------------------------------------------------
// Proactive token refresh — keep the machine-global login from lapsing
// ---------------------------------------------------------------------------
//
// A running `claude` self-refreshes its ~8h access token from the stored
// refresh token; nothing does when no session is running, so an idle machine's
// grant eventually expires ("Login expired · run /login"). These helpers let
// the daemon mint a fresh token during idle gaps and keep saved profiles in
// step with the live credential. The refresh token ROTATES on use, so this must
// only ever run on the primary device — a remote refreshing its pushed copy
// would invalidate the laptop's token (the one-way rule the remote push obeys).

// Claude Code's own OAuth client. A refresh must reuse the exact client_id that
// minted the tokens, so these mirror the installed CLI. Env-overridable because
// Anthropic has moved the endpoint before (console.anthropic.com → platform):
// a drift becomes a config change, not a code change.
const CC_OAUTH_CLIENT_ID =
  process.env.CODECAST_CC_OAUTH_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CC_OAUTH_TOKEN_URL =
  process.env.CODECAST_CC_OAUTH_TOKEN_URL || "https://platform.claude.com/v1/oauth/token";

/** The parsed `claudeAiOauth` block of the active credential (null for API-key
 * logins, missing/corrupt credentials). */
export function readActiveOauth(): Record<string, any> | null {
  const raw = readActiveCredential();
  if (!raw) return null;
  try {
    return JSON.parse(raw)?.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

/** Epoch-ms expiry of the active access token, or null if unknown. */
export function activeCredentialExpiresAt(): number | null {
  const exp = readActiveOauth()?.expiresAt;
  return typeof exp === "number" ? exp : null;
}

export interface RefreshResult {
  refreshed: boolean;
  expiresAt?: number;
  reason?: string;
}

/**
 * Mint a fresh access token from the stored refresh token and write the rotated
 * blob back to the active credential store. Defensive by construction: it only
 * overwrites once a complete, valid new blob is in hand, and preserves every
 * field it isn't sure changed (subscription, tier, scopes — and the old refresh
 * token when the server doesn't rotate it). Any failure returns
 * `{refreshed:false, reason}` and leaves the existing credential untouched, so
 * the worst case is "token still lapses, user runs /login" — never a login we
 * broke ourselves. `fetchImpl`/`now` are injectable for tests.
 */
export async function refreshActiveCredential(
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<RefreshResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  const raw = readActiveCredential();
  if (!raw) return { refreshed: false, reason: "no active credential" };
  let cred: any;
  try {
    cred = JSON.parse(raw);
  } catch {
    return { refreshed: false, reason: "active credential is not JSON" };
  }
  const oauth = cred?.claudeAiOauth;
  const refreshToken = oauth?.refreshToken;
  if (!refreshToken) {
    return { refreshed: false, reason: "no refresh token (API-key login?)" };
  }

  let resp: Response;
  try {
    resp = await fetchImpl(CC_OAUTH_TOKEN_URL, {
      method: "POST",
      // Form-encoded: the endpoint may time out on application/json.
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CC_OAUTH_CLIENT_ID,
      }).toString(),
    });
  } catch (err) {
    return { refreshed: false, reason: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { refreshed: false, reason: `token endpoint ${resp.status}: ${text.slice(0, 120)}` };
  }
  let data: any;
  try {
    data = await resp.json();
  } catch {
    return { refreshed: false, reason: "token response is not JSON" };
  }
  const accessToken = data?.access_token;
  const expiresInSec = Number(data?.expires_in);
  if (typeof accessToken !== "string" || !accessToken || !Number.isFinite(expiresInSec)) {
    return { refreshed: false, reason: "token response missing access_token/expires_in" };
  }
  const expiresAt = now + expiresInSec * 1000;
  // Only override the three fields a refresh actually changes; preserve the
  // rest of the blob verbatim (subscriptionType, rateLimitTier, scopes, …).
  const newCred = {
    ...cred,
    claudeAiOauth: {
      ...oauth,
      accessToken,
      refreshToken: typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token
        : refreshToken,
      expiresAt,
    },
  };
  writeActiveCredential(JSON.stringify(newCred));
  invalidateAccountsCache();
  return { refreshed: true, expiresAt };
}

/**
 * Re-snapshot the active login into the saved profile that covers it whenever
 * the live credential is FRESHER than the stored one — i.e. a manual /login or
 * a proactive refresh rotated the tokens. Freshness is compared by the token's
 * own expiry, so this is a cheap no-op when they're already in step. Returns the
 * updated profile name, or null when there's nothing to do (no login, not saved
 * yet — first-time saves are `autoSaveActiveProfile`'s job — or already fresh).
 */
export function resnapshotIfActiveFresher(): string | null {
  const active = activeAccountSummary();
  if (!active?.uuid && !active?.email) return null;
  const activeExpiry = activeCredentialExpiresAt() ?? 0;
  const index = readProfileIndex();
  const match = Object.entries(index.profiles).find(
    ([, meta]) =>
      (active.uuid && meta.uuid === active.uuid) || (active.email && meta.email === active.email),
  );
  if (!match) return null;
  const [name] = match;
  const raw = readProfileSecret(name);
  let storedExpiry = 0;
  if (raw) {
    try {
      const e = parseProfile(raw).credentials?.claudeAiOauth?.expiresAt;
      if (typeof e === "number") storedExpiry = e;
    } catch {
      /* stored blob unreadable — treat as stale, re-save below */
    }
  }
  if (activeExpiry <= storedExpiry) return null;
  try {
    saveProfile(name);
    return name;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Usage snapshots — per-account limit utilization from the OAuth usage API
// ---------------------------------------------------------------------------
//
// Anthropic's usage endpoint is keyed only by the Bearer token, so every saved
// profile's usage is fetchable with the access token already in its keychain
// snapshot. The probe is READ-ONLY — it never refreshes, so it can't rotate a
// dormant grant that may be active on another machine. Dormant tokens live
// ~8h past their last snapshot; after that the profile keeps its last reading
// (staleness is visible via fetched_at, and the windows move slowly anyway).
// ~/.codecast/cc-usage.json caches snapshots — percentages only, non-secret.

const CC_USAGE_URL =
  process.env.CODECAST_CC_USAGE_URL || "https://api.anthropic.com/api/oauth/usage";

export interface CcUsageWindow {
  percent: number;
  resets_at?: number; // epoch ms
  label?: string; // scoped window's model display name (e.g. "Fable")
}

export interface CcUsageSnapshot {
  fetched_at: number;
  session?: CcUsageWindow; // rolling 5h window
  weekly?: CcUsageWindow; // 7d, all models
  weekly_scoped?: CcUsageWindow; // 7d, model-scoped (the /usage screen's third bar)
  extra?: { percent: number; enabled: boolean }; // overflow usage credits
}

/** Normalize the usage API response to the compact snapshot we store/publish.
 * Prefers the `limits[]` array (what the /usage screen renders); falls back to
 * the legacy five_hour/seven_day blocks. Exported for tests. */
export function parseUsageResponse(data: any, now: number): CcUsageSnapshot {
  const snap: CcUsageSnapshot = { fetched_at: now };
  const toMs = (iso: unknown): number | undefined => {
    if (typeof iso !== "string") return undefined;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : undefined;
  };
  for (const lim of Array.isArray(data?.limits) ? data.limits : []) {
    if (typeof lim?.percent !== "number") continue;
    const w: CcUsageWindow = { percent: lim.percent, resets_at: toMs(lim.resets_at) };
    if (lim.kind === "session") snap.session = w;
    else if (lim.kind === "weekly_all") snap.weekly = w;
    else if (lim.kind === "weekly_scoped") {
      const label = lim.scope?.model?.display_name;
      if (typeof label === "string" && label) w.label = label;
      // Several scoped windows may exist; keep the most utilized one.
      if (!snap.weekly_scoped || w.percent > snap.weekly_scoped.percent) snap.weekly_scoped = w;
    }
  }
  if (!snap.session && typeof data?.five_hour?.utilization === "number") {
    snap.session = { percent: data.five_hour.utilization, resets_at: toMs(data.five_hour.resets_at) };
  }
  if (!snap.weekly && typeof data?.seven_day?.utilization === "number") {
    snap.weekly = { percent: data.seven_day.utilization, resets_at: toMs(data.seven_day.resets_at) };
  }
  const extra = data?.extra_usage;
  if (extra && typeof extra.utilization === "number") {
    snap.extra = { percent: extra.utilization, enabled: extra.is_enabled === true };
  }
  return snap;
}

export async function fetchUsageSnapshot(
  accessToken: string,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<CcUsageSnapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resp = await fetchImpl(CC_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "codecast-daemon",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new CcAccountError(`usage endpoint ${resp.status}`);
  }
  return parseUsageResponse(await resp.json(), opts.now ?? Date.now());
}

function usageCachePath(): string {
  return path.join(codecastDir(), "cc-usage.json");
}

interface UsageCache {
  // Keyed by account uuid (email fallback) — the same identity the profile
  // index carries, so a profile covering the active login shares one entry.
  accounts: Record<string, CcUsageSnapshot>;
}

export function readUsageCache(): UsageCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(usageCachePath(), "utf-8"));
    if (parsed && typeof parsed.accounts === "object") return parsed;
  } catch {}
  return { accounts: {} };
}

export interface UsageRefreshSummary {
  probed: string[];
  skipped: string[];
  failed: Array<{ name: string; reason: string }>;
}

/**
 * Refresh usage snapshots for the active login + every saved profile whose
 * access token is still live. Expired dormant tokens are skipped (their last
 * snapshot survives) — we never refresh a dormant grant. Per-account probes
 * are throttled by `minIntervalMs` so callers can invoke this freely.
 */
export async function refreshUsageSnapshots(
  opts: { fetchImpl?: typeof fetch; now?: number; minIntervalMs?: number } = {},
): Promise<UsageRefreshSummary> {
  const now = opts.now ?? Date.now();
  const minInterval = opts.minIntervalMs ?? 4 * 60 * 1000;
  const cache = readUsageCache();
  const summary: UsageRefreshSummary = { probed: [], skipped: [], failed: [] };

  const jobs = new Map<string, { label: string; token: string }>();
  const active = activeAccountSummary();
  const activeKey = active?.uuid || active?.email;
  const activeCred = readActiveCredential();
  if (activeKey && activeCred && credentialHealth(activeCred, now).pushable) {
    try {
      const token = JSON.parse(activeCred)?.claudeAiOauth?.accessToken;
      if (typeof token === "string" && token) jobs.set(activeKey, { label: "active", token });
    } catch {}
  }
  const index = readProfileIndex();
  const knownKeys = new Set<string>();
  for (const [name, meta] of Object.entries(index.profiles)) {
    const key = meta.uuid || meta.email;
    if (!key) continue;
    knownKeys.add(key);
    if (jobs.has(key)) continue; // active covers it with the freshest token
    const raw = readProfileSecret(name);
    if (!raw) continue;
    let profile: CcProfile;
    try {
      profile = parseProfile(raw);
    } catch {
      continue;
    }
    if (!credentialHealth(JSON.stringify(profile.credentials), now).pushable) {
      summary.skipped.push(name); // dormant token expired — keep last snapshot
      continue;
    }
    const token = profile.credentials?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token) jobs.set(key, { label: name, token });
  }
  if (activeKey) knownKeys.add(activeKey);

  for (const [key, job] of jobs) {
    const prev = cache.accounts[key];
    if (prev && now - prev.fetched_at < minInterval) {
      summary.skipped.push(job.label);
      continue;
    }
    try {
      cache.accounts[key] = await fetchUsageSnapshot(job.token, { fetchImpl: opts.fetchImpl, now });
      summary.probed.push(job.label);
    } catch (err) {
      summary.failed.push({ name: job.label, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (summary.probed.length > 0) {
    // Drop entries for deleted profiles so the cache can't grow unbounded.
    for (const key of Object.keys(cache.accounts)) {
      if (!knownKeys.has(key)) delete cache.accounts[key];
    }
    atomicWriteFile(usageCachePath(), JSON.stringify(cache, null, 2), { mode: 0o644 });
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Heartbeat payload (non-secret) — lets the web render the switcher
// ---------------------------------------------------------------------------

export interface AccountsHeartbeatPayload {
  active_email?: string;
  active_uuid?: string;
  profiles: Array<{
    name: string;
    email?: string;
    tier?: string;
    subscription?: string;
    usage?: CcUsageSnapshot;
    // Per-session launch token on file for this profile (never the token).
    token?: { stored_at: number; expires_at: number };
  }>;
}

// Keyed on the mtimes of the files the payload derives from rather than a TTL:
// a `cast accounts save` in another process, a fresh /login, or a usage refresh
// shows up on the very next heartbeat instead of after a blind expiry window.
// The compute result — including a failed/null one — is memoized against the
// same mtimes, so a broken source file isn't re-parsed every call.
export function createMtimeGatedCache<T>(
  paths: () => string[],
  compute: () => T,
): { get(): T; invalidate(): void } {
  let cached: { value: T; mtimes: number[] } | null = null;
  const mtimeOf = (p: string): number => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  return {
    get() {
      const mtimes = paths().map(mtimeOf);
      if (cached && cached.mtimes.every((m, i) => m === mtimes[i])) {
        return cached.value;
      }
      const value = compute();
      cached = { value, mtimes };
      return value;
    },
    invalidate() {
      cached = null;
    },
  };
}

// Recompute is small file reads — never the keychain — so the cache only
// exists to skip parsing ~/.claude.json when nothing changed.
const accountsCache = createMtimeGatedCache<AccountsHeartbeatPayload | null>(
  // The directory itself is on the list so a token file appearing or vanishing
  // (a rename into ~/.codecast) invalidates the payload like an index write.
  () => [indexPath(), claudeJsonPath(), usageCachePath(), codecastDir()],
  () => {
    let value: AccountsHeartbeatPayload | null = null;
    try {
      const active = activeAccountSummary();
      const usage = readUsageCache().accounts;
      const profiles = listProfiles().map(({ name, email, uuid, tier, subscription }) => {
        const tok = accountTokenInfo(name);
        return {
          name,
          email,
          tier,
          subscription,
          usage: usage[uuid || email || ""] ?? undefined,
          ...(tok ? { token: { stored_at: tok.stored_at, expires_at: tok.expires_at } } : {}),
        };
      });
      if (active?.email || profiles.length > 0) {
        value = { active_email: active?.email, active_uuid: active?.uuid, profiles };
      }
    } catch {
      value = null;
    }
    return value;
  },
);

export function invalidateAccountsCache(): void {
  accountsCache.invalidate();
}

export function getAccountsHeartbeatPayload(): AccountsHeartbeatPayload | null {
  return accountsCache.get();
}

// ---------------------------------------------------------------------------
// Auto-save: every login becomes a profile without the user asking
// ---------------------------------------------------------------------------

/** Derive a profile name from an email: the local part before the @
 * (claude2@almostcandid.com → claude2). If that's taken, fall back to the
 * domain's org part (ashot@gmail.com → gmail beats ashot-2), then to -2/-3
 * suffixes. Mirrors the web Settings suggestion so auto-saved and hand-saved
 * profiles end up named the same way. */
export function deriveProfileName(email: string | undefined, taken: string[]): string {
  const clean = (part: string | undefined) => part?.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  const [localRaw, domainRaw] = email?.includes("@") ? email.split("@") : [];
  const candidates = [clean(localRaw), clean(domainRaw?.split(".")[0])].filter(
    (c): c is string => !!c && VALID_PROFILE_NAME.test(c),
  );
  const takenSet = new Set(taken.map((t) => t.toLowerCase()));
  for (const c of candidates) if (!takenSet.has(c)) return c;
  const base = candidates[0] ?? "account";
  if (!takenSet.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!takenSet.has(`${base}-${i}`)) return `${base}-${i}`;
  }
}

/** True when a profile name still looks auto-derived under the old rule (the
 * email domain's org part, optionally -N deduped: claude2@almostcandid.com →
 * almostcandid / almostcandid-2). Hand-picked names don't match. */
export function isLegacyDerivedName(name: string, email: string | undefined): boolean {
  if (!email?.includes("@")) return false;
  const org = email.split("@")[1]?.split(".")[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return (
    !!org &&
    (name === org || (name.startsWith(`${org}-`) && /^\d+$/.test(name.slice(org.length + 1))))
  );
}

/** Rename profiles whose name still carries the old auto-derived form to the
 * current derivation (the email's local part: claude2). Moves the secret
 * snapshot along with the index row; returns the renames performed. */
export function migrateLegacyProfileNames(): Array<{ from: string; to: string }> {
  const index = readProfileIndex();
  const renames: Array<{ from: string; to: string }> = [];
  for (const [name, meta] of Object.entries(index.profiles)) {
    if (!isLegacyDerivedName(name, meta.email)) continue;
    const desired = deriveProfileName(
      meta.email,
      Object.keys(index.profiles).filter((n) => n !== name),
    );
    if (desired === name) continue;
    const raw = readProfileSecret(name);
    if (raw === null) continue; // index-only row — nothing safe to move
    writeProfileSecret(desired, raw);
    deleteProfileSecret(name);
    index.profiles[desired] = meta;
    delete index.profiles[name];
    renames.push({ from: name, to: desired });
  }
  if (renames.length) {
    writeProfileIndex(index);
    invalidateAccountsCache();
  }
  return renames;
}

/** Snapshot the active login as a profile iff no saved profile already covers
 * it (matched by account uuid, falling back to email). Returns the saved meta,
 * or null when there's nothing to do (no login, or already saved). The daemon
 * calls this each heartbeat so a fresh /login enrolls itself — the OAuth
 * browser dance stays the only manual step, ever. */
export function autoSaveActiveProfile(): CcProfileMeta | null {
  const active = activeAccountSummary();
  if (!active?.uuid && !active?.email) return null;
  const index = readProfileIndex();
  const covered = Object.values(index.profiles).some(
    (meta) =>
      (active.uuid && meta.uuid === active.uuid) ||
      (active.email && meta.email === active.email),
  );
  if (covered) return null;
  return saveProfile(deriveProfileName(active.email, Object.keys(index.profiles)));
}
