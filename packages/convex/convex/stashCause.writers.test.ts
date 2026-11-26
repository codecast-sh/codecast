import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { stashCauseOf, wakeHideFields } from "@codecast/shared/contracts";
import { completeTaskRun, linkRunConversation } from "./agentTasks";
import { daemonForkFields } from "./conversations";
import { applyPatches } from "./dispatch";
import { overlayViewerTriage } from "./lib/viewerTriage";
import { hashToken } from "./apiTokens";
import { makeFakeDb } from "./testDb";

// ct-101902: every write of the stash stamp says who or what set it
// (inbox_stash_cause, contracts/stashCause), and every clear takes the cause
// with it, so a row never carries a cause without a stamp or a stale one.

const NOW = 1_800_000_000_000;
const USER = "users_owner";
const RUN = "conversations_run";
const RUN_UUID = "run-uuid-1";
const TOKEN = "stash-cause-test-token";
const DAEMON = "laptop-daemon";

let time: ReturnType<typeof spyOn>;
beforeEach(() => { time = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { time.mockRestore(); });

async function world(task: Record<string, any>, conversations: any[]) {
  const tables: Record<string, any[]> = {
    agent_tasks: [{
      _id: "agent_tasks_t", _creationTime: 1, user_id: USER, short_id: "tr-1", title: "Sweep", prompt: "Sweep.",
      schedule_type: "once", status: "running", lease_holder: DAEMON, lease_expires_at: NOW + 60_000, run_at: NOW - 1,
      run_count: 0, retry_count: 0, max_retries: 3, mode: "apply", created_at: 1, ...task,
    }],
    conversations,
    devices: [],
    api_tokens: [{ _id: "api_tokens_owner", user_id: USER, token_hash: await hashToken(TOKEN) }],
    pending_messages: [],
  };
  return { ctx: { db: makeFakeDb(tables), scheduler: { runAfter: async () => {} } } as any, tables };
}
const conv = (tables: Record<string, any[]>, id: string) => tables.conversations.find((c) => c._id === id);

describe("each writer records its cause", () => {
  test("a daemon fork born stashed says the fork set it; one that inherits its origin's stash inherits its cause", () => {
    expect(daemonForkFields({ _id: "conv_o" } as any, { at_uuid: "a", copied: 1 }, NOW)).toMatchObject({ inbox_stashed_at: NOW, inbox_stash_cause: "fork" });
    const inherited = daemonForkFields({ _id: "conv_o", inbox_stashed_at: 5, inbox_stash_cause: "person" } as any, { at_uuid: "a", copied: 1 }, NOW);
    expect(inherited).toMatchObject({ inbox_stashed_at: 5, inbox_stash_cause: "person" });
    const legacy = daemonForkFields({ _id: "conv_o", inbox_stashed_at: 5 } as any, { at_uuid: "a", copied: 1 }, NOW) as Record<string, unknown>;
    expect(legacy.inbox_stash_cause).toBeUndefined();
  });

  test("a finished trigger run folded out of the way says so", async () => {
    // A once run with no session to report to posts nowhere new; a recurring
    // one with no parent is the repeating writer. A once run whose report is
    // posted to its owner is folded.
    const { ctx, tables } = await world({ created_by_conversation_id: "conversations_owner" }, [
      { _id: "conversations_owner", user_id: USER, session_id: "owner", status: "active", owner_device_id: "laptop" },
      { _id: RUN, _creationTime: NOW - 1000, user_id: USER, session_id: RUN_UUID, status: "active", agent_task_id: "agent_tasks_t" },
    ]);
    await (completeTaskRun as any)._handler(ctx, { api_token: TOKEN, task_id: "agent_tasks_t", summary: "Done.", run_session_uuid: RUN_UUID });
    expect(conv(tables, RUN)).toMatchObject({ inbox_stashed_at: NOW, inbox_stash_cause: "run_folded" });
  });

  test("a repeating run with nothing to nest under is stashed as one", async () => {
    const { ctx, tables } = await world({ schedule_type: "recurring", interval_ms: 3_600_000, created_by_conversation_id: undefined }, [
      { _id: RUN, user_id: USER, session_id: RUN_UUID, status: "active" },
    ]);
    await (completeTaskRun as any)._handler(ctx, { api_token: TOKEN, task_id: "agent_tasks_t", summary: "Nothing.", run_session_uuid: RUN_UUID });
    expect(conv(tables, RUN)).toMatchObject({ inbox_stashed_at: NOW, inbox_stash_cause: "run_repeating" });
  });

  test("the previous run of a repeating trigger is set aside as an earlier run", async () => {
    const { ctx, tables } = await world(
      { schedule_type: "recurring", interval_ms: 3_600_000, created_by_conversation_id: undefined, last_run_conversation_id: "conversations_prev" },
      [
        { _id: "conversations_prev", user_id: USER, session_id: "prev-uuid", status: "completed", parent_conversation_id: "conversations_x" },
        { _id: RUN, user_id: USER, session_id: RUN_UUID, status: "active", parent_conversation_id: "conversations_x" },
      ],
    );
    await (linkRunConversation as any)._handler(ctx, { api_token: TOKEN, task_id: "agent_tasks_t", run_session_uuid: RUN_UUID });
    expect(conv(tables, "conversations_prev")).toMatchObject({ inbox_stashed_at: NOW, inbox_stash_cause: "run_superseded" });
  });

  test("a closed session a trigger wakes is stashed by the wake, and a send that clears a stash clears its cause", () => {
    const closed = { inbox_dismissed_at: 10, inbox_closed_at: 10, standing_role_id: "roles_r" } as any;
    const woke = wakeHideFields(closed, { machine: true, now: NOW });
    expect(woke).toMatchObject({ inbox_stashed_at: NOW, inbox_stash_cause: "close_wake" });
    const sent = wakeHideFields({ inbox_stashed_at: 10, inbox_stash_cause: "fork" } as any, { machine: false, now: NOW });
    expect(sent).toHaveProperty("inbox_stash_cause", undefined);
    expect(sent).toHaveProperty("inbox_stashed_at", undefined);
  });
});

describe("the person's own stash", () => {
  const CONV = "conversations_c";
  const rows = (extra: Record<string, any> = {}) => makeFakeDb({
    conversations: [{ _id: CONV, user_id: USER, session_id: "s", status: "active", ...extra }],
    session_owners: [], session_viewer_triage: [], sync_actions: [], pending_messages: [], agent_tasks: [], inbox_hides: [],
  });

  test("a stash on the web or phone rail says the person set it, and re-stashing a system stash overwrites the cause", async () => {
    const db = rows({ inbox_stashed_at: 5, inbox_stash_cause: "fork" });
    await applyPatches({ db } as any, USER as any, { conversations: { [CONV]: { inbox_stashed_at: 111 } } });
    expect(db._tables.conversations[0]).toMatchObject({ inbox_stashed_at: 111, inbox_stash_cause: "person" });
  });

  test("a restore on that rail clears the cause with the stamp", async () => {
    const db = rows({ inbox_stashed_at: 5, inbox_stash_cause: "run_folded" });
    await applyPatches({ db } as any, USER as any, { conversations: { [CONV]: { inbox_stashed_at: null } } });
    expect(db._tables.conversations[0].inbox_stashed_at).toBeUndefined();
    expect(db._tables.conversations[0].inbox_stash_cause).toBeUndefined();
  });

  test("a team session's stash is this viewer's own triage, so it reads as theirs", () => {
    const row: any = { inbox_stash_cause: "fork" };
    overlayViewerTriage(row, { inbox_stashed_at: 9 });
    expect(row.inbox_stash_cause).toBe("person");
    overlayViewerTriage(row, {});
    expect(row.inbox_stash_cause).toBeNull();
  });
});

describe("reading a cause", () => {
  test("a cause counts only while the stamp is set, and a stash from before causes names none", () => {
    expect(stashCauseOf({ inbox_stashed_at: 1, inbox_stash_cause: "fork" })?.word).toBe("Forked");
    expect(stashCauseOf({ inbox_stashed_at: null, inbox_stash_cause: "fork" })).toBeNull();
    expect(stashCauseOf({ inbox_stashed_at: 1 })).toBeNull();
    expect(stashCauseOf({ inbox_stashed_at: 1, inbox_stash_cause: "from_the_future" })).toBeNull();
  });
});
