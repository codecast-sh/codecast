import { expect, test } from "bun:test";
import { fitTabs } from "./tabFit";
import { homeIssueRefs } from "./opsHomeModel";

test("tabs that fit are all drawn; past the width the tail folds and the active tab stays", () => {
  const w = [90, 80, 70, 80, 80, 60];
  expect(fitTabs(w, 1000, 76, 2, 0)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(fitTabs(w, 330, 76, 2, 0)).toEqual([0, 1, 2]);
  // Apps is open on a narrow bar: it takes the last place rather than folding away.
  expect(fitTabs(w, 330, 76, 2, 5)).toEqual([0, 1, 5]);
  // Not measured yet: draw everything so it can be measured.
  expect(fitTabs([0, 0, 0], 100, 76, 2, 0)).toEqual([0, 1, 2]);
});

test("a narrow bar keeps the most opened tabs first, drawn in bar order", () => {
  // Overview, Timeline, Issues, Replays, Metrics, Apps; ranked Overview, Issues, Replays, Metrics, Timeline, Apps.
  const w = [90, 80, 70, 80, 80, 60];
  const rank = [0, 2, 3, 4, 1, 5];
  expect(fitTabs(w, 250, 76, 2, 0, rank)).toEqual([0, 2]);
  expect(fitTabs(w, 330, 76, 2, 0, rank)).toEqual([0, 2, 3]);
  // Timeline open: it takes the last kept place.
  expect(fitTabs(w, 330, 76, 2, 1, rank)).toEqual([0, 1, 2]);
});

test("j and k from the home walk every issue the rows hold, once each: a folded row's variants and an alerting watch's metric issue", () => {
  const NOW = Date.UTC(2026, 10, 3, 12);
  const g = (id: string) => ({ _id: id, short_id: id, kind: "error", status: "open", first_seen: NOW - 3_600_000, last_seen: NOW - 60_000, count: 3, buckets: [] }) as any;
  const items = [
    { kind: "watch", group: g("eg-1") },
    { kind: "issue", group: g("eg-2"), variants: [g("eg-2"), g("eg-4")] },
    { kind: "replay", group: null },
    { kind: "issue", group: g("eg-2") },
  ] as any;
  expect(homeIssueRefs(items, NOW)).toEqual(["eg-1", "eg-2", "eg-4"]);
});
