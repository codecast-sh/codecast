// One verdict, two fact-gatherers: the web reads the inbox row it holds
// (web lib/sessionClose inFlightFactsOfRow), the server reads its database
// (lib/closeAside inFlightFactsOnServer). Fed the same session, they must hand
// the shared closeInFlightReason the same facts, or a close the client paints
// as "set aside" lands as a stop (or the reverse).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { closeInFlightReason } from "@codecast/shared/contracts";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { inFlightFactsOnServer } from "./lib/closeAside";
import { inFlightFactsOfRow } from "../../web/lib/sessionClose";

setDefaultTimeout(60_000);

const NOW = Date.now();
type Scenario = {
  conv?: Record<string, unknown>;
  agent?: string;
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
  "usage limit": { conv: { pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: NOW - 60_000 } },
  "old usage limit": { conv: { pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: NOW - 30 * 24 * 3_600_000 } },
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
    if (sc.agent) await ctx.db.insert("managed_sessions", { session_id: "s-agree", conversation_id: convId, user_id: user, pid: 1, started_at: NOW, last_heartbeat: NOW - 1000, agent_status: sc.agent, agent_status_updated_at: NOW - 1000 } as any);
    if (sc.queuedRow) await ctx.db.insert("pending_messages", { conversation_id: convId, from_user_id: user, content: "x", status: "pending", created_at: NOW, retry_count: 0 } as any);
    if (sc.poll) await ctx.db.insert("messages", { conversation_id: convId, role: "assistant", content: "", timestamp: NOW, tool_calls: [{ id: "q", name: "AskUserQuestion", input: "{}" }] } as any);
    const server = await inFlightFactsOnServer(ctx, await ctx.db.get(convId), NOW);
    const row = {
      ...base,
      agent_status: sc.agent ?? null,
      last_heartbeat: sc.agent ? NOW - 1000 : null,
      agent_status_updated_at: sc.agent ? NOW - 1000 : null,
      has_pending: !!(sc.conv as any)?.has_pending_messages,
      // The inbox row's awaiting_input: an open poll or a permission prompt.
      awaiting_input: !!sc.poll || sc.agent === "permission_blocked",
      workflow_run_id: sc.run ? "run" : null,
      workflow_run_status: runStatus,
      workflow_run_kind: runKind,
    };
    const client = inFlightFactsOfRow(row as any, NOW);
    return { server, client };
  });
}

describe("the client and the server gather the same in-flight facts", () => {
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      const { server, client } = await bothSides(sc);
      // The verdict agrees; so does every fact except how a turn is seen
      // (the row may count a queued message as producing, the database as queued).
      expect(closeInFlightReason(client) === null).toBe(closeInFlightReason(server) === null);
      expect({ ...client, turnLive: undefined }).toEqual({ ...server, turnLive: undefined });
    });
  }
});
