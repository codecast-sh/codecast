import { describe, expect, test } from "bun:test";
import { AFTER_CLOSE_MAX, type AfterCloseResult } from "@codecast/shared/contracts/closeKind";
import type { InboxBucket, WorkState } from "@codecast/shared/contracts";
import { askLine, claimCloseAdvice, closeAdviceCard, closeAdviceTargets, requestCloseAdvice, withCloseAdvice, type CloseAdvicePlacement, type CloseAdviceRow, type PendingCloseAdvice } from "./closeAdviceBar";

type Row = CloseAdviceRow & { owner: string; team: string | null };
const row = (id: string, extra: Partial<Row> = {}): Row => ({ _id: id, updated_at: 100, owner: "me", team: null, ...extra });

/** A bare bucket places the row with that work state (idle for a bucket that is not one). */
const placed = (bucket: InboxBucket, state?: WorkState): CloseAdvicePlacement =>
  ({ bucket, state: state ?? (bucket === "working" || bucket === "needs_input" || bucket === "done" || bucket === "dormant" ? bucket : "idle") });

function targets(rows: Row[], buckets: Record<string, InboxBucket | CloseAdvicePlacement>, opts: { featureTeams?: Array<string | null> } = {}) {
  const byId = new Map(rows.map((r) => [r._id, r]));
  const on = new Set(opts.featureTeams ?? [null, "t1"]);
  return closeAdviceTargets(rows.map((r) => r._id), {
    row: (id) => byId.get(id),
    placement: (id) => {
      const p = buckets[id];
      return typeof p === "string" ? placed(p) : p;
    },
    featureOn: (r) => on.has(r.team),
    mine: (r) => r.owner === "me",
  });
}

describe("which closed rows are asked about", () => {
  test("a row filed outside Needs You is asked about; Needs You and Questions are not", () => {
    const rows = [row("done"), row("dormant"), row("needs"), row("question"), row("pinned"), row("unplaced")];
    expect(targets(rows, { done: "done", dormant: "dormant", needs: "needs_input", question: "questions", pinned: "pinned" }))
      .toEqual(["done", "dormant", "pinned", "unplaced"]);
  });

  test("a row the inbox shows as Working is not asked about: it has asked nothing yet; a Sleeping one still is", () => {
    const rows = [row("working"), row("sleeping"), row("idle")];
    expect(targets(rows, { working: "working", sleeping: "dormant", idle: "idle" })).toEqual(["sleeping", "idle"]);
  });

  test("a pinned row still at work is not asked about; a pinned row that finished still is", () => {
    const rows = [row("running"), row("finished"), row("rider")];
    expect(targets(rows, {
      running: placed("pinned", "working"),
      finished: placed("pinned", "done"),
      // A rider files under its lead's bucket; its own work state still says it runs.
      rider: placed("done", "working"),
    })).toEqual(["finished"]);
  });

  test("a row the person filed Done is not asked about, unless activity since expired that", () => {
    const filed = row("filed", { inbox_rest: "done", inbox_rest_at: 200, updated_at: 100 });
    const expired = row("expired", { inbox_rest: "done", inbox_rest_at: 50, updated_at: 100 });
    const sleeping = row("sleeping", { inbox_rest: "dormant", inbox_rest_at: 200, updated_at: 100 });
    expect(targets([filed, expired, sleeping], { filed: "done", expired: "done", sleeping: "dormant" })).toEqual(["expired", "sleeping"]);
  });

  test("a row on the Closed or Stashed shelf is the person's own filing and is not asked about", () => {
    const rows = [row("closed"), row("stashed"), row("quiet")];
    expect(targets(rows, { closed: "dismissed", stashed: "stashed", quiet: "done" })).toEqual(["quiet"]);
  });

  test("so is a snoozed row", () => {
    expect(targets([row("snoozed"), row("quiet")], { snoozed: "snoozed", quiet: "done" })).toEqual(["quiet"]);
  });

  test("a row the placement does not cover is read off its own stamps: Closed, Stashed and Snoozed are the person's", () => {
    const rows = [
      row("closed", { inbox_dismissed_at: 50 }),
      row("stashed", { inbox_stashed_at: 50 }),
      row("snoozed", { inbox_snoozed_until: 500 }),
      row("woke", { inbox_snoozed_until: 50 }),
      row("plain"),
    ];
    expect(targets(rows, {})).toEqual(["plain"]);
    // The placement, when it has the row, outranks its stamps.
    expect(targets([row("stashed", { inbox_stashed_at: 50 })], { stashed: "done" })).toEqual(["stashed"]);
  });

  test("a teammate's session and a workspace without the feature are never asked about", () => {
    const rows = [row("mine"), row("theirs", { owner: "them" }), row("offteam", { team: "t2" })];
    expect(targets(rows, {})).toEqual(["mine"]);
    expect(targets(rows, {}, { featureTeams: [] })).toEqual([]);
  });

  test("at most AFTER_CLOSE_MAX, the first of the gesture, each once", () => {
    const rows = Array.from({ length: AFTER_CLOSE_MAX + 5 }, (_, i) => row(`s${i}`));
    const got = targets([...rows, rows[0]!], {});
    expect(got).toHaveLength(AFTER_CLOSE_MAX);
    expect(got[0]).toBe("s0");
    expect(new Set(got).size).toBe(got.length);
  });
});

