import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performListRecentSessions } from "./conversations";

// The command palette builds its list from TWO row sources: favorites carry
// whole store rows (so inbox_killed_at arrives) while recents come from this
// projection. Omitting the marker here left it permanently undefined on half
// the palette's rows, so killed-awareness silently could not work for them —
// the same class of gap as /sessions dropping killed rows entirely.

const USER = "u".repeat(31) + "a";

function fixtures(convs: Array<Record<string, any>>) {
  return makeFakeDb({
    users: [{ _id: USER, name: "Jason" }],
    conversations: convs.map((c) => ({
      user_id: USER,
      status: "active",
      updated_at: Date.now(),
      ...c,
    })),
  });
}

describe("listRecentSessions projects the killed marker", () => {
  test("a killed session carries inbox_killed_at", async () => {
    const db = fixtures([
      { _id: "conv_killed", title: "Retired", inbox_killed_at: 111 },
    ]);
    const rows = await performListRecentSessions({ db } as any, USER as any);
    expect(rows).toHaveLength(1);
    expect(rows[0].inbox_killed_at).toBe(111);
  });

  test("a live session reports the marker as undefined, not a stale value", async () => {
    const db = fixtures([{ _id: "conv_live", title: "Working" }]);
    const rows = await performListRecentSessions({ db } as any, USER as any);
    expect(rows[0].inbox_killed_at).toBeUndefined();
  });

  // Both palette sources must agree, which is the whole point of the projection.
  test("killed and live rows are distinguishable in one result set", async () => {
    const db = fixtures([
      { _id: "conv_killed", title: "Retired", inbox_killed_at: 111 },
      { _id: "conv_live", title: "Working" },
    ]);
    const rows = await performListRecentSessions({ db } as any, USER as any);
    const killed = rows.filter((r: any) => r.inbox_killed_at);
    expect(killed).toHaveLength(1);
    expect(killed[0].title).toBe("Retired");
  });
});
