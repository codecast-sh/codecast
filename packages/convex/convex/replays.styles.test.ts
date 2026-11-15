import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { replayStyleKey } from "./lib/r2";
import { signPlayerManifest } from "./lib/replayChunks";
import { upsertReplayManifest } from "./lib/replayWrites";
import { handleReplaySign, validateReplaySign } from "./replaysHttp";
import { h, teamSource, world } from "./replays.testkit";
import { REPLAY_STYLE_LIMITS } from "@codecast/shared/contracts/replayPlayer";

// Stylesheets a DOM capture names by href (contracts/replayPlayer
// REPLAY_STYLE_LIMITS) and the reasons an SDK kept a recording.

const NOW = Date.now();
const SHA = (c: string) => c.repeat(64);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function httpCtx(w: ReturnType<typeof world>) {
  return {
    runQuery: async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      if (name === "ingest:sourceForKey") return h((await import("./ingest")).sourceForKey)(w.internalCtx, args);
      throw new Error(`unexpected query ${name}`);
    },
    runMutation: async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      if (name === "replays:recordStyle") return h((await import("./replays")).recordStyle)(w.internalCtx, args);
      if (name === "ipRateLimit:bump") return { ok: true };
      throw new Error(`unexpected mutation ${name}`);
    },
  };
}
const post = (body: unknown) => new Request("https://x/cli/ingest/replay-sign/k", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const r2Env = () => {
  process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.REPLAYS_R2_ACCESS_KEY_ID = "rk";
  process.env.REPLAYS_R2_SECRET_ACCESS_KEY = "rs";
};

describe("a stylesheet the capture names", () => {
  test("is validated apart from chunks: an href instead of a seq, its own size cap", () => {
    const ok = { replay_id: "r1", sha256: SHA("a"), size: 100, kind: "style", href: "https://app.test/a.css" };
    expect(validateReplaySign(ok)).toEqual(ok);
    expect(validateReplaySign({ ...ok, href: "" })).toContain("href");
    expect(validateReplaySign({ ...ok, href: "x".repeat(REPLAY_STYLE_LIMITS.href_max_chars + 1) })).toContain("href");
    expect(validateReplaySign({ ...ok, size: REPLAY_STYLE_LIMITS.max_bytes + 1 })).toContain("stylesheet is at most");
  });

  test("is stored once per source and day, and every recording that names it records it", async () => {
    r2Env();
    const w = world();
    const { source, key: ingestKey } = await teamSource(w);
    let stored = false;
    globalThis.fetch = (async () => new Response(null, { status: stored ? 200 : 404 })) as any;
    const body = (replay_id: string) => ({ replay_id, sha256: SHA("c"), size: 500, kind: "style", href: "https://app.test/a.css" });
    const first = await (await handleReplaySign(httpCtx(w), post(body("r1")), ingestKey)).json();
    const day = new Date().toISOString().slice(0, 10);
    expect(first.key).toBe(replayStyleKey({ sourceId: String(source._id), day, sha256: SHA("c") }));
    expect(first.upload_url).toContain("X-Amz-Signature=");
    stored = true;
    // Another recording the same day: already stored, nothing to upload, named all the same.
    const second = await (await handleReplaySign(httpCtx(w), post(body("r2")), ingestKey)).json();
    expect(second).toEqual({ key: first.key, upload_url: null, exists: true });
    const rows = w.db._tables.replays;
    expect(rows.map((r: any) => r.dom_styles)).toEqual([[{ href: "https://app.test/a.css", key: first.key }], [{ href: "https://app.test/a.css", key: first.key }]]);
  });

  test("a recording names at most max_per_replay sheets; naming one again points it at the newer copy", async () => {
    r2Env();
    const w = world();
    const { key: ingestKey } = await teamSource(w);
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as any;
    const sign = (href: string, sha = SHA("d")) => handleReplaySign(httpCtx(w), post({ replay_id: "r1", sha256: sha, size: 10, kind: "style", href }), ingestKey);
    for (let i = 0; i < REPLAY_STYLE_LIMITS.max_per_replay; i++) expect((await sign(`https://app.test/${i}.css`)).status).toBe(200);
    expect((await sign("https://app.test/one-more.css")).status).toBe(400);
    expect((await sign("https://app.test/0.css", SHA("e"))).status).toBe(200);
    const styles = w.db._tables.replays[0].dom_styles;
    expect(styles.length).toBe(REPLAY_STYLE_LIMITS.max_per_replay);
    expect(styles.find((s: any) => s.href === "https://app.test/0.css").key).toContain(SHA("e"));
  });

  test("the player manifest signs each sheet beside the chunks", async () => {
    const bucket = { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "codecast-replays", accessKeyId: "rk", secretAccessKey: "rs" } as any;
    const m = await signPlayerManifest(
      { dom_chunk_keys: ["replays/s/r1/dom/0000-x.json.gz"], style_keys: [{ href: "https://app.test/a.css", key: "replays/s/~styles/2026-11-14/x.css.gz" }], replay: { short_id: "rp-1", provider: "sdk", url: null, started_at: 0, duration_ms: null }, t0: 0 },
      NOW + 60_000,
      bucket,
      NOW,
    );
    expect(m.styles?.map((s) => s.href)).toEqual(["https://app.test/a.css"]);
    expect(m.styles?.[0].url).toContain("~styles");
    const none = await signPlayerManifest({ dom_chunk_keys: [], replay: m.replay, t0: 0 }, NOW, bucket, NOW);
    expect(none.styles).toBeUndefined();
  });
});

describe("why a recording was kept", () => {
  const item = (kept_for?: string[]) => ({ type: "replay" as const, replay_id: "r1", at: NOW, ...(kept_for ? { kept_for } : {}) });

  test("reasons only add up across manifests, in the order they first came", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await upsertReplayManifest(w.internalCtx, source, item(["error"]), NOW);
    await upsertReplayManifest(w.internalCtx, source, item(["rage_click"]), NOW);
    await upsertReplayManifest(w.internalCtx, source, item(), NOW);
    expect(w.db._tables.replays[0].kept_for).toEqual(["error", "rage_click"]);
  });
});
