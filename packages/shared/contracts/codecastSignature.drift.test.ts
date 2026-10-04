// The verifier copies of the signature scheme must agree with the one
// statement of it (codecastSignature.ts): the copy in @platform/analytics
// (the vendored mirror, platform/packages/analytics/src/codecastVerify.ts)
// and Union's inline copy (union-mobile outreach/backend/src/lib/
// codecastSignature.ts). Each must build the same canonical string and accept
// every committed vector. Union lives in another repository, so its half runs
// only where that checkout exists (a laptop), and is skipped in CI.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vectors from "./__fixtures__/codecastSignature.vectors.json";
import { SIGNATURE_HEADERS, SIGNATURE_WINDOW_MS, bodySha256Hex, canonicalSignatureString, pathAndQueryOf, publicJwks, type CodecastJwk } from "./codecastSignature";
import * as platform from "../../../platform/packages/analytics/src/codecastVerify";

const UNION = path.join(os.homedir(), "src/union-mobile/outreach/backend/src/lib/codecastSignature.ts");

type Copy = {
  canonicalSignatureString: (p: Parameters<typeof canonicalSignatureString>[0]) => string;
  bodySha256Hex: (b: string | undefined) => Promise<string>;
  SIGNATURE_HEADERS: typeof SIGNATURE_HEADERS;
  SIGNATURE_WINDOW_MS: number;
  verifyCodecastSignature: (
    req: { method: string; pathAndQuery: string; body?: string | null; header: (n: string) => string | undefined },
    opts: { keys: Array<{ kty: "OKP"; crv: "Ed25519"; x: string; kid: string }>; sources: Array<{ id: string; workspace: string }>; now?: number },
  ) => Promise<{ ok: boolean }>;
};

async function agrees(copy: Copy) {
  expect(copy.SIGNATURE_HEADERS).toEqual(SIGNATURE_HEADERS);
  expect(copy.SIGNATURE_WINDOW_MS).toBe(SIGNATURE_WINDOW_MS);
  const keys = publicJwks(vectors.keys as CodecastJwk[]).keys.map(({ kty, crv, x, kid }) => ({ kty, crv, x, kid }));
  for (const v of vectors.vectors) {
    const h = v.headers as Record<string, string>;
    const parts = {
      method: v.request.method,
      pathAndQuery: pathAndQueryOf(v.request.url),
      bodySha256: await bodySha256Hex(v.request.body),
      timestamp: h[SIGNATURE_HEADERS.timestamp],
      source: v.request.source,
      workspace: v.request.workspace,
      nonce: h[SIGNATURE_HEADERS.nonce],
    };
    expect(await copy.bodySha256Hex(v.request.body)).toBe(parts.bodySha256);
    expect(copy.canonicalSignatureString(parts)).toBe(canonicalSignatureString(parts));
    expect(canonicalSignatureString(parts)).toBe(v.canonical);
    const lower = Object.fromEntries(Object.entries(h).map(([k, val]) => [k.toLowerCase(), val]));
    const req = { method: v.request.method, pathAndQuery: parts.pathAndQuery, body: v.request.body ?? null, header: (n: string) => lower[n.toLowerCase()] };
    const sources = [{ id: v.request.source, workspace: v.request.workspace }];
    expect((await copy.verifyCodecastSignature(req, { keys, sources, now: v.now })).ok).toBe(true);
    // And refuses the same vector with its body or path changed.
    expect((await copy.verifyCodecastSignature({ ...req, body: `${v.request.body ?? ""} ` }, { keys, sources, now: v.now })).ok).toBe(false);
    expect((await copy.verifyCodecastSignature({ ...req, pathAndQuery: `${parts.pathAndQuery}x` }, { keys, sources, now: v.now })).ok).toBe(false);
  }
}

describe("verifier copies of the codecast signature scheme", () => {
  test("@platform/analytics/codecast-verify agrees with codecastSignature.ts", async () => {
    await agrees(platform as unknown as Copy);
  });

  test.skipIf(!fs.existsSync(UNION))("Union's inline copy agrees with codecastSignature.ts", async () => {
    await agrees((await import(UNION)) as Copy);
  });
});
