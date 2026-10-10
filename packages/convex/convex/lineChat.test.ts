import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { lineChatBrief, lineChatOwner, lineChatTurns, sendLineChatCore } from "./lineChat";
import { formatLineChat, parseLineChat, lineFenceGuide, lineFenceHint, LINE_WIDGETS } from "@codecast/shared/contracts/lineChat";
import { discussCore } from "./decisionDiscussion";

// A conversation with a project's line (line-workspace.md LW4): the project
// lead's standing session answers, else a session started for the chat; the
// person's words reach it as a <line-chat> frame, the brief riding the first
// one, and each reply is read back from that session's transcript.

const HOST = "users_host" as any;
const OUTSIDER = "users_out" as any;
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function seed(opts: { lead?: boolean } = {}, extra: Record<string, any[]> = {}) {
  const lead = opts.lead ?? true;
  const tables: Record<string, any[]> = {
    users: [{ _id: HOST, name: "Ashot" }, { _id: OUTSIDER, name: "Outsider" }],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    team_memberships: [{ _id: "m1", user_id: HOST, team_id: TEAM, role: "admin" }],
    projects: [{
      _id: "projects_p1", short_id: "pj-aq", title: "Agent Quality", team_id: TEAM, workspace: `team:${TEAM}`, user_id: HOST,
      status: "active", created_at: NOW, updated_at: NOW,
      ...(lead ? { owner_role_id: "org_roles_lead" } : {}),
      line_profile: { finders: [], changed_at: NOW, root: "/Users/ashot/src/union", publisher_user_id: String(HOST), device_id: "dev1" },
    }],
    org_roles: lead ? [{
      _id: "org_roles_lead", scope_type: "team", team_id: TEAM, host_user_id: HOST, name: "Agent Quality lead", handle: "aq",
      scope: { project_ids: ["projects_p1"], plan_ids: [] }, reports_to: { kind: "user", user_id: HOST }, status: "active",
      anchor_id: "anchors_lead", created_at: NOW, updated_at: NOW,
    }] : [],
    anchors: lead ? [{ _id: "anchors_lead", team_id: TEAM, scope_type: "team", org_role_id: "org_roles_lead", conversation_id: "conversations_lead", status: "active" }] : [],
    conversations: lead ? [{ _id: "conversations_lead", short_id: "jxlead1", session_id: "sess-lead", user_id: HOST, team_id: TEAM, title: "lead", standing_role_id: "org_roles_lead", message_count: 30 }] : [],
    line_chats: [],
    pending_messages: [],
    messages: [],
    daemon_commands: [],
    devices: [],
    directory_team_mappings: [],
    session_owners: [],
    ...extra,
  };
  const db = makeFakeDb(tables);
  return { ctx: { db, scheduler: { runAfter: async () => null } } as any, tables };
}

const project = (tables: Record<string, any[]>) => tables.projects[0];

describe("the frame", () => {
  test("round trips the words, leaving the brief and the tail out", () => {
    const raw = formatLineChat({ project: "pj-aq", graph: "agentwatch", from: "Ashot", body: "Why did Dissolve close C119?", brief: "You answer for the line." });
    expect(parseLineChat(raw)).toEqual({ project: "pj-aq", graph: "agentwatch", from: "Ashot", body: "Why did Dissolve close C119?", briefed: true });
    const bare = formatLineChat({ project: "pj-aq", graph: null, from: "Ashot", body: "And Refine?" });
    expect(parseLineChat(bare)).toMatchObject({ graph: null, body: "And Refine?", briefed: false });
    // A tmux injection that collapses newlines and leaks a character ahead of the tag.
    expect(parseLineChat(`h${raw.replace(/\n/g, " ")}`)?.body).toBe("Why did Dissolve close C119?");
    expect(parseLineChat("just words")).toBeNull();
  });

  test("the brief hands over every widget the fence reader draws", () => {
    const { tables } = seed();
    const brief = lineChatBrief(project(tables), "agentwatch");
    for (const w of LINE_WIDGETS) expect(brief).toContain(`\`${w}\``);
    expect(brief).toContain(lineFenceGuide("pj-aq", "agentwatch"));
    expect(brief).toContain("cast workflow runs --task");
    expect(brief).toContain("/Users/ashot/src/union");
  });
});

describe("who answers", () => {
  test("the project's lead answers when its standing session can be reached", async () => {
    const { ctx, tables } = seed();
    const owner = await lineChatOwner(ctx, project(tables), null);
    expect(owner?.via).toBe("lead");
    expect(String(owner?.conversation._id)).toBe("conversations_lead");
  });

  test("with no lead, nobody answers until the first message starts a line session", async () => {
    const { ctx, tables } = seed({ lead: false });
    expect(await lineChatOwner(ctx, project(tables), null)).toBeNull();
  });
});

