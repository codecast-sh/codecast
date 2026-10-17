// A station's hand ends with its station (workflow_runs.stopStationHands).
// AgentWatch trial, 2026-10-16: 39 hand processes were alive for 10 active
// runs, some for 12 hours, because a hand that settled was never stopped and
// the runner's own kill dismissed the card. The server stops a hand when the
// runner reports its node over and every hand the run still holds when the
// run ends; the stop keeps the card, and a running report stops nothing, so a
// resumed runner can wait on its hand again.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { cancelCore, updateProgress } from "./workflow_runs";
import { hashToken } from "./apiTokens";

const T0 = 1_790_000_000_000;
const TOKEN = "station-hands-token";
const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./workflow_runs.ts": () => import("./workflow_runs"),
};

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder" } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0 } as any);
    const conv = (extra: Record<string, any>) => ctx.db.insert("conversations", { user_id: owner, agent_type: "claude_code", status: "active", started_at: T0, updated_at: T0, message_count: 4, ...extra } as any);
    const runLog = await conv({ session_id: "uuid-run", short_id: "jx7run0" });
    const propose = await conv({ session_id: "uuid-propose", short_id: "jx7prop", parent_conversation_id: runLog });
    const build = await conv({ session_id: "uuid-build", short_id: "jx7bild", parent_conversation_id: runLog });
    // A node session that is not one of this run's hands (a `claude -p` node's own session).
    const outside = await conv({ session_id: "uuid-outside", short_id: "jx7outs" });
    const run = await ctx.db.insert("workflow_runs", {
      user_id: owner, workflow_name: "agentwatch_trial", status: "running", primary_conversation_id: runLog,
      node_statuses: [
        { node_id: "propose", status: "running", session_id: "jx7prop", started_at: T0 },
        { node_id: "scan", status: "completed", session_id: "jx7outs", started_at: T0 },
      ],
      created_at: T0, updated_at: T0,
    } as any);
    return { owner, runLog, propose, build, outside, run };
  });
  return { t, ids };
}

const report = (t: any, run: any, extra: Record<string, any>) =>
  t.run((ctx: any) => (updateProgress as any)._handler({ db: ctx.db }, { api_token: TOKEN, run_id: run, current_node_id: extra.node_id, ...extra }));

const state = (t: any, id: any) => t.run(async (ctx: any) => {
  const conv = await ctx.db.get(id);
  const kills = (await ctx.db.query("daemon_commands").collect()).filter((c: any) => c.command === "kill_session" && JSON.parse(c.args).conversation_id === String(id));
  return { killed: !!conv.inbox_killed_at, dismissed: !!conv.inbox_dismissed_at, status: conv.status, kills: kills.map((c: any) => JSON.parse(c.args)) };
});

describe("a station's hand ends with its station", () => {
  test("a running report stops nothing: a resumed runner waits on the hand again", async () => {
    const { t, ids } = await setup();
    await report(t, ids.run, { node_id: "propose", node_status: "running", session_id: "jx7prop" });
    expect((await state(t, ids.propose)).kills).toEqual([]);
  });

  test("the node's end stops its hand and keeps its card, the run's worktree left alone", async () => {
    const { t, ids } = await setup();
    await report(t, ids.run, { node_id: "propose", node_status: "completed", outcome: "success", session_id: "jx7prop" });
    const propose = await state(t, ids.propose);
    expect(propose).toMatchObject({ killed: true, dismissed: false, status: "completed" });
    expect(propose.kills).toEqual([expect.objectContaining({ session_id: "uuid-propose", cause: "station_ended", keep_workspace: true })]);
    // Only that station's hand: the other station is still running.
    expect((await state(t, ids.build)).kills).toEqual([]);
  });

  test("a timed-out station's failed report stops its hand the same way", async () => {
    const { t, ids } = await setup();
    await report(t, ids.run, { node_id: "propose", node_status: "failed", outcome: "failure", session_id: "jx7prop" });
    expect((await state(t, ids.propose)).killed).toBe(true);
  });

  test("the run's end stops every hand it still holds, once, and never a session outside the run", async () => {
    const { t, ids } = await setup();
    await report(t, ids.run, { node_id: "propose", node_status: "completed", outcome: "success", session_id: "jx7prop" });
    await report(t, ids.run, { node_id: "build", node_status: "running", session_id: "jx7bild" });
    await report(t, ids.run, { node_id: "build", node_status: "failed", run_status: "failed", fail_reason: "the runner was stopped (SIGINT) at build" });
    expect((await state(t, ids.build)).killed).toBe(true);
    expect((await state(t, ids.propose)).kills).toHaveLength(1);
    expect(await state(t, ids.outside)).toMatchObject({ killed: false, kills: [] });
  });

  test("a cancelled run stops the hand it was waiting on", async () => {
    const { t, ids } = await setup();
    await t.run(async (ctx: any) => cancelCore({ db: ctx.db }, await ctx.db.get(ids.run), T0 + 10));
    expect((await state(t, ids.propose)).killed).toBe(true);
    expect((await t.run((ctx: any) => ctx.db.get(ids.run))).status).toBe("failed");
  });
});
