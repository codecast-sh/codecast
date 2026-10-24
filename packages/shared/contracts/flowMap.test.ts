import { describe, expect, test } from "bun:test";
import { DAY_MS, shippedFixes, stationWords } from "./flowMap";

describe("shippedFixes", () => {
  const now = 100 * DAY_MS;
  const t = (id: string, o: Record<string, unknown> = {}) => ({ _id: id, short_id: `ct-${id}`, title: id, status: "done", ...o });
  test("under watch, verified when the watch ended quiet, regressed when a finding reopened it; the header's counts are the list's", () => {
    const rows = shippedFixes({
      watched: [t("w", { watch_until: now + 3 * DAY_MS, closed_at: now - 4 * DAY_MS }), t("v", { watch_until: now - DAY_MS }), t("open", { status: "open", watch_until: now - DAY_MS })],
      reopened: [{ task: t("r", { status: "open" }), at: now - DAY_MS, by: { source: "judge:comms", title: "came back", ref: "sg-1" } }],
      now,
    });
    expect(rows.map((r) => [r.taskId, r.state])).toEqual([["r", "regressed"], ["w", "watching"], ["v", "verified"]]);
    expect(rows[0]).toMatchObject({ reopenedAt: now - DAY_MS, reopenedBy: { source: "judge:comms", ref: "sg-1" } });
  });
  test("a problem shipped again after it came back stands by its new watch", () => {
    const rows = shippedFixes({ watched: [t("x", { watch_until: now + DAY_MS })], reopened: [{ task: t("x"), at: now - 5 * DAY_MS, by: null }], now });
    expect(rows.map((r) => r.state)).toEqual(["watching"]);
  });
});

describe("stationWords", () => {
  test("an id reads as words, a segment's station by its own part", () => {
    expect(["plan_gate", "decide__decide", "rebase", "land-again"].map(stationWords)).toEqual(["Plan gate", "Decide", "Rebase", "Land again"]);
  });
});
