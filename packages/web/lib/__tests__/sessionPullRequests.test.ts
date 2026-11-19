import { describe, expect, test } from "bun:test";
import { CARD_BUCKETS, cardBuckets, isFullPullRequest, overlayCardPullRequests, rankCardSessions, stableCardIds, sessionPullRequests, sessionPullRequestsSig, showsCi, titledSessionPullRequests } from "../sessionPullRequests";
import { joinPullRequestDetail } from "../detailRows";

const pullRequests = {
  p1: { _id: "p1", repository: "acme/app", number: 10, state: "merged", title: "Ten" },
  p2: { _id: "p2", repository: "acme/app", number: 12, state: "open", draft: true, checks_state: "pending" },
  p3: { _id: "p3", repository: "acme/app", number: 11, state: "open", checks_state: "success" },
  p4: { _id: "p4", repository: "acme/app", number: 9, state: "closed" },
  p5: { _id: "p5", repository: "acme/app", number: 8, state: "open", checks_state: "failure" },
};
const link = (id: string, pr: string, conv: string, tier?: string) => ({ _id: id, pull_request_id: pr, conversation_id: conv, ...(tier ? { tier } : {}) });
const pullRequestSessions = {
  l1: link("l1", "p1", "c1", "committed"),
  l2: link("l2", "p2", "c1", "committed"),
  l3: link("l3", "p3", "c1", "committed"),
  l4: link("l4", "p4", "c1", "committed"),
  l5: link("l5", "p5", "c1"),
  l6: link("l6", "p2", "c2", "committed"),
  l7: link("l7", "missing", "c2", "committed"),
};
const state = { pullRequests, pullRequestSessions };
const line = (s: typeof state, id: string) => sessionPullRequests(s, id).map((p) => `${p.number}:${p.state}:${p.ci ?? ""}:${p.tier}`);

describe("sessionPullRequests", () => {
  test("joins links to rows: committed first, then what needs something, open before draft before merged before closed", () => {
    expect(line(state, "c1")).toEqual([
      "11:open:success:committed",
      "12:draft:pending:committed",
      "10:merged::committed",
      "9:closed::committed",
      "8:open:failure:observed",
    ]);
    expect(line(state, "c2")).toEqual(["12:draft:pending:committed"]);
    expect(sessionPullRequests(state, "c3")).toEqual([]);
    expect(sessionPullRequests(state, null)).toEqual([]);
  });

  test("failing checks lead their tier", () => {
    const failing = { ...state, pullRequests: { ...pullRequests, p3: { ...pullRequests.p3, checks_state: "failure" }, p2: { ...pullRequests.p2, draft: false } } };
    expect(line(failing, "c1").slice(0, 2)).toEqual(["11:open:failure:committed", "12:open:pending:committed"]);
  });

  test("builds the index once per pair of collections", () => {
    expect(sessionPullRequests(state, "c1")).toBe(sessionPullRequests(state, "c1"));
  });

  test("the signature is a short digest that moves only when a drawn field does, and titles come from the rows", () => {
    const sig = sessionPullRequestsSig(state, "c1");
    expect(sig.length).toBeLessThan(16);
    expect(titledSessionPullRequests(state, "c1").find((p) => p.id === "p1")?.title).toBe("Ten");
    const touched = { ...state, pullRequests: { ...pullRequests, p3: { ...pullRequests.p3, updated_at: 99, title: "renamed" } } };
    expect(sessionPullRequestsSig(touched, "c1")).toBe(sig);
    const red = { ...state, pullRequests: { ...pullRequests, p3: { ...pullRequests.p3, checks_state: "failure" } } };
    expect(sessionPullRequestsSig(red, "c1")).not.toBe(sig);
    const promoted = { ...state, pullRequestSessions: { ...pullRequestSessions, l5: link("l5", "p5", "c1", "committed") } };
    expect(sessionPullRequestsSig(promoted, "c1")).not.toBe(sig);
    expect(sessionPullRequestsSig(state, "c9")).toBe("");
  });

  test("checks show only while the pull request can change", () => {
    expect(showsCi({ state: "open", ci: "failure" })).toBe(true);
    expect(showsCi({ state: "merged", ci: "success" })).toBe(false);
    expect(showsCi({ state: "open", ci: null })).toBe(false);
  });
});

