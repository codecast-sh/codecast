// Vault (docs/architecture/vault.md): what a secret is, the rules its name,
// env vars and payload follow, and the pieces every surface computes the same
// way: the fingerprint a person tells keys apart by, the env vars a secret
// injects, the values the daemon redacts, and the 2FA code a login's seed
// gives. Convex validates with these, the CLI injects with them, the web
// draws a live code with them, so the three cannot disagree.
//
// Pure and isomorphic: TOTP uses Web Crypto (crypto.subtle), present in
// Convex, Node/Bun and the browser.

import { isPublicSuffix, siteOf } from "./productView";
import { ENV_NAME_RE, envNameProblem, SECRET_REDACTION_MAX, SECRET_REDACTION_MIN, isCredentialName, parseDotenv, parseDotenvLine } from "./secretRules";
export { SECRET_NAME_RE, ENV_NAME_RE, secretNameProblem, envNameIssue, envNameProblem, type EnvNameIssue, SECRET_REDACTION_MAX, SECRET_REDACTION_MIN, isCredentialName, parseDotenv, parseDotenvLine } from "./secretRules";

export const SECRET_KINDS = ["key", "login", "signin", "file"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export const SECRET_STATUSES = ["ready", "requested"] as const;
export type SecretStatus = (typeof SECRET_STATUSES)[number];

/** What `cast vault get|run|env|otp` and the browser read a secret for; each read records one. */
export const SECRET_READ_PURPOSES = ["get", "run", "env", "otp", "signin"] as const;
export type SecretReadPurpose = (typeof SECRET_READ_PURPOSES)[number];

export const SECRET_EVENT_KINDS = [
  "created",
  "updated",
  "rotated",
  "revealed",
  "read",
  "injected",
  "signed_in",
  "refreshed",
  "requested",
  "fulfilled",
  "deleted",
  "ask_first_on",
  "ask_first_off",
  "approval_requested",
  "approved",
  "denied",
  // The asking session took its approval decision back (cast decide cancel): nobody answered it.
  "withdrawn",
  "restored",
  "redaction_sync",
] as const;
export type SecretEventKind = (typeof SECRET_EVENT_KINDS)[number];


/** The whole payload as JSON, in UTF-8 bytes. A signin's cookie jar is the large case. */
export const SECRET_PAYLOAD_MAX = 512_000;
const SECRET_REDACTION_CHUNK = 64;


/** A cookie in the shape CDP `Network.setCookies` / `Storage.setCookies`
 *  take (cli browser/credentials.ts Cookie). */
export type SigninCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
  sameSite?: "Strict" | "Lax" | "None";
};

export type KeyPayload = { value: string };
export type LoginPayload = { username?: string; password?: string; totp_seed?: string; url?: string };
export type FilePayload = { content: string; filename?: string };

/** A file secret's filename as its temp file is named: the last path segment, or null when that is empty, `.` or `..`. */
export function fileBasename(filename: string | undefined): string | null {
  const base = filename?.split(/[\\/]/).pop()?.trim();
  return base && base !== "." && base !== ".." ? base : null;
}
export type SigninPayload = {
  cookies: SigninCookie[];
  /** origin -> key -> value, written before first paint. */
  local_storage?: Record<string, Record<string, string>>;
  captured_from: "chrome" | "agent-browser";
  account_hint?: string;
};

export type SecretPayloadOf = { key: KeyPayload; login: LoginPayload; file: FilePayload; signin: SigninPayload };
export type SecretPayload = SecretPayloadOf[SecretKind];

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const optStr = (x: unknown) => x === undefined || x === null || typeof x === "string";
const SAME_SITE = new Set(["Strict", "Lax", "None"]);

function cookieProblem(c: unknown, i: number): string | null {
  if (!isObj(c)) return `cookie ${i + 1} is not an object`;
  for (const k of ["name", "value", "domain", "path"] as const) {
    if (typeof c[k] !== "string") return `cookie ${i + 1} has no ${k}`;
  }
  if (typeof c.secure !== "boolean" || typeof c.httpOnly !== "boolean") return `cookie ${i + 1} needs secure and httpOnly as true or false`;
  if (c.expires !== undefined && typeof c.expires !== "number") return `cookie ${i + 1} has a non-numeric expires`;
  if (c.sameSite !== undefined && !SAME_SITE.has(c.sameSite as string)) return `cookie ${i + 1} has sameSite "${String(c.sameSite)}" (Strict, Lax or None)`;
  return null;
}

/** A cookie with only the fields a sign-in carries: a stored or injected cookie names no url, partition or anything else CDP would honour. */
export function signinCookie(c: SigninCookie): SigninCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(c.expires !== undefined ? { expires: c.expires } : {}),
    ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
  };
}

/**
 * Check a payload against its kind and return it normalized (a key trimmed,
 * a 2FA seed without spaces), or the one sentence that says what to fix.
 * Never quotes a value back.
 */
