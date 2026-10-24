import { describe, expect, test } from "bun:test";
import { LineSlotsReporter, readLineSlots } from "./lineSlots";

const origins: Record<string, string> = { "/home/ubuntu/union-mobile": "git@github.com:Union-AI/union-mobile.git" };
const originOf = (root: string) => origins[root];

describe("line slots", () => {
  test("reads declared checkouts with a normalized origin", () => {
    expect(readLineSlots({ line: { checkouts: [{ root: "/home/ubuntu/union-mobile/", runs: 10 }] } }, originOf))
      .toEqual([{ root: "/home/ubuntu/union-mobile", origin: "github.com/union-ai/union-mobile", runs: 10 }]);
  });

  test("skips entries without a root or a run count; 0 runs stays in the pool with no room", () => {
    expect(readLineSlots({ line: { checkouts: [{ root: "", runs: 3 }, { root: "/x", runs: -1 }, { root: "/y", runs: Number.NaN }] } }, originOf)).toEqual([]);
    expect(readLineSlots({ line: { checkouts: [{ root: "/home/ubuntu/union-mobile", runs: 0 }] } }, originOf))
      .toEqual([{ root: "/home/ubuntu/union-mobile", origin: "github.com/union-ai/union-mobile", runs: 0 }]);
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

  test("a checkout whose disk is full is offered with no runs until it has room, and the change is logged (2026-10-24)", () => {
    const logs: string[] = [];
    const r = new LineSlotsReporter((m) => logs.push(m));
    const cfg = { line: { checkouts: [{ root: "/home/ubuntu/union-mobile", runs: 10 }] } };
    let hold: string | null = null;
    expect(r.next(cfg, 1, originOf, () => hold)?.[0]?.runs).toBe(10);
    hold = "disk 100% full";
    expect(r.next(cfg, 2, originOf, () => hold)?.[0]?.runs).toBe(0);
    expect(r.next(cfg, 3, originOf, () => hold)).toBeUndefined();
    hold = null;
    expect(r.next(cfg, 4, originOf, () => hold)?.[0]?.runs).toBe(10);
    expect(logs).toEqual(["[LINE] /home/ubuntu/union-mobile takes no line runs: disk 100% full", "[LINE] /home/ubuntu/union-mobile takes line runs again: its disk has room"]);
  });
});
