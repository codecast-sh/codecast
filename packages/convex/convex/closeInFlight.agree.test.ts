// One verdict, two fact-gatherers: the web reads the inbox row it holds
// (web lib/sessionClose inFlightFactsOfRow), the server reads its database
// (lib/closeAside inFlightFactsOnServer). Fed the same session, they must hand
// the shared closeInFlightReason the same facts, or a close the client paints
// as "set aside" lands as a stop (or the reverse).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { closeInFlightReason, IN_FLIGHT_FACT_KEYS } from "@codecast/shared/contracts";
import { closeLeavesStanding, standsApartFromLead, stillHolds } from "@codecast/shared/contracts/closeCascade";
import { launchedHeadless } from "@codecast/shared/contracts/runsInParent";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { cascadeTakesDown, closeSetsAsideOnServer, holdFactsOnServer, inFlightFactsOnServer, nestedGroupOf } from "./lib/closeAside";
import { closeTakesDownOf, holdFactsOfRow, inFlightFactsOfRow, nestedInFlightOf } from "../../web/lib/sessionClose";

setDefaultTimeout(60_000);

const NOW = Date.now();
type Scenario = {
  conv?: Record<string, unknown>;
  agent?: string;
  openTasks?: { at: number; heartbeat: number };
  queuedRow?: boolean;
  run?: { run_kind?: "workflow"; status: string };
  poll?: boolean;
};

// The same session as both sides see it. `row` is what the inbox row carries
// for it (the server ships these fields: agent_status from the managed
// session, has_pending, awaiting_input, the run's status and kind).
const SCENARIOS: Record<string, Scenario> = {
  settled: { agent: "idle" },
  "no process": {},
  working: { agent: "working", conv: { updated_at: NOW - 1000 } },
  "permission prompt": { agent: "permission_blocked" },
  "open poll": { agent: "idle", poll: true },
  queued: { agent: "idle", conv: { has_pending_messages: true }, queuedRow: true },
  "fresh loop": { conv: { loop_state: { status: "armed", wakeup_at: NOW + 600_000, armed_at: NOW, event_at: NOW } } },
  "overdue loop": { conv: { loop_state: { status: "armed", wakeup_at: NOW - 3_600_000, armed_at: NOW - 7_200_000, event_at: NOW - 7_200_000 } } },
  "workflow tool run": { run: { run_kind: "workflow", status: "running" } },
  "flow run": { run: { status: "running" } },
  "background work": { agent: "waiting", openTasks: { at: NOW - 30_000, heartbeat: NOW - 1000 } },
  "background work, daemon gone": { agent: "waiting", openTasks: { at: NOW - 30_000, heartbeat: NOW - 3_600_000 } },
  "fleet queued": { conv: { subagent_slot: "queued", subagent_slot_at: NOW - 60_000, parent_conversation_id: undefined } },
  "usage limit": { conv: { pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: NOW - 60_000 } },
  "old usage limit": { conv: { pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: NOW - 30 * 24 * 3_600_000 } },
  // killSession stamps inbox_killed_at without inbox_dismissed_at; a killed row is never revived.
  "killed with a usage limit": { conv: { pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: NOW - 60_000, inbox_killed_at: NOW - 30_000 } },
  "armed trigger, no process": { conv: { armed_trigger_kind: "once" } },
};

