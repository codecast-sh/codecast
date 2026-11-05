// The ingest door (ingestHttp.ts): admission, key guessing, paths, origins and bodies.
import { describe, expect, test } from "bun:test";
import { gzipSync, strToU8 } from "fflate";
import { INGEST_LIMITS } from "@codecast/shared/contracts/ingest";
import { sourceForKey } from "./ingest";
import { bumpWindow } from "./ipRateLimit";
import { admitIngestKey, decodeIngestBody, INGEST_PREFIXES, UNKNOWN_KEY_RATE, ingestErrorStatus, ingestKeyFrom, ingestServe, originAllowed } from "./ingestHttp";
import { backoffMs, classifyStatus, DEFAULT_CODECAST_INGEST_ENDPOINT } from "@platform/analytics/codecast";
import { h, world, teamSource } from "./ingest.testkit";

describe("the door's admission", () => {
  const req = (origin?: string) => new Request("https://x/cli/ingest/k", { method: "POST", headers: origin ? { origin } : {} });
  const ctxWith = (source: any, limited: boolean) => ({
    runQuery: async () => source,
    runMutation: async () => (limited ? { ok: false, retry_after_ms: 30_000 } : { ok: true }),
  });
  const rate = { prefix: "ingest", max: 1, window_ms: 60_000 };
  const key = "cc_ing_" + "a".repeat(32);

  test("unknown key 401, refused origin 403, paused 503, limited 429 a browser can read", async () => {
    const source = { _id: "s1", status: "active", allowed_origins: ["https://app.union.dev"] };
    expect(((await admitIngestKey(ctxWith(null, false), req(), key, rate)) as Response).status).toBe(401);
    expect(((await admitIngestKey(ctxWith(source, false), req("https://evil.example"), key, rate)) as Response).status).toBe(403);
    expect(((await admitIngestKey(ctxWith({ ...source, status: "paused" }, false), req("https://app.union.dev"), key, rate)) as Response).status).toBe(503);
    const limited = (await admitIngestKey(ctxWith(source, true), req("https://app.union.dev"), key, rate)) as Response;
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Access-Control-Allow-Origin")).toBe("https://app.union.dev");
    expect(limited.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
    expect(limited.headers.get("Retry-After")).toBe("30");
    const ok = await admitIngestKey(ctxWith(source, false), req("https://app.union.dev"), key, rate);
    expect(ok).toMatchObject({ source: { _id: "s1" }, cors: { "Access-Control-Allow-Origin": "https://app.union.dev" } });
  });
});

describe("guessing keys at the door", () => {
  test("an address runs out of unknown keys, and then even a right one earns nothing until the window passes", async () => {
    const w = world();
    (w.db._tables.ip_rate_limits ??= []);
    const { ingest_key } = await teamSource(w);
    const ctx = {
      runQuery: async (_fn: any, args: any) => h(sourceForKey)(w.internalCtx, args),
      runMutation: async (_fn: any, args: any) => bumpWindow(w.db, args.key, args.max, args.window_ms),
    };
    const from = (ip: string) => new Request("https://x/cli/ingest/k", { method: "POST", headers: { "x-forwarded-for": ip } });
    const rate = { prefix: "ingest", max: 100, window_ms: 60_000 };
    const wrong = (i: number) => "cc_ing_" + String(i).padStart(32, "x");
    for (let i = 0; i < UNKNOWN_KEY_RATE.max; i++) {
      expect(((await admitIngestKey(ctx, from("1.2.3.4"), wrong(i), rate)) as Response).status).toBe(401);
    }
    const spent = (await admitIngestKey(ctx, from("1.2.3.4"), wrong(999), rate)) as Response;
    expect(spent.status).toBe(429);
    expect(Number(spent.headers.get("Retry-After"))).toBeGreaterThan(0);
    // The right key from the spent address is refused before it is looked up.
    expect(((await admitIngestKey(ctx, from("1.2.3.4"), ingest_key, rate)) as Response).status).toBe(429);
    // Another address, and a known key, are untouched.
    expect(await admitIngestKey(ctx, from("5.6.7.8"), ingest_key, rate)).toMatchObject({ source: { status: "active" } });
    expect(((await admitIngestKey(ctx, from("5.6.7.8"), wrong(1), rate)) as Response).status).toBe(401);
    // A known key spends nothing from the window.
    const row = w.db._tables.ip_rate_limits.find((r: any) => r.key === `${UNKNOWN_KEY_RATE.name}:5.6.7.8`);
    expect(row.count).toBe(1);
  });
});

describe("the door", () => {
  test("the key comes from the path on either prefix, else the bearer header", () => {
    expect(ingestKeyFrom("/cli/ingest/cc_ing_abc", null)).toBe("cc_ing_abc");
    expect(ingestKeyFrom("/api/ingest/cc_ing_abc/extra", null)).toBe("cc_ing_abc");
    expect(ingestKeyFrom("/cli/ingest/", "Bearer cc_ing_xyz")).toBe("cc_ing_xyz");
    expect(ingestKeyFrom("/cli/ingest/", null)).toBeNull();
  });

  test("origins: no list allows any, a list allows only its members", () => {
    expect(originAllowed(null, "https://evil.example")).toBe(true);
    expect(originAllowed(["https://app.union.dev/"], "https://app.union.dev")).toBe(true);
    expect(originAllowed(["https://app.union.dev"], "https://evil.example")).toBe(false);
    expect(originAllowed(["https://app.union.dev"], null)).toBe(true);
  });

  test("bodies: plain, gzip, a gzip bomb, junk", () => {
    const body = JSON.stringify({ items: [] });
    expect(decodeIngestBody(strToU8(body), null)).toEqual({ text: body });
    expect(decodeIngestBody(gzipSync(strToU8(body)), "gzip")).toEqual({ text: body });
    const bomb = gzipSync(new Uint8Array(INGEST_LIMITS.max_bytes + 10));
    expect(bomb.byteLength).toBeLessThan(INGEST_LIMITS.max_bytes);
    expect(decodeIngestBody(bomb, "gzip")).toMatchObject({ status: 413 });
    expect(decodeIngestBody(new Uint8Array(INGEST_LIMITS.max_bytes + 1), null)).toMatchObject({ status: 413 });
    expect(decodeIngestBody(strToU8("not gzip"), "gzip")).toMatchObject({ status: 400 });
    expect(decodeIngestBody(strToU8(body), "br")).toMatchObject({ status: 400 });
  });

  test("a paused source asks the SDK to back off, not to stop, so resuming brings it back", async () => {
    const w = world();
    const { ingest_key } = await teamSource(w);
    w.db._tables.event_sources[0].config = { ...w.db._tables.event_sources[0].config, allowed_origins: ["https://app.union.dev"] };
    const serve = (origin: string) =>
      h(ingestServe)(
        { runQuery: async (_fn: any, args: any) => h(sourceForKey)(w.internalCtx, args) },
        new Request(`https://convex.codecast.sh/cli/ingest/${ingest_key}`, { method: "POST", headers: { origin }, body: "{}" }),
      ) as Promise<Response>;
    w.db._tables.event_sources[0].status = "paused";
    const paused = await serve("https://app.union.dev");
    expect(paused.status).toBe(503);
    expect(paused.headers.get("Retry-After")).toBe("60");
    expect(paused.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
    expect(classifyStatus(paused.status)).toBe("retry");
    expect(backoffMs(0, paused.headers.get("Retry-After"))).toBe(60_000);
    // A refused origin never gets better by retrying, so it still stops the SDK.
    const refused = await serve("https://evil.example");
    expect(refused.status).toBe(403);
    expect(classifyStatus(refused.status)).toBe("stop");
  });

  test("the SDK's default endpoint lands on one of the door's prefixes", () => {
    expect(INGEST_PREFIXES).toContain(new URL(DEFAULT_CODECAST_INGEST_ENDPOINT).pathname + "/");
  });

  test("errors map like the CLI routes", () => {
    expect(ingestErrorStatus({ data: { code: "FORBIDDEN" } })).toBe(403);
    expect(ingestErrorStatus({ data: { code: "RATE_LIMITED" } })).toBe(429);
    expect(ingestErrorStatus(new Error("boom"))).toBe(500);
  });
});

