// The org screen's pure rules (org-staffing.md S41): the URL, the card's
// message, which proposals to feed, the strip's rows, the mission, the path.
// Run: bun test --timeout 240000 components/org/orgScreenModel.test.ts
import { describe, expect, test } from "bun:test";
import { proposalTotals } from "@codecast/shared/contracts/orgChangeWords";
import { findProposalCardMessage, healthRedirect, missionOf, OPEN_PROPOSAL_FEED_CAP, openProposalsToFeed, ORG_STACK_BELOW, orgScreenParams, orgScreenPath, stripCount, stripRows, stripTotals } from "./orgScreenModel";
import type { OrgProposalRow } from "./orgStaffingTypes";
import type { PendingComment } from "../../lib/quoteFormat";

const AUTHOR = { kind: "role" as const, id: "role-head", name: "Head of People", handle: "head-of-people", short_id: "or-9", avatar: "owl" };
const HEAD = "fixture-head-conv";
const T0 = 1_700_000_000_000;

const proposal = (n: number, extra: Partial<OrgProposalRow> = {}): OrgProposalRow => ({
  _id: `p${n}`, short_id: `op-${n}`, team_id: "fixture-team", author: AUTHOR, title: `Proposal ${n}`, summary_md: "", mode: "review", status: "open",
  created_at: T0 + n * 60_000, thread: { conversation_id: HEAD }, changes: [], ...extra,
});
const change = (proposal_id: string, seq: number, c: any, status: any = "proposed") => ({ _id: `${proposal_id}-c${seq}`, proposal_id, seq, change: c, rationale: "", evidence: [], status });
const ROLE = { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] } };
const LIMIT = { kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } };
const answer = (id: string, proposalId: string, card: string): PendingComment => ({ id, messageId: "", blockIndex: 0, quote: "", body: "", createdAt: T0, proposal: { id: proposalId, card, verdict: "approve", change_ids: [`${proposalId}-c1`], seqs: [1] } as any });

describe("orgScreenParams", () => {
  test("each parameter alone", () => {
    expect(orgScreenParams("proposal=OP-57").proposal).toBe("op-57");
    expect(orgScreenParams("?proposal=nope").proposal).toBeNull();
    expect(orgScreenParams("focus=3").focus).toBe(3);
    expect(orgScreenParams("focus=abc").focus).toBeNull();
    expect(orgScreenParams("show=map").show).toBe("map");
    expect(orgScreenParams("show=conversation").show).toBe("conversation");
    expect(orgScreenParams("show=x").show).toBeNull();
    expect(orgScreenParams("beside=conv-1").beside).toBe("conv-1");
    expect(orgScreenParams("lens=people").lens).toBe("people");
    expect(orgScreenParams("lens=odd").lens).toBe("everything");
    expect(orgScreenParams("").lens).toBe("everything");
    expect(orgScreenParams("proposed=0").proposed).toBe(false);
    expect(orgScreenParams("").proposed).toBe(true);
    expect(orgScreenParams("compose=hello%20there").compose).toBe("hello there");
    expect(orgScreenParams("compose=%20").compose).toBeNull();
    expect(orgScreenParams("panel=history").history).toBe(true);
    expect(orgScreenParams("panel=other").history).toBe(false);
    expect(orgScreenParams("week=1").week).toBe(true);
    expect(orgScreenParams("week=yes").week).toBe(false);
    expect(orgScreenParams("").week).toBe(false);
  });

  test("all together, from a string or a URLSearchParams", () => {
    const all = "proposal=op-7&focus=2&show=map&beside=conv-1&lens=goals&proposed=0&week=1&compose=hi&panel=history";
    const want = { proposal: "op-7", focus: 2, show: "map", beside: "conv-1", lens: "goals", proposed: false, week: true, compose: "hi", history: true };
    expect(orgScreenParams(all)).toEqual(want);
    expect(orgScreenParams(new URLSearchParams(all))).toEqual(want);
    expect(orgScreenParams(null)).toEqual({ proposal: null, focus: null, show: null, beside: null, lens: "everything", proposed: true, week: false, compose: null, history: false });
  });
});

describe("orgScreenPath", () => {
  test("writes proposal, focus, lens, show, beside in that order, only those set", () => {
    expect(orgScreenPath({})).toBe("/org");
    expect(orgScreenPath({ proposal: "op-7", show: "map" })).toBe("/org?proposal=op-7&show=map");
    expect(orgScreenPath({ beside: "conv-hop", show: "map", lens: "people", focus: 4, proposal: "op-8" })).toBe("/org?proposal=op-8&focus=4&lens=people&show=map&beside=conv-hop");
    expect(orgScreenPath({ proposal: "op-8", focus: "4", lens: "everything", beside: null })).toBe("/org?proposal=op-8&focus=4");
    expect(orgScreenPath({ lens: "people", week: true })).toBe("/org?lens=people&week=1");
    expect(orgScreenPath({ week: false })).toBe("/org");
  });
});

