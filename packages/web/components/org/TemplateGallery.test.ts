import { describe, expect, test } from "bun:test";
import { cadenceWords, cannotHireReason, type CatalogTemplate } from "./TemplateGallery";

// The gallery's honesty rules (org-hire.md H3): a card offers the hire only
// when this workspace can take it, and says why not otherwise.
const t = (patch: Partial<CatalogTemplate> = {}): CatalogTemplate => ({
  template_id: "growth", workspace: "codecast", name: "CMO", description: "d", latest: { version: "2.0.0", digest: "a".repeat(64) }, installable: true,
  asks: { inputs: 0, secrets: 0, authority: 0, setup: 0, routines: 0 }, manifest: { schemaVersion: 2, id: "growth", version: "2.0.0", name: "CMO", description: "d", role: { name: "CMO", handle: "x", charter: "c.md", caps: { hands_per_day: 1, wakes_per_day: 1, tokens_per_day: 1 } }, routines: [] } as any, ...patch,
});

describe("template gallery", () => {
  test("a card cannot hire without an installable release or a project to lead", () => {
    expect(cannotHireReason(t(), 1)).toBeNull();
    expect(cannotHireReason(t({ installable: false }), 1)).toMatch(/published without the files/);
    expect(cannotHireReason(t(), 0)).toMatch(/Create a project/);
    expect(cannotHireReason(t({ installable: undefined }), 1)).toMatch(/Not ready/);
  });
  test("cadence in words", () => {
    expect(cadenceWords("1d")).toBe("daily");
    expect(cadenceWords("7d")).toBe("weekly");
    expect(cadenceWords("2d")).toBe("every 2 days");
    expect(cadenceWords("14d")).toBe("every two weeks");
    expect(cadenceWords("1h")).toBe("every hour");
    expect(cadenceWords("30m")).toBe("every 30 minutes");
    expect(cadenceWords("weird")).toBe("every weird");
  });
});
