// Presentation facts the org surfaces share: how each work state reads, and
// how a parent reference is named. Data only; the cards render it.
import { parseThreadStateStatus, type WorkState } from "@codecast/shared/contracts";
import { describeOrgChange, type OrgChange } from "@codecast/shared/contracts/orgProposal";
import type { HealthFlag } from "@codecast/shared/contracts/orgCapacity";
import { THREAD_STATE_STATUS_META } from "../../lib/threadState";
import type { OrgParentRef, OrgStandingState, OrgTree } from "./orgTypes";
import type { OrgHealth } from "./orgStaffingTypes";

export const ORG_STATE_META: Record<WorkState, { label: string; color: string; chip: string }> = {
  needs_input: { label: "needs input", color: "var(--sol-yellow)", chip: THREAD_STATE_STATUS_META.blocked.chip },
  working: { label: "working", color: "var(--sol-green)", chip: THREAD_STATE_STATUS_META.working.chip },
  dormant: { label: "dormant", color: "var(--sol-blue)", chip: THREAD_STATE_STATUS_META.dormant.chip },
  done: { label: "done", color: "var(--sol-cyan)", chip: THREAD_STATE_STATUS_META.done.chip },
  idle: { label: "idle", color: "var(--sol-text-dim)", chip: "bg-sol-bg-highlight text-sol-text-dim border-sol-border/30" },
};

/** The board line of a standing agent: its pinned line, and the colour and
 *  word it is painted with. The agent's own declared status wins (the founder
 *  reads "Infra lead: needs input" from the lead, not from a tally of its
 *  hands); the observed work state stands in when nothing is declared; null
 *  when there is nothing to say. Shared by the role card, the anchor card and
 *  the panels so no two of them colour one status two ways. */
export function standingLineOf(s: OrgStandingState | null | undefined): { text: string | null; label: string; color: string } | null {
  if (!s) return null;
  const text = s.state_line?.trim() || null;
  const status = parseThreadStateStatus(s.state_status);
  if (status) return { text, label: THREAD_STATE_STATUS_META[status].label.toLowerCase(), color: THREAD_STATE_STATUS_META[status].color };
  if (s.state) return { text, label: ORG_STATE_META[s.state].label, color: ORG_STATE_META[s.state].color };
  return text ? { text, label: "pinned", color: "var(--sol-text-dim)" } : null;
}

export function parentName(tree: OrgTree, ref: OrgParentRef): string {
  return ref.kind === "user"
    ? tree.people.find((p) => p.user_id === ref.user_id)?.name ?? "someone"
    : tree.roles.find((r) => r._id === ref.role_id)?.name ?? "a role";
}

/** The one line a change reads as on a chip and in the pane's list: the
 *  shared describer (the words the CLI walk uses too), sentence cased. */
export function changeLine(change: OrgChange): string {
  const line = describeOrgChange(change);
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** A ghost's colour (org-staffing.md S5): the page's violet, dashed, at 55%. */
export const GHOST = {
  color: "var(--sol-violet)",
  opacity: 0.55,
  border: "1.5px dashed color-mix(in srgb, var(--sol-violet) 70%, transparent)",
  fill: "color-mix(in srgb, var(--sol-violet) 8%, transparent)",
  /** A retire proposal's hatch, laid over the card. */
  hatch: "repeating-linear-gradient(135deg, transparent 0 7px, color-mix(in srgb, var(--sol-violet) 14%, transparent) 7px 9px)",
} as const;

/** Flag severities in the inbox palette: a blocker is red, a warning orange,
 *  information dim. The pane's list, the node dots and the tooltips share it. */
export const SEVERITY_COLOR: Record<HealthFlag["severity"], string> = {
  blocker: "var(--sol-red)",
  warn: "var(--sol-orange)",
  info: "var(--sol-text-dim)",
};

/** org.health's flags keyed by the node they sit on ("person:<user_id>",
 *  "role:<role_id>"); the company's own flags have no node and are left out. */
export function healthFlagsByNode(health: OrgHealth | null | undefined): Record<string, HealthFlag[]> {
  const out: Record<string, HealthFlag[]> = {};
  if (!health) return out;
  for (const r of health.roles) if (r.flags.length) out[`role:${r.role_id}`] = r.flags;
  for (const p of health.people) if (p.flags.length) out[`person:${p.user_id}`] = p.flags;
  return out;
}