export function validatePayload<K extends SecretKind>(kind: K, raw: unknown): { payload: SecretPayloadOf[K] } | { error: string } {
  if (!(SECRET_KINDS as readonly string[]).includes(kind)) return { error: `"${kind}" is not a secret kind: use key, login, signin or file` };
  if (!isObj(raw)) return { error: `a ${kind} secret's value must be an object` };
  let payload: SecretPayload;
  if (kind === "key") {
    if (typeof raw.value !== "string" || !raw.value.trim()) return { error: "a key needs a value: paste it, or pipe it on stdin" };
    if (raw.value.trim().length < SECRET_REDACTION_MIN) {
      return { error: `a key needs at least ${SECRET_REDACTION_MIN} characters: a shorter one cannot be redacted from transcripts without blanking ordinary text` };
    }
    payload = { value: raw.value.trim() };
  } else if (kind === "login") {
    for (const k of ["username", "password", "totp_seed", "url"] as const) {
      if (!optStr(raw[k])) return { error: `a login's ${k} must be text` };
    }
    const login: LoginPayload = {};
    if (typeof raw.username === "string" && raw.username.trim()) login.username = raw.username.trim();
    if (typeof raw.password === "string" && raw.password) login.password = raw.password;
    if (typeof raw.url === "string" && raw.url.trim()) login.url = raw.url.trim();
    if (typeof raw.totp_seed === "string" && raw.totp_seed.trim()) {
      const seed = normalizeTotpSeed(raw.totp_seed);
      if (!seed) return { error: "the 2FA seed is neither a base32 secret nor an otpauth:// link: copy the setup key the site shows under \"can't scan the code\"" };
      login.totp_seed = seed;
    }
    if (!login.username && !login.password && !login.totp_seed) return { error: "a login needs at least a username, a password or a 2FA seed" };
    payload = login;
  } else if (kind === "file") {
    if (typeof raw.content !== "string" || !raw.content) return { error: "a file secret needs its content: pass --file <path> or pipe it on stdin" };
    if (!optStr(raw.filename)) return { error: "a file secret's filename must be text" };
    if (typeof raw.filename === "string" && raw.filename.trim() && !fileBasename(raw.filename)) return { error: "a file secret's filename must name a file, not . or .. or a directory" };
    payload = { content: raw.content, ...(typeof raw.filename === "string" && raw.filename.trim() ? { filename: raw.filename.trim() } : {}) };
  } else {
    if (!Array.isArray(raw.cookies) || raw.cookies.length === 0) return { error: "a sign-in needs the site's cookies: sign in to the site first, then save the sign-in" };
    for (let i = 0; i < raw.cookies.length; i++) {
      const p = cookieProblem(raw.cookies[i], i);
      if (p) return { error: p };
    }
    if (raw.captured_from !== "chrome" && raw.captured_from !== "agent-browser") return { error: "a sign-in says where it was captured: chrome or agent-browser" };
    if (raw.local_storage !== undefined) {
      if (!isObj(raw.local_storage) || !Object.values(raw.local_storage).every((m) => isObj(m) && Object.values(m).every((v) => typeof v === "string"))) {
        return { error: "a sign-in's local_storage maps each origin to string keys and string values" };
      }
    }
    if (!optStr(raw.account_hint)) return { error: "a sign-in's account_hint must be text" };
    payload = {
      cookies: (raw.cookies as SigninCookie[]).map(signinCookie),
      captured_from: raw.captured_from,
      ...(raw.local_storage ? { local_storage: raw.local_storage as Record<string, Record<string, string>> } : {}),
      ...(typeof raw.account_hint === "string" && raw.account_hint ? { account_hint: raw.account_hint } : {}),
    };
  }
  // Bytes, not characters: a page of CJK text is three bytes a character, and the ciphertext has to fit a Convex document.
  if (new TextEncoder().encode(JSON.stringify(payload)).length > SECRET_PAYLOAD_MAX) return { error: `a secret holds at most ${SECRET_PAYLOAD_MAX / 1000} KB: store the file somewhere else and keep its key here` };
  return { payload: payload as SecretPayloadOf[K] };
}

/** First 4 and last 4 of a value long enough that 8 characters give away
 *  little (20+); nothing for anything shorter. */
