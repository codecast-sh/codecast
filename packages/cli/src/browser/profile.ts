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
 * is ~68M, and the clone comes up logged into GitHub, Google and X — macOS
 * keeps the cookie encryption key in the Keychain under "Chrome Safe Storage",
 * which is per-browser rather than per-profile, so the copied cookie database
 * still decrypts.
 *
 * The clone is a POINT-IN-TIME COPY. It drifts as the real profile's sessions
 * refresh, so `cast browser profile sync` re-copies. It also means an agent's
 * writes never touch the human's real browser state.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where managed clones live. Mode 0700 — these hold live session cookies. */
export function browserHome(): string {
  return path.join(os.homedir(), ".codecast", "browser");
}

export function clonePath(name: string): string {
  return path.join(browserHome(), "profiles", name);
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
export function listRealProfiles(channel: ChromeChannel = "chrome"): RealProfile[] {
  const root = chromeUserDataRoot(channel);
  if (!root) return [];
  let state: any;
  try {
    state = JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf-8"));
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
}): CloneResult {
  const root = chromeUserDataRoot(opts.channel ?? "chrome");
  if (!root) throw new Error(`No Chrome user data found for channel '${opts.channel ?? "chrome"}'`);
  const src = path.join(root, opts.sourceDir);
  if (!fs.existsSync(src)) {
    throw new Error(`Chrome profile '${opts.sourceDir}' not found at ${src}`);
  }

  const dest = opts.destRoot;
  const destProfile = path.join(dest, "Default");
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

  return { dest, bytes: dirSize(dest), files, missing, cookiesFound };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}
