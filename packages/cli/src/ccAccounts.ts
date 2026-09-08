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

import { execFileSync, keychainReadAsync } from "./proc.js";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readLocalCredential, readLocalCredentialAsync } from "./remote/session-move.js";
import { readProfileIndexFile } from "./readForUpdate.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { renderProviderEnvFile, sourceFilePrefix } from "./providerKeyLaunch.js";
import { defaultConfigDir } from "./config/configDir.js";

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
  // The token endpoint refused this profile's refresh token (invalid_grant):
  // the saved login is dead until the account signs in again. Set by the
  // daemon's usage refresh, cleared by any re-save of the profile (a fresh
  // /login re-snapshots it). Readers treat it as "not a switch target".
  login_expired_at?: number;
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

function profileFileDir(): string {
  return path.join(defaultConfigDir(), "cc-accounts");
}

function indexPath(): string {
  return path.join(defaultConfigDir(), "cc-accounts.json");
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
    const f = activeCredentialFile();
    if (!fs.existsSync(f)) return null;
    return fs.readFileSync(f, "utf-8");
  }
  return readLocalCredential();
}

/** The same read for the daemon's timers, with the keychain call off the loop. */
export async function readActiveCredentialAsync(): Promise<string | null> {
  if (useFileStore()) return fs.promises.readFile(activeCredentialFile(), "utf-8").catch(() => null);
  return readLocalCredentialAsync();
}

