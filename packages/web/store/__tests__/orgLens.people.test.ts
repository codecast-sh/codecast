import { describe, expect, test } from "bun:test";
import { groupSessionsForOrgLens, orgLensAvailable, type OrgLensSources } from "../orgLens";
import { applyPersonMove, drawnManager, managersAfterMove, personMoveApplies } from "../orgTreeMoves";
import type { InboxSession } from "../inboxStore";

// By reports with people: a person who reports to the viewer is a group of
// their sessions, their roles and their own reports fold under them, and the
// lens only regroups rows the inbox already holds.
const ME = "me", LEAD = "lead", IC = "ic", OTHER = "other";
const row = (id: string, user: string, extra: Partial<InboxSession> = {}) =>
  ({ _id: id, session_id: id, title: id, user_id: user, updated_at: 1, message_count: 1, agent_type: "claude_code", project_path: "/x/repo", ...extra }) as InboxSession;

function sources(people: Array<{ user_id: string; reports_to_user_id?: string }>): OrgLensSources {
  return {
    tasks: {}, plans: {}, projects: {}, initiatives: {}, sessions: {}, meId: ME,
    people: people.map((p) => ({ ...p, name: p.user_id.toUpperCase() })),
    roles: [
      { _id: "role_lead", name: "Lead's role", status: "active", reports_to: { kind: "user", user_id: LEAD } },
      { _id: "role_mine", name: "My role", status: "active", reports_to: { kind: "user", user_id: ME } },
    ],
  };
}

describe("By reports with people", () => {
  const src = sources([{ user_id: ME }, { user_id: LEAD, managers: [{ kind: "user", user_id: ME }] }, { user_id: IC, managers: [{ kind: "user", user_id: LEAD }] }, { user_id: OTHER }]);
  const items = [
    row("s_lead", LEAD),
    row("s_ic", IC),
    row("s_lead_role", OTHER, { org_role_id: "role_lead" }),
    row("s_mine_role", ME, { org_role_id: "role_mine" }),
    row("s_owned_by_lead", OTHER, { owner_user_id: LEAD }),
    row("s_other", OTHER),
    row("s_me", ME),
  ];
  const { groups, projectGroups } = groupSessionsForOrgLens("reports", items, src);

  test("a report holds their sessions, their role's, and their own reports'", () => {
    const lead = groups.find((g) => g.key === `person:${LEAD}`)!;
    expect(lead.userId).toBe(LEAD);
    expect(lead.items.map((x) => x._id).sort()).toEqual(["s_ic", "s_lead", "s_lead_role", "s_owned_by_lead"]);
    // A role that reports to the viewer stays its own group, and nobody else gets one.
    expect(groups.map((g) => g.key)).toEqual(["role_mine", `person:${LEAD}`]);
  });

  test("everything outside the viewer's line falls to the folder tier", () => {
    expect(projectGroups.flatMap((g) => g.items.map((x) => x._id)).sort()).toEqual(["s_me", "s_other"]);
  });

  test("the lens is offered when only a person reports to the viewer", () => {
    const onlyPeople = { ...src, roles: [] };
    expect(orgLensAvailable("reports", [], onlyPeople)).toBe(true);
    expect(orgLensAvailable("reports", [], { ...onlyPeople, people: onlyPeople.people.map(({ managers: _r, ...p }) => p) })).toBe(false);
  });
});

describe("movePerson on the tree", () => {
  test("moves, clears, and refuses a loop", () => {
    const tree = { people: [{ user_id: ME }, { user_id: LEAD, managers: [{ kind: "user", user_id: ME }] }, { user_id: IC }] as any[], roles: [] as any[] };
    applyPersonMove(tree, { kind: "movePerson", id: "i1", user_id: IC, managers: [{ kind: "user", user_id: LEAD }], at: 1 });
    expect(tree.people[2].managers).toEqual([{ kind: "user", user_id: LEAD }]);
    expect(personMoveApplies(tree, ME, [{ kind: "user", user_id: IC }])).toBe(false);
    applyPersonMove(tree, { kind: "movePerson", id: "i2", user_id: IC, managers: [], at: 2 });
    expect("managers" in tree.people[2]).toBe(false);
  });

  test("moves under a role and refuses a loop through one (org-people.md P2)", () => {
    const tree = { people: [{ user_id: ME }, { user_id: IC, managers: [{ kind: "user", user_id: ME }] }] as any[], roles: [{ _id: "r1", status: "active", reports_to: { kind: "user", user_id: IC } }] as any[] };
    // The role reports to Ic, who reports to Me: neither can go under it.
    expect(personMoveApplies(tree, IC, [{ kind: "role", role_id: "r1" }])).toBe(false);
    expect(personMoveApplies(tree, ME, [{ kind: "role", role_id: "r1" }])).toBe(false);
    delete tree.people[1].managers;
    applyPersonMove(tree, { kind: "movePerson", id: "i3", user_id: ME, managers: [{ kind: "role", role_id: "r1" }], at: 3 });
    expect(tree.people[0].managers).toEqual([{ kind: "role", role_id: "r1" }]);
    // Equal co-managers: Ic takes Me on beside the role; the chart draws Me under the role, listed first.
    applyPersonMove(tree, { kind: "movePerson", id: "i4", user_id: ME, managers: [{ kind: "role", role_id: "r1" }, { kind: "user", user_id: IC }], at: 4 });
    expect(tree.people[0].managers).toEqual([{ kind: "role", role_id: "r1" }, { kind: "user", user_id: IC }]);
    expect(drawnManager(tree as any, tree.people[0])).toEqual({ kind: "role", role_id: "r1" });
    // Dragging Me from the role's line onto Ic's card moves that line and keeps the rest; the top means nobody.
    expect(managersAfterMove(tree as any, ME, { kind: "user", user_id: IC })).toEqual([{ kind: "user", user_id: IC }]);
    expect(managersAfterMove(tree as any, ME, null)).toEqual([]);
  });
});

// By goal: offered only when a session on screen works in a project an open
// goal holds. A goal cached from another workspace holds none of them.
describe("By goal availability", () => {
  const base = sources([{ user_id: ME }]);
  const src: OrgLensSources = {
    ...base,
    tasks: { t1: { project_id: "p1" } as any },
    projects: { p1: { _id: "p1" } as any },
  };
  const items = [row("s1", ME, { active_task: { _id: "t1" } as any })];
  const goal = (project_ids: string[], status = "active") => ({ g1: { _id: "g1", title: "G", status, project_ids } });

  test("a goal over an on-screen session's project offers the lens", () => {
    expect(orgLensAvailable("goal", items, { ...src, initiatives: goal(["p1"]) })).toBe(true);
  });

  test("a goal over projects nobody on screen works in does not", () => {
    expect(orgLensAvailable("goal", items, { ...src, initiatives: goal(["p_elsewhere"]) })).toBe(false);
  });

  test("a closed goal does not", () => {
    expect(orgLensAvailable("goal", items, { ...src, initiatives: goal(["p1"], "done") })).toBe(false);
  });
});
