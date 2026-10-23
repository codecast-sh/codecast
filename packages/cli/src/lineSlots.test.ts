import { describe, expect, test } from "bun:test";
import { LineSlotsReporter, readLineSlots } from "./lineSlots";

const origins: Record<string, string> = { "/home/ubuntu/union-mobile": "git@github.com:Union-AI/union-mobile.git" };
const originOf = (root: string) => origins[root];

describe("line slots", () => {
  test("reads declared checkouts with a normalized origin", () => {
    expect(readLineSlots({ line: { checkouts: [{ root: "/home/ubuntu/union-mobile/", runs: 10 }] } }, originOf))
      .toEqual([{ root: "/home/ubuntu/union-mobile", origin: "github.com/union-ai/union-mobile", runs: 10 }]);
  });

  test("skips entries without a root or a positive run count", () => {
    expect(readLineSlots({ line: { checkouts: [{ root: "", runs: 3 }, { root: "/x", runs: 0 }] } }, originOf)).toEqual([]);
    expect(readLineSlots({}, originOf)).toEqual([]);
  });

  test("sends only on change, and [] once when the declaration goes", () => {
    const r = new LineSlotsReporter();
    const cfg = { line: { checkouts: [{ root: "/home/ubuntu/union-mobile", runs: 10 }] } };
    expect(r.next({}, 0, originOf)).toBeUndefined();
    expect(r.next(cfg, 1, originOf)).toHaveLength(1);
    expect(r.next(cfg, 2, originOf)).toBeUndefined();
    expect(r.next(cfg, 11 * 60_000, originOf)).toHaveLength(1);
    expect(r.next({}, 11 * 60_000 + 1, originOf)).toEqual([]);
  });
});