export function fingerprint(value: string | undefined | null): string | undefined {
  const v = (value ?? "").trim();
  if (v.length < 20) return undefined;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/** A list of names as stored: trimmed, blanks and repeats dropped. Every
 *  writer cleans with this, and the web's optimistic edit too, so the server's
 *  echo equals what the person sees. */
export function cleanSecretList(xs?: string[]): string[] | undefined {
  return xs ? [...new Set(xs.map((x) => x.trim()).filter(Boolean))] : undefined;
}

/** Sites as stored: bare lowercase hostnames, whatever URL was pasted. */
export function cleanSecretSites(xs?: string[]): string[] | undefined {
  return cleanSecretList(xs?.map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")));
}

export type SecretMetaEdit = { name?: string; note?: string; env?: string[]; sites?: string[] };

/** An edit of a secret's metadata as stored: only the fields it names, each
 *  cleaned, and one emptied unset. `secrets.updateMeta` writes it and the web's
 *  optimistic edit applies it, so the server's echo equals the draft. */
export function cleanSecretEdit(fields: SecretMetaEdit): SecretMetaEdit {
  const nonEmpty = (xs?: string[]) => (xs?.length ? xs : undefined);
  const patch: SecretMetaEdit = {};
  if (fields.name !== undefined) patch.name = fields.name.trim();
  if (fields.note !== undefined) patch.note = fields.note.trim() || undefined;
  if (fields.env !== undefined) patch.env = nonEmpty(cleanSecretList(fields.env));
  if (fields.sites !== undefined) patch.sites = nonEmpty(cleanSecretSites(fields.sites));
  return patch;
}

/**
 * Why a stored site cannot scope a secret, or null. A public suffix ("com",
 * "co.uk") or a single-label name would cover every site under it, so a
 * saved sign-in on it would be put into the agent browser on all of them.
 */
export function siteProblem(site: string): string | null {
  if (!site.trim() || /\s/.test(site.trim())) return "Sites are hostnames like dashboard.stripe.com, one per entry";
  if (isPublicSuffix(site.replace(/^\.+/, ""))) return `"${site}" names every site under it: name the site itself, like dashboard.stripe.com`;
  return null;
}

/** A site as a sign-in compares it: lowercase, no leading dots or `www.`. */
export const bareSite = (site: string) => site.toLowerCase().replace(/^\.+/, "").replace(/^www\./, "");

/** The host a typed site names: a bare host or any http(s) URL, lowercased, without port or userinfo. Null when there is none. */
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

/**
 * Sites whose login the agent browser keeps for itself rather than borrowing
 * one from a person's Chrome or a saved sign-in. Google rotates its session
 * cookies and revokes a session it sees from two browsers; YouTube carries the
 * same cookies. Matched as the host itself or any subdomain, so
 * `accounts.google.com` and `.google.com` cookie rows count.
 */
export const OWN_LOGIN_HOSTS: readonly string[] = ["google.com", "youtube.com"];

/** Does the agent browser keep its own login for this host (OWN_LOGIN_HOSTS)? Such a site is never saved as a sign-in. */
export function keepsOwnLogin(host: string): boolean {
  const h = host.replace(/^\.+/, "").toLowerCase();
  return OWN_LOGIN_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
}

/** The sites that scope a sign-in, bare. A public suffix the backend no longer accepts ("com") scopes nothing, on a row saved before it refused them. */
export const signinScopeSites = (sites: readonly string[]) => sites.map(bareSite).filter((b) => !siteProblem(b));

/**
 * Is a cookie on `domain` part of the sign-in for `sites`? Every host key a
 * browser would send to the site (the site and its parents of two labels or
 * more, as the cli's cookieHostKeys walks them) and the site's own subdomains.
 */
export function inSigninScope(domain: string, sites: readonly string[]): boolean {
  const d = domain.toLowerCase().replace(/^\.+/, "");
  return signinScopeSites(sites).some((s) => {
    const parent = d.includes(".") && !/^[\d.]+$/.test(s) && !s.includes(":") && s.endsWith(`.${d}`);
    return d === s || parent || d.endsWith(`.${s}`);
  });
}

/** Is a localStorage key of a sign-in an origin in its scope? */
export function originInSigninScope(origin: string, sites: readonly string[]): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === origin && inSigninScope(u.hostname, sites);
  } catch {
    return false;
  }
}

/**
 * Why a sign-in's value cannot be stored under `sites`, or null: every cookie
 * and every localStorage origin must belong to them. The server checks each
 * write, so a jar captured for one site never carries another's cookies into
 * the Vault. Names no cookie value, only a domain.
 */
export function signinScopeProblem(payload: Pick<SigninPayload, "cookies" | "local_storage">, sites: readonly string[] | undefined): string | null {
  if (!signinScopeSites(sites ?? []).length) return "a sign-in needs the site it is for: add it under Sites first";
  const named = (sites ?? []).join(", ");
  const cookie = payload.cookies.find((c) => !inSigninScope(c.domain, sites!));
  if (cookie) return `a cookie for ${cookie.domain} is not part of the sign-in for ${named}: save only that site's cookies`;
  const origin = Object.keys(payload.local_storage ?? {}).find((o) => !originInSigninScope(o, sites!));
  if (origin !== undefined) return `storage for ${origin} is not part of the sign-in for ${named}: save only that site's storage`;
  return null;
}

/** A name as agents would type it: lowercase, dashes, at most 63 characters. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

/** The site's own name from a host or URL, the label before its public suffix: `https://dashboard.stripe.com/x` -> `stripe`, `bbc.co.uk` -> `bbc`. "" when there is none. */
export function siteName(site: string): string {
  return slugify(siteOf(bareSite(signinSite(site) ?? "")).split(".")[0] ?? "");
}

const SIGNIN_SUFFIX = "-signin";

/** The name a saved sign-in for a site gets unless one is given (`github.com` -> `github-signin`, a site with no name of its own `site-signin`); "" for no site. The web suggests it and `cast vault save-signin` picks it. */
export function signinName(site: string): string {
  if (!site.trim()) return "";
  const base = siteName(site).slice(0, 63 - SIGNIN_SUFFIX.length).replace(/-+$/, "");
  return `${base || "site"}${SIGNIN_SUFFIX}`;
}

