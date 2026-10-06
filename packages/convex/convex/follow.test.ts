import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { dropFollower, follow, followersOf, following, reportView, unfollow, viewOf } from "./follow";
import { FOLLOW_LEASE_MS } from "@codecast/shared/contracts/follow";

// Follow mode over the fake db: the lease, the write gate, and the access rule.

const T1 = "t1";
const ANN = "ua";
const BOB = "ub";
const CY = "uc";
const SHARED = "conv-shared";
const PRIVATE = "conv-private";

function tables() {
  return {
    teams: [{ _id: T1, name: "T" }],
    team_memberships: [
      { _id: "m1", user_id: ANN, team_id: T1, visibility: "full" },
      { _id: "m2", user_id: BOB, team_id: T1, visibility: "full" },
      { _id: "m3", user_id: CY, team_id: T1, visibility: "full" },
    ],
    users: [
      { _id: ANN, name: "Ann" },
      { _id: BOB, name: "Bob", image: "https://x/bob.png" },
      { _id: CY, name: "Cy" },
    ],
    conversations: [
      { _id: SHARED, user_id: ANN, team_id: T1, is_private: false, updated_at: 1 },
      { _id: PRIVATE, user_id: ANN, team_id: T1, is_private: true, updated_at: 1 },
    ],
    session_owners: [] as any[],
    view_follows: [] as any[],
    view_states: [] as any[],
  };
}

function ctxFor(rows: ReturnType<typeof tables>, user: string) {
  return {
    db: makeFakeDb(rows as any),
    auth: { getUserIdentity: async () => ({ subject: `${user}|sess`, tokenIdentifier: "x" }) },
  };
}

const h = (fn: any) => fn._handler ?? fn.handler;

describe("follow lease", () => {
  test("follow upserts one lease per follower, and the leader sees live followers with names", async () => {
    const rows = tables();
    await h(follow)(ctxFor(rows, BOB), { leader_id: ANN });
    await h(follow)(ctxFor(rows, BOB), { leader_id: ANN });
    expect(rows.view_follows.length).toBe(1);
    const mine = await h(followersOf)(ctxFor(rows, ANN), {});
    expect(mine).toEqual([{ user_id: BOB, name: "Bob", image: "https://x/bob.png" }]);
    expect(await h(following)(ctxFor(rows, BOB), {})).toEqual({ leader_id: ANN });
  });

  test("a new leader replaces the old lease; following yourself does nothing", async () => {
    const rows = tables();
    await h(follow)(ctxFor(rows, BOB), { leader_id: ANN });
    await h(follow)(ctxFor(rows, BOB), { leader_id: CY });
    expect(rows.view_follows.length).toBe(1);
    expect(rows.view_follows[0].leader_id).toBe(CY);
    await h(follow)(ctxFor(rows, BOB), { leader_id: BOB });
    expect(rows.view_follows[0].leader_id).toBe(CY);
  });

  test("a dead lease counts as nobody: not a follower, not following", async () => {
    const rows = tables();
    rows.view_follows.push({ _id: "f1", follower_id: BOB, leader_id: ANN, updated_at: Date.now() - FOLLOW_LEASE_MS - 1 });
    expect(await h(followersOf)(ctxFor(rows, ANN), {})).toEqual([]);
    expect(await h(following)(ctxFor(rows, BOB), {})).toBeNull();
  });

  test("a leader drops one follower: renewals are refused, the follower learns it ended, a fresh follow revives it", async () => {
    const rows = tables();
    await h(follow)(ctxFor(rows, BOB), { leader_id: ANN, fresh: true });
    await h(follow)(ctxFor(rows, CY), { leader_id: ANN, fresh: true });
    // Only the leader of that lease can drop it.
    await h(dropFollower)(ctxFor(rows, CY), { follower_id: BOB });
    expect((await h(followersOf)(ctxFor(rows, ANN), {})).length).toBe(2);
    await h(dropFollower)(ctxFor(rows, ANN), { follower_id: BOB });
    expect((await h(followersOf)(ctxFor(rows, ANN), {})).map((f: any) => f.user_id)).toEqual([CY]);
    await h(follow)(ctxFor(rows, BOB), { leader_id: ANN });
    expect(await h(following)(ctxFor(rows, BOB), {})).toBeNull();
    expect(await h(viewOf)(ctxFor(rows, BOB), { leader_id: ANN })).toMatchObject({ ended: true });
    expect(await h(reportView)(ctxFor(rows, ANN), { path: "/x" })).toEqual({ written: true });
    await h(follow)(ctxFor(rows, BOB), { leader_id: ANN, fresh: true });
    expect(await h(following)(ctxFor(rows, BOB), {})).toEqual({ leader_id: ANN });
    expect((await h(followersOf)(ctxFor(rows, ANN), {})).length).toBe(2);
  });

  test("unfollow drops the lease", async () => {
    const rows = tables();
    await h(follow)(ctxFor(rows, BOB), { leader_id: ANN });
    await h(unfollow)(ctxFor(rows, BOB), {});
    expect(rows.view_follows.length).toBe(0);
  });
});

