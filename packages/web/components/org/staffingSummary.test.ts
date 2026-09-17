// The summary a person reads cold (org-staffing.md S17): the ask split from
// its evidence line, the first sentence in front, the groups with counts,
// the budget arithmetic from the tree, the intro rule, the kind words, and
// the glossary's examples from the reader's own workspace.
import { describe, expect, test } from "bun:test";
import { ORG_FIXTURE } from "./orgFixture";
import { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_PROPOSAL } from "./orgStaffingFixture";
import { budgetArithmetic, capsLine, hasAcceptedBefore, splitAsk } from "./staffingModel";
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

describe("the budget arithmetic", () => {
  test("today sums the active seats; after adds a new seat, swaps a changed limit, drops a retired seat; paused seats stay outside", () => {
    const tree = {
      ...ORG_FIXTURE,
      roles: [
        { ...ORG_FIXTURE.roles[0], handle: "growth", status: "active" as const, caps: { hands_per_day: 2, wakes_per_day: 8, tokens_per_day: 400_000 } },
        { ...ORG_FIXTURE.roles[0], _id: "r2", handle: "ops", status: "active" as const, caps: { hands_per_day: 1, wakes_per_day: 4, tokens_per_day: 100_000 } },
        { ...ORG_FIXTURE.roles[0], _id: "r3", handle: "paused", status: "paused" as const, caps: { hands_per_day: 9, wakes_per_day: 9, tokens_per_day: 9 } },
      ],
    };
    const changes = [
      { ...P.changes[0], status: "proposed" as const, change: { kind: "role" as const, name: "Chief of Staff", handle: "chief-of-staff", reports_to: "me", caps: { hands_per_day: 0, wakes_per_day: 8, tokens_per_day: 200_000 } } },
      { ...P.changes[0], _id: "b", status: "proposed" as const, change: { kind: "budget" as const, handle: "growth", caps: { tokens_per_day: 800_000 } } },
      { ...P.changes[0], _id: "r", status: "proposed" as const, change: { kind: "retire" as const, handle: "ops" } },
      // Decided rows do not move the total: applied ones are in the tree, skipped ones never will be.
      { ...P.changes[0], _id: "s", status: "skipped" as const, change: { kind: "budget" as const, handle: "growth", caps: { hands_per_day: 50 } } },
    ];
    const b = budgetArithmetic(tree, changes);
    expect(b.today).toEqual({ hands_per_day: 3, wakes_per_day: 12, tokens_per_day: 500_000 });
    expect(b.after).toEqual({ hands_per_day: 2, wakes_per_day: 16, tokens_per_day: 1_000_000 });
    expect(b.seats).toBe(2);
    expect(b.paused).toBe(1);
    expect(b.lines.map((l) => `${l.handle}:${l.note}`)).toEqual(["chief-of-staff:new seat", "growth:changed limit", "ops:seat closed"]);
    expect(capsLine(b.today)).toBe("3 hands, 12 wakes, 500,000 tokens");
    expect(capsLine({ wakes_per_day: 1 })).toBe("1 wake");
    expect(capsLine(null)).toBe("no limit set");
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
    expect(kindDescription("rename")).toBe('This version of codecast does not know this kind of change ("rename"). Update, or ask the agent what it does.');
    expect(kindDescription(undefined)).toMatch(/does not know this kind of change\. Update/);
    expect(changeLine({ kind: "task_status", task: "ct-1", status: "done", reason: "x" })).toBe("Mark task ct-1 done");
    expect(changeLine({ kind: "rename" } as any)).not.toMatch(/not supported in this build/);
  });
});

describe("the glossary", () => {
  test("eight words, one sentence each, with examples from this workspace where it has one", () => {
    const entries = glossaryEntries(ORG_FIXTURE, ORG_STAFFING_FIXTURE_HEALTH, P);
    expect(entries.map((e) => e.word)).toEqual(GLOSSARY_ORDER);
    expect(entries).toHaveLength(8);
    for (const e of entries) {
      expect(e.definition.split(/[.!?](\s|$)/).filter((s) => s.trim()).length).toBe(1);
      expect(e.example.length).toBeGreaterThan(8);
    }
    const by = Object.fromEntries(entries.map((e) => [e.word, e]));
    expect(by.role.own).toBe(true);
    expect(by.role.example).toMatch(/^@growth, /);
    expect(by.proposal.own).toBe(true);
    expect(by.proposal.example).toMatch(/^op-7, the one open now: 8 changes, 2 decided\./);
    expect(by.budget.example).toMatch(/tokens a day\.$/);
  });

  test("with an empty workspace every example is a general one, and the short page has four parts", () => {
    const entries = glossaryEntries(null, null, null);
    expect(entries.every((e) => !e.own)).toBe(true);
    expect(HOW_THIS_WORKS).toHaveLength(4);
    expect(HOW_THIS_WORKS.map((s) => s.heading)).toEqual(["What you are looking at", "Where a proposal comes from", "What accepting does", "Talking it over"]);
  });
});
