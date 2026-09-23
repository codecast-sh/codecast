// Presentation facts the org surfaces share: how each work state reads, and
// how a parent reference is named. Data only; the cards render it.
import { parseThreadStateStatus, type WorkState } from "@codecast/shared/contracts";
import { changeLine, describeTenure, type OrgChange, type OrgTenureSpec } from "@codecast/shared/contracts/orgProposal";
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

/** The word on the button and the tab that open the staffing pane, said as
 *  what they open: the proposal waiting on the person when one is open,
 *  else how the company is doing (StaffingPane's health body). The first
 *  open guide names the same word, so the reader meets one name. */
export function staffingPaneWord(hasOpenProposal: boolean): "Proposal" | "Health" {
  return hasOpenProposal ? "Proposal" : "Health";
}

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

/** The compact tenure chip a role node and a ghost seat draw (org-staffing.md
 *  S10). Null for a standing seat — standing is silent. A program reads
 *  "program · ends with pl-N" / a date / a project, the plan or project named
 *  from the tree when it knows it. The ", then …" tail is dropped for the chip;
 *  the full sentence is its title. */
export function roleTenureChip(tenure: OrgTenureSpec | undefined | null, tree: OrgTree | null | undefined): { short: string; full: string } | null {
  if (!tenure || tenure.kind === "standing") return null;
  const e = tenure.ends as { plan?: string; project?: string; date?: number };
  const roles = tree?.roles ?? [];
  const names: { plan?: string; project?: string } = {};
  if (e.plan) names.plan = roles.flatMap((r) => r.scope_names.plans).find((p) => p.id === e.plan || p.short_id === e.plan)?.short_id;
  if (e.project) names.project = roles.flatMap((r) => r.scope_names.projects).find((p) => p.id === e.project || p.short_id === e.project || p.title === e.project)?.title;
  const full = describeTenure(tenure, names);
  return { short: full.replace(/, then .*$/, ""), full };
}

export function parentName(tree: OrgTree, ref: OrgParentRef): string {
  return ref.kind === "user"
    ? tree.people.find((p) => p.user_id === ref.user_id)?.name ?? "someone"
    : tree.roles.find((r) => r._id === ref.role_id)?.name ?? "a role";
}

/**
 * What each kind of change is, in the reader's words (org-staffing.md S17):
 * the group header the pane shows, and the one sentence that says what
 * accepting one does. The reader has never heard of a role, a scope or a
 * budget, so every label names the thing in plain words and the sentence
 * carries the mechanism. The glossary is the one place a word is defined;
 * these sentences use the words, they do not define them.
 */
export const CHANGE_KIND_META: Record<OrgChange["kind"], { label: string; describe: string }> = {
  plan_status: { label: "Plans to close or reopen", describe: "Marks a plan finished, abandoned or active again, because the evidence says the record is behind what happened." },
  task_status: { label: "Tasks to close or reopen", describe: "Marks a task done, dropped, open or backlog, so the board says what actually happened to it." },
  project_status: { label: "Projects to pause or close", describe: "Marks a project paused, finished or active again." },
  projects: { label: "New or merged projects", describe: "Creates a lasting area of work, or folds one into another." },
  file: { label: "Plans filed under a project", describe: "Puts a plan under the project it belongs to, so the agent looking after that project sees it." },
  role: { label: "New standing agents", describe: "Adds a standing agent with a name and an area of work to look after." },
  move: { label: "Reporting line changes", describe: "Moves a standing agent under a different person or agent, and can change what it looks after." },
  scope: { label: "Area of work changes", describe: "Adds or removes the projects and plans a standing agent looks after." },
  budget: { label: "Daily limit changes", describe: "Raises or lowers how much an agent may do in one day." },
  trust: { label: "Starting work on its own", describe: "Turns on or off whether an agent starts work in its area without asking." },
  routine: { label: "Scheduled routines", describe: "Gives an agent a job it runs on a schedule." },
  project_meta: { label: "Project charters", describe: "Writes down what a project is for, who owns it, and how urgent it is." },
  adopt: { label: "Sessions adopted as standing agents", describe: "Makes an existing session the standing session of an agent." },
  retire: { label: "Agents retired", describe: "Closes a seat; its sessions fall back to their owners." },
  authority: { label: "Authority outside codecast", describe: "Lets an agent spend, publish, write or connect outside codecast, inside limits you set." },
  hire: { label: "Hires from a template", describe: "Hires an agent from a template: its answers, its release and the project it will lead." },
  upgrade: { label: "Template updates", describe: "Moves a hired agent to a newer release of its template." },
  // The company's goals (initiatives-projects-role-page.md "I1, revised").
  initiative: { label: "Goals to set", describe: "Sets a goal the company has not written down: its name, what reaching it looks like, the projects that carry it and who drives it." },
  initiative_projects: { label: "Projects added to a goal", describe: "Adds projects whose work serves a goal that exists and does not list them." },
  initiative_owner: { label: "Owners for a goal", describe: "Names who drives a goal that has no owner: a person or an agent." },
};

