import { describe, expect, it } from "bun:test";
import { SIGNATURE_HEADERS, canonicalSignatureString, bodySha256Hex, createCodecastVerifier, nonceMemory, verifyCodecastSignature, type CodecastPublicKey } from "./codecastVerify";

// The signing half lives in codecast (packages/shared/contracts/codecastSignature.ts),
// which also checks this copy against its committed vectors. These tests sign
// the way it does, from the documented canonical string.

const NOW = 1_790_000_000_000;
const SOURCE = { id: "src-6", workspace: "team:k57" };
const CONFIG = { sources: { union: SOURCE } };

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, public: { kty: "OKP", crv: "Ed25519", x: jwk.x!, kid } as CodecastPublicKey };
}

const b64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function signed(key: Awaited<ReturnType<typeof keyPair>>, req: { method: string; url: string; body?: string }, over: { source?: string; workspace?: string; nonce?: string; now?: number } = {}) {
  const u = new URL(req.url);
  const parts = {
    method: req.method,
    pathAndQuery: `${u.pathname}${u.search}`,
    bodySha256: await bodySha256Hex(req.body),
    timestamp: String(Math.floor((over.now ?? NOW) / 1000)),
    source: over.source ?? SOURCE.id,
    workspace: over.workspace ?? SOURCE.workspace,
    nonce: over.nonce ?? crypto.randomUUID().replace(/-/g, ""),
  };
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, new TextEncoder().encode(canonicalSignatureString(parts)));
  const headers = new Headers({
    [SIGNATURE_HEADERS.signature]: b64url(sig),
    [SIGNATURE_HEADERS.keyId]: key.kid,
    [SIGNATURE_HEADERS.timestamp]: parts.timestamp,
    [SIGNATURE_HEADERS.source]: parts.source,
    [SIGNATURE_HEADERS.workspace]: parts.workspace,
    [SIGNATURE_HEADERS.nonce]: parts.nonce,
  });
  return new Request(req.url, { method: req.method, headers, ...(req.body !== undefined ? { body: req.body } : {}) });
}

function keyServer(...sets: CodecastPublicKey[][]) {
  const urls: string[] = [];
  let i = 0;
  const fetch = (async (url: string) => {
    urls.push(url);
    const keys = sets[Math.min(i++, sets.length - 1)];
    return Response.json({ keys });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, urls };
}

describe("createCodecastVerifier", () => {
  it("accepts codecast's signed request for a configured source, and leaves the body readable", async () => {
    const k = await keyPair("k1");
    const server = keyServer([k.public]);
    const verifier = createCodecastVerifier({ config: CONFIG, fetch: server.fetch, now: () => NOW });
    const req = await signed(k, { method: "POST", url: "https://api.union.test/api/codecast/jobs/rerun?x=1", body: '{"jobId":"j9"}' });
    expect(await verifier.verify(req)).toEqual({ ok: true, kid: "k1", source: SOURCE.id, workspace: SOURCE.workspace });
    expect(await req.json()).toEqual({ jobId: "j9" });
    expect(server.urls).toEqual(["https://convex.codecast.sh/.well-known/codecast-keys.json"]);
  });

  it("tampering with the body, path, timestamp or source fails", async () => {
    const k = await keyPair("k1");
    const opts = { keys: [k.public], sources: [SOURCE, { id: "src-7", workspace: SOURCE.workspace }], now: NOW };
    const req = await signed(k, { method: "POST", url: "https://a.test/api/codecast/x", body: "{}" });
    const parts = (over: Partial<{ path: string; body: string; header: Record<string, string> }> = {}) => ({
      method: "POST",
      pathAndQuery: over.path ?? "/api/codecast/x",
      body: over.body ?? "{}",
      header: (n: string) => over.header?.[n] ?? req.headers.get(n),
    });
    expect((await verifyCodecastSignature(parts(), opts)).ok).toBe(true);
    expect((await verifyCodecastSignature(parts({ body: '{"a":1}' }), opts)).ok).toBe(false);
    expect((await verifyCodecastSignature(parts({ path: "/api/codecast/y" }), opts)).ok).toBe(false);
    expect((await verifyCodecastSignature(parts({ header: { [SIGNATURE_HEADERS.timestamp]: String(NOW / 1000 + 1) } }), opts)).ok).toBe(false);
    expect((await verifyCodecastSignature(parts({ header: { [SIGNATURE_HEADERS.source]: "src-7" } }), opts)).ok).toBe(false);
    expect((await verifyCodecastSignature(parts(), { ...opts, now: NOW + 6 * 60_000 })).ok).toBe(false);
  });

  it("refuses a source the file does not list, and a replayed nonce", async () => {
    const k = await keyPair("k1");
    const verifier = createCodecastVerifier({ config: CONFIG, fetch: keyServer([k.public]).fetch, now: () => NOW });
    const other = await signed(k, { method: "GET", url: "https://a.test/api/codecast/manifest" }, { source: "src-99" });
    expect(await verifier.verify(other)).toMatchObject({ ok: false, error: expect.stringContaining("src-99") });
    const once = await signed(k, { method: "GET", url: "https://a.test/api/codecast/manifest" }, { nonce: "n1" });
    expect((await verifier.verify(once)).ok).toBe(true);
    const again = await signed(k, { method: "GET", url: "https://a.test/api/codecast/manifest" }, { nonce: "n1" });
    expect(await verifier.verify(again)).toMatchObject({ ok: false, error: expect.stringContaining("replayed") });
  });

  it("key rotation: an unknown kid refetches the key set once, then verifies", async () => {
    const old = await keyPair("2026-09");
    const fresh = await keyPair("2026-10");
    const server = keyServer([old.public], [fresh.public, old.public]);
    let t = NOW;
    const verifier = createCodecastVerifier({ config: CONFIG, fetch: server.fetch, now: () => t });
    expect((await verifier.verify(await signed(old, { method: "GET", url: "https://a.test/api/codecast/m" }))).ok).toBe(true);
    expect((await verifier.verify(await signed(fresh, { method: "GET", url: "https://a.test/api/codecast/m" }))).ok).toBe(true);
    expect(server.urls).toHaveLength(2);
    // A kid nobody publishes refetches at most once a minute.
    const stranger = await keyPair("nobody");
    t += 1000;
    await verifier.verify(await signed(stranger, { method: "GET", url: "https://a.test/api/codecast/m" }, { now: t }));
    await verifier.verify(await signed(stranger, { method: "GET", url: "https://a.test/api/codecast/m" }, { now: t }));
    expect(server.urls).toHaveLength(2);
  });

  it("names its sources from codecast.json and refuses a bad file", () => {
    expect(() => createCodecastVerifier({ config: { sources: {}, token: "x" } })).toThrow('unknown key "token"');
    expect(() => createCodecastVerifier({ config: CONFIG, sources: ["nope"] })).toThrow('no source "nope"');
  });

  it("the nonce memory forgets expired nonces", () => {
    let t = 0;
    const seen = nonceMemory(10, () => t);
    expect(seen("a", 5)).toBe(false);
    expect(seen("a", 5)).toBe(true);
    t = 6;
    expect(seen("a", 9)).toBe(false);
  });
});
