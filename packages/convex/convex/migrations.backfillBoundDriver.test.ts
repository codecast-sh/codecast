import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { backfillBoundDriverPage } from "./lib/boundDriverBackfill";

// ownerMigrations:backfillBoundDriver: a person's session a task binding filed
// under a role before driver_user_id existed gets its person as driver, the
// rule applyHoldChange writes for a new binding.

const ME = "users_me";
const MATE = "users_mate";
const BOT = "users_bot";
const ROLE = "org_roles_growth";

const conv = (id: string, over: Record<string, any> = {}) => ({
  _id: `conversations_${id}`, short_id: id, user_id: ME, status: "active", message_count: 3, updated_at: 1, _creationTime: 1,
  org_role_id: ROLE, org_role_hold: "bound", active_task_id: "tasks_1", ...over,
});

function fixtures() {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me" }, { _id: MATE, name: "Mate" }, { _id: BOT, name: "Pool", is_bot: true }],
    org_roles: [{ _id: ROLE, handle: "growth", name: "Growth lead", status: "active" }],
    conversations: [
      conv("bound"),
      conv("authored", { user_id: BOT, author_user_id: ME }),
      conv("stamped", { driver_user_id: MATE }),
      conv("filed", { org_role_hold: "filed" }),
      conv("role_hand", { role_started: true }),
      conv("standing", { standing_role_id: ROLE, anchor_id: "anchors_growth" }),
      conv("unbound", { active_task_id: undefined }),
      conv("bot_run", { user_id: BOT }),
      // Its starter left it to a teammate: the teammate's row, not the starter, owns it.
      conv("left", {}),
    ],
    session_owners: [{ _id: "so1", conversation_id: "conversations_left", user_id: MATE, added_by: ME, added_at: 2 }],
    session_decisions: [],
    messages: [],
  });
}

describe("backfillBoundDriver", () => {
  test("a dry run names each bound session its person drives and writes nothing", async () => {
    const db = fixtures();
    const res = await backfillBoundDriverPage({ db } as any, {});
    expect(res.dryRun).toBe(true);
    expect(res.rows.map((r) => [r.session, r.driver]).sort()).toEqual([["authored", ME], ["bound", ME]]);
    expect(res.next).toBeNull();
    expect((await db.get("conversations_bound" as any)).driver_user_id).toBeUndefined();
  });

  test("a real run stamps the starter; filed, role-started, standing, unbound, bot-run and left sessions stay", async () => {
    const db = fixtures();
    await backfillBoundDriverPage({ db } as any, { dryRun: false });
    expect((await db.get("conversations_bound" as any)).driver_user_id).toBe(ME);
    expect((await db.get("conversations_authored" as any)).driver_user_id).toBe(ME);
    expect((await db.get("conversations_stamped" as any)).driver_user_id).toBe(MATE);
    for (const id of ["filed", "role_hand", "standing", "unbound", "bot_run", "left"]) {
      expect((await db.get(`conversations_${id}` as any)).driver_user_id).toBeUndefined();
    }
  });
});
