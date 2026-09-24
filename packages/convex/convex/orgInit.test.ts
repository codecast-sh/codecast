import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { ANALYSIS_CAPS, computeAnalysisActivity, computeAnalysisInputs, computeAnalysisOrg, computeAnalysisSignals, computeAnalysisWork, landingRecordsOf, mergeAnalysisInputs, performApplyDecision, readLanding, sessionUseOf, withLanding } from "./orgInit";
import { orgProposalBlock } from "@codecast/shared/contracts/orgProposal";

// Org init (docs/architecture/org-init.md O1, O2): the analyzer's inputs are
// bounded and access checked, and applying an answered proposal is idempotent.

const ME = "u".repeat(31) + "m"; // team admin, caller
const MATE = "u".repeat(31) + "t";
const OUTSIDER = "u".repeat(31) + "o";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const D = 24 * H;

const P = "projects_p";
const Q = "projects_q";
const PLAN = "plans_pl1";
const S1 = "conversations_s1";
const STACK = "decision_stacks_1";

function fixtures(extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me", email: "me@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
      { _id: OUTSIDER, name: "Outsider", email: "o@x.ai" },
    ],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { chat: true, calls: true } }],
    counters: [],
    org_roles: [],
    org_role_history: [],
    role_wakes: [],
    anchors: [],
    initiatives: [],
    inbox_buckets: [{ _id: "inbox_buckets_1", user_id: ME, name: "growth", sort_order: 0 }],
    bucket_assignments: [{ _id: "ba1", user_id: ME, conversation_id: S1, bucket_id: "inbox_buckets_1" }],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", description: "Bring users in", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW - 10 * H },
      { _id: Q, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", project_path: "/repo/billing", created_at: 1, updated_at: NOW - 10 * H },
      // Another workspace's project: never in the answer.
      { _id: "projects_x", user_id: OUTSIDER, workspace: `user:${OUTSIDER}`, short_id: "pr-9", title: "Secret", status: "active", created_at: 1, updated_at: NOW },
    ],
    plans: [
      { _id: PLAN, user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "pl-1", title: "Launch", status: "active", goal: "Ship it", created_at: 1, updated_at: NOW - 3 * H },
    ],
    tasks: [
      { _id: "tasks_t1", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "ct-1", source: "human", title: "Landing page", task_type: "task", status: "in_progress", priority: "high", created_at: 1, updated_at: NOW - H },
      { _id: "tasks_t2", user_id: ME, team_id: TEAM, workspace: WS, plan_id: PLAN, short_id: "ct-2", source: "human", title: "Wire analytics", task_type: "task", status: "open", priority: "medium", created_at: 1, updated_at: NOW - 5 * H },
      { _id: "tasks_t3", user_id: ME, team_id: TEAM, workspace: WS, short_id: "ct-3", source: "human", title: "Unfiled", task_type: "task", status: "open", priority: "low", created_at: 1, updated_at: NOW - 2 * H },
    ],
    docs: [
      { _id: "docs_d1", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, title: "Launch notes", content: "# Launch notes", doc_type: "note", created_at: 1, updated_at: NOW - 4 * H },
      { _id: "docs_d2", user_id: ME, team_id: TEAM, workspace: WS, title: "Design", content: "# Design", doc_type: "design", created_at: 1, updated_at: NOW - 4 * H },
    ],
    conversations: [
      { _id: S1, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", title: "Growth session", short_id: "jx1", session_id: "s1", project_path: "/repo/growth", git_root: "/repo/growth", git_remote_url: "git@github.com:acme/growth.git", updated_at: NOW - 2 * H, created_at: 1, message_count: 3 },
      // A teammate's private row: not the caller's to count.
      { _id: "conversations_s2", user_id: MATE, team_id: TEAM, is_private: true, status: "active", agent_type: "claude", title: "Mate private", short_id: "jx2", project_path: "/repo/billing", updated_at: NOW - H, created_at: 1, message_count: 3 },
    ],
    session_insights: [
      { _id: "si1", conversation_id: S1, team_id: TEAM, actor_user_id: ME, source: "idle", generated_at: NOW - 3 * H, summary: "x", headline: "Landing shipped", outcome_type: "shipped", themes: ["growth", "landing"] },
      { _id: "si2", conversation_id: S1, team_id: TEAM, actor_user_id: ME, source: "idle", generated_at: NOW - 40 * D, summary: "old", outcome_type: "blocked", themes: ["old"] },
    ],
    chat_channels: [{ _id: "chat_channels_1", team_id: TEAM, name: "general", created_at: 1 }],
    chat_messages: [{ _id: "cm1", channel_id: "chat_channels_1", user_id: ME, content: "hi", created_at: NOW - H }],
    session_decisions: [
      { _id: "sd1", conversation_id: S1, session_id: "s1", user_id: ME, short_id: "sd-1", question: "Blue or green?", options: [{ label: "Blue" }, { label: "Green" }], blocking: true, status: "pending", category: "approach", created_at: NOW - 6 * H },
    ],
    decision_stacks: [
      { _id: STACK, short_id: "ds-1", title: "Adopt the org for Acme", team_id: TEAM, owner_user_id: ME, decision_ids: [], policy: {}, status: "open", created_at: NOW - H, updated_at: NOW - H },
    ],
    session_owners: [],
    managed_sessions: [],
    messages: [],
    user_presence: [],
    project_updates: [],
    commits: [],
    transcripts: [],
    chat_channel_members: [],
    artifacts: [],
    conversation_images: [],
    ...extra,
  });
}

const ctxOf = (db: any) => ({ db }) as any;

