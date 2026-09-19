import { describe, expect, test } from "bun:test";
import { initiativeLine, parseInitiativeHealth, parseInitiativeStatus, progressText, scopeSentence } from "./initiativeCommand";

const c = { green: "", yellow: "", red: "", cyan: "", dim: "", bold: "", reset: "" };

describe("cast initiative: reading what a person types", () => {
  test("a health in any spelling", () => {
    for (const t of ["on_track", "on-track", "On Track", "ontrack"]) expect(parseInitiativeHealth(t)).toBe("on_track");
    expect(parseInitiativeHealth("at risk")).toBe("at_risk");
    expect(parseInitiativeHealth("fine")).toBeNull();
  });
  test("a status", () => {
    expect(parseInitiativeStatus("Active")).toBe("active");
    expect(parseInitiativeStatus("done")).toBeNull();
  });
});

describe("cast initiative ls", () => {
  test("one line carries status, owner, projects, progress, health with its date and the target", () => {
    const line = initiativeLine(c, {
      short_id: "in-3", title: "Win enterprise", status: "active", health: "at_risk", health_at: Date.UTC(2026, 8, 18),
      owner_label: "@growth", projects: [{}, {}], task_counts: { total: 8, done: 2 }, target_date: Date.UTC(2026, 11, 1),
    });
    expect(line).toBe("  ◉ in-3 Win enterprise At risk (2026-09-18) Active | @growth | 2 projects | 2/8 done (25%) | target 2026-12-01");
  });
  test("no owner and no update are said plainly", () => {
    const line = initiativeLine(c, { short_id: "in-1", title: "T", status: "proposed", health: "none", project_ids: [] });
    expect(line).toContain("No update");
    expect(line).toContain("no owner");
    expect(progressText({ total: 0, done: 0 })).toBe("no tasks");
  });
});

describe("the owner role's scope, in one sentence", () => {
  const titleOf = (id: string) => ({ p: "Growth", q: "Billing" }[id] ?? id);
  test("nothing happened", () => {
    expect(scopeSentence("@growth", null, titleOf)).toBeNull();
    expect(scopeSentence("@growth", { added: [], listed: ["p"], skipped: [] }, titleOf)).toBeNull();
    expect(scopeSentence("@growth", { added: [], listed: [], skipped: [{ project_id: "p", reason: "whole_workspace" }] }, titleOf)).toBeNull();
  });
  test("what was added, what was not and why, and who was taken over", () => {
    const s = scopeSentence("@growth", {
      added: ["p"], listed: [], skipped: [{ project_id: "q", reason: "not_admin" }], took_over: "@growth took over 2 sessions.",
    }, titleOf);
    expect(s).toBe("@growth now has Growth in its scope. Billing was not added to its scope: only an admin of the role may change its scope. @growth took over 2 sessions.");
  });
});
