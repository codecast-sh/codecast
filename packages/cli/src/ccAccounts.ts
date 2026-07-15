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

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readLocalCredential } from "./remote/session-move.js";

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

function atomicWriteFile(filePath: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, filePath);
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
    atomicWriteFile(path.join(homeDir(), ".claude", ".credentials.json"), credentialJson);
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

/** Patch ONLY the oauthAccount key in ~/.claude.json (atomic; the file also
 * holds per-project history that concurrent claude processes rewrite). */
export function patchOauthAccount(oauthAccount: Record<string, any>): void {
  const p = claudeJsonPath();
  let cfg: any = {};
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {}
  cfg.oauthAccount = oauthAccount;
  atomicWriteFile(p, JSON.stringify(cfg, null, 2), 0o644);
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

function writeProfileSecret(name: string, content: string): void {
  if (useFileStore()) {
    atomicWriteFile(path.join(profileFileDir(), `${name}.json`), content);
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
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), "utf-8"));
    if (parsed && typeof parsed.profiles === "object") return parsed;
  } catch {}
  return { profiles: {} };
}

function writeProfileIndex(index: ProfileIndex): void {
  atomicWriteFile(indexPath(), JSON.stringify(index, null, 2), 0o644);
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
// Heartbeat payload (non-secret) — lets the web render the switcher
// ---------------------------------------------------------------------------

export interface AccountsHeartbeatPayload {
  active_email?: string;
  active_uuid?: string;
  profiles: Array<{ name: string; email?: string; tier?: string; subscription?: string }>;
}

// Keyed on the mtimes of the two files the payload derives from (the profile
// index and ~/.claude.json's oauthAccount) rather than a TTL: a `cast accounts
// save` in another process or a fresh /login shows up on the very next
// heartbeat instead of after a blind expiry window. Recompute is two small
// file reads — never the keychain — so the cache only exists to skip parsing
// ~/.claude.json when nothing changed.
let accountsCache: { value: AccountsHeartbeatPayload | null; indexMtime: number; claudeMtime: number } | null = null;

function mtimeOf(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

export function invalidateAccountsCache(): void {
  accountsCache = null;
}

export function getAccountsHeartbeatPayload(): AccountsHeartbeatPayload | null {
  const indexMtime = mtimeOf(indexPath());
  const claudeMtime = mtimeOf(claudeJsonPath());
  if (accountsCache && accountsCache.indexMtime === indexMtime && accountsCache.claudeMtime === claudeMtime) {
    return accountsCache.value;
  }
  let value: AccountsHeartbeatPayload | null = null;
  try {
    const active = activeAccountSummary();
    const profiles = listProfiles().map(({ name, email, tier, subscription }) => ({
      name,
      email,
      tier,
      subscription,
    }));
    if (active?.email || profiles.length > 0) {
      value = { active_email: active?.email, active_uuid: active?.uuid, profiles };
    }
  } catch {
    value = null;
  }
  accountsCache = { value, indexMtime, claudeMtime };
  return value;
}

// ---------------------------------------------------------------------------
// Auto-save: every login becomes a profile without the user asking
// ---------------------------------------------------------------------------

/** Derive a profile name from an email: the org part of the domain
 * (ashot@footage.com → footage), deduped with -2/-3 against taken names.
 * Mirrors the web Settings suggestion so auto-saved and hand-saved profiles
 * end up named the same way. */
export function deriveProfileName(email: string | undefined, taken: string[]): string {
  const org = email?.split("@")[1]?.split(".")[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  const base = org && VALID_PROFILE_NAME.test(org) ? org : "account";
  const takenSet = new Set(taken.map((t) => t.toLowerCase()));
  if (!takenSet.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!takenSet.has(`${base}-${i}`)) return `${base}-${i}`;
  }
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
