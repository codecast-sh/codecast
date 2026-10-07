import { describe, expect, test } from "bun:test";
import vectors from "./__fixtures__/codecastSignature.vectors.json";
import {
  CODECAST_KEYS_PATH,
  SIGNATURE_HEADERS,
  bodySha256Hex,
  canonicalSignatureString,
  generateSigningKey,
  jwksKeys,
  nonceMemory,
  parseSigningKeys,
  pathAndQueryOf,
  publicJwks,
  signCodecastRequest,
  verifyCodecastRequest,
  type CodecastJwk,
  type VerifyInput,
} from "./codecastSignature";
import { codecastKeysUrlOf, mergeCodecastConfig, parseCodecastConfig } from "./codecastConfig";

const NOW = 1_790_000_000_000;
const source = { id: "src-12", workspace: "team:k57abc" };

async function signed(key: CodecastJwk, over: Partial<{ method: string; url: string; body: string; source: string; workspace: string }> = {}, nonce?: string) {
  const req = { method: "POST", url: "https://api.example.com/api/codecast/jobs/rerun?dry=1", body: '{"jobId":"j9"}', source: source.id, workspace: source.workspace, ...over };
  const headers = await signCodecastRequest(req, key, { now: NOW, ...(nonce ? { nonce } : {}) });
  return { req, headers };
}

function verifyInput(req: { method: string; url: string; body?: string }, headers: Record<string, string>, keys: CodecastJwk[], over: Partial<VerifyInput> = {}): VerifyInput {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: req.method,
    pathAndQuery: pathAndQueryOf(req.url),
    body: req.body,
    header: (n) => lower[n.toLowerCase()],
    keys: publicJwks(keys).keys,
    sources: [source],
    now: NOW,
    ...over,
  };
}

