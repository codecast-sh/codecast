// The seen record (tours/seen.ts): one home on clientState.tips, legacy
// records honoured, a finish upgrades a skip, writes suppressed on stub data.
// Run: bun test tours/seen.test.ts
import { describe, expect, test } from "bun:test";
import { isTourSeen, markTourSeen, tourOutcome, tourSeenId, toursWriteSuppressed, type TourSeenState } from "./seen";
import type { TourDef } from "./types";

const base: TourDef = { id: "org-page", title: "The org page", teaches: "x", area: "org", route: null, steps: [], legacy: { tips: ["nux-tour"], ui: ["org_nux_seen"] } };

function store(tips: TourSeenState["clientState"]["tips"] = {}, ui: Record<string, unknown> = {}): TourSeenState & { writes: unknown[] } {
  const st = {
    clientState: { tips, ui },
    writes: [] as unknown[],
    updateClientTips(partial: Record<string, unknown>) {
      st.writes.push(partial);
      Object.assign(st.clientState.tips as object, partial);
    },
  };
  return st as unknown as TourSeenState & { writes: unknown[] };
}

describe("the seen record", () => {
  test("unseen until finished or dismissed", () => {
    const st = store();
    expect(isTourSeen(base, st.clientState)).toBe(false);
    expect(tourOutcome(base, st.clientState)).toBe(null);
    markTourSeen(st, "org-page", "skipped");
    expect(st.clientState.tips?.dismissed).toEqual([tourSeenId("org-page")]);
    expect(isTourSeen(base, st.clientState)).toBe(true);
    expect(tourOutcome(base, st.clientState)).toBe("skipped");
  });

  test("a finish after a skip upgrades the record; a second mark writes nothing", () => {
    const st = store();
    markTourSeen(st, "org-page", "skipped");
    markTourSeen(st, "org-page", "finished");
    expect(tourOutcome(base, st.clientState)).toBe("finished");
    const writes = st.writes.length;
    markTourSeen(st, "org-page", "finished");
    markTourSeen(st, "org-page", "skipped");
    expect(st.writes.length).toBe(writes);
  });

  test("records written before the tours existed count", () => {
    expect(isTourSeen(base, { tips: { completed: ["nux-tour"] }, ui: {} })).toBe(true);
    expect(tourOutcome(base, { tips: { completed: ["nux-tour"] }, ui: {} })).toBe("finished");
    expect(isTourSeen(base, { tips: {}, ui: { org_nux_seen: true } })).toBe(true);
    expect(tourOutcome(base, { tips: {}, ui: { org_nux_seen: true } })).toBe("skipped");
    expect(isTourSeen({ ...base, legacy: undefined }, { tips: { completed: ["nux-tour"] }, ui: { org_nux_seen: true } })).toBe(false);
  });

  test("other tours' records do not count", () => {
    expect(isTourSeen(base, { tips: { completed: [tourSeenId("org-role")] }, ui: {} })).toBe(false);
  });

  test("the preview flag suppresses writes", () => {
    expect(toursWriteSuppressed("?preview=1")).toBe(true);
    expect(toursWriteSuppressed("?proposal=op-3&preview=1")).toBe(true);
    expect(toursWriteSuppressed("?preview=10")).toBe(false);
    expect(toursWriteSuppressed("")).toBe(false);
    expect(toursWriteSuppressed("?tour=org-page")).toBe(false);
  });
});
