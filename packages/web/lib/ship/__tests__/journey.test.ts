import { describe, expect, test } from "bun:test";
import { journeyOf, journeyStages, readableWhy, targetsFromLine } from "../journey";
import graph from "./changeGraph.fixture.json";

const g = graph as any;
const run = (over: Record<string, unknown>) => ({ status: "running", node_statuses: [], ...over }) as any;

describe("journeyStages", () => {
  test("the change flow reads as its stages to live, with who acts at each", () => {
    const s = journeyStages(g);
    expect(s.map((x) => x.label)).toEqual(["Check", "Review", "Decide", "Land", "Deploy", "Live"]);
    expect(s.map((x) => x.who)).toEqual(["auto", "agent", "you", "auto", "you", "auto"]);
    expect(s.map((x) => x.id)).toEqual(["check", "review", "decide", "ship", "deploy", "live"]);
  });
  test("each stage names the way back to the session it can take, with its limit", () => {
    const s = journeyStages(g);
    expect(s[0].loops).toEqual([{ id: "fix_check", label: "Fix check", max: 3 }]);
    expect(s[1].loops.map((l) => l.id)).toEqual(["fix_review"]);
    expect(s[3].loops.map((l) => l.id)).toEqual(["fix_conflict"]);
  });
});

describe("journeyOf", () => {
  test("a run waiting on the session puts the stage that sent it back, with the note and the round", () => {
    const j = journeyOf(g, run({
      current_node_id: "fix_review",
      waiting_on_session: { node_id: "fix_review", since: 5, note: "The reviewer asked for changes. Rename the hook." },
      node_statuses: [
        { node_id: "check__verify", status: "completed", visits: 1 },
        { node_id: "review__review", status: "completed", visits: 1 },
        { node_id: "fix_review", status: "running", visits: 2 },
      ],
    }));
    expect(j.stages.map((s) => s.state)).toEqual(["done", "back", "idle", "idle", "idle", "idle"]);
    expect(j.now).toEqual({ kind: "session", stage: "Review", note: "The reviewer asked for changes. Rename the hook.", since: 5, round: 2, max: 3 });
  });
  test("a run at Decide waits on you with its decision", () => {
    const j = journeyOf(g, run({ status: "paused", current_node_id: "decide__decide", gate_decision_id: "d1", node_statuses: [{ node_id: "check__verify", status: "completed" }, { node_id: "review__review", status: "completed" }] }));
    expect(j.stages[2].state).toBe("waiting");
    expect(j.now).toMatchObject({ kind: "you", stage: "Decide", decisionId: "d1" });
  });
  test("a landed change waits at Deploy with the stage's own line, and is going out once a deploy carries it", () => {
    const landed = (line: string) => run({ current_node_id: "deploy__wait", node_statuses: [{ node_id: "ship__ship", status: "completed" }, { node_id: "deploy__wait", status: "running", result_preview: line }] });
    const waiting = journeyOf(g, landed("abc1234567 landed; live on web dp-12, waiting for backend."));
    expect(waiting.stages.slice(-3).map((s) => s.state)).toEqual(["done", "waiting", "idle"]);
    expect(waiting.now).toMatchObject({ kind: "landed", line: "abc1234567 landed; live on web dp-12, waiting for backend." });
    const going = journeyOf(g, landed("abc1234567 landed; live on web dp-12, waiting for backend (going out in dp-13)."));
    expect(going.stages.slice(-2).map((s) => s.state)).toEqual(["active", "idle"]);
    expect(going.now.kind).toBe("deploying");
  });
  test("a run that ended at Live is live everywhere it ships", () => {
    const j = journeyOf(g, run({ status: "completed", current_node_id: "exit", node_statuses: [{ node_id: "deploy__wait", status: "completed", result_preview: "Live: abc1234567 on backend dp-12, web dp-14." }, { node_id: "deploy__live", status: "completed", result_preview: '{"exit": "live"}' }] }));
    expect(j.stages.every((s) => s.state === "done")).toBe(true);
    expect(j.now).toMatchObject({ kind: "live", line: "Live: abc1234567 on backend dp-12, web dp-14." });
  });
  test("a stopped run says where and why, in words", () => {
    const j = journeyOf(g, run({ status: "failed", current_node_id: "ship__rebase", fail_reason: 'Stopped: The change does not rebase cleanly. {"rebased": false, "why": "conflict"}' }));
    expect(j.stages[3].state).toBe("stopped");
    expect(j.now).toEqual({ kind: "stopped", stage: "Land", why: "The change does not rebase cleanly." });
  });
});

test("targetsFromLine reads the Deploy stage's line", () => {
  expect(targetsFromLine("4a6e413b2c landed; live on web dp-12, waiting for backend, cli (going out in dp-13).")).toEqual([
    { name: "web", state: "live", deploy: "dp-12" },
    { name: "backend", state: "deploying", deploy: "dp-13" },
    { name: "cli", state: "deploying", deploy: "dp-13" },
  ]);
  expect(targetsFromLine("86402bc333 landed; waiting for scratch-e2e.")).toEqual([{ name: "scratch-e2e", state: "waiting" }]);
  expect(targetsFromLine("Live: 4a6e413b2c on backend dp-13, web dp-12.")).toEqual([{ name: "backend", state: "live", deploy: "dp-13" }, { name: "web", state: "live", deploy: "dp-12" }]);
  expect(targetsFromLine("Waiting for codecast/change-ct-1 to land on main.")).toEqual([]);
});

test("readableWhy cuts long reasons at a word", () => {
  expect(readableWhy("a ".repeat(200))!.endsWith("…")).toBe(true);
});