describe("leader view", () => {
  test("a leader nobody follows writes nothing; a followed leader writes one row and updates it in place", async () => {
    const rows = tables();
    expect(await h(reportView)(ctxFor(rows, ANN), { path: "/inbox" })).toEqual({ written: false });
    expect(rows.view_states.length).toBe(0);
    await h(follow)(ctxFor(rows, BOB), { leader_id: ANN });
    expect(await h(reportView)(ctxFor(rows, ANN), { path: "/inbox" })).toEqual({ written: true });
    await h(reportView)(ctxFor(rows, ANN), { path: `/conversation/${SHARED}`, conversation_id: SHARED, anchor: { message_id: "m9", offset: 1.7 } });
    expect(rows.view_states.length).toBe(1);
    expect(rows.view_states[0].anchor).toEqual({ message_id: "m9", offset: 1 });
  });

  test("the in-page view is clamped on write, read back by a follower, and withheld with a private conversation", async () => {
    const rows = tables();
    await h(follow)(ctxFor(rows, BOB), { leader_id: ANN });
    await h(reportView)(ctxFor(rows, ANN), {
      path: "/docs/d1",
      view: { panel: " diff ", diff: { file: "src/a.ts", line: 12.6 }, scroll: { key: "doc", offset: 1.4 } },
    });
    expect(rows.view_states[0].view).toEqual({ panel: "diff", diff: { file: "src/a.ts", line: 12 }, scroll: { key: "doc", offset: 1 } });
    expect(await h(viewOf)(ctxFor(rows, BOB), { leader_id: ANN })).toMatchObject({ view: { scroll: { key: "doc", offset: 1 } } });
    await h(reportView)(ctxFor(rows, ANN), { path: `/conversation/${PRIVATE}`, conversation_id: PRIVATE, view: { diff: { file: "secret.ts" } } });
    expect(await h(viewOf)(ctxFor(rows, BOB), { leader_id: ANN })).toEqual({ path: "", updated_at: rows.view_states[0].updated_at, withheld: true });
    await h(reportView)(ctxFor(rows, ANN), { path: "/inbox", view: { scroll: { key: "", offset: 0.5 } } });
    expect(rows.view_states[0].view).toBeUndefined();
  });

  test("viewOf reaches only a live follower of that leader", async () => {
    const rows = tables();
    rows.view_states.push({ _id: "s1", user_id: ANN, path: "/inbox", updated_at: 5 });
    expect(await h(viewOf)(ctxFor(rows, BOB), { leader_id: ANN })).toBeNull();
    await h(follow)(ctxFor(rows, BOB), { leader_id: ANN });
    expect(await h(viewOf)(ctxFor(rows, BOB), { leader_id: ANN })).toMatchObject({ path: "/inbox", withheld: false });
    // Following Ann does not open Cy's view.
    rows.view_states.push({ _id: "s2", user_id: CY, path: "/docs", updated_at: 5 });
    expect(await h(viewOf)(ctxFor(rows, BOB), { leader_id: CY })).toBeNull();
  });

  test("a conversation the follower cannot open is withheld with its path", async () => {
    const rows = tables();
    await h(follow)(ctxFor(rows, BOB), { leader_id: ANN });
    rows.view_states.push({ _id: "s1", user_id: ANN, path: `/conversation/${PRIVATE}`, conversation_id: PRIVATE, anchor: { message_id: "m1", offset: 0.2 }, updated_at: 5 });
    expect(await h(viewOf)(ctxFor(rows, BOB), { leader_id: ANN })).toEqual({ path: "", updated_at: 5, withheld: true });
    rows.view_states[0] = { ...rows.view_states[0], path: `/conversation/${SHARED}`, conversation_id: SHARED };
    expect(await h(viewOf)(ctxFor(rows, BOB), { leader_id: ANN })).toMatchObject({ path: `/conversation/${SHARED}`, conversation_id: SHARED, withheld: false });
  });
});