/** The fingerprint a row shows for its payload: a key's value; nothing else has one. */
export function payloadFingerprint(kind: SecretKind, payload: SecretPayload): string | undefined {
  return kind === "key" ? fingerprint((payload as KeyPayload).value) : undefined;
}

/** Cookies that ride beside a sign-in without holding it: analytics and ads,
 *  CSRF guards, bot and load-balancer stamps, consent and locale. They outlive
 *  a sign-in or die before it, so they never date one. */
const NOT_SESSION_COOKIE_RE = /^(?:_ga|_gid|_gat|_gcl|__utm|_fbp|_fbc|_hj|_pk_|ajs_|amplitude|mp_|_clck|_clsk|_uetsid|_uetvid|optimizely|intercom-|__hs|hubspot|_tt_|_ttp|_rdt_|_scid|_pin_|__cf|cf_|_cfuvid|awsalb)|csrf|xsrf|consent|locale/i;

/**
 * When a sign-in runs out (ms): the latest expiry among the cookies that hold
 * the session. Those are the httpOnly ones when the jar has any, else every
 * cookie, leaving out the ones that never hold a session. The latest, because
 * a site's short access cookie is reissued from its long refresh cookie: the
 * sign-in lives while either does. Session cookies (no expiry) date nothing; a
 * session held only by them has no known expiry.
 */
export function signinExpiresAt(payload: SigninPayload): number | undefined {
  const held = payload.cookies.filter((c) => !NOT_SESSION_COOKIE_RE.test(c.name));
  const httpOnly = held.filter((c) => c.httpOnly);
  const times = (httpOnly.length ? httpOnly : held).map((c) => c.expires).filter((e): e is number => typeof e === "number" && e > 0);
  return times.length ? Math.max(...times) * 1000 : undefined;
}

// ---------------------------------------------------------------------------
// Env vars
// ---------------------------------------------------------------------------

/** `stripe-test` -> `STRIPE_TEST`; a leading digit gets an underscore. */
export function envBase(name: string): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return /^[0-9]/.test(base) ? `_${base}` : base;
}

export type EnvField = "value" | "username" | "password" | "path";
export type EnvBinding = { var: string; field: EnvField };

/**
 * The env vars a secret injects and which field fills each. A key fills its
 * names (or `STRIPE_TEST` from the name). A login fills `<NAME>_USERNAME` and
 * `<NAME>_PASSWORD`; given names override in that order, one name meaning the
 * password. A file is written to disk and its path fills `<NAME>_FILE` or the
 * given name. A sign-in injects nothing.
 */
export function envFor(secret: { name: string; kind: SecretKind; env?: string[] | null }): EnvBinding[] {
  const env = (secret.env ?? []).filter(Boolean);
  const base = envBase(secret.name);
  switch (secret.kind) {
    case "key":
      return (env.length ? env : [base]).map((v) => ({ var: v, field: "value" as const }));
    case "login":
      if (env.length === 1) return [{ var: env[0], field: "password" }];
      if (env.length >= 2) return [{ var: env[0], field: "username" }, { var: env[1], field: "password" }];
      return [{ var: `${base}_USERNAME`, field: "username" }, { var: `${base}_PASSWORD`, field: "password" }];
    case "file":
      return [{ var: env[0] ?? `${base}_FILE`, field: "path" }];
    default:
      return [];
  }
}

/** How many env names a kind uses (envFor); a key fills every name it is given. */
const ENV_NAMES_USED: Partial<Record<SecretKind, { max: number; problem: string }>> = {
  login: { max: 2, problem: "a login takes at most two env vars: username then password" },
  file: { max: 1, problem: "a file takes one env var, for its path" },
};

/** Why a secret cannot fill the vars it would inject (one named by its env, or derived from its name), or null. */
export function secretEnvProblem(secret: { name: string; kind: SecretKind; env?: string[] | null }): string | null {
  const used = ENV_NAMES_USED[secret.kind];
  if (used && (secret.env ?? []).filter(Boolean).length > used.max) return used.problem;
  for (const b of envFor(secret)) {
    const p = envNameProblem(b.var);
    if (p) return p;
  }
  return null;
}

/**
 * The env assignments for one secret; `filePath` is where the caller wrote a
 * file secret. Throws, naming the var, for a secret stored before
 * envNameProblem refused loader variables.
 */
export function envValues(
  secret: { name: string; kind: SecretKind; env?: string[] | null },
  payload: SecretPayload,
  filePath?: string,
): Record<string, string> {
  const problem = secretEnvProblem(secret);
  if (problem) throw new Error(`${secret.name}: ${problem}. Change it on the Vault page`);
  const out: Record<string, string> = {};
  for (const b of envFor(secret)) {
    const value =
      b.field === "path" ? filePath
      : b.field === "value" ? (payload as KeyPayload).value
      : (payload as LoginPayload)[b.field];
    if (typeof value === "string") out[b.var] = value;
  }
  return out;
}

/** A value long enough to be a token: 16+ characters, not a bare word. */
const longToken = (v: string) => v.length >= 16 && !/^[A-Za-z]+$/.test(v);

