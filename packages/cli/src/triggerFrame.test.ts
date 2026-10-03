// The trigger frame is prompt bytes production sends, and the eval harness
// replays it. The golden was written from taskScheduler's buildPrompt before
// the body moved here, at a fixed `now`, so any drift in the frame shows up as
// a byte diff against what production sent.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTriggerFrame } from "./triggerFrame.js";
import { buildBootGraph, importChain, repoRootFrom } from "./bench/bootGraph.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(SRC, "__fixtures__/triggerFrame.golden.json"), "utf8")) as {
  now: number;
  cases: Array<{ name: string; task: Record<string, unknown>; frame: string }>;
};

describe("buildTriggerFrame", () => {
  test("a spawned run sees the events that fired it, quoted after its prompt", () => {
    const at = Date.UTC(2026, 9, 3, 12);
    const task = { _id: "t1", title: "On errors", prompt: "Fix it.", mode: "apply", pending_events: [{ event_type: "error_new", group_short_id: "eg-2", title: "Boom", at }] };
    const frame = buildTriggerFrame(task, at);
    expect(frame.indexOf('error_new eg-2: "Boom"')).toBeGreaterThan(frame.indexOf("Fix it."));
    expect(frame).toContain("untrusted data");
    expect(buildTriggerFrame({ ...task, pending_events: undefined }, at)).not.toContain("What fired this run");
  });

  test("the golden covers every branch of the frame", () => {
    const names = golden.cases.map((c) => c.name);
    expect(names.filter((n) => n.endsWith("/with-summary")).length).toBeGreaterThanOrEqual(3);
    expect(names.filter((n) => n.endsWith("/without-summary")).length).toBeGreaterThanOrEqual(3);
    const frames = golden.cases.map((c) => c.frame).join("\n");
    for (const ago of ["m ago", "h ago", "d ago", "unknown time ago"]) expect(frames).toContain(ago);
  });

  for (const c of golden.cases) {
    test(`matches the pre-refactor frame: ${c.name}`, () => {
      expect(buildTriggerFrame(c.task, golden.now)).toBe(c.frame);
    });
  }

  test("the previous-run age reads the given now, not the clock", () => {
    const task = { _id: "fixturetrigger", title: "t", prompt: "p", last_run_summary: "s", last_run_at: 1_000 };
    expect(buildTriggerFrame(task, 1_000 + 3 * 60_000)).toContain("Previous run (3m ago):");
    expect(buildTriggerFrame(task, 1_000 + 3 * 3_600_000)).toContain("Previous run (3h ago):");
  });
});

describe("triggerFrame.ts stays a leaf", () => {
  test("its static import graph does not reach the scheduler", () => {
    const graph = buildBootGraph(path.join(SRC, "triggerFrame.ts"));
    const scheduler = path.join(SRC, "taskScheduler.ts");
    const root = repoRootFrom(SRC);
    const chain = importChain(graph, scheduler)?.map((f) => path.relative(root, f)).join(" -> ");
    expect(chain ?? null).toBeNull();
    expect(graph.nodes.has(scheduler)).toBe(false);
  }, 60_000);
});
