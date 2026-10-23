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

/** A secret's name: what agents type, so a lowercase slug (`stripe-test`). */
export const SECRET_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The whole payload as JSON, in UTF-8 bytes. A signin's cookie jar is the large case. */
export const SECRET_PAYLOAD_MAX = 512_000;
/** The daemon exact-matches values up to this length (knownValueRedaction
 *  MAX_LENGTH); a longer file is a document, not a token worth matching. */
export const SECRET_REDACTION_MAX = 8192;

/** A ref the backend reads as an id before a name: a short id (`sec-4`) or a Convex id (32 lowercase letters and digits, entities isConvexId). */
const ID_SHAPED_RE = /^(?:sec-\d+|[a-z0-9]{32})$/;

export function secretNameProblem(name: string): string | null {
  if (!SECRET_NAME_RE.test(name)) return `"${name}" is not a secret name: use 1 to 63 lowercase letters, digits and dashes, like stripe-test`;
  if (ID_SHAPED_RE.test(name)) return `"${name}" reads as a secret's id, so it would never be found by name: pick a name that says what it is, like stripe-test`;
  return null;
}

// Env vars that make a shell, a loader or an interpreter run code, or read its
// config, from wherever the value points. A team secret fills its teammates'
// process env (`vault run`, `vault env`, `cast dev`), so it never names one.
const LOADER_ENV = new Set([
  "PATH", "IFS", "ENV", "BASH_ENV", "SHELL", "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND", "CDPATH", "GLOBIGNORE",
  "HOME", "ZDOTDIR", "XDG_CONFIG_HOME",
  "NODE_OPTIONS", "NODE_PATH", "RUBYOPT", "RUBYLIB", "GEM_HOME", "GEM_PATH", "PERLLIB", "CLASSPATH",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "PHPRC", "PHP_INI_SCAN_DIR", "LUA_INIT", "LUA_PATH", "LUA_CPATH", "TCLLIBPATH",
  "GCONV_PATH", "HOSTALIASES", "LOCPATH", "NLSPATH", "OPENSSL_CONF", "OPENSSL_ENGINES",
  "EDITOR", "VISUAL", "PAGER", "MANPAGER", "LESSOPEN", "LESSCLOSE", "BROWSER", "SSH_ASKPASS", "SUDO_ASKPASS",
  "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER", "GIT_EXTERNAL_DIFF", "GIT_PROXY_COMMAND", "GIT_DIR", "GIT_WORK_TREE",
]);
const LOADER_ENV_PREFIX = /^(?:LD_|DYLD_|PYTHON|PERL5|BASH_FUNC_|GIT_CONFIG|NPM_CONFIG_|LUA_INIT_)/;

export function envNameProblem(name: string): string | null {
  if (!ENV_NAME_RE.test(name)) return `"${name}" is not an env var name: use letters, digits and underscores, starting with a letter, like STRIPE_SECRET_KEY`;
  const upper = name.toUpperCase();
  if (LOADER_ENV.has(upper) || LOADER_ENV_PREFIX.test(upper)) {
    return `${name} tells a shell or an interpreter what code to load, so a secret cannot set it: give the secret a variable of its own, like STRIPE_SECRET_KEY`;
  }
  return null;
}

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
  const host = site.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/:?#].*$/, "").replace(/^www\./, "");
  return slugify(siteOf(host).split(".")[0] ?? "");
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

/** Analytics and ad cookies: they outlive any sign-in on the same site, so they never date one. */
const TRACKING_COOKIE_RE = /^(?:_ga|_gid|_gat|_gcl|__utm|_fbp|_fbc|_hj|_pk_|ajs_|amplitude|mp_|_clck|_clsk|_uetsid|_uetvid|optimizely|intercom-|__hs|hubspot|_tt_|_ttp|_rdt_|_scid|_pin_)/i;

/**
 * When a sign-in runs out (ms): the earliest expiry among the cookies that
 * hold the session. Those are the httpOnly ones when the jar has any, else
 * every cookie that is not a tracker, since one dead auth cookie ends the
 * sign-in however long a site's other cookies live. Session cookies (no
 * expiry) date nothing; a session held only by them has no known expiry.
 */
