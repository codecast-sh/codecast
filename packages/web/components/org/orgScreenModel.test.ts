// The Org screen's pure rules (essence spec §3.2, §5): the URL, the panel's
// size, where a proposal opens, the card's message, which proposals to feed.
// Run: bun test components/org/orgScreenModel.test.ts
import { describe, expect, test } from "bun:test";
import { detailLayout, detailSizeOf, findProposalCardMessage, healthRedirect, OPEN_PROPOSAL_FEED_CAP, openProposalsToFeed, ORG_DETAIL_DEFAULT, orgScreenParams, proposalPanelOf } from "./orgScreenModel";
import type { OrgProposalRow } from "./orgStaffingTypes";

const AUTHOR = { kind: "role" as const, id: "role-head", name: "Head of People", handle: "head-of-people", short_id: "or-9", avatar: "owl" };
const HEAD = "fixture-head-conv";
const T0 = 1_700_000_000_000;

const proposal = (n: number, extra: Partial<OrgProposalRow> = {}): OrgProposalRow => ({
  _id: `p${n}`, short_id: `op-${n}`, team_id: "fixture-team", author: AUTHOR, title: `Proposal ${n}`, summary_md: "", mode: "review", status: "open",
  created_at: T0 + n * 60_000, thread: { conversation_id: HEAD }, changes: [], ...extra,
});

describe("orgScreenParams", () => {
  test("each parameter alone", () => {
    expect(orgScreenParams("proposal=OP-57").proposal).toBe("op-57");
    expect(orgScreenParams("?proposal=nope").proposal).toBeNull();
    expect(orgScreenParams("focus=3").focus).toBe(3);
    expect(orgScreenParams("focus=abc").focus).toBeNull();
    expect(orgScreenParams("session=conv-1").session).toBe("conv-1");
    expect(orgScreenParams("session=%20").session).toBeNull();
    expect(orgScreenParams("compose=hello%20there").compose).toBe("hello there");
    expect(orgScreenParams("compose=%20").compose).toBeNull();
    expect(orgScreenParams("panel=history").history).toBe(true);
    expect(orgScreenParams("panel=other").history).toBe(false);
  });

  test("all together, from a string or a URLSearchParams; the cut parameters are not read", () => {
    const all = "proposal=op-7&focus=2&session=c1&compose=hi&panel=history&show=map&beside=c2&lens=goals&week=1&proposed=0";
    const want = { proposal: "op-7", focus: 2, session: "c1", compose: "hi", history: true };
    expect(orgScreenParams(all)).toEqual(want);
    expect(orgScreenParams(new URLSearchParams(all))).toEqual(want);
    expect(orgScreenParams(null)).toEqual({ proposal: null, focus: null, session: null, compose: null, history: false });
  });
});

describe("healthRedirect", () => {
  test("the retired health page lands on the Org screen, other parameters kept", () => {
    expect(healthRedirect("view=health")).toBe("/org");
    expect(healthRedirect("?view=health&proposal=op-3")).toBe("/org?proposal=op-3");
    expect(healthRedirect(new URLSearchParams("view=health&preview=1"))).toBe("/org?preview=1");
  });
  test("any other address is not redirected", () => {
    expect(healthRedirect("")).toBeNull();
    expect(healthRedirect(null)).toBeNull();
    expect(healthRedirect("view=chart")).toBeNull();
  });
});

describe("the panel's size", () => {
  test("a stored size counts only with room on both sides", () => {
    expect(detailSizeOf(undefined)).toBe(ORG_DETAIL_DEFAULT);
    expect(detailSizeOf({ detail: 0 })).toBe(ORG_DETAIL_DEFAULT);
    expect(detailSizeOf({ detail: 99 })).toBe(ORG_DETAIL_DEFAULT);
    expect(detailSizeOf({ detail: 57.5 })).toBe(57.5);
  });
  test("closed is the canvas alone, open the person's size, filling the panel alone", () => {
    expect(detailLayout(false, false, 40)).toEqual({ "org-canvas": 100, "org-detail": 0 });
    expect(detailLayout(false, true, 40)).toEqual({ "org-canvas": 100, "org-detail": 0 });
    expect(detailLayout(true, false, 40)).toEqual({ "org-canvas": 60, "org-detail": 40 });
    expect(detailLayout(true, true, 40)).toEqual({ "org-canvas": 0, "org-detail": 100 });
  });
});

