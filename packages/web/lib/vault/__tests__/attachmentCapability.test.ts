// LOCAL-01, web side. An attachment URL must not carry the daemon's loopback
// bearer — the secret that also spawns shells on /term/ws — because an SVG
// from the vault, opened as a document, runs at the daemon's origin and can
// read its own location.
//
// The real client functions against a stubbed fetch: what is asserted is what
// ends up IN the URL.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureVaultCapability, vaultAssetUrl } from "../client";

const TOKEN = "0123456789abcdef0123456789abcdef";
const ep = { port: 41999, token: TOKEN } as unknown as Parameters<typeof vaultAssetUrl>[0];

const realFetch = globalThis.fetch;
let requested: string[] = [];
let answer: (url: string) => Response;

function capBody(expiresIn: number, value = "v1.x.y"): Response {
  return new Response(JSON.stringify({ value, expires_at: Date.now() + expiresIn }), { status: 200 });
}

beforeEach(() => {
  requested = [];
  answer = () => capBody(12 * 60 * 60 * 1000);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    return answer(url);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("attachment URLs", () => {
  test("carry a capability and never the daemon bearer", async () => {
    await ensureVaultCapability(ep, "vault-a");
    const url = vaultAssetUrl(ep, "vault-a", "notes/shot.png")!;
    expect(url).toContain("cap=");
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("token=");
  });

  test("the mint itself goes through the authenticated envelope", async () => {
    await ensureVaultCapability(ep, "vault-b");
    expect(requested.some((u) => u.includes("/vault/cap?vault=vault-b"))).toBe(true);
  });

  test("one mint serves every asset in a vault, and vaults do not share one", async () => {
    await ensureVaultCapability(ep, "vault-c");
    const before = requested.length;
    vaultAssetUrl(ep, "vault-c", "a.png");
    vaultAssetUrl(ep, "vault-c", "b.png");
    expect(requested.length).toBe(before);
    expect(vaultAssetUrl(ep, "vault-unknown", "a.png")).toBeNull();
  });

  test("a daemon with no capability route keeps the old URL, so web can ship first", async () => {
    answer = () => new Response("{}", { status: 404 });
    await ensureVaultCapability(ep, "vault-old");
    const url = vaultAssetUrl(ep, "vault-old", "a.png")!;
    expect(url).toContain(`token=${TOKEN}`);
    expect(url).not.toContain("cap=");
  });

  test("an expired capability is not used, and the cold path re-mints", async () => {
    answer = () => capBody(-1000, "v1.expired.aa");
    await ensureVaultCapability(ep, "vault-d");
    // Asking for the URL both refuses the stale capability AND starts a fresh
    // mint of its own, which is what makes the cold path self-healing.
    expect(vaultAssetUrl(ep, "vault-d", "a.png")).toBeNull();

    answer = () => capBody(12 * 60 * 60 * 1000, "v1.fresh.bb");
    // Drain whatever mint the line above started before asking for a new one:
    // it was answered with the stale body and is still in flight.
    for (let i = 0; i < 4 && vaultAssetUrl(ep, "vault-d", "a.png") === null; i++) {
      await ensureVaultCapability(ep, "vault-d");
    }
    expect(vaultAssetUrl(ep, "vault-d", "a.png")).toContain("v1.fresh.bb");
  });

  test("a rotated daemon token never reuses the old capability", async () => {
    await ensureVaultCapability(ep, "vault-e");
    const rotated = { port: 41999, token: "ffff" } as unknown as typeof ep;
    expect(vaultAssetUrl(rotated, "vault-e", "a.png")).toBeNull();
  });
});
