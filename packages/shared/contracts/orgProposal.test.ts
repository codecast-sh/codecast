import { describe, expect, test } from "bun:test";
import { applyProposalChanges, extractOrgProposal, orgProposalBlock, orgProposalVerdict } from "./orgProposal";

describe("org proposal block", () => {
  test("round trips through a decision context", () => {
    const p = { kind: "role" as const, name: "Growth", handle: "growth", scope: { projects: ["pr-1"] } };
    const md = `Reasoning first.\n\n${orgProposalBlock(p)}\n\ntrailing note`;
    expect(extractOrgProposal(md)).toEqual(p);
  });
  test("malformed or missing blocks read as null", () => {
    expect(extractOrgProposal("no block")).toBeNull();
    expect(extractOrgProposal("```org-proposal\n{not json\n```")).toBeNull();
    expect(extractOrgProposal("```org-proposal\n{\"kind\":\"role\"}\n```")).toBeNull();
    expect(extractOrgProposal("```org-proposal\n{\"kind\":\"other\",\"handle\":\"x\"}\n```")).toBeNull();
  });
  test("verdict follows the fixed option order", () => {
    expect([0, 1, 2, 3, undefined].map(orgProposalVerdict)).toEqual(["apply", "apply_with_changes", "skip", null, null]);
  });
  test("changes: JSON overrides fields, prose rides as a note", () => {
    const p = { kind: "role" as const, name: "Growth", handle: "growth" };
    expect(applyProposalChanges(p, '{"handle":"grow","kind":"retire"}')).toEqual({ proposal: { kind: "role", name: "Growth", handle: "grow" } });
    expect(applyProposalChanges(p, "weekly reports please")).toEqual({ proposal: p, note: "weekly reports please" });
    expect(applyProposalChanges(p, "  ")).toEqual({ proposal: p });
  });
});
