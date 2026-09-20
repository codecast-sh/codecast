// The DEV preview (`/org?preview=1`) on a proposal spec a dry run wrote
// (docs/architecture/org-eval.md): the evaluation loop renders the analyzer's
// `proposal.json` on the real proposal page without posting it anywhere. The
// spec goes through the same parser the post uses, so a spec the server would
// refuse paints nothing here either.
//
//   sessionStorage.setItem("org-preview-spec", JSON.stringify(spec))
//   then open /org?preview=1&proposal=op-1
import { parseOrgProposalSpec, resolveOrgAsks } from "@codecast/shared/contracts/orgProposal";
import type { OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";

export const ORG_PREVIEW_SPEC_KEY = "org-preview-spec";
export const ORG_PREVIEW_SPEC_SHORT_ID = "op-1";

/** The row `orgProposals.get` would hand back for this spec, or null when the parser refuses it. */
export function orgProposalRowFromSpec(raw: unknown, now: number = Date.now()): OrgProposalRow | null {
  const { spec } = parseOrgProposalSpec(raw);
  if (!spec) return null;
  const proposalId = "preview-spec-proposal";
  const changes: OrgProposalChange[] = spec.changes.map((c, i) => ({
    _id: `preview-spec-change-${i + 1}`, proposal_id: proposalId, seq: i + 1, status: "proposed",
    change: c.change, rationale: c.rationale, evidence: c.evidence ?? [],
    ...(c.expected_effect ? { expected_effect: c.expected_effect } : {}),
    ...(c.risk ? { risk: c.risk } : {}),
  }));
  return {
    _id: proposalId, short_id: ORG_PREVIEW_SPEC_SHORT_ID, team_id: "fixture-team",
    author: { kind: "role", id: "fixture-role-chief", name: "Chief of Staff", short_id: "or-9" },
    thread: { conversation_id: "fixture-chief-conv", short_id: "jx7ch1f" },
    title: spec.title, summary_md: spec.summary_md, mode: spec.mode, status: "open", created_at: now,
    asks: resolveOrgAsks(spec.asks, changes), changes,
  };
}

/** The spec a dry run left in this tab's session storage, as a proposal row. */
export function readOrgPreviewSpec(): OrgProposalRow | null {
  try {
    const text = typeof window === "undefined" ? null : window.sessionStorage.getItem(ORG_PREVIEW_SPEC_KEY);
    return text ? orgProposalRowFromSpec(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}
