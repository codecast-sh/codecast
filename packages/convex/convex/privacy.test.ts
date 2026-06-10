import { describe, expect, test } from "bun:test";
import { profileConversationVisible, buildShareUpdate } from "./privacy";

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
