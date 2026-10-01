import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { HEAD_OF_PEOPLE_JOB, HEAD_OF_PEOPLE_PROMPT, headOfPeopleOpening, headOfPeoplePrompt } from "./headOfPeoplePrompt";
import { ORG_CHANGE_KINDS, parseOrgProposalSpec } from "./orgProposal";

// The Head of People's prompt is the product decision written in
// docs/architecture/head-of-people-prompt.md; the code carries it word for word.

describe("the Head of People prompt", () => {
  test("is the text of the decision doc", () => {
    const doc = fs.readFileSync(path.join(import.meta.dir, "../../../docs/architecture/head-of-people-prompt.md"), "utf8");
    expect(HEAD_OF_PEOPLE_PROMPT).toBe(doc.trim());
  });

  test("fills the workspace and the person everywhere", () => {
    const p = headOfPeoplePrompt({ workspace: "Acme", person: "Ada" });
    expect(p).not.toMatch(/\{workspace\}|\{person\}/);
    expect(p.startsWith("You are the Head of People for Acme. You report to Ada.")).toBe(true);
    expect(p).toContain("where each of Ada's sessions belongs");
  });

  test("says leads report to the person by default, in one sentence", () => {
    expect(HEAD_OF_PEOPLE_PROMPT.match(/Leads report to \{person\} by default[^.]*\./g)).toHaveLength(1);
  });
  test("the reference's example parses with the reader cast org propose uses, and every shape it lists is a change kind", () => {
    const p = headOfPeoplePrompt({ workspace: "Acme", person: "Ada", mode: "init" });
    const json = p.split("```json\n")[1].split("\n```")[0];
    const parsed = parseOrgProposalSpec(JSON.parse(json));
    expect(parsed.errors).toEqual([]);
    expect(parsed.spec!.mode).toBe("init");
    const kinds = [...p.matchAll(/^- (\w+): \{/gm)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(5);
    for (const k of kinds) expect(ORG_CHANGE_KINDS as readonly string[]).toContain(k);
  });

  test("an open proposal is a fact in the reference; the team flag rides every workspace verb", () => {
    const p = headOfPeoplePrompt({ workspace: "Acme", person: "Ada", team: "Acme", open: { short_id: "op-3", title: "Company review: Acme", decided: 1, total: 4 } });
    expect(p).toContain('Still open: op-3 "Company review: Acme", 1 of 4 changes decided.');
    for (const verb of ["inputs", "health", "propose", "proposals"]) expect(p).toContain(`cast org ${verb} --team "Acme"`);
  });
});

// The opening is the structure role's (org-staffing.md S30), in the shape of
// every role's opening: whom it reports to, its job, how it wakes, where its
// sessions go, and where it remembers, in about 200 words. The right hand is
// the Chief of Staff's opening (chiefOfStaffPrompt.ts), not this one.
describe("the Head of People opening", () => {
  const o = headOfPeopleOpening({ workspace: "Acme", person: "Ada" });

  test("keeps the structure true: reviews weekly, proposes, applies nothing, holds the remainder, routes to the owner", () => {
    expect(o).not.toMatch(/\{workspace\}|\{person\}/);
    expect(o.startsWith("You are the Head of People for Acme. You report to Ada.")).toBe(true);
    expect(o).toContain("keep the company's structure true");
    expect(o).toContain("Company review");
    expect(o).toContain("apply nothing yourself");
    expect(o).toContain("goes to that lead (`cast role wake @handle");
    expect(o).toContain("with your recommendation attached");
    expect(o).toContain("What no lead owns is yours to look after");
    expect(o).not.toContain("right hand");
    expect(o).toContain("Start every turn with `cast brief`");
    expect(o).not.toContain("cast escalate");
    expect(o).toContain("raise in this thread");
    expect(o).toContain("Your brief is your memory between turns");
    const words = o.split(/\s+/).length;
    expect(words).toBeGreaterThan(150);
    expect(words).toBeLessThan(260);
  });

  test("its job paragraph is the charter", () => {
    expect(HEAD_OF_PEOPLE_JOB.startsWith("Your job is to keep the company's structure true")).toBe(true);
    expect(o).toContain(HEAD_OF_PEOPLE_JOB.split("{person}").join("Ada"));
  });
});