async function bothSides(sc: Scenario) {
  const t = convexTest(schema, allModules);
  return t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Riley" } as any);
    const base = { user_id: user, agent_type: "claude_code", started_at: NOW - 3_600_000, updated_at: NOW - 3_600_000, status: "active", session_id: "s-agree", message_count: 8, last_message_role: "assistant", ...sc.conv };
    const convId = await ctx.db.insert("conversations", base as any);
    let runStatus: string | null = null;
    let runKind: string | null = null;
    if (sc.run) {
      const run = await ctx.db.insert("workflow_runs", { user_id: user, workflow_name: "w", status: sc.run.status, node_statuses: [], created_at: 1, updated_at: 1, ...(sc.run.run_kind ? { run_kind: sc.run.run_kind, external_run_id: "x" } : {}) } as any);
      await ctx.db.patch(convId, { workflow_run_id: run } as any);
      runStatus = sc.run.status;
      runKind = sc.run.run_kind ?? null;
    }
    const heartbeat = sc.openTasks?.heartbeat ?? NOW - 1000;
    const openTasks = sc.openTasks ? { open_tasks: [{ id: "b1", kind: "background", command: "bun run build" }], open_tasks_at: sc.openTasks.at } : {};
    if (sc.agent) await ctx.db.insert("managed_sessions", { session_id: "s-agree", conversation_id: convId, user_id: user, pid: 1, started_at: NOW, last_heartbeat: heartbeat, agent_status: sc.agent, agent_status_updated_at: NOW - 1000, ...openTasks } as any);
    if (sc.queuedRow) await ctx.db.insert("pending_messages", { conversation_id: convId, from_user_id: user, content: "x", status: "pending", created_at: NOW, retry_count: 0 } as any);
    if (sc.poll) await ctx.db.insert("messages", { conversation_id: convId, role: "assistant", content: "", timestamp: NOW, tool_calls: [{ id: "q", name: "AskUserQuestion", input: "{}" }] } as any);
    const server = await inFlightFactsOnServer(ctx, await ctx.db.get(convId), NOW);
    const serverHold = await holdFactsOnServer(ctx, await ctx.db.get(convId), NOW);
    const row = {
      ...base,
      agent_status: sc.agent ?? null,
      last_heartbeat: sc.agent ? heartbeat : null,
      ...openTasks,
      agent_status_updated_at: sc.agent ? NOW - 1000 : null,
      has_pending: !!(sc.conv as any)?.has_pending_messages,
      // The inbox row's awaiting_input: an open poll or a permission prompt.
      awaiting_input: !!sc.poll || sc.agent === "permission_blocked",
      workflow_run_id: sc.run ? "run" : null,
      workflow_run_status: runStatus,
      workflow_run_kind: runKind,
    };
    const client = inFlightFactsOfRow(row as any, NOW);
    const clientHold = holdFactsOfRow(row as any, NOW);
    return { server, client, serverHold, clientHold };
  });
}

describe("the client and the server gather the same in-flight facts", () => {
  test("each fills exactly the shared fact set, so neither can leave a fact out", async () => {
    const { server, client } = await bothSides(SCENARIOS.settled!);
    expect(Object.keys(client).sort()).toEqual([...IN_FLIGHT_FACT_KEYS].sort());
    expect(Object.keys(server).sort()).toEqual([...IN_FLIGHT_FACT_KEYS].sort());
  });

  for (const [name, sc] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      const { server, client, serverHold, clientHold } = await bothSides(sc);
      // What a spawned child left up by its lead's close still holds: the
      // shared stillHolds, over facts gathered on each side.
      expect(stillHolds(clientHold)).toBe(stillHolds(serverHold));
      expect([clientHold.processAlive, clientHold.triggerArmed]).toEqual([serverHold.processAlive, serverHold.triggerArmed]);
      // The verdict agrees; so does every fact except how a turn is seen
      // (the row may count a queued message as producing, the database as queued).
      expect(closeInFlightReason(client) === null).toBe(closeInFlightReason(server) === null);
      expect({ ...client, turnLive: undefined }).toEqual({ ...server, turnLive: undefined });
    });
  }
});

