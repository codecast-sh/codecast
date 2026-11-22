import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { cliSessionClassifier } from "./cliSessionClassifier";

// The CLI feed (`cast feed`, `cast sessions --team`) reads what a person reads
// (shared personWorkState): a session its role drives that waits is working,
// as the inbox files it; a paused role's session waits on its person.

const NOW = 1_800_000_000_000;
const settled = (over: Record<string, any> = {}) => ({
  _id: "conversations_a", user_id: "users_me", status: "active", message_count: 6,
  updated_at: NOW - 3_600_000, last_message_role: "assistant", ...over,
});

describe("the CLI feed classifier and a role that drives", () => {
  const classify = (conv: any) => cliSessionClassifier({ db: makeFakeDb({ managed_sessions: [], messages: [], agent_tasks: [], conversations: [conv] }) }, NOW).classify(conv);

  test("a waiting session its role drives reads as working; a paused role's or a plain one reads needs input", async () => {
    expect((await classify(settled({ org_role_id: "org_roles_r" }))).work_state).toBe("working");
    expect((await classify(settled({ org_role_id: "org_roles_r", driver_user_id: "users_me" }))).work_state).toBe("needs_input");
    expect((await classify(settled())).work_state).toBe("needs_input");
  });
});
