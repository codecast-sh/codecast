import { describe, expect, test } from "bun:test";
import { builtinHires, cadenceWords, cannotHireReason, displayTitle, EXECUTIVE_ASSISTANT_HIRE, HEAD_OF_PEOPLE_HIRE, templateTools, visibleCatalog, type CatalogTemplate } from "./templateCatalog";
import { requiredInputs } from "./orgTemplateSpec";

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

describe("what a card says a template brings", () => {
  test("a workspace's own copy of a template replaces Codecast's, as the server reads it", () => {
    const own = t({ workspace: "team:t1", latest: { version: "2.0.1", digest: "b".repeat(64) } });
    expect(visibleCatalog([t(), own, t({ template_id: "on-call" })]).map((x) => `${x.template_id}@${x.workspace}`)).toEqual(["growth@team:t1", "on-call@codecast"]);
  });
  test("tools split into commands and skills; answers count only what a hire cannot go without", () => {
    const m = { ...t().manifest, tools: [{ id: "gads", kind: "command", path: "s/g.mjs", run: "node", summary: "Ads" }, { id: "ads-daily", kind: "skill", path: "skills/ads-daily" }],
      inputs: [{ key: "a", label: "A", kind: "string", required: true }, { key: "b", label: "B", kind: "string", required: true, default: "x" }, { key: "c", label: "C", kind: "string" }, { key: "s", label: "S", kind: "secret", required: true }] } as any;
    expect(templateTools(m)).toEqual({ commands: ["gads"], skills: ["ads-daily"] });
    expect(templateTools(t().manifest)).toEqual({ commands: [], skills: [] });
    expect(requiredInputs(m).map((i) => i.key)).toEqual(["a"]);
  });
});

describe("the instance a hire starts with", () => {
  test("the project part is cut at a word so the role's handle fits 32 characters", async () => {
    const { defaultInstance, handleFor, hireErrors } = await import("./orgTemplateSpec");
    const m = { id: "growth", role: { handle: "{{instance}}-cmo" } } as any;
    expect(defaultInstance("Public Launch & Fundraise", m)).toBe("public-launch-growth");
    expect(handleFor(m, defaultInstance("Public Launch & Fundraise", m))).toBe("public-launch-growth-cmo");
    expect(defaultInstance("Acme", m)).toBe("acme-growth");
    expect(defaultInstance("Supercalifragilisticexpialidocious", m)).toBe("growth");
    const template = t({ manifest: { ...t().manifest, role: { name: "CMO", handle: "{{instance}}-cmo", charter: "c.md" } } as any });
    const draft = { template, project: { _id: "p", title: "P" } as any, instance: "public-launch-fundraise-growth", config: {}, reportsTo: "me", seatHandle: null, updatePolicy: "stable" as const };
    expect(hireErrors(draft)).toEqual(["The role's handle @public-launch-fundraise-growth-cmo is longer than 32 characters: shorten the name"]);
  });
});
