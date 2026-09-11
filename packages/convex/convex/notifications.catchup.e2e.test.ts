import { expect, test } from "bun:test";
import * as notifications from "./notifications";
import { makeFakeDb } from "./testDb";

const context = (user: string | null) => ({
  auth: { getUserIdentity: async () => user ? { subject: `${user}|session` } : null },
  db: makeFakeDb({
    users: [{ _id: "owner" }, { _id: "other" }],
    team_memberships: [],
    push_ring: [
      { _id: "p1", user_id: "owner", workspace: "user:owner", epoch: "epoch", seq: 1, key: "epoch.1", title: "First", body: "", data: {}, created_at: 1 },
      { _id: "p2", user_id: "owner", workspace: "user:owner", epoch: "epoch", seq: 2, key: "epoch.2", title: "Second", body: "", data: {}, created_at: 2 },
      { _id: "p3", user_id: "owner", workspace: "team:departed", epoch: "epoch", seq: 3, key: "epoch.3", title: "Hidden", body: "", data: {}, created_at: 3 },
      { _id: "p4", user_id: "other", workspace: "user:other", epoch: "epoch", seq: 4, key: "epoch.4", title: "Other", body: "", data: {}, created_at: 4 },
    ],
  }),
});

test("mobile catch-up authenticates and honors the current workspace access", async () => {
  const query = (notifications as any).getMissedSince;
  expect(query).toBeDefined();
  expect(await query._handler(context(null), { seq: 0 })).toEqual({ epoch: null, entries: [] });
  const result = await query._handler(context("owner"), { seq: 1, epoch: "epoch" });
  expect(result.epoch).toBe("epoch");
  expect(result.entries.map((row: any) => row.key)).toEqual(["epoch.2"]);
  const reset = await query._handler(context("owner"), { seq: 100, epoch: "old" });
  expect(reset.entries.map((row: any) => row.key)).toEqual(["epoch.1", "epoch.2"]);
});
