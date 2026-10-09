// A dynamic run (the Workflow tool, called mid-conversation) hosts in the
// person's own session. That session gets the run POINTER so its card can say
// "workflow running", but never is_workflow_primary: the flag means "this
// session is the run's log", and claiming it took the composer away for a
// RunLogEndedBar as soon as the run ended.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { ingestSnapshot, unmarkDynamicRunHosts } from "./workflow_runs";
import { hashToken } from "./apiTokens";

const HOST = "users_host" as any;
const TOKEN = "dynamic-host-token";
const NOW = 1_800_000_000_000;

async function seed(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: HOST, name: "Host" }],
    teams: [],
    team_memberships: [],
    api_tokens: [{ _id: "token_host", user_id: HOST, token_hash: await hashToken(TOKEN) }],
    directory_team_mappings: [],
    conversations: [
      // A person's own session, mid-conversation, that called the Workflow tool.
      { _id: "conversations_host", session_id: "sess-host", user_id: HOST, message_count: 40 },
    ],
    workflow_runs: [],
    messages: [],
    ...extra,
  };
  const db = makeFakeDb(tables);
  const ctx = { db, scheduler: { runAfter: async () => null }, async runMutation() { return null; } } as any;
  return { ctx, tables };
}

const snapshot = (ctx: any, status: string) =>
  (ingestSnapshot as any)._handler(ctx, {
    api_token: TOKEN,
    external_run_id: "wf_c6c86999-01a",
    session_id: "sess-host",
    workflow_name: "huddles-deep-review",
    status,
    phases: [{ title: "Review" }],
    agents: [{ agent_id: "a1", label: "verify:the ring race", state: "done" }],
  });

describe("a dynamic run's host session is not the run's log", () => {
  test("a live snapshot stamps the pointer and leaves the flag unset", async () => {
    const { ctx, tables } = await seed();
    const r = await snapshot(ctx, "running");
    expect(r.ok).toBe(true);
    const conv = tables.conversations.find((c) => c._id === "conversations_host")!;
    expect(conv.workflow_run_id).toBe(r.run_id);
    expect(conv.is_workflow_primary).toBeFalsy();
  });

  test("the flag stays unset once the run ends, so the composer survives", async () => {
    const { ctx, tables } = await seed();
    await snapshot(ctx, "running");
    await snapshot(ctx, "completed");
    const conv = tables.conversations.find((c) => c._id === "conversations_host")!;
    expect(conv.is_workflow_primary).toBeFalsy();
  });
});

describe("unmarkDynamicRunHosts repairs the sessions already stamped", () => {
  test("clears the flag on a real host and reports it", async () => {
    const { ctx, tables } = await seed();
    const r = await snapshot(ctx, "completed");
    // The old stamp, as the rows in the wild carry it.
    await ctx.db.patch("conversations_host", { is_workflow_primary: true });

    const dry = await (unmarkDynamicRunHosts as any)._handler(ctx, { dry_run: true });
    expect(dry.cleared).toEqual(["sess-host"]);
    expect(tables.conversations.find((c) => c._id === "conversations_host")!.is_workflow_primary).toBe(true);

    await (unmarkDynamicRunHosts as any)._handler(ctx, { dry_run: false });
    expect(tables.conversations.find((c) => c._id === "conversations_host")!.is_workflow_primary).toBe(false);
    expect(r.run_id).toBeTruthy();
  });

  test("leaves a log the line opened for its run alone", async () => {
    const RUN = "workflow_runs_line";
    const { ctx, tables } = await seed({
      conversations: [
        { _id: "conversations_log", session_id: `wf-${RUN}`, user_id: HOST, message_count: 1, workflow_run_id: RUN, is_workflow_primary: true },
      ],
      workflow_runs: [{
        _id: RUN, user_id: HOST, status: "completed", node_statuses: [], external_run_id: "wf_line-01",
        primary_conversation_id: "conversations_log", created_at: NOW, updated_at: NOW,
      }],
    });
    const out = await (unmarkDynamicRunHosts as any)._handler(ctx, { dry_run: false });
    expect(out.cleared).toEqual([]);
    expect(tables.conversations.find((c) => c._id === "conversations_log")!.is_workflow_primary).toBe(true);
  });
});
