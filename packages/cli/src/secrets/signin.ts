// Saved sign-ins (docs/architecture/vault.md "Saved sign-ins"): the decisions,
// with no browser and no network, so each one is a plain function a test can
// pin. Which saved sign-in covers a host, which cookies belong to a site,
// whether the agent browser needs the saved jar, and whether its own jar has
// moved on far enough to be written back.
//
// Nothing here holds a value longer than a call. The one thing kept on disk is
// signinState: per sign-in, the cookie names it carries and a sha256 of the
// jar last written, so the next `open` can tell "still signed in, newer
// cookies" from "signed out" without reading the secret again.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { cookieHostKeys } from "../browser/credentials.js";
import { browserHome, keepsOwnLogin } from "../browser/profile.js";
import { secretNameProblem, signinCookie, siteProblem, type SecretMeta, type SigninCookie, type SigninPayload } from "@codecast/shared/contracts/secrets";

/** A browser's newer cookies go back to the Vault at most this often per sign-in. */
export const SIGNIN_REFRESH_EVERY_MS = 30 * 60_000;

/** localStorage kept per sign-in; a site that stores more keeps its session in cookies anyway. */
export const SIGNIN_STORAGE_MAX = 256_000;

/** The host a site argument names: a bare host or any URL, lowercased. Null when there is none. */
export function signinSite(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

const bare = (site: string) => site.toLowerCase().replace(/^\.+/, "").replace(/^www\./, "");

/** The sites that scope a sign-in. A public suffix the backend no longer accepts ("com") scopes nothing, on a row saved before it refused them. */
const scopingSites = (sites: readonly string[]) => sites.map(bare).filter((b) => !siteProblem(b));

/** Does a sign-in saved for `sites` cover `host`? The site itself, `www.` either way, and its subdomains. */
export function coversHost(sites: readonly string[], host: string): boolean {
  const h = bare(host);
  return scopingSites(sites).some((b) => h === b || h.endsWith(`.${b}`));
}

/**
 * The one saved sign-in to use for `host`: one whose cookies have not all
 * expired (signin_expires_at) over one that has, then the most specific site,
 * then the person's own over the team's, then the most recently written.
 * Requests (no value yet) and other kinds never match.
 */
export function pickSignin(rows: readonly SecretMeta[], host: string, now: number = Date.now()): SecretMeta | null {
  const specificity = (r: SecretMeta) => Math.max(...(r.sites ?? []).filter((s) => coversHost([s], host)).map((s) => bare(s).length));
  const expired = (r: SecretMeta) => Number(r.signin_expires_at !== undefined && r.signin_expires_at <= now);
  return (
    rows
      .filter((r) => r.kind === "signin" && r.status === "ready" && coversHost(r.sites ?? [], host))
      .sort(
        (a, b) =>
          expired(a) - expired(b) ||
          specificity(b) - specificity(a) ||
          Number(b.workspace.startsWith("user:")) - Number(a.workspace.startsWith("user:")) ||
          b.updated_at - a.updated_at,
      )[0] ?? null
  );
}

/**
 * Is a cookie on `domain` part of the sign-in for `sites`? Every host key the
 * browser would send to the site (its parents included, credentials.ts
 * cookieHostKeys) and the site's own subdomains. Google's are never part of
 * any, as in every other carry.
 */
export function inSiteScope(domain: string, sites: readonly string[]): boolean {
  const d = domain.toLowerCase().replace(/^\.+/, "");
  if (keepsOwnLogin(d)) return false;
  return scopingSites(sites).some((s) => {
    const keys = cookieHostKeys(s).map((k) => k.replace(/^\.+/, ""));
    return keys.includes(d) || d.endsWith(`.${s}`);
  });
}

/**
 * The part of a saved jar that may go into the agent browser for `sites`:
 * cookies in the sign-in's scope (never Google's), alive at `now` and carrying
 * only a cookie's own fields, and localStorage of the sign-in's own origins.
 * Whoever saved the row chose what it holds; this decides what a teammate's
 * browser takes from it.
 */
export function scopedJar(saved: Pick<SigninPayload, "cookies" | "local_storage">, sites: readonly string[], now: number): { cookies: SigninCookie[]; local_storage: Record<string, Record<string, string>> } {
  const cookies = aliveCookies(saved.cookies, now).filter((c) => inSiteScope(c.domain, sites)).map(signinCookie);
  const local_storage = Object.fromEntries(Object.entries(saved.local_storage ?? {}).filter(([origin]) => {
    try {
      const u = new URL(origin);
      return (u.protocol === "https:" || u.protocol === "http:") && u.origin === origin && inSiteScope(u.hostname, sites);
    } catch {
      return false;
    }
  }));
  return { cookies, local_storage };
}

export const cookieKey = (c: Pick<SigninCookie, "name" | "domain">) => `${c.name}\u0000${c.domain}`;

/** Cookies still alive at `now` (ms). A session cookie has no expiry and is alive. */
export function aliveCookies<T extends Pick<SigninCookie, "expires">>(cookies: readonly T[], now: number): T[] {
  return cookies.filter((c) => !(typeof c.expires === "number" && c.expires > 0 && c.expires * 1000 <= now));
}

/**
 * Does the browser need the saved jar? Yes when any saved cookie that is
 * still alive is missing from it.
 *
 * Counting "any cookie for the host" would be wrong the way it was for the
 * Chrome carry (credentials.ts provisionCredentials): sites hand a signed-out
 * browser tracking cookies on the first request. A browser holding every
 * saved name is signed in, maybe with newer values; those are the write-back's
 * to keep, never ours to overwrite with older ones.
 */
export function needsSignin(saved: readonly SigninCookie[], present: readonly Pick<SigninCookie, "name" | "domain">[], now: number): boolean {
  const have = new Set(present.map(cookieKey));
  return aliveCookies(saved, now).some((c) => !have.has(cookieKey(c)));
}

/** A stable fingerprint of a jar, so a later look can tell whether it moved. Order and session-only fields don't count. */
export function jarDigest(cookies: readonly SigninCookie[]): string {
  const rows = cookies.map((c) => [c.name, c.domain, c.path, c.value, c.expires ?? 0].join("\u0000")).sort();
  return crypto.createHash("sha256").update(rows.join("\u0001")).digest("hex");
}

/** What this machine remembers about a sign-in it injected or captured. No value, only names and a digest. */
export type SigninMemory = {
  name: string;
  /** cookieKey of each saved cookie: the browser is signed in while it holds them all. */
  keys: string[];
  digest: string;
  /** When this machine last wrote the jar (inject, capture or refresh), ms. */
  at: number;
  captured_from: SigninPayload["captured_from"];
  account_hint?: string;
  /** The value's value_updated_at as of that write or read: a write-back sends it, and the backend refuses one the value has moved past. A metadata edit leaves it alone. */
  updated_at?: number;
};

export function rememberJar(
  name: string,
  cookies: readonly SigninCookie[],
  from: Pick<SigninPayload, "captured_from" | "account_hint">,
  now: number,
  updatedAt?: number,
): SigninMemory {
  return {
    name,
    keys: [...new Set(cookies.map(cookieKey))],
    digest: jarDigest(cookies),
    at: now,
    captured_from: from.captured_from,
    ...(from.account_hint ? { account_hint: from.account_hint } : {}),
    ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
  };
}

/**
 * Does the browser still hold every cookie this machine last wrote for the
 * sign-in? A memory of no cookies proves nothing: every browser holds all of
 * none, signed out or not.
 */
export function stillSignedIn(memory: Pick<SigninMemory, "keys">, present: readonly Pick<SigninCookie, "name" | "domain">[]): boolean {
  const have = new Set(present.map(cookieKey));
  return memory.keys.length > 0 && memory.keys.every((k) => have.has(k));
}

/**
 * The jar to write back, or null. Only a browser still signed in (it holds
 * every saved name) whose cookies changed since this machine last wrote them,
 * and not sooner than `every` after that write: a session a site rotates on
 * every page view would otherwise rewrite the secret on every `open`.
 */
export function writeBackJar(memory: SigninMemory, current: readonly SigninCookie[], now: number, every = SIGNIN_REFRESH_EVERY_MS): SigninCookie[] | null {
  if (now - memory.at < every) return null;
  if (!stillSignedIn(memory, current)) return null;
  if (jarDigest(current) === memory.digest) return null;
  return [...current];
}

/**
 * After a refused write-back (the saved jar changed since this machine read
 * it), does the browser's jar still win? Only when its latest cookie expiry is
 * later than the saved one's: a site extends a live session's expiry, so the
 * later jar is the newer session. A tie, or session cookies only, keeps the
 * saved one.
 */
export function jarIsNewer(browser: readonly Pick<SigninCookie, "expires">[], saved: readonly Pick<SigninCookie, "expires">[]): boolean {
  const latest = (cookies: readonly Pick<SigninCookie, "expires">[]) => Math.max(0, ...cookies.map((c) => c.expires ?? 0));
  return latest(browser) > latest(saved);
}

// The cookies a site sets to say who is signed in, read for the account hint
// the Vault page and the dialog show. Not a secret: the site prints the same
// name on every page.
const ACCOUNT_COOKIES = ["dotcom_user"];

export function accountHint(cookies: readonly SigninCookie[]): string | undefined {
  for (const name of ACCOUNT_COOKIES) {
    const v = cookies.find((c) => c.name === name)?.value;
    if (v && v.length <= 100) return decodeURIComponent(v);
  }
  return undefined;
}

/**
 * The localStorage a write-back keeps: each origin as the browser reads it now
 * (empty when the site cleared it), and a saved origin the browser was not
 * read for, or whose read failed (null), as saved. A refresh replaces the
 * whole payload, so a saved origin left out here is gone on every machine.
 */
export function mergeStorage(
  saved: Record<string, Record<string, string>>,
  read: Record<string, Record<string, string> | null>,
): Record<string, Record<string, string>> {
  const out = { ...saved };
  for (const [origin, items] of Object.entries(read)) if (items) out[origin] = items;
  return out;
}

/** Origin -> key -> value with empty origins dropped and the whole bounded; null when nothing is left. */
export function boundedStorage(raw: Record<string, Record<string, string>>): Record<string, Record<string, string>> | null {
  const out: Record<string, Record<string, string>> = {};
  let size = 0;
  for (const [origin, items] of Object.entries(raw)) {
    const n = JSON.stringify(items).length;
    if (!Object.keys(items).length || size + n > SIGNIN_STORAGE_MAX) continue;
    out[origin] = items;
    size += n;
  }
  return Object.keys(out).length ? out : null;
}

// ── This machine's memory (browserHome()/vault-signins.json) ────────────────

function statePath(): string {
  return path.join(browserHome(), "vault-signins.json");
}

export function readSigninState(file = statePath()): Record<string, SigninMemory> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSigninMemory(id: string, memory: SigninMemory, file = statePath()): void {
  const all = readSigninState(file);
  all[id] = memory;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
}

// ── The vault_capture_signin daemon command ─────────────────────────────────

export type CaptureSigninArgs = { site: string; name?: string; where: { team_id: string } | { personal: true } };

/**
 * The command's args as the mutation wrote them: a site, an optional name and
 * exactly one of a team or personal. The child validates the same shape again
 * through its own flags.
 */
export function parseCaptureSigninArgs(json: string | undefined): CaptureSigninArgs {
  let a: any;
  try {
    a = json ? JSON.parse(json) : {};
  } catch {
    throw new Error("args are not JSON");
  }
  const site = typeof a.site === "string" ? signinSite(a.site) : null;
  if (!site) throw new Error("missing site");
  if (a.name !== undefined) {
    if (typeof a.name !== "string") throw new Error("name must be text");
    const p = secretNameProblem(a.name);
    if (p) throw new Error(p);
  }
  const team = typeof a.team_id === "string" && a.team_id ? a.team_id : null;
  if (!!team === (a.personal === true)) throw new Error("name exactly one of team_id, personal");
  return { site, ...(a.name ? { name: a.name } : {}), where: team ? { team_id: team } : { personal: true } };
}

/** The `cast vault save-signin` argv the daemon runs for these args; `check` only counts the cookies (vault_check_signin). */
export function captureSigninArgv(a: CaptureSigninArgs, check = false): string[] {
  return [
    "vault", "save-signin", a.site, "--from-chrome", "--json",
    ...(check ? ["--check"] : []),
    ...(a.name ? ["--name", a.name] : []),
    ...("team_id" in a.where ? ["--team", a.where.team_id] : ["--personal"]),
  ];
}
