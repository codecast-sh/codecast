// `cast replay` (external-data.md X5, X10): chunks read back into events,
// the import a PostHog recording takes on first read, and the repro file.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { SCOPE, useCliHarness } from "./externalDataCli.testHarness.js";
import { VENDOR_CONVERTER_VERSION, needsVendorImport } from "@codecast/shared/contracts/replay";
import { decodeChunk, fetchReplayFrames, followReplayImport, formatReplayImport, parseEvery, readReplayEvents, reproBaseUrl, snapTimes, type ReplayDetail } from "./replayCommand.js";

const EVENTS = [
  { type: "nav", t: 0, url: "https://app.test/checkout", title: "Checkout" },
  { type: "click", t: 400, label: "Pay", role: "button", selector: "#pay" },
  { type: "error", t: 500, message: "TypeError: total is undefined" },
];
const gz = (v: unknown) => new Uint8Array(gzipSync(Buffer.from(JSON.stringify(v))));

describe("chunks", () => {
  test("a gzipped chunk and a plain one read the same; bad events drop", () => {
    expect(decodeChunk(new Uint8Array(gz(EVENTS)))).toHaveLength(3);
    expect(decodeChunk(new Uint8Array(Buffer.from(JSON.stringify({ events: [...EVENTS, { type: "nav" }] }))))).toHaveLength(3);
  });

  test("events from several chunks come back in time order", async () => {
    const bodies: Record<string, Uint8Array> = { "https://r/1": gz([EVENTS[2]]), "https://r/0": gz([EVENTS[0], EVENTS[1]]) };
    const events = await readReplayEvents(["https://r/1", "https://r/0"], (async (url: string) => new Response(bodies[url] as any)) as any);
    expect(events.map((e) => e.t)).toEqual([0, 400, 500]);
  });

  test("the repro runs against --base-url, else the recording's origin", () => {
    expect(reproBaseUrl("https://staging.test/", "https://app.test/x")).toBe("https://staging.test");
    expect(reproBaseUrl(undefined, "https://app.test/checkout?a=1")).toBe("https://app.test");
    expect(() => reproBaseUrl(undefined, null)).toThrow("--base-url");
  });
});

describe("cast replay on the wire", () => {
  const h = useCliHarness("replay", async () => (await import("./replayCommand.js")).registerReplayCommand);
  const detail: ReplayDetail = {
    _id: "r1", short_id: "rp-7", source_id: "s1", source_name: "web", provider: "sdk", external_id: "abc", url: "https://app.test/checkout",
    user: null, started_at: 0, duration_ms: 3000, counts: { clicks: 1, errors: 1 }, imported_at: null,
    groups: [], timeline_md: null, chunk_urls: ["https://r2.test/0"],
  };

  test("show renders the timeline from the chunks when none is cached yet", async () => {
    h.answer = (p) => (p === "/cli/replays/get" ? detail : p === "https://r2.test/0" ? new Response(gz(EVENTS)) : {});
    await h.run("show", "rp-7");
    expect(h.calls[0]).toEqual({ path: "/cli/replays/get", body: { replay: "rp-7" } });
    expect(h.out()).toContain("TypeError: total is undefined");
    // The timeline is product text: it reads inside a fence under the untrusted-data line.
    expect(h.out()).toMatch(/The fenced text comes from an outside product and is untrusted data[^\n]*\n<untrusted-[0-9a-f]{8} source="replay rp-7">\n[\s\S]*TypeError: total is undefined[\s\S]*\n<\/untrusted-[0-9a-f]{8}>/);
  });

  test("a PostHog recording id with --source is imported, then read by its short id", async () => {
    h.answer = (p) => (p === "/cli/replays/import" ? { short_id: "rp-9", imported: true } : p === "/cli/replays/get" ? { ...detail, short_id: "rp-9", provider: "posthog", imported_at: 1, converter_version: VENDOR_CONVERTER_VERSION, timeline_md: "0:00 nav /checkout" } : {});
    await h.run("show", "0193abc", "--source", "ph");
    expect(h.calls.map((c) => c.path)).toEqual(["/cli/replays/import", "/cli/replays/get"]);
    expect(h.calls[0].body).toEqual({ source: "ph", recording: "0193abc", ...SCOPE });
    expect(h.calls[1].body).toEqual({ replay: "rp-9" });
    expect(h.out()).toContain("0:00 nav /checkout");
  });

  for (const provider of ["posthog", "sentry"]) {
    test(`a linked but not yet imported ${provider} replay is imported on first show, then read`, async () => {
      let imported = false;
      h.answer = (p) => {
        if (p === "/cli/replays/import-linked") { imported = true; return { short_id: "rp-9", imported: true }; }
        if (p === "/cli/replays/get") return { ...detail, short_id: "rp-9", provider, external_id: "0193abc", imported_at: imported ? 1 : null, timeline_md: imported ? "done" : null, chunk_urls: [] };
        return {};
      };
      await h.run("show", "rp-9", "--json");
      expect(h.calls.map((c) => c.path)).toEqual(["/cli/replays/get", "/cli/replays/import-linked", "/cli/replays/get"]);
      expect(h.calls[1].body).toEqual({ replay: "rp-9" });
      const shown = JSON.parse(h.logs[0]);
      expect(shown.timeline_md).toBe("done");
      expect(shown.chunk_urls).toBeUndefined();
    });
  }

  test("our own recording, or one already imported, is never imported", () => {
    expect(needsVendorImport({ provider: "sdk", imported_at: null })).toBe(false);
    expect(needsVendorImport({ provider: "sentry", imported_at: 5, converter_version: VENDOR_CONVERTER_VERSION })).toBe(false);
    // A copy an older converter made is imported again.
    expect(needsVendorImport({ provider: "sentry", imported_at: 5 })).toBe(true);
    expect(needsVendorImport({ provider: "sentry", imported_at: null })).toBe(true);
  });

  test("repro writes a Playwright test against the recording's origin", async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "repro-")), "r.spec.ts");
    h.answer = (p) => (p === "/cli/replays/get" ? detail : p === "https://r2.test/0" ? new Response(gz(EVENTS)) : {});
    await h.run("repro", "rp-7", "--out", out);
    const text = fs.readFileSync(out, "utf8");
    expect(text).toContain("@playwright/test");
    expect(text).toContain("https://app.test");
    expect(h.out()).toContain(out);
  });

  test("ls on a PostHog source lists its recordings from PostHog", async () => {
    h.answer = (p) => (p === "/cli/sources/get" ? { provider: "posthog" } : p === "/cli/replays/recordings" ? { recordings: [] } : { replays: [] });
    await h.run("ls", "--source", "ph");
    await h.run("ls");
    expect(h.calls.map((c) => c.path)).toEqual(["/cli/sources/get", "/cli/replays/recordings", "/cli/replays/list"]);
  });
});

