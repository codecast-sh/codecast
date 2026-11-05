import { describe, expect, test } from "bun:test";
import { foldTallies, mergeTallySums, moveTally, readTallies, tallyAnswers, writeTallySums, type TallyInput } from "./replayTallies";
import { patchReplay } from "./replayIndex";
import { makeFakeDb } from "../testDb";

const owner = { workspace: "team:t1", source_id: "s1" as any };
const rec = (id: string, over: Partial<TallyInput> = {}): TallyInput & { _id: string; source_id: string; workspace: string; group_ids: string[] } => ({
  _id: id,
  source_id: "s1",
  workspace: "team:t1",
  external_id: `x-${id}`,
  user: { email: "ada@x.org" },
  duration_ms: 60_000,
  counts: { errors: 1, failed_requests: 0 },
  facts: { active_ms: 30_000 },
  group_ids: [],
  started_at: 1000,
  ...over,
} as any);

describe("replay tallies", () => {
  test("a person's row counts every recording and the part the default floor hides", async () => {
    const db = makeFakeDb({ replay_tallies: [] });
    await moveTally({ db }, owner, null, rec("a"));
    await moveTally({ db }, owner, null, rec("b", { facts: { active_ms: 1000 }, started_at: 2000 }));
    // Linked to an issue, a short recording is never hidden.
    await moveTally({ db }, owner, null, rec("c", { facts: { active_ms: 1000 }, group_ids: ["g1"] }));
    const [row] = db._tables.replay_tallies;
    expect([row.n, row.short_n, row.ms, row.short_ms, row.errors, row.last_at]).toEqual([3, 1, 180_000, 60_000, 3, 2000]);
    const read = readTallies(db._tables.replay_tallies, true);
    expect([read.total, read.below, read.people[0].sessions, read.people[0].short]).toEqual([2, 1, 2, 1]);
    expect(readTallies(db._tables.replay_tallies, false).total).toBe(3);
  });

  test("a patch through patchReplay moves the recording between people and across the floor", async () => {
    const db = makeFakeDb({ event_sources: [{ _id: "s1" }], replays: [rec("r1", { facts: undefined })], replay_tallies: [] });
    await moveTally({ db }, owner, null, db._tables.replays[0]);
    // Active time arrives under the floor: the row moves to the hidden side.
    await patchReplay({ db }, db._tables.replays[0], { facts: { at: 1, active_ms: 2000 } });
    expect([db._tables.replay_tallies[0].n, db._tables.replay_tallies[0].short_n]).toEqual([1, 1]);
    // The person is learned: the anonymous shard empties and the person's row holds it.
    await patchReplay({ db }, db._tables.replays[0], { user: { email: "bob@x.org" } });
    expect(db._tables.replay_tallies.map((r: any) => [r.person_key, r.n])).toEqual([["bob@x.org", 1]]);
  });

  test("recordings with no person spread over shards and count toward the total only", async () => {
    const db = makeFakeDb({ replay_tallies: [] });
    for (let i = 0; i < 20; i++) await moveTally({ db }, owner, null, rec(`n${i}`, { user: null }));
    expect(db._tables.replay_tallies.length).toBeGreaterThan(1);
    const read = readTallies(db._tables.replay_tallies, true);
    expect([read.total, read.people.length]).toEqual([20, 0]);
  });

  test("a recount folds pages and writes sums; a row a live write touched since is left", async () => {
    const rows = [rec("a"), rec("b", { user: { id: "d1" } }), rec("c", { started_at: 5000 })];
    const sums = mergeTallySums(new Map(), [...foldTallies(rows.slice(0, 2)).values()]);
    mergeTallySums(sums, [...foldTallies(rows.slice(2)).values()]);
    const db = makeFakeDb({ replay_tallies: [{ _id: "t9", ...owner, person_key: "d1", n: 7, updated_at: 99_999 }] });
    await writeTallySums({ db }, owner, [...sums.values()], 50_000);
    const by = Object.fromEntries(db._tables.replay_tallies.map((r: any) => [r.person_key, r]));
    expect([by["ada@x.org"].n, by["ada@x.org"].last_at, by.d1.n]).toEqual([2, 5000, 7]);
  });

  test("only an unfiltered list, at the default floor or none, reads the tallies", () => {
    expect(tallyAnswers({ active_min_ms: 5000 })).toBe(true);
    expect(tallyAnswers({})).toBe(true);
    expect(tallyAnswers({ active_min_ms: 30_000 })).toBe(false);
    expect(tallyAnswers({ active_min_ms: 5000, q: "ada" })).toBe(false);
    expect(tallyAnswers({ browser: "Chrome" } as any)).toBe(false);
  });
});
