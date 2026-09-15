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

/** The one line a change reads as in the pane's list and in a chip's title:
 *  the shared describer (the words the CLI walk uses too), sentence cased.
 *  Total: a kind this build does not know (a newer server) still reads as a
 *  line, so the pane and the chart degrade to a chip instead of throwing. */
export function changeLine(change: OrgChange): string {
  const line = describeOrgChange(change) ?? `${String((change as { kind?: unknown }).kind ?? "change")} (not supported in this build)`;
  return line.charAt(0).toUpperCase() + line.slice(1);
}

const at = (h: string) => `@${h.replace(/^@/, "")}`;
const compact = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
const refs = (xs: string[] | undefined, sign: string) => (xs ?? []).map((x) => `${sign}${x}`).join(" ");

/**
 * The delta alone, for the chip on a card (org-staffing.md S5: "+ project X",
 * "tokens 800k", "trust to decide"). The card already names the role the
 * chip sits on, so the verb and the handle are left out; the full sentence
 * (changeLine) is the chip's title.
 */
export function chipLine(change: OrgChange): string {
  switch (change.kind) {
    case "role": return at(change.handle);
    case "projects": return change.changes.map((x) => x.op === "create" ? `+ ${x.title}` : `${x.from} into ${x.into}`).join(", ");
    case "move": return [change.reports_to ? `under ${change.reports_to}` : "", refs(change.scope_add, "+"), refs(change.scope_remove, "\u2212")].filter(Boolean).join(" ") || "move";
    case "retire": return "retire";
    case "scope": return [refs(change.add, "+ "), refs(change.remove, "\u2212 ")].filter(Boolean).join(" ");
    case "budget": return Object.entries(change.caps).filter(([, v]) => v !== undefined).map(([k, v]) => `${k.replace("_per_day", "")} ${compact(v as number)}`).join(" \u00b7 ");
    case "trust": return `trust to ${change.trust}`;
    case "routine": return `every ${change.every} \u00b7 ${change.title}`;
    case "project_meta": return [change.project, change.priority, change.owner ? `owner ${at(change.owner)}` : ""].filter(Boolean).join(" \u00b7 ");
    case "adopt": return `adopt ${change.conversation}`;
    case "file": return `${change.plan} under ${change.project}`;
    default: return changeLine(change);
  }
}

/** The one word a change's action strip leads with, so "Accept" names what
 *  it accepts on a card carrying several changes. */
export const CHANGE_KIND_WORD: Record<OrgChange["kind"], string> = {
  projects: "projects",
  file: "filing",
  role: "role",
  move: "move",
  scope: "scope",
  budget: "budget",
  trust: "trust",
  routine: "routine",
  project_meta: "charter",
  adopt: "adopt",
  retire: "retire",
};

/** A ghost's colour (org-staffing.md S5): the page's violet, dashed, at 55%. */
export const GHOST = {
  color: "var(--sol-violet)",
  opacity: 0.55,
  border: "1.5px dashed color-mix(in srgb, var(--sol-violet) 70%, transparent)",
  fill: "color-mix(in srgb, var(--sol-violet) 8%, transparent)",
  /** A retire proposal's hatch, laid over the card. */
  hatch: "repeating-linear-gradient(135deg, transparent 0 7px, color-mix(in srgb, var(--sol-violet) 14%, transparent) 7px 9px)",
} as const;

/**
 * Flag severities carried in shape and word, not hue alone: a blocker is a
 * filled red dot with its word as a tag (red means "needs attention", as in
 * the inbox header); a warning is a hollow ring in the trigger amber; info has
 * no dot and a dim label. Red and orange are adjacent hues in this palette and
 * read as one colour, so the dot's fill is what tells them apart. The pane's
 * list, the node dots and the bottleneck chips share it.
 */
export const SEVERITY_META: Record<HealthFlag["severity"], { color: string; word: string; dot: "filled" | "ring" | "none"; tag: boolean }> = {
  blocker: { color: "var(--sol-red)", word: "blocker", dot: "filled", tag: true },
  warn: { color: "var(--sol-yellow)", word: "warn", dot: "ring", tag: false },
  info: { color: "var(--sol-text-dim)", word: "info", dot: "none", tag: false },
};

/** The colour alone, for surfaces that pair it with the word already. */
export const SEVERITY_COLOR: Record<HealthFlag["severity"], string> = {
  blocker: SEVERITY_META.blocker.color,
  warn: SEVERITY_META.warn.color,
  info: SEVERITY_META.info.color,
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
