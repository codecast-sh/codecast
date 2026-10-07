// Visitors are anonymous: an id plus a secret the browser keeps in
// localStorage. Only the secret's hash is stored, and every public function
// proves the caller with it, so a visitor id alone (which appears on every
// message and presence row) grants nothing.

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export const SECRET_LENGTH = 32; // ~190 bits

/** A uniformly random string over `alphabet`. Rejection sampling keeps every
 *  character equally likely whatever the alphabet's length. */
export function randomToken(length: number, alphabet = TOKEN_ALPHABET): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

export function newSecret(): string {
  return randomToken(SECRET_LENGTH);
}

/** SHA-256 as lowercase hex; strings hash as UTF-8. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Shape first, so junk never reaches the hash. */
export function isSecretShaped(secret: unknown): secret is string {
  return typeof secret === "string" && secret.length === SECRET_LENGTH && /^[A-Za-z0-9]+$/.test(secret);
}

export async function secretMatches(secretHash: string, secret: unknown): Promise<boolean> {
  return isSecretShaped(secret) && (await sha256Hex(secret)) === secretHash;
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** How long a runtime token is good for. The shell hands each frame a fresh
 *  one well before its token runs out (RUNTIME_TOKEN_RENEW_MS). */
export const RUNTIME_TOKEN_TTL_MS = 30 * 60_000;
export const RUNTIME_TOKEN_RENEW_MS = 10 * 60_000;

/** The credential an app's SDK holds instead of the visitor secret. App code
 *  is written by strangers and can read anything the SDK has, and the
 *  runtime lets it reach any site, so the token is made to be worth little
 *  once it leaves: it proves "this visitor, in this app, for the version on
 *  their screen, until `expires`" and nothing more. It opens that app's data
 *  and presence state, never the room, the character or another app, and it
 *  dies within RUNTIME_TOKEN_TTL_MS of the person leaving that version.
 *  Keyed by the secret's hash, which never leaves the server and the
 *  visitor's own browser, so the shell mints it without a round trip and
 *  the server checks it without storing anything.
 *
 *  A "watch" token is the same proof for looking only: the home page's live
 *  previews run apps the visitor never opened, so the app reads its data but
 *  cannot write in their name. Shaped "<version>.<expires>.<mac>", with a
 *  leading "w" for watching. */
export type TokenScope = "use" | "watch";

export async function runtimeToken(secretHash: string, appId: string, version: number, expires: number, scope: TokenScope = "use"): Promise<string> {
  const domain = scope === "watch" ? "watch" : "runtime";
  return `${scope === "watch" ? "w" : ""}${version}.${expires}.${await hmacSha256Hex(secretHash, `${domain}:${appId}:${version}:${expires}`)}`;
}

/** The shell's side: a fresh runtime token for a secret it holds. */
export async function runtimeTokenForSecret(secret: string, appId: string, version: number, now = Date.now(), scope: TokenScope = "use"): Promise<string> {
  return runtimeToken(await sha256Hex(secret), appId, version, now + RUNTIME_TOKEN_TTL_MS, scope);
}

/** What a live runtime token for this visitor and app allows, or null. */
export async function runtimeTokenScope(secretHash: string, appId: string, token: string, now: number): Promise<TokenScope | null> {
  const m = /^(w?)(\d{1,6})\.(\d{13})\.[0-9a-f]{64}$/.exec(token);
  if (!m) return null;
  const expires = Number(m[3]);
  if (expires <= now || expires > now + RUNTIME_TOKEN_TTL_MS) return null;
  const scope: TokenScope = m[1] ? "watch" : "use";
  return sameToken(await runtimeToken(secretHash, appId, Number(m[2]), expires, scope), token) ? scope : null;
}

/** Constant-time string comparison, for comparing tokens. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
