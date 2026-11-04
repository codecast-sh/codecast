// The inbox's first run: the card shows only once an empty cache is known to
// be the truth, and an unsent composer stub is not a conversation.
import { describe, expect, test } from "bun:test";
import { inboxCrawlWsKey } from "../../hooks/useSyncInboxSessions";
import { syncMetaKey } from "../../hooks/reconcileCrawl";
import { firstRun } from "../firstRun";

const REAL_ID = "k".repeat(32);
const floor = { [syncMetaKey("sessions", inboxCrawlWsKey("u_me"))]: { backfilledAt: 1 } };
const base = { currentUser: { _id: "u_me" }, sessions: {}, pendingSessionCreates: {}, syncMeta: floor };

describe("firstRun", () => {
  test("unknown until the user doc has synced", () => {
    expect(firstRun({ ...base, currentUser: undefined })).toBe("unknown");
  });

  test("a machine that has ever checked in ends it", () => {
    expect(firstRun({ ...base, currentUser: { _id: "u_me", cli_version: "1.2.0" } })).toBe("no");
  });

  test("an empty cold cache is unknown until the sessions floor is cut", () => {
    expect(firstRun({ ...base, syncMeta: {} })).toBe("unknown");
    expect(firstRun(base)).toBe("yes");
  });

  test("another account's floor does not stand in", () => {
    expect(firstRun({ ...base, currentUser: { _id: "u_other" } })).toBe("unknown");
  });

  test("a conversation ends it, floor or no floor", () => {
    expect(firstRun({ ...base, syncMeta: {}, sessions: { [REAL_ID]: {} } })).toBe("no");
  });

  test("a composer's unsent stub is not a conversation; one being created is", () => {
    const sessions = { "stub-1": {} };
    expect(firstRun({ ...base, sessions })).toBe("yes");
    expect(firstRun({ ...base, sessions, pendingSessionCreates: { "stub-1": Promise.resolve(REAL_ID) } })).toBe("no");
  });
});
