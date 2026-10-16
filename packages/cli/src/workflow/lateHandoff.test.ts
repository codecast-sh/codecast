// ct-60145: an implement hand ended a turn while its check ran in the
// background, the runner read that first turn end as its answer with no
// handoff yet, and the run failed "no outgoing edge from implement (outcome
// success, handoff none)" while the handoff landed minutes later. The builder
// stations route only on their handoff, so the runner waits for it within the
// node's timeout.
import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow, type RunOptions } from "./runner.js";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";

const shipped = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
const builders = ["implement", "implement_line"];

// The station with the shipped line's own edges out of it, between a start and
// the two places they lead: verify, and the stopped exit.
const graphFor = (id: string) => parseWorkflowSource(`digraph line {
  start [shape=Mdiamond]
  ${id} [label="Build", backend=session, agent=claude, timeout=600, prompt="build it"]
  verify [shape=parallelogram, script="true"]
  exit [shape=Msquare]
  stopped [shape=Msquare, label="Stopped", stop="$handoff_note"]
  start -> ${id}
  ${shipped.edges.filter((e) => e.from === id).map((e) => `${id} -> ${e.to} [condition="${e.condition}"]`).join("\n  ")}
  verify -> exit
}`);

describe("workflow/runner (a builder's handoff lands after its turn ends)", () => {
  let tmpDir: string;
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let logs: string[];
  let calls: Array<{ route: string; body: any }>;
  let task: Record<string, any>;
  let reads: number;
  // On which inbox read the hand hands off, and with what status; 0 never.
  let handoffAt: number;
  let handoffStatus: string;
  // On which inbox read the clock jumps, and by how much.
  let jumpAt: number;
  let jumpMs: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-wf-late-"));
    origFetch = globalThis.fetch;
    origLog = console.log;
    logs = [];
    console.log = (...args: any[]) => logs.push(args.join(" "));
    calls = [];
    task = { short_id: "ct-9", title: "Fix it", status: "in_progress", execution_status: "" };
    reads = 0;
    handoffAt = 0;
    handoffStatus = "done";
    jumpAt = 0;
    jumpMs = 0;
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      calls.push({ route, body });
      const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (route === "/cli/spawn") return reply({ conversation_id: "conv_hand", short_id: "jx7hand" });
      if (route === "/cli/inbox") {
        reads++;
        if (reads === jumpAt) setSystemTime(new Date(Date.now() + jumpMs));
        if (reads === handoffAt) task = { ...task, status: "in_review", execution_status: handoffStatus, verification_evidence: "cannot build: x" };
        // The hand ended its turn on a backgrounded check: live, needs input, nothing pinned.
        return reply({ sessions: [{ id: "conv_hand", work_state: "needs_input", is_live: true, message_count: 40 }] });
      }
      if (route === "/cli/sessions/state/get") return reply({ state: "", status: "" });
      if (route === "/cli/work/get") return reply(task);
      return reply({ ok: true });
    }) as typeof fetch;
  });

  afterEach(() => {
    setSystemTime();
    globalThis.fetch = origFetch;
    console.log = origLog;
    fs.rmSync(tmpDir, { recursive: true });
  });

  const run = (id: string) => runWorkflow(graphFor(id), { cwd: tmpDir, runId: "run-1", runSession: "conv_run", taskId: "ct-9", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 } as RunOptions);
  const reached = (id: string) => calls.some((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === id);
  const failReason = () => calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.fail_reason).map((c) => String(c.body.fail_reason)).pop() ?? "";

  test("the shipped builders route only on their handoff", () => {
    for (const id of builders) {
      const out = shipped.edges.filter((e) => e.from === id);
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((e) => /\bhandoff\b/.test(e.condition ?? ""))).toBe(true);
    }
  });

  test.each(builders)("%s: a done handoff nine minutes after the turn ended routes to verify", async (id) => {
    // ct-60270 th719815g: the handoff came 555s after the node closed.
    jumpAt = 6;
    jumpMs = 9 * 60_000;
    handoffAt = 8;
    expect(await run(id)).toBe("completed");
    expect(reached("verify")).toBe(true);
    expect(failReason()).not.toContain("no outgoing edge");
    expect(reads).toBe(8);
  }, 30000);

  test.each(builders.flatMap((id) => ["needs_context", "blocked"].map((s) => [id, s] as const)))(
    "%s: a late %s handoff routes to stopped, never a dead end",
    async (id, status) => {
      handoffAt = 8;
      handoffStatus = status;
      expect(await run(id)).toBe("failed");
      expect(reached("verify")).toBe(false);
      expect(failReason()).toContain("Stopped: cannot build: x");
    },
    30000,
  );

  test.each(builders)("%s: a hand that never hands off ends at the node's timeout, not later", async (id) => {
    jumpAt = 5;
    jumpMs = 11 * 60_000;
    expect(await run(id)).toBe("failed");
    expect(reads).toBe(5);
    expect(calls.some((c) => c.route === "/cli/sessions/kill" && c.body.session === "conv_hand")).toBe(true);
    expect(failReason()).toContain("killed after 10m");
  }, 30000);
});
