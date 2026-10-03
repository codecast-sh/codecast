import { afterEach, describe, expect, test } from "bun:test";
import { generateSigningKey, pathAndQueryOf, verifyCodecastRequest } from "@codecast/shared/contracts/codecastSignature";
import { SIGNING_NOT_CONFIGURED, publishedKeys, signatureHeaders } from "./codecastSigning";

afterEach(() => {
  delete process.env.CODECAST_SIGNING_KEY;
});

describe("codecast's signing key", () => {
  test("unset: nothing published, nothing signed", async () => {
    expect(publishedKeys()).toEqual({ keys: [] });
    expect(await signatureHeaders({ method: "GET", url: "https://a.example/x", source: "src-1", workspace: "team:t" })).toEqual({ ok: false, error: SIGNING_NOT_CONFIGURED });
  });

  test("a rotation list: the first key signs, both are published without their private halves", async () => {
    const fresh = await generateSigningKey("new");
    const old = await generateSigningKey("old");
    process.env.CODECAST_SIGNING_KEY = JSON.stringify([fresh, old]);
    const published = publishedKeys();
    expect(published.keys.map((k) => k.kid)).toEqual(["new", "old"]);
    expect(JSON.stringify(published)).not.toContain(fresh.d!);
    expect(JSON.stringify(published)).not.toContain(old.d!);
    const req = { method: "POST", url: "https://a.example/codecast/x?y=1", body: "{}", source: "src-1", workspace: "team:t" };
    const signed = await signatureHeaders(req);
    if (!signed.ok) throw new Error(signed.error);
    expect(signed.headers["Codecast-Key-Id"]).toBe("new");
    const out = await verifyCodecastRequest({
      method: req.method,
      pathAndQuery: pathAndQueryOf(req.url),
      body: req.body,
      header: (n) => signed.headers[Object.keys(signed.headers).find((k) => k.toLowerCase() === n.toLowerCase())!],
      keys: published.keys,
      sources: [{ id: "src-1", workspace: "team:t" }],
    });
    expect(out.ok).toBe(true);
  });

  test("a malformed value says why, and a later fix is picked up", async () => {
    process.env.CODECAST_SIGNING_KEY = "{not json";
    const bad = await signatureHeaders({ method: "GET", url: "https://a.example/x", source: "src-1", workspace: "team:t" });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("not JSON") });
    process.env.CODECAST_SIGNING_KEY = JSON.stringify(await generateSigningKey("k"));
    expect((await signatureHeaders({ method: "GET", url: "https://a.example/x", source: "src-1", workspace: "team:t" })).ok).toBe(true);
  });
});
