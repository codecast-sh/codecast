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

test("j and k from the home walk every row that opens an issue: issues and replay rows naming one, once each", () => {
  const g = (id: string) => ({ _id: id, short_id: id }) as any;
  const items = [
    { kind: "watch", group: g("eg-1") },
    { kind: "issue", group: g("eg-2") },
    { kind: "replay", group: g("eg-3") },
    { kind: "replay", group: null },
    { kind: "issue", group: g("eg-2") },
  ] as any;
  expect(homeIssueRefs(items)).toEqual(["eg-2", "eg-3"]);
});