describe("rankCardSessions / stableCardIds", () => {
  const id = (n: number) => `jx7${String(n).padStart(29, "a")}`;
  const sessions = (order: number[]) => {
    const out: Record<string, any> = { tmp: { _id: "optimistic-1", updated_at: 1e9 } };
    order.forEach((n, i) => { out[id(n)] = { _id: id(n), updated_at: 1000 - i, is_pinned: n === 199 }; });
    return out;
  };

  test("pinned first, then newest, never an optimistic id", () => {
    const ranked = rankCardSessions(sessions([0, 1, 2, 199]));
    expect(ranked[0]).toBe(id(199));
    expect(ranked).not.toContain("optimistic-1");
  });

  test("nested subagents are never asked about; set-aside sessions rank after the active list", () => {
    const ranked = rankCardSessions({
      [id(1)]: { _id: id(1), updated_at: 5 },
      [id(2)]: { _id: id(2), updated_at: 9, is_subagent: true, parent_conversation_id: id(1) } as any,
      [id(3)]: { _id: id(3), updated_at: 8, inbox_dismissed_at: 1 } as any,
      [id(4)]: { _id: id(4), updated_at: 7, inbox_killed_at: 1 } as any,
    });
    expect(ranked).toEqual([id(1), id(3), id(4)]);
  });

  test("a heartbeat reordering the edge keeps the asked set, and the same array", () => {
    const base = Array.from({ length: 200 }, (_, n) => n);
    const held = stableCardIds(rankCardSessions(sessions(base)), []);
    expect(held.length).toBe(120);
    expect([...held].sort()).toEqual(held);
    const nudged = [...base];
    [nudged[119], nudged[125]] = [nudged[125], nudged[119]];
    expect(stableCardIds(rankCardSessions(sessions(nudged)), held)).toBe(held);
  });

  test("a new session joins; one that falls far behind leaves; never past the cap", () => {
    const base = Array.from({ length: 300 }, (_, n) => n);
    let held = stableCardIds(rankCardSessions(sessions(base)), []);
    held = stableCardIds(rankCardSessions(sessions([250, ...base.filter((n) => n !== 250)])), held);
    expect(held).toContain(id(250));
    const sunk = [...base.filter((n) => n !== 3), 3];
    held = stableCardIds(rankCardSessions(sessions(sunk)), held);
    expect(held).not.toContain(id(3));
    let churn = held;
    for (let round = 0; round < 10; round++) {
      const order = [...Array.from({ length: 20 }, (_, k) => 400 + round * 20 + k), ...base];
      churn = stableCardIds(rankCardSessions(sessions(order)), churn);
      expect(churn.length).toBeLessThanOrEqual(120);
    }
  });
});

describe("overlayCardPullRequests", () => {
  test("keeps what a fuller feed cached, takes the chip fields, clears the ones left out", () => {
    const cached = { p1: { _id: "p1", number: 1, state: "open", draft: true, checks_state: "pending", head_ref: "fix/a", linked_session_ids: ["c1", "c2"] } };
    const [row] = overlayCardPullRequests([{ _id: "p1", number: 1, state: "open", checks_state: "success", title: "One" }], cached);
    expect(row.head_ref).toBe("fix/a");
    expect(row.linked_session_ids).toEqual(["c1", "c2"]);
    expect(row.checks_state).toBe("success");
    expect(row.title).toBe("One");
    expect(row.draft).toBeUndefined();
    expect(isFullPullRequest(row)).toBe(false);
    const withMerge = { p1: { ...cached.p1, mergeable_state: "blocked" } };
    const [moved] = overlayCardPullRequests([{ _id: "p1", number: 1, state: "merged", checks_state: "success" }], withMerge);
    expect(moved.mergeable_state).toBeUndefined();
    const [same] = overlayCardPullRequests([{ _id: "p1", number: 1, state: "open", draft: true, checks_state: "pending" }], withMerge);
    expect(same.mergeable_state).toBe("blocked");
    // The checks themselves live in pullRequestDetails, stamped with the state
    // they were read under: once the chip feed moves the row's state, the
    // page's read of the row hides them until a full read sends them again.
    const detail = { _id: "p1", checks: [{ name: "ci", conclusion: "failure" }], checks_state: "pending", _cachedAt: 1 };
    expect(joinPullRequestDetail(same, detail).checks).toEqual(detail.checks);
    expect(joinPullRequestDetail(moved, detail).checks).toBeUndefined();
    const [fresh] = overlayCardPullRequests([{ _id: "p9", number: 9, state: "merged" }], cached);
    expect(fresh).toMatchObject({ _id: "p9", number: 9, state: "merged" });
    expect(isFullPullRequest(fresh)).toBe(false);
    expect(isFullPullRequest({ body: "" })).toBe(true);
  });
});

describe("cardBuckets", () => {
  const ids = Array.from({ length: 60 }, (_, n) => `jx7${String(n).padStart(29, "b")}`).sort();
  test("splits the ids into stable groups and keeps a group's array when its members stay", () => {
    const first = cardBuckets(ids, []);
    expect(first).toHaveLength(CARD_BUCKETS);
    expect(first.flat().sort()).toEqual([...ids].sort());
    const extra = `jx7${"c".repeat(29)}`;
    const second = cardBuckets([...ids, extra].sort(), first);
    const changed = second.filter((g, i) => g !== first[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain(extra);
  });

  test("each group goes best first by the ranking", () => {
    const ranked = [...ids].reverse();
    const groups = cardBuckets(ids, [], ranked);
    for (const g of groups) expect(g).toEqual([...g].sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b)));
    expect(cardBuckets(ids, groups, [...ids])).toEqual(groups);
    expect(cardBuckets(ids, groups, [...ids])[0]).toBe(groups[0]);
  });
});