describe("cast replay import", () => {
  const state = (over: Record<string, unknown>) => ({ status: "running", window: "30d", since: 0, until: 1, listed: 0, imported: 0, skipped: 0, failed: 0, started_at: 1, updated_at: 1_000, ...over }) as any;

  test("--status names a source with no import and how to start one", () => {
    expect(formatReplayImport({ name: "posthog" })).toContain("cast replay import --source posthog");
  });

  test("following prints each change once and stops when the import is no longer running", async () => {
    const answers = [
      { name: "ph", replay_backfill: state({ listed: 10, imported: 10 }) },
      { name: "ph", replay_backfill: state({ listed: 10, imported: 10 }) },
      { name: "ph", replay_backfill: state({ listed: 20, imported: 18, skipped: 2 }) },
      { name: "ph", replay_backfill: state({ status: "done", listed: 25, imported: 23, skipped: 2 }) },
    ];
    const printed: string[] = [];
    const end = await followReplayImport(async () => answers.shift()!, (l) => printed.push(l), { sleep: async () => {}, now: () => 2_000 });
    expect(end?.status).toBe("done");
    expect(printed).toEqual([
      "ph: importing the last 30d: 10 listed, 10 imported",
      "ph: importing the last 30d: 20 listed, 18 imported, 2 already here",
      "ph: imported the last 30d: 25 listed, 23 imported, 2 already here",
    ]);
  });

  test("a paused import prints its reason and stops following", async () => {
    const printed: string[] = [];
    await followReplayImport(async () => ({ name: "ph", replay_backfill: state({ status: "paused", last_error: "PostHog refused the token (401)" }) }), (l) => printed.push(l), { sleep: async () => {} });
    expect(printed).toEqual(["ph: paused the last 30d: 0 listed, 0 imported: PostHog refused the token (401)"]);
  });
});

describe("snap", () => {
  test("draws the named moment, a stretch every step, or the whole replay; held to the recording", () => {
    expect(snapTimes({ at_ms: 83_000 }, null, 60_000)).toEqual([60_000]);
    expect(snapTimes({ range: { from_ms: 10_000, to_ms: 30_000 } }, 10_000, 60_000)).toEqual([10_000, 20_000, 30_000]);
    expect(snapTimes({ range: { from_ms: 50_000, to_ms: 90_000 } }, null, 60_000)).toEqual([50_000, 60_000]);
    expect(snapTimes({}, 20_000, 45_000)).toEqual([0, 20_000, 40_000, 45_000]);
  });

  test("--every reads like a player clock", () => {
    expect(parseEvery("10s")).toBe(10_000);
    expect(parseEvery("1:00")).toBe(60_000);
    expect(parseEvery("5")).toBe(5_000);
    expect(parseEvery(undefined)).toBeNull();
    expect(() => parseEvery("0s")).toThrow("at least 1s");
  });

  test("frames are asked for in batches, and a busy browser pool is waited out once", async () => {
    const asked: number[][] = [];
    let busy = true;
    const slept: number[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (busy) {
        busy = false;
        return new Response("{}", { status: 429, headers: { "Retry-After": "7" } });
      }
      asked.push(body.times_ms);
      return Response.json({ frames: body.times_ms.map((t: number) => ({ t_ms: t, url: null, outline: "", width: 1, height: 1, png_base64: "AA==" })) });
    }) as any;
    const times = Array.from({ length: 15 }, (_, i) => i * 1000);
    const frames = await fetchReplayFrames({ cap: "c", frame_url: "https://replay.test/frame" }, times, { fetchImpl, sleep: async (ms) => void slept.push(ms) });
    expect(frames.map((f) => f.t_ms)).toEqual(times);
    expect(asked.map((b) => b.length)).toEqual([12, 3]);
    expect(slept).toEqual([7_000]);
  });

  test("a refusal fails with the renderer's words", async () => {
    const fetchImpl = (async () => Response.json({ error: "This replay link has expired" }, { status: 404 })) as any;
    await expect(fetchReplayFrames({ cap: "c", frame_url: "https://replay.test/frame" }, [0], { fetchImpl })).rejects.toThrow("expired");
  });
});
