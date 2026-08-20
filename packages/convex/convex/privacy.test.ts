import { describe, expect, test } from "bun:test";
import { profileConversationVisible, buildShareUpdate, buildPathRestampUpdate, resolveCreationPrivacy, isConversationTeamVisible, canOwnerOrTeamAccess } from "./privacy";
import { makeFakeDb } from "./testDb";

// Regression for the profile-feed privacy leak: a teammate's profile page
// (team/[username]) selected their conversations by (team_id, user_id) and
// rendered message previews + counts WITHOUT checking is_private. But team_id is
// routing — it's stamped on private conversations too — so private session text
// leaked onto any teammate's profile. profileConversationVisible is the gate.
//
// Shape: profileConversationVisible(isOwner, isViewerTeamMember, ownerMembershipVisibility, conversation)

const sharedConv = { user_id: "u_owner", team_id: "t1", is_private: false } as any;
const privateConv = { user_id: "u_owner", team_id: "t1", is_private: true } as any;

describe("profileConversationVisible", () => {
  test("THE BUG: a teammate cannot see the owner's PRIVATE conversation", () => {
    expect(profileConversationVisible(false, true, "summary", privateConv)).toBe(false);
  });

  test("the owner viewing their own profile sees their private conversation", () => {
    expect(profileConversationVisible(true, false, "summary", privateConv)).toBe(true);
  });

  test("a teammate sees a SHARED (non-private) conversation", () => {
    expect(profileConversationVisible(false, true, "summary", sharedConv)).toBe(true);
  });

  test("a per-conversation team_visibility override reveals an otherwise-private conv", () => {
    const overridden = { ...privateConv, team_visibility: "team" };
    expect(profileConversationVisible(false, true, "summary", overridden)).toBe(true);
  });

  test("team_visibility:'private' does NOT reveal a private conv", () => {
    const stillPrivate = { ...privateConv, team_visibility: "private" };
    expect(profileConversationVisible(false, true, "summary", stillPrivate)).toBe(false);
  });

  test("defense in depth: a non-member viewer sees nothing, even a shared conv", () => {
    expect(profileConversationVisible(false, false, "summary", sharedConv)).toBe(false);
  });

  test("owner opted out (membership visibility 'hidden') hides even shared convs from teammates", () => {
    expect(profileConversationVisible(false, true, "hidden", sharedConv)).toBe(false);
  });

  test("membership visibility 'activity' is not shareable — shared conv stays hidden", () => {
    expect(profileConversationVisible(false, true, "activity", sharedConv)).toBe(false);
  });

  test("legacy conv with undefined is_private is treated as private for teammates", () => {
    const legacy = { user_id: "u_owner", team_id: "t1" } as any; // no is_private field
    expect(profileConversationVisible(false, true, "summary", legacy)).toBe(false);
  });

  test("a conversation with no team_id is never team-visible to a teammate", () => {
    const noTeam = { user_id: "u_owner", is_private: false } as any;
    expect(profileConversationVisible(false, true, "summary", noTeam)).toBe(false);
  });
});

// Minimal ctx stub: buildShareUpdate only reads directory mappings and the
// owner doc. The index predicate is irrelevant to the seeded data, so ignore it.
function mockCtx(mappings: any[], owner: any) {
  return {
    db: {
      query: (_table: string) => ({
        withIndex: (_name: string, _fn: any) => ({ collect: async () => mappings }),
      }),
      get: async (_id: any) => owner,
    },
  } as any;
}

// Regression for "shared with nobody": setPrivacy/setTeamVisibility flipped
// is_private→false WITHOUT guaranteeing a team_id. A conversation with
// is_private:false and no team_id fails the very first gate of every team
// check (isConversationTeamVisible: `if (!team_id) return false`), so it reads
// as private to every teammate. buildShareUpdate is the single source of truth
// that keeps the two fields from diverging — sharing must always yield a team.
describe("buildShareUpdate — sharing always yields a team_id", () => {
  const UNION = "t_union";
  const mapping = {
    team_id: UNION,
    path_prefix: "/Users/ashot/src/union-mobile",
    auto_share: true,
  };

  // team_id comes back as the branded Id<"teams">; compare as plain strings.
  const share = (ctx: any, conv: any) =>
    buildShareUpdate(ctx, conv, "u_owner" as any) as Promise<{
      is_private: boolean;
      team_id?: string;
    }>;

  test("THE BUG: a team-less conv whose path matches a mapping gets that team", async () => {
    const ctx = mockCtx([mapping], { team_id: undefined, active_team_id: undefined });
    const updates = await share(ctx, {
      project_path: "/Users/ashot/src/union-mobile/outreach",
      git_root: "/Users/ashot/src/union-mobile",
    });
    expect(updates.is_private).toBe(false);
    expect(updates.team_id).toBe(UNION);
  });

  test("an already-teamed conv keeps its team (never overwrites)", async () => {
    const updates = await share(mockCtx([], {}), { team_id: "t_existing" });
    expect(updates.team_id).toBe("t_existing");
    expect(updates.is_private).toBe(false);
  });

  test("no mapping match → falls back to the owner's active team", async () => {
    const ctx = mockCtx([mapping], { active_team_id: "t_active", team_id: "t_default" });
    const updates = await share(ctx, { project_path: "/somewhere/else" });
    expect(updates.team_id).toBe("t_active");
  });

  test("no mapping + no active team → falls back to the owner's default team", async () => {
    const updates = await share(mockCtx([], { team_id: "t_default" }), { project_path: "/x" });
    expect(updates.team_id).toBe("t_default");
  });

  test("owner belongs to no team at all → team_id omitted (the only remaining edge)", async () => {
    const updates = await share(mockCtx([], {}), { project_path: "/x" });
    expect(updates.team_id).toBeUndefined();
    expect(updates.is_private).toBe(false);
  });
});

