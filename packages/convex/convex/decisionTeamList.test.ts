import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { ANSWERED_WINDOW_MS, teamDecisionsCore } from "./decisionTeamList";
import { withDecisionFacts } from "./lib/decisionRowFacts";
import { decisionTeamOf, restampDecisionTeams } from "./lib/decisionTeam";
import { backfillPage } from "./decisionTeamBackfill";

// The Decisions page's Team view reads every decision of one workspace the
// viewer may read: its open ones whoever owns them, and the last week's
// answered ones. Line decisions stay with listOpenForLines; trial asks reach
// nobody; another team's and a private session's stay out.

const ME = "users_me" as any;
const MATE = "users_mate" as any;
const OUTSIDER = "users_out" as any;
const TEAM = "teams_t" as any;
const OTHER_TEAM = "teams_o" as any;
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

// Each row carries the team askCore stamps on it (lib/decisionTeam.ts): its conversation's here.
const TEAM_OF: Record<string, string | undefined> = { conversations_team: TEAM, conversations_private: TEAM, conversations_other: OTHER_TEAM };

function fixture({ stamped = true } = {}) {
  const decision = (id: string, conversation: string, extra: Record<string, unknown> = {}) => ({
    _id: id, short_id: id.replace("session_decisions_", "sd-"), conversation_id: conversation, session_id: "s", user_id: MATE,
    question: "q", options: [{ label: "A" }, { label: "B" }], blocking: true, status: "pending", created_at: NOW - DAY,
    ...(stamped && TEAM_OF[conversation] ? { team_id: TEAM_OF[conversation] } : {}), ...extra,
  });
  return {
    users: [{ _id: ME, name: "Me" }, { _id: MATE, name: "Mate" }, { _id: OUTSIDER, name: "Out" }],
    teams: [{ _id: TEAM }, { _id: OTHER_TEAM }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "member" },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member" },
      { _id: "m3", user_id: OUTSIDER, team_id: OTHER_TEAM, role: "member" },
    ],
    conversations: [
      { _id: "conversations_team", session_id: "s1", user_id: MATE, team_id: TEAM, team_visibility: "full" },
      { _id: "conversations_private", session_id: "s2", user_id: MATE, team_id: TEAM, is_private: true },
      { _id: "conversations_other", session_id: "s3", user_id: OUTSIDER, team_id: OTHER_TEAM, team_visibility: "full" },
      { _id: "conversations_mine", session_id: "s4", user_id: ME },
    ],
    tasks: [{ _id: "tasks_t", short_id: "ct-1", user_id: MATE, team_id: TEAM, workspace: `team:${TEAM}`, title: "t", status: "open", project_id: "projects_p", task_type: "task", priority: "medium" }],
    workflows: [{ _id: "workflows_w", user_id: MATE, name: "feedback", slug: "feedback", label: "Feedback", nodes: [], edges: [] }],
    workflow_runs: [{ _id: "workflow_runs_r", user_id: MATE, workflow_id: "workflows_w", status: "paused", node_statuses: [], created_at: NOW, updated_at: NOW }],
    session_decisions: [
      decision("session_decisions_open", "conversations_team", { asked_user_ids: [MATE], task_id: "tasks_t" }),
      decision("session_decisions_unowned", "conversations_team", { asked_user_ids: [] }),
      decision("session_decisions_answered", "conversations_team", { status: "answered", resolved_at: NOW - DAY }),
      decision("session_decisions_old_answer", "conversations_team", { status: "answered", created_at: NOW - 12 * DAY, resolved_at: NOW - ANSWERED_WINDOW_MS - DAY }),
      decision("session_decisions_line", "conversations_team", { workflow_run_id: "workflow_runs_r", task_id: "tasks_t" }),
      decision("session_decisions_trial", "conversations_team", { trial: true }),
      decision("session_decisions_private", "conversations_private", { asked_user_ids: [MATE] }),
      decision("session_decisions_other", "conversations_other", { user_id: OUTSIDER }),
      decision("session_decisions_mine", "conversations_mine", { user_id: ME }),
    ],
    decision_inbox: [],
    session_owners: [],
  };
}

const ctx = (opts?: { stamped?: boolean }) => ({ db: makeFakeDb(fixture(opts), { indexes: schemaIndexes(schema as any) }) }) as any;
const ids = (rows: { _id: string }[]) => rows.map((r) => r._id).sort();

