// The DEV preview (`/org?preview=1`) on a proposal spec a dry run wrote
// (docs/architecture/org-eval.md): the evaluation loop renders the analyzer's
// `proposal.json` on the real proposal page without posting it anywhere. The
// spec goes through the same parser the post uses, so a spec the server would
// refuse paints nothing here either.
//
//   sessionStorage.setItem("org-preview-spec", JSON.stringify(spec))
//   sessionStorage.setItem("org-preview-tree", JSON.stringify(__inboxStore.getState().orgTree))   (optional)
//   then open /org?preview=1&proposal=op-1
//
// With a saved tree the chart behind the proposal is that workspace's own, so
// the ghosts land where they would on the live page; without one, ORG_FIXTURE.
import { parseOrgProposalSpec, resolveOrgAsks } from "@codecast/shared/contracts/orgProposal";
import type { OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";

export const ORG_PREVIEW_SPEC_KEY = "org-preview-spec";
export const ORG_PREVIEW_TREE_KEY = "org-preview-tree";
export const ORG_PREVIEW_SPEC_SHORT_ID = "op-1";

/** The row `orgProposals.get` would hand back for this spec, or null when the parser refuses it. */
export function orgProposalRowFromSpec(raw: unknown, teamId: string | null = "fixture-team", now: number = Date.now()): OrgProposalRow | null {
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
    _id: proposalId, short_id: ORG_PREVIEW_SPEC_SHORT_ID, ...(teamId ? { team_id: teamId } : {}),
    author: { kind: "role", id: "fixture-role-chief", name: "Chief of Staff", short_id: "or-9" },
    thread: { conversation_id: "fixture-chief-conv", short_id: "jx7ch1f" },
    title: spec.title, summary_md: spec.summary_md, mode: spec.mode, status: "open", created_at: now,
    asks: resolveOrgAsks(spec.asks, changes), changes,
  };
}

function stored(key: string): unknown {
  try {
    const text = typeof window === "undefined" ? null : window.sessionStorage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The tree saved in this tab's session storage, when it has a tree's shape. */
export function readOrgPreviewTree(): OrgTree | null {
  const t = stored(ORG_PREVIEW_TREE_KEY) as OrgTree | null;
  return t?.workspace?.id && Array.isArray(t.people) && Array.isArray(t.roles) ? t : null;
}

/** The spec a dry run left in this tab's session storage, as a proposal row of the previewed workspace. */
export function readOrgPreviewSpec(): OrgProposalRow | null {
  const raw = stored(ORG_PREVIEW_SPEC_KEY);
  const tree = readOrgPreviewTree();
  return raw ? orgProposalRowFromSpec(raw, tree ? (tree.workspace.kind === "team" ? tree.workspace.id : null) : undefined) : null;
}