/**
 * A sign-in cookie whose value is a credential: an httpOnly one, or a long
 * token. Consent and preference cookies ("granted", "dark_mode") would
 * otherwise become exact-match redaction targets and blank ordinary words out
 * of every transcript.
 */
const holdsSession = (c: SigninCookie) => c.httpOnly || longToken(c.value);

/**
 * A sign-in's localStorage values that may hold its session: a single-page
 * app keeps its token there, often inside a JSON object, so each long value
 * goes in whole and each long string inside one that parses as JSON goes in
 * on its own. Urls (a saved route, an api base) name no secret.
 */
function storagePieces(storage: SigninPayload["local_storage"]): string[] {
  const out: string[] = [];
  const keep = (v: string) => {
    if (longToken(v) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) out.push(v);
  };
  const walk = (x: unknown): void => {
    if (typeof x === "string") keep(x);
    else if (x && typeof x === "object") for (const y of Object.values(x)) walk(y);
  };
  for (const items of Object.values(storage ?? {})) {
    for (const value of Object.values(items)) {
      keep(value);
      if (/^\s*[{[]/.test(value)) {
        try {
          walk(JSON.parse(value));
        } catch {}
      }
    }
  }
  return out;
}

/** A value past SECRET_REDACTION_MAX as consecutive pieces from its start (the last one ending at its end), so printed whole it is redacted piece by piece, and a part of it from any piece boundary on. */
function redactionChunks(v: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + SECRET_REDACTION_CHUNK < v.length; i += SECRET_REDACTION_CHUNK) out.push(v.slice(i, i + SECRET_REDACTION_CHUNK));
  out.push(v.slice(-SECRET_REDACTION_CHUNK));
  return out;
}

/** The values in a payload worth redacting wherever they appear: a key, a
 *  password, a 2FA seed (bare and as its otpauth link), a file whole and in
 *  the pieces a command prints of it (filePieces), a multi-line key in those
 *  pieces too, a sign-in's session cookies (holdsSession) and the storage
 *  that may hold its token (storagePieces). A key or a file piece too long to
 *  match whole goes in as redactionChunks. Usernames and urls are not secret. */
export function redactionValuesOf(kind: SecretKind, payload: SecretPayload): string[] {
  const out: string[] = [];
  const push = (v: string | undefined) => {
    if (v && v.length <= SECRET_REDACTION_MAX) out.push(v);
  };
  const pushLong = (v: string) => {
    if (v.length <= SECRET_REDACTION_MAX) out.push(v);
    else out.push(...redactionChunks(v));
  };
  if (kind === "key") {
    const value = (payload as KeyPayload).value;
    pushLong(value);
    if (value.includes("\n")) for (const piece of filePieces(value)) pushLong(piece);
  } else if (kind === "login") {
    const p = payload as LoginPayload;
    push(p.password);
    if (p.totp_seed) {
      push(totpParams(p.totp_seed)?.secret);
      if (/^otpauth:/i.test(p.totp_seed)) push(p.totp_seed);
    }
  } else if (kind === "file") {
    const content = (payload as FilePayload).content;
    pushLong(content.trim());
    for (const piece of filePieces(content)) pushLong(piece);
  } else {
    const p = payload as SigninPayload;
    for (const c of p.cookies) if (holdsSession(c)) push(c.value);
    for (const piece of storagePieces(p.local_storage)) push(piece);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// .env files
// ---------------------------------------------------------------------------


/** The env vars .env text sets: only names an env var can have, a later line winning, as a shell would. The Vault's import and `run --env-file` both read a file this way. */
export function dotenvVars(text: string): Map<string, string> {
  return new Map(parseDotenv(text).filter(([name]) => ENV_NAME_RE.test(name)));
}

/** How long a line or a JSON string of a file must be to be matched on its own. */
const FILE_PIECE_MIN = 16;
/** A dotenv value is a credential at any length the daemon's floors accept (knownValueRedaction MIN_LENGTH). */
const DOTENV_VALUE_MIN = 8;

/** A YAML `key: value` line (a list item's too). */
const YAML_PAIR_RE = /^\s*(?:-\s+)?([\w.-]+)\s*:\s+(.+)$/;
/** The value after a .netrc `password` or `account` keyword, wherever it sits on the line. */
const NETRC_SECRET_RE = /(?:^|\s)(?:password|account)\s+(\S+)/g;

/**
 * The parts of a file secret a command prints on their own: each dotenv or
 * INI value (`grep KEY .env`), each YAML value that is one token or sits
 * under a credential name (`token: …` in a kubeconfig), each .netrc
 * password, each JSON string value (`jq -r .private_key`) and each line that
 * is one token (a base64 line of a PEM). A value under a credential name
 * counts from SECRET_REDACTION_MIN, any dotenv value from DOTENV_VALUE_MIN,
 * anything else from FILE_PIECE_MIN. PEM armour and urls are the same in
 * every file, so they are left out.
 */
function filePieces(content: string): string[] {
  const out: string[] = [];
  const keep = (raw: string, min = FILE_PIECE_MIN) => {
    const v = raw.trim();
    if (v.length >= min && !/^-----(?:BEGIN|END) [A-Z0-9 ]+-----$/.test(v) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) out.push(v);
  };
  const texts = [content];
  const walk = (x: unknown): void => {
    if (typeof x === "string") {
      keep(x);
      if (x.includes("\n")) texts.push(x);
    } else if (x && typeof x === "object") for (const y of Object.values(x)) walk(y);
  };
  if (/^\s*[{[]/.test(content)) {
    try {
      walk(JSON.parse(content));
    } catch {}
  }
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      const env = parseDotenvLine(line);
      if (env) {
        keep(env[1], isCredentialName(env[0]) ? SECRET_REDACTION_MIN : DOTENV_VALUE_MIN);
        continue;
      }
      const yaml = YAML_PAIR_RE.exec(line);
      if (yaml) {
        const value = yaml[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
        if (isCredentialName(yaml[1]!)) keep(value, SECRET_REDACTION_MIN);
        else if (!/\s/.test(value)) keep(value);
        continue;
      }
      for (const m of line.matchAll(NETRC_SECRET_RE)) keep(m[1]!, SECRET_REDACTION_MIN);
      if (!/\s/.test(line.trim())) keep(line);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238 over RFC 4226 HOTP)
// ---------------------------------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, case-insensitive, spaces, dashes and padding ignored; null on any other character. */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> | null {
  const s = input.toUpperCase().replace(/[\s=-]/g, "");
  if (!s) return null;
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Bytes as base32, the inverse of base32Decode. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";
export type TotpParams = { secret: string; digits: number; period: number; algorithm: TotpAlgorithm; issuer?: string; account?: string };

const ALGORITHMS: Record<string, TotpAlgorithm> = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };

/** A link's label, percent-decoded; a malformed escape leaves it as typed (it only names the account). */
function decodeLabel(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** An `otpauth://totp/Issuer:account?secret=…` link, or null. */
export function parseOtpauth(uri: string): TotpParams | null {
  let u: URL;
  try {
    u = new URL(uri.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "otpauth:" || u.hostname.toLowerCase() !== "totp") return null;
  const secret = (u.searchParams.get("secret") ?? "").toUpperCase().replace(/[\s=-]/g, "");
  if (!secret || !base32Decode(secret)) return null;
  const label = decodeLabel(u.pathname.replace(/^\//, ""));
  const [labelIssuer, account] = label.includes(":") ? label.split(/:([\s\S]*)/, 2).map((s) => s.trim()) : [undefined, label.trim()];
  const digits = Number(u.searchParams.get("digits") ?? 6);
  const period = Number(u.searchParams.get("period") ?? 30);
  const algorithm = ALGORITHMS[(u.searchParams.get("algorithm") ?? "SHA1").toUpperCase()];
  if (!algorithm || !(digits >= 6 && digits <= 8) || !(period > 0)) return null;
  const issuer = u.searchParams.get("issuer") || labelIssuer || undefined;
  return { secret, digits, period, algorithm, ...(issuer ? { issuer } : {}), ...(account ? { account } : {}) };
}

/** A stored seed's parameters: an otpauth link's own, or a bare base32 secret at the defaults (SHA-1, 6 digits, 30 s). */
export function totpParams(seed: string): TotpParams | null {
  const s = seed.trim();
  if (/^otpauth:/i.test(s)) return parseOtpauth(s);
  const secret = s.toUpperCase().replace(/[\s=-]/g, "");
  return base32Decode(secret) ? { secret, digits: 6, period: 30, algorithm: "SHA-1" } : null;
}

/** A seed as stored: an otpauth link kept whole (it carries digits and period), a bare secret compacted. */
export function normalizeTotpSeed(seed: string): string | null {
  const p = totpParams(seed);
  if (!p) return null;
  return /^otpauth:/i.test(seed.trim()) ? seed.trim() : p.secret;
}

async function hotp(key: Uint8Array<ArrayBuffer>, counter: number, digits: number, algorithm: TotpAlgorithm): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: algorithm }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The code for a seed at `atMs`, and how many seconds it stays valid. */
export async function totp(seed: string, atMs: number = Date.now()): Promise<{ code: string; remaining: number; period: number }> {
  const p = totpParams(seed);
  if (!p) throw new Error("this 2FA seed is not a base32 secret or otpauth:// link: store the site's setup key again");
  const key = base32Decode(p.secret)!;
  const step = Math.floor(atMs / 1000 / p.period);
  const code = await hotp(key, step, p.digits, p.algorithm);
  return { code, remaining: p.period - (Math.floor(atMs / 1000) % p.period), period: p.period };
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/** What `list` returns per secret: metadata only, never a value or its ciphertext. */
export type SecretMeta = {
  _id: string;
  short_id: string;
  name: string;
  kind: SecretKind;
  status: SecretStatus;
  workspace: string;
  team_id?: string;
  env?: string[];
  sites?: string[];
  note?: string;
  fingerprint?: string;
  signin_expires_at?: number;
  created_by: string;
  created_by_name?: string;
  created_at: number;
  updated_at: number;
  /** When the current value arrived (a fill, rotate or sign-in write-back); a request's own time until it is filled. */
  value_updated_at?: number;
  rotated_at?: number;
  last_used_at?: number;
  last_used_by_conversation?: string;
  use_count?: number;
  requested_by?: string;
  requested_by_name?: string;
  requested_from_conversation?: string;
  request_why?: string;
  updated_by_name?: string;
  /** A login with a 2FA seed (`cast vault otp` works). */
  has_otp?: boolean;
  /** An agent's read needs a person's approval per session. */
  ask_first?: boolean;
  /** Previous values kept for restore (`versions`). */
  version_count?: number;
};

/** One previous value of a secret, as `versions` lists it: metadata only. */
export type SecretVersionMeta = {
  _id: string;
  rotated_at: number;
  rotated_by_name?: string;
  fingerprint?: string;
  expires_at: number;
};

/** How long rotate keeps the previous value for restore. */
export const SECRET_VERSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a person's Approve for an Ask first secret lets its session read it, at most; the session ending closes it sooner. */
export const SECRET_APPROVAL_TTL_MS = 12 * 60 * 60 * 1000;

/** The two answers of the decision an Ask first read files (category "access"). */
export const APPROVE_FOR_SESSION = "Approve for this session";
export const DENY = "Deny";

/** Whether answering `decision` with option `index` lets its session read an Ask first secret. */
export function approvesSecretRead(decision: { category?: string; options: readonly { label: string }[] }, index: number): boolean {
  return decision.category === "access" && decision.options[index]?.label === APPROVE_FOR_SESSION;
}

/**
 * What a passkey presence grant unlocks (convex/passkeys.ts): one action on
 * one target, once. The target is the secret id for reveal and ask_first_off,
 * the decision id for approve, the passkey id for remove_passkey, and the
 * user's own id for add_passkey.
 */
export const PRESENCE_ACTIONS = ["reveal", "approve", "ask_first_off", "add_passkey", "remove_passkey"] as const;
export type PresenceAction = (typeof PRESENCE_ACTIONS)[number];

/** How long a presence challenge waits for its assertion, and then how long the grant it earns stays usable. */
export const PRESENCE_TTL_MS = 2 * 60 * 1000;

/**
 * How long a passkey set up with nothing to vouch for it (an account's first)
 * waits before it confirms anything. The session that set it up may be an
 * agent holding the person's sign-in, so the person gets that long, told on
 * the phone and on every screen, to remove it with one press.
 */
export const PASSKEY_PROBATION_MS = 24 * 60 * 60 * 1000;

/**
 * A grant is spent by the one who began it. presenceBegin answers a `grant`
 * string beside the challenge id, and the gated call takes it (`grant` on
 * reveal, setAskFirst, resolve, passkeys.remove and registrationBegin;
 * `presence` on a decision answer). It is in no query, no challenge and no
 * /confirm URL, so another caller holding the same sign-in cannot spend a
 * grant the person just earned.
 */
export type PresenceGrant = string;

/** The code every presence gate refuses with, first in its message, so a client knows to run the passkey ceremony and retry. */
export const PRESENCE_REQUIRED = "presence_required";

/** What each action does, as a clause after "to": the refusal and the confirm page both say it. */
export const PRESENCE_PHRASE: Record<PresenceAction, string> = {
  reveal: "reveal an Ask first secret",
  approve: "approve an Ask first read",
  ask_first_off: "turn Ask first off",
  add_passkey: "add another passkey",
  remove_passkey: "remove a passkey",
};

export function presenceRequiredMessage(action: PresenceAction): string {
  return `${PRESENCE_REQUIRED}: confirm with Touch ID or your security key to ${PRESENCE_PHRASE[action]}`;
}

/** Whether an error (thrown, or a returned `{ error }`) is a presence gate's refusal. */
export function isPresenceRequired(err: unknown): boolean {
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : typeof (err as any)?.error === "string" ? (err as any).error : "";
  return text.includes(`${PRESENCE_REQUIRED}:`);
}

/** What a client's gated press answers when the person did not confirm with Touch ID, so nothing was sent. */
export const NOT_CONFIRMED = Symbol("not confirmed");

/** A passkey as its owner's settings list shows it; the public key never leaves the backend. */
export type PasskeyMeta = {
  _id: string;
  name: string;
  created_at: number;
  last_used_at?: number;
  /** Set up with no grant, it confirms nothing until then (PASSKEY_PROBATION_MS). */
  probation_until?: number;
};

/** Whether a passkey is still waiting out its probation. */
export const inProbation = (p: { probation_until?: number }, now = Date.now()): boolean => (p.probation_until ?? 0) > now;

/**
 * Whether removing a passkey needs no Touch ID: one set up with no grant
 * while it waits out its probation, has never confirmed anything, or is the
 * only one. Otherwise a key an agent set up first would be the only thing
 * that could assert its own removal. `count` is how many passkeys the person has.
 */
export const removableUnasked = (p: { probation_until?: number; last_used_at?: number }, count: number, now = Date.now()): boolean =>
  p.probation_until !== undefined && (inProbation(p, now) || !p.last_used_at || count === 1);

/** What the waiting client and the /confirm page read about one presence challenge. */
export type PresenceChallengeState = {
  status: "pending" | "granted" | "used" | "expired";
  action: PresenceAction;
  /** What is being confirmed, in a few words: the secret's name (and for approve, the session's), the passkey's name. Absent once settled unless the owner asks. */
  label?: string;
  expires_at: number;
};

/** What `cliRead` answers for an Ask first secret this session has no approval for. */
export type SecretNeedsApproval = {
  needs_approval: { decision: string; secret: string };
  /** Every gated secret of the read, when it named more than one. */
  approvals: { decision: string; secret: string }[];
  message: string;
};

/**
 * What `refresh` answers when the value changed since this machine read it.
 * `value_updated_at` is the value's own version (cliRead, rotate, fill and
 * refresh return it): a metadata edit leaves it alone.
 */
export type SecretStaleWrite = { stale: true; value_updated_at: number; message: string };

/**
 * The row a name means among rows of several workspaces, the one rule the
 * backend (findSecret) and the CLI's planners share: the preferred
 * workspace's row (the repo profile's), else the only row with that status
 * when `status` is given, else the only row. A name in more than one
 * workspace with nothing to settle it is ambiguous, never a silent pick.
 */
export function pickSecretByName<T extends Pick<SecretMeta, "name" | "workspace" | "status">>(
  rows: readonly T[],
  name: string,
  opts: { prefer?: string; status?: SecretStatus } = {},
): T | { ambiguous: T[] } | null {
  let found = rows.filter((r) => r.name === name);
  const preferred = opts.prefer ? found.find((r) => r.workspace === opts.prefer) : undefined;
  if (preferred) return preferred;
  if (opts.status && found.length > 1 && found.some((r) => r.status === opts.status)) found = found.filter((r) => r.status === opts.status);
  if (found.length > 1) return { ambiguous: found };
  return found[0] ?? null;
}

/**
 * The refusal for a name held in several workspaces: each row's short id and
 * scope, so the next command names one. A [vault] line and a vault://
 * reference name a secret only by name (`byNameOnly`), so there the fix is a
 * rename.
 */
export function ambiguousSecretName(name: string, rows: readonly Pick<SecretMeta, "short_id" | "workspace">[], opts: { byNameOnly?: boolean } = {}): string {
  const each = rows.map((r) => `${r.short_id} ${r.workspace.startsWith("team:") ? "team" : "personal"}`).join(", ");
  const fix = opts.byNameOnly ? "rename one of them (cast vault ls shows both), since this names a secret only by name" : `name the one you mean by its short id, like ${rows[0].short_id}`;
  return `${name} is in ${rows.length} workspaces (${each}): ${fix}`;
}

/** What a read or a rotate of a request with no value yet says: the agent's next step, the same from every verb. */
export function pendingRequestLine(row: Pick<SecretMeta, "short_id">): string {
  return `${row.short_id} is a request with no value yet: end the turn dormant on it; a person fills it on the Vault page`;
}

/** What about a ready secret needs a look, most urgent first. */
export type SecretHealth = "expired" | "expiring" | "stale" | "unused";

export const DAY_MS = 86_400_000;

/** secretHealth's thresholds in days: a sign-in this close to its expiry, a secret unread this long after its value arrived, and one last read longer ago than this. */
export const SECRET_HEALTH_DAYS = { expiring: 3, unused: 1, stale: 90 } as const;

/** A sign-in that has not expired yet but will within SECRET_HEALTH_DAYS.expiring. */
export const isExpiring = (exp: number, now: number) => exp > now && exp - now < SECRET_HEALTH_DAYS.expiring * DAY_MS;

/** The order every Vault list shows: open requests first, then by name. */
export const compareSecrets = (a: Pick<SecretMeta, "status" | "name">, b: Pick<SecretMeta, "status" | "name">) =>
  a.status === b.status ? a.name.localeCompare(b.name) : a.status === "requested" ? -1 : 1;

/**
 * A ready secret's health from its metadata alone: a sign-in past or within
 * 3 days of its expiry, a secret no agent read in a day since its value
 * arrived (a request counts from its fill, not from the ask), or one last
 * read over 90 days ago. A sign-in is never stale: a browser still signed in
 * with it uses it without a read, so its last read dates nothing (its first
 * use is always a read, so "never used" holds). Null when nothing needs a
 * look, and for requests, which have a section of their own. The web list
 * and detail and `cast vault ls|show` all say it this way.
 */
export function secretHealth(
  row: Pick<SecretMeta, "kind" | "status" | "signin_expires_at" | "use_count" | "created_at" | "value_updated_at" | "last_used_at">,
  now: number,
): SecretHealth | null {
  if (row.status !== "ready") return null;
  const exp = row.signin_expires_at;
  if (exp !== undefined && exp <= now) return "expired";
  if (exp !== undefined && isExpiring(exp, now)) return "expiring";
  if (!row.use_count && now - (row.value_updated_at ?? row.created_at) > SECRET_HEALTH_DAYS.unused * DAY_MS) return "unused";
  if (row.kind !== "signin" && row.last_used_at !== undefined && now - row.last_used_at > SECRET_HEALTH_DAYS.stale * DAY_MS) return "stale";
  return null;
}
