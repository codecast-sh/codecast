import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "../testDb";
import { ownerMembershipVisibilityAt, teamVisibleInputs, teamVisibleRecentInsights } from "./changesAccess";

// The access matrix for the Changes gate (changes-page.md 8.4): which sessions
// a team's stories may draw on, and how much of each.

const TEAM = "team_a" as any;
const OTHER = "team_b" as any;
const SPLIT = 1_000_000;

type Seed = {
  conversations: any[];
  members?: Array<{ user_id: string; visibility?: string; visibility_history?: any[]; team_id?: string }>;
  insights?: any[];
};

function ctxFor({ conversations, members = [], insights }: Seed) {
  return {
    db: makeFakeDb({
      conversations,
      team_memberships: members.map((m, i) => ({ _id: `m${i}`, team_id: TEAM, role: "member", ...m })),
      session_insights: insights ?? conversations.map((c) => insightFor(c._id)),
    }),
  } as any;
}

function conv(id: string, fields: Record<string, any> = {}) {
  return { _id: id, user_id: "u1", team_id: TEAM, is_private: false, started_at: SPLIT + 1, title: `title ${id}`, ...fields };
}

function insightFor(conversationId: string, fields: Record<string, any> = {}) {
  return {
    _id: `i_${conversationId}`, conversation_id: conversationId, team_id: TEAM, actor_user_id: "u1",
    source: "idle", generated_at: 5, summary: `summary ${conversationId}`, headline: `headline ${conversationId}`,
    turns: [{ ask: "ask", did: ["did"] }], goal: "goal", what_changed: "wc", key_changes: ["k"],
    next_action: "next", themes: ["t"], outcome_type: "progress", ...fields,
  };
}

async function gate(seed: Seed, ids?: string[]) {
  return teamVisibleInputs(ctxFor(seed), TEAM, (ids ?? seed.conversations.map((c) => c._id)) as any);
}

describe("teamVisibleInputs: conversation visibility", () => {
  test("a private session contributes nothing", async () => {
    const out = await gate({ conversations: [conv("c1", { is_private: true })] });
    expect(out.size).toBe(0);
  });

  test("an auto-shared session passes at the member's default summary level", async () => {
    const out = await gate({ conversations: [conv("c1", { auto_shared: true })], members: [{ user_id: "u1" }] });
    const input = out.get("c1")!;
    expect(input.mode).toBe("summary");
    expect(input.membership_level).toBe("summary");
    expect(input.owner_id as any).toBe("u1");
    expect(input.insight).toEqual({
      _id: "i_c1" as any, generated_at: 5, headline: "headline c1", summary: "summary c1", outcome_type: "progress",
    });
  });

  test("team_visibility summary on a private session passes at summary, even for a full member", async () => {
    const out = await gate({
      conversations: [conv("c1", { is_private: true, team_visibility: "summary" })],
      members: [{ user_id: "u1", visibility: "full" }],
    });
    expect(out.get("c1")?.mode).toBe("summary");
    expect(out.get("c1")?.insight?.turns).toBeUndefined();
  });

  test("team_visibility full lets turns through", async () => {
    const out = await gate({
      conversations: [conv("c1", { is_private: true, team_visibility: "full" })],
      members: [{ user_id: "u1", visibility: "summary" }],
    });
    expect(out.get("c1")?.mode).toBe("full");
    expect(out.get("c1")?.insight?.turns).toEqual([{ ask: "ask", did: ["did"] }]);
  });

  test("a full member's shared session passes at full", async () => {
    const out = await gate({ conversations: [conv("c1")], members: [{ user_id: "u1", visibility: "full" }] });
    expect(out.get("c1")?.mode).toBe("full");
  });

  test("locked private never passes, even with a stale auto_shared flag", async () => {
    const out = await gate({
      conversations: [conv("c1", { is_private: true, team_visibility: "private", auto_shared: true })],
      members: [{ user_id: "u1", visibility: "full" }],
    });
    expect(out.size).toBe(0);
  });

  test("a session routed to another team, or to none, never passes", async () => {
    const out = await gate({
      conversations: [conv("c1", { team_id: OTHER }), conv("c2", { team_id: undefined })],
      members: [{ user_id: "u1", visibility: "full" }],
    });
    expect(out.size).toBe(0);
  });

  test("unknown and repeated ids are ignored", async () => {
    const out = await gate({ conversations: [conv("c1")], members: [{ user_id: "u1" }] }, ["c1", "c1", "nope"]);
    expect([...out.keys()]).toEqual(["c1"]);
  });
});

