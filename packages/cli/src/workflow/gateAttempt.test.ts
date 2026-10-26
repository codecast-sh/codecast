import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow, type RunOptions } from "./runner.js";

// Oct 26: seven cards answered Revise sent their runs back to a build whose
// visits a check loop had spent, and each run failed on max_visits at once:
// the rework the person asked for never ran.
let dir: string;
let fetched: typeof fetch;
let log: typeof console.log;
let answers: Array<string | { gate_response: string; gate_answer: string }>;
let gateReplies: object[];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gate-attempt-")));
  fetched = globalThis.fetch;
  log = console.log;
  console.log = () => {};
  gateReplies = [];
  globalThis.fetch = (async (url: any) => {
    const route = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (route === "/cli/workflow-runs/gate") return new Response(JSON.stringify(gateReplies.shift() ?? { ok: true }), { status: 200 });
    const next = route === "/cli/workflow-runs/poll-gate" ? answers.shift() ?? null : undefined;
    const body = next === undefined ? { ok: true } : typeof next === "string" || next === null ? { status: "running", gate_response: next } : { status: "running", ...next };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetched;
  console.log = log;
  fs.rmSync(dir, { recursive: true, force: true });
});

const graph = () => parseWorkflowSource(`digraph line {
  start [shape=Mdiamond]
  build [shape=parallelogram, max_visits=2, script="echo \\"$human_message|$sent_back\\" >> builds.log"]
  check [shape=parallelogram, script="n=$(cat n 2>/dev/null || echo 0); n=$((n+1)); echo $n > n; [ $n -ge 2 ]"]
  decide [label="Decide", shape=hexagon]
  exit [shape=Msquare]
  start -> build -> check
  check -> build [condition="outcome = failure"]
  check -> decide [condition="outcome = success"]
  decide -> build [label="[R] Revise"]
  decide -> exit [label="[S] Ship"]
}`);
const run = () => runWorkflow(graph(), { cwd: dir, runId: "run-1", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 } as RunOptions);

describe("a person's answer at a gate", () => {
  test("sends the run back to a build that spent its visits, and the build runs with the note", async () => {
    answers = ["R: keep the colleagues on a phone booking", "S"];
    expect(await run()).toBe("completed");
    const builds = fs.readFileSync(path.join(dir, "builds.log"), "utf8").trim().split("\n");
    expect(builds).toHaveLength(3);
    expect(builds[2]).toMatch(/^keep the colleagues on a phone booking\|Decide:/);
  }, 30000);

  test("picked by its key alone hands the build the option's own words", async () => {
    answers = [{ gate_response: "R", gate_answer: "Revise it first: find why it goes silent on garbled calls" }, "S"];
    expect(await run()).toBe("completed");
    const builds = fs.readFileSync(path.join(dir, "builds.log"), "utf8").trim().split("\n");
    expect(builds[2]).toMatch(/^Revise it first: find why it goes silent on garbled calls\|Decide:/);
  }, 30000);
});

// Oct 26: with no card standing, the gate asked its own Ship / Revise / Drop
// (sd-1594, sd-1595, sd-1601), a card without the change's options.
describe("a gate with a presenting station", () => {
  test("asks nothing of its own when no card stands: the station presents again and the gate takes that card", async () => {
    gateReplies = [{ error: "present posted no card for this gate", present_again: true }];
    answers = ["S"];
    const g = parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      present [shape=parallelogram, script="echo presented >> presents.log"]
      decide [label="Decide", shape=hexagon, asker=present]
      exit [shape=Msquare]
      start -> present -> decide
      decide -> exit [label="[S] Ship"]
    }`);
    expect(await runWorkflow(g, { cwd: dir, runId: "run-1", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 } as RunOptions)).toBe("completed");
    expect(fs.readFileSync(path.join(dir, "presents.log"), "utf8").trim().split("\n")).toHaveLength(2);
  }, 30000);

  test("a station that never posts stops at its own visit limit: a gate that asked nobody is no new attempt", async () => {
    gateReplies = Array.from({ length: 10 }, () => ({ error: "present posted no card for this gate", present_again: true }));
    answers = [];
    const g = parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      present [shape=parallelogram, max_visits=2, script="echo presented >> presents.log"]
      decide [label="Decide", shape=hexagon, asker=present]
      exit [shape=Msquare]
      start -> present -> decide
      decide -> exit [label="[S] Ship"]
    }`);
    expect(await runWorkflow(g, { cwd: dir, runId: "run-1", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 } as RunOptions)).toBe("failed");
    expect(fs.readFileSync(path.join(dir, "presents.log"), "utf8").trim().split("\n")).toHaveLength(2);
  }, 30000);
});
