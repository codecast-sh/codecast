import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { listForRepository, recordExternalEvent } from "./externalEvents";

function context(seed: Record<string, any[]> = {}) {
  return {
    auth: { getUserIdentity: async () => ({ subject: "u1|sess" }) },
    db: makeFakeDb({
      users: [{ _id: "u1" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      external_events: [],
      ...seed,
    }),
  } as any;
}

describe("external event repository case", () => {
  test("record stores the canonical spelling and listForRepository finds it whatever case is asked", async () => {
    const ctx = context();
    await recordExternalEvent(ctx, {
      team_id: "team_1" as any, source: "github", repository: "Codecast-SH/Codecast", kind: "pr_opened",
      title: "t", dedupe_key: "d1", created_at: 1,
    });
    expect(ctx.db._tables.external_events[0].repository).toBe("codecast-sh/codecast");
    const rows = await (listForRepository as any)._handler(ctx, { repository: "CODECAST-SH/CODECAST" });
    expect(rows.map((r: any) => r.dedupe_key)).toEqual(["d1"]);
  });
});
