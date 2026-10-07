import { describe, expect, test } from "bun:test";
import worker, { handleFrame, playerCsp, validateFrameRequest, type Env } from "./worker";
import { REPLAY_FRAME_LIMITS } from "../../../packages/shared/contracts/replayPlayer";

const env = { BROWSER: {} as Env["BROWSER"], CONVEX_ORIGIN: "https://convex.test" } as Env;
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
    expect(csp).toContain("connect-src https://convex.test https://*.r2.cloudflarestorage.com");
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
    const csp = playerCsp("https://convex.codecast.sh");
    const script = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(script).toBe("script-src 'self'");
    expect(csp).toContain("default-src 'none'");
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
    expect(calls).toEqual(["https://convex.test/cli/replays/player?cap=dead"]);
  });

  test("a live one renders, and a busy browser pool reads as a retry", async () => {
    const ok = (async () => new Response("{}", { status: 200 })) as any;
    const frames = [{ t_ms: 0, png_base64: "AA==", url: "https://shop.test/", outline: "Cart", width: 800, height: 600 }];
    const res = await handleFrame(post({ cap: "live", times_ms: [0] }), env, { fetch: ok, render: async () => frames });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ frames });
    const busy = await handleFrame(post({ cap: "live", times_ms: [0] }), env, { fetch: ok, render: async () => { throw new Error("Rate limit exceeded"); } });
    expect(busy.status).toBe(429);
    expect(busy.headers.get("Retry-After")).toBe("60");
  });
});
