// The summary a person reads cold (org-staffing.md S17): the ask split from
// its evidence line, the first sentence in front, the groups with counts,
// the budget arithmetic from the tree, the intro rule, the kind words, and
// the glossary's examples from the reader's own workspace.
import { describe, expect, test } from "bun:test";
import { ORG_FIXTURE } from "./orgFixture";
import { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_PROPOSAL } from "./orgStaffingFixture";
import { hasAcceptedBefore, splitAsk } from "./staffingModel";
import { CHANGE_KIND_META, changeLine, kindDescription, kindLabel } from "./orgMeta";
import { GLOSSARY_ORDER, HOW_THIS_WORKS, glossaryEntries } from "./orgGlossaryWords";
import { ORG_CHANGE_KINDS } from "@codecast/shared/contracts/orgProposal";

const P = ORG_STAFFING_FIXTURE_PROPOSAL;

describe("the ask", () => {
  test("the first paragraph is the ask, the rest is the tail, and the evidence line becomes the href behind the Evidence control", () => {
    const md = "**The ask.** Accept the record changes as one group. Then 11 filings.\n\nWhat I looked at: every plan and task.\n\nWhat could not be verified: two sessions.\n\nEvidence, what could not be verified, findings and escalations: https://codecast.sh/a/a6ox";
    expect(splitAsk(md)).toEqual({ ask: "**The ask.** Accept the record changes as one group. Then 11 filings.", tail: "What I looked at: every plan and task.\n\nWhat could not be verified: two sessions.", evidenceHref: "https://codecast.sh/a/a6ox" });
    // A single newline before it, or a blank line of spaces, still finds it.
    expect(splitAsk("Accept it.\n  \nEvidence: https://x.y/z.").evidenceHref).toBe("https://x.y/z");
    expect(splitAsk("Accept it.\nEvidence and findings: https://x.y/z")).toEqual({ ask: "Accept it.", tail: "", evidenceHref: "https://x.y/z" });
    // One paragraph and no evidence line: every word is the ask, nothing is the tail.
    expect(splitAsk(P.summary_md)).toEqual({ ask: P.summary_md, tail: "", evidenceHref: null });
    expect(splitAsk(undefined)).toEqual({ ask: "", tail: "", evidenceHref: null });
  });

});

describe("the intro rule", () => {
  test("a person who accepted a change on any proposal in view has read enough", () => {
    expect(hasAcceptedBefore([P], "nobody")).toBe(false);
    expect(hasAcceptedBefore([P], null)).toBe(false);
    const mine = { changes: P.changes.map((c) => c.status === "accepted" ? { ...c, decided_by: "me" } : c) };
    expect(hasAcceptedBefore([mine], "me")).toBe(true);
    // A skip is not an accept.
    const skipped = { changes: P.changes.map((c) => c.status === "skipped" ? { ...c, decided_by: "me" } : c) };
    expect(hasAcceptedBefore([skipped], "me")).toBe(false);
  });
});

describe("the kind words", () => {
  test("every kind in the shared contract has a label and a one sentence description; an unknown kind reads as a sentence", () => {
    for (const k of ORG_CHANGE_KINDS) {
      expect(CHANGE_KIND_META[k].label.length).toBeGreaterThan(3);
      expect(CHANGE_KIND_META[k].describe).toMatch(/\.$/);
      expect(kindLabel(k)).toBe(CHANGE_KIND_META[k].label);
    }
    expect(kindLabel("task_status")).toBe("Tasks to close or reopen");
    expect(kindLabel("rename")).toBe("Changes this version cannot show yet");
    expect(kindDescription("rename")).toBe('This version of codecast does not know this kind of change ("rename"). Update codecast, or ask the head of people what it does.');
    expect(kindDescription(undefined)).toMatch(/does not know this kind of change\. Update codecast/);
    expect(changeLine({ kind: "task_status", task: "ct-1", status: "done", reason: "x" })).toBe("Mark task ct-1 done");
    expect(changeLine({ kind: "rename" } as any)).not.toMatch(/not supported in this build/);
  });
});

describe("the glossary", () => {
  test("one sentence each, no short id in an example, with examples from this workspace where it has one", () => {
    const entries = glossaryEntries(ORG_FIXTURE, ORG_STAFFING_FIXTURE_HEALTH, P);
    expect(entries.map((e) => e.word)).toEqual(GLOSSARY_ORDER);
    expect(entries).toHaveLength(13);
    for (const e of entries) {
      expect(e.definition.split(/[.!?](\s|$)/).filter((s) => s.trim()).length).toBe(1);
      expect(e.example.length).toBeGreaterThan(8);
    }
    const by = Object.fromEntries(entries.map((e) => [e.word, e]));
    expect(by.role.own).toBe(true);
    expect(by.role.example).toMatch(/^@growth, /);
    expect(by.proposal.own).toBe(true);
    expect(by.proposal.example).toBe("The one open now: 8 changes, 2 decided.");
    for (const e of entries) expect(e.example).not.toMatch(/\b(op|ct|pl|or|tr)-\d+\b/);
    expect(by.session.example).toMatch(/sessions? working right now\.$/);
  });

  test("Serves, Carried by and Now are words; goal, project and their relations take examples from the company's own goals and projects", () => {
    const company = {
      goals: [
        { _id: "g1", title: "Make revenue" },
        { _id: "g2", title: "Increase top of funnel", parent_initiative_id: "g1", project_ids: ["p1", "p2", "p9"] },
      ],
      projects: [{ _id: "p1", title: "Lead lists" }, { _id: "p2", title: "Matching Engine" }],
    };
    const by = Object.fromEntries(glossaryEntries(null, null, null, company).map((e) => [e.word, e]));
    expect(["Serves", "Carried by", "Now", "Focus"].every((t) => Object.values(by).some((e) => e.term === t))).toBe(true);
    expect(by.serves.example).toBe('"Lead lists" serves "Increase top of funnel".');
    expect(by.carried_by.example).toBe('"Increase top of funnel" is carried by "Lead lists" and "Matching Engine".');
    expect(by.goal.example).toBe('"Increase top of funnel", carried by Lead lists and Matching Engine.');
    expect(by.project.own).toBe(true);
    // No projects anywhere: a sub-goal still says what it serves.
    const bare = Object.fromEntries(glossaryEntries(null, null, null, { goals: company.goals.map(({ project_ids, ...g }) => g), projects: [] }).map((e) => [e.word, e]));
    expect(bare.serves.example).toBe('"Increase top of funnel" serves "Make revenue".');
    expect(bare.carried_by.own).toBe(false);
    // A person's brief priorities are their focus, never their goals.
    expect(by.focus.definition).toMatch(/^A person's own priorities/);
  });

  test("with an empty workspace every example is a general one, and the short page has four parts", () => {
    const entries = glossaryEntries(null, null, null);
    expect(entries.every((e) => !e.own)).toBe(true);
    expect(HOW_THIS_WORKS).toHaveLength(4);
    expect(HOW_THIS_WORKS.map((s) => s.heading)).toEqual(["What you are looking at", "Where a proposal comes from", "What accepting does", "Talking it over"]);
  });
});
