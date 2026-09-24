import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { isManifestSignatureFile, publicKeyToBase64, signManifest, verifyDetached, verifyManifestSignature } from "./signing";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: publicKeyToBase64(publicKey), pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
}

const enc = new TextEncoder();
const manifest = enc.encode(JSON.stringify({ version: "1.1.0", released: "2026-01-01T00:00:00Z", binaries: {} }));
const SIG_URL = "https://dl.example.com/latest.json.sig";

function fetchWith(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("manifest signatures", () => {
  it("round trips a detached signature", () => {
    const k = keypair();
    const s = signManifest(manifest, k.pem, "release-2026");
    expect(verifyDetached(manifest, s.sig, k.pub)).toBe(true);
    expect(verifyDetached(enc.encode("tampered"), s.sig, k.pub)).toBe(false);
    expect(verifyDetached(manifest, s.sig, keypair().pub)).toBe(false);
  });

  it("does nothing, not even a request, without pinned keys", async () => {
    let fetched = 0;
    const fetch: typeof globalThis.fetch = (async () => { fetched++; return new Response("", { status: 500 }); }) as unknown as typeof globalThis.fetch;
    expect(await verifyManifestSignature({ manifestBytes: manifest, signatureUrl: SIG_URL, policy: undefined, fetch })).toEqual({ ok: true, verified: false });
    expect(await verifyManifestSignature({ manifestBytes: manifest, signatureUrl: SIG_URL, policy: { keys: {}, required: true }, fetch })).toEqual({ ok: true, verified: false });
    expect(fetched).toBe(0);
  });

  it("verifies a manifest signed by a pinned key", async () => {
    const k = keypair();
    const file = { signatures: [signManifest(manifest, k.pem, "a")] };
    const verdict = await verifyManifestSignature({ manifestBytes: manifest, signatureUrl: SIG_URL, policy: { keys: { a: k.pub }, required: true }, fetch: fetchWith(file) });
    expect(verdict).toEqual({ ok: true, verified: true, keyId: "a" });
  });

  it("refuses an altered manifest under either policy", async () => {
    const k = keypair();
    const file = { signatures: [signManifest(manifest, k.pem, "a")] };
    for (const required of [true, false]) {
      const verdict = await verifyManifestSignature({ manifestBytes: enc.encode("{}"), signatureUrl: SIG_URL, policy: { keys: { a: k.pub }, required }, fetch: fetchWith(file) });
      expect(verdict).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("accepts a rotated key when the client pins either key", async () => {
    const old = keypair();
    const fresh = keypair();
    const both = { signatures: [signManifest(manifest, old.pem, "old"), signManifest(manifest, fresh.pem, "new")] };
    const onlyOld = await verifyManifestSignature({ manifestBytes: manifest, signatureUrl: SIG_URL, policy: { keys: { old: old.pub }, required: true }, fetch: fetchWith(both) });
    const onlyNew = await verifyManifestSignature({ manifestBytes: manifest, signatureUrl: SIG_URL, policy: { keys: { new: fresh.pub }, required: true }, fetch: fetchWith(both) });
    expect(onlyOld).toEqual({ ok: true, verified: true, keyId: "old" });
    expect(onlyNew).toEqual({ ok: true, verified: true, keyId: "new" });
  });

  it("treats a signature by an unknown key as unsigned: refused only when required", async () => {
    const stranger = keypair();
    const file = { signatures: [signManifest(manifest, stranger.pem, "x")] };
    const pinned = { a: keypair().pub };
    expect(await verifyManifestSignature({ manifestBytes: manifest, signatureUrl: SIG_URL, policy: { keys: pinned, required: true }, fetch: fetchWith(file) })).toEqual({ ok: false, reason: "unknown_key" });
    expect(await verifyManifestSignature({ manifestBytes: manifest, signatureUrl: SIG_URL, policy: { keys: pinned, required: false }, fetch: fetchWith(file) })).toEqual({ ok: true, verified: false });
  });

  it("treats a missing signature file as unsigned: refused only when required", async () => {
    const pinned = { a: keypair().pub };
    expect(await verifyManifestSignature({ manifestBytes: manifest, signatureUrl: SIG_URL, policy: { keys: pinned, required: true }, fetch: fetchWith("", 404) })).toEqual({ ok: false, reason: "missing" });
    expect(await verifyManifestSignature({ manifestBytes: manifest, signatureUrl: SIG_URL, policy: { keys: pinned, required: false }, fetch: fetchWith("", 404) })).toEqual({ ok: true, verified: false });
  });

  it("refuses a signature file it cannot read under either policy", async () => {
    const pinned = { a: keypair().pub };
    for (const body of ["not json", {}, { signatures: [] }, { signatures: [{ keyId: "a", alg: "rsa", sig: "x" }] }, { signatures: [{ keyId: "../a", alg: "ed25519", sig: "x" }] }]) {
      for (const required of [true, false]) {
        const v = await verifyManifestSignature({ manifestBytes: manifest, signatureUrl: SIG_URL, policy: { keys: pinned, required }, fetch: fetchWith(body) });
        expect(v, JSON.stringify(body)).toEqual({ ok: false, reason: "malformed" });
      }
    }
  });

  it("validates the signature file shape", () => {
    expect(isManifestSignatureFile({ signatures: [{ keyId: "k", alg: "ed25519", sig: "AA==" }] })).toBe(true);
    expect(isManifestSignatureFile({ signatures: [{ keyId: "k", alg: "ed25519", sig: "A".repeat(200) }] })).toBe(false);
  });
});
