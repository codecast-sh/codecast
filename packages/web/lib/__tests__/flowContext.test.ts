import { describe, expect, test } from "bun:test";
import { flowContext, flowOrigin, stationName, stepTarget } from "../flowContext";

const t = (s: number, e: number) => ({ started_at: s * 1000, completed_at: e * 1000 });
// The Change run behind sd-4198, as the server holds it: paused at decide__decide.
const run = {
  _id: "r1", status: "paused", current_node_id: "decide__decide", gate_node_id: "decide__decide",
  gate_decision_id: "k97", gate_decision_short_id: "sd-4198",
  node_statuses: [
    { node_id: "start", status: "completed", ...t(0, 0) },
    { node_id: "check", status: "completed", ...t(0, 0) },
    { node_id: "check__verify", status: "completed", ...t(0, 120) },
    { node_id: "check__passed", status: "completed", ...t(120, 120) },
    { node_id: "review", status: "completed", ...t(120, 120) },
    { node_id: "review__review", status: "completed", session_id: "jx7enwn", session: { _id: "convReview" }, ...t(120, 360) },
    { node_id: "review__approved", status: "completed", ...t(360, 360) },
    { node_id: "intent", status: "completed", session_id: "jx7b7zg", ...t(360, 420) },
    { node_id: "ship__rebase", status: "failed", ...t(420, 423) },
    { node_id: "fix_conflict", status: "completed", ...t(423, 423) },
    { node_id: "ask", status: "completed", ...t(423, 424) },
    { node_id: "decide", status: "completed", ...t(424, 424) },
    { node_id: "decide__decide", status: "running", started_at: 424000 },
  ],
};

describe("flowContext", () => {
  test("a run whose line dropped its station reads its own history, with the gate where it stands", () => {
    const newGraph = { nodes: [{ id: "land", label: "Land", type: "agent" }, { id: "deploy", label: "Deploy", type: "command" }] };
    const ctx = flowContext(run, newGraph, { decisionId: "sd-4198" });
    expect(ctx.lineChanged).toBe(true);
    expect(ctx.stations.map((s) => s.label)).toEqual(["Verify", "Review", "Intent", "Rebase", "Ask", "Decide"]);
    const decide = ctx.stations[ctx.focus];
    expect(decide).toMatchObject({ id: "decide__decide", state: "waiting", current: true, href: "/decisions/sd-4198", segment: "Decide" });
    expect(ctx.stations.find((s) => s.id === "review__review")?.href).toBe("/conversation/convReview");
    expect(ctx.stations.find((s) => s.id === "intent")?.href).toBe("/conversation/jx7b7zg");
  });

  test("an ended run of an older flow still reads its own history, not the new flow's stations", () => {
    const newGraph = { nodes: [{ id: "decide", label: "Decide", type: "human" }, { id: "ship", label: "Ship", type: "agent" }, { id: "dropped", type: "command" }] };
    const ended = { ...run, status: "failed", node_statuses: run.node_statuses.map((n) => n.node_id === "decide__decide" ? { ...n, status: "failed", completed_at: 500000 } : n) };
    const ctx = flowContext(ended, newGraph);
    expect(ctx.lineChanged).toBe(true);
    expect(ctx.stations.map((s) => s.label)).toEqual(["Verify", "Review", "Intent", "Rebase", "Ask", "Decide"]);
  });

  test("focus follows the viewer's session, and the arrows reach every station back to the first", () => {
    const ctx = flowContext(run, null, { conversationId: "convReview" });
    expect(ctx.stations[ctx.focus].id).toBe("review__review");
    expect(ctx.stations[stepTarget(ctx, ctx.focus, 1)].id).toBe("intent");
    expect(ctx.stations[stepTarget(ctx, ctx.focus, -1)].id).toBe("check__verify");
    expect(stepTarget(ctx, 0, -1)).toBe(-1);
  });

  test("a station with no session carries what it printed, so it reads in place", () => {
    const failed = { ...run, node_statuses: run.node_statuses.map((n) => n.node_id === "ship__rebase" ? { ...n, result_preview: "CONFLICT (content): evalCatalog.json", outcome: "conflict" } : n) };
    const rebase = flowContext(failed, null).stations.find((s) => s.id === "ship__rebase")!;
    expect(rebase).toMatchObject({ state: "failed", output: "CONFLICT (content): evalCatalog.json", outcome: "conflict" });
    expect(rebase.href).toBeUndefined();
  });

  test("the origin leads: the session the task was filed from, then the task", () => {
    expect(flowOrigin({ task_short_id: "ct-98224", task_title: "Counterpart fee", task_origin_conversation_id: "c1" }, "Eval requests dashboard")).toEqual([
      { key: "session", label: "Eval requests dashboard", href: "/conversation/c1" },
      { key: "task", label: "Counterpart fee", ref: "ct-98224", href: "/tasks/ct-98224" },
    ]);
    expect(flowOrigin({})).toEqual([]);
  });

  test("with a current graph, stations not reached yet show in graph order", () => {
    const live = { _id: "r2", status: "running", current_node_id: "build", node_statuses: [{ node_id: "plan", status: "completed", session_id: "s1", ...t(0, 60) }, { node_id: "build", status: "running", session_id: "s2", started_at: 60000 }] };
    const graph = { nodes: [{ id: "start", type: "start" }, { id: "plan", label: "Plan", type: "agent" }, { id: "route", type: "conditional" }, { id: "skipped", label: "Skipped branch", type: "agent" }, { id: "build", label: "Build", type: "agent" }, { id: "review", label: "Review", type: "agent" }, { id: "exit", type: "exit" }] };
    const ctx = flowContext({ ...live, gate_node_id: "" }, graph);
    expect(ctx.lineChanged).toBe(false);
    expect(ctx.stations.map((s) => `${s.label}:${s.state}`)).toEqual(["Plan:done", "Build:live"]);
    expect(ctx.ahead.map((s) => s.label)).toEqual(["Review"]);
    expect(ctx.at).toBe(1);
    expect(ctx.focus).toBe(1);
  });

  test("a run standing at a fan-out says so", () => {
    const run3 = { _id: "r3", status: "running", gate_node_id: "", current_node_id: "land__checks", node_statuses: [{ node_id: "land__pr", status: "completed", session_id: "s1", ...t(0, 30) }, { node_id: "land__checks", status: "running", started_at: 30000 }] };
    const ctx = flowContext(run3, { nodes: [{ id: "land__pr", type: "agent" }, { id: "land__checks", label: "Checks", type: "parallel_fanout" }, { id: "land__merge", type: "command" }] });
    expect(ctx.stations[ctx.at]).toMatchObject({ id: "land__checks", label: "Checks", state: "live" });
  });

  test("names read from ids", () => {
    expect(stationName("ship__rebase")).toBe("Rebase");
    expect(stationName("fix_conflict")).toBe("Fix conflict");
    expect(stationName("x", "Resolve conflict")).toBe("Resolve conflict");
  });
});
