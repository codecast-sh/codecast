import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { pinForResume } from "./accountSwitch";

// The pin a daemon sources on resume. A teammate who can read a team visible
// session gets an answer for their own device, but only the session's runner
// rewrites the stored pin.

const TEAM = "teams_acme";
const ANA = "users_ana"; // runs the session
const BEN = "users_ben"; // teammate
const EVE = "users_eve"; // outsider

function world() {
  return makeFakeDb({
    users: [{ _id: ANA }, { _id: BEN }, { _id: EVE }],
    team_memberships: [
      { _id: "m1", user_id: ANA, team_id: TEAM, role: "member", visibility: "full" },
      { _id: "m2", user_id: BEN, team_id: TEAM, role: "member", visibility: "full" },
    ],
    session_owners: [],
    devices: [],
    conversations: [
      { _id: "conv_1", user_id: ANA, team_id: TEAM, is_private: false, cc_account: "work", cc_account_auto: true, status: "active" },
    ],
  });
}

const as = (db: any, userId: string) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${userId}|sess`, tokenIdentifier: "x" }) } });
const call = (db: any, userId: string) => (pinForResume as any)._handler(as(db, userId), { conversation_id: "conv_1", device_id: "dev-x" });

describe("accountSwitch.pinForResume", () => {
  test("a teammate's read does not rewrite the runner's pin", async () => {
    const db = world();
    const r = await call(db, BEN);
    expect(r).not.toBeNull();
    expect(db._tables.conversations[0].cc_account).toBe("work");
    expect(db._patched.length).toBe(0);
  });

  test("an outsider gets nothing", async () => {
    const db = world();
    expect(await call(db, EVE)).toBeNull();
    expect(db._patched.length).toBe(0);
  });

  test("the runner's resume still corrects the stored pin", async () => {
    const db = world();
    const r = await call(db, ANA);
    expect(r).toEqual({ cc_account: null });
    expect(db._patched.length).toBe(1);
    expect(db._tables.conversations[0].cc_account).toBeUndefined();
  });
});
