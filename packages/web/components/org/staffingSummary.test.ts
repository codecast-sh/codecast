// The summary a person reads cold (org-staffing.md S17): the ask split from
// its evidence line, the first sentence in front, the groups with counts,
// the budget arithmetic from the tree, the intro rule, and the kind words.
import { describe, expect, test } from "bun:test";
import { ORG_STAFFING_FIXTURE_PROPOSAL } from "./orgStaffingFixture";
import { hasAcceptedBefore, splitAsk } from "./staffingModel";
import { CHANGE_KIND_META, changeLine, kindDescription, kindLabel } from "./orgMeta";
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
