import { describe, expect, test } from "bun:test";

// Regulated health data (HIPAA): a team's policy marks the browser regulated,
// and lib/analytics.ts then loads neither PostHog nor Sentry. The vendor side is
// checked in the browser; this pins the decision and its memory across loads.
const store = new Map<string, string>();
(globalThis as any).localStorage ??= {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { teamsHoldRegulatedData: regulatedDataOf } = await import("@codecast/shared/contracts");
const analytics = await import("../analytics");

describe("regulated health data", () => {
  test("any team with regulated_data marks the viewer; an unanswered feed decides nothing", () => {
    expect(regulatedDataOf([{ policy: { public_sharing_disabled: true } }, { policy: { regulated_data: true } }])).toBe(true);
    expect(regulatedDataOf([{ policy: {} }, { policy: { regulated_data: false } }, null])).toBe(false);
    expect(regulatedDataOf([])).toBeNull();
    expect(regulatedDataOf(undefined)).toBeNull();
  });

  test("the marker outlives the page so the next load starts quiet, and clears when no team holds it", () => {
    analytics.setRegulatedData(true);
    expect(analytics.isRegulatedData()).toBe(true);
    expect(localStorage.getItem("codecast.regulated-data")).toBe("1");
    analytics.setRegulatedData(false);
    expect(analytics.isRegulatedData()).toBe(false);
    expect(localStorage.getItem("codecast.regulated-data")).toBeNull();
  });
});
