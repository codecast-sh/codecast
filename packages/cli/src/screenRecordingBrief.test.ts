import { describe, expect, test } from "bun:test";
import { formatScreenRecordingMessage, framedLines, lineMomentMs, parseScreenRecordingMessage } from "@codecast/shared/contracts";
import { expandScreenRecording, screenRecordingForDelivery, SCREEN_RECORDING_WORDS_WAIT_MS, type ScreenRecordingCall } from "./screenRecordingBrief";

const sent = formatScreenRecordingMessage({ call: "cl-12", durationMs: 42_000 }, "fix this please");

function call(over: Partial<ScreenRecordingCall> = {}): ScreenRecordingCall {
  return {
    short_id: "cl-12",
    started_at: 1_000_000,
    ended_at: 1_042_000,
    transcribe_status: "done",
    screen: { no_audio: false },
    segments: [
      { t0: 1000, t1: 5000, text: "The send button does nothing." },
      { t0: 6000, t1: 10_000, text: "And this title here is cut off." },
    ],
    ...over,
  };
}

describe("screen recording message", () => {
  test("the sent message parses back to its call and caption", () => {
    expect(parseScreenRecordingMessage(sent)).toEqual({ call: "cl-12", transcriptId: null, durationMs: 42_000, caption: "fix this please", lines: [] });
    expect(parseScreenRecordingMessage("just text")).toBeNull();
  });

  test("a pointing word moves the frame to it", () => {
    const s = { t0: 0, t1: 10_000, text: "Look at the bottom, this one" };
    expect(lineMomentMs(s)).toBeGreaterThan(lineMomentMs({ ...s, text: "nothing to point at in here!" }) - 9000);
    expect(lineMomentMs({ t0: 0, t1: 10_000, text: "plain words only" })).toBe(5000);
  });

  test("past the cap, pointing lines keep their pictures", () => {
    const segs = Array.from({ length: 30 }, (_, i) => ({ t0: i * 1000, t1: i * 1000 + 900, text: i === 25 ? "this is broken" : "words" }));
    const picked = framedLines(segs, 6);
    expect(picked).toHaveLength(6);
    expect(picked).toContain(25);
  });
});

describe("expandScreenRecording", () => {
  test("writes timed lines with a frame each", async () => {
    const asked: number[] = [];
    const out = await expandScreenRecording(sent, {
      getCall: async () => call(),
      frameAt: async (_c, ms) => {
        asked.push(ms);
        return `/tmp/f-${ms}.png`;
      },
    }, 0);
    expect(out.kind).toBe("ready");
    if (out.kind !== "ready") return;
    expect(out.frames).toBe(2);
    expect(out.text).toContain("[0:01] The send button does nothing. [Image /tmp/f-3000.png]");
    expect(out.text).toContain("[0:06] And this title here is cut off. [Image");
    expect(out.text.endsWith("fix this please")).toBe(true);
    // The agent's copy is still a screen recording to every surface, now with its lines.
    const back = parseScreenRecordingMessage(out.text)!;
    expect(back.call).toBe("cl-12");
    expect(back.lines.map((l) => l.text)).toEqual(["The send button does nothing.", "And this title here is cut off."]);
    expect(back.caption).toBe("fix this please");
    // The pointing word ("this") sits before the line's middle.
    expect(asked[1]).toBeLessThan(8000);
  });

  test("waits on the words, then sends what it has", async () => {
    const deps = { getCall: async () => call({ transcribe_status: "pending", segments: [], filmed: true }), frameAt: async () => "/tmp/open.png" };
    expect((await expandScreenRecording(sent, deps, 0)).kind).toBe("wait");
    // A video still uploading is waited on longer: its words cannot start yet.
    const uploading = { ...deps, getCall: async () => call({ transcribe_status: "pending", segments: [], filmed: false }) };
    expect((await expandScreenRecording(sent, uploading, SCREEN_RECORDING_WORDS_WAIT_MS + 1)).kind).toBe("wait");
    const late = await expandScreenRecording(sent, deps, SCREEN_RECORDING_WORDS_WAIT_MS + 1);
    expect(late.kind).toBe("ready");
    if (late.kind === "ready") expect(late.text).toContain("still being transcribed");
  });

  test("a silent video says the microphone was off", async () => {
    const out = await expandScreenRecording(sent, {
      getCall: async () => call({ transcribe_status: "failed", segments: [], screen: { no_audio: true } }),
      frameAt: async () => "/tmp/open.png",
    }, 0);
    expect(out.kind === "ready" && out.text).toContain("microphone was off");
    expect(out.kind === "ready" && out.text).toContain("[Image /tmp/open.png]");
  });

  test("an already expanded copy and other messages pass through", async () => {
    const deps = { getCall: async () => call(), frameAt: async () => null };
    const first = await expandScreenRecording(sent, deps, 0);
    expect(first.kind).toBe("ready");
    if (first.kind === "ready") expect((await expandScreenRecording(first.text, deps, 0)).kind).toBe("unchanged");
    expect((await expandScreenRecording("hello", deps, 0)).kind).toBe("unchanged");
  });
});

describe("screenRecordingForDelivery", () => {
  const slowCall = (n: number) =>
    call({ segments: Array.from({ length: n }, (_, i) => ({ t0: i * 1000, t1: i * 1000 + 900, text: `this is line ${i}` })) });

  test("a 12-frame cut never holds the delivery loop, and the copy is there on a later pass", async () => {
    let cut = 0;
    const deps = {
      getCall: async () => slowCall(12),
      // 2 s a frame in production; 40 ms here keeps the test short while
      // still taking ~0.5 s for the whole cut.
      frameAt: async (_c: string, ms: number) => { await new Promise((r) => setTimeout(r, 40)); cut++; return `/tmp/f-${ms}.png`; },
    };
    const t0 = performance.now();
    const first = screenRecordingForDelivery("m1", sent, Date.now(), { siteUrl: null, apiToken: null }, undefined, deps);
    const firstMs = performance.now() - t0;
    expect(first).toEqual({ wait: true });
    expect(firstMs).toBeLessThan(20);
    // An unrelated message delivered during the cut answers at once.
    const t1 = performance.now();
    expect(screenRecordingForDelivery("m2", "plain words", Date.now(), { siteUrl: null, apiToken: null }, undefined, deps)).toEqual({ wait: false, content: "plain words" });
    expect(performance.now() - t1).toBeLessThan(5);
    // Rechecks while cutting stay waits, and cost nothing.
    expect(screenRecordingForDelivery("m1", sent, Date.now(), { siteUrl: null, apiToken: null }, undefined, deps)).toEqual({ wait: true });
    expect(cut).toBeLessThan(12);
    while (cut < 12) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 10));
    const done = screenRecordingForDelivery("m1", sent, Date.now(), { siteUrl: null, apiToken: null }, undefined, deps);
    expect(done.wait).toBe(false);
    if (!done.wait) expect(done.content.match(/\[Image \//g)).toHaveLength(12);
  });

  test("words still being read: the job is dropped and asked again on the next pass", async () => {
    let asked = 0;
    const deps = { getCall: async () => { asked++; return call({ transcribe_status: "pending", segments: [], filmed: true }); }, frameAt: async () => null };
    expect(screenRecordingForDelivery("m3", sent, Date.now(), { siteUrl: null, apiToken: null }, undefined, deps).wait).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(screenRecordingForDelivery("m3", sent, Date.now(), { siteUrl: null, apiToken: null }, undefined, deps).wait).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toBe(2);
  });
});