// Creation-time chokepoint: every conversation insert derives team/privacy
// from here. The bug it exists to prevent: an insert site writing an
// is_private:false literal with no team_id ("shared with nobody" — invisible
// to every teammate, and unfixable by restamp because it read as a manual
// share). tasks.assignToAgent and both workflow_runs inserts did exactly that.
describe("resolveCreationPrivacy — inserts always resolve team/privacy together", () => {
  const mapping = { team_id: "t_union", path_prefix: "/Users/a/src/union-mobile", auto_share: true };

  test("mapped path → team + shared + auto_shared, exactly like createConversation", async () => {
    const p = await resolveCreationPrivacy(
      mockCtx([mapping], {}), "u_owner" as any, "/Users/a/src/union-mobile/outreach"
    );
    expect(p).toEqual({ team_id: "t_union", is_private: false, auto_shared: true } as any);
  });

  test("unmapped path → private, fallback team kept for routing only", async () => {
    const p = await resolveCreationPrivacy(
      mockCtx([], {}), "u_owner" as any, "/elsewhere", "t_task" as any
    );
    expect(p).toEqual({ team_id: "t_task", is_private: true, auto_shared: undefined } as any);
  });
});

// Regression for the born-blank visibility gap: quick-create pre-warm and
// web-started stubs mint the conversation BEFORE the real path exists, so
// creation resolved team/privacy against nothing → private, teamless. When the
// daemon later stamped project_path/git_root (updateProjectPath /
// updateSessionId), nothing re-resolved — the conversation stayed private
// forever despite an auto_share mapping covering its directory. Observable
// symptom: two sessions in the same repo showed disjoint @ mention session
// lists, because mention scope keys off the conversation's team_id.
describe("buildPathRestampUpdate — late path stamp re-resolves born-blank visibility", () => {
  const mappings = [
    { team_id: "t_union", path_prefix: "/Users/a/src/union-mobile", auto_share: true },
    { team_id: "t_other", path_prefix: "/Users/a/src/other", auto_share: true },
    { team_id: "t_quiet", path_prefix: "/Users/a/src/quiet", auto_share: false },
  ] as any;

  // The pre-warm signature: private, no team, no explicit visibility marker.
  const bornBlank = { is_private: true } as any;

  test("THE BUG: born-blank conv stamped with a mapped git_root gets team + auto-share", () => {
    expect(buildPathRestampUpdate(bornBlank, mappings, "/Users/a/src/union-mobile")).toEqual({
      team_id: "t_union",
      is_private: false,
      auto_shared: true,
    } as any);
  });

  test("subdirectory of a mapped prefix matches (creation-equivalent prefix rule)", () => {
    expect(
      buildPathRestampUpdate(bornBlank, mappings, "/Users/a/src/union-mobile/outreach")
    ).toEqual({ team_id: "t_union", is_private: false, auto_shared: true } as any);
  });

  test("user-locked private (team_visibility 'private') is never touched", () => {
    const locked = { is_private: true, team_visibility: "private" } as any;
    expect(buildPathRestampUpdate(locked, mappings, "/Users/a/src/union-mobile")).toBeNull();
  });

  test("manually shared conv (is_private false without auto_shared) is never touched", () => {
    const manual = { is_private: false, team_id: "t_other" } as any;
    expect(buildPathRestampUpdate(manual, mappings, "/Users/a/src/union-mobile")).toBeNull();
  });

  // Regression for "shared with nobody" round 2: task/workflow launch paths
  // once inserted is_private:false literals with no team_id. Such a row reads
  // as shared but fails every team gate, and the manual-share guard used to
  // treat it as an explicit user choice — freezing the contradiction forever.
  // A shared row with NO team is never a valid manual share; adopting the
  // mapping's team only grants the visibility the owner already believes exists.
  test("THE BUG: shared-but-teamless conv under a mapped path gets the team", () => {
    const poisoned = { is_private: false } as any;
    expect(buildPathRestampUpdate(poisoned, mappings, "/Users/a/src/union-mobile/outreach")).toEqual({
      team_id: "t_union",
    } as any);
  });

  test("shared-but-teamless conv with no mapping match stays untouched (restamp never invents a team)", () => {
    const poisoned = { is_private: false } as any;
    expect(buildPathRestampUpdate(poisoned, mappings, "/Users/a/src/unmapped")).toBeNull();
  });

  test("no mapping match → no change (restamp never revokes)", () => {
    const autoShared = { is_private: false, auto_shared: true, team_id: "t_union" } as any;
    expect(buildPathRestampUpdate(autoShared, mappings, "/Users/a/src/unmapped")).toBeNull();
    expect(buildPathRestampUpdate(bornBlank, mappings, undefined)).toBeNull();
  });

  test("near-miss sibling dir does not match (union-mobile2 is not under union-mobile)", () => {
    expect(buildPathRestampUpdate(bornBlank, mappings, "/Users/a/src/union-mobile2")).toBeNull();
  });

  test("auto-shared conv restamped into a different mapped dir switches teams", () => {
    const autoShared = { is_private: false, auto_shared: true, team_id: "t_union" } as any;
    expect(buildPathRestampUpdate(autoShared, mappings, "/Users/a/src/other")).toEqual({
      team_id: "t_other",
    } as any);
  });

  test("mapping without auto_share stamps the team for routing but stays private", () => {
    expect(buildPathRestampUpdate(bornBlank, mappings, "/Users/a/src/quiet")).toEqual({
      team_id: "t_quiet",
    } as any);
  });

  test("already-correct conv → null (no churn writes)", () => {
    const correct = { is_private: false, auto_shared: true, team_id: "t_union" } as any;
    expect(buildPathRestampUpdate(correct, mappings, "/Users/a/src/union-mobile")).toBeNull();
  });

  test("legacy conv with undefined is_private is treated as default-private and repaired", () => {
    expect(buildPathRestampUpdate({} as any, mappings, "/Users/a/src/union-mobile")).toEqual({
      team_id: "t_union",
      is_private: false,
      auto_shared: true,
    } as any);
  });
});