describe("org.analysisInputs", () => {
  test("reads the workspace inside the window, capped, with private rows and other workspaces left out", async () => {
    const db = fixtures();
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.workspace).toEqual({ kind: "team", id: TEAM, name: "Acme" });
    expect(r.projects.map((p) => p.title).sort()).toEqual(["Billing", "Growth"]);
    expect(r.projects.find((p) => p.title === "Growth")).toMatchObject({ tasks: { total: 1, open: 1, by_status: { in_progress: 1 } }, plans: 1, description: "Bring users in" });
    expect(r.plans).toEqual([expect.objectContaining({ short_id: "pl-1", progress: { total: 1, done: 0, in_progress: 0, open: 1, source: "window" } })]);
    expect(r.tasks).toEqual({ total: 3, by_status: { in_progress: 1, open: 2 }, unfiled_open: 1, truncated: false, closed_counted: "inside the window only" });
    expect(r.docs_by_type).toEqual({ note: 1, design: 1 });
    // Sessions: the caller's row counts; the teammate's private row does not.
    expect(r.sessions.total).toBe(1);
    expect(r.members.find((m) => m.is_me)).toMatchObject({ sessions_30d: 1, by_project_path: { "/repo/growth": 1 } });
    expect(r.members.find((m) => m.name === "Mate")).toMatchObject({ sessions_30d: 0 });
    expect(r.git_roots).toEqual([{ git_root: "/repo/growth", remote_url: "git@github.com:acme/growth.git", repo: "acme/growth", sessions: 1 }]);
    expect(r.labels).toEqual([{ name: "growth", count: 1 }]);
    // Insights: the 40 day old row is outside the window.
    expect(r.insights).toMatchObject({ total: 1, outcomes: { shipped: 1 }, themes: [{ name: "growth", count: 1 }, { name: "landing", count: 1 }] });
    expect(r.channels).toEqual([{ id: "chat_channels_1", name: "general", messages_30d: 1, last_at: NOW - H }]);
    expect(r.decisions_open_by_category).toEqual({ approach: 1 });
    expect(r.org).toMatchObject({ roles: [], whole_workspace_roles: 0 });
    expect(r.org.projects_without_role.map((p) => p.title).sort()).toEqual(["Billing", "Growth"]);
    expect(r.window_days).toBe(30);
    expect(r.caps).toBe(ANALYSIS_CAPS);
  });

  // initiatives-projects-role-page.md I1, I2: who answers for the work, from the top of the tree down.
  test("coverage reads the initiatives, each project's lead and the work outside any project, inside the workspace", async () => {
    const db = fixtures({
      initiatives: [
        { _id: "initiatives_a", user_id: ME, team_id: TEAM, workspace: WS, short_id: "in-1", title: "Reach 1000 users", status: "active", health: "at_risk", health_at: NOW - D, project_ids: [P, Q], created_at: 1, updated_at: NOW },
        { _id: "initiatives_b", user_id: ME, team_id: TEAM, workspace: WS, short_id: "in-2", title: "Hire", status: "planned", health: "none", owner: { kind: "user", user_id: ME }, project_ids: [], created_at: 1, updated_at: NOW },
        // Another workspace's goal: never in the answer.
        { _id: "initiatives_x", user_id: OUTSIDER, workspace: `user:${OUTSIDER}`, short_id: "in-9", title: "Secret goal", status: "active", health: "none", project_ids: [], created_at: 1, updated_at: NOW },
      ],
      org_roles: [
        { _id: "org_roles_g", user_id: ME, team_id: TEAM, short_id: "or-1", name: "Growth lead", handle: "growth", status: "active", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, created_at: 1, updated_at: 1 },
        // A whole workspace role leads nothing, so it hides no gap.
        { _id: "org_roles_c", user_id: ME, team_id: TEAM, short_id: "or-2", name: "Chief of Staff", handle: "chief-of-staff", status: "active", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, created_at: 1, updated_at: 1 },
      ],
    });
    const { coverage } = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(coverage).toMatchObject({ active_initiatives: 1, active_without_owner: 1, with_work: 1, with_lead: 1 });
    expect(coverage!.initiatives.map((i) => i.short_id)).toEqual(["in-1", "in-2"]);
    expect(coverage!.initiatives[0]).toMatchObject({ health: "at_risk", projects_without_lead: 0, projects: [{ title: "Growth", lead: "@growth", has_work: true }, { title: "Billing", has_work: false }] });
    expect(coverage!.initiatives[1].owner).toEqual({ kind: "user", name: "Me" });
    expect(coverage!.projects).toEqual([expect.objectContaining({ title: "Growth", lead: "@growth", lead_by: "scope", open_tasks: 1, open_plans: 1, initiatives: ["in-1"] })]);
    // The one loose task; the plan is filed, so no plan is outside.
    expect(coverage!.outside).toMatchObject({ plans: [], open_tasks: 1 });
  });

  // org-roles-run-work.md R2: the facts a person would use to say "this session is already a role".
  test("a session older than a week is listed with its age, helpers, routines, pinned state, first message and projects; a young one and a standing one are not", async () => {
    const D = 24 * H;
    const base = { user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", is_private: false, updated_at: NOW - H, created_at: 1, message_count: 10 };
    const db = fixtures({
      conversations: [
        { ...base, _id: "conversations_old", short_id: "jxold", title: "Market growth mandate", started_at: NOW - 34 * D, message_count: 17000, project_path: "/repo/growth", thread_state: "Daily market growth run is complete\nStatus: deploy verified", thread_state_status: "dormant" },
        { ...base, _id: "conversations_h1", short_id: "jxh1", title: "helper", started_at: NOW - 2 * D, parent_conversation_id: "conversations_old", is_subagent: true },
        { ...base, _id: "conversations_h2", short_id: "jxh2", title: "helper", started_at: NOW - D, parent_conversation_id: "conversations_old", is_subagent: true },
        { ...base, _id: "conversations_young", short_id: "jxyoung", title: "Fix a bug", started_at: NOW - 2 * D },
        { ...base, _id: "conversations_standing", short_id: "jxstand", title: "Chief of Staff", started_at: NOW - 60 * D, standing_role_id: "org_roles_1", anchor_id: "anchors_1" },
      ],
      agent_tasks: [
        { _id: "agent_tasks_1", user_id: ME, short_id: "tr-886", title: "Daily growth run", originating_conversation_id: "conversations_old", schedule_type: "recurring", interval_ms: D, status: "scheduled" },
        { _id: "agent_tasks_2", user_id: ME, short_id: "tr-2", title: "One check", originating_conversation_id: "conversations_old", schedule_type: "once", status: "scheduled" },
      ],
      tasks: [
        { _id: "tasks_f1", user_id: ME, team_id: TEAM, workspace: WS, project_id: Q, short_id: "ct-9", title: "Filed by the old session", task_type: "task", status: "open", priority: "low", created_from_conversation: "conversations_old", created_at: 1, updated_at: NOW - H },
      ],
      messages: [
        { _id: "messages_1", conversation_id: "conversations_old", role: "user", content: "Steer our top of funnel to get true breadth across all market segments." },
        { _id: "messages_2", conversation_id: "conversations_old", role: "assistant", content: "I will work in three passes." },
      ],
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.sessions.long_running).toMatchObject({ min_age_days: 7, old_enough: 1, listed: 1 });
    expect(r.sessions.long_running.rows).toEqual([expect.objectContaining({
      short_id: "jxold", title: "Market growth mandate", started_at: NOW - 34 * D, age_days: 34, messages: 17000, helpers: 2,
      routines: [{ short_id: "tr-886", title: "Daily growth run", schedule: "recurring", every_ms: D }],
      state_line: "Daily market growth run is complete", state_status: "dormant",
      first_message: "Steer our top of funnel to get true breadth across all market segments.",
      // Its work share by project: the task it filed under Billing; Growth, its path's project, has nothing counted and leaves the row.
      projects: [{ short_id: "pr-2", title: "Billing", tasks: 1, commits_30d: 0, messages_7d: 0, bound: false }], tasks_filed: 1, private: false,
    })]);
  });

  // Union, 2026-09-22: the growth seat got a four project area because its row
  // listed four projects with one task in each. The counts say which dominates.
  test("a long running row's projects carry its work share: tasks touched, commits of the window and messages of the week that name each, biggest first", async () => {
    const D = 24 * H;
    const base = { user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", is_private: false, updated_at: NOW - H, created_at: 1, message_count: 10 };
    const db = fixtures({
      conversations: [{ ...base, _id: "conversations_old", short_id: "jxold", title: "Growth engine", started_at: NOW - 34 * D, project_path: "/repo/billing", active_task_id: "tasks_b1" }],
      tasks: [
        { _id: "tasks_b1", user_id: ME, team_id: TEAM, workspace: WS, project_id: Q, short_id: "ct-11", title: "Invoice retries", task_type: "task", status: "in_progress", priority: "low", created_from_conversation: "conversations_old", created_at: 1, updated_at: NOW - H },
        { _id: "tasks_g1", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "ct-12", title: "Cold email daily run", task_type: "task", status: "open", priority: "low", created_at: 1, updated_at: NOW - H },
      ],
      commits: [
        // Names Growth by its short id; another through the task it carries; a one word title ("Growth") is never named by its word alone; one outside the window; one that names nothing.
        { _id: "commits_1", conversation_id: "conversations_old", sha: "a1", message: "pr-1: warm the list", author_name: "Me", author_email: "me@x.ai", timestamp: NOW - 2 * D, files_changed: 1, insertions: 1, deletions: 0 },
        { _id: "commits_2", conversation_id: "conversations_old", sha: "a2", message: "ct-12 retries", author_name: "Me", author_email: "me@x.ai", timestamp: NOW - 3 * D, files_changed: 1, insertions: 1, deletions: 0, task_ids: ["tasks_g1"] },
        { _id: "commits_3", conversation_id: "conversations_old", sha: "a3", message: "growth: bring users in faster", author_name: "Me", author_email: "me@x.ai", timestamp: NOW - 4 * D, files_changed: 1, insertions: 1, deletions: 0 },
        { _id: "commits_4", conversation_id: "conversations_old", sha: "a4", message: "pr-1: old", author_name: "Me", author_email: "me@x.ai", timestamp: NOW - 40 * D, files_changed: 1, insertions: 1, deletions: 0 },
        { _id: "commits_5", conversation_id: "conversations_old", sha: "a5", message: "tidy", author_name: "Me", author_email: "me@x.ai", timestamp: NOW - D, files_changed: 1, insertions: 1, deletions: 0 },
      ],
      messages: [
        { _id: "messages_1", conversation_id: "conversations_old", role: "user", content: "Bring users in through the growth loop", timestamp: NOW - H },
        { _id: "messages_2", conversation_id: "conversations_old", role: "assistant", content: "Working pr-1 now; the billing task waits.", timestamp: NOW - H },
        // A tool result naming the project is not a word anyone wrote.
        { _id: "messages_3", conversation_id: "conversations_old", role: "tool", content: "pr-1 pr-1 pr-1", timestamp: NOW - H },
      ],
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.sessions.long_running.rows[0].projects).toEqual([
      { short_id: "pr-1", title: "Growth", tasks: 0, commits_30d: 2, messages_7d: 1, bound: false },
      { short_id: "pr-2", title: "Billing", tasks: 1, commits_30d: 0, messages_7d: 0, bound: true },
    ]);
    // Growth is not on the org slice's list (never filed there, not bound); the session's own read put it there.
    const org = await computeAnalysisOrg(ctxOf(db), ME as any, TEAM, NOW, (await computeAnalysisWork(ctxOf(db), ME as any, TEAM)).handoff);
    expect(org.sessions.long_running.rows[0].projects.map((p: any) => p.short_id)).toEqual(["pr-2"]);
  });

  // A landing usually sits further back than the activity window: on Union a 30
  // day read found one for 4 of 44 stale records (2026-09-23).
  test("a flagged record's landing is searched over three months in its own read, under a cap the search reports", async () => {
    const D = 24 * H;
    const commit = (id: string, days: number, message: string, extra: any = {}) => ({ _id: id, repository: "acme/growth", team_id: TEAM, branch: "main", sha: `${id}0000000000`, message, author_name: "Me", author_email: "me@x.ai", timestamp: NOW - days * D, files_changed: 1, insertions: 1, deletions: 0, ...extra });
    const db = fixtures({
      tasks: [
        // Open, quiet for 45 days, never had a session: stale; its landing is 60 days back, outside the 30 day activity read.
        { _id: "tasks_t1", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "ct-1", source: "human", title: "Landing page hero copy", task_type: "task", status: "open", priority: "high", created_at: 1, updated_at: NOW - 50 * D },
      ],
      commits: [commit("c1", 60, "landing hero: copy pass"), commit("c2", 100, "ct-1 first cut, too old"), commit("c3", 20, "unrelated")],
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.activity.stale.tasks).toEqual([expect.objectContaining({ short_id: "ct-1", reason: "open, untouched 45d", landing: [{ sha: "c10000000000", at: NOW - 60 * D, line: "landing hero: copy pass" }] })]);
    expect(r.activity.landing).toEqual({ window_days: 90, commits_searched: 2, truncated: false });
    // At the cap the search says so; the record's landing is what the read reached.
    const capped = await readLanding(ctxOf(db), ME as any, TEAM, NOW, ["acme/growth"], [{ short_id: "ct-1", title: "Landing page hero copy" }], 1);
    expect(capped).toEqual({ window_days: 90, commits_searched: 1, truncated: true, by_record: { "ct-1": [] } });
  });

  // The reviewer never read a word a person wrote (org-eval, 2026-09-23).
  test("said: the team's ended calls with their summaries, and the chat threads where a person decided, asked or named a role or project; what the caller may not read is not there", async () => {
    const D = 24 * H;
    const PRIV = "chat_channels_priv";
    const db = fixtures({
      org_roles: [{ _id: "org_roles_g", user_id: ME, team_id: TEAM, short_id: "or-1", handle: "growth", name: "Growth lead", status: "active", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, created_at: 1, updated_at: 1 }],
      transcripts: [
        { _id: "transcripts_1", room_key: "channel:chat_channels_1", team_id: TEAM, started_by: MATE, status: "ended", started_at: NOW - 2 * D, ended_at: NOW - 2 * D + H, title: "Pricing huddle", participants: [{ id: ME, name: "Me" }, { id: MATE, name: "Mate" }], summary: "Agreed to raise the price.", action_items: ["Me: update the page"], routes: [], last_seq: 3 },
        // A private channel's huddle the caller was not in: not readable.
        { _id: "transcripts_2", room_key: `channel:${PRIV}`, team_id: TEAM, started_by: MATE, status: "ended", started_at: NOW - 3 * D, ended_at: NOW - 3 * D + H, title: "Private", participants: [{ id: MATE, name: "Mate" }], summary: "secret", action_items: [], routes: [], last_seq: 3 },
        // A recording its creator never shared, a live call, one outside the window, and one with nothing said.
        { _id: "transcripts_3", room_key: "rec:01ARZ3NDEKTSV4RRFFQ69G5FAV", team_id: TEAM, started_by: ME, status: "ended", started_at: NOW - D, title: "My memo", summary: "mine", routes: [], last_seq: 1 },
        { _id: "transcripts_4", room_key: "channel:chat_channels_1", team_id: TEAM, started_by: ME, status: "live", started_at: NOW - H, participants: [{ id: ME, name: "Me" }], routes: [], last_seq: 1 },
        { _id: "transcripts_5", room_key: "channel:chat_channels_1", team_id: TEAM, started_by: ME, status: "ended", started_at: NOW - 40 * D, participants: [{ id: ME, name: "Me" }], summary: "old", routes: [], last_seq: 1 },
        // A huddle that ended before a word was spoken or written.
        { _id: "transcripts_6", room_key: "channel:chat_channels_1", team_key: TEAM, team_id: TEAM, started_by: ME, status: "ended", started_at: NOW - D, participants: [], routes: [], last_seq: 0 },
      ],
      chat_channels: [
        { _id: "chat_channels_1", team_id: TEAM, name: "general", kind: "public", created_by: ME, created_at: 1, updated_at: 1 },
        { _id: PRIV, team_id: TEAM, name: "leads", kind: "private", created_by: MATE, created_at: 1, updated_at: 1 },
        { _id: "chat_channels_dm", team_id: TEAM, name: "me-mate", kind: "dm", created_by: ME, created_at: 1, updated_at: 1 },
      ],
      chat_channel_members: [{ _id: "ccm1", channel_id: PRIV, user_id: MATE, added_by: MATE, added_at: 1 }, { _id: "ccm2", channel_id: "chat_channels_dm", user_id: ME, added_by: ME, added_at: 1 }],
      chat_messages: [
        // A decision with an ask in reply, and an agent's reply that is context, not a signal.
        { _id: "cm_root1", team_id: TEAM, channel_id: "chat_channels_1", user_id: ME, content: "We decided to drop the old funnel.", created_at: NOW - 5 * D },
        { _id: "cm_r1a", team_id: TEAM, channel_id: "chat_channels_1", thread_root_id: "cm_root1", user_id: MATE, content: "Can you own the migration?", created_at: NOW - 5 * D + H },
        { _id: "cm_r1b", team_id: TEAM, channel_id: "chat_channels_1", thread_root_id: "cm_root1", user_id: MATE, author_kind: "agent", content: "Decided: I will do it.", created_at: NOW - 5 * D + 2 * H },
        { _id: "cm_r1c", team_id: TEAM, channel_id: "chat_channels_1", thread_root_id: "cm_root1", user_id: MATE, content: "ok", created_at: NOW - 5 * D + 3 * H },
        // Names a role and a project, no decision, no ask.
        { _id: "cm_root2", team_id: TEAM, channel_id: "chat_channels_1", user_id: MATE, content: "@growth is on Growth this week", created_at: NOW - 4 * D },
        // Small talk: not for the reviewer.
        { _id: "cm_root3", team_id: TEAM, channel_id: "chat_channels_1", user_id: MATE, content: "lunch", created_at: NOW - 3 * D },
        // An agent's own line decides nothing.
        { _id: "cm_root4", team_id: TEAM, channel_id: "chat_channels_1", user_id: ME, author_kind: "agent", content: "We decided to ship.", created_at: NOW - 2 * D },
        // A private channel the caller is not in, and a direct message: never.
        { _id: "cm_priv", team_id: TEAM, channel_id: PRIV, user_id: MATE, content: "We decided to fire everyone?", created_at: NOW - D },
        { _id: "cm_dm", team_id: TEAM, channel_id: "chat_channels_dm", user_id: MATE, content: "Can you decide?", created_at: NOW - D },
      ],
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.channels.map((c: any) => c.name)).toEqual(["general", "me-mate"]);
    expect(r.said.calls).toEqual([{ title: "Pricing huddle", started_at: NOW - 2 * D, ended_at: NOW - 2 * D + H, participants: ["Me", "Mate"], summary: "Agreed to raise the price.", action_items: ["Me: update the page"] }]);
    expect(r.said.chat).toEqual([
      { channel: "#general", at: NOW - 4 * D, by: "Mate", line: "@growth is on Growth this week", why: ["named"], replies: [] },
      { channel: "#general", at: NOW - 5 * D, by: "Me", line: "We decided to drop the old funnel.", why: ["decided", "asked"], replies: [{ at: NOW - 5 * D + H, by: "Mate", line: "Can you own the migration?" }] },
    ]);
    expect(r.said.truncated).toBe(false);
    // A personal workspace reads no team chat and no calls.
    const mine = await computeAnalysisInputs(ctxOf(db), ME as any, undefined, NOW);
    expect(mine.said).toEqual({ calls: [], chat: [], truncated: false });
  });

  test("said stops at its byte budget, newest threads first, and says so", async () => {
    const many = (n: number, f: (i: number) => any) => Array.from({ length: n }, (_, i) => f(i));
    // One channel's read (the cap) at the line cap is under the budget; four are not.
    const db = fixtures({
      chat_channels: many(4, (c) => ({ _id: `chat_channels_${c}`, team_id: TEAM, name: `room${c}`, kind: "public", created_by: ME, created_at: 1, updated_at: 1 })),
      chat_messages: many(4 * ANALYSIS_CAPS.messages_per_channel, (i) => ({ _id: `cm_${i}`, team_id: TEAM, channel_id: `chat_channels_${i % 4}`, user_id: ME, content: `We decided to ${"x".repeat(ANALYSIS_CAPS.said_line_chars * 4)} ${i}`, created_at: NOW - i * H })),
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.said.truncated).toBe(true);
    expect(r.said.chat.length).toBeGreaterThan(0);
    expect(r.said.chat.length).toBeLessThan(4 * ANALYSIS_CAPS.messages_per_channel);
    expect(r.said.chat[0].at).toBe(NOW);
    expect(JSON.stringify(r.said).length).toBeLessThanOrEqual(ANALYSIS_CAPS.said_bytes + 200);
  });

  // Union, 2026-09-20: ranked by helpers alone, the list held the largest finished
  // A seated session is the role, not a candidate: the role row names it.
  test("a role row names the session that is its seat, and that session leaves the long running list", async () => {
    const D = 24 * H;
    const base = { user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", is_private: false, updated_at: NOW - H, created_at: 1, message_count: 10 };
    const db = fixtures({
      org_roles: [{ _id: "org_roles_g", team_id: TEAM, workspace: WS, short_id: "or-1", handle: "growth", name: "Market growth mandate", status: "active", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, caps: { hands_per_day: 2, wakes_per_day: 8, tokens_per_day: 100000 }, created_at: 1, updated_at: 1 }],
      conversations: [
        { ...base, _id: "conversations_seat", short_id: "jxseat", title: "Market growth mandate", started_at: NOW - 40 * D, standing_role_id: "org_roles_g" },
        { ...base, _id: "conversations_old", short_id: "jxold", title: "Another long job", started_at: NOW - 30 * D },
      ],
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.org.roles.find((x: any) => x.handle === "growth").seat).toEqual({ session: "jxseat", title: "Market growth mandate" });
    expect(r.sessions.long_running.rows.map((s: any) => s.short_id)).toEqual(["jxold"]);
  });

  // A weekly job is parked six days in seven and the scan reads active rows only.
  test("a session a live routine wakes is listed even when the scan skipped it (parked between wakes, or dismissed), with helpers unknown", async () => {
    const D = 24 * H;
    const base = { user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", is_private: false, updated_at: NOW - H, created_at: 1, message_count: 10 };
    const db = fixtures({
      conversations: [
        { ...base, _id: "conversations_old", short_id: "jxold", title: "Market growth mandate", started_at: NOW - 34 * D },
        // Parked: its process ended after the last weekly run, so status is not active and the scan skips it.
        { ...base, _id: "conversations_weekly", short_id: "jxweekly", title: "Weekly blog posts", status: "completed", started_at: NOW - 40 * D, updated_at: NOW - 3 * D, message_count: 700 },
        // Dismissed from the inbox by a person who reviewed the loop: skipped by the scan too.
        { ...base, _id: "conversations_quiet", short_id: "jxquiet", title: "Ads campaign", inbox_dismissed_at: NOW - 5 * D, started_at: NOW - 44 * D, message_count: 2800 },
        // Another team's routine session: never ours.
        { ...base, _id: "conversations_other", short_id: "jxother", team_id: "teams_other", title: "Their job", status: "completed", started_at: NOW - 40 * D },
      ],
      agent_tasks: [
        { _id: "agent_tasks_w", user_id: ME, short_id: "tr-10", title: "Weekly post", originating_conversation_id: "conversations_weekly", schedule_type: "recurring", interval_ms: 7 * D, status: "scheduled", run_at: NOW + D },
        { _id: "agent_tasks_q", user_id: ME, short_id: "tr-11", title: "Ads check", originating_conversation_id: "conversations_quiet", schedule_type: "recurring", interval_ms: 3 * D, status: "scheduled", run_at: NOW + D },
        { _id: "agent_tasks_o", user_id: OUTSIDER, short_id: "tr-12", title: "Theirs", originating_conversation_id: "conversations_other", schedule_type: "recurring", interval_ms: D, status: "scheduled", run_at: NOW + D },
      ],
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    const rows = r.sessions.long_running.rows;
    expect(rows.map((s: any) => s.short_id)).toEqual(["jxquiet", "jxweekly", "jxold"]);
    expect(rows[1]).toMatchObject({ title: "Weekly blog posts", helpers: null, scanned: false, routines: [{ short_id: "tr-10", title: "Weekly post", schedule: "recurring", every_ms: 7 * D }] });
    expect(rows[2].scanned).toBeUndefined();
  });

  // A seated session's limit is sized on what it spends, so its row carries
  // the last week's use in the unit the caps count, and says what it covers.
  test("a long running row carries its measured use for the week: input plus output tokens and model calls a day, the days covered, and not counted when no message carries usage", async () => {
    const D = 24 * H;
    const base = { user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", is_private: false, updated_at: NOW - H, created_at: 1, message_count: 10 };
    const usage = (n: number) => ({ input_tokens: 100 * n, output_tokens: 10 * n, cache_read_input_tokens: 5000 });
    const db = fixtures({
      conversations: [
        { ...base, _id: "conversations_old", short_id: "jxold", title: "Market growth mandate", started_at: NOW - 34 * D },
        // Started three days ago and a week old by age? No: two weeks old, so listed; its messages carry no usage block (another backend).
        { ...base, _id: "conversations_codex", short_id: "jxcodex", title: "Codex worker", agent_type: "codex", started_at: NOW - 14 * D, message_count: 5 },
      ],
      messages: [
        { _id: "messages_1", conversation_id: "conversations_old", role: "user", content: "Steer the funnel.", timestamp: NOW - 6 * D },
        { _id: "messages_2", conversation_id: "conversations_old", role: "assistant", content: "Pass one.", timestamp: NOW - 6 * D + H, usage: usage(1) },
        { _id: "messages_3", conversation_id: "conversations_old", role: "assistant", content: "Pass two.", timestamp: NOW - 2 * D, usage: usage(2) },
        { _id: "messages_4", conversation_id: "conversations_old", role: "assistant", content: "Pass three.", timestamp: NOW - H, usage: usage(3) },
        // Outside the week: never counted.
        { _id: "messages_5", conversation_id: "conversations_old", role: "assistant", content: "Old.", timestamp: NOW - 9 * D, usage: usage(9) },
        { _id: "messages_6", conversation_id: "conversations_codex", role: "user", content: "Fix the build.", timestamp: NOW - D },
        { _id: "messages_7", conversation_id: "conversations_codex", role: "assistant", content: "Done.", timestamp: NOW - D + H },
      ],
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    const rows = r.sessions.long_running.rows;
    expect(rows.map((s: any) => s.short_id).sort()).toEqual(["jxcodex", "jxold"]);
    // The internal id served only the read; a seat is named by its short id.
    expect(rows.every((s: any) => s.id === undefined)).toBe(true);
    const old = rows.find((s: any) => s.short_id === "jxold");
    expect(old.use_7d).toEqual({ days: 7, tokens: 660, calls: 3, per_day: { tokens: 94, calls: 0.4 }, counted: true, messages_read: 4, truncated: false });
    const codex = rows.find((s: any) => s.short_id === "jxcodex");
    expect(codex.use_7d).toEqual({ days: 7, tokens: 0, calls: 0, per_day: { tokens: 0, calls: 0 }, counted: false, messages_read: 2, truncated: false });
  });

  test("measured use covers the days it can: a session younger than the week, and a session read at the cap", () => {
    const D = 24 * H;
    // Three days old: the figure is over three days, not seven.
    expect(sessionUseOf([{ timestamp: NOW - 2 * D, usage: { input_tokens: 300, output_tokens: 0 } }], NOW - 3 * D, NOW)).toMatchObject({ days: 3, tokens: 300, per_day: { tokens: 100 } });
    // At the cap, the newest rows span two days: the figure covers those two, and says it was cut.
    const rows = Array.from({ length: 4 }, (_, i) => ({ timestamp: NOW - i * 12 * H, usage: { input_tokens: 50, output_tokens: 0 } }));
    expect(sessionUseOf(rows, NOW - 30 * D, NOW, 4)).toMatchObject({ days: 2, tokens: 200, per_day: { tokens: 100 }, truncated: true, messages_read: 4 });
  });

  // jobs and left out the session a routine wakes every day.
  test("long running sessions rank by evidence of a standing purpose: a live routine, then this week's activity, a pinned state, helpers", async () => {
    const D = 24 * H;
    const base = { user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", is_private: false, created_at: 1, message_count: 10, started_at: NOW - 30 * D };
    const helper = (parent: string, n: number) => ({ ...base, _id: `conversations_h_${parent}_${n}`, short_id: `jxh${parent}${n}`, title: "helper", started_at: NOW - D, updated_at: NOW - D, parent_conversation_id: `conversations_${parent}`, is_subagent: true });
    const db = fixtures({
      conversations: [
        // A finished job: many helpers, quiet for three weeks, no routine.
        { ...base, _id: "conversations_big", short_id: "jxbig", title: "Networks", updated_at: NOW - 20 * D, message_count: 1800 },
        ...[1, 2, 3].map((n) => helper("big", n)),
        // Active this week with a pinned state and no routine.
        { ...base, _id: "conversations_recent", short_id: "jxrecent", title: "Eval suite overhaul", updated_at: NOW - D, thread_state: "Making the suite green" },
        // A routine wakes it every day; no helpers at all.
        { ...base, _id: "conversations_routine", short_id: "jxroutine", title: "Cold email optimizer", updated_at: NOW - H, thread_state: "Monday tells us what it cost" },
      ],
      agent_tasks: [
        { _id: "agent_tasks_r", user_id: ME, short_id: "tr-1", title: "Daily reply rate monitor", originating_conversation_id: "conversations_routine", schedule_type: "recurring", interval_ms: D, status: "scheduled", run_at: NOW + H },
        { _id: "agent_tasks_p", user_id: ME, short_id: "tr-2", title: "Paused", originating_conversation_id: "conversations_big", schedule_type: "recurring", interval_ms: D, status: "paused", run_at: NOW + H },
      ],
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.sessions.long_running.rows.map((s: any) => s.short_id)).toEqual(["jxroutine", "jxrecent", "jxbig"]);
    expect(r.sessions.long_running.rows[0].routines).toEqual([{ short_id: "tr-1", title: "Daily reply rate monitor", schedule: "recurring", every_ms: D }]);
    expect(r.sessions.long_running.rows[2]).toMatchObject({ helpers: 3, routines: [] });
  });

  test("the three slices merge to the one process read, and the org slice never reads tasks", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const whole = await computeAnalysisInputs(ctx, ME as any, TEAM, NOW);
    const work = await computeAnalysisWork(ctx, ME as any, TEAM);
    const signals = await computeAnalysisSignals(ctx, ME as any, TEAM, NOW);
    const org = await computeAnalysisOrg(ctx, ME as any, TEAM, NOW, JSON.parse(JSON.stringify(work.handoff)));
    const activity = await computeAnalysisActivity(ctx, ME as any, TEAM, NOW);
    const landing = await readLanding(ctx, ME as any, TEAM, NOW, activity.repos, landingRecordsOf(activity.activity));
    expect(mergeAnalysisInputs(ME as any, TEAM, "Acme", work, org, signals, NOW, withLanding(activity.activity, landing), activity.coverage)).toEqual(whole);
    expect(work.handoff.latest_event).toBe(NOW - H);
    expect(Object.keys(whole.truncated).sort()).toEqual(["docs", "insights", "plans", "projects", "tasks"]);
    // The activity block is its own slice (S9): areas, people and stale lists.
    expect(whole.activity).toBeDefined();
    expect(Object.keys(whole.activity.stale).sort()).toEqual(["plans", "projects", "tasks"]);
  });

  test("every list at its cap still answers, and each floor is reported", async () => {
    const many = (n: number, f: (i: number) => any) => Array.from({ length: n }, (_, i) => f(i));
    const db = fixtures({
      projects: many(ANALYSIS_CAPS.projects + 5, (i) => ({ _id: `projects_c${i}`, user_id: ME, team_id: TEAM, workspace: WS, title: `P${i}`, status: "active", created_at: 1, updated_at: NOW - i })),
      plans: many(ANALYSIS_CAPS.plans + 5, (i) => ({ _id: `plans_c${i}`, user_id: ME, team_id: TEAM, workspace: WS, project_id: `projects_c${i % 10}`, short_id: `pl-${i}`, title: `Plan ${i}`, status: "active", created_at: 1, updated_at: NOW - i })),
      tasks: many(ANALYSIS_CAPS.tasks + 5, (i) => ({ _id: `tasks_c${i}`, user_id: ME, team_id: TEAM, workspace: WS, project_id: `projects_c${i % 10}`, plan_id: `plans_c${i % 20}`, short_id: `ct-${i}`, title: `T${i}`, task_type: "task", status: i % 3 ? "open" : "done", priority: "medium", created_at: 1, updated_at: NOW - i })),
      docs: many(ANALYSIS_CAPS.docs + 5, (i) => ({ _id: `docs_c${i}`, user_id: ME, team_id: TEAM, workspace: WS, title: `D${i}`, content: "x".repeat(2000), doc_type: i % 2 ? "note" : "design", created_at: 1, updated_at: NOW - i })),
      session_insights: many(ANALYSIS_CAPS.insights + 5, (i) => ({ _id: `si_c${i}`, conversation_id: S1, team_id: TEAM, actor_user_id: ME, source: "idle", generated_at: NOW - i * 1000, summary: "x", outcome_type: "shipped", themes: ["t"] })),
      chat_channels: many(ANALYSIS_CAPS.channels + 5, (i) => ({ _id: `chat_channels_c${i}`, team_id: TEAM, name: `c${i}`, created_at: 1 })),
      chat_messages: many(ANALYSIS_CAPS.messages_per_channel + 5, (i) => ({ _id: `cm_c${i}`, channel_id: "chat_channels_c0", user_id: ME, content: "hi", created_at: NOW - i * 1000 })),
      session_decisions: many(ANALYSIS_CAPS.decisions + 5, (i) => ({ _id: `sd_c${i}`, conversation_id: S1, session_id: "s1", user_id: ME, short_id: `sd-${i}`, question: "?", options: [{ label: "a" }, { label: "b" }], blocking: true, status: "pending", category: "approach", created_at: NOW - i * 1000 })),
      bucket_assignments: many(ANALYSIS_CAPS.assignments + 5, (i) => ({ _id: `ba_c${i}`, user_id: ME, conversation_id: S1, bucket_id: "inbox_buckets_1" })),
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.truncated).toEqual({ projects: true, plans: true, tasks: true, docs: true, insights: true });
    expect(r.projects.length).toBe(ANALYSIS_CAPS.projects);
    expect(r.plans.length).toBe(ANALYSIS_CAPS.plans);
    // Tasks are read per status (every open row) plus the window's changes,
    // so the total is not one cap; the floor is reported per slice.
    expect(r.tasks.total).toBeGreaterThanOrEqual(ANALYSIS_CAPS.tasks);
    expect(r.tasks.truncated).toBe(true);
    expect(Object.values(r.docs_by_type).reduce((a, b) => a + b, 0)).toBe(ANALYSIS_CAPS.docs);
    expect(r.insights.total).toBe(ANALYSIS_CAPS.insights);
    expect(r.channels.length).toBe(ANALYSIS_CAPS.channels);
    expect(r.channels.find((c) => c.name === "c0")!.messages_30d).toBe(ANALYSIS_CAPS.messages_per_channel);
    expect(r.decisions_open_by_category.approach).toBe(ANALYSIS_CAPS.decisions);
    expect(r.labels).toEqual([{ name: "growth", count: ANALYSIS_CAPS.assignments }]);
  });

  test("the per list caps hold", async () => {
    const many = Array.from({ length: ANALYSIS_CAPS.projects + 20 }, (_, i) => ({
      _id: `projects_m${i}`, user_id: ME, team_id: TEAM, workspace: WS, title: `P${i}`, status: "active", created_at: 1, updated_at: NOW - i,
    }));
    const db = fixtures({ projects: many });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.projects.length).toBe(ANALYSIS_CAPS.projects);
    expect(r.truncated).toMatchObject({ projects: true, tasks: false });
  });

  test("a personal workspace reads only the caller's rows; a non member sees nothing of the team", async () => {
    const db = fixtures();
    const personal = await computeAnalysisInputs(ctxOf(db), OUTSIDER as any, undefined, NOW);
    expect(personal.projects.map((p) => p.title)).toEqual(["Secret"]);
    expect(personal.members.map((m) => m.name)).toEqual(["Outsider"]);
    expect(personal.channels).toEqual([]);
    await expect(computeAnalysisInputs(ctxOf(db), OUTSIDER as any, TEAM, NOW)).rejects.toThrow();
  });

  test("role health: idle when its scope had no event in 14 days, overlaps and wakes at the cap", async () => {
    const db = fixtures({
      org_roles: [
        { _id: "org_roles_1", short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth lead", handle: "growth", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", caps: { hands_per_day: 6, wakes_per_day: 2, tokens_per_day: 1 }, created_by: ME, created_at: 1, updated_at: 1 },
        { _id: "org_roles_2", short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Also growth", handle: "growth2", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 },
        { _id: "org_roles_3", short_id: "or-3", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Billing lead", handle: "billing", scope: { project_ids: [Q], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 },
      ],
      role_wakes: [
        { _id: "rw1", role_id: "org_roles_1", short_id: "rw-1", causes: [], status: "delivered", frame_chars: 1, created_at: NOW - H },
        { _id: "rw2", role_id: "org_roles_1", short_id: "rw-2", causes: [], status: "delivered", frame_chars: 1, created_at: NOW - 2 * H },
        { _id: "rw3", role_id: "org_roles_1", short_id: "rw-3", causes: [], status: "held", frame_chars: 0, created_at: NOW - 3 * H },
      ],
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    const growth = r.org.roles.find((x) => x.handle === "growth")!;
    expect(growth.idle).toBe(false);
    expect(growth.wakes_7d).toMatchObject({ total: 2, held: 1, days_at_cap: 1 });
    expect(growth.overlaps).toEqual([{ handle: "growth2", projects: 1, plans: 0 }]);
    // Billing owns a project with no task, plan, doc or visible session: the
    // scope feed has no row for it, so the role reads idle.
    const billing = r.org.roles.find((x) => x.handle === "billing")!;
    expect(billing).toMatchObject({ idle: true, last_scope_event_at: null, idle_days: null });
    expect(r.org.projects_without_role).toEqual([]);
  });
});

// A fake stack: one role proposal answered "create", one answered "create with
// changes", one skipped, one still pending.
function proposalDecision(id: string, short: string, proposal: any, answer: { status: "answered" | "pending"; answer_index?: number; answer_text?: string }) {
  return {
    _id: id, conversation_id: S1, session_id: "s1", user_id: ME, short_id: short,
    question: `Create ${proposal.name ?? proposal.handle ?? "projects"}?`,
    context_md: `Why: evidence.\n\n${orgProposalBlock(proposal)}`,
    options: [{ label: "Create as proposed" }, { label: "Create with changes" }, { label: "Skip" }],
    blocking: true, stack_id: STACK, created_at: NOW - H,
    ...(answer.status === "answered" ? { answered_by: { kind: "user", id: ME } } : {}),
    ...answer,
  };
}

describe("cast org apply", () => {
  test("an explicit personal stack never inherits the asking session's team", async () => {
    const db = fixtures({
      decision_stacks: [{ _id: STACK, short_id: "ds-1", title: "Personal CMO", scope_user_id: ME, owner_user_id: ME, decision_ids: [], policy: {}, status: "open", created_at: NOW, updated_at: NOW }],
      projects: [{ _id: P, user_id: ME, workspace: `user:${ME}`, short_id: "pr-1", title: "Personal product", status: "active", created_at: 1, updated_at: NOW }],
      session_decisions: [proposalDecision("sd_personal", "sd-90", { kind: "role", name: "Personal CMO", handle: "personal-cmo", scope: { projects: ["pr-1"] } }, { status: "answered", answer_index: 0 })],
    });
    const result = await performApplyDecision(ctxOf(db), ME as any, "sd-90", { provision: false });
    expect(result.status).toBe("applied");
    const roles = await db.query("org_roles").collect();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ scope_type: "user", scope_user_id: ME, scope: { project_ids: [P], plan_ids: [] } });
    expect(roles[0].team_id).toBeUndefined();
    expect((await db.get(S1 as any)).team_id).toBe(TEAM);
    expect((await performApplyDecision(ctxOf(db), ME as any, "sd-90", { provision: false })).status).toBe("skipped");
  });

  test("creates the accepted roles with scope, parent and charter, folds change text in, skips the rest, and is idempotent", async () => {
    const db = fixtures({
      session_decisions: [
        proposalDecision("sd_a", "sd-10", { kind: "role", name: "Head of Growth", handle: "growth", scope: { projects: ["pr-1"] }, charter: "Owns growth.", caps: { wakes_per_day: 12 } }, { status: "answered", answer_index: 0 }),
        proposalDecision("sd_b", "sd-11", { kind: "role", name: "Landing lead", handle: "landing", scope: { plans: ["pl-1"] }, reports_to: "@growth" }, { status: "answered", answer_index: 1, answer_text: "Report weekly, not daily." }),
        proposalDecision("sd_c", "sd-12", { kind: "role", name: "Billing lead", handle: "billing", scope: { projects: ["Billing"] } }, { status: "answered", answer_index: 2 }),
        proposalDecision("sd_d", "sd-13", { kind: "role", name: "Ops", handle: "ops" }, { status: "pending" }),
      ],
    });
    const ctx = ctxOf(db);
    const a = await performApplyDecision(ctx, ME as any, "sd-10", { provision: false });
    expect(a).toMatchObject({ status: "applied", role: { handle: "growth", short_id: "or-1" } });
    const growth = await db.get("org_roles_1" as any) ?? (await db.query("org_roles").withIndex("by_short_id", (q: any) => q.eq("short_id", "or-1")).first());
    expect(growth).toMatchObject({ name: "Head of Growth", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, charter: "Owns growth.", caps: { hands_per_day: 6, wakes_per_day: 12, tokens_per_day: 400_000 } });

    const b = await performApplyDecision(ctx, ME as any, "sd-11", { provision: false });
    expect(b).toMatchObject({ status: "applied", role: { handle: "landing" } });
    const landing = await db.query("org_roles").withIndex("by_short_id", (q: any) => q.eq("short_id", "or-2")).first();
    expect(landing.reports_to).toEqual({ kind: "role", role_id: growth._id });
    expect(landing.scope).toEqual({ project_ids: [], plan_ids: [PLAN] });
    expect(landing.charter).toContain("Report weekly, not daily.");

    expect(await performApplyDecision(ctx, ME as any, "sd-12", { provision: false })).toMatchObject({ status: "skipped" });
    expect(await performApplyDecision(ctx, ME as any, "sd-13", { provision: false })).toMatchObject({ status: "unanswered" });
    expect((await db.get("sd_a" as any)).applied_at).toBeGreaterThan(0);
    expect((await db.get("sd_c" as any)).applied_at).toBeGreaterThan(0);
    expect((await db.get("sd_d" as any)).applied_at).toBeUndefined();

    // Second run: nothing created twice.
    expect(await performApplyDecision(ctx, ME as any, "sd-10", { provision: false })).toMatchObject({ status: "skipped", note: expect.stringContaining("already applied") });
    const roles = await db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", TEAM)).collect();
    expect(roles.map((r: any) => r.handle).sort()).toEqual(["growth", "landing"]);
  });

  test("a handle the person already gave a role by hand is refused, never adopted", async () => {
    const db = fixtures({
      org_roles: [
        { _id: "org_roles_hand", short_id: "or-3", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth (mine)", handle: "growth", scope: { project_ids: [Q], plan_ids: [] }, reports_to: { kind: "user", user_id: MATE }, charter: "My own words.", status: "active", created_by: ME, created_at: 1, updated_at: 1 },
      ],
      session_decisions: [
        proposalDecision("sd_a", "sd-40", { kind: "role", name: "Head of Growth", handle: "growth", scope: { projects: ["pr-1"] }, charter: "Owns growth.", caps: { wakes_per_day: 12 } }, { status: "answered", answer_index: 0 }),
      ],
    });
    const ctx = ctxOf(db);
    const r = await performApplyDecision(ctx, ME as any, "sd-40", { provision: false });
    // Read the message once: bun's toMatchObject with an asymmetric matcher
    // writes the matcher back into the received object.
    const message = r.status === "error" ? r.error : "";
    expect(r.status).toBe("error");
    expect(message).toContain("@growth is already or-3 (Growth (mine))");
    expect(message).toContain("pick another handle, or skip");
    // The hand made role is untouched: scope, parent, charter and caps.
    const hand = await db.get("org_roles_hand" as any);
    expect(hand).toMatchObject({ scope: { project_ids: [Q], plan_ids: [] }, reports_to: { kind: "user", user_id: MATE }, charter: "My own words." });
    expect(hand.caps).toBeUndefined();
    // Not stamped: answering with a new handle makes the same decision apply.
    expect((await db.get("sd_a" as any)).applied_at).toBeUndefined();
    const roles = await db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", TEAM)).collect();
    expect(roles.length).toBe(1);
  });

  test("an answer that is not a person's (a delegated role, a policy default) does not apply", async () => {
    const db = fixtures({
      session_decisions: [
        { ...proposalDecision("sd_r", "sd-50", { kind: "role", name: "X", handle: "xx" }, { status: "answered", answer_index: 0 }), answered_by: { kind: "role", id: "org_roles_9" } },
        { ...proposalDecision("sd_p", "sd-51", { kind: "role", name: "Y", handle: "yy" }, { status: "answered", answer_index: 0 }), answered_by: { kind: "policy", id: "stack:x" } },
      ],
    });
    const ctx = ctxOf(db);
    expect(await performApplyDecision(ctx, ME as any, "sd-50", { provision: false })).toMatchObject({ status: "error", error: expect.stringContaining("only when a person answered it (answered by role)") });
    expect(await performApplyDecision(ctx, ME as any, "sd-51", { provision: false })).toMatchObject({ status: "error", error: expect.stringContaining("answered by policy") });
    expect(await db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", TEAM)).collect()).toEqual([]);
  });

  test("a decision without a proposal block, or applied by a plain member, is refused as a value", async () => {
    const db = fixtures({
      session_decisions: [
        { _id: "sd_p", conversation_id: S1, session_id: "s1", user_id: ME, short_id: "sd-20", question: "Plain?", context_md: "no block", options: [{ label: "a" }, { label: "b" }, { label: "c" }], blocking: true, status: "answered", answer_index: 0, stack_id: STACK, created_at: NOW },
        proposalDecision("sd_q", "sd-21", { kind: "role", name: "X", handle: "xx" }, { status: "answered", answer_index: 0 }),
      ],
    });
    const ctx = ctxOf(db);
    expect(await performApplyDecision(ctx, ME as any, "sd-20")).toMatchObject({ status: "error", error: expect.stringContaining("no org proposal") });
    expect(await performApplyDecision(ctx, MATE as any, "sd-21")).toMatchObject({ status: "error", error: expect.stringContaining("owner or a team admin") });
    expect(await performApplyDecision(ctx, ME as any, "sd-99")).toMatchObject({ status: "error" });
  });

  test("update mode proposals: projects, move and retire", async () => {
    const db = fixtures({
      org_roles: [
        { _id: "org_roles_1", short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth lead", handle: "growth", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 },
        { _id: "org_roles_2", short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Old", handle: "old", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 },
      ],
      session_decisions: [
        proposalDecision("sd_a", "sd-30", { kind: "projects", changes: [{ op: "create", title: "Platform", description: "Shared infra", project_path: "/repo/platform" }] }, { status: "answered", answer_index: 0 }),
        proposalDecision("sd_b", "sd-31", { kind: "move", handle: "growth", scope_add: ["pr-2"], reports_to: "Mate" }, { status: "answered", answer_index: 0 }),
        proposalDecision("sd_c", "sd-32", { kind: "retire", handle: "@old" }, { status: "answered", answer_index: 0 }),
      ],
    });
    const ctx = ctxOf(db);
    expect(await performApplyDecision(ctx, ME as any, "sd-30")).toMatchObject({ status: "applied", note: expect.stringContaining('created project "Platform"') });
    const platform = (await db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", WS)).collect()).find((p: any) => p.title === "Platform");
    expect(platform).toMatchObject({ team_id: TEAM, workspace: WS, status: "active", project_path: "/repo/platform" });
    // Re-applying after the stamp is a skip; an unstamped identical create finds the project and does not twin it.
    await db.patch("sd_a" as any, { applied_at: undefined, applied_note: undefined });
    expect(await performApplyDecision(ctx, ME as any, "sd-30")).toMatchObject({ status: "applied", note: expect.stringContaining("already exists") });

    expect(await performApplyDecision(ctx, ME as any, "sd-31")).toMatchObject({ status: "applied" });
    const growth = await db.get("org_roles_1" as any);
    expect(growth.scope.project_ids.map(String).sort()).toEqual([P, Q].sort());
    expect(growth.reports_to).toEqual({ kind: "user", user_id: MATE });

    expect(await performApplyDecision(ctx, ME as any, "sd-32")).toMatchObject({ status: "applied", note: expect.stringContaining("retired @old") });
    expect((await db.get("org_roles_2" as any)).status).toBe("retired");
  });
});
