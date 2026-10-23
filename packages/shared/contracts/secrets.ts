// Vault (docs/architecture/vault.md): what a secret is, the rules its name,
// env vars and payload follow, and the pieces every surface computes the same
// way: the fingerprint a person tells keys apart by, the env vars a secret
// injects, the values the daemon redacts, and the 2FA code a login's seed
// gives. Convex validates with these, the CLI injects with them, the web
// draws a live code with them, so the three cannot disagree.
//
// Pure and isomorphic: TOTP uses Web Crypto (crypto.subtle), present in
// Convex, Node/Bun and the browser.

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
  "restored",
  "redaction_sync",
] as const;
export type SecretEventKind = (typeof SECRET_EVENT_KINDS)[number];

/** A secret's name: what agents type, so a lowercase slug (`stripe-test`). */
export const SECRET_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The whole payload as JSON. A signin's cookie jar is the large case. */
export const SECRET_PAYLOAD_MAX = 512_000;
/** The daemon exact-matches values up to this length (knownValueRedaction
 *  MAX_LENGTH); a longer file is a document, not a token worth matching. */
export const SECRET_REDACTION_MAX = 8192;

export function secretNameProblem(name: string): string | null {
  if (SECRET_NAME_RE.test(name)) return null;
  return `"${name}" is not a secret name: use 1 to 63 lowercase letters, digits and dashes, like stripe-test`;
}

export function envNameProblem(name: string): string | null {
  if (ENV_NAME_RE.test(name)) return null;
  return `"${name}" is not an env var name: use letters, digits and underscores, starting with a letter, like STRIPE_SECRET_KEY`;
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
      cookies: raw.cookies as SigninCookie[],
      captured_from: raw.captured_from,
      ...(raw.local_storage ? { local_storage: raw.local_storage as Record<string, Record<string, string>> } : {}),
      ...(typeof raw.account_hint === "string" && raw.account_hint ? { account_hint: raw.account_hint } : {}),
    };
  }
  if (JSON.stringify(payload).length > SECRET_PAYLOAD_MAX) return { error: `a secret holds at most ${SECRET_PAYLOAD_MAX / 1000} KB: store the file somewhere else and keep its key here` };
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

/** The fingerprint a row shows for its payload: a key's value; nothing else has one. */
export function payloadFingerprint(kind: SecretKind, payload: SecretPayload): string | undefined {
  return kind === "key" ? fingerprint((payload as KeyPayload).value) : undefined;
}

/** The latest cookie expiry of a sign-in (ms), so the row says when it runs out. Session cookies (no expiry) don't count. */
export function signinExpiresAt(payload: SigninPayload): number | undefined {
  const times = payload.cookies.map((c) => c.expires).filter((e): e is number => typeof e === "number" && e > 0);
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

/** The env assignments for one secret; `filePath` is where the caller wrote a file secret. */
export function envValues(
  secret: { name: string; kind: SecretKind; env?: string[] | null },
  payload: SecretPayload,
  filePath?: string,
): Record<string, string> {
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

/** The values in a payload worth redacting wherever they appear: a key, a
 *  password, a 2FA seed, a file short enough to match whole, a sign-in's
 *  cookie values. Usernames and urls are not secret. */
export function redactionValuesOf(kind: SecretKind, payload: SecretPayload): string[] {
  const out: string[] = [];
  const push = (v: string | undefined) => {
    if (v && v.length <= SECRET_REDACTION_MAX) out.push(v);
  };
  if (kind === "key") push((payload as KeyPayload).value);
  else if (kind === "login") {
    const p = payload as LoginPayload;
    push(p.password);
    push(p.totp_seed ? (totpParams(p.totp_seed)?.secret ?? undefined) : undefined);
  } else if (kind === "file") push((payload as FilePayload).content.trim());
  else for (const c of (payload as SigninPayload).cookies) push(c.value);
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
  const label = decodeURIComponent(u.pathname.replace(/^\//, ""));
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

/** What `cliRead` answers for an Ask first secret this session has no approval for. */
export type SecretNeedsApproval = {
  needs_approval: { decision: string; secret: string };
  /** Every gated secret of the read, when it named more than one. */
  approvals: { decision: string; secret: string }[];
  message: string;
};

/** What `refresh` answers when the row changed since this machine read it. */
export type SecretStaleWrite = { stale: true; updated_at: number; message: string };

/** What about a ready secret needs a look, most urgent first. */
export type SecretHealth = "expired" | "expiring" | "stale" | "unused";

const DAY_MS = 86_400_000;

/**
 * A ready secret's health from its metadata alone: a sign-in past or within
 * 3 days of its expiry, a secret no agent read in a day since it was added,
 * or one last read over 90 days ago. Null when nothing needs a look, and for
 * requests, which have a section of their own. The web list and detail and
 * `cast vault ls|show` all say it this way.
 */
export function secretHealth(
  row: Pick<SecretMeta, "status" | "signin_expires_at" | "use_count" | "created_at" | "last_used_at">,
  now: number,
): SecretHealth | null {
  if (row.status !== "ready") return null;
  const exp = row.signin_expires_at;
  if (exp !== undefined && exp <= now) return "expired";
  if (exp !== undefined && exp - now < 3 * DAY_MS) return "expiring";
  if (!row.use_count && now - row.created_at > DAY_MS) return "unused";
  if (row.last_used_at !== undefined && now - row.last_used_at > 90 * DAY_MS) return "stale";
  return null;
}