/** The kind's label, total: a kind this build does not know still reads as a
 *  sentence, never as a build error. */
export function kindLabel(kind: string | undefined): string {
  return CHANGE_KIND_META[kind as OrgChange["kind"]]?.label ?? "Changes this version cannot show yet";
}

/** The kind's one sentence, total, with the unknown kind named so the reader
 *  can quote it. */
export function kindDescription(kind: string | undefined): string {
  return CHANGE_KIND_META[kind as OrgChange["kind"]]?.describe ?? `This version of codecast does not know this kind of change${kind ? ` ("${kind}")` : ""}. Update, or ask the agent what it does.`;
}

/** The one line a change reads as to a person (org-staffing.md S17). The
 *  writer is the shared contract's, so the pane, the chart's chips, the org
 *  log and `cast org log` say a change the same way (S21). */
export { changeLine } from "@codecast/shared/contracts/orgProposal";
/** The words for limits and cadences are the shared contract's, so a derived
 *  ask (server or page) and a row line say them the same way. */
export { capsWords, everyWords } from "@codecast/shared/contracts/orgProposal";
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";

const at = (h: string) => `@${h.replace(/^@/, "")}`;
const compact = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
const refs = (xs: string[] | undefined, sign: string) => (xs ?? []).map((x) => `${sign}${x}`).join(" ");
/** Caps always read in one order, whatever order the proposal wrote them. */
const CAP_ORDER = ["hands_per_day", "wakes_per_day", "tokens_per_day"] as const;

/**
 * The delta alone, for the chip on a card (org-staffing.md S5: "+ project X",
 * "tokens 800k", "starts work on its own"). The card already names the role the
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
    case "budget": return CAP_ORDER.filter((k) => change.caps[k] !== undefined).map((k) => `${k.replace("_per_day", "")} ${compact(change.caps[k] as number)}`).join(" \u00b7 ");
    case "trust": return autonomyOn(change.trust) ? "starts work on its own" : "stops starting work on its own";
    case "routine": return `every ${change.every} \u00b7 ${change.title}`;
    case "project_meta": return [change.project, change.priority, change.owner ? `owner ${at(change.owner)}` : ""].filter(Boolean).join(" \u00b7 ");
    case "adopt": return `adopt ${change.conversation}`;
    case "file": return `${change.plan} under ${change.project}`;
    case "authority": return change.authority.map((g) => g.kind).join(" \u00b7 ");
    case "hire": return `${change.template} ${change.version}`;
    case "upgrade": return `to ${change.to}`;
    case "initiative": return `+ ${change.title}`;
    case "initiative_projects": return refs(change.projects, "+ ");
    case "initiative_owner": return `owner ${change.owner.startsWith("@") ? at(change.owner) : change.owner}`;
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
  budget: "limit",
  trust: "switch",
  routine: "routine",
  project_meta: "charter",
  adopt: "adopt",
  retire: "retire",
  plan_status: "plan",
  task_status: "task",
  project_status: "project",
  authority: "authority",
  hire: "hire",
  upgrade: "update",
  initiative: "goal",
  initiative_projects: "projects",
  initiative_owner: "owner",
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
