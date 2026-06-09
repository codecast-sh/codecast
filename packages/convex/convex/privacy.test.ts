import { describe, expect, test } from "bun:test";
import { profileConversationVisible } from "./privacy";

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