describe("teamVisibleInputs: membership level", () => {
  for (const level of ["hidden", "activity"]) {
    test(`a member at ${level} contributes nothing, whatever the session says`, async () => {
      const out = await gate({
        conversations: [conv("c1"), conv("c2", { is_private: true, team_visibility: "full" })],
        members: [{ user_id: "u1", visibility: level }],
      });
      expect(out.size).toBe(0);
    });
  }

  test("a going-forward raise reads each session at its own segment", async () => {
    const members = [{ user_id: "u1", visibility: "full", visibility_history: [{ before: SPLIT, visibility: "summary" }] }];
    const out = await gate({
      conversations: [conv("old", { started_at: SPLIT - 1 }), conv("new", { started_at: SPLIT + 1 })],
      members,
    });
    expect(out.get("old")?.mode).toBe("summary");
    expect(out.get("old")?.membership_level).toBe("summary");
    expect(out.get("old")?.insight?.turns).toBeUndefined();
    expect(out.get("new")?.mode).toBe("full");
    expect(out.get("new")?.membership_level).toBe("full");
  });

  test("sessions from a hidden stretch stay out after the member opens up going forward", async () => {
    const out = await gate({
      conversations: [conv("old", { started_at: SPLIT - 1 }), conv("new", { started_at: SPLIT + 1 })],
      members: [{ user_id: "u1", visibility: "summary", visibility_history: [{ before: SPLIT, visibility: "hidden" }] }],
    });
    expect([...out.keys()]).toEqual(["new"]);
  });

  test("ownerMembershipVisibilityAt reads the history at the session start", async () => {
    const ctx = ctxFor({
      conversations: [],
      members: [{ user_id: "u1", visibility: "full", visibility_history: [{ before: SPLIT, visibility: "activity" }] }],
    });
    expect(await ownerMembershipVisibilityAt(ctx, "u1" as any, TEAM, SPLIT - 1)).toBe("activity");
    expect(await ownerMembershipVisibilityAt(ctx, "u1" as any, TEAM, SPLIT)).toBe("full");
    expect(await ownerMembershipVisibilityAt(ctx, "u1" as any, TEAM, undefined)).toBe("full");
  });
});

describe("teamVisibleInputs: insights", () => {
  test("an insight written under another team is withheld; the session still passes", async () => {
    const out = await gate({
      conversations: [conv("c1")],
      members: [{ user_id: "u1" }],
      insights: [insightFor("c1", { team_id: OTHER })],
    });
    expect(out.get("c1")?.insight).toBeNull();
  });

  test("a session with no insight passes with none", async () => {
    const out = await gate({ conversations: [conv("c1")], members: [{ user_id: "u1" }], insights: [] });
    expect(out.get("c1")?.insight).toBeNull();
  });

  test("fields prose must never read do not leave the gate", async () => {
    const out = await gate({ conversations: [conv("c1")], members: [{ user_id: "u1", visibility: "full" }] });
    const insight = out.get("c1")!.insight as any;
    for (const key of ["goal", "what_changed", "key_changes", "next_action", "themes", "blockers", "metadata"]) {
      expect(insight[key]).toBeUndefined();
    }
  });
});

describe("teamVisibleRecentInsights", () => {
  test("keeps only insights whose sessions pass the gate", async () => {
    const conversations = [conv("shared"), conv("private", { is_private: true }), conv("hiddenOwner", { user_id: "u2" })];
    const ctx = ctxFor({
      conversations,
      members: [{ user_id: "u1" }, { user_id: "u2", visibility: "hidden" }],
      insights: [insightFor("shared"), insightFor("private"), insightFor("hiddenOwner", { actor_user_id: "u2" }),
        insightFor("elsewhere", { team_id: OTHER })],
    });
    const rows = await teamVisibleRecentInsights(ctx, TEAM, 0);
    expect(rows.map((r) => r.conversation_id as string)).toEqual(["shared"]);
    expect(rows[0].insight.headline).toBe("headline shared");
  });
});
