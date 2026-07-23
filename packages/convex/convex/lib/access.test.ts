import { describe, expect, test } from "bun:test";
import type { Id } from "../_generated/dataModel";
import {
  canAccessTask,
  canAccessDoc,
  canAccessPlan,
  canAccessProject,
  canAccessConversation,
  requireTeamMembership,
  workspaceForConversation,
  workspaceForResource,
  workspacesMatch,
} from "./access";

// ── Mock ctx ──
// The owner-or-team helpers (task/doc/plan) only read team_memberships via the
// by_user_team index. The conversation helper additionally reads the OWNER's
// membership row to resolve visibility (privacy.isConversationTeamVisible). This
// mock backs both off one in-memory membership list, honoring the index predicate
// (user_id + team_id) so a query for one user's row never leaks another's.

type Membership = { user_id: string; team_id: string; visibility?: string };

function mockCtx(memberships: Membership[]) {
  return {
    db: {
      query: (_table: string) => {
        let pred: (m: Membership) => boolean = () => true;
        const builder: any = {
          withIndex: (_name: string, fn: (q: any) => any) => {
            // Capture the eq() constraints the helper applies (user_id, team_id).
            const constraints: Record<string, string> = {};
            const q = {
              eq: (field: string, value: string) => {
                constraints[field] = value;
                return q;
              },
            };
            fn(q);
            pred = (m) =>
              Object.entries(constraints).every(
                ([k, v]) => (m as any)[k]?.toString() === v?.toString(),
              );
            return builder;
          },
          first: async () => memberships.find(pred) ?? null,
          collect: async () => memberships.filter(pred),
        };
        return builder;
      },
    },
  } as any;
}

const OWNER = "u_owner" as Id<"users">;
const MEMBER = "u_member" as Id<"users">;
const STRANGER = "u_stranger" as Id<"users">;
const TEAM = "t_team" as Id<"teams">;

// Owner is a member of the team with a shareable visibility (so team-visible
// conversations actually surface to teammates). MEMBER is also on the team.
const memberships: Membership[] = [
  { user_id: OWNER, team_id: TEAM, visibility: "summary" },
  { user_id: MEMBER, team_id: TEAM, visibility: "summary" },
];

// ── tasks / docs / plans share the plain owner-or-team rule ──
describe("canAccessTask", () => {
  const task = { user_id: OWNER, team_id: TEAM };

  test("owner has access", async () => {
    expect(await canAccessTask(mockCtx(memberships), OWNER, task)).toBe(true);
  });
  test("team member has access", async () => {
    expect(await canAccessTask(mockCtx(memberships), MEMBER, task)).toBe(true);
  });
  test("non-member is denied", async () => {
    expect(await canAccessTask(mockCtx(memberships), STRANGER, task)).toBe(false);
  });
  test("team-less task is private to its owner", async () => {
    const solo = { user_id: OWNER };
    expect(await canAccessTask(mockCtx(memberships), MEMBER, solo)).toBe(false);
  });
  test("an explicit assignee can access a team-less task", async () => {
    const assigned = { user_id: OWNER, assignee: MEMBER.toString() };
    expect(await canAccessTask(mockCtx(memberships), MEMBER, assigned)).toBe(true);
  });
});

describe("canAccessDoc", () => {
  const doc = { user_id: OWNER, team_id: TEAM };

  test("owner has access", async () => {
    expect(await canAccessDoc(mockCtx(memberships), OWNER, doc)).toBe(true);
  });
  test("team member has access", async () => {
    expect(await canAccessDoc(mockCtx(memberships), MEMBER, doc)).toBe(true);
  });
  test("non-member is denied", async () => {
    expect(await canAccessDoc(mockCtx(memberships), STRANGER, doc)).toBe(false);
  });
});

describe("canAccessPlan", () => {
  const plan = { user_id: OWNER, team_id: TEAM };

  test("owner has access", async () => {
    expect(await canAccessPlan(mockCtx(memberships), OWNER, plan)).toBe(true);
  });
  test("team member has access", async () => {
    expect(await canAccessPlan(mockCtx(memberships), MEMBER, plan)).toBe(true);
  });
  test("non-member is denied", async () => {
    expect(await canAccessPlan(mockCtx(memberships), STRANGER, plan)).toBe(false);
  });
});

describe("canAccessProject", () => {
  const project = { user_id: OWNER, team_id: TEAM };

  test("owner and team member have access", async () => {
    expect(await canAccessProject(mockCtx(memberships), OWNER, project)).toBe(true);
    expect(await canAccessProject(mockCtx(memberships), MEMBER, project)).toBe(true);
  });

  test("non-member is denied", async () => {
    expect(await canAccessProject(mockCtx(memberships), STRANGER, project)).toBe(false);
  });
});

describe("requireTeamMembership", () => {
  test("returns the membership for a member", async () => {
    const membership = await requireTeamMembership(mockCtx(memberships), MEMBER, TEAM);
    expect(membership?.user_id).toBe(MEMBER);
  });

  test("throws a typed forbidden error for a non-member", async () => {
    await expect(requireTeamMembership(mockCtx(memberships), STRANGER, TEAM))
      .rejects.toThrow("Forbidden");
  });
});

// ── conversations carry the faithful visibility nuance ──
// A team member only gets access when the conversation is actually team-visible
// (not private). team_id alone is routing, not a grant.
describe("canAccessConversation", () => {
  const sharedConv = { user_id: OWNER, team_id: TEAM, is_private: false };
  const privateConv = { user_id: OWNER, team_id: TEAM, is_private: true };

  test("owner has access even to a private conversation", async () => {
    expect(await canAccessConversation(mockCtx(memberships), OWNER, privateConv)).toBe(true);
  });
  test("team member can access a SHARED conversation", async () => {
    expect(await canAccessConversation(mockCtx(memberships), MEMBER, sharedConv)).toBe(true);
  });
  test("team member CANNOT access a PRIVATE conversation (team_id is routing, not a grant)", async () => {
    expect(await canAccessConversation(mockCtx(memberships), MEMBER, privateConv)).toBe(false);
  });
  test("non-member is denied even on a shared conversation", async () => {
    expect(await canAccessConversation(mockCtx(memberships), STRANGER, sharedConv)).toBe(false);
  });
  test("a team_visibility override reveals an otherwise-private conversation to a member", async () => {
    const overridden = { ...privateConv, team_visibility: "team" };
    expect(await canAccessConversation(mockCtx(memberships), MEMBER, overridden)).toBe(true);
  });
});

describe("authorization workspaces", () => {
  test("a private team-routed conversation remains in its owner's personal workspace", () => {
    const conversation = { user_id: OWNER, team_id: TEAM, is_private: true };
    expect(workspaceForConversation(conversation)).toEqual({ type: "personal", userId: OWNER });
    expect(workspacesMatch(
      workspaceForConversation(conversation),
      workspaceForResource({ user_id: OWNER }),
    )).toBe(true);
  });

  test("a shared conversation and a team work item share one authorization workspace", () => {
    const conversation = { user_id: OWNER, team_id: TEAM, is_private: false };
    expect(workspacesMatch(
      workspaceForConversation(conversation),
      workspaceForResource({ user_id: OWNER, team_id: TEAM }),
    )).toBe(true);
  });
});
