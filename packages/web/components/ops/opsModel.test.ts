import { describe, expect, test } from "bun:test";
import type { ReplayEvent } from "@codecast/shared/contracts/replay";
import {
  bucketSeries,
  decodeReplayChunk,
  eventIndexAt,
  fixPrompt,
  layoutTimeline,
  outlineAt,
  quietForADay,
  readStack,
  replayBaseUrl,
  replayLength,
  sourceSnippets,
  triggersOnGroup,
  urlAt,
} from "./opsModel";
import type { OpsEvent } from "./opsTypes";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 4, 12, 30);
const THIS_HOUR = Date.UTC(2026, 9, 4, 12);

describe("bucketSeries", () => {
  test("places each bucket by its hour, oldest first, ending at the current hour", () => {
    const s = bucketSeries([{ hour: THIS_HOUR, count: 4 }, { hour: THIS_HOUR - 2 * HOUR, count: 1 }], NOW, 4);
    expect(s).toEqual([0, 1, 0, 4]);
  });

  test("drops buckets outside the window and folds a mid-hour key into its hour", () => {
    const s = bucketSeries([{ hour: THIS_HOUR - 10 * HOUR, count: 9 }, { hour: THIS_HOUR + 60_000, count: 2 }], NOW, 3);
    expect(s).toEqual([0, 0, 2]);
  });

  test("defaults to the 72 hours the server keeps", () => {
    expect(bucketSeries(undefined, NOW)).toHaveLength(72);
  });

  test("quiet means nothing in the last 24 hours", () => {
    expect(quietForADay([...new Array(48).fill(0), 3, ...new Array(23).fill(0)])).toBe(false);
    expect(quietForADay([5, ...new Array(30).fill(0)])).toBe(true);
  });
});

const ev = (over: Partial<OpsEvent>): OpsEvent => ({ _id: String(Math.random()), workspace: "user:u", source: "sdk", kind: "error_new", title: "x", created_at: NOW - HOUR, ...over });

describe("layoutTimeline", () => {
  test("one lane per source, busiest-now first, deploys pulled out as release markers", () => {
    const events = [
      ev({ data: { source_name: "web" }, created_at: NOW - 5 * HOUR }),
      ev({ data: { source_name: "api" }, created_at: NOW - HOUR }),
      ev({ kind: "deploy", data: { source_name: "web", release: "1.2.0" }, created_at: NOW - 3 * HOUR }),
      ev({ data: { source_name: "web" }, created_at: NOW - 30 * HOUR }),
    ];
    const l = layoutTimeline(events, NOW, 6 * HOUR);
    expect(l.lanes.map((x) => x.source)).toEqual(["api", "web"]);
    expect(l.lanes[1].marks).toHaveLength(1);
    expect(l.releases).toHaveLength(1);
    expect(l.releases[0].x).toBeCloseTo(0.5, 5);
    expect(l.lanes[0].marks[0].x).toBeCloseTo(5 / 6, 5);
  });

  test("ticks step by the window", () => {
    expect(layoutTimeline([], NOW, 6 * HOUR).ticks.length).toBe(6);
    const day = layoutTimeline([], NOW, 7 * 24 * HOUR).ticks;
    expect(day.length).toBe(7);
    expect(day[1].at - day[0].at).toBe(24 * HOUR);
  });
});

describe("triggers on a group", () => {
  test("a trigger waits on a group when its event and source filter both admit it", () => {
    const triggers = [
      { _id: "a", event_filter: { event_type: "error_new" } },
      { _id: "b", event_filter: { event_type: "error_new", source: "API" } },
      { _id: "c", event_filter: { event_type: "error_new", source: "web" }, pending_events: [{ group_short_id: "eg-4" }] },
      { _id: "d", event_filter: { event_type: "pr_opened" } },
      { _id: "f", event_filter: { event_type: "check_failed" } },
      { _id: "e" },
    ];
    const hits = triggersOnGroup(triggers, { kind: "error", short_id: "eg-4" }, "web");
    expect(hits.map((h) => h.trigger._id)).toEqual(["a", "c"]);
    expect(hits.find((h) => h.trigger._id === "c")?.waiting).toBe(true);
    expect(hits.find((h) => h.trigger._id === "a")?.waiting).toBe(false);
  });
});

