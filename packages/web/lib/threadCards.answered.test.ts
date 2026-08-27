import { test, expect, describe } from "bun:test";
import { answeredByViewer, cardsForChip, serverCards, unreadByChip } from "./threadCards";
import type { ThreadInboxRow, ThreadLastReply } from "../store/threadTypes";

// A thread whose newest reply is the viewer's own has nothing awaiting them:
// it leaves every view until someone else replies. An agent's answer — even
// one stamped with the asker's id — is still news.

const T0 = 1_700_000_000_000;
const ME = "u_me";

function row(kind: ThreadInboxRow["kind"], last: Partial<ThreadLastReply> | null, unread = 0): ThreadInboxRow {
  return {
    _id: `${kind}:${String(last?.user_id ?? "none")}`,
    kind,
    root_key: "r1",
    channel_id: "c1",
    last_activity_at: T0,
    last_read_at: T0 - 1000,
    updated_at: T0,
    unread,
    last_reply: last ? { _id: "m1", created_at: T0, preview: "", ...last } : null,
  };
}

const cards = (rows: ThreadInboxRow[]) => serverCards(rows, () => "channel", () => undefined, () => undefined, ME);

describe("answeredByViewer", () => {
  test("own person reply retires; others and agents do not", () => {
    expect(answeredByViewer(row("chat", { user_id: ME }), ME)).toBe(true);
    expect(answeredByViewer(row("chat", { user_id: "u_other" }), ME)).toBe(false);
    expect(answeredByViewer(row("comment", { user_id: ME, author_kind: "agent" }), ME)).toBe(false);
    expect(answeredByViewer(row("chat", null), ME)).toBe(false);
    expect(answeredByViewer(row("chat", { user_id: ME }), undefined)).toBe(false);
  });
});

describe("views", () => {
  test("an answered thread is absent from All and from its own chip", () => {
    const all = cards([row("chat", { user_id: ME }), row("chat", { user_id: "u_other" })]);
    expect(cardsForChip(all, "all", false).map((c) => c.id)).toEqual(["chat:u_other"]);
    expect(cardsForChip(all, "chat", false).map((c) => c.id)).toEqual(["chat:u_other"]);
  });

  test("an answered thread with a stale unread count does not tick the chip", () => {
    const counts = unreadByChip(cards([row("task", { user_id: ME }, 1), row("task", { user_id: "u_other" }, 1)]));
    expect(counts.task).toBe(1);
    expect(counts.all).toBe(1);
  });
});
