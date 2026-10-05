// The lane model for one Multiplayer sim run (simLanes.ts), held to what the
// real artifacts mean: rows below are copied from a real failing run's
// events.jsonl (u11ShrinkProbe interleave 968891), whose ids are synthetic.

import { describe, expect, it } from "bun:test";
import type { SimEvent } from "@codecast/shared/contracts/evalsApi";
import { buildTimeline, failIndex, keptIndexes, parseChannel, rowDiffSides, shrinkCaption, splitRowDiff, stepLabels, traceLabels, type StepBand } from "./simLanes";
import { SimLabels, traceMatches } from "../../store/__tests__/sim/labels";

const REAL: SimEvent[] = [
  { channel: "live:bo-host:inbox", due: 1800000025000, label: "push conversations:listInboxSessions", producer: "bo-host inbox", seq: 3 },
  { channel: "conn:bo-host", due: 1800000025000, label: "req query syncLog:getHeads", producer: "bo-host syncLog:getHeads", seq: 9 },
  { channel: "sched", due: 1800000025000, label: "sched agentTasks:generateDisplaySummary", producer: "sched agentTasks:generateDisplaySummary", seq: 1 },
  { actor: "world", kind: "step", label: "settle #1", seq: 0, verb: "settle" } as SimEvent,
  { actor: "bo-host", kind: "step", label: "kill ada/s", seq: 21, verb: "kill" } as SimEvent,
  { channel: "actor:bo-host", due: 1800000025000, label: "bo-host kill ada/s", producer: "actor:bo-host kill", seq: 21 },
  { channel: "conn:bo-host", due: 1800000025000, label: "req mutation dispatch:dispatch", producer: "bo-host dispatch:dispatch", seq: 23 },
  { actor: "ada.admin", kind: "step", label: "remove acme bo", seq: 20, verb: "remove" } as SimEvent,
  { channel: "actor:ada.admin", due: 1800000025000, label: "ada.admin remove acme bo", producer: "actor:ada.admin remove", seq: 20 },
  { channel: "timer:bo-host", due: 1800000085000, label: "setTimeout(flushApplyTally, 60000)", producer: "bo-host setTimeout(flushApplyTally, 60000)", seq: 39 },
];
const REAL_WORLD = { scenario: "u11ShrinkProbe", mode: "interleave" as const, seed: 968891, labels: {}, devices: [{ name: "bo", windows: [{ name: "bo-host", role: "host" as const, closed: false }] }] };

describe("parseChannel", () => {
  it("reads every channel kind net.ts names", () => {
    expect(parseChannel("conn:bo-host")).toEqual({ kind: "conn", window: "bo-host" });
    expect(parseChannel("live:bo-host:feed-anchors")).toEqual({ kind: "live", window: "bo-host", feed: "feed-anchors" });
    expect(parseChannel("repl:laptop-host>laptop-follower")).toEqual({ kind: "repl", from: "laptop-host", to: "laptop-follower" });
    expect(parseChannel("bridge:laptop:daemon")).toEqual({ kind: "bridge", device: "laptop", from: "daemon" });
    expect(parseChannel("timer:bo-host")).toEqual({ kind: "timer", owner: "bo-host" });
    expect(parseChannel("sched")).toEqual({ kind: "sched" });
    expect(parseChannel("actor:ada.admin")).toEqual({ kind: "actor", name: "ada.admin" });
    expect(parseChannel("weird")).toEqual({ kind: "other", raw: "weird" });
  });
});

