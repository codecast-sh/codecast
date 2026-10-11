// Which queue items an org conversation asked the viewer, with their role,
// and which of them answer in place. Run: bun test components/org/orgDecisions.test.ts
import { describe, expect, test } from "bun:test";
import { ORG_FIXTURE_WITH_HEAD } from "./orgFixture";
import { canAnswerInPlace, orgDecisions } from "./orgDecisions";

const HEAD_ID = "fixture-role-head";
const GROWTH_ID = ORG_FIXTURE_WITH_HEAD.roles.find((r) => r.handle === "growth")!._id;

const decide = (extra: Record<string, unknown> = {}): any => ({ key: "decide:1", source: "decide", conversationId: "fixture-growth-conv", question: "Keep the spring ads running?", options: [{ label: "Yes" }, { label: "No" }], blocking: true, createdAt: 100, decisionId: "sd1", ...extra });
const roles = (tree: typeof ORG_FIXTURE_WITH_HEAD | null, queue: any[]) => orgDecisions(tree, queue).map(({ item, role }) => [item.key, role._id]);

describe("org decisions", () => {
  test("a decision from a role's conversation is that role's, oldest first", () => {
    const ask = { key: "ask:fixture-head-conv", source: "ask", conversationId: "fixture-head-conv", question: "Head of People", options: [], blocking: true, createdAt: 50 };
    expect(roles(ORG_FIXTURE_WITH_HEAD, [decide(), ask])).toEqual([["ask:fixture-head-conv", HEAD_ID], ["decide:1", GROWTH_ID]]);
  });

  test("a decision outside the org, or one a role holds under a grant, is not the viewer's", () => {
    expect(roles(ORG_FIXTURE_WITH_HEAD, [decide({ conversationId: "somebody-elses-session" }), decide({ key: "decide:2", heldByRole: true })])).toEqual([]);
  });

  test("without a tree no decision matches a role", () => {
    expect(roles(null, [decide()])).toEqual([]);
  });

  test("a session filed under a role since the tree listed sessions asks as that role, read from its own row", () => {
    const filed = decide({ key: "decide:2", conversationId: "filed-since", session: { _id: "filed-since", org_role_id: GROWTH_ID } });
    const rolesOnly = { ...ORG_FIXTURE_WITH_HEAD, roles: ORG_FIXTURE_WITH_HEAD.roles.map((r) => ({ ...r, sessions: [] })) };
    expect(roles(rolesOnly, [filed])).toEqual([["decide:2", GROWTH_ID]]);
    // A retired role's filing is not a decision of the org's.
    const retired = { ...rolesOnly, roles: rolesOnly.roles.map((r) => (r._id === GROWTH_ID ? { ...r, status: "retired" as const } : r)) };
    expect(roles(retired, [filed])).toEqual([]);
  });

  test("a short single-choice decide answers in place; a multi-choice card, many options, or a question does not", () => {
    expect(canAnswerInPlace(decide())).toBe(true);
    expect(canAnswerInPlace(decide({ kind: "multi" }))).toBe(false);
    expect(canAnswerInPlace(decide({ options: [1, 2, 3, 4, 5].map((n) => ({ label: `${n}` })) }))).toBe(false);
    expect(canAnswerInPlace(decide({ source: "ask", decisionId: undefined }))).toBe(false);
  });
});