describe("codecast request signatures", () => {
  test("round trip: what codecast signs, a verifier with the published keys accepts", async () => {
    const key = await generateSigningKey("k1");
    const { req, headers } = await signed(key);
    expect(Object.keys(headers).sort()).toEqual(Object.values(SIGNATURE_HEADERS).sort());
    expect(await verifyCodecastRequest(verifyInput(req, headers, [key]))).toEqual({ ok: true, kid: "k1", source: source.id, workspace: source.workspace });
  });

  test("the published set carries no private half", async () => {
    const key = await generateSigningKey("k1");
    expect(JSON.stringify(publicJwks([key]))).not.toContain(key.d!);
    expect(jwksKeys(publicJwks([key]))[0]).toEqual({ kty: "OKP", crv: "Ed25519", x: key.x, kid: "k1" });
  });

  test("tampering with the body, path, query, method, timestamp, source or workspace fails", async () => {
    const key = await generateSigningKey("k1");
    const { req, headers } = await signed(key);
    const tampered: Array<[string, VerifyInput]> = [
      ["body", verifyInput({ ...req, body: '{"jobId":"j10"}' }, headers, [key])],
      ["path", verifyInput({ ...req, url: "https://api.example.com/api/codecast/jobs/cancel?dry=1" }, headers, [key])],
      ["query", verifyInput({ ...req, url: "https://api.example.com/api/codecast/jobs/rerun?dry=0" }, headers, [key])],
      ["method", verifyInput({ ...req, method: "PUT" }, headers, [key])],
      ["timestamp", verifyInput(req, { ...headers, [SIGNATURE_HEADERS.timestamp]: String(NOW / 1000 + 1) }, [key])],
      ["nonce", verifyInput(req, { ...headers, [SIGNATURE_HEADERS.nonce]: "b3RoZXI" }, [key])],
    ];
    for (const [what, input] of tampered) {
      const out = await verifyCodecastRequest(input);
      expect({ what, ok: out.ok }).toEqual({ what, ok: false });
    }
    // A source or workspace the app is configured for, but not the one signed.
    const other = { id: "src-13", workspace: source.workspace };
    const swapped = await verifyCodecastRequest(verifyInput(req, { ...headers, [SIGNATURE_HEADERS.source]: other.id }, [key], { sources: [source, other] }));
    expect(swapped).toMatchObject({ ok: false, error: "the signature does not match the request" });
    const ws = { id: source.id, workspace: "team:other" };
    const swappedWs = await verifyCodecastRequest(verifyInput(req, { ...headers, [SIGNATURE_HEADERS.workspace]: ws.workspace }, [key], { sources: [source, ws] }));
    expect(swappedWs.ok).toBe(false);
  });

  test("a validly signed request for a source this app is not configured for is refused", async () => {
    const key = await generateSigningKey("k1");
    const { req, headers } = await signed(key, { source: "src-99" });
    const out = await verifyCodecastRequest(verifyInput(req, headers, [key]));
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toContain("src-99");
  });

  test("outside the 5 minute window either way is refused", async () => {
    const key = await generateSigningKey("k1");
    const { req, headers } = await signed(key);
    expect((await verifyCodecastRequest(verifyInput(req, headers, [key], { now: NOW + 5 * 60_000 }))).ok).toBe(true);
    expect((await verifyCodecastRequest(verifyInput(req, headers, [key], { now: NOW + 5 * 60_000 + 1000 }))).ok).toBe(false);
    expect((await verifyCodecastRequest(verifyInput(req, headers, [key], { now: NOW - 6 * 60_000 }))).ok).toBe(false);
  });

  test("a replayed nonce is refused; a forged request does not spend one", async () => {
    const key = await generateSigningKey("k1");
    const seen = nonceMemory(100, () => NOW);
    const { req, headers } = await signed(key, {}, "cmVwbGF5");
    const forged = await verifyCodecastRequest(verifyInput({ ...req, body: "{}" }, headers, [key], { seenNonce: seen }));
    expect(forged.ok).toBe(false);
    expect((await verifyCodecastRequest(verifyInput(req, headers, [key], { seenNonce: seen }))).ok).toBe(true);
    expect(await verifyCodecastRequest(verifyInput(req, headers, [key], { seenNonce: seen }))).toMatchObject({ ok: false, error: expect.stringContaining("replayed") });
  });

  test("the nonce memory forgets expired nonces and stays under its cap", () => {
    let t = 0;
    const seen = nonceMemory(3, () => t);
    expect(seen("a", 10)).toBe(false);
    expect(seen("a", 10)).toBe(true);
    t = 11;
    expect(seen("a", 20)).toBe(false);
    for (const n of ["b", "c", "d", "e"]) seen(n, 100);
    // "a" was pushed out by the cap.
    expect(seen("a", 100)).toBe(false);
  });

  test("key rotation by kid: both keys verify while published, the dropped one stops", async () => {
    const old = await generateSigningKey("2026-09");
    const fresh = await generateSigningKey("2026-10");
    const env = JSON.stringify([fresh, old]);
    const keys = parseSigningKeys(env);
    expect(keys[0].kid).toBe("2026-10");
    const byOld = await signed(old);
    const byNew = await signed(keys[0]);
    expect(byNew.headers[SIGNATURE_HEADERS.keyId]).toBe("2026-10");
    expect((await verifyCodecastRequest(verifyInput(byOld.req, byOld.headers, keys))).ok).toBe(true);
    expect((await verifyCodecastRequest(verifyInput(byNew.req, byNew.headers, keys))).ok).toBe(true);
    const dropped = await verifyCodecastRequest(verifyInput(byOld.req, byOld.headers, [fresh]));
    expect(dropped).toMatchObject({ ok: false, unknownKid: "2026-09" });
    // A kid naming the wrong key bytes does not verify.
    const lying = await verifyCodecastRequest(verifyInput(byOld.req, byOld.headers, [{ ...fresh, kid: "2026-09" }]));
    expect(lying).toMatchObject({ ok: false, error: "the signature does not match the request" });
  });

  test("parseSigningKeys takes one JWK or a list, and says what is wrong without echoing key material", async () => {
    const key = await generateSigningKey("solo");
    expect(parseSigningKeys(JSON.stringify(key))).toHaveLength(1);
    expect(() => parseSigningKeys("nope")).toThrow("not JSON");
    expect(() => parseSigningKeys(JSON.stringify({ ...key, d: undefined }))).toThrow("private Ed25519 JWK");
    expect(() => parseSigningKeys(JSON.stringify([key, key]))).toThrow("twice");
    try {
      parseSigningKeys(JSON.stringify([{ ...key, crv: "P-256" }]));
    } catch (e: any) {
      expect(String(e.message)).not.toContain(key.d!);
    }
  });

  test("the canonical string is the seven documented lines", async () => {
    expect(
      canonicalSignatureString({ method: "get", pathAndQuery: "/a?b=1", bodySha256: await bodySha256Hex(undefined), timestamp: "1", source: "src-1", workspace: "team:t", nonce: "n" }),
    ).toBe(["codecast-signature-v1", "GET", "/a?b=1", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "1", "src-1", "team:t", "n"].join("\n"));
    expect(CODECAST_KEYS_PATH).toBe("/.well-known/codecast-keys.json");
  });

  test("the committed vectors still sign and verify the same (verifier copies are drift tested against them)", async () => {
    for (const v of vectors.vectors) {
      const key = vectors.keys.find((k) => k.kid === v.kid) as CodecastJwk;
      const headers = await signCodecastRequest(v.request, key, { now: v.now, nonce: v.headers[SIGNATURE_HEADERS.nonce as keyof typeof v.headers] });
      expect(headers).toEqual(v.headers);
      const out = await verifyCodecastRequest({
        ...verifyInput(v.request, v.headers, vectors.keys as CodecastJwk[], { now: v.now, sources: [{ id: v.request.source, workspace: v.request.workspace }] }),
      });
      expect(out.ok).toBe(true);
    }
  });
});

