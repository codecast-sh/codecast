import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { REHEARSAL_RESULT_MAX, report } from "./moveRehearsals";

const ME = "users_me";
function world() {
  const db = makeFakeDb({
    users: [{ _id: ME }],
    move_rehearsals: [{ _id: "mr_1", user_id: ME, request_id: "r1", session_id: "s1", destination_id: "d1", status: "pending", created_at: 1 }],
  });
  return { db, ctx: { db, auth: { getUserIdentity: async () => ({ subject: `${ME}|sess`, tokenIdentifier: "x" }) } } as any };
}
const send = (w: any, result: string) => (report as any)._handler(w.ctx, { rehearsal_id: "mr_1", result });

describe("moveRehearsals.report", () => {
  test("a result over the limit fails with a reason instead of being cut mid JSON", async () => {
    const w = world();
    await send(w, JSON.stringify({ session_id: "s1", destination_id: "d1", pad: "x".repeat(REHEARSAL_RESULT_MAX) }));
    const row = w.db._tables.move_rehearsals[0];
    expect(row.status).toBe("failed");
    expect(row.result).toBeUndefined();
    expect(row.error).toMatch(/too large/);
  });

  test("a result inside the limit is kept whole", async () => {
    const w = world();
    const result = JSON.stringify({ session_id: "s1", destination_id: "d1" });
    await send(w, result);
    expect(w.db._tables.move_rehearsals[0]).toMatchObject({ status: "done", result });
  });
});
