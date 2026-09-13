// A typed org tree matching S3 exactly. Used for the empty state preview and
// the layout tests. Ids and ordering are deterministic; timestamps hang off the
// hour the module loaded so the relative ages read as recent.
import type { WorkState } from "@codecast/shared/contracts";
import { countStates, sortOrgSessions, type OrgSession, type OrgTree } from "./orgTypes";

const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const STATES: WorkState[] = ["working", "needs_input", "done", "dormant", "idle"];
const AGENTS = ["claude", "codex", "claude", "gemini", "claude", "cursor", "claude", "opencode"];
const TITLES = [
  "Fix the auth race on team switch",
  "Migrate sync layer to wake signatures",
  "Org page: React Flow canvas",
  "Investigate slow inbox paint",
  "Draft release notes for 1.2",
  "Reconcile pending tombstones",
  "Mobile composer strobe after send",
  "Add role scope to CLI",
  "Punchcard chart for team activity",
  "Backfill short ids on plans",
];

function session(i: number, opts: { owner?: string; role?: string }): OrgSession {
  return {
    _id: `fixture-session-${i}`,
    short_id: `jx7f${(i + 10).toString(36)}${(i * 7 % 36).toString(36)}`,
    title: TITLES[i % TITLES.length] + (i >= TITLES.length ? ` (${Math.floor(i / TITLES.length) + 1})` : ""),
    agent_type: AGENTS[i % AGENTS.length],
    state: STATES[(i * 3) % STATES.length],
    updated_at: T0 - i * 7 * 60_000,
    owner_user_id: opts.owner,
    org_role_id: opts.role,
    subagent_count: i % 5 === 0 ? 2 + (i % 3) : 0,
    is_anchor: false,
    project_path: i % 2 ? "~/src/codecast" : "~/src/platform",
    git_branch: "main",
  };
}

const ME = "fixture-user-me";
const SAM = "fixture-user-sam";
const ROLE = "fixture-role-growth";

const mine = Array.from({ length: 22 }, (_, i) => session(i, { owner: ME }));
const sams = Array.from({ length: 11 }, (_, i) => session(100 + i, { owner: SAM }));
const growth = Array.from({ length: 7 }, (_, i) => session(200 + i, { owner: ME, role: ROLE }));

export const ORG_FIXTURE: OrgTree = {
  workspace: { kind: "team", id: "fixture-team", name: "Codecast" },
  people: [
    {
      user_id: ME,
      name: "Ashot Petrosian",
      role: "owner",
      is_me: true,
      presence: "online",
      counts: countStates(mine),
      sessions: sortOrgSessions(mine).slice(0, 8),
      total: mine.length,
    },
    {
      user_id: SAM,
      name: "Samvit Jain",
      role: "member",
      is_me: false,
      presence: "away",
      counts: countStates(sams),
      sessions: sortOrgSessions(sams).slice(0, 8),
      total: sams.length,
    },
  ],
  roles: [
    {
      _id: ROLE,
      short_id: "or-1",
      scope_type: "team",
      team_id: "fixture-team",
      host_user_id: ME,
      name: "Head of Growth",
      handle: "growth",
      scope: { project_ids: ["fixture-project-growth"], plan_ids: ["fixture-plan-seo"] },
      reports_to: { kind: "user", user_id: ME },
      status: "active",
      charter: "Owns organic search, paid search and the weekly growth review.",
      created_by: ME,
      created_at: T0 - 86_400_000 * 12,
      updated_at: T0 - 3_600_000,
      counts: countStates(growth),
      sessions: sortOrgSessions(growth).slice(0, 8),
      total: growth.length,
      scope_names: {
        projects: [{ id: "fixture-project-growth", title: "Growth", short_id: "pr-4" }],
        plans: [{ id: "fixture-plan-seo", title: "SEO and AI citations", short_id: "pl-88" }],
      },
    },
  ],
  anchors: [
    {
      anchor_id: "fixture-anchor",
      name: "Codecast anchor",
      bot_user_id: "fixture-bot",
      host_user_id: ME,
      scope_type: "team",
      team_id: "fixture-team",
      conversation_id: "fixture-anchor-conv",
      short_id: "jx70qkc",
      state: "dormant",
      status: "active",
    },
  ],
  generated_at: T0,
};

/** All fixture sessions, for tests that page through sessionsUnder. */
export const ORG_FIXTURE_ALL_SESSIONS: OrgSession[] = [...mine, ...sams, ...growth];