describe("teamDecisionsCore", () => {
  test("a team's open and recently answered decisions, whoever owns them", async () => {
    const rows = await teamDecisionsCore(ctx(), ME, `team:${TEAM}`, NOW);
    expect(ids(rows)).toEqual(["session_decisions_answered", "session_decisions_open", "session_decisions_unowned"]);
  });

  test("the personal workspace is the viewer's own sessions outside a team", async () => {
    expect(ids(await teamDecisionsCore(ctx(), ME, `user:${ME}`, NOW))).toEqual(["session_decisions_mine"]);
    expect(await teamDecisionsCore(ctx(), ME, `user:${MATE}`, NOW)).toEqual([]);
  });

  test("a team the viewer is not in reads nothing", async () => {
    expect(await teamDecisionsCore(ctx(), ME, `team:${OTHER_TEAM}`, NOW)).toEqual([]);
    expect(await teamDecisionsCore(ctx(), OUTSIDER, `team:${TEAM}`, NOW)).toEqual([]);
  });

  test("a private session's decision is its owner's", async () => {
    const rows = await teamDecisionsCore(ctx(), MATE, `team:${TEAM}`, NOW);
    expect(ids(rows)).toContain("session_decisions_private");
  });
});

describe("the team stamp", () => {
  test("the Team view reads the rows routed to the team, not every team's newest", async () => {
    // The same rows unstamped: nothing of the team's is read until the backfill stamps them.
    expect(await teamDecisionsCore(ctx({ stamped: false }), ME, `team:${TEAM}`, NOW)).toEqual([]);
  });

  test("a decision about a problem goes to the problem's team, else the asking conversation's", () => {
    expect(decisionTeamOf({ team_id: OTHER_TEAM }, { team_id: TEAM })).toBe(TEAM);
    expect(decisionTeamOf({ team_id: OTHER_TEAM }, { team_id: undefined })).toBe(OTHER_TEAM);
    expect(decisionTeamOf({ team_id: undefined }, null)).toBeUndefined();
  });

  test("the backfill counts on a dry run, then stamps open rows and the last 14 days' answered ones", async () => {
    const c = ctx({ stamped: false });
    const page = (dryRun: boolean, status: "pending" | "answered") => backfillPage(c, { dryRun, status, since: NOW - 14 * DAY, cursor: null, numItems: 100 });
    const dry = await page(true, "pending");
    expect([dry.scanned, dry.stamped, dry.team, dry.personal, dry.done]).toEqual([7, 6, 6, 1, true]);
    expect(await teamDecisionsCore(c, ME, `team:${TEAM}`, NOW)).toEqual([]);
    await page(false, "pending");
    expect((await page(false, "answered")).stamped).toBe(2);
    expect(ids(await teamDecisionsCore(c, ME, `team:${TEAM}`, NOW))).toEqual(["session_decisions_answered", "session_decisions_open", "session_decisions_unowned"]);
    // A second pass finds nothing left to stamp.
    expect((await page(false, "pending")).stamped).toBe(0);
  });

  test("a conversation moved to another team takes its decisions along", async () => {
    const c = ctx();
    await c.db.patch("conversations_private", { team_id: OTHER_TEAM });
    expect(await restampDecisionTeams(c, "conversations_private")).toBe(1);
    expect((await c.db.get("session_decisions_private")).team_id).toBe(OTHER_TEAM);
  });
});

describe("withDecisionFacts", () => {
  test("stamps the task's project as the area, the run's flow as the source, and its problem's findings and reach", async () => {
    const c = ctx();
    await c.db.patch("tasks_t", { cause: { signal_count: 4, first_seen: NOW, last_seen: NOW, fingerprints: ["evidence:contacts/a:1", "evidence:contacts/b:2", "evidence:contacts/a:3", "x"] } });
    const rows = await withDecisionFacts(c, [
      { _id: "a", task_id: "tasks_t", workflow_run_id: "workflow_runs_r" },
      { _id: "b" },
    ] as any);
    expect(rows.map((r) => [r.area_project_id, r.source_flow, r.problem_findings, r.problem_reach])).toEqual([["projects_p", "Feedback", 4, 2], [null, null, null, null]]);
  });
});