describe("sending", () => {
  test("the first message to a session carries the brief; the next does not; a redelivery is one ask", async () => {
    const { ctx, tables } = seed();
    const first = await sendLineChatCore(ctx, HOST, { project_id: "projects_p1", text: "Why did Dissolve close C119?", client_id: "c1", graph: "agentwatch" });
    expect(first).toMatchObject({ ok: true, conversation_id: "conversations_lead" });
    await sendLineChatCore(ctx, HOST, { project_id: "projects_p1", text: "And Refine?", client_id: "c2", graph: "agentwatch" });
    await sendLineChatCore(ctx, HOST, { project_id: "projects_p1", text: "And Refine?", client_id: "c2", graph: "agentwatch" });

    const sent = tables.pending_messages.map((m) => parseLineChat(m.content));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ project: "pj-aq", from: "Ashot", body: "Why did Dissolve close C119?", briefed: true });
    expect(sent[1]).toMatchObject({ body: "And Refine?", briefed: false });
    expect(tables.line_chats).toHaveLength(1);
    expect(tables.line_chats[0].asks.map((a: any) => a.client_id)).toEqual(["c1", "c2"]);
  });

  test("with no lead, the first message starts a line session in the publishing checkout, briefed", async () => {
    const { ctx, tables } = seed({ lead: false });
    const res = await sendLineChatCore(ctx, HOST, { project_id: "projects_p1", text: "Show me the steps", client_id: "c1", graph: null });
    expect("ok" in res && res.ok).toBe(true);
    const spawned = tables.conversations.find((c) => c.title === "Agent Quality · line chat");
    expect(spawned?.project_path).toBe("/Users/ashot/src/union");
    expect(tables.daemon_commands.some((c) => c.command === "start_session")).toBe(true);
    expect(String(tables.line_chats[0].line_conversation_id)).toBe(String(spawned._id));
    const seeded = tables.pending_messages.find((m) => String(m.conversation_id) === String(spawned._id));
    expect(parseLineChat(seeded?.content)).toMatchObject({ body: "Show me the steps", briefed: true });

    // The next message goes to the same session, without the brief.
    await sendLineChatCore(ctx, HOST, { project_id: "projects_p1", text: "And the runs?", client_id: "c2", graph: null });
    expect(tables.conversations.filter((c) => c.title === "Agent Quality · line chat")).toHaveLength(1);
    const second = tables.pending_messages.filter((m) => String(m.conversation_id) === String(spawned._id)).map((m) => parseLineChat(m.content));
    expect(second.at(-1)).toMatchObject({ body: "And the runs?", briefed: false });
  });

  test("someone who cannot read the project cannot talk with its line; an empty message is refused", async () => {
    const { ctx, tables } = seed();
    expect(await sendLineChatCore(ctx, OUTSIDER, { project_id: "projects_p1", text: "hi", client_id: "c1" })).toEqual({ error: "Project not found" });
    expect(await sendLineChatCore(ctx, HOST, { project_id: "projects_p1", text: "   ", client_id: "c2" })).toEqual({ error: "The message is empty" });
    expect(tables.pending_messages).toHaveLength(0);
  });
});

describe("the replies", () => {
  test("each ask gets the session's last words after it, widgets and all", async () => {
    const frame = (body: string, brief?: string) => formatLineChat({ project: "pj-aq", graph: "agentwatch", from: "Ashot", body, brief });
    const msg = (i: number, role: string, content: string) => ({ _id: `messages_${i}`, conversation_id: "conversations_lead", role, content, timestamp: NOW + i * 1000 });
    const reply = 'It dissolved C119 into the fee policy change.\n\n```line\n{"widget":"decision","project":"pj-aq","step":"dissolve","run":"r1"}\n```';
    const { ctx, tables } = seed({}, {
      messages: [
        msg(1, "user", frame("Why did Dissolve close C119?", "You answer for the line.")),
        msg(2, "assistant", "Reading the run."),
        msg(3, "assistant", reply),
        msg(4, "user", frame("And Refine?")),
      ],
    });
    const asks = [
      { client_id: "c1", text: "Why did Dissolve close C119?", at: NOW, user_id: HOST, conversation_id: "conversations_lead" as any },
      { client_id: "c2", text: "And Refine?", at: NOW + 3500, user_id: HOST, conversation_id: "conversations_lead" as any },
    ];
    const [a, b] = await lineChatTurns(ctx, project(tables), asks);
    expect(a).toMatchObject({ delivered: true, reply: { text: reply } });
    expect(b).toMatchObject({ delivered: true, reply: null });
  });
});

describe("a line decision's discussion", () => {
  test("its owner is told the reply can draw the line's widgets", async () => {
    const { ctx, tables } = seed({}, {
      tasks: [{ _id: "tasks_t1", short_id: "ct-7", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, title: "Fee issue", status: "in_review", project_id: "projects_p1" }],
      workflow_runs: [{ _id: "workflow_runs_r1", user_id: HOST, team_id: TEAM, task_id: "tasks_t1", status: "paused" }],
      session_decisions: [{
        _id: "session_decisions_d1", short_id: "sd-9", conversation_id: "conversations_lead", session_id: "sess-lead", user_id: HOST, asked_user_ids: [HOST],
        question: "Ship the fee fix?", options: [{ label: "Ship" }], blocking: true, status: "pending", created_at: NOW, workflow_run_id: "workflow_runs_r1", task_id: "tasks_t1",
      }],
    });
    const res = await discussCore(ctx, HOST, { decision: "sd-9", text: "Show me what Dissolve said", client_id: "d1" });
    expect("ok" in res && res.ok).toBe(true);
    expect(tables.pending_messages[0].content).toContain(lineFenceHint("pj-aq"));
  });
});