export function signinExpiresAt(payload: SigninPayload): number | undefined {
  const httpOnly = payload.cookies.filter((c) => c.httpOnly);
  const session = httpOnly.length ? httpOnly : payload.cookies.filter((c) => !TRACKING_COOKIE_RE.test(c.name));
  const times = session.map((c) => c.expires).filter((e): e is number => typeof e === "number" && e > 0);
  return times.length ? Math.min(...times) * 1000 : undefined;
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

/** Why a secret cannot fill the vars it would inject (one named by its env, or derived from its name), or null. */
export function secretEnvProblem(secret: { name: string; kind: SecretKind; env?: string[] | null }): string | null {
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

/**
 * A sign-in cookie whose value is a credential: an httpOnly one, or a long
 * token (16+ characters, not a bare word). Consent and preference cookies
 * ("granted", "dark_mode") would otherwise become exact-match redaction
 * targets and blank ordinary words out of every transcript.
 */
const holdsSession = (c: SigninCookie) => c.httpOnly || (c.value.length >= 16 && !/^[A-Za-z]+$/.test(c.value));

/** The values in a payload worth redacting wherever they appear: a key, a
 *  password, a 2FA seed (bare and as its otpauth link), a file whole and in
 *  the pieces a command prints of it (filePieces), a sign-in's session
 *  cookies (holdsSession). Usernames and urls are not secret. */
export function redactionValuesOf(kind: SecretKind, payload: SecretPayload): string[] {
  const out: string[] = [];
  const push = (v: string | undefined) => {
    if (v && v.length <= SECRET_REDACTION_MAX) out.push(v);
  };
  if (kind === "key") push((payload as KeyPayload).value);
  else if (kind === "login") {
    const p = payload as LoginPayload;
    push(p.password);
    if (p.totp_seed) {
      push(totpParams(p.totp_seed)?.secret);
      if (/^otpauth:/i.test(p.totp_seed)) push(p.totp_seed);
    }
  } else if (kind === "file") {
    const content = (payload as FilePayload).content;
    push(content.trim());
    for (const piece of filePieces(content)) push(piece);
  } else for (const c of (payload as SigninPayload).cookies) if (holdsSession(c)) push(c.value);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// .env files
// ---------------------------------------------------------------------------

const DOTENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/;
const DOTENV_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

/**
 * One .env line's name and value, or null when it is not an assignment
 * (`KEY=value`, `export KEY=value`). Inside double quotes `\n`, `\r`, `\t`,
 * `\"` and `\\` are escapes; single quotes and backticks keep everything
 * literal; an unquoted value (or one whose quote never closes) ends at ` #`
 * and is trimmed. Names may carry `.` and `-`, which no env var can:
 * dotenvVars leaves those out.
 */
export function parseDotenvLine(line: string): [string, string] | null {
  const m = DOTENV_LINE_RE.exec(line);
  if (!m) return null;
  const name = m[1]!;
  const raw = m[2]!.trim();
  const q = raw[0];
  if (q === '"') {
    let out = "";
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i]!;
      if (c === '"') return [name, out];
      if (c === "\\" && i + 1 < raw.length) {
        const next = raw[++i]!;
        out += DOTENV_ESCAPES[next] ?? `\\${next}`;
      } else out += c;
    }
  } else if (q === "'" || q === "`") {
    const end = raw.indexOf(q, 1);
    if (end > 0) return [name, raw.slice(1, end)];
  }
  return [name, raw.replace(/\s+#.*$/, "").trim()];
}

/** Every assignment in .env text, in order; a name given twice is kept twice. The daemon's redaction reads every one. */
export function parseDotenv(text: string): Array<[string, string]> {
  return text.split(/\r?\n/).flatMap((line) => {
    const pair = parseDotenvLine(line);
    return pair ? [pair] : [];
  });
}

/** The env vars .env text sets: only names an env var can have, a later line winning, as a shell would. The Vault's import and `run --env-file` both read a file this way. */
export function dotenvVars(text: string): Map<string, string> {
  return new Map(parseDotenv(text).filter(([name]) => ENV_NAME_RE.test(name)));
}

/** How long a line or a JSON string of a file must be to be matched on its own. */
const FILE_PIECE_MIN = 16;
/** A dotenv value is a credential at any length the daemon's floors accept (knownValueRedaction MIN_LENGTH). */
const DOTENV_VALUE_MIN = 8;

/**
 * The parts of a file secret a command prints on their own: each dotenv
 * value (`grep KEY .env`), each JSON string value (`jq -r .private_key`) and
 * each line that is one token (a base64 line of a PEM). PEM armour and urls
 * are the same in every file, so they are left out.
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
      if (env) keep(env[1], DOTENV_VALUE_MIN);
      else if (!/\s/.test(line.trim())) keep(line);
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

/** The refusal for a name held in several workspaces: each row's short id and scope, so the next command names one. */
export function ambiguousSecretName(name: string, rows: readonly Pick<SecretMeta, "short_id" | "workspace">[]): string {
  const each = rows.map((r) => `${r.short_id} ${r.workspace.startsWith("team:") ? "team" : "personal"}`).join(", ");
  return `${name} is in ${rows.length} workspaces (${each}): name the one you mean by its short id, like ${rows[0].short_id}`;
}

/** What about a ready secret needs a look, most urgent first. */
export type SecretHealth = "expired" | "expiring" | "stale" | "unused";

const DAY_MS = 86_400_000;

/** secretHealth's thresholds in days: a sign-in this close to its expiry, a secret unread this long after its value arrived, and one last read longer ago than this. */
export const SECRET_HEALTH_DAYS = { expiring: 3, unused: 1, stale: 90 } as const;

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
  if (exp !== undefined && exp - now < SECRET_HEALTH_DAYS.expiring * DAY_MS) return "expiring";
  if (!row.use_count && now - (row.value_updated_at ?? row.created_at) > SECRET_HEALTH_DAYS.unused * DAY_MS) return "unused";
  if (row.kind !== "signin" && row.last_used_at !== undefined && now - row.last_used_at > SECRET_HEALTH_DAYS.stale * DAY_MS) return "stale";
  return null;
}
