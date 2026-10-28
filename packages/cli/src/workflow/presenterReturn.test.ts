// ct-65353: the run went back to Present, and the runner sent the brief to the
// session that presented before. That session could not come back (its agent
// crashed on every resume), so nothing ever answered, and the station waited
// out its 90-minute limit, twice. A presenter sent back its brief now has a
// grace to come back; one that cannot is retired, the card it left waiting is
// taken back, and a fresh hand presents.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow, type RunOptions } from "./runner.js";

const graph = parseWorkflowSource(`digraph line {
  start [shape=Mdiamond]
  present [label="Present", backend=session, agent=claude, timeout=600, prompt="present it"]
  decide [label="Decide", shape=hexagon, asker=present, prompt="Ship it?"]
  ship [shape=parallelogram, script="true"]
  exit [shape=Msquare]
  start -> present -> decide
  decide -> ship [label="[S] Ship :: Land it"]
  ship -> exit
}`);

type Hand = { live: boolean; killed: boolean; pinnedAt: number };

describe("workflow/runner (a presenter sent back its brief)", () => {
  let tmpDir: string;
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let calls: Array<{ route: string; body: any }>;
  let hands: Record<string, Hand>;
  let spawned: number;
  let gates: number;
  // What the first presenter does once the run comes back to it.
  let onReturn: (hand: Hand) => void;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-wf-presenter-"));
    origFetch = globalThis.fetch;
    origLog = console.log;
    console.log = () => {};
    calls = [];
    hands = {};
    spawned = 0;
    gates = 0;
    onReturn = () => {};
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      calls.push({ route, body });
      const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (route === "/cli/spawn") {
        spawned++;
        const id = `conv_hand${spawned}`;
        // A fresh hand presents at once: it posts its card and pins done.
        hands[id] = { live: false, killed: false, pinnedAt: 1000 * spawned };
        return reply({ conversation_id: id, short_id: `jx7hand${spawned}` });
      }
      if (route === "/cli/inbox") {
        const id = body.session_ids?.[0];
        const h = hands[id];
        return reply({ sessions: h ? [{ id, session_id: `uuid-${id}`, work_state: "done", is_live: h.live, is_killed: h.killed, message_count: 12 }] : [] });
      }
      if (route === "/cli/sessions/state/get") {
        const h = hands[body.session];
        return reply(h ? { state: "Posted the card", status: "done", at: h.pinnedAt } : {});
      }
      if (route === "/cli/messages/send") {
        if (hands[body.to]) onReturn(hands[body.to]);
        return reply({ ok: true });
      }
      if (route === "/cli/sessions/kill") {
        if (hands[body.session]) hands[body.session].killed = true;
        return reply({ ok: true });
      }
      if (route === "/cli/decide" && body.action === "ls") {
        return reply({ decisions: [{ id: "k_old", short_id: "sd-1", status: "pending" }, { id: "k_done", short_id: "sd-0", status: "answered" }] });
      }
      // The first card is refused, so the run goes back to its presenter; the second is taken.
      if (route === "/cli/workflow-runs/gate") return reply(++gates === 1 ? { present_again: true } : { ok: true });
      if (route === "/cli/workflow-runs/poll-gate") return reply({ status: "running", gate_response: "S" });
      return reply({ ok: true });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    fs.rmSync(tmpDir, { recursive: true });
  });

  const run = () => runWorkflow(graph, { cwd: tmpDir, runId: "run-1", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, presenterGraceMs: 50 } as RunOptions);
  const routed = (route: string, match: (body: any) => boolean = () => true) => calls.filter((c) => c.route === route && match(c.body));

  test("a killed presenter is retired at once: its waiting card is taken back and a fresh hand presents", async () => {
    onReturn = (h) => { h.killed = true; };
    expect(await run()).toBe("completed");
    expect(spawned).toBe(2);
    expect(routed("/cli/sessions/kill", (b) => b.session === "conv_hand1")).toHaveLength(1);
    expect(routed("/cli/decide", (b) => b.action === "ls")[0].body.session_id).toBe("uuid-conv_hand1");
    expect(routed("/cli/decide", (b) => b.action === "cancel").map((c) => c.body.decision_id)).toEqual(["sd-1"]);
    expect(gates).toBe(2);
  }, 20000);

  test("a presenter that never wakes within the grace is retired the same way", async () => {
    // Its agent crashes on every resume: it never reads live and never pins again.
    onReturn = () => {};
    expect(await run()).toBe("completed");
    expect(spawned).toBe(2);
    expect(routed("/cli/sessions/kill", (b) => b.session === "conv_hand1")).toHaveLength(1);
    expect(routed("/cli/decide", (b) => b.action === "cancel").map((c) => c.body.decision_id)).toEqual(["sd-1"]);
  }, 20000);

  test("a presenter that comes back keeps the station: nothing is retired and no second hand starts", async () => {
    onReturn = (h) => { h.live = true; h.pinnedAt = 5000; };
    expect(await run()).toBe("completed");
    expect(spawned).toBe(1);
    expect(routed("/cli/sessions/kill")).toHaveLength(0);
    expect(routed("/cli/decide", (b) => b.action === "cancel")).toHaveLength(0);
    expect(gates).toBe(2);
  }, 20000);
});
