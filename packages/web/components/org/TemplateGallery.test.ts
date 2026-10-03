import { describe, expect, test } from "bun:test";
import { builtinHires, cadenceWords, cannotHireReason, displayTitle, EXECUTIVE_ASSISTANT_HIRE, HEAD_OF_PEOPLE_HIRE, type CatalogTemplate } from "./templateCatalog";

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
  test("a title's tokens read as words before any answer exists", () => {
    const m = { ...t().manifest, inputs: [{ key: "repo.name", label: "Repository", kind: "string" }] } as any;
    expect(displayTitle(m, "Merge pass for {{input.repo.name}}")).toBe("Merge pass for Repository");
    expect(displayTitle(m, "Weekly review of {{project.name}} as {{instance}}")).toBe("Weekly review of the project as the instance");
    expect(displayTitle(m, "{{input.unknown}} check")).toBe("… check");
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

// The roles codecast itself offers at the top of the gallery (org-staffing.md
// S6, S30): each until one stands, and never once it does.
describe("built-in hires", () => {
  test("both offered in an empty org; each hidden once it stands; a retired one counts as gone", () => {
    expect(builtinHires([], { assistant: false })).toEqual([HEAD_OF_PEOPLE_HIRE, EXECUTIVE_ASSISTANT_HIRE]);
    expect(builtinHires([{ handle: "growth", status: "active" }], { assistant: false })).toEqual([HEAD_OF_PEOPLE_HIRE, EXECUTIVE_ASSISTANT_HIRE]);
    expect(builtinHires([{ handle: "head-of-people", status: "active" }], { assistant: false })).toEqual([EXECUTIVE_ASSISTANT_HIRE]);
    // The old handle still names the Head of People.
    expect(builtinHires([{ handle: "chief-of-staff", status: "active" }], { assistant: false })).toEqual([EXECUTIVE_ASSISTANT_HIRE]);
    expect(builtinHires([{ handle: "head-of-people", status: "retired" }], { assistant: true })).toEqual([HEAD_OF_PEOPLE_HIRE]);
    expect(builtinHires([{ handle: "head-of-people", status: "active" }], { assistant: true })).toEqual([]);
  });
});