// The group a close reads: the web (closeTakesDownOf, nestedInFlightOf over the
// rows it holds) and the server (nestedGroupOf + cascadeTakesDown, and
// closeSetsAsideOnServer) must name the same members and the same verdict, and
// adopt the same spawned children. A close takes down only what goes down with
// the lead (Task subagents and teammates).
describe("the client and the server agree on the group a close takes down", () => {
  type Kid = { session_id: string; busy?: boolean; mate?: boolean; conv?: Record<string, unknown> };
  async function group(kids: Kid[]) {
    const t = convexTest(schema, allModules);
    return t.run(async (ctx) => {
      const user = await ctx.db.insert("users", { name: "Riley" } as any);
      const leadBase = { user_id: user, agent_type: "claude_code", started_at: NOW - 3_600_000, updated_at: NOW - 3_600_000, status: "active", session_id: "s-lead", message_count: 8, last_message_role: "assistant" };
      const lead = await ctx.db.insert("conversations", leadBase as any);
      const rows: any[] = [{ ...leadBase, _id: String(lead) }];
      for (const k of kids) {
        const base = {
          user_id: user, agent_type: "claude_code", started_at: NOW - 600_000, updated_at: k.busy ? NOW - 1000 : NOW - 3_600_000, status: "active",
          session_id: k.session_id, message_count: 4, last_message_role: "assistant",
          ...(k.mate ? { spawned_by_conversation_id: lead, agent_team_name: "crew", agent_name: "reviewer" } : { is_subagent: true, parent_conversation_id: lead }),
          ...k.conv,
        };
        const id = await ctx.db.insert("conversations", base as any);
        if (k.busy) await ctx.db.insert("managed_sessions", { session_id: k.session_id, conversation_id: id, user_id: user, pid: 2, started_at: NOW, last_heartbeat: NOW - 1000, agent_status: "working", agent_status_updated_at: NOW - 1000 } as any);
        // The row a client holds: no cli_flags (never sent), its verdict instead.
        const { cli_flags: _flags, ...sent } = base as any;
        rows.push({
          ...sent, headless_launch: launchedHeadless(base as any), _id: String(id), ...(k.mate ? { spawned_by_conversation_id: String(lead) } : { parent_conversation_id: String(lead) }),
          agent_status: k.busy ? "working" : null, agent_status_updated_at: k.busy ? NOW - 1000 : null, last_heartbeat: k.busy ? NOW - 1000 : null,
          has_pending: false, awaiting_input: false,
        });
      }
      const leadRow = await ctx.db.get(lead);
      const serverDown = (await nestedGroupOf(ctx, leadRow)).filter((c) => cascadeTakesDown(c, "inbox_dismissed_at", { close: true })).map((c) => c.session_id).sort();
      const serverAside = await closeSetsAsideOnServer(ctx, leadRow, NOW);
      const clientDown = closeTakesDownOf(rows, String(lead)).map((r: any) => r.session_id).sort();
      const clientAside = nestedInFlightOf(rows, String(lead), NOW);
      const serverStanding: string[] = [];
      for (const c of await nestedGroupOf(ctx, leadRow)) {
        if (standsApartFromLead(c) && stillHolds(await holdFactsOnServer(ctx, c, NOW))) serverStanding.push(c.session_id);
      }
      const clientStanding = rows.slice(1).filter((r) => closeLeavesStanding(r, holdFactsOfRow(r, NOW))).map((r) => r.session_id).sort();
      return { serverDown, serverAside, clientDown, clientAside, serverStanding: serverStanding.sort(), clientStanding };
    });
  }

  test("a close takes the agent- subagents and the teammate, never a spawned child", async () => {
    const r = await group([
      { session_id: "agent-a0a0a06131" }, { session_id: "agent-a0a0a06132" }, { session_id: "ca19ce3d-spawned" },
      { session_id: "5b1e-mate", mate: true },
    ]);
    expect(r.serverDown).toEqual(["5b1e-mate", "agent-a0a0a06131", "agent-a0a0a06132"]);
    expect(r.clientDown).toEqual(r.serverDown);
  });

  test("a daemon-linked codex child (--print, which the client never sees) goes down on both sides; a /cli/spawn one stays up on both", async () => {
    const r = await group([
      { session_id: "019a-codex-thread", conv: { agent_type: "codex", cli_flags: "--print" } },
      { session_id: "019a-codex-station", conv: { agent_type: "codex" } },
    ]);
    expect(r.serverDown).toEqual(["019a-codex-thread"]);
    expect(r.clientDown).toEqual(r.serverDown);
  });

  test("both adopt the same spawned children: only the one that still holds something", async () => {
    const r = await group([
      { session_id: "ca19ce3d-live", busy: true },
      { session_id: "ca19ce3d-armed", conv: { armed_trigger_kind: "standing" } },
      { session_id: "ca19ce3d-done1", conv: { status: "completed" } },
      { session_id: "ca19ce3d-done2", conv: { status: "completed" } },
      { session_id: "agent-a0a0a062757379", busy: true },
    ]);
    expect(r.serverStanding).toEqual(["ca19ce3d-armed", "ca19ce3d-live"]);
    expect(r.clientStanding).toEqual(r.serverStanding);
  });

  test("a spawned child mid-turn does not set its lead's close aside", async () => {
    const r = await group([{ session_id: "agent-a0a0a06131" }, { session_id: "ca19ce3d-spawned", busy: true }]);
    expect(r.serverAside).toBe(false);
    expect(r.clientAside).toBeNull();
  });

  test("an agent- subagent mid-turn does", async () => {
    const r = await group([{ session_id: "agent-a0a0a06131", busy: true }, { session_id: "ca19ce3d-spawned" }]);
    expect(r.serverAside).toBe(true);
    expect(r.clientAside).toBe("nested");
  });

  test("an already closed or killed subagent is not counted", async () => {
    const r = await group([
      { session_id: "agent-a0a0a0636c6f736564", conv: { inbox_dismissed_at: 5, inbox_closed_at: 5 } },
      { session_id: "agent-a0a0a06b696c6c6564", conv: { inbox_dismissed_at: 5, inbox_killed_at: 5 } },
      { session_id: "agent-a0a0a06c697665" },
    ]);
    expect(r.serverDown).toEqual(["agent-a0a0a06c697665"]);
    expect(r.clientDown).toEqual(r.serverDown);
  });
});
