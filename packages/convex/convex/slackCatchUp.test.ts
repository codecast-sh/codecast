import { describe, expect, test } from "bun:test";
import { CATCH_UP_OVERLAP_S, FIRST_RUN_WINDOW_S, catchUpFloor, planCatchUp } from "./slackCatchUp";

const NOW = 1_800_000_000;

describe("catchUpFloor", () => {
  test("reads from the mark less the overlap", () => {
    expect(catchUpFloor({ caught_up_ts: String(NOW - 3600), since_ts: "0" }, NOW)).toBe(NOW - 3600 - CATCH_UP_OVERLAP_S);
  });

  test("an outage longer than any window is still covered from the mark", () => {
    const mark = NOW - 10 * 86_400;
    expect(catchUpFloor({ caught_up_ts: String(mark), since_ts: "0" }, NOW)).toBe(mark - CATCH_UP_OVERLAP_S);
  });

  test("a first run reads the first run window", () => {
    expect(catchUpFloor({ since_ts: "0" }, NOW)).toBe(NOW - FIRST_RUN_WINDOW_S);
  });

  test("never reads before the link's own floor", () => {
    expect(catchUpFloor({ since_ts: String(NOW - 60) }, NOW)).toBe(NOW - 60);
    expect(catchUpFloor({ caught_up_ts: String(NOW - 3600), since_ts: String(NOW - 600) }, NOW)).toBe(NOW - 600);
  });
});

describe("planCatchUp", () => {
  const floor = NOW - 3600;
  const msgs = [
    { ts: String(NOW - 60) },                                                  // new root
    { ts: String(NOW - 120), subtype: "file_share" },                          // new root with a file
    { ts: String(NOW - 180), subtype: "channel_join" },                        // notice: not a line
    { ts: String(NOW - 7200) },                                                 // old root, already covered
    { ts: String(NOW - 86_400), reply_count: 4, latest_reply: String(NOW - 30) }, // old root, new reply
    { ts: String(NOW - 90_000), reply_count: 2, latest_reply: String(NOW - 80_000) }, // old thread, quiet
  ];

  test("takes new roots and the threads that moved past the floor", () => {
    const plan = planCatchUp(msgs, floor, true);
    expect(plan.roots.map((m) => m.ts)).toEqual([String(NOW - 60), String(NOW - 120)]);
    expect(plan.threadRoots).toEqual([String(NOW - 86_400)]);
  });

  test("no thread reads when the link leaves threads out", () => {
    expect(planCatchUp(msgs, floor, false).threadRoots).toEqual([]);
  });
});
