/**
 * Carrying your logins to a browser that is not on this machine.
 *
 * ## Why the profile copy is not enough
 *
 * Chrome encrypts every cookie with a key derived from a secret in the login
 * Keychain — one 24-character string, per machine. Copying the profile to
 * another Mac therefore produces a browser that is signed out of everything:
 * measured on this machine, 400 of 400 cookies were `v10`-encrypted with none
 * in plaintext, and decrypting one with a different machine's secret returns
 * garbage.
 *
 * Shipping the Keychain secret alongside the profile would work and is the
 * wrong trade: that one string decrypts every cookie for every site you are
 * signed into, it would live on a rented host, and revoking it means rotating
 * every session you have. So the secret never leaves this machine. We decrypt
 * here, hand over the individual cookies, and let the remote Chrome re-encrypt
 * them under its own key.
 *
 * ## Which sites — nobody should have to answer that
 *
 * The obvious design asks the human for a list of domains, which is both a
 * chore and a guess: they cannot know in advance which sites a task will touch.
 *
 * Navigation answers it instead. A browser only needs credentials for a site at
 * the moment it visits that site, so the driver provisions on demand: before it
 * navigates, it checks whether the target host already has cookies, and if not
 * it decrypts just that host's and injects them. No list, no configuration, and
 * the set of credentials that ever leaves this machine is exactly the set the
 * work actually used — which is a smaller exposure than any list a human would
 * have written, not a larger one.
 *
 * ## The one site that is never carried: Google
 *
 * Google rotates its session cookies and revokes a session it sees from two
 * browsers — carrying them signs the HUMAN out too (profile.ts has the full
 * story). Both carry paths skip the own-login hosts; the agent browser holds
 * its own Google login, made once by a person with `cast browser login`.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PageSession } from "./instance.js";
import { CdpConnection } from "./cdp.js";
import { chromeUserDataRoot, cookieDbPath, keepsOwnLogin, type ChromeChannel } from "./profile.js";

export { cookieDbPath };

/** A cookie in the shape `Network.setCookies` wants. */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
  sameSite?: "Strict" | "Lax" | "None";
}

const CHROME_V10 = "v10";
// Chrome's fixed KDF parameters on macOS. Not ours to choose.
const KDF_SALT = "saltysalt";
const KDF_ROUNDS = 1003;
const KDF_LEN = 16;
const AES_IV = Buffer.alloc(16, 0x20); // sixteen spaces

let cachedKey: Buffer | null = null;

/**
 * The AES key Chrome derives from the login Keychain.
 *
 * Reading it prompts for Keychain access the first time unless the entry is
 * already trusted for this binary. Cached for the life of the process so a
 * batch of navigations asks once.
 */
export function chromeEncryptionKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  if (process.platform !== "darwin") return null;
  try {
    const secret = execFileSync(
      "security",
      ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!secret) return null;
    cachedKey = crypto.pbkdf2Sync(secret, KDF_SALT, KDF_ROUNDS, KDF_LEN, "sha1");
    return cachedKey;
  } catch {
    return null;
  }
}

/**
 * Decrypt one `encrypted_value` blob.
 *
 * Chrome prefixes the plaintext with a 32-byte hash of the cookie's domain on
 * newer builds and not on older ones. Distinguishing them by version byte is
 * unreliable across channels, so decide from the bytes: if the first 32 look
 * like a digest rather than text, drop them.
 */
