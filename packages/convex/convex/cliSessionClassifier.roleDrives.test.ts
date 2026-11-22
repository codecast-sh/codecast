import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { cliSessionClassifier } from "./cliSessionClassifier";

// The CLI feed (`cast feed`, `cast sessions --team`) keeps the RAW work state,
// so a watcher (`--until`, `-w`, `--state needs_input`) sees a role's wait as
// waiting, and names the role it waits on (with_role, as inboxForCLI does): the
// person's view lists it as working. A paused role's session names no role.

const NOW = 1_800_000_000_000;
const settled = (over: Record<string, any> = {}) => ({
  _id: "conversations_a", user_id: "users_me", status: "active", message_count: 6,
  updated_at: NOW - 3_600_000, last_message_role: "assistant", ...over,
});

describe("the CLI feed classifier and a role that drives", () => {
  const rowFields = (conv: any) => cliSessionClassifier({
    db: makeFakeDb({ managed_sessions: [], messages: [], agent_tasks: [], conversations: [conv], org_roles: [{ _id: "org_roles_r", handle: "growth", name: "Growth lead" }] }),
  }, NOW).rowFields(conv);

  test("a waiting session its role drives stays needs_input and names its role", async () => {
    expect(await rowFields(settled({ org_role_id: "org_roles_r" }))).toMatchObject({ work_state: "needs_input", with_role: "growth" });
  });

  test("a paused role's session and a plain one name no role", async () => {
    for (const conv of [settled({ org_role_id: "org_roles_r", driver_user_id: "users_me" }), settled()]) {
      const row = await rowFields(conv);
      expect(row.work_state).toBe("needs_input");
      expect("with_role" in row).toBe(false);
    }
  });
});