describe("healthRedirect", () => {
  test("the retired health page lands on the People map with This week on, other parameters kept", () => {
    expect(healthRedirect("view=health")).toBe("/org?lens=people&week=1");
    expect(healthRedirect("?view=health&lens=goals&proposal=op-3")).toBe("/org?lens=people&proposal=op-3&week=1");
    expect(healthRedirect(new URLSearchParams("view=health&preview=1"))).toBe("/org?preview=1&lens=people&week=1");
  });
  test("any other address is not redirected", () => {
    expect(healthRedirect("")).toBeNull();
    expect(healthRedirect(null)).toBeNull();
    expect(healthRedirect("view=chart&lens=people")).toBeNull();
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

describe("stripRows", () => {
  const withRole = proposal(2, { changes: [change("p2", 1, ROLE), change("p2", 2, LIMIT)] });
  const loading = proposal(3, { counts: { total: 9, decided: 3, applied: 3, failed: 0, skipped: 0 } });
  const noThread = proposal(1, { thread: null });
  const elsewhere = proposal(4, { thread: { conversation_id: "other-conv" } });
  const comments = [answer("a", "p2", "k1"), answer("b", "p2", "k2"), answer("c", "p9", "k1")];
  const rows = stripRows([withRole, elsewhere, loading, noThread], HEAD, comments, T0 + 10 * 60_000);

  test("oldest first", () => {
    expect(rows.map((r) => r.proposal.short_id)).toEqual(["op-1", "op-2", "op-3", "op-4"]);
  });
  test("foreign for a null thread and for another thread; never in the preview, whose column draws every row", () => {
    expect(rows.map((r) => r.foreign)).toEqual([true, false, false, true]);
    expect(stripRows([withRole], null, undefined, T0).map((r) => r.foreign)).toEqual([true]);
    expect(stripRows([withRole, elsewhere, noThread], HEAD, undefined, T0, true).map((r) => r.foreign)).toEqual([false, false, false]);
  });
  test("answered counts this proposal's staged answers only", () => {
    expect(rows.map((r) => r.answered)).toEqual([0, 2, 0, 0]);
  });
  test("decided and total from the change rows, or from counts while they load", () => {
    expect(rows[1]).toMatchObject({ decided: 0, total: 2 });
    expect(rows[2]).toMatchObject({ decided: 3, total: 9 });
  });
  test("totals come from the one helper, the list count while loading, nothing with neither", () => {
    expect(rows[1].totals).toBe(proposalTotals(withRole.changes).line!.replace(/\.$/, ""));
    expect(rows[1].totals).not.toMatch(/\.$/);
    expect(rows[2].totals).toBe("9 changes");
    expect(stripTotals(proposal(5))).toBe("");
    expect(stripTotals(proposal(6, { changes: [change("p6", 1, ROLE)] }))).toBe(proposalTotals([change("p6", 1, ROLE)]).count);
  });
  test("the row's count is the words its card leads with, the list count while loading, nothing with neither", () => {
    expect(rows[1].count).toBe("2 to decide");
    expect(rows[2].count).toBe("9 changes");
    expect(stripCount(proposal(5))).toBe("");
  });
  test("the columns stack where the conversation's 560px and the map's 360px floors no longer fit side by side", () => {
    expect(ORG_STACK_BELOW).toBeGreaterThanOrEqual(560 + 360);
    expect(ORG_STACK_BELOW).toBe(980);
  });
  test("age and author ride along", () => {
    expect(rows[0].age).toBe("9m ago");
    expect(rows[0].author).toBe(AUTHOR);
  });
});

describe("missionOf", () => {
  const goal = (n: number, parent?: string) => ({ _id: `g${n}`, short_id: `in-${n}`, title: `Goal ${n}`, ...(parent ? { parent_initiative_id: parent } : {}) });
  test("none, one root with children, two roots, a root with no children", () => {
    expect(missionOf([])).toBeNull();
    expect(missionOf([goal(1), goal(2, "g1"), goal(3, "g1")])).toEqual({ title: "Goal 1", shortId: "in-1" });
    expect(missionOf([goal(1), goal(2, "g1"), goal(3)])).toBeNull();
    expect(missionOf([goal(1)])).toBeNull();
  });
});

test("the filter reads every lens the company pane offers; anything else is everything", () => {
  expect(orgScreenParams("lens=projects").lens).toBe("projects");
  expect(orgScreenParams("lens=goals").lens).toBe("goals");
  expect(orgScreenParams("lens=people").lens).toBe("people");
  expect(orgScreenParams("lens=health").lens).toBe("everything");
  expect(orgScreenPath({ lens: "projects", proposal: "op-3" })).toBe("/org?proposal=op-3&lens=projects");
});

describe("proposedMissionOf", () => {
  test("a new goal at the top that the proposal puts others under is the mission it would set", async () => {
    const { proposedMissionOf } = await import("./orgScreenModel");
    const { UNION_GOALS_PROPOSAL } = await import("./goalsFixture");
    expect(proposedMissionOf([UNION_GOALS_PROPOSAL])).toEqual({ title: "Broker high-value introductions that become real transactions", proposal: "op-54", seq: 1 });
    // Nothing gathered under it, or nothing proposed at all: no mission.
    expect(proposedMissionOf([{ ...UNION_GOALS_PROPOSAL, changes: UNION_GOALS_PROPOSAL.changes.slice(0, 1) }])).toBeNull();
    expect(proposedMissionOf([])).toBeNull();
  });
});