export function decryptCookieValue(blob: Buffer, key: Buffer): string | null {
  if (blob.subarray(0, 3).toString("utf-8") !== CHROME_V10) return null;
  try {
    const d = crypto.createDecipheriv("aes-128-cbc", key, AES_IV);
    d.setAutoPadding(false);
    let out = Buffer.concat([d.update(blob.subarray(3)), d.final()]);
    const pad = out[out.length - 1];
    if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);
    const printable = (b: Buffer) => b.every((c) => c >= 0x20 && c < 0x7f);
    if (out.length > 32 && !printable(out.subarray(0, 32))) out = out.subarray(32);
    if (!printable(out)) return null;
    return out.toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Every `host_key` Chrome would send to `host`.
 *
 * A cookie set on `.example.com` is sent to `api.example.com`, so a host needs
 * its own name plus every parent domain. The walk stops two labels from the end
 * rather than consulting a public suffix list: the only cost of stopping in the
 * wrong place for a name like `foo.co.uk` is asking for `.co.uk` cookies, which
 * do not exist, so the query returns nothing and nothing breaks.
 */
export function cookieHostKeys(host: string): string[] {
  const clean = host.replace(/^\.+/, "").toLowerCase();
  if (!clean || /^[\d.]+$/.test(clean) || clean.includes(":")) return [clean];
  const labels = clean.split(".");
  // A single-label host — an intranet name like `wiki`, or localhost — has no
  // parent to walk to. It still has to return itself: an empty list would build
  // `IN ()`, which is a SQL syntax error rather than an empty result.
  if (labels.length < 2) return [clean];
  const keys = new Set<string>();
  for (let i = 0; i + 2 <= labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    keys.add(suffix);
    keys.add(`.${suffix}`);
  }
  return [...keys];
}

export interface ReadCookiesResult {
  cookies: Cookie[];
  /** Set when nothing could be read, so callers can say why rather than "0". */
  reason?: string;
}

/**
 * Read and decrypt this machine's cookies for one host.
 *
 * The database is copied before reading: Chrome holds it open with WAL, and
 * querying the live file risks both a lock error and a torn read.
 */
export function localCookiesForHost(userDataDir: string, host: string, profileDir = "Default"): ReadCookiesResult {
  const db = cookieDbPath(userDataDir, profileDir);
  if (!db) return { cookies: [], reason: `no cookie database under ${userDataDir}` };
  const key = chromeEncryptionKey();
  if (!key) return { cookies: [], reason: "could not read the Chrome key from the login Keychain" };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cast-cred-"));
  try {
    const copy = path.join(scratch, "Cookies");
    fs.copyFileSync(db, copy);
    // Bring the write-ahead log along; the newest logins live there on a
    // profile Chrome is actively using.
    for (const ext of ["-wal", "-shm"]) {
      if (fs.existsSync(db + ext)) fs.copyFileSync(db + ext, copy + ext);
    }

    const hostKeys = cookieHostKeys(host);
    const inList = hostKeys.map((h) => `'${h.replace(/'/g, "''")}'`).join(",");
    const raw = execFileSync(
      "sqlite3",
      [
        copy,
        "-json",
        `SELECT host_key, name, path, is_secure, is_httponly, samesite, expires_utc,
                hex(encrypted_value) AS ev
         FROM cookies WHERE host_key IN (${inList})`,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!raw) return { cookies: [] };

    const sameSite = (n: number): Cookie["sameSite"] | undefined =>
      n === 0 ? "None" : n === 1 ? "Lax" : n === 2 ? "Strict" : undefined;

    const cookies: Cookie[] = [];
    for (const r of JSON.parse(raw) as any[]) {
      const value = decryptCookieValue(Buffer.from(r.ev, "hex"), key);
      if (value === null) continue;
      cookies.push({
        name: r.name,
        value,
        domain: r.host_key,
        path: r.path || "/",
        secure: !!r.is_secure,
        httpOnly: !!r.is_httponly,
        sameSite: sameSite(r.samesite),
        // Chrome counts microseconds from 1601; CDP wants seconds from 1970.
        // Zero means a session cookie, which CDP expects as an absent field.
        ...(r.expires_utc ? { expires: r.expires_utc / 1e6 - 11644473600 } : {}),
      });
    }
    return { cookies };
  } catch (err) {
    return { cookies: [], reason: (err as Error).message };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Does the clone hold the SAME Google session as the human's Chrome — copied
 * cookies rather than a login of its own? Used once, when a clone made before
 * the own-login rule is first started under it: shared rows must go (they are
 * the hazard), a distinct session is the clone's own and is kept, so the
 * person is not asked to sign in for nothing. Unreadable is treated as
 * shared — stripping costs one sign-in, keeping a shared session costs both.
 */
export function sharesGoogleSession(realRoot: string, cloneRoot: string, profileDir = "Default"): boolean {
  const SESSION = new Set(["SID", "__Secure-1PSID", "__Secure-3PSID", "LSID"]);
  const clone = localCookiesForHost(cloneRoot, "accounts.google.com");
  if (clone.reason) return true;
  const mine = clone.cookies.filter((c) => SESSION.has(c.name));
  if (!mine.length) return false;
  const real = localCookiesForHost(realRoot, "accounts.google.com", profileDir);
  if (real.reason) return true;
  const theirs = new Map(real.cookies.map((c) => [`${c.name}\u0000${c.domain}`, c.value]));
  return mine.some((c) => theirs.get(`${c.name}\u0000${c.domain}`) === c.value);
}

/** Cookies the target browser already holds for this host, keyed name+domain. */
async function remoteCookies(page: PageSession, url: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const r = await page.conn.send<any>("Network.getCookies", { urls: [url] }, page.sessionId, 8000);
    for (const c of r.cookies ?? []) map.set(`${c.name}\u0000${c.domain}`, c.value);
  } catch {
    /* treat as empty; injecting is the safe direction */
  }
  return map;
}

/** Why a carry was skipped for an own-login host — the message agents read. */
export const OWN_LOGIN_REASON = "the agent browser keeps its own login for this site (a shared one signs both browsers out)";

export interface ProvisionResult {
  /** How many cookies were injected. Zero means none were needed or available. */
  injected: number;
  host: string;
  /** Why nothing was injected, when that is worth reporting. */
  reason?: string;
}

/**
 * Make sure the browser has this machine's login for `url`, before it navigates.
 *
 * A no-op only when the browser already holds exactly the cookies we would set,
 * so a repeat call costs nothing and never rewrites a session with itself.
 */
export async function provisionCredentials(
  page: PageSession,
  url: string,
  userDataDir: string,
): Promise<ProvisionResult> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { injected: 0, host: url, reason: "not a url" };
  }
  if (!host || host === "localhost" || /^[\d.]+$/.test(host)) {
    return { injected: 0, host, reason: "local address" };
  }
  if (keepsOwnLogin(host)) return { injected: 0, host, reason: OWN_LOGIN_REASON };

  const { cookies, reason } = localCookiesForHost(userDataDir, host);
  if (!cookies.length) return { injected: 0, host, reason: reason ?? "no local cookies for this site" };

  // Skip only when every cookie we hold is ALREADY there with the same value.
  //
  // The obvious test — "does the browser have any cookies for this host?" — is
  // wrong, and wrong in the direction that silently fails. Sites set tracking
  // and preference cookies on the very first request, so a signed-out browser
  // is never empty: github.com hands out `_octo` and `logged_in=no` before you
  // have done anything. Counting those as a session meant the login was never
  // carried over and the page stayed signed out, with nothing reported.
  const already = await remoteCookies(page, url);
  const missing = cookies.filter((c) => already.get(`${c.name}\u0000${c.domain}`) !== c.value);
  if (!missing.length) return { injected: 0, host, reason: "already has the same cookies" };

  await page.conn.send("Network.setCookies", { cookies: missing }, page.sessionId, 10_000);
  return { injected: missing.length, host };
}

/**
 * The same carry-over for the LOCAL managed browser, at the browser level.
 *
 * The managed browser starts from a clone of the real profile, but a clone is a
 * snapshot: sign in to something new in your real Chrome an hour later and the
 * agent's browser does not know. So before an agent opens a site, the cookies
 * your real Chrome holds for that host are read fresh (the same decrypt as the
 * remote path — the key never leaves the machine) and any that differ are set
 * through the browser-wide `Storage` domain, no page needed. Local-storage
 * tokens are not carried; sites that keep their session only there still need
 * a sign-in in the agent's tab.
 */
export async function provisionLocalLogins(
  port: number,
  url: string,
  source: { profileDir: string; channel?: ChromeChannel },
): Promise<ProvisionResult> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { injected: 0, host: url, reason: "not a url" };
  }
  if (!host || host === "localhost" || /^[\d.]+$/.test(host)) return { injected: 0, host, reason: "local address" };
  if (keepsOwnLogin(host)) return { injected: 0, host, reason: OWN_LOGIN_REASON };
  const root = chromeUserDataRoot(source.channel ?? "chrome");
  if (!root) return { injected: 0, host, reason: "no real Chrome profile on this machine" };

  const { cookies, reason } = localCookiesForHost(root, host, source.profileDir);
  if (!cookies.length) return { injected: 0, host, reason: reason ?? "no local cookies for this site" };

  const conn = await CdpConnection.fromPort(port, 5_000);
  try {
    const already = new Map<string, string>();
    try {
      const r = await conn.send<any>("Storage.getCookies", {}, undefined, 8_000);
      for (const c of r.cookies ?? []) already.set(`${c.name}\u0000${c.domain}`, c.value);
    } catch {
      /* treat as empty; injecting is the safe direction */
    }
    const missing = cookies.filter((c) => already.get(`${c.name}\u0000${c.domain}`) !== c.value);
    if (!missing.length) return { injected: 0, host, reason: "already has the same cookies" };
    await conn.send("Storage.setCookies", { cookies: missing }, undefined, 10_000);
    return { injected: missing.length, host };
  } finally {
    conn.close();
  }
}