// Work items inherit a linked conversation's team only when the conversation
// is team-visible. The bug this prevents: tasks.create copied conv.team_id
// unconditionally ("regardless of conversation privacy"), so a task created
// from a PRIVATE session in a team-routed conversation became readable by the
// whole team (canAccessTask gates on team_id alone).
describe("teamVisibleConvTeam — private sessions never hand their team to work items", () => {
  const { teamVisibleConvTeam } = require("./privacy");

  test("THE BUG: a private conversation contributes no team", () => {
    expect(teamVisibleConvTeam({ team_id: "t1", is_private: true })).toBeUndefined();
  });

  test("a shared conversation hands over its team", () => {
    expect(teamVisibleConvTeam({ team_id: "t1", is_private: false })).toBe("t1");
  });

  test("auto_shared counts as team-visible", () => {
    expect(teamVisibleConvTeam({ team_id: "t1", is_private: true, auto_shared: true })).toBe("t1");
  });

  test("a team_visibility override reveals an otherwise-private conversation", () => {
    expect(teamVisibleConvTeam({ team_id: "t1", is_private: true, team_visibility: "summary" })).toBe("t1");
  });

  test("team_visibility:'private' stays private", () => {
    expect(teamVisibleConvTeam({ team_id: "t1", is_private: true, team_visibility: "private" })).toBeUndefined();
  });

  test("no team_id → nothing to hand over, shared or not", () => {
    expect(teamVisibleConvTeam({ is_private: false })).toBeUndefined();
  });

  test("null/undefined conversation → undefined", () => {
    expect(teamVisibleConvTeam(undefined)).toBeUndefined();
    expect(teamVisibleConvTeam(null)).toBeUndefined();
  });
});

