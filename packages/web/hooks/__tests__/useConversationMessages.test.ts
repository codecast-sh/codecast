import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeUnconfirmedMessages, messagePageSyncKey } from "../useConversationMessages";

const message = (content: string) => ({
  _id: "message-1",
  message_uuid: "stream-1",
  role: "assistant",
  content,
  timestamp: 1,
});

describe("messagePageSyncKey", () => {
  it("changes as a same-id streaming message grows and finalizes", () => {
    const partial = messagePageSyncKey("conversation-1", [message("Half a reply")]);
    const grown = messagePageSyncKey("conversation-1", [message("Half a reply, now complete.")]);

    expect(grown).not.toBe(partial);
  });

  it("stays stable for an unchanged page", () => {
    const first = messagePageSyncKey("conversation-1", [message("Complete reply")]);
    const cloned = messagePageSyncKey("conversation-1", [{ ...message("Complete reply") }]);

    expect(cloned).toBe(first);
  });
});

describe("history jumps are one-shot fetches", () => {
  const src = readFileSync(join(import.meta.dir, "../useConversationMessages.ts"), "utf8");

  it("jumpToStart calls fetchMessagesAround instead of subscribing", () => {
    const at = src.indexOf("const jumpToStart = useCallback");
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf("const jumpToEnd = useCallback", at));
    expect(fn).toContain("fetchMessagesAround");
    expect(fn).not.toContain("useQuery");
  });

  it("the around useQuery is bookmark/deeplink only, not jumpTimestamp", () => {
    const at = src.indexOf("const aroundData = useQuery(");
    expect(at).toBeGreaterThan(-1);
    const args = src.slice(at, src.indexOf(");", at) + 2);
    expect(args).toContain("jumpMode === null");
    expect(args).not.toContain("jumpTimestamp !== null");
  });
});

describe("mergeUnconfirmedMessages", () => {
  const confirmed = (id: string, timestamp: number, clientId?: string) =>
    ({ _id: id, role: "user", content: id, timestamp, ...(clientId ? { client_id: clientId } : {}) }) as any;
  const pending = (id: string, timestamp: number, extra: Record<string, unknown> = {}) =>
    ({ _id: id, role: "user", content: id, timestamp, _clientId: id, _isQueued: true, ...extra }) as any;

  it("keeps every unconfirmed row after every confirmed row, whatever the clocks say", () => {
    // "testing" was sent at t=100, and the second line at t=200. The agent
    // picked the paste up late, so the transcript echoed "testing" at t=300,
    // after the second line left this window. The second line is still
    // unconfirmed: the session has not read it, so it cannot precede a row
    // the session has read.
    const server = [confirmed("older", 10), confirmed("testing", 300)];
    const queue = [pending("second-line", 200)];
    expect(mergeUnconfirmedMessages(server, queue).map((m) => m._id)).toEqual(["older", "testing", "second-line"]);
  });

  it("orders the unconfirmed tail by send time", () => {
    const server = [confirmed("a", 10)];
    const queue = [pending("late", 30), pending("early", 20)];
    expect(mergeUnconfirmedMessages(server, queue).map((m) => m._id)).toEqual(["a", "early", "late"]);
  });

  it("drops pending rows the server already echoed and the local queue", () => {
    const server = [confirmed("a", 10), confirmed("srv-b", 20, "b")];
    const queue = [pending("b", 15), pending("a", 5), pending("q", 30, { _isLocalQueue: true }), pending("c", 40)];
    expect(mergeUnconfirmedMessages(server, queue).map((m) => m._id)).toEqual(["a", "srv-b", "c"]);
  });

  it("returns the same server ref when nothing is pending", () => {
    const server = [confirmed("a", 10)];
    expect(mergeUnconfirmedMessages(server, [])).toBe(server);
    expect(mergeUnconfirmedMessages(server, [pending("a", 5)])).toBe(server);
  });
});
