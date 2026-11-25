import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { performUndo } from "../undoStack";
import type { PendingComment } from "../../lib/quoteFormat";

// ct-101441: a quote the person removes by hand (x / ⌫ on the message, the
// chip's Remove) comes back on undo with its note, its block and the review
// target; a recorded quote's server draft is saved again. Removals a send or a
// cleanup makes (removeReviewComment) are not recorded.

const CONV = "k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MSG = "k57bbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const owner = Symbol("discard-undo-test");
let sent: Array<{ action: string; args: any[] }> = [];

const quote = (id: string, over: Partial<PendingComment> = {}): PendingComment => ({
  id, messageId: MSG, blockIndex: 2, quote: "rewrite the sync layer", body: "my careful note", createdAt: 5, ...over,
});

function setFlag(on: boolean) {
  const cs = useInboxStore.getState().clientState as any;
  useInboxStore.setState({ clientState: { ...cs, ui: { ...(cs?.ui ?? {}), quote_drafts: on } } } as any);
}
const batch = () => useInboxStore.getState().reviewComments[CONV] ?? [];

beforeEach(() => {
  _resetUndoStacks();
  sent = [];
  useInboxStore.setState({ reviewComments: { [CONV]: [quote("a")] }, reviewMessageId: MSG, reviewActiveBlock: 2, reviewEditingId: null } as any);
  useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
    sent.push({ action, args });
    return null;
  }, { owner });
});
afterEach(() => {
  useInboxStore.getState()._clearDispatch(owner);
  setFlag(false);
  useInboxStore.setState({ reviewComments: {}, reviewMessageId: null, reviewActiveBlock: 0 } as any);
});

describe("discardReviewComment", () => {
  it("undo brings the quote back on its block, note and review target included", () => {
    setFlag(false);
    useInboxStore.getState().discardReviewComment(CONV, "a");
    expect(batch()).toEqual([]);
    expect(useInboxStore.getState().reviewMessageId).toBeNull();

    expect(performUndo()).toBe(true);
    expect(batch()).toEqual([quote("a")]);
    expect(useInboxStore.getState().reviewMessageId).toBe(MSG);
    expect(useInboxStore.getState().reviewActiveBlock).toBe(2);
  });

  it("undo saves a recorded quote's server draft again", () => {
    setFlag(true);
    useInboxStore.getState().discardReviewComment(CONV, "a");
    expect(sent.some((d) => d.action === "removeQuoteDrafts" && d.args[0].includes("a"))).toBe(true);
    sent = [];

    expect(performUndo()).toBe(true);
    expect(batch()).toEqual([quote("a")]);
    const saved = sent.find((d) => d.action === "saveQuoteDrafts");
    expect(saved?.args[0]).toBe(CONV);
    expect(saved?.args[1].map((w: any) => [w.client_id, w.body, w.block_index])).toEqual([["a", "my careful note", 2]]);
  });

  it("a removal a send or cleanup makes is not on the undo stack", () => {
    useInboxStore.getState().removeReviewComment(CONV, "a");
    expect(performUndo()).toBe(false);
    expect(batch()).toEqual([]);
  });
});
