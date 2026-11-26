import { describe, expect, test } from "bun:test";
import { TRIAGE_REASONS, triageSectionOf, type TriageReason } from "@codecast/shared/contracts/triage";
import { LAB_DEFAULTS, LAB_SCENARIOS, runLab } from "./labModel";

const NOW = Date.UTC(2026, 10, 25, 12);

describe("triage lab scenarios", () => {
  for (const sc of LAB_SCENARIOS) {
    test(sc.title, () => {
      const { triage } = runLab({ ...LAB_DEFAULTS, ...sc.facts }, NOW);
      expect(triage.reason).toBe(sc.expect);
      if (sc.expectSection !== undefined) expect(triageSectionOf(triage)).toBe(sc.expectSection);
    });
  }
});

test("every reason has a lab scenario that reaches it", () => {
  const reached = new Set(LAB_SCENARIOS.map((s) => s.expect));
  const missing = (Object.keys(TRIAGE_REASONS) as TriageReason[]).filter((r) => !reached.has(r));
  expect(missing).toEqual([]);
});