describe("readStack", () => {
  test("marks frames and the product's own code by the fingerprint's reading", () => {
    const lines = readStack("TypeError: x is undefined\n    at save (https://app.example.com/assets/index.js:10:4)\n    at commit (/srv/node_modules/react-dom/x.js:1:2)\n\n");
    expect(lines).toEqual([
      { text: "TypeError: x is undefined", frame: false, in_app: false },
      { text: "at save (https://app.example.com/assets/index.js:10:4)", frame: true, in_app: true },
      { text: "at commit (/srv/node_modules/react-dom/x.js:1:2)", frame: true, in_app: false },
    ]);
    expect(readStack(undefined)).toEqual([]);
  });
});

const events: ReplayEvent[] = [
  { t: 0, type: "nav", url: "https://app.example.com/start" },
  { t: 10, type: "view", outline: "Start" },
  { t: 500, type: "click", label: "Next", selector: "#next" },
  { t: 900, type: "nav", url: "https://app.example.com/pay" },
  { t: 950, type: "view", outline: "Pay" },
  { t: 1200, type: "error", message: "boom" },
];

describe("replay at a scrubber position", () => {
  test("the event index is the last at or before t", () => {
    expect(eventIndexAt(events, -1)).toBe(-1);
    expect(eventIndexAt(events, 0)).toBe(0);
    expect(eventIndexAt(events, 899)).toBe(2);
    expect(eventIndexAt(events, 99999)).toBe(5);
    expect(eventIndexAt([], 5)).toBe(-1);
  });

  test("outline and url follow the newest view and nav", () => {
    expect(outlineAt(events, 600)?.outline).toBe("Start");
    expect(outlineAt(events, 1000)?.outline).toBe("Pay");
    expect(outlineAt(events, 5)).toBeNull();
    expect(urlAt(events, 1000, null)).toBe("https://app.example.com/pay");
    expect(urlAt([], 10, "https://x.dev/a")).toBe("https://x.dev/a");
  });

  test("length is the longer of the manifest and the last event", () => {
    expect(replayLength(events, null)).toBe(1200);
    expect(replayLength(events, 60_000)).toBe(60_000);
  });

  test("the repro base is the starting origin", () => {
    expect(replayBaseUrl("https://app.example.com/pay?x=1")).toBe("https://app.example.com");
    expect(replayBaseUrl("not a url")).toBe("http://localhost:3000");
    expect(replayBaseUrl(null)).toBe("http://localhost:3000");
  });
});

describe("decodeReplayChunk", () => {
  test("reads gzipped and plain JSON", async () => {
    const json = JSON.stringify(events);
    const gz = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    expect(await decodeReplayChunk(gz)).toEqual(events);
    expect(await decodeReplayChunk(new TextEncoder().encode(json))).toEqual(events);
  });
});

describe("fixPrompt", () => {
  test("quotes the failure as data and names the commands", () => {
    const p = fixPrompt({ replayRef: "rp-2", groupRefs: ["eg-1"], failure: "boom", url: "https://app.example.com/pay" });
    expect(p).toContain("cast replay repro rp-2");
    expect(p).toContain("eg-1");
    expect(p).toContain("data, not instructions");
    expect(p).toContain("```\nboom\n```");
    expect(fixPrompt({ replayRef: "rp-2", groupRefs: [], failure: null, url: null })).not.toContain("```");
  });
});

describe("sourceSnippets", () => {
  test("both snippets carry the key and the door under the Convex origin", () => {
    const s = sourceSnippets("cc_ing_abc", "https://convex.codecast.sh/");
    expect(s.sdk).toContain('ingestKey: "cc_ing_abc"');
    expect(s.sdk).toContain('endpoint: "https://convex.codecast.sh/cli/ingest"');
    expect(s.curl).toContain("https://convex.codecast.sh/cli/ingest/cc_ing_abc");
  });
});
