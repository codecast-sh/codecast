import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { backfillMovedStarterRowsPage } from "./lib/starterRowBackfill";

// migrations:backfillMovedStarterRows: a person's session that moved to
// another account before a move wrote the starter's row gets that row.

const ME = "users_me";
const MATE = "users_mate";
const BOT = "users_bot";

const conv = (id: string, over: Record<string, any> = {}) => ({ _id: `conversations_${id}`, short_id: id, user_id: MATE, author_user_id: ME, status: "active", updated_at: 1, ...over });

function fixtures() {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me" }, { _id: MATE, name: "Mate" }, { _id: BOT, name: "Box", is_bot: true }],
    conversations: [
      conv("moved"),
      conv("onto_box", { user_id: BOT }),
      conv("has_rows"),
      conv("role_run", { org_role_id: "org_roles_1", role_started: true }),
      conv("bot_started", { author_user_id: BOT }),
      conv("never_moved", { user_id: ME }),
      conv("no_author", { author_user_id: undefined }),
    ],
    session_owners: [{ _id: "o1", conversation_id: "conversations_has_rows", user_id: MATE, added_by: MATE, added_at: 1 }],
  });
}

const rowsOf = (db: any, id: string) => db._tables.session_owners.filter((r: any) => r.conversation_id === `conversations_${id}`).map((r: any) => r.user_id);

describe("backfillMovedStarterRows", () => {
  test("a dry run names each moved person's session with no rows and writes nothing", async () => {
    const db = fixtures();
    const res = await backfillMovedStarterRowsPage({ db } as any, {});
    expect(res.rows.map((r) => r.session).sort()).toEqual(["moved", "onto_box"]);
    expect(res.next).toBeNull();
    expect(db._tables.session_owners).toHaveLength(1);
  });

  test("a real run writes the starter's row; sessions with rows, role runs, agent starts and unmoved sessions are left alone", async () => {
    const db = fixtures();
    await backfillMovedStarterRowsPage({ db } as any, { dryRun: false });
    expect(rowsOf(db, "moved")).toEqual([ME]);
    expect(rowsOf(db, "onto_box")).toEqual([ME]);
    expect(rowsOf(db, "has_rows")).toEqual([MATE]);
    for (const id of ["role_run", "bot_started", "never_moved", "no_author"]) expect(rowsOf(db, id)).toEqual([]);
    expect(db._tables.conversations.find((c: any) => c._id === "conversations_moved").owner_user_id).toBe(ME);
  });
});
