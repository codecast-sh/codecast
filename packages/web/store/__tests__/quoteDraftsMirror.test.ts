import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { attachReviewForSend, attachReviewToMessage, takeReviewBatch } from "../../lib/reviewActions";
import type { PendingComment } from "../../lib/quoteFormat";

// The composer's quote batch mirrored to its server record (lib/quoteDraftWire,
// convex quoteDrafts.ts). The batch stays local and the composer's source; with
// the person's quote_drafts preference on, each write also dispatches the
// touched quotes, and a send carries their ids.

const CONV = "k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MSG = "k57bbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const owner = Symbol("quote-drafts-test");
let sent: Array<{ action: string; args: any[] }> = [];
let refuse = false;

const quote = (id: string, over: Partial<PendingComment> = {}): PendingComment => ({
  id, messageId: MSG, blockIndex: 1, quote: "rewrite the sync layer", body: "", createdAt: 5, ...over,
});

function setFlag(on: boolean) {
  const cs = useInboxStore.getState().clientState as any;
  useInboxStore.setState({ clientState: { ...cs, ui: { ...(cs?.ui ?? {}), quote_drafts: on } } } as any);
}

const mirrorWrites = () => sent.filter((d) => d.action === "saveQuoteDrafts" || d.action === "removeQuoteDrafts");

beforeEach(() => {
  sent = [];
  refuse = false;
  useInboxStore.setState({ reviewComments: {}, reviewMessageId: null, reviewEditingId: null } as any);
  useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
    sent.push({ action, args });
    if (refuse) throw new Error("Uncaught Error: Unknown dispatch action");
    return null;
  }, { owner });
});
afterEach(() => {
  useInboxStore.getState()._clearDispatch(owner);
  setFlag(false);
});

describe("with the quote record off", () => {
  it("batch writes dispatch nothing", () => {
    setFlag(false);
    const s = useInboxStore.getState();
    s.addReviewComment(CONV, quote("a"));
    s.commitReviewComment(CONV, "a", "why now?");
    s.removeReviewComment(CONV, "a");
    s.addReviewComment(CONV, quote("b"));
    s.clearReviewComments(CONV);
    expect(mirrorWrites()).toEqual([]);
  });

  it("a send takes no quote ids", () => {
    setFlag(false);
    useInboxStore.getState().addReviewComment(CONV, quote("a", { body: "why?" }));
    expect(attachReviewForSend(CONV, "go").quoteIds).toEqual([]);
  });
});

describe("with the quote record on", () => {
  beforeEach(() => setFlag(true));

  it("add, note and verdict each save the quote's whole record", () => {
    const s = useInboxStore.getState();
    s.addReviewComment(CONV, quote("a"));
    s.commitReviewComment(CONV, "a", "why now?");
    s.applyReviewVerdict(CONV, quote("x", { verdict: "cut", verdictAt: 9 }));
    const saves = mirrorWrites().map((d) => d.args);
    expect(saves).toHaveLength(3);
    expect(saves[0]).toEqual([CONV, [{ client_id: "a", message_id: MSG, block_index: 1, quote: "rewrite the sync layer", body: "", created_at: 5 }]]);
    expect(saves[1][1][0].body).toBe("why now?");
    // The verdict landed on the block's existing quote, so it saves that one.
    expect(saves[2][1][0]).toMatchObject({ client_id: "a", verdict: "cut", body: "why now?" });
  });

  it("removing or discarding a quote drops its record", () => {
    const s = useInboxStore.getState();
    s.addReviewComment(CONV, quote("a"));
    s.addReviewComment(CONV, quote("b", { blockIndex: 2 }));
    s.removeReviewComment(CONV, "a");
    s.clearReviewComments(CONV);
    const removes = mirrorWrites().filter((d) => d.action === "removeQuoteDrafts").map((d) => d.args[0]);
    expect(removes).toEqual([["a"], ["b"]]);
  });

  it("pictures, page pins, plan quotes and doc batches stay local", () => {
    const s = useInboxStore.getState();
    s.addReviewComment(CONV, quote("img", { image: { storageId: "st", point: { x: 1, y: 1 }, width: 2, height: 2 } as any }));
    s.addReviewComment(CONV, quote("plan", { messageId: `${MSG}#plan` }));
    s.addReviewComment(`doc:${MSG}`, quote("doc"));
    s.addReviewComment("stub-conversation", quote("stub"));
    expect(mirrorWrites()).toEqual([]);
  });

  it("a send takes the recorded quotes' ids and leaves their records for the send to stamp", () => {
    const s = useInboxStore.getState();
    s.addReviewComment(CONV, quote("a", { body: "why?" }));
    s.addReviewComment(CONV, quote("plan", { messageId: `${MSG}#plan`, body: "x" }));
    sent = [];
    const { quoteIds } = attachReviewForSend(CONV, "go");
    expect(quoteIds).toEqual(["a"]);
    expect(useInboxStore.getState().reviewComments[CONV]).toBeUndefined();
    // The plan quote had no record; the sent one keeps its record.
    expect(mirrorWrites()).toEqual([]);
  });

  it("a take that is not a store send drops the records it took", () => {
    useInboxStore.getState().addReviewComment(CONV, quote("a", { body: "why?" }));
    sent = [];
    takeReviewBatch(CONV);
    expect(mirrorWrites().map((d) => [d.action, d.args[0]])).toEqual([["removeQuoteDrafts", ["a"]]]);
  });

  it("sendMessage hands the quote ids to dispatch as a fifth argument", () => {
    useInboxStore.getState().sendMessage(CONV, "hi", undefined, "client-1", ["a"]);
    const send = sent.find((d) => d.action === "sendMessage");
    expect([send?.args[0], send?.args[3], send?.args[4]]).toEqual([CONV, "client-1", ["a"]]);
  });

  it("a refused mirror write leaves the batch as it was", async () => {
    refuse = true;
    useInboxStore.getState().addReviewComment(CONV, quote("a"));
    await new Promise((r) => setTimeout(r, 20));
    expect(useInboxStore.getState().reviewComments[CONV]?.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("the composed message is the same with the record on or off", () => {
  const batch = () => [
    quote("1", { blockIndex: 0, quote: "first block", body: "n1" }),
    quote("2", { blockIndex: 3, quote: "line one\nline two", body: "", verdict: "approve", verdictAt: 1 }),
    quote("3", { blockIndex: 1, quote: "", body: "only a note" }),
    quote("4", { blockIndex: 2, messageId: `${MSG}#plan`, quote: "plan step", body: "cut it" }),
  ];
  const compose = (on: boolean, typed: string) => {
    setFlag(on);
    useInboxStore.setState({ reviewComments: { [CONV]: batch() } } as any);
    const forSend = attachReviewForSend(CONV, typed).text;
    useInboxStore.setState({ reviewComments: { [CONV]: batch() } } as any);
    const legacy = attachReviewToMessage(CONV, typed);
    return { forSend, legacy };
  };

  for (const typed of ["", "  my reply  ", "line\nbreaks"]) {
    it(`byte-identical for ${JSON.stringify(typed)}`, () => {
      const off = compose(false, typed);
      const on = compose(true, typed);
      expect(on.forSend).toBe(off.legacy);
      expect(off.forSend).toBe(off.legacy);
      expect(on.legacy).toBe(off.legacy);
    });
  }
});
