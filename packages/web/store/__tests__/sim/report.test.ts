import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexIdFor } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { SimLabels } from "./labels";
import { parseOrder } from "./net";
import {
  SimFailure,
  artifactDir,
  eventsJsonl,
  fieldDiff,
  formatFailure,
  replayCommands,
  reportFailure,
  writeArtifacts,
  type DeliveryRecord,
  type FailureContext,
} from "./report";

const T0 = 1_800_000_000_000;
const ADA = convexIdFor("user:ada");
const BO = convexIdFor("user:bo");
const ACME = convexIdFor("team:acme");
const DOC = convexIdFor("docs:1");
const SECRET = "the body of a private doc";

function world() {
  const labels = new SimLabels();
  labels.register(ADA, "ada");
  labels.register(BO, "bo");
  labels.register(ACME, "acme");
  labels.onInsert("docs", DOC);
  return labels;
}

// Fifteen deliveries, so the block shows only the last twelve.
const CHANNELS = ["conn:A", "conn:A", "live:B:docs", "sched", "conn:A", "repl:A>A1", "repl:A>A1", "repl:A>A1", "timer:A", "conn:B", "conn:B", "live:B:docs", "conn:A", "conn:B", "conn:B"];
const ring: DeliveryRecord[] = CHANNELS.map((channel, i) => ({
  seq: i + 1,
  channel,
  due: T0 + i * 250,
  label: channel.startsWith("conn:") ? `res docs:update ${DOC}` : "recompute",
  producer: i % 2 ? `window:${BO}` : "net",
}));

function forced(over: Partial<FailureContext> = {}): FailureContext {
  return {
    scenario: "visibilityFlip",
    mode: "interleave",
    seed: 7,
    step: "settle #2",
    delivery: 15,
    invariant: { id: "INV-workspace-rows", meaning: "a window holds exactly the work items its principal may read" },
    message: `bo holds ${DOC} after the flip back to private`,
    window: { name: "B.host", principal: BO, scope: ACME },
    row: {
      table: "docs",
      id: DOC,
      server: { _id: DOC, title: "Plan", workspace: `user:${ADA}`, owner: ADA, content: SECRET, team_id: ACME, tags: { b: 1, a: 2 }, archived_at: 5 },
      replica: { _id: DOC, title: "Plan v0", workspace: `team:${ACME}`, owner: ADA, content: "older body", team_id: BO, tags: { a: 2, b: 1 } },
    },
    ring,
    order: CHANNELS,
    labels: world(),
    t0: T0,
    ...over,
  };
}