const advice = (over: Partial<PendingCloseAdvice> = {}): PendingCloseAdvice => ({
  verb: "Closed",
  ids: ["a"],
  targets: ["a"],
  titles: { a: "Owners redesign", b: "Eval audit", c: "Stripe SDK" },
  verdict: Promise.resolve(null),
  keep: () => {},
  ...over,
});
const asks = (...pairs: Array<[string, string]>): AfterCloseResult[] => pairs.map(([session, reason]) => ({ session, verdict: "needs_you", reason }));

describe("the card the bar becomes", () => {
  test("one Close that asked: its title, the reason, Undo and Open", () => {
    expect(closeAdviceCard(advice(), asks(["a", "Decide whether to file both follow-ups as tasks"]))).toEqual({
      title: "Closed “Owners redesign”",
      ask: "Decide whether to file both follow-ups as tasks",
      triggers: undefined,
      action: { label: "Open", sessions: ["a"], open: true },
    });
  });

  test("a Kill says Killed", () => {
    expect(closeAdviceCard(advice({ verb: "Killed" }), asks(["a", "Pick a sort order"]))?.title).toBe("Killed “Owners redesign”");
  });

  test("close, skip, an error and a timeout leave the receipt as it is", () => {
    expect(closeAdviceCard(advice(), [{ session: "a", verdict: "close" }])).toBeNull();
    expect(closeAdviceCard(advice(), [{ session: "a", verdict: "skip" }])).toBeNull();
    expect(closeAdviceCard(advice(), null)).toBeNull();
    expect(closeAdviceCard(advice(), [])).toBeNull();
  });

  test("a verdict for a session that was not asked about is ignored", () => {
    expect(closeAdviceCard(advice(), asks(["zz", "Answer it"]))).toBeNull();
  });

  test("bulk: Closed N sessions, K asked you something, Keep K restores only those", () => {
    const bulk = advice({ ids: Array.from({ length: 14 }, (_, i) => (i < 3 ? "abc"[i]! : `x${i}`)), targets: ["a", "b", "c"] });
    const card = closeAdviceCard(bulk, [...asks(["a", "Pick one"], ["c", "Reply"]), { session: "b", verdict: "close" }]);
    expect(card).toEqual({
      title: "Closed 14 sessions",
      ask: "2 asked you something",
      triggers: undefined,
      action: { label: "Keep 2", sessions: ["a", "c"], open: false },
    });
  });

  test("bulk with one that asked: the single card naming it, counting the rest", () => {
    const bulk = advice({ ids: ["a", "b", "c"], targets: ["a", "b", "c"] });
    const card = closeAdviceCard(bulk, [...asks(["b", "Reopen Chrome"]), { session: "a", verdict: "close" }]);
    expect(card).toEqual({
      title: "Closed “Eval audit” and 2 more",
      ask: "Reopen Chrome",
      triggers: undefined,
      action: { label: "Open", sessions: ["b"], open: true },
    });
  });

  test("the reason is one line; the bar clamps it to two lines on screen", () => {
    expect(askLine("  Decide\n\nwhether   to merge  ")).toBe("Decide whether to merge");
    expect(askLine(undefined)).toBe("It asked you something");
    const long = "Decide ".repeat(80).trim();
    expect(closeAdviceCard(advice(), asks(["a", long]))?.ask).toBe(long);
  });

  test("a Kill that also canceled triggers: the ask first, the triggers line second", () => {
    const card = closeAdviceCard(advice({ verb: "Killed", triggers: "Also canceled trigger \"Nightly\"" }), asks(["a", "Pick a sort order"]));
    expect(card?.ask).toBe("Pick a sort order");
    expect(card?.triggers).toBe("Also canceled trigger \"Nightly\"");
  });
});

describe("the call and its hand-off to the bar", () => {
  test("the verdicts come back; an error or a slow answer is null and never throws", async () => {
    const results = asks(["a", "Reply"]);
    expect(await requestCloseAdvice(async () => ({ results }), ["a"], 1000)).toEqual(results);
    expect(await requestCloseAdvice(async () => { throw new Error("down"); }, ["a"], 1000)).toBeNull();
    expect(await requestCloseAdvice(() => { throw new Error("sync"); }, ["a"], 1000)).toBeNull();
    expect(await requestCloseAdvice(() => new Promise(() => {}), ["a"], 5)).toBeNull();
  });

  test("the bar raised inside the gesture's write claims its advice, once; nothing else can", () => {
    const a = advice();
    let claimed: PendingCloseAdvice | null = null;
    let second: PendingCloseAdvice | null = a;
    withCloseAdvice(a, () => {
      claimed = claimCloseAdvice();
      second = claimCloseAdvice();
    });
    expect(claimed).toBe(a);
    expect(second).toBeNull();
    withCloseAdvice(a, () => {});
    expect(claimCloseAdvice()).toBeNull();
  });
});