// The team-visibility rule exists twice: the async isConversationTeamVisible
// (fetches the owner's membership visibility) and the sync body it delegates
// to (used by createTeamFeedFilter and profileConversationVisible with the
// visibility pre-loaded). The async form now delegates to the sync one; this
// matrix pins the two surfaces to the same answer for every input combination
// so they can never drift apart again.
describe("isConversationTeamVisible — async and sync surfaces agree on the full matrix", () => {
  const teamIds = [undefined, "t1"] as const;
  const isPrivates = [true, false] as const;
  const teamVisibilities = [undefined, "private", "summary", "team"] as const;
  const ownerVisibilities = ["summary", "full", "detailed", "hidden", "activity"] as const;

  for (const teamId of teamIds) {
    for (const isPrivate of isPrivates) {
      for (const teamVisibility of teamVisibilities) {
        for (const ownerVisibility of ownerVisibilities) {
          const label = `team_id=${teamId} is_private=${isPrivate} team_visibility=${teamVisibility} owner=${ownerVisibility}`;
          test(label, async () => {
            const conv = {
              user_id: "u_owner",
              team_id: teamId,
              is_private: isPrivate,
              team_visibility: teamVisibility,
            } as any;
            const ctx = {
              db: makeFakeDb({
                team_memberships: teamId
                  ? [{ _id: "m1", user_id: "u_owner", team_id: teamId, visibility: ownerVisibility }]
                  : [],
              }),
            } as any;
            const asyncAnswer = await isConversationTeamVisible(ctx, conv);
            // profileConversationVisible(false, true, vis, conv) IS the sync rule
            // (a non-owner teammate falls straight through to it).
            const syncAnswer = profileConversationVisible(false, true, ownerVisibility, conv);
            expect(asyncAnswer).toBe(syncAnswer);
          });
        }
      }
    }
  }

  test("owner with NO membership row defaults to 'summary' on both surfaces", async () => {
    const conv = { user_id: "u_owner", team_id: "t1", is_private: false } as any;
    const ctx = { db: makeFakeDb({ team_memberships: [] }) } as any;
    expect(await isConversationTeamVisible(ctx, conv)).toBe(true);
    expect(profileConversationVisible(false, true, "summary", conv)).toBe(true);
  });
});

// Regression for the owner-definition drift: eleven-plus conversations.ts
// endpoints gated on `conversation.user_id === viewer` before falling back to
// team access, while checkConversationAccess also accepts the denormalized
// owner_user_id and a session_owners row. A secondary session owner (assigned,
// not primary, not a teammate) could open a conversation but was denied
// getMoreMessages/export/fork/tree. canOwnerOrTeamAccess is the shared gate
// with the canonical owner definition and no share-token tier.
describe("canOwnerOrTeamAccess — canonical owner definition plus team visibility", () => {
  const CONV = "conversations_1";
  const privateConvRow = {
    _id: CONV,
    user_id: "u_primary",
    is_private: true,
  } as any;

  const ctxWith = (tables: Record<string, any[]>) =>
    ({ db: makeFakeDb({ team_memberships: [], session_owners: [], ...tables }) }) as any;

  test("THE BUG: a session_owners-only user (not primary, not teammate) passes", async () => {
    const ctx = ctxWith({
      session_owners: [{ _id: "so1", conversation_id: CONV, user_id: "u_second", added_at: 1 }],
    });
    expect(await canOwnerOrTeamAccess(ctx, "u_second" as any, privateConvRow)).toBe(true);
  });

  test("the primary owner passes", async () => {
    expect(await canOwnerOrTeamAccess(ctxWith({}), "u_primary" as any, privateConvRow)).toBe(true);
  });

  test("the denormalized owner_user_id holder passes", async () => {
    const conv = { ...privateConvRow, owner_user_id: "u_assigned" };
    expect(await canOwnerOrTeamAccess(ctxWith({}), "u_assigned" as any, conv)).toBe(true);
  });

  test("a stranger is denied", async () => {
    expect(await canOwnerOrTeamAccess(ctxWith({}), "u_stranger" as any, privateConvRow)).toBe(false);
  });

  test("a teammate reaches a SHARED conversation", async () => {
    const shared = { _id: CONV, user_id: "u_primary", team_id: "t1", is_private: false } as any;
    const ctx = ctxWith({
      team_memberships: [
        { _id: "m1", user_id: "u_mate", team_id: "t1" },
        { _id: "m2", user_id: "u_primary", team_id: "t1" },
      ],
    });
    expect(await canOwnerOrTeamAccess(ctx, "u_mate" as any, shared)).toBe(true);
  });

  test("a teammate is denied a PRIVATE conversation (team access follows real visibility)", async () => {
    const routed = { _id: CONV, user_id: "u_primary", team_id: "t1", is_private: true } as any;
    const ctx = ctxWith({
      team_memberships: [
        { _id: "m1", user_id: "u_mate", team_id: "t1" },
        { _id: "m2", user_id: "u_primary", team_id: "t1" },
      ],
    });
    expect(await canOwnerOrTeamAccess(ctx, "u_mate" as any, routed)).toBe(false);
  });

  test("no share-token tier: a minted token grants nothing here", async () => {
    const tokened = { ...privateConvRow, share_token: "tok" };
    expect(await canOwnerOrTeamAccess(ctxWith({}), "u_stranger" as any, tokened)).toBe(false);
  });
});
