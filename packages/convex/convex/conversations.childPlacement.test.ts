import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { collectInboxSessionsPaginated, classifyWorkStates } from "./conversations";
import { cliSessionClassifier } from "./cliSessionClassifier";
import { deriveLiveAt, inboxEpoch } from "@codecast/shared/contracts";
import { placeProjectableRow } from "@codecast/shared/contracts/inboxPlacement";
import { makeFakeDb } from "./testDb";

// A subagent child row is built by buildSubagentChildRow, not the top-level
// enrichment. The server and `cast sessions` place the child from its
// conversation doc and the web from that row, so the row must carry every
// fact placement reads (PLACEMENT_ROW_FIELDS), or the two file it apart.

const ME = "users_me";
const H = 3_600_000;
const NOW = 1_800_000_000_000 + 25_000;
const EPOCH = inboxEpoch(NOW);

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => { nowSpy = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { nowSpy.mockRestore(); });

function world(child: Record<string, unknown>) {
  const live = { status: "active", updated_at: EPOCH - 3 * H, started_at: EPOCH - 4 * H, message_count: 30, last_message_role: "assistant" };
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@example.com" }],
    conversations: [
      { _id: "conversations_p", user_id: ME, title: "Lead", ...live, updated_at: EPOCH - 60_000 },
      { _id: "conversations_c", user_id: ME, title: "Child", is_subagent: true, parent_conversation_id: "conversations_p", ...live, ...child },
    ],
    messages: [], managed_sessions: [], session_decisions: [], session_owners: [],
  });
}

describe("a subagent child places the same from its doc and from its row", () => {
  test.each([
    ["a fresh dormant pin on a blocker, no daemon", { thread_state_status: "dormant", thread_state_at: EPOCH - 3 * H, last_turn_at: EPOCH - 3 * H - 60_000, parked_wake_kind: "blocker" }, "dormant"],
    ["a done pin older than its latest turn", { thread_state_status: "done", thread_state_at: EPOCH - 4 * H, last_turn_at: EPOCH - 3 * H }, "needs_input"],
  ])("%s", async (_name, child, want) => {
    const db = world(child);
    const floor = await collectInboxSessionsPaginated({ db }, ME as any, { paginationOpts: { numItems: 10, cursor: null } });
    const row = floor.page.find((r: any) => String(r._id) === "conversations_c");
    expect(row).toBeDefined();
    const replica = placeProjectableRow({ ...row, ...deriveLiveAt(row, NOW) }, false, NOW).work_state;
    const doc = await db.get("conversations_c");
    const server = (await classifyWorkStates({ db }, ME as any, [doc], new Map(), NOW)).get("conversations_c");
    const cli = (await cliSessionClassifier({ db }, NOW).classify(doc)).work_state;
    expect({ replica, server, cli }).toEqual({ replica: want, server: want, cli: want });
  });
});
