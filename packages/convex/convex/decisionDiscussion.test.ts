import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { decisionOwner, discussCore, discussionTurns } from "./decisionDiscussion";
import { formatDecisionDiscussion, parseDecisionDiscussion } from "@codecast/shared/contracts";

// Every decision has a session to discuss it with (ct-58330): the session
// that presents it, falling to the run's starter, the project lead's standing
// session, then the workspace agent, and a person's words reach it on the
// pending message rail with the owner's reply read back from its transcript.

const HOST = "users_host" as any;
const BOT = "users_bot" as any; // an agent account: runs sessions, reads no queue
const OUTSIDER = "users_out" as any;
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function seed(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: HOST, name: "Ashot" },
      { _id: BOT, name: "agent", is_bot: true },
      { _id: OUTSIDER, name: "Outsider" },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    team_memberships: [{ _id: "m1", user_id: HOST, team_id: TEAM, role: "admin" }],
    projects: [{ _id: "projects_p1", title: "Agent Quality", team_id: TEAM, owner_role_id: "org_roles_lead" }],
    org_roles: [
      {
        _id: "org_roles_lead", scope_type: "team", team_id: TEAM, host_user_id: HOST, name: "Agent Quality lead", handle: "aq",
        scope: { project_ids: ["projects_p1"], plan_ids: [] }, reports_to: { kind: "user", user_id: HOST }, status: "active",
        anchor_id: "anchors_lead", created_at: NOW, updated_at: NOW,
      },
    ],
    anchors: [
      { _id: "anchors_lead", team_id: TEAM, scope_type: "team", org_role_id: "org_roles_lead", conversation_id: "conversations_lead", status: "active" },
      { _id: "anchors_ws", team_id: TEAM, scope_type: "team", conversation_id: "conversations_ws", status: "active" },
    ],
    conversations: [
      { _id: "conversations_ask", short_id: "jxask01", session_id: "sess-ask", user_id: HOST, owner_user_id: HOST, team_id: TEAM, title: "Fix the cart", message_count: 4 },
      { _id: "conversations_runlog", short_id: "jxlog01", session_id: "sess-log", user_id: HOST, team_id: TEAM, title: "line run", is_workflow_primary: true, message_count: 2 },
      { _id: "conversations_starter", short_id: "jxsta01", session_id: "sess-sta", user_id: HOST, owner_user_id: HOST, team_id: TEAM, title: "Planner", message_count: 9 },
      { _id: "conversations_lead", short_id: "jxlead1", session_id: "sess-lead", user_id: HOST, team_id: TEAM, title: "lead", standing_role_id: "org_roles_lead", message_count: 30 },
      { _id: "conversations_ws", short_id: "jxws001", session_id: "sess-ws", user_id: HOST, team_id: TEAM, title: "workspace agent", message_count: 50 },
      { _id: "conversations_bot", short_id: "jxbot01", session_id: "sess-bot", user_id: BOT, team_id: TEAM, title: "unowned", message_count: 3 },
    ],
    session_owners: [
      { _id: "so1", conversation_id: "conversations_ask", user_id: HOST, added_by: HOST, added_at: NOW },
      { _id: "so2", conversation_id: "conversations_starter", user_id: HOST, added_by: HOST, added_at: NOW },
    ],
    tasks: [{ _id: "tasks_t1", short_id: "ct-7", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, title: "Cart total", status: "in_review", project_id: "projects_p1" }],
    workflow_runs: [
      { _id: "workflow_runs_detached", user_id: HOST, team_id: TEAM, task_id: "tasks_t1", primary_conversation_id: "conversations_runlog", status: "paused" },
      { _id: "workflow_runs_started", user_id: HOST, team_id: TEAM, task_id: "tasks_t1", primary_conversation_id: "conversations_runlog", spawner_conversation_id: "conversations_starter", status: "paused" },
    ],
    session_decisions: [],
    pending_messages: [],
    messages: [],
    ...extra,
  };
  const db = makeFakeDb(tables);
  return { ctx: { db } as any, tables };
}

