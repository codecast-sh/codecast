/**
 * Chrome profile discovery and cloning.
 *
 * The problem this solves: since Chrome 136 the browser refuses
 * `--remote-debugging-port` whenever it points at the DEFAULT user-data-dir.
 * That killed the old "just attach to the browser you're already using" trick,
 * which is exactly what the Claude and Codex extensions rely on — they run
 * INSIDE the real profile, so they inherit every login for free.
 *
 * Without an extension the only lawful path is a separate user-data-dir, and a
 * fresh one is logged out of everything, which makes an agent useless on any
 * site that matters. So we clone: copy the identity-bearing files out of the
 * real profile into a managed directory that CDP is allowed to drive.
 *
 * Measured on Chrome 151 (macOS): a full profile is ~6.8G, the identity subset
 * is ~68M, and the clone comes up logged into GitHub, X and codecast — macOS
 * keeps the cookie encryption key in the Keychain under "Chrome Safe Storage",
 * which is per-browser rather than per-profile, so the copied cookie database
 * still decrypts.
 *
 * The clone is a POINT-IN-TIME COPY. It drifts as the real profile's sessions
 * refresh, so `cast browser start --resync` re-copies. It also means an agent's
 * writes never touch the human's real browser state.
 *
 * ## What the clone must NOT share: Google
 *
 * Google's session cookies rotate every few minutes (`__Secure-1PSIDTS` and
 * friends), and a token that keeps turning up from two browsers reads to Google
 * as a stolen cookie: it invalidates the whole session, and BOTH browsers land
 * on the account chooser — the agent's and the human's real Chrome. Seen on
 * 2026-08-17: the clone was signed out first, then the human's Chrome. The
 * copied profile also carries the Chrome-level account (refresh tokens in
 * `Web Data`'s token_service, the account list and device id in Preferences),
 * which lets the clone act as a second copy of the human's Chrome.
 *
 * So the clone keeps its OWN Google login. `detachSharedIdentity` strips the
 * Google/YouTube cookies and the Chrome account from every clone, the per-open
 * cookie carry (credentials.ts) skips those hosts, and a person signs in once
 * in the agent browser (`cast browser login`). That login is the clone's own
 * session, so a `--resync` preserves it instead of copying the shared one back.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where managed clones live. Mode 0700 — these hold live session cookies. */
export function browserHome(): string {
  const root = process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast");
  return path.join(root, "browser");
}

export function clonePath(name: string): string {
  return path.join(browserHome(), "profiles", name);
}

// ---------------------------------------------------------------------------
// Logins the agent browser keeps for itself
// ---------------------------------------------------------------------------

/**
 * Sites whose login the clone must own rather than borrow from the human's
 * Chrome. Google rotates its session cookies and revokes a session it sees
 * from two browsers (header comment); YouTube carries the same cookies.
 * Matched as the host itself or any subdomain, so `accounts.google.com`,
 * `ads.google.com` and `.google.com` cookie rows all count.
 */
export const OWN_LOGIN_HOSTS: readonly string[] = ["google.com", "youtube.com"];

/** Does the agent browser keep its own login for this host (see OWN_LOGIN_HOSTS)? */
export function keepsOwnLogin(host: string): boolean {
  const h = host.replace(/^\.+/, "").toLowerCase();
  return OWN_LOGIN_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
}

/** SQL predicate selecting the cookie rows of the own-login hosts. */
function ownLoginCookieWhere(): string {
  return OWN_LOGIN_HOSTS.map((s) => `host_key = '${s}' OR host_key LIKE '%.${s}'`).join(" OR ");
}

