// Codecast-signed requests (docs/architecture/external-data.md X8, "Signed
// requests"). Codecast signs every request it makes to a product's app
// connector (the manifest, a reader, an action, a watch poll) with one
// Ed25519 key, and publishes the public half at
// <codecast site>/.well-known/codecast-keys.json. A product verifies the
// signature against that key set and needs no shared secret at all: nothing
// to paste into codecast, nothing to set in its own deployment.
//
// This module is the one statement of the scheme: the headers, the canonical
// string, signing and verifying. Codecast signs with it (convex/lib/
// codecastSigning.ts) and the verifiers are checked against it: the copy in
// @platform/analytics/codecast-verify and Union's inline copy are drift
// tested against the vectors below (codecastSignature.drift.test.ts).
//
// The canonical string is seven lines joined by "\n", in this order:
//
//   codecast-signature-v1
//   <METHOD, uppercase>
//   <path and query exactly as requested, e.g. /api/codecast/jobs?limit=5>
//   <lowercase hex sha256 of the body bytes; of the empty string when there is no body>
//   <Codecast-Timestamp: unix seconds, decimal>
//   <Codecast-Source: the source's short id, src-N>
//   <Codecast-Workspace: the source's workspace key, team:<id> or user:<id>>
//   <Codecast-Nonce: 16 random bytes, base64url>
//
// Codecast-Signature is the base64url (no padding) Ed25519 signature of that
// string's UTF-8 bytes, under the key Codecast-Key-Id names.
//
// Pure: WebCrypto only (crypto.subtle Ed25519, present in Convex's runtime,
// Bun, Node 20+ and current browsers), no node or convex imports.

export const SIGNATURE_SCHEME = "codecast-signature-v1";

export const SIGNATURE_HEADERS = {
  signature: "Codecast-Signature",
  keyId: "Codecast-Key-Id",
  timestamp: "Codecast-Timestamp",
  source: "Codecast-Source",
  workspace: "Codecast-Workspace",
  nonce: "Codecast-Nonce",
} as const;

/** Where codecast publishes its public keys, under its Convex site origin. */
export const CODECAST_KEYS_PATH = "/.well-known/codecast-keys.json";

/** A request is accepted this far either side of the verifier's clock, and a nonce is remembered this long. */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;

/** The deployment env var holding codecast's signing key(s), on codecast's side only. */
export const CODECAST_SIGNING_KEY_ENV = "CODECAST_SIGNING_KEY";

export interface CanonicalParts {
  method: string;
  /** Path and query as requested: `/a/b?x=1`. */
  pathAndQuery: string;
  /** Lowercase hex sha256 of the body bytes. */
  bodySha256: string;
  /** Unix seconds, decimal. */
  timestamp: string;
  source: string;
  workspace: string;
  nonce: string;
}

/** The exact bytes that are signed, as a string (module comment). */
export function canonicalSignatureString(p: CanonicalParts): string {
  return [SIGNATURE_SCHEME, p.method.toUpperCase(), p.pathAndQuery, p.bodySha256, p.timestamp, p.source, p.workspace, p.nonce].join("\n");
}

/** The path and query of a URL as a server sees it in its request line. */
export function pathAndQueryOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

type Bytes = Uint8Array<ArrayBuffer>;

function utf8(text: string): Bytes {
  return new TextEncoder().encode(text) as Bytes;
}

function bodyBytes(body: string | Uint8Array | undefined | null): Bytes {
  if (body === undefined || body === null) return new Uint8Array(0);
  return typeof body === "string" ? utf8(body) : (new Uint8Array(body) as Bytes);
}

/** Lowercase hex sha256 of a body (the empty body when absent). */
export async function bodySha256Hex(body: string | Uint8Array | undefined | null): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bodyBytes(body));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out as Bytes;
  } catch {
    return null;
  }
}

// ── Keys ──

/** An Ed25519 key as a JWK. `d` is the private half; a published key never carries it. */
export interface CodecastJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  d?: string;
  kid: string;
  alg?: "EdDSA";
  use?: "sig";
}

export interface CodecastJwks {
  keys: CodecastJwk[];
}

