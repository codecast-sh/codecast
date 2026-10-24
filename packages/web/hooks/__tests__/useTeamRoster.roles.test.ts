// The roster names a role's bot user as its role (org-staffing.md S30): the
// role rows are the one home for the name and face; the bot user keeps the
// title it was born with, which chat derives its mention handle from.
import { describe, expect, test } from "bun:test";
import { withRoleIdentities, type RosterIdentity } from "../useTeamRoster";
import type { RoleRows } from "../../lib/sessionIdentity";

const BOT = "kd72wjbnhf1exb75acb92rtwzx8gvdva";
const rows: RoleRows = {
  roles: [{ _id: "or1", short_id: "or-59", name: "Cam's Engineering Co-worker", handle: "cam-coworker", avatar: "hare", status: "active", given_name: "Hazel" }],
  anchors: [{ bot_user_id: BOT, org_role_id: "or1" }],
};

describe("withRoleIdentities", () => {
  test("a role's bot user reads as the role's given name and carries its face", () => {
    const list: RosterIdentity[] = [
      { _id: "kd7person", name: "Cam" },
      { _id: BOT, name: "Cam's Engineering Co-worker", is_bot: true },
    ];
    const out = withRoleIdentities(list, rows);
    expect(out[0]).toBe(list[0]);
    expect(out[1].name).toBe("Hazel");
    expect(out[1].role).toMatchObject({ name: "Hazel", handle: "cam-coworker", face: "hare" });
    // The input row (the bot user's own identity) is untouched.
    expect(list[1].name).toBe("Cam's Engineering Co-worker");
  });

  test("a roster with no role bots is returned as the same array", () => {
    const list: RosterIdentity[] = [{ _id: "kd7person", name: "Cam" }, { _id: "kd7slack", name: "Slack", is_bot: true }];
    expect(withRoleIdentities(list, rows)).toBe(list);
    expect(withRoleIdentities(list, null)).toBe(list);
  });
});
