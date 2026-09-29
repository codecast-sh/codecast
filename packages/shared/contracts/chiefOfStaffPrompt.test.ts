import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { CHIEF_OF_STAFF_JOB, CHIEF_OF_STAFF_PROMPT, chiefOfStaffOpening, chiefOfStaffPrompt } from "./chiefOfStaffPrompt";
import { ORG_CHANGE_KINDS, parseOrgProposalSpec } from "./orgProposal";

// The Chief of Staff's prompt is the product decision written in
// docs/architecture/chief-of-staff-prompt.md; the code carries it word for word.

describe("the Chief of Staff prompt", () => {
  test("is the text of the decision doc", () => {
    const doc = fs.readFileSync(path.join(import.meta.dir, "../../../docs/architecture/chief-of-staff-prompt.md"), "utf8");
    expect(CHIEF_OF_STAFF_PROMPT).toBe(doc.trim());
  });

  test("fills the workspace and the person everywhere", () => {
    const p = chiefOfStaffPrompt({ workspace: "Acme", person: "Ada" });
    expect(p).not.toMatch(/\{workspace\}|\{person\}/);
    expect(p.startsWith("You are the Chief of Staff for Acme. You report to Ada.")).toBe(true);
    expect(p).toContain("where each of Ada's sessions belongs");
  });

  test("says leads report to the person by default, in one sentence", () => {
    expect(CHIEF_OF_STAFF_PROMPT.match(/Leads report to \{person\} by default[^.]*\./g)).toHaveLength(1);
  });
  test("the reference's example parses with the reader cast org propose uses, and every shape it lists is a change kind", () => {
    const p = chiefOfStaffPrompt({ workspace: "Acme", person: "Ada", mode: "init" });
    const json = p.split("```json\n")[1].split("\n```")[0];
    const parsed = parseOrgProposalSpec(JSON.parse(json));
    expect(parsed.errors).toEqual([]);
    expect(parsed.spec!.mode).toBe("init");
    const kinds = [...p.matchAll(/^- (\w+): \{/gm)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(5);
    for (const k of kinds) expect(ORG_CHANGE_KINDS as readonly string[]).toContain(k);
  });

  test("an open proposal is a fact in the reference; the team flag rides every workspace verb", () => {
    const p = chiefOfStaffPrompt({ workspace: "Acme", person: "Ada", team: "Acme", open: { short_id: "op-3", title: "Company review: Acme", decided: 1, total: 4 } });
    expect(p).toContain('Still open: op-3 "Company review: Acme", 1 of 4 changes decided.');
    for (const verb of ["inputs", "health", "propose", "proposals"]) expect(p).toContain(`cast org ${verb} --team "Acme"`);
  });
});

// The opening is the right hand's (org-staffing.md S26), in the shape of every
// role's opening: whom it reports to, its job, how it wakes, where its
// sessions go, and where it remembers, in about 200 words.
describe("the Chief of Staff opening", () => {
  const o = chiefOfStaffOpening({ workspace: "Acme", person: "Ada" });

  test("is the right hand's: goals in view, answers anything, routes to the owner, decides with a recommendation, owns what no lead owns", () => {
    expect(o).not.toMatch(/\{workspace\}|\{person\}/);
    expect(o.startsWith("You are the Chief of Staff for Acme. You report to Ada, as their right hand")).toBe(true);
    expect(o).toContain("keep Ada's goals in view");
    expect(o).toContain("Answer anything Ada asks");
    expect(o).toContain("goes to that lead (`cast role wake @handle");
    expect(o).toContain("with your recommendation attached");
    expect(o).toContain("What no lead owns is yours to look after");
    expect(o).toContain("your weekly Company review runs it");
    expect(o).toContain("Start every turn with `cast brief`");
    expect(o).not.toContain("cast escalate");
    expect(o).toContain("raise in this thread");
    expect(o).toContain("Your brief is your memory between turns");
    const words = o.split(/\s+/).length;
    expect(words).toBeGreaterThan(150);
    expect(words).toBeLessThan(260);
  });

  test("its job paragraph is the charter", () => {
    expect(CHIEF_OF_STAFF_JOB.startsWith("Your job is to keep {person}'s goals in view")).toBe(true);
    expect(o).toContain(CHIEF_OF_STAFF_JOB.split("{person}").join("Ada"));
  });
});