describe("where a proposal opens", () => {
  const tree = { roles: [{ _id: "role-head", handle: "head-of-people", short_id: "or-9", standing: { conversation_id: "standing-head" } }] } as any;
  test("its own thread when it has one", () => {
    expect(proposalPanelOf(proposal(1), tree)).toEqual({ kind: "thread", conversationId: HEAD });
  });
  test("a row from before the thread field: the author's conversation, a role's standing one or the session itself", () => {
    expect(proposalPanelOf(proposal(1, { thread: undefined }), tree)).toEqual({ kind: "thread", conversationId: "standing-head" });
    expect(proposalPanelOf(proposal(1, { thread: undefined, author: { kind: "session", id: "sess-9" } }), tree)).toEqual({ kind: "thread", conversationId: "sess-9" });
    // A role the tree does not hold, or one that has not started: the card alone.
    expect(proposalPanelOf(proposal(1, { thread: undefined }), null)).toEqual({ kind: "card" });
  });
  test("a person posted it (thread null): the card alone", () => {
    expect(proposalPanelOf(proposal(1, { thread: null }), tree)).toEqual({ kind: "card" });
    expect(proposalPanelOf(proposal(1, { thread: undefined, author: { kind: "user", id: "u1" } }), tree)).toEqual({ kind: "card" });
  });
});

describe("findProposalCardMessage", () => {
  const messages = [
    { _id: "m0", role: "user", content: "op-57" },
    { _id: "m1", role: "assistant", content: "Here it is, op-57, and then op-57#3 came up." },
    { _id: "m2", role: "assistant", content: "The proposal:\n\n  OP-57  \n\nTell me what you think." },
    { _id: "m3", role: "assistant", content: "op-57" },
    { _id: "m4", role: "assistant", content: "op-57#3\nI changed my mind." },
    { _id: "m5", role: "assistant", content: "op-5" },
  ];
  test("the oldest agent message with the bare line, case-insensitive, N fixed", () => {
    expect(findProposalCardMessage(messages, "op-57")).toBe("m2");
    expect(findProposalCardMessage(messages, "op-5")).toBe("m5");
    expect(findProposalCardMessage(messages, "op-570")).toBeNull();
  });
  test("a sentence, a #seq line and a person's message never match", () => {
    expect(findProposalCardMessage([messages[0], messages[1], messages[4]], "op-57")).toBeNull();
    expect(findProposalCardMessage(undefined, "op-57")).toBeNull();
    expect(findProposalCardMessage([], "op-57")).toBeNull();
  });
});

describe("openProposalsToFeed", () => {
  test("open ones oldest first, capped, the linked ref appended once, closed excluded", () => {
    const rows = [proposal(3), proposal(1), proposal(2, { status: "resolved" }), proposal(4)];
    expect(openProposalsToFeed(rows, null)).toEqual(["op-1", "op-3", "op-4"]);
    expect(openProposalsToFeed(rows, "op-3")).toEqual(["op-1", "op-3", "op-4"]);
    expect(openProposalsToFeed(rows, "op-9")).toEqual(["op-1", "op-3", "op-4", "op-9"]);
    const many = Array.from({ length: OPEN_PROPOSAL_FEED_CAP + 3 }, (_, i) => proposal(i + 1));
    const fed = openProposalsToFeed(many, "op-11");
    expect(fed).toHaveLength(OPEN_PROPOSAL_FEED_CAP + 1);
    expect(fed[0]).toBe("op-1");
    expect(fed.at(-1)).toBe("op-11");
  });
});