const decision = (over: Record<string, any> = {}) => ({
  _id: "session_decisions_d1",
  short_id: "sd-9",
  conversation_id: "conversations_ask",
  session_id: "sess-ask",
  user_id: HOST,
  asked_user_ids: [HOST],
  question: "Ship the cart fix?",
  options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }],
  blocking: true,
  status: "pending",
  created_at: NOW,
  ...over,
});

describe("decisionOwner", () => {
  test("the session that asked owns its own question", async () => {
    const { ctx } = seed();
    const owner = await decisionOwner(ctx, decision() as any);
    expect(owner?.via).toBe("asker");
    expect(String(owner?.conversation._id)).toBe("conversations_ask");
  });

  test("a gate asked through a run's log falls to the session that started the run", async () => {
    const { ctx } = seed();
    const owner = await decisionOwner(ctx, decision({ conversation_id: "conversations_runlog", workflow_run_id: "workflow_runs_started", task_id: "tasks_t1" }) as any);
    expect(owner?.via).toBe("run");
    expect(String(owner?.conversation._id)).toBe("conversations_starter");
  });

  test("a run started outside any session is the project lead's to discuss", async () => {
    const { ctx } = seed();
    const owner = await decisionOwner(ctx, decision({ conversation_id: "conversations_runlog", workflow_run_id: "workflow_runs_detached" }) as any);
    expect(owner?.via).toBe("lead");
    expect(String(owner?.conversation._id)).toBe("conversations_lead");
  });

  test("an asker that is gone gets an owner: the lead, else the workspace agent", async () => {
    const { ctx, tables } = seed();
    tables.conversations.find((c) => c._id === "conversations_ask")!.inbox_killed_at = NOW;
    expect((await decisionOwner(ctx, decision({ task_id: "tasks_t1" }) as any))?.via).toBe("lead");
    const noTask = await decisionOwner(ctx, decision() as any);
    expect(noTask?.via).toBe("workspace");
    expect(String(noTask?.conversation._id)).toBe("conversations_ws");
    // A deleted asker leaves no team to read: the asked person's own agent.
    expect(await decisionOwner(ctx, decision({ conversation_id: "conversations_missing" }) as any)).toBeNull();
    tables.anchors.push({ _id: "anchors_personal", scope_type: "user", scope_user_id: HOST, conversation_id: "conversations_starter", status: "active" });
    const deleted = await decisionOwner(ctx, decision({ conversation_id: "conversations_missing" }) as any);
    expect(deleted?.via).toBe("workspace");
    expect(String(deleted?.conversation._id)).toBe("conversations_starter");
  });

  test("a session nobody answers for (an agent account's, no owner) is not an owner", async () => {
    const { ctx } = seed();
    const owner = await decisionOwner(ctx, decision({ conversation_id: "conversations_bot", task_id: "tasks_t1" }) as any);
    expect(owner?.via).toBe("lead");
  });

  test("a paused org (no reachable lead) still leaves the workspace agent", async () => {
    const { ctx, tables } = seed();
    tables.org_roles[0].status = "retired";
    const owner = await decisionOwner(ctx, decision({ conversation_id: "conversations_runlog", workflow_run_id: "workflow_runs_detached" }) as any);
    expect(owner?.via).toBe("workspace");
  });
});