/** Where CC keeps the active login when the store is a file (Linux, sandboxed tests). */
function activeCredentialFile(): string {
  return path.join(homeDir(), ".claude", ".credentials.json");
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
    atomicWriteFile(activeCredentialFile(), credentialJson, {
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
    const f = profileSecretFile(name);
    if (!fs.existsSync(f)) return null;
    return fs.readFileSync(f, "utf-8");
  }
  try {
    return execFileSync("security", profileSecretArgs(name), { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

/** The same read for the daemon's timers, with the keychain call off the loop. */
async function readProfileSecretAsync(name: string): Promise<string | null> {
  if (useFileStore()) return fs.promises.readFile(profileSecretFile(name), "utf-8").catch(() => null);
  return keychainReadAsync(profileSecretArgs(name)).catch(() => null);
}

function profileSecretArgs(name: string): string[] {
  return ["find-generic-password", "-s", `${PROFILE_KEYCHAIN_PREFIX}${name}`, "-w"];
}
function profileSecretFile(name: string): string {
  return path.join(profileFileDir(), `${name}.json`);
}

function deleteProfileSecret(name: string): void {
  if (useFileStore()) {
    fs.rmSync(profileSecretFile(name), { force: true });
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
    atomicWriteFile(profileSecretFile(name), content, { mode: 0o600 });
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
// Verified identity: which account a credential ACTUALLY belongs to
// ---------------------------------------------------------------------------
//
// ~/.claude.json's oauthAccount is a LABEL, written by a different program at a
// different moment than the credential it describes. The two drift: a switch
// writes the keychain and the label in two steps, and CC rewrites the label
// only when it fetches a profile. A stale label is not cosmetic — every
// destructive write in this module keys off it. `resnapshotActiveProfile` picks
// which profile to overwrite from the label, so ONE desync copies the live
// token into the wrong profile, and each later switch spreads it further.
// (2026-09-02: claude2, claude3 and fresh all held one token, three labels.)
//
// The token can prove its own identity: /api/oauth/profile answers with the
// account uuid for any credential carrying the user:profile scope, which every
// CC OAuth login has. So identity is resolved FROM THE CREDENTIAL and cached
// here, keyed by a hash of the access token. Callers stay synchronous; the
// daemon refreshes the cache on the same timer as usage.

const CC_PROFILE_URL =
  process.env.CODECAST_CC_PROFILE_URL || "https://api.anthropic.com/api/oauth/profile";

export interface VerifiedIdentity {
  uuid?: string;
  email?: string;
  verified_at: number;
}

interface IdentityCache {
  // Keyed by tokenKey() — a hash, never token material.
  tokens: Record<string, VerifiedIdentity>;
}

function identityCachePath(): string {
  return path.join(defaultConfigDir(), "cc-identity.json");
}

/** Stable per-token key. A hash so the cache file holds no token material. */
export function tokenKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

function readIdentityCache(): IdentityCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(identityCachePath(), "utf-8"));
    if (parsed && typeof parsed.tokens === "object") return parsed;
  } catch {}
  return { tokens: {} };
}

function writeIdentityCache(cache: IdentityCache): void {
  atomicWriteFile(identityCachePath(), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/** Ask the account server whose credential this is. Throws on a dead token. */
export async function fetchAccountIdentity(
  accessToken: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ uuid?: string; email?: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resp = await fetchImpl(CC_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "codecast-daemon",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new CcAccountError(`profile endpoint ${resp.status}`);
  const data: any = await resp.json();
  const acct = data?.account ?? {};
  const uuid = typeof acct.uuid === "string" ? acct.uuid : undefined;
  // The endpoint answers with `email`; CC's own oauthAccount block spells the
  // same field `emailAddress`, so accept either rather than depend on one.
  const rawEmail = acct.email ?? acct.email_address;
  const email = typeof rawEmail === "string" ? rawEmail : undefined;
  if (!uuid && !email) throw new CcAccountError("profile response carried no account identity");
  return { uuid, email };
}

/** The cached verdict for a token, or null when it was never verified. */
export function verifiedIdentityFor(accessToken: string | undefined): VerifiedIdentity | null {
  if (!accessToken) return null;
  return readIdentityCache().tokens[tokenKey(accessToken)] ?? null;
}

/** Verify one token and cache the answer. Returns null when the probe fails
 *  (an expired or revoked token proves nothing about its account). */
export async function verifyIdentity(
  accessToken: string,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<VerifiedIdentity | null> {
  try {
    const { uuid, email } = await fetchAccountIdentity(accessToken, opts);
    const entry: VerifiedIdentity = { uuid, email, verified_at: opts.now ?? Date.now() };
    const cache = readIdentityCache();
    cache.tokens[tokenKey(accessToken)] = entry;
    writeIdentityCache(cache);
    invalidateAccountsCache();
    return entry;
  } catch {
    return null;
  }
}

/** Verify the machine's current login. The daemon calls this on its usage
 *  timer, so the synchronous readers below almost always find a fresh answer. */
export async function verifyActiveIdentity(
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<VerifiedIdentity | null> {
  const token = oauthOf(await readActiveCredentialAsync())?.accessToken;
  if (typeof token !== "string" || !token) return null;
  const known = verifiedIdentityFor(token);
  if (known) return known;
  return verifyIdentity(token, opts);
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/** Who the machine is logged in as. The credential's own verdict wins over
 *  ~/.claude.json, which is only a label and can name a different account. */
export function activeAccountSummary(): { email?: string; uuid?: string } | null {
  const verified = verifiedIdentityFor(readActiveOauth()?.accessToken);
  if (verified) return { email: verified.email, uuid: verified.uuid };
  const acct = readOauthAccount();
  if (!acct?.accountUuid && !acct?.emailAddress) return null;
  return { email: acct.emailAddress, uuid: acct.accountUuid };
}

/** The same answer, plus whether the credential itself proved it. Destructive
 *  writes need to know: an unverified identity may be naming another account. */
export function activeAccountIdentity(): { email?: string; uuid?: string; verified: boolean } | null {
  const verified = verifiedIdentityFor(readActiveOauth()?.accessToken);
  if (verified) return { email: verified.email, uuid: verified.uuid, verified: true };
  const acct = readOauthAccount();
  if (!acct?.accountUuid && !acct?.emailAddress) return null;
  return { email: acct.emailAddress, uuid: acct.accountUuid, verified: false };
}

/** One access token cannot belong to two accounts. When the credential we are
 *  about to snapshot is already stored under a DIFFERENT profile, the label is
 *  provably wrong — refuse rather than stamp a second name on one token. This
 *  is the offline half of the identity rule: it needs no network and it stops
 *  the spread at the first duplicate instead of the fifth.
 *
 *  The refresh token counts as the same proof, and it catches a case the access
 *  token cannot. Refresh tokens are single use: once two profiles hold one, the
 *  first rotation strands the other copy, and a live claude that rotated the
 *  active credential has already made its access token differ from every stored
 *  one while the refresh half still names the duplicate (ct-49526). */
function assertNotAnotherProfilesCredential(name: string, credentialJson: string): void {
  const oauth = oauthOf(credentialJson);
  const token = typeof oauth?.accessToken === "string" && oauth.accessToken ? oauth.accessToken : null;
  const refresh = typeof oauth?.refreshToken === "string" && oauth.refreshToken ? oauth.refreshToken : null;
  if (!token && !refresh) return;
  for (const other of Object.keys(readProfileIndex().profiles)) {
    if (other === name) continue;
    let stored: string | null;
    try {
      stored = readProfileSecret(other);
    } catch {
      continue;
    }
    if (!stored) continue;
    let otherOauth: any;
    try {
      otherOauth = JSON.parse(stored)?.credentials?.claudeAiOauth;
    } catch {
      continue;
    }
    const shared = token && otherOauth?.accessToken === token
      ? "access token"
      : refresh && otherOauth?.refreshToken === refresh
        ? "refresh token"
        : null;
    if (!shared) continue;
    throw new CcAccountError(
      `Refusing to save "${name}": this machine's credential shares its ${shared} with the login already stored ` +
        `as "${other}", so the login is "${other}", not "${name}". Log into ${name}'s account (claude /login) and ` +
        `save again — run \`cast accounts verify\` to see what each profile really holds.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Identity matched read back
// ---------------------------------------------------------------------------
// When a live claude holds the active credential the daemon does not refresh it
// (ccLiveGate.ts) — the CLI does, and we read the result back. Writing a
// credential we did not mint into a profile is the write that poisoned the
// store on 2026-09-02, when one login ended up saved under three names. So the
// read back names its profile from the credential itself and refuses anything
// less than a single unambiguous answer.

/** What a credential proves about whose it is. Any of these alone can name a
 *  profile; any of them disagreeing rules one out. */
export interface CredentialIdentity {
  uuid?: string;
  email?: string;
  organization?: string;
  refreshToken?: string;
}

export type CredentialProfileMatch =
  | { kind: "matched"; name: string }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "none" };

/** Identity fields are compared case-insensitively: an email that differs only
 *  in case is the same account. */
function normalizeField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

/** A token is compared verbatim — case carries meaning in a secret, and folding
 *  it could call two different grants the same one. */
function tokenField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The identity an oauthAccount block carries, however it spells it. */
function identityOfOauthAccount(acct: Record<string, any> | null | undefined): CredentialIdentity {
  return {
    uuid: normalizeField(acct?.accountUuid ?? acct?.account_uuid ?? acct?.uuid),
    email: normalizeField(acct?.emailAddress ?? acct?.email ?? acct?.email_address),
    // The uuid when the blob carries one, else the name: both are stable per
    // organization, and only ever compared against another profile's copy.
    organization: normalizeField(acct?.organizationUuid ?? acct?.organization_uuid ?? acct?.organizationName),
  };
}

/** "token" when they hold the same refresh token, "match" when a field they
 *  share agrees, "mismatch" when one disagrees, "unverifiable" when they have
 *  no field in common.
 *
 *  A disagreement wins over an agreement: two accounts in one organization
 *  share that field and differ on email, and the email is what tells them
 *  apart. */
function compareIdentities(
  a: CredentialIdentity,
  b: CredentialIdentity,
): "token" | "match" | "mismatch" | "unverifiable" {
  let agreed = false;
  for (const field of ["uuid", "email", "organization"] as const) {
    const left = a[field];
    const right = b[field];
    if (!left || !right) continue;
    if (left !== right) return "mismatch";
    agreed = true;
  }
  if (a.refreshToken && b.refreshToken && a.refreshToken === b.refreshToken) return "token";
  return agreed ? "match" : "unverifiable";
}

/**
 * Which saved profile a credential belongs to, or why we cannot say.
 *
 * `matched` needs exactly one profile the credential agrees with AND no profile
 * we could not judge at all: an unreadable secret on a profile with no recorded
 * identity might BE this account, and writing elsewhere on that guess is how a
 * token lands under the wrong name. Ambiguity is a refusal, never a coin flip.
 *
 * Every read is async: the daemon calls this on its maintenance tick, where a
 * synchronous keychain call has answered in seconds under load.
 */
export async function matchProfileForCredential(
  raw: CredentialIdentity,
): Promise<CredentialProfileMatch> {
  // Normalized here as well as at the call sites: an email that differs only in
  // case is the same account, and a caller that forgot would silently answer
  // "none" and leave the profile carrying a spent token.
  const identity: CredentialIdentity = {
    uuid: normalizeField(raw.uuid),
    email: normalizeField(raw.email),
    organization: normalizeField(raw.organization),
    refreshToken: tokenField(raw.refreshToken),
  };
  const matched: string[] = [];
  const byToken: string[] = [];
  let unverifiable = 0;
  for (const [name, meta] of Object.entries(readProfileIndex().profiles)) {
    const stored = await readProfileSecretAsync(name).catch(() => null);
    let storedIdentity: CredentialIdentity = {};
    if (stored) {
      try {
        const profile = parseProfile(stored);
        storedIdentity = {
          ...identityOfOauthAccount(profile.oauthAccount),
          refreshToken: tokenField(profile.credentials?.claudeAiOauth?.refreshToken),
        };
      } catch {
        /* unreadable blob — the index's own labels are all we have */
      }
    }
    // The index records what we were told at save time and survives a keychain
    // that will not answer, so it fills whatever the stored blob left blank.
    const candidate: CredentialIdentity = {
      uuid: storedIdentity.uuid ?? normalizeField(meta.uuid),
      email: storedIdentity.email ?? normalizeField(meta.email),
      organization: storedIdentity.organization,
      refreshToken: storedIdentity.refreshToken,
    };
    const verdict = compareIdentities(identity, candidate);
    if (verdict === "token") {
      byToken.push(name);
      matched.push(name);
    } else if (verdict === "match") {
      matched.push(name);
    } else if (verdict === "unverifiable") {
      unverifiable++;
    }
  }
  // Refresh token equality is proof rather than evidence: one refresh token
  // belongs to exactly one grant, so a profile we could not judge does not
  // weaken it. Two profiles holding it is the fault this cannot resolve — the
  // credential is duplicated, and assertNotAnotherProfilesCredential refuses
  // the write that would spread it further.
  if (byToken.length === 1) return { kind: "matched", name: byToken[0] };
  if (byToken.length > 1) return { kind: "ambiguous", names: byToken };
  if (matched.length === 1 && unverifiable === 0) return { kind: "matched", name: matched[0] };
  if (matched.length === 0 && unverifiable === 0) return { kind: "none" };
  return { kind: "ambiguous", names: matched };
}

/** The identity block to store beside the credential. When the credential has
 *  proved whose it is, that verdict wins over ~/.claude.json's label, which may
 *  still name the account we switched away from. */
function activeOauthAccountForSave(): Record<string, any> | null {
  const label = readOauthAccount();
  const verified = verifiedIdentityFor(readActiveOauth()?.accessToken);
  if (!verified?.uuid) return label;
  if (label?.accountUuid === verified.uuid) return label;
  // The label describes a different account: keep only what the credential
  // itself proved, so nothing downstream reads the stale org/email.
  return { accountUuid: verified.uuid, emailAddress: verified.email };
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
  assertNotAnotherProfilesCredential(name, cred);
  const profile = buildProfile(cred, activeOauthAccountForSave(), Date.now());
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
  return path.join(defaultConfigDir(), `cc-account-${name}.env`);
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

/** The identity block for a profile that saved none, rebuilt from the index.
 *  Empty when even the index has nothing — an unknown login, which readers
 *  handle, unlike a confident wrong answer. */
function identityBlockFor(
  meta: Omit<CcProfileMeta, "name" | "active"> | undefined,
): Record<string, any> {
  if (!meta?.uuid && !meta?.email) return {};
  return { accountUuid: meta.uuid, emailAddress: meta.email };
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
  // The label MUST move with the credential. Leaving the outgoing account's
  // identity in ~/.claude.json when the target carries none was the whole bug:
  // the machine then runs account B while every reader is told A, and the next
  // switch-away re-saves B's live token under A's profile. No label is honest
  // ("unknown", and the credential can still prove itself); a stale one is not.
  const targetIdentity =
    target.oauthAccount && Object.keys(target.oauthAccount).length > 0
      ? target.oauthAccount
      : identityBlockFor(readProfileIndex().profiles[name]);
  patchOauthAccount(targetIdentity);
  // Stamp the activation here, not at the next usage tick: the daemon's
  // switch_account probes right after this, and `cast accounts use` from a
  // terminal must not let a pre-switch snapshot pass as evidence meanwhile.
  noteActiveAccount(targetIdentity?.accountUuid || targetIdentity?.emailAddress);
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
  return oauthOf(readActiveCredential());
}

export async function readActiveOauthAsync(): Promise<Record<string, any> | null> {
  return oauthOf(await readActiveCredentialAsync());
}

function oauthOf(raw: string | null): Record<string, any> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw)?.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

/** Epoch-ms expiry of the active access token, or null if unknown. Async
 * because every caller is a daemon timer or a login flow, and the read behind
 * it is a keychain call. */
export async function activeCredentialExpiresAt(): Promise<number | null> {
  const exp = (await readActiveOauthAsync())?.expiresAt;
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
  const raw = await readActiveCredentialAsync();
  if (!raw) return { refreshed: false, reason: "no active credential" };
  let cred: any;
  try {
    cred = JSON.parse(raw);
  } catch {
    return { refreshed: false, reason: "active credential is not JSON" };
  }
  const rotated = await rotateOauthCredential(cred, opts);
  if (!rotated.ok) return { refreshed: false, reason: rotated.reason };
  writeActiveCredential(JSON.stringify(rotated.cred));
  invalidateAccountsCache();
  return { refreshed: true, expiresAt: rotated.expiresAt };
}

/**
 * The token-endpoint round trip behind every refresh: trade the blob's refresh
 * token for a new access token and return the rotated blob, or the reason it
 * could not be rotated. `dead` marks a DEFINITIVE refusal (the endpoint
 * answered 400/401: invalid_grant, revoked, already rotated elsewhere) as
 * opposed to a transient failure (network, 5xx) worth retrying. Never writes.
 */
export async function rotateOauthCredential(
  cred: any,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<{ ok: true; cred: any; expiresAt: number } | { ok: false; reason: string; dead: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  const oauth = cred?.claudeAiOauth;
  const refreshToken = oauth?.refreshToken;
  if (!refreshToken) {
    return { ok: false, reason: "no refresh token (API-key login?)", dead: false };
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
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, reason: `request failed: ${err instanceof Error ? err.message : String(err)}`, dead: false };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      reason: `token endpoint ${resp.status}: ${text.slice(0, 120)}`,
      dead: resp.status === 400 || resp.status === 401,
    };
  }
  let data: any;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, reason: "token response is not JSON", dead: false };
  }
  const accessToken = data?.access_token;
  const expiresInSec = Number(data?.expires_in);
  if (typeof accessToken !== "string" || !accessToken || !Number.isFinite(expiresInSec)) {
    return { ok: false, reason: "token response missing access_token/expires_in", dead: false };
  }
  const expiresAt = now + expiresInSec * 1000;
  // Only override the three fields a refresh actually changes; preserve the
  // rest of the blob verbatim (subscriptionType, rateLimitTier, scopes, …).
  return {
    ok: true,
    expiresAt,
    cred: {
      ...cred,
      claudeAiOauth: {
        ...oauth,
        accessToken,
        refreshToken: typeof data.refresh_token === "string" && data.refresh_token
          ? data.refresh_token
          : refreshToken,
        expiresAt,
      },
    },
  };
}

/** Stamp a profile dead in the index (see CcProfileMeta.login_expired_at). */
function markLoginExpired(name: string, now: number): void {
  const index = readProfileIndex();
  if (!index.profiles[name] || index.profiles[name].login_expired_at) return;
  index.profiles[name] = { ...index.profiles[name], login_expired_at: now };
  writeProfileIndex(index);
  invalidateAccountsCache();
}

/**
 * Rotate a DORMANT profile's tokens in place, so its usage stays readable
 * past the ~8h access-token life. The profile is this machine's only holder
 * of that grant (the active login is snapshotted into its profile on every
 * switch away, and remotes are pushed the active login only), so rotating it
 * here keeps the lineage whole: the new pair is written back into the same
 * profile and the next switch to it lands on a live login. A definitive
 * refusal marks the profile `login_expired_at` in the index, which every
 * reader takes as "dead until re-saved" — no retries against a revoked grant,
 * no auto-switch onto it. Same defensive write discipline as the active
 * refresh: nothing is overwritten until a complete new blob is in hand.
 */
export async function refreshProfileCredential(
  name: string,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<RefreshResult & { dead?: boolean; accessToken?: string }> {
  const now = opts.now ?? Date.now();
  const raw = await readProfileSecretAsync(name);
  if (!raw) return { refreshed: false, reason: "no saved credential" };
  let profile: CcProfile;
  try {
    profile = parseProfile(raw);
  } catch (err) {
    return { refreshed: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const rotated = await rotateOauthCredential(profile.credentials, { ...opts, now });
  if (!rotated.ok) {
    if (rotated.dead) markLoginExpired(name, now);
    return { refreshed: false, reason: rotated.reason, dead: rotated.dead };
  }
  writeProfileSecret(name, JSON.stringify({ ...profile, credentials: rotated.cred }));
  const index = readProfileIndex();
  if (index.profiles[name]?.login_expired_at) {
    const { login_expired_at: _cleared, ...rest } = index.profiles[name];
    index.profiles[name] = rest;
    writeProfileIndex(index);
    invalidateAccountsCache();
  }
  return { refreshed: true, expiresAt: rotated.expiresAt, accessToken: rotated.cred.claudeAiOauth.accessToken };
}

/**
 * Re-snapshot the active login into the saved profile that covers it whenever
 * the live credential is FRESHER than the stored one. Three things make it
 * fresher: a manual /login, the daemon's own proactive refresh, and — the case
 * the live process gate creates — a running claude that rotated the credential
 * while the daemon stood back. That last one is the read back, so this is also
 * the path a credential we did not mint takes into a profile.
 *
 * Which profile is answered by `matchProfileForCredential`, from the credential
 * itself: exactly one profile it agrees with by account uuid, email,
 * organization or refresh token equality. An ambiguous answer is refused and
 * logged rather than resolved by picking the first, because picking the first
 * is how one login ended up saved under three names.
 *
 * Fresher means a later expiry, or a rotated refresh token that is not older.
 * A rotation alone is enough: a live claude's refresh replaces the pair, and
 * the stored copy's refresh token is spent from that moment — a profile still
 * holding it is a login that will fail the next time we touch it.
 *
 * Returns the updated profile name, or null when there is nothing to do (no
 * login, not saved yet — first-time saves are `autoSaveActiveProfile`'s job —
 * already in step, or an identity we refused to guess at).
 */
export async function resnapshotIfActiveFresher(
  opts: { warn?: (msg: string) => void } = {},
): Promise<string | null> {
  const raw = await readActiveCredentialAsync();
  const activeOauth = oauthOf(raw);
  if (!activeOauth) return null;
  const label = identityOfOauthAccount(readOauthAccount());
  const active = activeAccountIdentity();
  // ~/.claude.json is a label written by another program at another moment. When
  // the credential itself has proved a DIFFERENT account, the label describes
  // the one we switched away from — and its organization is stale too. Carrying
  // that organization would rule out the very profile the uuid names, which is
  // the 2026-09-02 poisoning shape read from the other end.
  const labelDescribesUs = !active?.verified || !active.uuid || label.uuid === normalizeField(active.uuid);
  const identity: CredentialIdentity = {
    uuid: normalizeField(active?.uuid) ?? label.uuid,
    email: normalizeField(active?.email) ?? label.email,
    ...(labelDescribesUs ? { organization: label.organization } : {}),
    refreshToken: tokenField(activeOauth.refreshToken),
  };
  if (!identity.uuid && !identity.email && !identity.organization && !identity.refreshToken) return null;

  const match = await matchProfileForCredential(identity);
  if (match.kind === "ambiguous") {
    opts.warn?.(
      `refusing to write the active login into a profile: ${
        match.names.length
          ? `it matches ${match.names.length} profiles (${match.names.join(", ")})`
          : "a saved profile carries no identity we can rule out"
      } — run \`cast accounts verify\` to see what each profile really holds`,
    );
    return null;
  }
  if (match.kind !== "matched") return null;
  const name = match.name;

  const activeExpiry = typeof activeOauth.expiresAt === "number" ? activeOauth.expiresAt : 0;
  const stored = await readProfileSecretAsync(name);
  let storedExpiry = 0;
  let storedRefresh: string | undefined;
  if (stored) {
    try {
      const oauth = parseProfile(stored).credentials?.claudeAiOauth;
      if (typeof oauth?.expiresAt === "number") storedExpiry = oauth.expiresAt;
      storedRefresh = tokenField(oauth?.refreshToken);
    } catch {
      /* stored blob unreadable — treat as stale, re-save below */
    }
  }
  const refreshTokenRotated =
    !!identity.refreshToken && !!storedRefresh && identity.refreshToken !== storedRefresh;
  const fresher = activeExpiry > storedExpiry;
  const rotatedAndNotOlder = refreshTokenRotated && activeExpiry >= storedExpiry;
  if (!fresher && !rotatedAndNotOlder) return null;
  try {
    saveProfile(name);
    return name;
  } catch (err) {
    // assertNotAnotherProfilesCredential refuses a credential a second profile
    // already holds. That refusal is the point — say so rather than swallow it.
    opts.warn?.(`re-snapshot of profile "${name}" refused: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audit: what does each profile REALLY hold?
// ---------------------------------------------------------------------------

export interface ProfileAudit {
  name: string;
  labelled_email?: string;
  labelled_uuid?: string;
  actual_email?: string;
  actual_uuid?: string;
  /** ok = the credential is the account the profile claims.
   *  mislabeled = it belongs to a different account (provable, from the token).
   *  duplicate = mislabeled AND another profile already covers that account.
   *  unverifiable = the token could not answer (expired, revoked, offline). */
  verdict: "ok" | "mislabeled" | "duplicate" | "unverifiable";
  reason?: string;
  /** Set by repairProfileIdentities: what it did about a bad verdict. */
  repair?: "dropped-credential" | "relabelled";
}

/** Probe every saved profile's stored credential and say whose it actually is.
 *  Answers the only question the index cannot: the index records what we were
 *  TOLD at save time, the token records the truth. */
export async function auditProfileIdentities(
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ProfileAudit[]> {
  const index = readProfileIndex();
  const results: ProfileAudit[] = [];
  for (const [name, meta] of Object.entries(index.profiles)) {
    const row: ProfileAudit = {
      name,
      labelled_email: meta.email,
      labelled_uuid: meta.uuid,
      verdict: "unverifiable",
    };
    const raw = await readProfileSecretAsync(name);
    const token = safeParse(raw ?? "")?.credentials?.claudeAiOauth?.accessToken;
    if (typeof token !== "string" || !token) {
      row.reason = raw ? "no access token in the stored snapshot" : "no stored credential";
      results.push(row);
      continue;
    }
    try {
      const actual = await fetchAccountIdentity(token, opts);
      row.actual_email = actual.email;
      row.actual_uuid = actual.uuid;
      row.verdict = !meta.uuid || meta.uuid === actual.uuid ? "ok" : "mislabeled";
    } catch (err) {
      row.reason = err instanceof Error ? err.message : String(err);
    }
    results.push(row);
  }
  // A mislabel whose real account another profile already covers is a pure
  // duplicate: one token wearing two names, the shape that spreads.
  for (const row of results) {
    if (row.verdict !== "mislabeled") continue;
    const covered = results.some(
      (r) => r !== row && r.verdict === "ok" && r.actual_uuid && r.actual_uuid === row.actual_uuid,
    );
    if (covered) row.verdict = "duplicate";
  }
  return results;
}

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Repair what the audit found. A duplicate loses its credential (the account
 *  is already covered under its right name, and the profile drops back to
 *  "needs /login"); a mislabel nobody else covers is relabelled to the account
 *  it actually holds, so a working token is never thrown away. */
export async function repairProfileIdentities(
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ProfileAudit[]> {
  const audit = await auditProfileIdentities(opts);
  const index = readProfileIndex();
  let dirty = false;
  for (const row of audit) {
    if (row.verdict === "duplicate") {
      deleteProfileSecret(row.name);
      removeAccountToken(row.name);
      row.repair = "dropped-credential";
      dirty = true;
    } else if (row.verdict === "mislabeled") {
      const raw = await readProfileSecretAsync(row.name);
      const parsed = raw ? safeParse(raw) : null;
      if (parsed) {
        parsed.oauthAccount = { accountUuid: row.actual_uuid, emailAddress: row.actual_email };
        writeProfileSecret(row.name, JSON.stringify(parsed));
      }
      index.profiles[row.name] = { ...index.profiles[row.name], uuid: row.actual_uuid, email: row.actual_email };
      row.repair = "relabelled";
      dirty = true;
    }
  }
  if (dirty) {
    writeProfileIndex(index);
    invalidateAccountsCache();
  }
  return audit;
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
  // The two fields below are LOCAL ONLY — stripped before the heartbeat,
  // because Convex's ccUsageValidator rejects unknown fields and a daemon that
  // sent one would have every heartbeat's account inventory refused.
  //
  // Where this reading came from. Absent means the OAuth usage endpoint;
  // "live-session" means a running session's statusLine command forwarded the
  // windows the Messages API had just reported (statuslineHook.ts).
  source?: "live-session";
  // When the usage endpoint last answered for this account, carried across live
  // updates. The live payload has no model-scoped window, so this is what
  // bounds how long a live feed may hold the poll off.
  polled_at?: number;
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

/** A usage-endpoint refusal, carrying what the response said about coming back.
 *  `retryAfterMs` is set only when the server named a wait (429 Retry-After);
 *  otherwise the caller picks its own delay. */
export class CcUsageHttpError extends CcAccountError {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`usage endpoint ${status}`);
  }
}

// Why: a corrupt or hostile Retry-After would otherwise hold every automated
// usage poll off for years, freezing the meters auto-switch reads (ct-49527).
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Retry-After (RFC 9110) in ms: either delta-seconds or an HTTP date. Capped
 *  at 24h. Undefined when the header is absent, unparseable, or already past —
 *  the caller then falls back to its own backoff. Exported for tests. */
export function parseRetryAfter(header: string | null | undefined, now: number): number | undefined {
  const raw = header?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : undefined;
}

export async function fetchUsageSnapshot(
  accessToken: string,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<CcUsageSnapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
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
    throw new CcUsageHttpError(
      resp.status,
      resp.status === 429 ? parseRetryAfter(resp.headers.get("retry-after"), now) : undefined,
    );
  }
  return parseUsageResponse(await resp.json(), now);
}

// ---------------------------------------------------------------------------
// Per-account poll backoff
// ---------------------------------------------------------------------------
// The poll used to treat every refusal alike: throw, and try again on the next
// five-minute tick. That reads a 429's Retry-After as noise and hammers a rate-
// limited endpoint, and it makes a hard outage cost one request per account per
// five minutes for as long as it lasts. So a failure now records when this
// account may be asked again: what the server named on a 429, else 30s doubling
// per consecutive failure. The stale snapshot always survives — a meter that
// flapped to empty on a transient 500 would read as headroom.

const USAGE_BACKOFF_BASE_MS = 30_000;
const USAGE_BACKOFF_MAX_MS = 15 * 60 * 1000;

export interface UsageRetryState {
  retry_at: number; // no automated probe of this account before then
  failures: number; // consecutive failures; drives the delay
  reason: string; // the last failure, as `cast usage` prints it
  failed_at: number;
  status?: number; // HTTP status, when the endpoint answered at all
  retry_after?: boolean; // the server named the wait; not our own guess
}

/** The backoff state after one failed probe. */
function nextUsageRetry(
  prev: UsageRetryState | undefined,
  err: unknown,
  now: number,
): UsageRetryState {
  const failures = (prev?.failures ?? 0) + 1;
  const http = err instanceof CcUsageHttpError ? err : undefined;
  const named = http?.retryAfterMs;
  const backoff = Math.min(USAGE_BACKOFF_BASE_MS * 2 ** (failures - 1), USAGE_BACKOFF_MAX_MS);
  return {
    retry_at: now + (named ?? backoff),
    failures,
    reason: err instanceof Error ? err.message : String(err),
    failed_at: now,
    ...(http && { status: http.status }),
    ...(named !== undefined && { retry_after: true }),
  };
}

function usageCachePath(): string {
  return path.join(defaultConfigDir(), "cc-usage.json");
}

export interface UsageCache {
  // Keyed by account uuid (email fallback) — the same identity the profile
  // index carries, so a profile covering the active login shares one entry.
  accounts: Record<string, CcUsageSnapshot>;
  // Backoff after a failed probe, same keys. Kept beside the snapshots rather
  // than inside one because Convex's ccUsageValidator is a closed object: a
  // snapshot carrying an extra field would have every heartbeat's whole account
  // inventory rejected. So this stays local — `cast usage` reads it, the
  // heartbeat never sends it.
  retries?: Record<string, UsageRetryState>;
}

export function readUsageCache(): UsageCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(usageCachePath(), "utf-8"));
    if (parsed && typeof parsed.accounts === "object") {
      if (!parsed.retries || typeof parsed.retries !== "object") delete parsed.retries;
      return parsed;
    }
  } catch {}
  return { accounts: {} };
}

// ---------------------------------------------------------------------------
// Activation stamp — when the machine's active account last changed
// ---------------------------------------------------------------------------
// The server's auto-switch loop reads limit parks and usage snapshots as
// evidence about the ACTIVE account. A park stamped before the account changed
// hands belongs to the previous login, and a snapshot fetched before the change
// says nothing about the new one — acting on either pushed a 2%-used account
// off the machine twice on 2026-09-02. The stamp lets the loop tell the two
// apart: it holds off judging the account until a probe fetched after `since`
// lands, and `refreshUsageSnapshots` makes that probe skip the throttle.
interface ActiveStamp {
  key: string; // account uuid, else email — the usage cache's key
  since: number;
}

function activeStampPath(): string {
  return path.join(defaultConfigDir(), "cc-active.json");
}

export function readActiveStamp(): ActiveStamp | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(activeStampPath(), "utf-8"));
    if (parsed && typeof parsed.key === "string" && typeof parsed.since === "number") return parsed;
  } catch {}
  return null;
}

/** Record `key` as the active account. Returns when it became active: `now`
 * if it just changed, else the stored time. */
export function noteActiveAccount(key: string | undefined, now = Date.now()): number | undefined {
  if (!key) return undefined;
  const prev = readActiveStamp();
  if (prev?.key === key) return prev.since;
  atomicWriteFile(activeStampPath(), JSON.stringify({ key, since: now }), { mode: 0o644 });
  return now;
}

export interface UsageRefreshSummary {
  probed: string[];
  skipped: string[];
  failed: Array<{ name: string; reason: string }>;
  // Dormant profiles whose tokens were rotated on this pass to make the probe
  // possible (see refreshProfileCredential).
  rotated: string[];
  // Dormant profiles whose refresh token the endpoint refused on this pass:
  // now marked login_expired_at in the index.
  expired: string[];
}

/**
 * Refresh usage snapshots for the active login + every saved profile. A
 * dormant profile whose access token has lapsed is rotated first with its own
 * refresh token (refreshProfileCredential) — its reading otherwise froze at
 * the last probe before the token died, and a frozen pegged window kept the
 * account out of auto-switch for days. A profile already marked login-expired
 * is skipped (its last snapshot survives) until a re-save clears the mark.
 * Per-account probes are throttled by `minIntervalMs` (0 = probe everything
 * now) so callers can invoke this freely.
 */
// ---------------------------------------------------------------------------
// Live usage from a session's statusLine command
// ---------------------------------------------------------------------------
// Every turn of every Claude session carries the account's rate-limit windows,
// and the statusLine hook forwards them (statuslineHook.ts). That feed is
// fresher AND cheaper than the OAuth usage endpoint, so while it is running it
// takes precedence: the poll skips an account with a fresh live reading, and a
// poll that fails or arrives late never overwrites one.

// How long a live reading stands in for a poll.
const LIVE_USAGE_FRESH_MS = 5 * 60 * 1000;

// But never for longer than this. The statusLine payload carries the two
// unified windows and no model-scoped one, so an account whose sessions post
// continuously would keep its Fable meter frozen at whatever the last poll saw
// — and auto-switch reads that meter. It would then send sessions to an account
// whose scoped window pegged hours ago, and continue them there each time they
// park. One poll every half hour is enough to keep that window honest and still
// cuts the endpoint's traffic for a busy account roughly sixfold.
const LIVE_USAGE_POLL_FLOOR_MS = 30 * 60 * 1000;

// A live post lands every 15s per active session. Rewriting the cache each time
// would invalidate the accounts payload and re-push the whole inventory on the
// next heartbeat for no new information, so an unchanged reading is only
// re-stamped this often.
const LIVE_USAGE_RESTAMP_MS = 60 * 1000;

/** A live reading recent enough to stand in for a usage poll. */
function isLiveUsageFresh(snap: CcUsageSnapshot | undefined, now: number): boolean {
  return snap?.source === "live-session" && now - snap.fetched_at < LIVE_USAGE_FRESH_MS;
}

/** The floor above. A live feed keeps `fetched_at` moving, so it holds off the
 *  ordinary throttle just as surely as the live skip — this is the one
 *  condition that overrides both. An account that has never been polled has no
 *  scoped window at all, so it is overdue from the start. */
function isLivePollOverdue(snap: CcUsageSnapshot | undefined, now: number): boolean {
  return snap?.source === "live-session" && now - (snap.polled_at ?? 0) >= LIVE_USAGE_POLL_FLOOR_MS;
}

/**
 * The usage windows out of a Claude Code statusLine payload, or null when it
 * carries none. Verified against 2.1.263: `rate_limits.five_hour` and
 * `.seven_day`, each `{ used_percentage, resets_at }` with `resets_at` in epoch
 * SECONDS (the usage endpoint answers ISO strings, hence the conversion).
 */
export function parseStatusLineUsage(payload: unknown, now: number): CcUsageSnapshot | null {
  const limits = (payload as any)?.rate_limits;
  if (!limits || typeof limits !== "object") return null;
  const window = (raw: any): CcUsageWindow | undefined => {
    if (typeof raw?.used_percentage !== "number" || !Number.isFinite(raw.used_percentage)) return undefined;
    const secs = raw.resets_at;
    const w: CcUsageWindow = { percent: raw.used_percentage };
    if (typeof secs === "number" && Number.isFinite(secs) && secs > 0) w.resets_at = Math.round(secs * 1000);
    return w;
  };
  const session = window(limits.five_hour);
  const weekly = window(limits.seven_day);
  if (!session && !weekly) return null;
  return { fetched_at: now, source: "live-session", ...(session && { session }), ...(weekly && { weekly }) };
}

/**
 * The live reading folded onto whatever the last poll left, or null when it
 * says nothing new.
 *
 * The statusLine payload carries only the two unified windows, so the model-
 * scoped window and the usage-credit block are carried over — dropping them
 * would read as headroom on an account whose Fable window is pegged, and
 * auto-switch would send sessions there. The tradeoff is that `fetched_at`
 * advances while `weekly_scoped` stays as old as the last poll, which is why
 * the live feed only holds the poll off for five minutes at a time and never
 * past the half-hour floor.
 *
 * Null for an unchanged reading: a post lands every 15s per active session, and
 * rewriting the cache each time would invalidate the accounts payload and
 * re-push the whole inventory on the next heartbeat for no new information.
 */
function mergeLiveUsage(
  prev: CcUsageSnapshot | undefined,
  snap: CcUsageSnapshot,
): CcUsageSnapshot | null {
  const merged: CcUsageSnapshot = {
    ...snap,
    ...(prev?.weekly_scoped && { weekly_scoped: prev.weekly_scoped }),
    ...(prev?.extra && { extra: prev.extra }),
    ...(prev?.polled_at !== undefined && { polled_at: prev.polled_at }),
    ...(!snap.weekly && prev?.weekly && { weekly: prev.weekly }),
    ...(!snap.session && prev?.session && { session: prev.session }),
  };
  const unchanged =
    prev?.source === "live-session" &&
    snap.fetched_at - prev.fetched_at < LIVE_USAGE_RESTAMP_MS &&
    prev.session?.percent === merged.session?.percent &&
    prev.weekly?.percent === merged.weekly?.percent;
  return unchanged ? null : merged;
}

export interface StatusLineIngest {
  key: string;
  snapshot: CcUsageSnapshot;
  wrote: boolean;
}

// Read-modify-write of one file from a route that can fire several times a
// second: without a chain two posts arriving together would both read the old
// cache and the second would erase the first.
let liveUsageWriteChain: Promise<void> = Promise.resolve();

/**
 * The whole /hook/statusline body -> the usage cache, so the daemon route stays
 * a parser and this stays testable. Null when the payload carries no windows or
 * no account can be named for it.
 *
 * Every filesystem call here is async on purpose: this runs on the daemon's
 * loopback server, where one synchronous read stalls delivery, injection, the
 * heartbeat and the watchdog alike (daemon.loopBudget.guard.test.ts).
 */
export async function ingestStatusLineUsage(
  payload: unknown,
  opts: { account?: string; now?: number } = {},
): Promise<StatusLineIngest | null> {
  const now = opts.now ?? Date.now();
  const snapshot = parseStatusLineUsage(payload, now);
  if (!snapshot) return null;
  const key = await usageKeyForSessionAsync(opts.account);
  if (!key) return null;

  let wrote = false;
  liveUsageWriteChain = liveUsageWriteChain.then(async () => {
    const stored = await readJsonAsync<UsageCache>(usageCachePath());
    const cache: UsageCache = stored?.accounts ? stored : { accounts: {} };
    const merged = mergeLiveUsage(cache.accounts[key], snapshot);
    if (!merged) return;
    cache.accounts[key] = merged;
    await writeJsonAsync(usageCachePath(), cache);
    wrote = true;
  });
  await liveUsageWriteChain;
  return { key, snapshot, wrote };
}

async function usageKeyForSessionAsync(account: string | undefined): Promise<string | undefined> {
  if (account) {
    if (!VALID_PROFILE_NAME.test(account)) return undefined;
    // The index is read for two strings, so the validating reader
    // (readProfileIndex) would only add a synchronous file read here.
    const index = await readJsonAsync<ProfileIndex>(indexPath());
    const meta = index?.profiles?.[account];
    return meta?.uuid || meta?.email || undefined;
  }
  return (await readJsonAsync<ActiveStamp>(activeStampPath()))?.key;
}
async function readJsonAsync<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}
async function writeJsonAsync(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o644 });
  await fs.promises.rename(temp, file);
}

export async function refreshUsageSnapshots(
  opts: { fetchImpl?: typeof fetch; now?: number; minIntervalMs?: number } = {},
): Promise<UsageRefreshSummary> {
  const now = opts.now ?? Date.now();
  const minInterval = opts.minIntervalMs ?? 4 * 60 * 1000;
  const cache = readUsageCache();
  const summary: UsageRefreshSummary = { probed: [], skipped: [], failed: [], rotated: [], expired: [] };

  const jobs = new Map<string, { label: string; token: string }>();
  const active = activeAccountSummary();
  const activeKey = active?.uuid || active?.email;
  const activeSince = noteActiveAccount(activeKey, now);
  // Keychain reads go async: this runs on a daemon timer, and a busy keychain
  // answered `security` in 2 to 3s (7 calls in one day's log, 2026-09-02).
  const activeCred = await readActiveCredentialAsync();
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
    if (meta.login_expired_at) {
      summary.skipped.push(name); // dead grant — keep last snapshot, no retry
      continue;
    }
    const raw = await readProfileSecretAsync(name);
    let profile: CcProfile | null = null;
    try {
      profile = raw ? parseProfile(raw) : null;
    } catch {
      profile = null;
    }
    if (!profile) {
      // An index entry with no readable secret behind it (keychain item gone,
      // blob corrupt): nothing can probe or switch to it. Same standing as a
      // refused grant — dead until the account signs in again and is
      // re-saved — so it is marked the same way rather than skipped in
      // silence, where it would read as live with a frozen meter.
      markLoginExpired(name, now);
      summary.expired.push(name);
      continue;
    }
    let token = profile.credentials?.claudeAiOauth?.accessToken;
    if (!credentialHealth(JSON.stringify(profile.credentials), now).pushable) {
      const prev = cache.accounts[key];
      if (prev && now - prev.fetched_at < minInterval) {
        summary.skipped.push(name); // inside the throttle — rotating now would buy nothing
        continue;
      }
      const rotated = await refreshProfileCredential(name, { fetchImpl: opts.fetchImpl, now });
      if (!rotated.refreshed) {
        if (rotated.dead) summary.expired.push(name);
        else summary.failed.push({ name, reason: rotated.reason ?? "token refresh failed" });
        continue;
      }
      summary.rotated.push(name);
      token = rotated.accessToken;
    }
    if (typeof token === "string" && token) jobs.set(key, { label: name, token });
  }
  if (activeKey) knownKeys.add(activeKey);

  const retries: Record<string, UsageRetryState> = { ...cache.retries };
  let retriesChanged = false;

  const probed = new Map<string, CcUsageSnapshot>();
  for (const [key, job] of jobs) {
    const prev = cache.accounts[key];
    // A just-activated account is probed regardless of the throttle: its last
    // snapshot predates the switch, and the server holds off judging the
    // account until one fetched after the activation lands.
    const predatesActivation =
      key === activeKey && activeSince !== undefined && !!prev && prev.fetched_at < activeSince;
    const backoff = retries[key];
    // Why: the endpoint named a wait (429 Retry-After) or we picked one after a
    // refusal; asking again before it earns another refusal and, on a 429, can
    // extend the block. This outranks both the activation probe and the live
    // feed's overdue stamp — no local urgency makes a rate-limited endpoint
    // answer. A human pressing refresh comes in with minInterval 0 and is let
    // through; only the poll is held (ct-49527).
    if (minInterval > 0 && backoff && now < backoff.retry_at) {
      summary.skipped.push(job.label);
      continue;
    }
    const mustProbe = predatesActivation || isLivePollOverdue(prev, now);
    // A session of this account feeds the windows every turn, so a poll would
    // spend the usage endpoint's tight budget for a staler answer (ct-49525).
    if (!mustProbe && (isLiveUsageFresh(prev, now) || (prev && now - prev.fetched_at < minInterval))) {
      summary.skipped.push(job.label);
      continue;
    }
    try {
      // polled_at is what bounds the live feed's hold on this poll; it rides
      // the snapshot so a later live update can carry it forward.
      probed.set(key, { ...(await fetchUsageSnapshot(job.token, { fetchImpl: opts.fetchImpl, now })), polled_at: now });
      summary.probed.push(job.label);
      if (retries[key]) {
        delete retries[key]; // recovered — the next failure starts at 30s again
        retriesChanged = true;
      }
    } catch (err) {
      retries[key] = nextUsageRetry(retries[key], err, now);
      retriesChanged = true;
      summary.failed.push({ name: job.label, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (probed.size > 0 || retriesChanged) {
    // Re-read rather than write back the copy taken before the probes: a live
    // statusLine post can land during them (keychain reads and the endpoint
    // together run for seconds), and writing the stale copy would erase it.
    const latest = readUsageCache();
    for (const [key, snap] of probed) {
      const disk = latest.accounts[key];
      // A live post landed while this pass ran. Its unified windows are newer,
      // so keep them and take from the endpoint only what it alone can say —
      // including the stamp that lets the feed hold off the next poll.
      latest.accounts[key] =
        disk && disk.fetched_at > snap.fetched_at
          ? {
              ...disk,
              polled_at: snap.polled_at,
              ...(snap.weekly_scoped && { weekly_scoped: snap.weekly_scoped }),
              ...(snap.extra && { extra: snap.extra }),
            }
          : snap;
    }
    // Drop entries for deleted profiles so the cache can't grow unbounded.
    for (const key of Object.keys(latest.accounts)) {
      if (!knownKeys.has(key)) delete latest.accounts[key];
    }
    for (const key of Object.keys(retries)) {
      if (!knownKeys.has(key)) delete retries[key];
    }
    if (Object.keys(retries).length > 0) latest.retries = retries;
    else delete latest.retries;
    atomicWriteFile(usageCachePath(), JSON.stringify(latest, null, 2), { mode: 0o644 });
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Heartbeat payload (non-secret) — lets the web render the switcher
// ---------------------------------------------------------------------------

export interface AccountsHeartbeatPayload {
  active_email?: string;
  active_uuid?: string;
  // When the active account last changed (see the activation stamp). The
  // server's auto-switch loop trusts a usage snapshot of the active account
  // only if it was fetched after this.
  active_since?: number;
  profiles: Array<{
    name: string;
    email?: string;
    tier?: string;
    subscription?: string;
    usage?: CcUsageSnapshot;
    // Per-session launch token on file for this profile (never the token).
    token?: { stored_at: number; expires_at: number };
    // The saved login is dead (refresh refused) — see CcProfileMeta.
    login_expired_at?: number;
  }>;
}

// Keyed on the mtimes of the files the payload derives from rather than a TTL:
// a `cast accounts save` in another process, a fresh /login, or a usage refresh
// shows up on the very next heartbeat instead of after a blind expiry window.
// The compute result — including a failed/null one — is memoized against the
// same mtimes, so a broken source file isn't re-parsed every call.
// `ttlMs` adds a time bound for a payload whose sources the mtimes cannot
// fully name (the daemon's project roots also come from started sessions).
export function createMtimeGatedCache<T>(
  paths: () => string[],
  compute: () => T,
  opts?: { ttlMs?: number },
): { get(): T; invalidate(): void } {
  let cached: { value: T; mtimes: number[]; at: number } | null = null;
  const mtimeOf = (p: string): number => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  return {
    get() {
      const now = Date.now();
      const mtimes = paths().map(mtimeOf);
      const fresh = opts?.ttlMs === undefined || (cached !== null && now - cached.at < opts.ttlMs);
      if (cached && fresh && cached.mtimes.every((m, i) => m === mtimes[i])) {
        return cached.value;
      }
      const value = compute();
      cached = { value, mtimes, at: now };
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
  () => [indexPath(), claudeJsonPath(), usageCachePath(), activeStampPath(), defaultConfigDir()],
  () => {
    let value: AccountsHeartbeatPayload | null = null;
    try {
      const active = activeAccountSummary();
      const stamp = readActiveStamp();
      const activeSince =
        stamp && (active?.uuid || active?.email) === stamp.key ? stamp.since : undefined;
      const usage = readUsageCache().accounts;
      const profiles = listProfiles().map(({ name, email, uuid, tier, subscription, login_expired_at }) => {
        const tok = accountTokenInfo(name);
        return {
          name,
          email,
          tier,
          subscription,
          usage: usage[uuid || email || ""] ?? undefined,
          ...(tok ? { token: { stored_at: tok.stored_at, expires_at: tok.expires_at } } : {}),
          ...(login_expired_at ? { login_expired_at } : {}),
        };
      });
      if (active?.email || profiles.length > 0) {
        value = {
          active_email: active?.email,
          active_uuid: active?.uuid,
          ...(activeSince !== undefined ? { active_since: activeSince } : {}),
          profiles,
        };
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