describe("buildTimeline on a real run", () => {
  const t = buildTimeline(REAL, REAL_WORLD);

  it("puts deliveries in file order on x, keeping each one's enqueue seq", () => {
    expect(t.count).toBe(7);
    expect(t.marks.map((m) => m.i)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(t.marks.map((m) => m.seq)).toEqual([3, 9, 1, 21, 23, 20, 39]);
  });

  it("places step bands between deliveries, a settle and both verbs where they ran", () => {
    expect(t.steps.map((s) => [s.verb, s.at, s.end])).toEqual([
      ["settle", 3, 3],
      ["kill", 3, 5],
      ["remove", 5, 7],
    ]);
  });

  it("gives windows, sched, timers and each actor their own lanes, under the world's devices", () => {
    expect(t.lanes.map((l) => l.id)).toEqual(["d:bo", "w:bo-host", "sched", "t:bo-host", "a:bo-host", "a:ada.admin"]);
    expect(t.marks.map((m) => m.shape)).toEqual(["live", "conn", "sched", "actor", "conn", "actor", "timer"]);
    expect(t.feeds).toEqual(["inbox"]);
  });

  it("still draws a run with no world.json, and a replication between two windows", () => {
    const bare = buildTimeline([{ channel: "repl:a>b", due: 0, label: "slice", producer: "a replicate", seq: 1 }, { channel: "bridge:laptop:daemon", due: 0, label: "hb", producer: "d", seq: 2 }], null);
    expect(bare.lanes.map((l) => l.id)).toEqual(["d:laptop", "w:a", "w:b"]);
    expect(bare.marks[0]).toMatchObject({ shape: "repl", lane: "w:a", toLane: "w:b" });
    expect(bare.lastIndex["w:b"]).toBe(0);
  });
});

describe("failure, trace and shrink", () => {
  it("reads result.delivery as a count", () => {
    expect(failIndex(38, 38)).toBe(37);
    expect(failIndex(0, 10)).toBe(0);
    expect(failIndex(undefined, 10)).toBeNull();
  });

  it("traces a label by its text or by its id, by the runner's own --trace rule", () => {
    const labels = SimLabels.from({ sessionadasz11: "ada/s" });
    expect(traceMatches({ channel: "actor:bo-host", label: "bo-host kill ada/s", producer: "x" }, "ada/s", labels)).toBe(true);
    expect(traceMatches({ channel: "conn:x", label: "req get sessionadasz11", producer: "x" }, "ada/s", labels)).toBe(true);
    expect(traceMatches({ channel: "conn:x", label: "req get other", producer: "x" }, "ada/s", labels)).toBe(false);
    const t = buildTimeline(REAL, REAL_WORLD);
    expect(traceLabels(t.marks, SimLabels.from({ sessionadasz11000000000000000000: "ada/s", userzedz9000000000000000000000000: "zed" }))).toEqual([{ label: "ada/s", count: 1 }]);
  });

  it("reads recorded labels without throwing on a clash", () => {
    const labels = SimLabels.from({ a: "ada", b: "ada", c: "cy" });
    expect(labels.entries()).toEqual([["a", "ada"], ["c", "cy"]]);
  });

  it("keeps what the shrink kept, and says so in the caption", () => {
    expect([...keptIndexes(5, [1, 3])!]).toEqual([0, 2, 4]);
    expect(keptIndexes(5, null)).toBeNull();
    expect(shrinkCaption(17, { order: ["a", "b", "c", "d"], oneMinimal: true, attempts: 9 })).toBe("17 recorded, 4 needed (1-minimal)");
    expect(shrinkCaption(38, { order: Array(21).fill("x"), oneMinimal: false, attempts: 46 })).toBe("38 recorded, 21 needed (a cap stopped it, not 1-minimal)");
    expect(shrinkCaption(12, null)).toBe("12 recorded");
  });
});

describe("rowDiffSides", () => {
  const world = { scenario: "s", mode: "interleave" as const, seed: 1, labels: {}, devices: [{ name: "laptop", windows: [{ name: "laptop-host", role: "host" as const, closed: false }, { name: "laptop-follower", role: "follower" as const, closed: false }] }] };
  it("names host against follower for INV-followers, whose server column is the host window's row", () => {
    expect(rowDiffSides("INV-followers", "laptop-follower", world)).toEqual({ server: "host (laptop-host)", replica: "follower (laptop-follower)" });
  });
  it("keeps server against replica for every other invariant", () => {
    expect(rowDiffSides("INV-team-inbox", "laptop-host", world)).toEqual({ server: "server", replica: "replica (laptop-host)" });
    expect(rowDiffSides("INV-x", null, null)).toEqual({ server: "server", replica: "replica" });
  });
});

describe("stepLabels", () => {
  const band = (at: number, end: number, verb: string, label: string, actor = "world"): StepBand => ({ at, end, verb, actor, label });
  const x0 = (i: number) => 10 + 20 * i;
  const charW = 6;
  const ends = (steps: StepBand[], right: number) =>
    stepLabels(steps, x0, right, charW).map((p, k) => (p ? { row: p.row, from: p.x, to: p.x + steps[k].verb.length * charW + (p.detail ? 5 + p.detail.length * charW : 0) } : null));

  it("keeps a label on the top row when its verb fits before the next band", () => {
    const [a] = stepLabels([band(0, 10, "settle", "settle #1"), band(10, 20, "remove", "acme bo")], x0, 500, charW);
    expect(a).toEqual({ row: 0, x: 14, detail: "settle #1" });
  });

  it("drops a narrow band's label to the second row instead of running it into the next label", () => {
    // The real fixture's first step: a settle one delivery wide, then a send.
    const steps = [band(0, 1, "settle", "settle #1"), band(1, 9, "send", "s1 hello", "laptop-host"), band(9, 20, "remove", "acme ada", "bo.admin")];
    const placed = ends(steps, 500);
    expect(placed.map((p) => p?.row)).toEqual([1, 0, 0]);
    for (const row of [0, 1]) {
      const onRow = placed.filter((p) => p?.row === row) as Array<{ from: number; to: number }>;
      for (let i = 1; i < onRow.length; i++) expect(onRow[i].from).toBeGreaterThan(onRow[i - 1].to);
    }
    // A top-row label never passes the next band's edge.
    expect(placed[1]!.to).toBeLessThanOrEqual(x0(9));
  });

  it("leaves a label to its title when neither row has room", () => {
    // Three checks at one delivery: only the last has room, on the second row.
    const steps = [band(0, 0, "settle", "a"), band(0, 0, "expect", "b"), band(0, 0, "inspect", "c"), band(0, 30, "remove", "d")];
    const rows = stepLabels(steps, x0, 700, charW).map((p) => p?.row ?? null);
    expect(rows).toEqual([null, null, 1, 0]);
  });
});

describe("splitRowDiff", () => {
  // Shaped like zzProbeStashRestoreFollower interleave 333090: the server side is a projection, so most fields are absent there.
  const diff = [
    { field: "archived_at", server: "(absent)", replica: "null" },
    { field: "agent_status", server: "\"needs_input\"", replica: "\"stashed\"" },
    { field: "has_unread", server: "(absent)", replica: "false" },
    { field: "inbox_stashed_at", server: "null", replica: "1800000025000" },
    { field: "message_count", server: "(absent)", replica: "0" },
    { field: "tags", server: "[]", replica: "(absent)" },
    { field: "title", server: "(absent)", replica: "\"ada/s\"" },
  ];

  it("puts the fields one side lacks and the other leaves empty behind a count", () => {
    const { shown, omitted } = splitRowDiff(diff, {});
    expect(omitted.map((d) => d.field)).toEqual(["archived_at", "has_unread", "message_count", "tags"]);
    // A field absent on one side but holding a real value on the other still says something.
    expect(shown.map((d) => d.field)).toEqual(["agent_status", "inbox_stashed_at", "title"]);
  });

  it("leads with the fields the invariant compares or the message names", () => {
    const { shown } = splitRowDiff(diff, { message: "placed stashed, the server places needs_input; inbox_stashed_at moved", keys: ["agent_status"] });
    expect(shown.map((d) => d.field)).toEqual(["agent_status", "inbox_stashed_at", "title"]);
    expect(splitRowDiff(diff, { keys: ["title"] }).shown[0]!.field).toBe("title");
  });
});

