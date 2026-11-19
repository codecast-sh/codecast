import { afterEach, describe, expect, test } from "bun:test";
import { LONG_FRAME_MS, summarizeLongFrame, watchLongFrames, type LongFrameEntry } from "../freezeAttribution";

const frame = (over: Partial<LongFrameEntry> = {}): LongFrameEntry => ({
  startTime: 1_000,
  duration: 1_200,
  blockingDuration: 1_150,
  renderStart: 2_050,
  styleAndLayoutStart: 2_150,
  scripts: [
    {
      duration: 900,
      forcedStyleAndLayoutDuration: 35,
      invoker: "IDBRequest.onsuccess",
      invokerType: "event-listener",
      sourceURL: "https://codecast.sh/assets/dexie-C3W9GgEH.js?v=3#frag",
      sourceFunctionName: "",
      sourceCharPosition: 40587,
    },
    { duration: 140, invoker: "TimerHandler:setTimeout", invokerType: "user-callback", sourceURL: "https://codecast.sh/assets/vendor-CXMc377C.js", sourceFunctionName: "Xs", sourceCharPosition: 9 },
    { duration: 4, invoker: "https://codecast.sh/conversation/jx7secretconversationid?share=abc", invokerType: "classic-script" },
  ],
  ...over,
});

describe("summarizeLongFrame", () => {
  test("a frame under the floor is not written down", () => {
    expect(summarizeLongFrame(frame({ duration: LONG_FRAME_MS - 1 }))).toBeNull();
    expect(summarizeLongFrame(frame({ duration: LONG_FRAME_MS }))).not.toBeNull();
  });

  test("splits the frame into script, rendering and layout", () => {
    const mark = summarizeLongFrame(frame())!;
    expect(mark.ms).toBe(1_200);
    expect(mark.blocking).toBe(1_150);
    // The frame ends at 2,200: rendering began at 2,050, style and layout at 2,150.
    expect(mark.render).toBe(150);
    expect(mark.layout).toBe(50);
    // Every script counts toward the total, the 4 ms one included.
    expect(mark.script).toBe(1_044);
  });

  test("lists the scripts that made the frame long, longest first, each by chunk and position", () => {
    const mark = summarizeLongFrame(frame())!;
    expect(mark.scripts).toEqual([
      { ms: 900, forced: 35, type: "event-listener", by: "IDBRequest.onsuccess", fn: "", src: "dexie-C3W9GgEH.js", at: 40587 },
      { ms: 140, forced: 0, type: "user-callback", by: "TimerHandler:setTimeout", fn: "Xs", src: "vendor-CXMc377C.js", at: 9 },
    ]);
  });

  test("a script URL keeps its file name only, and a page URL is never written", () => {
    const mark = summarizeLongFrame(
      frame({
        scripts: [
          {
            duration: 300,
            invoker: "https://codecast.sh/conversation/jx7secretconversationid?share=abc#x",
            invokerType: "classic-script",
            sourceURL: "https://codecast.sh/share/tokenabc/page.js?key=secret",
          },
        ],
      }),
    )!;
    const text = JSON.stringify(mark);
    // An inline script reports the page URL, whose last segment is an id.
    expect(mark.scripts[0].by).toBe("(page)");
    expect(mark.scripts[0].src).toBe("page.js");
    expect(text).not.toContain("jx7secretconversationid");
    expect(text).not.toContain("share=abc");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("tokenabc");
  });

  test("a frame with no script entries still reports its layout", () => {
    const mark = summarizeLongFrame(frame({ scripts: undefined }))!;
    expect(mark.scripts).toEqual([]);
    expect(mark.script).toBe(0);
    expect(mark.layout).toBe(50);
  });

  test("the worst case fits the recorder's 2,000 character limit for a mark", () => {
    const long = "x".repeat(400);
    const scripts = Array.from({ length: 30 }, (_, i) => ({
      duration: 1_000_000 + i,
      forcedStyleAndLayoutDuration: 999_999,
      invoker: `Some.${long}`,
      invokerType: "resolve-promise",
      sourceURL: `https://codecast.sh/assets/${long}.js`,
      sourceFunctionName: long,
      sourceCharPosition: 123_456_789,
    }));
    const mark = summarizeLongFrame(frame({ duration: 9_999_999, blockingDuration: 9_999_999, scripts }))!;
    expect(mark.scripts).toHaveLength(5);
    expect(JSON.stringify(mark).length).toBeLessThan(2_000);
  });
});

describe("watchLongFrames", () => {
  const original = (globalThis as any).PerformanceObserver;
  afterEach(() => {
    (globalThis as any).PerformanceObserver = original;
  });

  function installObserver(supported: string[]) {
    const state: { deliver?: (entries: LongFrameEntry[]) => void; disconnected: boolean; observed?: unknown } = { disconnected: false };
    (globalThis as any).PerformanceObserver = class {
      static supportedEntryTypes = supported;
      constructor(callback: (list: { getEntries(): LongFrameEntry[] }) => void) {
        state.deliver = (entries) => callback({ getEntries: () => entries });
      }
      observe(options: unknown) { state.observed = options; }
      disconnect() { state.disconnected = true; }
    };
    return state;
  }

  test("does nothing where the browser reports no long animation frames", () => {
    const state = installObserver(["longtask"]);
    const marks: unknown[] = [];
    watchLongFrames((_, data) => marks.push(data))();
    expect(state.observed).toBeUndefined();
    expect(marks).toEqual([]);
  });

  test("marks the longest frame of a batch, at most once a second, until stopped", () => {
    const state = installObserver(["long-animation-frame"]);
    const marks: Array<{ name: string; ms: number }> = [];
    const stop = watchLongFrames((name, data) => marks.push({ name, ms: data.ms as number }));
    expect(state.observed).toEqual({ type: "long-animation-frame", buffered: false });

    state.deliver!([frame({ startTime: 0, duration: 300 }), frame({ startTime: 400, duration: 800 }), frame({ startTime: 1_300, duration: 100 })]);
    expect(marks).toEqual([{ name: "long_frame", ms: 800 }]);

    // 600 ms after the marked frame began: held back.
    state.deliver!([frame({ startTime: 1_000, duration: 2_000 })]);
    expect(marks).toHaveLength(1);

    state.deliver!([frame({ startTime: 1_400, duration: 500 })]);
    expect(marks).toEqual([{ name: "long_frame", ms: 800 }, { name: "long_frame", ms: 500 }]);

    stop();
    expect(state.disconnected).toBe(true);
  });

  test("a recorder that throws does not break the observer", () => {
    const state = installObserver(["long-animation-frame"]);
    let calls = 0;
    watchLongFrames(() => { calls++; throw new Error("stopped"); });
    expect(() => state.deliver!([frame({ startTime: 0 })])).not.toThrow();
    expect(() => state.deliver!([frame({ startTime: 5_000 })])).not.toThrow();
    expect(calls).toBe(2);
  });
});