const ED25519 = { name: "Ed25519" } as const;
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isEd25519Jwk(value: unknown): value is CodecastJwk {
  const k = value as Partial<CodecastJwk> | null;
  return !!k && typeof k === "object" && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string" && typeof k.kid === "string" && KID_RE.test(k.kid);
}

/**
 * The signing keys an env value holds: one private JWK, or a JSON array of
 * them. The first signs; every one is published. Rotating is: put the new
 * key first (verifiers refetch the key set when a request names a kid they
 * have not seen), then drop the old one once its last requests are past the
 * 5 minute window. Throws with what is wrong, never with key material.
 */
export function parseSigningKeys(raw: string): CodecastJwk[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CODECAST_SIGNING_KEY_ENV} is not JSON: it holds a private Ed25519 JWK or an array of them`);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (!list.length) throw new Error(`${CODECAST_SIGNING_KEY_ENV} holds no key`);
  const kids = new Set<string>();
  return list.map((k, i) => {
    if (!isEd25519Jwk(k) || typeof k.d !== "string") throw new Error(`${CODECAST_SIGNING_KEY_ENV}[${i}] is not a private Ed25519 JWK with a kid`);
    if (kids.has(k.kid)) throw new Error(`${CODECAST_SIGNING_KEY_ENV}: kid ${k.kid} appears twice`);
    kids.add(k.kid);
    return { kty: "OKP", crv: "Ed25519", x: k.x, d: k.d, kid: k.kid };
  });
}

/** The public key set to publish: every key, without its private half. */
export function publicJwks(keys: readonly CodecastJwk[]): CodecastJwks {
  return { keys: keys.map((k) => ({ kty: "OKP", crv: "Ed25519", x: k.x, kid: k.kid, alg: "EdDSA", use: "sig" })) };
}

/** The keys in a fetched JWKS document that this scheme can use. */
export function jwksKeys(doc: unknown): CodecastJwk[] {
  const keys = (doc as Partial<CodecastJwks> | null)?.keys;
  return Array.isArray(keys) ? keys.filter(isEd25519Jwk).map((k) => ({ kty: "OKP", crv: "Ed25519", x: k.x, kid: k.kid })) : [];
}

/** A new private signing key (for `CODECAST_SIGNING_KEY`). The kid defaults to the date it was made. */
export async function generateSigningKey(kid = `ck-${new Date().toISOString().slice(0, 10)}`): Promise<CodecastJwk> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { kty: "OKP", crv: "Ed25519", x: jwk.x!, d: jwk.d!, kid };
}

// Imported keys by kid and key bytes: a process signs or verifies many times with one key.
const imported = new Map<string, Promise<CryptoKey>>();

function importKey(k: CodecastJwk, use: "sign" | "verify"): Promise<CryptoKey> {
  const id = `${use}:${k.kid}:${k.x}`;
  let key = imported.get(id);
  if (!key) {
    const jwk: JsonWebKey = { kty: "OKP", crv: "Ed25519", x: k.x, ...(use === "sign" ? { d: k.d } : {}) };
    key = crypto.subtle.importKey("jwk", jwk, ED25519, false, [use]);
    // A key that will not import must not stay cached as a rejection.
    key.catch(() => imported.delete(id));
    imported.set(id, key);
  }
  return key;
}

// ── Signing ──

export interface SignInput {
  method: string;
  url: string;
  body?: string;
  source: string;
  workspace: string;
}

export function newNonce(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/** The signature headers for one request, under `key` (a private JWK). */
export async function signCodecastRequest(
  req: SignInput,
  key: CodecastJwk,
  opts: { now?: number; nonce?: string } = {},
): Promise<Record<string, string>> {
  if (!key.d) throw new Error("signing needs a private key");
  const parts: CanonicalParts = {
    method: req.method,
    pathAndQuery: pathAndQueryOf(req.url),
    bodySha256: await bodySha256Hex(req.body),
    timestamp: String(Math.floor((opts.now ?? Date.now()) / 1000)),
    source: req.source,
    workspace: req.workspace,
    nonce: opts.nonce ?? newNonce(),
  };
  const signature = await crypto.subtle.sign(ED25519, await importKey(key, "sign"), utf8(canonicalSignatureString(parts)));
  return {
    [SIGNATURE_HEADERS.signature]: base64urlEncode(new Uint8Array(signature)),
    [SIGNATURE_HEADERS.keyId]: key.kid,
    [SIGNATURE_HEADERS.timestamp]: parts.timestamp,
    [SIGNATURE_HEADERS.source]: parts.source,
    [SIGNATURE_HEADERS.workspace]: parts.workspace,
    [SIGNATURE_HEADERS.nonce]: parts.nonce,
  };
}

// ── Verifying ──

/** A source the verifying app belongs to, from its codecast.json. */
export interface ExpectedSource {
  id: string;
  workspace: string;
}

export interface VerifyInput {
  method: string;
  pathAndQuery: string;
  body?: string | Uint8Array | null;
  /** Header lookup, case-insensitive as HTTP is. */
  header: (name: string) => string | null | undefined;
  /** Public keys (a fetched JWKS's keys). */
  keys: readonly CodecastJwk[];
  /** The sources this app accepts calls for: Codecast-Source and Codecast-Workspace must match one. */
  sources: readonly ExpectedSource[];
  now?: number;
  /**
   * Remember a nonce until `expiresAt`; answer true when it was already seen
   * (a replay). Omit it only where replays are harmless.
   */
  seenNonce?: (nonce: string, expiresAt: number) => boolean;
}

export type VerifyResult = { ok: true; kid: string; source: string; workspace: string } | { ok: false; error: string; unknownKid?: string };

/** Whether a request was signed by codecast for one of this app's sources. */
export async function verifyCodecastRequest(input: VerifyInput): Promise<VerifyResult> {
  const h = (name: string) => input.header(name)?.trim() ?? "";
  const signature = h(SIGNATURE_HEADERS.signature);
  const kid = h(SIGNATURE_HEADERS.keyId);
  const timestamp = h(SIGNATURE_HEADERS.timestamp);
  const source = h(SIGNATURE_HEADERS.source);
  const workspace = h(SIGNATURE_HEADERS.workspace);
  const nonce = h(SIGNATURE_HEADERS.nonce);
  if (!signature || !kid || !timestamp || !source || !workspace || !nonce) return { ok: false, error: "not a codecast-signed request: a signature header is missing" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, error: "bad Codecast-Timestamp" };
  const now = input.now ?? Date.now();
  const at = Number(timestamp) * 1000;
  if (Math.abs(now - at) > SIGNATURE_WINDOW_MS) return { ok: false, error: "Codecast-Timestamp is outside the 5 minute window" };
  if (!input.sources.some((s) => s.id === source && s.workspace === workspace)) {
    return { ok: false, error: `signed for ${source} in ${workspace}, which is not a source this app is configured for` };
  }
  const key = input.keys.find((k) => k.kid === kid);
  if (!key) return { ok: false, error: `no codecast key ${kid}`, unknownKid: kid };
  const sig = base64urlDecode(signature);
  if (!sig || sig.length !== 64) return { ok: false, error: "bad Codecast-Signature" };
  const canonical = canonicalSignatureString({
    method: input.method,
    pathAndQuery: input.pathAndQuery,
    bodySha256: await bodySha256Hex(input.body),
    timestamp,
    source,
    workspace,
    nonce,
  });
  let valid = false;
  try {
    valid = await crypto.subtle.verify(ED25519, await importKey(key, "verify"), sig, utf8(canonical));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "the signature does not match the request" };
  // Only a valid signature spends its nonce, so forged requests cannot fill the memory.
  if (input.seenNonce?.(nonce, at + SIGNATURE_WINDOW_MS)) return { ok: false, error: "replayed request: the nonce was already used" };
  return { ok: true, kid, source, workspace };
}

/**
 * A nonce memory for verifiers: an insertion-ordered map capped at `max`,
 * each entry forgotten once its request's window has passed.
 */
export function nonceMemory(max = 10_000, now: () => number = Date.now): (nonce: string, expiresAt: number) => boolean {
  const seen = new Map<string, number>();
  return (nonce, expiresAt) => {
    const t = now();
    for (const [n, exp] of seen) {
      if (exp > t && seen.size < max) break;
      seen.delete(n);
    }
    if ((seen.get(nonce) ?? 0) > t) return true;
    seen.set(nonce, expiresAt);
    return false;
  };
}