describe("codecast.json", () => {
  test("parses, and refuses unknown keys and malformed sources", () => {
    expect(parseCodecastConfig({ ingestKey: "cc_ing_abc", sources: { union: { id: "src-4", workspace: "team:k57" } } })).toEqual({
      ok: true,
      config: { ingestKey: "cc_ing_abc", sources: { union: { id: "src-4", workspace: "team:k57" } } },
    });
    const bad = parseCodecastConfig({ secret: "x", ingestKey: "sk_live", sources: { a: { id: "4" } } });
    expect(bad.ok).toBe(false);
    expect((bad as { errors: string[] }).errors).toHaveLength(3);
  });

  test("merge records the source, the new key and a non-prod endpoint, and reports each change", () => {
    const first = mergeCodecastConfig(null, { name: "union-errors", source: { id: "src-5", workspace: "team:k57" }, ingestKey: "cc_ing_one", endpoint: "https://convex.codecast.sh/cli/ingest" });
    expect(first.config).toEqual({ ingestKey: "cc_ing_one", sources: { "union-errors": { id: "src-5", workspace: "team:k57" } } });
    expect(first.changes).toEqual(["sources.union-errors = src-5 (team:k57)", "ingestKey set"]);
    const second = mergeCodecastConfig(first.config, { name: "union", source: { id: "src-6", workspace: "team:k57" }, endpoint: "https://dev.example/cli/ingest/" });
    expect(Object.keys(second.config.sources)).toEqual(["union", "union-errors"]);
    expect(second.config.endpoint).toBe("https://dev.example/cli/ingest");
    expect(mergeCodecastConfig(second.config, { name: "union", source: { id: "src-6", workspace: "team:k57" } }).changes).toEqual([]);
  });

  test("reads the replay block, refuses a bad one, and merge keeps it", () => {
    const file = { ingestKey: "cc_ing_abc", sources: {}, replay: { dom: "onError", sampleRate: 0.05 } };
    const parsed = parseCodecastConfig(file);
    expect(parsed).toEqual({ ok: true, config: file as never });
    const bad = parseCodecastConfig({ sources: {}, replay: { dom: "always", sampleRate: 2, extra: 1 } });
    expect((bad as { errors: string[] }).errors).toEqual(['unknown key "replay.extra"', 'replay.dom must be one of "off", "onError", "sampled"', "replay.sampleRate must be a number from 0 to 1"]);
    const merged = mergeCodecastConfig(parsed.ok ? parsed.config : null, { name: "web", source: { id: "src-9", workspace: "team:k57" } });
    expect(merged.config.replay).toEqual({ dom: "onError", sampleRate: 0.05 });
    expect(Object.keys(merged.config)).toEqual(["ingestKey", "sources", "replay"]);
  });

  test("the keys URL is the endpoint's origin", () => {
    expect(codecastKeysUrlOf(null)).toBe("https://convex.codecast.sh/.well-known/codecast-keys.json");
    expect(codecastKeysUrlOf({ endpoint: "https://x.convex.site/cli/ingest" })).toBe("https://x.convex.site/.well-known/codecast-keys.json");
  });
});