describe("discussCore", () => {
  test("the words reach the owner as a decision-discussion frame and the ask is recorded", async () => {
    const { ctx, tables } = seed({ session_decisions: [decision({ conversation_id: "conversations_runlog", workflow_run_id: "workflow_runs_detached" })] });
    const r = await discussCore(ctx, HOST, { decision: "sd-9", text: "Why does this need a new table?", client_id: "c1" });
    expect(r).toEqual({ ok: true, conversation_id: "conversations_lead" as any });
    const sent = tables.pending_messages.find((m) => m.client_id === "c1");
    expect(String(sent.conversation_id)).toBe("conversations_lead");
    expect(sent.human).toBe(true);
    const frame = parseDecisionDiscussion(sent.content);
    expect(frame).toEqual({ decision: "sd-9", from: "Ashot", about: 'About sd-9 ("Ship the cart fix?"):', body: "Why does this need a new table?" });
    const row = tables.session_decisions[0];
    expect(row.discussion).toHaveLength(1);
    expect(row.discussion[0]).toMatchObject({ conversation_id: "conversations_lead", text: "Why does this need a new table?", client_id: "c1" });
  });

  test("a redelivered send is one ask and one message", async () => {
    const { ctx, tables } = seed({ session_decisions: [decision()] });
    await discussCore(ctx, HOST, { decision: "session_decisions_d1", text: "hm?", client_id: "c2" });
    await discussCore(ctx, HOST, { decision: "session_decisions_d1", text: "hm?", client_id: "c2" });
    expect(tables.session_decisions[0].discussion).toHaveLength(1);
    expect(tables.pending_messages.filter((m) => m.client_id === "c2")).toHaveLength(1);
  });

  test("someone who cannot read the decision cannot discuss it", async () => {
    const { ctx, tables } = seed({ session_decisions: [decision({ conversation_id: "conversations_lead" })] });
    tables.conversations.find((c) => c._id === "conversations_lead")!.is_private = true;
    const r = await discussCore(ctx, OUTSIDER, { decision: "sd-9", text: "let me in", client_id: "c3" });
    expect(r).toEqual({ error: "Decision not found" });
    expect(tables.pending_messages).toHaveLength(0);
  });

  test("an empty message is refused", async () => {
    const { ctx } = seed({ session_decisions: [decision()] });
    expect(await discussCore(ctx, HOST, { decision: "sd-9", text: "   ", client_id: "c4" })).toEqual({ error: "The message is empty" });
  });
});

describe("discussionTurns", () => {
  const ask = { conversation_id: "conversations_lead" as any, user_id: HOST, text: "Why a new table?", client_id: "c1", at: NOW };
  const frame = (body: string) => formatDecisionDiscussion({ decision: "sd-9", question: "Ship the cart fix?", from: "Ashot", body });
  const msg = (i: number, role: string, content: string, extra: Record<string, any> = {}) => ({ _id: `messages_${i}`, conversation_id: "conversations_lead", role, content, timestamp: NOW + i * 1000, ...extra });

  test("the reply is the owner's last words after the ask, before the next turn", async () => {
    const { ctx } = seed({
      messages: [
        msg(0, "assistant", "earlier, unrelated"),
        msg(1, "user", frame("Why a new table?")),
        msg(2, "assistant", "Reading sd-9."),
        msg(3, "user", "", { tool_results: [{ tool_use_id: "t", content: "ok" }] }),
        msg(4, "assistant", "It needs one because the bodies exceed the row cap."),
        msg(5, "user", "something else entirely"),
        msg(6, "assistant", "not a reply to the ask"),
      ],
    });
    const [turn] = await discussionTurns(ctx, { _id: "session_decisions_d1" as any, short_id: "sd-9", discussion: [ask] });
    expect(turn.delivered).toBe(true);
    expect(turn.reply).toEqual({ text: "It needs one because the bodies exceed the row cap.", at: NOW + 4000 });
  });

  test("an ask still on its way has no reply, and a collapsed newline still matches", async () => {
    const { ctx } = seed({ messages: [msg(1, "assistant", "busy with something")] });
    const [pending] = await discussionTurns(ctx, { _id: "session_decisions_d1" as any, short_id: "sd-9", discussion: [ask] });
    expect(pending).toMatchObject({ delivered: false, reply: null });

    const collapsed = frame("Why a new table?").replace(/\n/g, " ");
    const seeded = seed({ messages: [msg(1, "user", collapsed), msg(2, "assistant", "Because of the cap.")] });
    const [turn] = await discussionTurns(seeded.ctx, { _id: "session_decisions_d1" as any, short_id: "sd-9", discussion: [ask] });
    expect(turn.reply?.text).toBe("Because of the cap.");
  });
});
