import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { peopleFor } from "./sessionDecisions";

// Who a session's decision asks besides the role's ladder (peopleFor). A
// session a role started, while a role still holds it, has no implicit person:
// its runner may be a pool machine's account. Released (a retire, a
// visibility drop clears org_role_id), it is its runner's again.

const RUNNER = "users_runner";
const LEAD = "users_lead";

const db = () => makeFakeDb({ users: [{ _id: RUNNER, name: "Runner" }, { _id: LEAD, name: "Lead" }], session_owners: [] });
const hand = (over: Record<string, any> = {}) => ({ _id: "conversations_hand", user_id: RUNNER, role_started: true, org_role_id: "org_roles_r", ...over });

describe("peopleFor a session a role started", () => {
  test("while a role holds it, its runner is not asked; the line's person is", async () => {
    expect(await peopleFor({ db: db() } as any, hand(), LEAD as any)).toEqual([LEAD]);
  });

  test("released from its role, it asks its runner again", async () => {
    expect(await peopleFor({ db: db() } as any, hand({ org_role_id: undefined }))).toEqual([RUNNER]);
  });

  test("a person's own session filed under a role asks its runner", async () => {
    expect(await peopleFor({ db: db() } as any, hand({ role_started: undefined }), LEAD as any)).toEqual([RUNNER, LEAD]);
  });
});