/** Where a Chrome profile keeps its cookie database (moved across versions). */
export function cookieDbPath(userDataDir: string, profileDir = "Default"): string | null {
  for (const rel of [[profileDir, "Network", "Cookies"], [profileDir, "Cookies"]]) {
    const p = path.join(userDataDir, ...rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Run SQL against a database with the sqlite3 CLI; throws on failure. Refuses
 * a file that is not SQLite first: pointed at one, sqlite3 truncates the
 * `-wal` sidecar beside it while failing, which is a worse outcome than
 * skipping the step.
 */
function sqlite(db: string, sql: string): string {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(db, "r");
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString("latin1") !== "SQLite format 3\0") throw new Error(`${path.basename(db)} is not a SQLite database`);
  return execFileSync("sqlite3", [db, sql], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Written into a clone once its shared identity has been stripped. A clone
 * without it predates the rule: its Google cookies are copies of the human's
 * session and must not be preserved across a resync.
 */
const IDENTITY_STAMP = "cast-identity.json";

export function identityDetached(userDataDir: string): boolean {
  return fs.existsSync(path.join(userDataDir, IDENTITY_STAMP));
}

export interface DetachReport {
  /** Cookie rows removed for the own-login hosts; null when the store was unreadable. */
  cookies: number | null;
  /** Chrome account refresh tokens removed; null when Web Data was unreadable. */
  tokens: number | null;
  /** Steps that did not apply, in words — surfaced, never fatal. */
  notes: string[];
}

/**
 * Turn a copied profile into a browser that is nobody's Chrome: drop the
 * own-login hosts' cookies, the Chrome account's refresh tokens (`Web Data`
 * token_service), the account list, device id and cookie cache in
 * Preferences, and the signed-in identity in `Local State`'s profile cache.
 * Idempotent, and stamps the clone so a later start can tell it has run.
 * Every step is best effort: a Chrome build that renamed a table loses one
 * layer of the strip, not the launch.
 */
export function detachSharedIdentity(userDataDir: string, opts: { cookies?: boolean } = {}): DetachReport {
  const profile = path.join(userDataDir, "Default");
  const report: DetachReport = { cookies: null, tokens: null, notes: [] };

  if (opts.cookies !== false) {
    const db = cookieDbPath(userDataDir);
    if (db) {
      try {
        report.cookies = parseInt(sqlite(db, `DELETE FROM cookies WHERE ${ownLoginCookieWhere()}; SELECT changes();`), 10) || 0;
      } catch (err) {
        report.notes.push(`could not strip Google cookies: ${(err as Error).message.split("\n")[0]}`);
      }
    }
  }

  const webData = path.join(profile, "Web Data");
  if (fs.existsSync(webData)) {
    try {
      report.tokens = parseInt(sqlite(webData, "DELETE FROM token_service; SELECT changes();"), 10) || 0;
    } catch (err) {
      report.notes.push(`could not strip Chrome account tokens: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  const prefsPath = path.join(profile, "Preferences");
  try {
    if (fs.existsSync(prefsPath)) {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
      prefs.account_info = [];
      delete prefs.gaia_cookie;
      if (prefs.google) delete prefs.google.services;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    }
  } catch (err) {
    report.notes.push(`could not strip the account from Preferences: ${(err as Error).message}`);
  }

  const localStatePath = path.join(userDataDir, "Local State");
  try {
    if (fs.existsSync(localStatePath)) {
      const state = JSON.parse(fs.readFileSync(localStatePath, "utf-8"));
      const cache = state?.profile?.info_cache ?? {};
      // Keep the look of the profile (name, colours), drop everything that
      // says whose Google account it is or that a company manages it.
      const own = Object.fromEntries(
        Object.entries(cache.Default ?? {}).filter(([k]) => !/gaia|picture|hosted_domain|managed|user_name|consented|enterprise/.test(k)),
      );
      state.profile = {
        ...(state.profile ?? {}),
        info_cache: { Default: { ...own, gaia_id: "", gaia_name: "", user_name: "", is_consented_primary_account: false } },
        last_used: "Default",
        last_active_profiles: ["Default"],
      };
      fs.writeFileSync(localStatePath, JSON.stringify(state));
    }
  } catch (err) {
    report.notes.push(`could not strip the account from Local State: ${(err as Error).message}`);
  }

  fs.writeFileSync(path.join(userDataDir, IDENTITY_STAMP), JSON.stringify({ version: 1, detached_at: Date.now() }));
  return report;
}

/**
 * Copy the own-login hosts' cookie rows from an earlier clone's store into a
 * fresh one, so a resync keeps the login a person made in the agent browser.
 * Both stores were written by the same Chrome under the same Keychain key, so
 * the encrypted values carry over as they are.
 */
function preserveOwnLogins(fromDb: string, toDb: string): number {
  const rows = sqlite(
    toDb,
    `ATTACH DATABASE '${fromDb.replace(/'/g, "''")}' AS old;
     INSERT OR REPLACE INTO cookies SELECT * FROM old.cookies WHERE ${ownLoginCookieWhere()};
     SELECT changes();`,
  );
  return parseInt(rows, 10) || 0;
}

/** Root of a real Chrome install's user data, by channel. */
export function chromeUserDataRoot(channel: ChromeChannel = "chrome"): string | null {
  const home = os.homedir();
  const roots: Record<ChromeChannel, string[]> =
    process.platform === "darwin"
      ? {
          chrome: [path.join(home, "Library/Application Support/Google/Chrome")],
          canary: [path.join(home, "Library/Application Support/Google/Chrome Canary")],
          chromium: [path.join(home, "Library/Application Support/Chromium")],
        }
      : {
          chrome: [path.join(home, ".config/google-chrome")],
          canary: [path.join(home, ".config/google-chrome-unstable")],
          chromium: [path.join(home, ".config/chromium")],
        };
  for (const r of roots[channel]) {
    if (fs.existsSync(r)) return r;
  }
  return null;
}

export type ChromeChannel = "chrome" | "canary" | "chromium";

export interface RealProfile {
  /** Directory name under the user-data root: "Default", "Profile 3", … */
  dir: string;
  /** The name the human gave it in Chrome's profile switcher. */
  name: string;
  /** Signed-in account, when Chrome knows one. */
  email: string | null;
  /** Chrome's own "last used" pointer — the profile they were just in. */
  lastUsed: boolean;
}

/**
 * Read Chrome's `Local State` to enumerate profiles with their human names.
 * The directory names alone ("Profile 7") are useless for choosing.
 */
export function listRealProfiles(channel: ChromeChannel = "chrome", rootOverride?: string): RealProfile[] {
  const root = rootOverride ?? chromeUserDataRoot(channel);
  if (!root) return [];
  try {
    return parseLocalState(fs.readFileSync(path.join(root, "Local State"), "utf-8"));
  } catch {
    return [];
  }
}

/** Split out from file reading so the parsing rules can be tested directly. */
export function parseLocalState(raw: string): RealProfile[] {
  let state: any;
  try {
    state = JSON.parse(raw);
  } catch {
    return [];
  }
  const cache = state?.profile?.info_cache ?? {};
  const lastUsed = state?.profile?.last_used ?? "Default";
  return Object.entries(cache)
    .map(([dir, info]: [string, any]) => ({
      dir,
      name: info?.name || dir,
      email: info?.user_name || null,
      lastUsed: dir === lastUsed,
    }))
    .sort((a, b) => (a.lastUsed ? -1 : b.lastUsed ? 1 : a.dir.localeCompare(b.dir)));
}

// Files at the user-data root that the clone needs. `Local State` carries the
// profile registry and the encryption metadata the cookie store refers to.
const ROOT_FILES = ["Local State", "First Run"];

// Per-profile identity carriers. Chrome moved cookies from the profile root
// into Network/ and back across versions, so both locations are attempted and
// whichever exists wins.
const PROFILE_FILES = [
  "Cookies",
  "Preferences",
  "Secure Preferences",
  "Login Data",
  "Login Data For Account",
  "Web Data",
  "Affiliation Database",
  "Trust Tokens",
];

// IndexedDB is deliberately absent. It is where the bulk lives — 1.2G of the
// 1.3G on the development machine, against 4.5M of cookies — and copying it
// pushed Chrome's cold start past twenty seconds while adding no logins that
// cookies and Local Storage had not already carried. Sites that keep a refresh
// token only in IndexedDB will ask the agent to sign in again; that is the
// right trade for a clone that copies in a second.
const PROFILE_DIRS = [
  "Network", // cookies + transport security on newer builds
  "Local Storage", // where most SPAs park their session token
  "Session Storage",
];

// SQLite may be mid-transaction while the real Chrome is running; the sidecars
// carry the uncommitted tail. Copying the main file alone can yield a database
// that opens but is missing the most recent logins.
const SQLITE_SIDECARS = ["", "-wal", "-shm", "-journal"];

export interface CloneResult {
  dest: string;
  bytes: number;
  files: number;
  /** Names we expected but did not find — surfaced so a silent miss can't pass
   *  for success (an early version copied no cookies at all and looked fine). */
  missing: string[];
  cookiesFound: boolean;
  /** What was stripped so the clone shares no identity with the human's Chrome. */
  detach: DetachReport;
  /** Own-login cookie rows carried over from the previous clone (a resync). */
  ownLoginsKept: number;
}

function copyFile(from: string, to: string): number {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return fs.statSync(to).size;
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}

/**
 * Copy the identity-bearing subset of a real Chrome profile into a managed
 * directory that CDP is allowed to drive. Always writes the clone as profile
 * "Default" regardless of the source directory name, so the launch command
 * never has to pass --profile-directory.
 */
export function cloneProfile(opts: {
  sourceDir: string; // "Default", "Profile 7", …
  destRoot: string; // managed user-data-dir
  channel?: ChromeChannel;
  /** Point at a different user-data root. Used by tests. */
  sourceRoot?: string;
}): CloneResult {
  const root = opts.sourceRoot ?? chromeUserDataRoot(opts.channel ?? "chrome");
  if (!root) throw new Error(`No Chrome user data found for channel '${opts.channel ?? "chrome"}'`);
  const src = path.join(root, opts.sourceDir);
  if (!fs.existsSync(src)) {
    throw new Error(`Chrome profile '${opts.sourceDir}' not found at ${src}`);
  }

  const dest = opts.destRoot;
  const destProfile = path.join(dest, "Default");

  // A resync replaces the store, but the login a person made in the agent
  // browser for the own-login hosts is the clone's own and must survive it.
  // Only from a clone that was already detached: before that, its rows for
  // those hosts were copies of the human's session — the thing being removed.
  let keep: string | null = null;
  const oldDb = identityDetached(dest) ? cookieDbPath(dest) : null;
  if (oldDb) {
    keep = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-own-logins-")), "Cookies");
    for (const suffix of SQLITE_SIDECARS) {
      if (fs.existsSync(oldDb + suffix)) fs.copyFileSync(oldDb + suffix, keep + suffix);
    }
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(destProfile, { recursive: true, mode: 0o700 });
  fs.chmodSync(dest, 0o700);

  const missing: string[] = [];
  let files = 0;
  let cookiesFound = false;

  for (const f of ROOT_FILES) {
    const from = path.join(root, f);
    if (!fs.existsSync(from)) continue;
    copyFile(from, path.join(dest, f));
    files++;
  }

  for (const f of PROFILE_FILES) {
    let found = false;
    for (const suffix of SQLITE_SIDECARS) {
      const from = path.join(src, f + suffix);
      if (!fs.existsSync(from)) continue;
      try {
        copyFile(from, path.join(destProfile, f + suffix));
        files++;
        if (suffix === "") found = true;
      } catch {
        /* a locked sidecar is not fatal */
      }
    }
    if (found && f === "Cookies") cookiesFound = true;
    if (!found) missing.push(f);
  }

  for (const d of PROFILE_DIRS) {
    const from = path.join(src, d);
    if (!fs.existsSync(from)) {
      missing.push(`${d}/`);
      continue;
    }
    try {
      fs.cpSync(from, path.join(destProfile, d), { recursive: true, force: true });
      files++;
      if (d === "Network" && fs.existsSync(path.join(destProfile, d, "Cookies"))) {
        cookiesFound = true;
      }
    } catch {
      missing.push(`${d}/`);
    }
  }

  // Chrome asks to be the default browser and runs first-run flows on a fresh
  // data dir; both steal focus and block automation on the very first launch.
  try {
    const prefsPath = path.join(destProfile, "Preferences");
    if (fs.existsSync(prefsPath)) {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
      prefs.profile = { ...(prefs.profile ?? {}), exit_type: "Normal", exited_cleanly: true };
      prefs.browser = { ...(prefs.browser ?? {}), has_seen_welcome_page: true };
      // A restore bubble on launch covers the page an agent just opened.
      if (prefs.session) prefs.session.restore_on_startup = 5;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    }
  } catch {
    /* preference tidying is best effort */
  }

  const detach = detachSharedIdentity(dest);
  let ownLoginsKept = 0;
  if (keep) {
    const newDb = cookieDbPath(dest);
    if (newDb) {
      try {
        ownLoginsKept = preserveOwnLogins(keep, newDb);
      } catch (err) {
        detach.notes.push(`could not keep the agent browser's own logins: ${(err as Error).message.split("\n")[0]}`);
      }
    }
    fs.rmSync(path.dirname(keep), { recursive: true, force: true });
  }

  return { dest, bytes: dirSize(dest), files, missing, cookiesFound, detach, ownLoginsKept };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}
