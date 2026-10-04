// Verify that a request came from codecast (codecast
// docs/architecture/external-data.md X8, signed requests). Codecast signs
// every call it makes to an app connector with Ed25519 and publishes its
// public keys at <codecast>/.well-known/codecast-keys.json, so an app needs
// no shared secret: it commits codecast.json (which names the sources allowed
// to call it) and checks every /codecast/* request here.
//
//   import codecastJson from "./codecast.json";
//   import { createCodecastVerifier } from "@platform/analytics/codecast-verify";
//   const verifier = createCodecastVerifier({ config: codecastJson });
//   const result = await verifier.verify(request);           // a Fetch Request
//   if (!result.ok) return new Response(result.error, { status: 401 });
//
// The scheme is codecast's packages/shared/contracts/codecastSignature.ts,
// spelled again here because the platform package must not import codecast;
// codecast's codecastSignature.drift.test.ts checks this copy against the
// committed vectors. WebCrypto only: Node 20+, Bun, Deno, workers, browsers.

import { codecastKeysUrl, parseCodecastJson, type CodecastJson } from "./codecast";

export const SIGNATURE_SCHEME = "codecast-signature-v1";
export const SIGNATURE_HEADERS = {
  signature: "Codecast-Signature",
  keyId: "Codecast-Key-Id",
  timestamp: "Codecast-Timestamp",
  source: "Codecast-Source",
  workspace: "Codecast-Workspace",
  nonce: "Codecast-Nonce",
} as const;
export const SIGNATURE_WINDOW_MS = 5 * 60_000;

/** A key set is refetched this often, and at once (at most once a minute) when a request names an unknown kid. */
const KEYS_TTL_MS = 60 * 60_000;
const UNKNOWN_KID_REFETCH_MS = 60_000;

export interface CodecastPublicKey {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
}

export interface CanonicalParts {
  method: string;
  pathAndQuery: string;
  bodySha256: string;
  timestamp: string;
  source: string;
  workspace: string;
  nonce: string;
}

/** The signed string: seven lines joined by "\n" (codecastSignature.ts documents each). */
export function canonicalSignatureString(p: CanonicalParts): string {
  return [SIGNATURE_SCHEME, p.method.toUpperCase(), p.pathAndQuery, p.bodySha256, p.timestamp, p.source, p.workspace, p.nonce].join("\n");
}

type Bytes = Uint8Array<ArrayBuffer>;

function bodyBytes(body: string | Uint8Array | ArrayBuffer | null | undefined): Bytes {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body) as Bytes;
  return new Uint8Array(body instanceof ArrayBuffer ? body : body) as Bytes;
}

