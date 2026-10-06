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

  it("the around subscription is bookmark/deeplink only, not jumpTimestamp", () => {
    const at = src.indexOf("const aroundData = useQueryNoThrow(");
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

  describe("an approval's answer in a hosted conversation", () => {
    // The hosted turn consumes the answer and writes no transcript row, so
    // the bubble never meets an echo.
    const answer = (id: string, timestamp: number, sentBaselineTs: number) =>
      pending(id, timestamp, { content: `Decision: Approve\n<cast-decision id="${id}" question="Send it?"/>`, _sentBaselineTs: sentBaselineTs });
    const server = [confirmed("asked", 100), confirmed("result", 300), confirmed("done", 400)];

    it("sits where the card was, not below what came after it", () => {
      const merged = mergeUnconfirmedMessages(server, [answer("d1", 250, 200), pending("typed", 500)], true);
      expect(merged.map((m) => m._id)).toEqual(["asked", "d1", "result", "done", "typed"]);
    });

    it("keeps two answers given together in the order they were given", () => {
      const merged = mergeUnconfirmedMessages(server, [answer("d2", 260, 200), answer("d1", 250, 200)], true);
      expect(merged.map((m) => m._id)).toEqual(["asked", "d1", "d2", "result", "done"]);
    });

    it("waits for the transcript once the server has taken it, rather than standing alone", () => {
      const taken = { ...answer("d1", 250, 200), _isSettled: true, _isQueued: undefined };
      expect(mergeUnconfirmedMessages([], [taken], true)).toEqual([]);
      expect(mergeUnconfirmedMessages([], [answer("d2", 260, 200)], true).map((m) => m._id)).toEqual(["d2"]);
    });

    it("trails like any unread send in a conversation whose agent echoes it", () => {
      const merged = mergeUnconfirmedMessages(server, [answer("d1", 250, 200)]);
      expect(merged.map((m) => m._id)).toEqual(["asked", "result", "done", "d1"]);
    });
  });

  it("returns the same server ref when nothing is pending", () => {
    const server = [confirmed("a", 10)];
    expect(mergeUnconfirmedMessages(server, [])).toBe(server);
    expect(mergeUnconfirmedMessages(server, [pending("a", 5)])).toBe(server);
  });
});

describe("share-link guests open at the beginning", () => {
  const hook = readFileSync(join(import.meta.dir, "../useConversationMessages.ts"), "utf8");
  const page = readFileSync(join(import.meta.dir, "../../app/conversation/[id]/ConversationPageClient.tsx"), "utf8");

  it("the guest view asks for the first page, not the live tail", () => {
    const at = page.indexOf("function GuestConversationView");
    const call = page.slice(page.indexOf("useConversationMessages(", at), page.indexOf(";", page.indexOf("useConversationMessages(", at)));
    expect(call).toMatch(/,\s*true\)$/);
  });

  it("the start is a target centered on timestamp 0, so target mode is on from the first render", () => {
    expect(hook).toContain("(startTarget ? 0 : undefined)");
    const hasTarget = hook.slice(hook.indexOf("const hasTarget = !!("), hook.indexOf(");", hook.indexOf("const hasTarget = !!(")));
    expect(hasTarget).toContain("startTarget");
  });
});
