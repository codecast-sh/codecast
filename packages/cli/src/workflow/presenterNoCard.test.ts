// ct-62633, Nov 5: the gate found no card of Present's and sent the run back, then the card station refused a
// report and sent it back again. The "no decision of yours stands" note from the gate rode along on every later
// visit, so Present withdrew its open card and posted it again unchanged, three times in two minutes (sd-2513,
// sd-2527, sd-2528), and each new decision lost the ladder's recommendation. The note is for the one visit the
// gate sent back.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow, type RunOptions } from "./runner.js";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
isolateCodecastDirEachTest("cast-wf-state-");

describe("workflow/runner (the gate's no-card note)", () => {
  let tmpDir: string;
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let briefs: string[];
  let gates: number;
  let pinnedAt: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-wf-nocard-"));
    origFetch = globalThis.fetch;
    origLog = console.log;
    console.log = () => {};
    briefs = [];
    gates = 0;
    pinnedAt = 1000;
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (route === "/cli/spawn") { briefs.push(String(body.prompt ?? body.message ?? "")); return reply({ conversation_id: "conv_present", short_id: "jx7pres" }); }
      if (route === "/cli/inbox") return reply({ sessions: [{ id: "conv_present", session_id: "uuid-present", work_state: "done", is_live: true, is_killed: false, message_count: 12 }] });
      if (route === "/cli/sessions/state/get") return reply({ state: "Posted the card", status: "done", at: pinnedAt });
      if (route === "/cli/messages/send") { briefs.push(String(body.body ?? "")); pinnedAt += 1000; return reply({ ok: true }); }
      if (route === "/cli/workflow-runs/gate") return reply(++gates === 1 ? { error: "present posted no card for this gate", present_again: true } : { ok: true });
      if (route === "/cli/workflow-runs/poll-gate") return reply({ status: "running", gate_response: "S" });
      return reply({ ok: true });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("a visit the card station sends back is not told that no decision of its own stands", async () => {
    const count = path.join(tmpDir, "card-count");
    // The card is taken on its first and third reports and refuses the second.
    const graph = parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      present [label="Present", backend=session, agent=claude, timeout=600, max_visits=5, prompt="present it"]
      card [shape=parallelogram, script="n=$(cat ${count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${count}; [ $n -ne 2 ]"]
      decide [label="Decide", shape=hexagon, asker=present, prompt="Ship it?"]
      ship [shape=parallelogram, script="true"]
      exit [shape=Msquare]
      start -> present -> card
      card -> decide [condition="outcome = success"]
      card -> present [condition="outcome = failure", label="card refused"]
      decide -> ship [label="[S] Ship :: Land it"]
      ship -> exit
    }`);
    const outcome = await runWorkflow(graph, { cwd: tmpDir, runId: `run-nocard-${Date.now()}`, runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, presenterGraceMs: 50 } as RunOptions);
    expect(outcome).toBe("completed");
    expect(briefs).toHaveLength(3);
    const told = briefs.map((b) => b.includes("No decision of yours stands"));
    // First visit: nothing to say. Second, sent back by the gate: told. Third, sent back by the card: not told.
    expect(told).toEqual([false, true, false]);
  }, 30000);
});
