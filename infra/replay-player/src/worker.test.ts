import { describe, expect, test } from "bun:test";
import worker, { frameRequestAllowed, handleFrame, playerCsp, replaysBucket, validateFrameRequest, type Env } from "./worker";
import { remoteAssetHosts, remoteAssetsLabel } from "./remoteAssets";
import { REPLAY_FRAME_LIMITS } from "../../../packages/shared/contracts/replayPlayer";

const BUCKET = "https://acct.r2.cloudflarestorage.com/codecast-replays/";
const env = { BROWSER: {} as Env["BROWSER"], CONVEX_ORIGIN: "https://convex.test", REPLAYS_BUCKET_URL: BUCKET } as Env;
const get = (path: string) => worker.fetch(new Request(`https://replay.codecast.sh${path}`), env);
const post = (body: unknown) => new Request("https://replay.codecast.sh/frame", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

describe("the player page", () => {
  test("is served for any capability, never cached, never sends a referrer, and runs only its own script", async () => {
    const res = await get("/p/abc.def?t=1000");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain(`connect-src https://convex.test ${BUCKET}`);
    expect(csp).not.toContain("*.r2");
    expect(csp).not.toContain("unsafe-eval");
    const html = await res.text();
    expect(html).toContain('data-manifest-origin="https://convex.test"');
    expect(html).toContain('<script src="/player.js"></script>');
  });

  test("anything else is not found", async () => {
    expect((await get("/")).status).toBe(404);
    expect((await get("/p/")).status).toBe(404);
    expect((await get("/frame")).status).toBe(405);
  });

  test("the CSP never lets a script in from elsewhere", () => {
    const csp = playerCsp("https://convex.codecast.sh", BUCKET);
    const script = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(script).toBe("script-src 'self'");
    expect(csp).toContain("default-src 'none'");
  });

  test("nothing remote loads unless the viewer opted in on this view, and frame mode never does", async () => {
    const remoteDirectives = (csp: string) => ["style-src", "img-src", "font-src", "media-src"].map((d) => csp.split("; ").find((x) => x.startsWith(d))!);
    const interactive = (await get("/p/abc.def?t=1000")).headers.get("Content-Security-Policy")!;
    for (const d of remoteDirectives(interactive)) expect(d).not.toContain("https:");
    const frame = (await get("/p/abc.def?t=1000&mode=frame&assets=remote")).headers.get("Content-Security-Policy")!;
    for (const d of remoteDirectives(frame)) expect(d).not.toContain("https:");
    const optedIn = (await get("/p/abc.def?t=1000&assets=remote")).headers.get("Content-Security-Policy")!;
    expect(optedIn).toContain("img-src https: data: blob:");
    expect(optedIn).not.toContain("http:");
    expect(optedIn).toContain("script-src 'self';");
  });

  test("an unset or malformed bucket reads from no bucket", () => {
    expect(playerCsp("https://convex.test", undefined)).toContain("connect-src https://convex.test;");
    expect(replaysBucket("https://acct.r2.cloudflarestorage.com")).toBeNull();
    expect(replaysBucket("http://acct.r2.cloudflarestorage.com/b/")).toBeNull();
    expect(replaysBucket("https://acct.r2.cloudflarestorage.com/b")).toEqual({ origin: "https://acct.r2.cloudflarestorage.com", prefix: "/b/" });
  });
});

describe("the remote assets a capture names", () => {
  test("what a browser would fetch, never a link's target", () => {
    const events = [
      { type: 4, data: { href: "https://shop.example/cart" } },
      { type: 2, data: { node: { type: 0, childNodes: [
        { type: 2, tagName: "img", attributes: { src: "https://cdn.example/a.png", srcset: "https://img2.example/a.png 2x" }, childNodes: [] },
        { type: 2, tagName: "a", attributes: { href: "https://elsewhere.example/" }, childNodes: [] },
        { type: 2, tagName: "link", attributes: { rel: "stylesheet", href: "https://css.example/s.css", _cssText: "@font-face{src:url(https://fonts.example/f.woff2)}" }, childNodes: [] },
        { type: 2, tagName: "div", attributes: { style: "background:url('https://bg.example/b.jpg')" }, childNodes: [] },
        { type: 2, tagName: "style", attributes: {}, childNodes: [{ type: 3, isStyle: true, textContent: "@import 'https://imp.example/x.css';" }] },
        { type: 2, tagName: "img", attributes: { src: "data:image/png;base64,AA==" }, childNodes: [] },
      ] } } },
      { type: 3, data: { source: 0, adds: [{ node: { type: 2, tagName: "img", attributes: { src: "https://late.example/l.png" }, childNodes: [] } }] } },
    ];
    expect(remoteAssetHosts(events).sort()).toEqual(["bg.example", "cdn.example", "css.example", "fonts.example", "img2.example", "imp.example", "late.example"]);
    expect(remoteAssetsLabel(["cdn.example"])).toBe("Load images from cdn.example");
    expect(remoteAssetsLabel(["cdn.example", "a", "b"])).toBe("Load images from cdn.example and 2 other sites");
    expect(remoteAssetsLabel([])).toBe("");
  });
});

describe("what the frame renderer's browser may fetch", () => {
  const origins = { player: "https://replay.codecast.sh", convex: "https://convex.codecast.sh", bucket: BUCKET };
  test("the player, Convex, the replays bucket and inline data", () => {
    for (const u of [
      "https://replay.codecast.sh/p/cap?mode=frame",
      "https://replay.codecast.sh/player.js",
      "https://convex.codecast.sh/cli/replays/player?cap=x",
      "https://acct.r2.cloudflarestorage.com/codecast-replays/replays/s/r/dom/0-abc.json.gz?X-Amz-Signature=1",
      "data:image/png;base64,AA==",
      "blob:https://replay.codecast.sh/1234",
      "about:blank",
    ]) expect(frameRequestAllowed(u, origins)).toBe(true);
  });
  test("no bucket at all when the worker is not told which", () => {
    expect(frameRequestAllowed("https://acct.r2.cloudflarestorage.com/codecast-replays/x", { ...origins, bucket: undefined })).toBe(false);
  });
  test("never a host a recording names", () => {
    for (const u of [
      "https://shop.example/logo.png",
      "http://169.254.169.254/latest/meta-data",
      "https://evil.example/@import.css",
      "https://r2.cloudflarestorage.com.evil.example/x",
      "https://other-acct.r2.cloudflarestorage.com/codecast-replays/x",
      "https://acct.r2.cloudflarestorage.com/someone-elses-bucket/x",
      "https://acct.r2.cloudflarestorage.com/codecast-replays-evil/x",
      "http://acct.r2.cloudflarestorage.com/x",
      "ftp://x",
      "not a url",
    ]) expect(frameRequestAllowed(u, origins)).toBe(false);
  });
});

describe("frames", () => {
  test("a request is checked before anything runs", () => {
    expect(validateFrameRequest({ cap: "c", times_ms: [5000, 0] })).toEqual({ cap: "c", times_ms: [0, 5000] });
    expect(validateFrameRequest({ cap: "c", times_ms: [] })).toContain("at least one");
    expect(validateFrameRequest({ cap: "c", times_ms: [-1] })).toContain("0 or more");
    expect(validateFrameRequest({ cap: "", times_ms: [1] })).toContain("cap");
    expect(validateFrameRequest({ cap: "c", times_ms: Array(REPLAY_FRAME_LIMITS.max_frames_per_request + 1).fill(0) })).toContain("at most");
  });

  test("a capability Convex refuses starts no browser", async () => {
    let rendered = false;
    const calls: string[] = [];
    const res = await handleFrame(post({ cap: "dead", times_ms: [0] }), env, {
      fetch: (async (url: string) => (calls.push(url), new Response("{}", { status: 404 }))) as any,
      render: async () => ((rendered = true), []),
    });
    expect(res.status).toBe(404);
    expect(rendered).toBe(false);
    expect(calls).toEqual(["https://convex.test/cli/replays/frame-admit"]);
  });

  test("a capability past its frame budget starts no browser and says when to come back", async () => {
    let rendered = false;
    const res = await handleFrame(post({ cap: "spent", times_ms: [0] }), env, {
      fetch: (async () => new Response("{}", { status: 429, headers: { "Retry-After": "420" } })) as any,
      render: async () => ((rendered = true), []),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("420");
    expect(rendered).toBe(false);
  });

  test("a live one renders, and a busy browser pool reads as a retry", async () => {
    const ok = (async () => new Response(null, { status: 204 })) as any;
    const frames = [{ t_ms: 0, png_base64: "AA==", url: "https://shop.test/", outline: "Cart", width: 800, height: 600 }];
    const res = await handleFrame(post({ cap: "live", times_ms: [0] }), env, { fetch: ok, render: async () => frames });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ frames });
    const busy = await handleFrame(post({ cap: "live", times_ms: [0] }), env, { fetch: ok, render: async () => { throw new Error("Rate limit exceeded"); } });
    expect(busy.status).toBe(429);
    expect(busy.headers.get("Retry-After")).toBe("60");
  });
});
