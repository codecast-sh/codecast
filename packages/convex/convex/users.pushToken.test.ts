import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { clearPushToken, storePushToken } from "./users";

// A push token names a phone. Signing out must stop that account pushing to
// it, and a phone that signs into a second account must stop receiving the
// first account's notifications.

const A = "users_a";
const B = "users_b";
const ctx = (db: any, user: string | null) => ({
  db,
  auth: { getUserIdentity: async () => (user ? { subject: `${user}|session` } : null) },
});
const seed = () => makeFakeDb({
  users: [
    { _id: A, push_token: "tok-phone", notifications_enabled: true, notification_preferences: {} },
    { _id: B, notifications_enabled: true, notification_preferences: {} },
  ],
});
const tokenOf = (db: any, id: string) => db._tables.users.find((u: any) => u._id === id).push_token;

describe("clearPushToken", () => {
  test("clears the caller's token when it matches", async () => {
    const db = seed();
    expect(await (clearPushToken as any)._handler(ctx(db, A), { push_token: "tok-phone" })).toEqual({ cleared: true });
    expect(tokenOf(db, A)).toBeUndefined();
  });

  test("leaves a token another device registered since", async () => {
    const db = seed();
    expect(await (clearPushToken as any)._handler(ctx(db, A), { push_token: "tok-old" })).toEqual({ cleared: false });
    expect(tokenOf(db, A)).toBe("tok-phone");
  });

  test("cannot clear another user's token", async () => {
    const db = seed();
    expect(await (clearPushToken as any)._handler(ctx(db, B), { push_token: "tok-phone" })).toEqual({ cleared: false });
    expect(tokenOf(db, A)).toBe("tok-phone");
  });

  test("refuses a signed-out caller", async () => {
    await expect((clearPushToken as any)._handler(ctx(seed(), null), { push_token: "tok-phone" })).rejects.toThrow("Not authenticated");
  });
});

describe("storePushToken", () => {
  test("takes the token off the account that held it", async () => {
    const db = seed();
    await (storePushToken as any)._handler(ctx(db, B), { push_token: "tok-phone" });
    expect(tokenOf(db, B)).toBe("tok-phone");
    expect(tokenOf(db, A)).toBeUndefined();
  });

  test("re-registering the same account keeps its token", async () => {
    const db = seed();
    await (storePushToken as any)._handler(ctx(db, A), { push_token: "tok-phone" });
    expect(tokenOf(db, A)).toBe("tok-phone");
  });
});