export async function bodySha256Hex(body: string | Uint8Array | ArrayBuffer | null | undefined): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bodyBytes(body));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64urlDecode(text: string): Bytes | null {
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

/** The Ed25519 keys in a fetched key set. */
export function jwksKeys(doc: unknown): CodecastPublicKey[] {
  const keys = (doc as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return [];
  return keys
    .filter((k) => k && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string" && typeof k.kid === "string")
    .map((k) => ({ kty: "OKP" as const, crv: "Ed25519" as const, x: k.x as string, kid: k.kid as string }));
}

const imported = new Map<string, Promise<CryptoKey>>();
function importPublic(k: CodecastPublicKey): Promise<CryptoKey> {
  const id = `${k.kid}:${k.x}`;
  let key = imported.get(id);
  if (!key) {
    key = crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: k.x }, { name: "Ed25519" }, false, ["verify"]);
    key.catch(() => imported.delete(id));
    imported.set(id, key);
  }
  return key;
}

export interface ExpectedSource {
  id: string;
  workspace: string;
}

export type VerifyResult = { ok: true; kid: string; source: string; workspace: string } | { ok: false; error: string; unknownKid?: string };

export interface VerifyParts {
  method: string;
  pathAndQuery: string;
  body?: string | Uint8Array | ArrayBuffer | null;
  header: (name: string) => string | null | undefined;
}

/** One request against a fixed key set and source list (no fetching). */
export async function verifyCodecastSignature(
  req: VerifyParts,
  opts: { keys: readonly CodecastPublicKey[]; sources: readonly ExpectedSource[]; now?: number; seenNonce?: (nonce: string, expiresAt: number) => boolean },
): Promise<VerifyResult> {
  const h = (name: string) => req.header(name)?.trim() ?? "";
  const signature = h(SIGNATURE_HEADERS.signature);
  const kid = h(SIGNATURE_HEADERS.keyId);
  const timestamp = h(SIGNATURE_HEADERS.timestamp);
  const source = h(SIGNATURE_HEADERS.source);
  const workspace = h(SIGNATURE_HEADERS.workspace);
  const nonce = h(SIGNATURE_HEADERS.nonce);
  if (!signature || !kid || !timestamp || !source || !workspace || !nonce) return { ok: false, error: "not a codecast-signed request: a signature header is missing" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, error: "bad Codecast-Timestamp" };
  const now = opts.now ?? Date.now();
  const at = Number(timestamp) * 1000;
  if (Math.abs(now - at) > SIGNATURE_WINDOW_MS) return { ok: false, error: "Codecast-Timestamp is outside the 5 minute window" };
  if (!opts.sources.some((s) => s.id === source && s.workspace === workspace)) {
    return { ok: false, error: `signed for ${source} in ${workspace}, which is not a source this app is configured for` };
  }
  const key = opts.keys.find((k) => k.kid === kid);
  if (!key) return { ok: false, error: `no codecast key ${kid}`, unknownKid: kid };
  const sig = base64urlDecode(signature);
  if (!sig || sig.length !== 64) return { ok: false, error: "bad Codecast-Signature" };
  const canonical = canonicalSignatureString({ method: req.method, pathAndQuery: req.pathAndQuery, bodySha256: await bodySha256Hex(req.body), timestamp, source, workspace, nonce });
  let valid = false;
  try {
    valid = await crypto.subtle.verify({ name: "Ed25519" }, await importPublic(key), sig, new TextEncoder().encode(canonical) as Bytes);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "the signature does not match the request" };
  if (opts.seenNonce?.(nonce, at + SIGNATURE_WINDOW_MS)) return { ok: false, error: "replayed request: the nonce was already used" };
  return { ok: true, kid, source, workspace };
}

/** Nonces remembered until their request's window passes, in an insertion-ordered map capped at `max`. */
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

export interface CodecastVerifierOptions {
  /** The app's committed codecast.json (parsed JSON): which sources may call, and where codecast's keys are. */
  config: unknown;
  /** Only these source names from the file (default: every source it lists). */
  sources?: string[];
  /** Overrides where the key set is fetched. */
  keysUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface CodecastVerifier {
  /** A Fetch Request (the body is read from a clone, so the handler can still read it). */
  verify(request: Request): Promise<VerifyResult>;
  /** Any server's request: method, path and query as requested, the raw body, and a header lookup. */
  verifyParts(parts: VerifyParts): Promise<VerifyResult>;
}

/** A verifier that fetches codecast's key set (cached an hour, refetched on an unknown kid) and remembers nonces. */
export function createCodecastVerifier(options: CodecastVerifierOptions): CodecastVerifier {
  const parsed = parseCodecastJson(options.config);
  if (!parsed.ok) throw new Error(`codecast.json: ${parsed.errors.join("; ")}`);
  const file: CodecastJson = parsed.config;
  const names = options.sources ?? Object.keys(file.sources);
  const sources = names.map((n) => {
    const s = file.sources[n];
    if (!s) throw new Error(`codecast.json lists no source "${n}"`);
    return s;
  });
  const keysUrl = options.keysUrl ?? codecastKeysUrl(file);
  const now = options.now ?? (() => Date.now());
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const seenNonce = nonceMemory(10_000, now);
  let keys: CodecastPublicKey[] = [];
  let fetchedAt = 0;
  let lastForced = 0;
  let inflight: Promise<void> | null = null;

  const refresh = () =>
    (inflight ??= (async () => {
      try {
        const res = await doFetch(keysUrl, { headers: { Accept: "application/json" } });
        if (res.ok) {
          keys = jwksKeys(await res.json());
          fetchedAt = now();
        }
      } catch {
        // Codecast unreachable: keep the keys already held.
      } finally {
        inflight = null;
      }
    })());

  const verifyParts = async (parts: VerifyParts): Promise<VerifyResult> => {
    if (!keys.length || now() - fetchedAt > KEYS_TTL_MS) await refresh();
    let out = await verifyCodecastSignature(parts, { keys, sources, now: now(), seenNonce });
    if (!out.ok && out.unknownKid && now() - lastForced > UNKNOWN_KID_REFETCH_MS) {
      lastForced = now();
      await refresh();
      out = await verifyCodecastSignature(parts, { keys, sources, now: now(), seenNonce });
    }
    return out;
  };

  return {
    verifyParts,
    async verify(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(await request.clone().arrayBuffer());
      return verifyParts({ method: request.method, pathAndQuery: `${url.pathname}${url.search}`, body, header: (n) => request.headers.get(n) });
    },
  };
}