describe("formatFailure", () => {
  test("the full block for a forced diff", () => {
    expect(formatFailure(forced(), "/sim-out/visibilityFlip-interleave-7")).toMatchInlineSnapshot(`
      "sim failure: visibilityFlip [interleave seed 7] at step "settle #2", after 15 deliveries
        INV-workspace-rows: a window holds exactly the work items its principal may read
        bo holds docs#1 after the flip back to private
        window B.host (principal bo, scope acme)
        row docs#1 (docs)
          archived_at  server 5  replica (absent)
          title        server "Plan"  replica "Plan v0"
          workspace    server "user:ada"  replica "team:acme"
        last 12 deliveries, in delivery order (#: enqueue seq):
          #4   +750ms   sched        recompute               by window:bo
          #5   +1000ms  conn:A       res docs:update docs#1  by net
          #6   +1250ms  repl:A>A1    recompute               by window:bo
          #7   +1500ms  repl:A>A1    recompute               by net
          #8   +1750ms  repl:A>A1    recompute               by window:bo
          #9   +2000ms  timer:A      recompute               by net
          #10  +2250ms  conn:B       res docs:update docs#1  by window:bo
          #11  +2500ms  conn:B       res docs:update docs#1  by net
          #12  +2750ms  live:B:docs  recompute               by window:bo
          #13  +3000ms  conn:A       res docs:update docs#1  by net
          #14  +3250ms  conn:B       res docs:update docs#1  by window:bo
          #15  +3500ms  conn:B       res docs:update docs#1  by net
        replay:
          bun run sim visibilityFlip --seed 7 --trace docs#1
          bun run sim visibilityFlip --seed 7 --order "conn:A conn:A live:B:docs sched conn:A repl:A>A1 repl:A>A1 repl:A>A1 timer:A conn:B conn:B live:B:docs conn:A conn:B conn:B"
        artifacts: /sim-out/visibilityFlip-interleave-7"
    `);
  });

  test("denylisted fields never print, whatever their values", () => {
    const text = formatFailure(forced(), "/out");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("older body");
    expect(text).not.toMatch(/^\s+(content|team_id)\s/m);
    expect(fieldDiff("docs", { content: "a", team_id: "x" }, { content: "b", team_id: "y" })).toEqual([]);
    expect(fieldDiff("tasks", { steps: [1] }, { steps: [2] })).toEqual([]);
  });

  test("key order inside a value is not a difference", () => {
    expect(fieldDiff("docs", { tags: { a: 1, b: 2 } }, { tags: { b: 2, a: 1 } })).toEqual([]);
  });

  test("both replay lines, and the order line replays the run", () => {
    const lines = formatFailure(forced(), "/out").split("\n").map((l) => l.trim());
    expect(lines).toContain("bun run sim visibilityFlip --seed 7 --trace docs#1");
    const orderLine = lines.find((l) => l.includes("--order"))!;
    expect(orderLine.startsWith("bun run sim visibilityFlip --seed 7 --order ")).toBe(true);
    expect(parseOrder(orderLine.match(/--order "([^"]*)"/)![1])).toEqual(CHANNELS);
  });

  test("a failure a red marker names says it was expected", () => {
    const head = formatFailure(forced({ expected: "ct-56011" }), "/out").split("\n")[0];
    expect(head).toBe('sim failure (expected, red: ct-56011): visibilityFlip [interleave seed 7] at step "settle #2", after 15 deliveries');
  });

  test("a failure with no row traces everything", () => {
    const text = formatFailure(forced({ row: undefined }), "/out");
    expect(text).toContain("bun run sim visibilityFlip --seed 7 --trace\n");
  });

  test("a row missing on one side says so instead of diffing", () => {
    const ctx = forced();
    const text = formatFailure({ ...ctx, row: { ...ctx.row!, server: null } }, "/out");
    expect(text).toContain("  row docs#1 (docs)\n    absent on the server\n  last 12");
  });
});

describe("SimLabels", () => {
  test("inserted rows number per table and keep a world name", () => {
    const labels = new SimLabels();
    labels.register(convexIdFor("tasks:a"), "task:acme/t1");
    labels.onInsert("tasks", convexIdFor("tasks:a"));
    labels.onInsert("tasks", convexIdFor("tasks:b"));
    labels.onInsert("docs", convexIdFor("docs:a"));
    expect(labels.label(convexIdFor("tasks:a"))).toBe("task:acme/t1");
    expect(labels.label(convexIdFor("tasks:b"))).toBe("tasks#2");
    expect(labels.label(convexIdFor("docs:a"))).toBe("docs#1");
    expect(labels.id("tasks#2")).toBe(convexIdFor("tasks:b"));
  });

  test("an unknown id falls back to its first 8 characters", () => {
    const id = convexIdFor("conversations:zz");
    expect(new SimLabels().label(id)).toBe(id.slice(0, 8));
    expect(new SimLabels().relabel(`x ${id} y`)).toBe(`x ${id.slice(0, 8)} y`);
  });

  test("a label names one id", () => {
    const labels = world();
    expect(() => labels.register(convexIdFor("user:cy"), "ada")).toThrow(`"ada" already names ${ADA}`);
    expect(() => labels.register(ADA, "ada2")).toThrow(`${ADA} is already "ada"`);
    labels.register(ADA, "ada");
    expect(() => labels.id("nobody")).toThrow('no row is labelled "nobody"; known: acme, ada, bo, docs#1');
  });
});

describe("reportFailure", () => {
  test("writes the artifacts, then throws the printed text", () => {
    const root = mkdtempSync(join(tmpdir(), "sim-report-"));
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const ctx = forced();
      const dir = artifactDir("visibilityFlip", "interleave", 7, root);
      let thrown: unknown;
      try {
        reportFailure(ctx, { events: ring, world: { users: ["ada", "bo"] }, final: { ok: false } }, dir);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SimFailure);
      expect((thrown as SimFailure).message).toBe(formatFailure(ctx, dir));
      expect(err).toHaveBeenCalledWith((thrown as SimFailure).message);

      const result = readFileSync(join(dir, "result.json"), "utf8");
      expect(result).not.toContain(SECRET);
      expect(JSON.parse(result).row.diff).toEqual([
        { field: "archived_at", server: "5", replica: "(absent)" },
        { field: "title", server: '"Plan"', replica: '"Plan v0"' },
        { field: "workspace", server: '"user:ada"', replica: '"team:acme"' },
      ]);
      const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n");
      expect(events).toHaveLength(15);
      expect(JSON.parse(events[0])).toEqual({ seq: 1, channel: "conn:A", due: T0, label: `res docs:update ${DOC}`, producer: "net" });
      expect(JSON.parse(readFileSync(join(dir, "world.json"), "utf8"))).toEqual({ users: ["ada", "bo"] });
      expect(JSON.parse(readFileSync(join(dir, "final.json"), "utf8"))).toEqual({ ok: false });
    } finally {
      err.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("run history fields", () => {
  test("step rows sit between the deliveries at their place, and result.json carries the run's meta", () => {
    const root = mkdtempSync(join(tmpdir(), "sim-report-"));
    try {
      const dir = artifactDir("visibilityFlip", "interleave", 7, root, true);
      expect(dir).toBe(join(root, "visibilityFlip-interleave-7-known"));
      const steps = [
        { at: 0, seq: 0, verb: "settle", actor: "world", label: "settle #1" },
        { at: 2, seq: 3, verb: "kill", actor: "B", label: "kill ada/s" },
        { at: 15, seq: 0, verb: "expect", actor: "world", label: "expect window B hides ada/s" },
      ];
      const meta = { gitHead: "a".repeat(40), dirty: true, startedAt: "2026-10-03T22:00:00.000Z", realMs: 812 };
      writeArtifacts(dir, { scenario: "visibilityFlip", passed: true }, { events: ring, steps, world: {}, final: {}, meta });
      const rows = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(rows).toHaveLength(ring.length + steps.length);
      expect(rows[0]).toEqual({ kind: "step", seq: 0, verb: "settle", actor: "world", label: "settle #1" });
      expect(rows[3]).toEqual({ kind: "step", seq: 3, verb: "kill", actor: "B", label: "kill ada/s" });
      expect(rows[1].kind).toBeUndefined();
      expect(rows.at(-1).label).toBe("expect window B hides ada/s");
      // With no steps the file is what it was before step markers existed.
      expect(eventsJsonl(ring, [])).toBe(eventsJsonl(ring));
      expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))).toEqual({ scenario: "visibilityFlip", passed: true, ...meta });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replay lines gain the minimal order once a shrink has run", () => {
    const order = ["scripted", "actor:ada", "conn:A"];
    expect(replayCommands("visibilityFlip", 7, order, "ada/s")).toEqual([
      "bun run sim visibilityFlip --seed 7 --trace ada/s",
      'bun run sim visibilityFlip --seed 7 --order "scripted actor:ada conn:A"',
    ]);
    expect(replayCommands("visibilityFlip", 7, order, null, ["scripted", "conn:A"])).toEqual([
      "bun run sim visibilityFlip --seed 7 --trace",
      'bun run sim visibilityFlip --seed 7 --order "scripted actor:ada conn:A"',
      'bun run sim visibilityFlip --seed 7 --order "scripted conn:A"',
    ]);
  });
});
