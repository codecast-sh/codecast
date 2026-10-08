import type { CSSProperties } from "react";
import type { OrgChangeStatus } from "./orgStaffingTypes";
import type { OrgGhostStub } from "./orgLayout";
// Presentation facts the org surfaces share: how each work state reads, and
// how a parent reference is named. Data only; the cards render it.
import { parseThreadStateStatus, type WorkState } from "@codecast/shared/contracts";
import { describeTenure, type OrgChange, type OrgTenureSpec } from "@codecast/shared/contracts/orgProposal";
import type { HealthFlag } from "@codecast/shared/contracts/orgCapacity";
import { THREAD_STATE_STATUS_META } from "../../lib/threadState";
import type { OrgParentRef, OrgStandingState, OrgTree, StateCounts } from "./orgTypes";
import type { OrgHealth } from "./orgStaffingTypes";

export const ORG_STATE_META: Record<WorkState, { label: string; color: string; chip: string }> = {
  needs_input: { label: "needs input", color: "var(--sol-yellow)", chip: THREAD_STATE_STATUS_META.blocked.chip },
  working: { label: "working", color: "var(--sol-green)", chip: THREAD_STATE_STATUS_META.working.chip },
  dormant: { label: "dormant", color: "var(--sol-blue)", chip: THREAD_STATE_STATUS_META.dormant.chip },
  done: { label: "done", color: "var(--sol-cyan)", chip: THREAD_STATE_STATUS_META.done.chip },
  idle: { label: "idle", color: "var(--sol-text-dim)", chip: "bg-sol-bg-highlight text-sol-text-dim border-sol-border/30" },
};

/** A person's presence as a colour: the map's dot and a company line's state. */
export const PRESENCE_COLOR: Record<"online" | "away" | "offline", string> = {
  online: "var(--sol-green)",
  away: "var(--sol-yellow)",
  offline: "color-mix(in srgb, var(--sol-border) 50%, transparent)",
};

/** A card's sessions in words, the states a person acts on first ("4 need
 *  input · 2 working"), at most `max` parts; the rest is for a title. Empty
 *  when there is nothing to say. */
export function stateWords(counts: Partial<StateCounts>, max = 2): string[] {
  const out: string[] = [];
  const n = (k: WorkState) => counts[k] ?? 0;
  if (n("needs_input")) out.push(`${n("needs_input")} need${n("needs_input") === 1 ? "s" : ""} input`);
  if (n("working")) out.push(`${n("working")} working`);
  for (const k of ["dormant", "done", "idle"] as const) if (out.length < max && n(k)) out.push(`${n(k)} ${ORG_STATE_META[k].label}`);
  return out.slice(0, max);
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
  role: { label: "New roles", describe: "Adds a role with a name and an area to look after." },
  charter_edit: { label: "Charter edits", describe: "Changes a passage of a role's charter, or adds or removes a line, leaving the rest as it is." },
  move: { label: "Reporting changes", describe: "Moves a role under a different person or role, and can change what it looks after." },
  scope: { label: "Area changes", describe: "Adds or removes the projects and plans a role looks after." },
  budget: { label: "Daily limit changes", describe: "Raises or lowers how much a role may do in one day." },
  trust: { label: "Starting work on its own", describe: "Turns on or off whether a role starts work in its area without asking." },
  routine: { label: "New triggers", describe: "Gives a role a trigger that wakes it on a schedule." },
  project_meta: { label: "What a project is for", describe: "Writes down what a project is for, who owns it, and how urgent it is." },
  adopt: { label: "Sessions that become a role", describe: "Makes an existing session the role's own thread, so the role keeps what it knows." },
  retire: { label: "Roles retired", describe: "Retires a role; its area falls back to the role that covers it, else its sessions to their owners." },
  authority: { label: "Permissions outside codecast", describe: "Lets a role spend, publish, write or connect outside codecast, inside limits you set." },
  hire: { label: "Hires from a template", describe: "Hires a role from a template: its answers, its version and the project it will lead." },
  upgrade: { label: "Template updates", describe: "Moves a hired role to a newer version of its template." },
  // The company's goals (initiatives-projects-role-page.md "I1, revised").
  initiative: { label: "Goals to set", describe: "Sets a goal the company has not written down: its name, what reaching it looks like, the projects that carry it and who drives it." },
  initiative_projects: { label: "Projects added to a goal", describe: "Adds projects whose work serves a goal that exists and does not list them." },
  initiative_owner: { label: "Owners for a goal", describe: "Names who drives a goal that has no owner: a person or a role." },
  initiative_shape: { label: "Goals placed and measured", describe: "Puts a goal under the goal it serves, or at the top, and sets the numbers that say it is reached." },
};

/** The kind's label, total: a kind this build does not know still reads as a
 *  sentence, never as a build error. */
export function kindLabel(kind: string | undefined): string {
  return CHANGE_KIND_META[kind as OrgChange["kind"]]?.label ?? "Changes this version cannot show yet";
}

/** The kind's one sentence, total, with the unknown kind named so the reader
 *  can quote it. */
export function kindDescription(kind: string | undefined): string {
  return CHANGE_KIND_META[kind as OrgChange["kind"]]?.describe ?? `This version of codecast does not know this kind of change${kind ? ` ("${kind}")` : ""}. Update codecast, or ask the head of people what it does.`;
}

/** The one line a change reads as to a person (org-staffing.md S17). The
 *  writer is the shared contract's, so the pane, the chart's chips, the org
 *  log and `cast org log` say a change the same way (S21). */
export { changeLine } from "@codecast/shared/contracts/orgProposal";
/** The words for limits and cadences are the shared contract's, so a derived
 *  ask (server or page) and a row line say them the same way. */
export { capsWords, everyWords } from "@codecast/shared/contracts/orgProposal";
/** The delta alone, for the chip on a card (org-staffing.md S5). The writer
 *  lives with the rest of a change's words (orgChangeWords); the chart keeps
 *  reading it from here. */
export { chipLine } from "@codecast/shared/contracts/orgChangeWords";

/** The one word a change's action strip leads with, so "Accept" names what
 *  it accepts on a card carrying several changes. */
export const CHANGE_KIND_WORD: Record<OrgChange["kind"], string> = {
  projects: "projects",
  charter_edit: "charter",
  file: "filing",
  role: "role",
  move: "move",
  scope: "area",
  budget: "limit",
  trust: "switch",
  routine: "trigger",
  project_meta: "charter",
  adopt: "adopt",
  retire: "retire",
  plan_status: "plan",
  task_status: "task",
  project_status: "project",
  authority: "permission",
  hire: "hire",
  upgrade: "update",
  initiative: "goal",
  initiative_projects: "projects",
  initiative_owner: "owner",
  initiative_shape: "shape",
};

/** A ghost's colour (org-staffing.md S5): the page's violet at 55%. On the
 *  chart a proposed card wears ONE quiet mark of it (`frame` and `fill`: a
 *  thin solid violet outline over a soft tint, with its icon in violet); the
 *  dashed `border` is the proposal card's own, where a role row still frames. */
export const GHOST = {
  color: "var(--sol-violet)",
  opacity: 0.55,
  border: "1.5px dashed color-mix(in srgb, var(--sol-violet) 70%, transparent)",
  frame: "1px solid color-mix(in srgb, var(--sol-violet) 45%, transparent)",
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

/** What pausing a role does (org-staffing.md S25), said one way everywhere. */
export const rolePausedSentence = (name: string) => `${name} is paused: its triggers hold until you resume it. Messages still reach it.`;

// ---------------------------------------------------------------- reset (S27)

export type OrgResetPreview = { roles: Array<{ short_id: string; handle: string; name: string; sessions: number }>; proposals: number };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a reset would change, as the sentences the confirm shows. */
export function resetSentences(p: OrgResetPreview): string[] {
  const sessions = p.roles.reduce((n, r) => n + r.sessions, 0);
  if (p.roles.length === 0 && p.proposals === 0) return ["There is nothing to reset: this workspace has no roles and no proposals."];
  return [
    p.roles.length > 0 ? `${count(p.roles.length, "role is", "roles are")} retired, and ${p.roles.length === 1 ? "its" : "their"} triggers are cancelled.` : "",
    sessions > 0 ? `${count(sessions, "session goes", "sessions go")} back to ${sessions === 1 ? "its owner" : "their owners"}.` : "",
    p.proposals > 0 ? `${count(p.proposals, "proposal is", "proposals are")} archived, open ones included.` : "",
    "Your projects, plans, tasks and sessions stay as they are. The next review starts from the work alone.",
  ].filter(Boolean);
}


// The frame a proposed change draws in, by its status, and a ghost card's frame.
export const CHIP_STATUS: Record<OrgChangeStatus, { border: string; color: string }> = {
  proposed: { border: GHOST.border, color: GHOST.color },
  accepted: { border: "1.5px solid color-mix(in srgb, var(--sol-cyan) 60%, transparent)", color: "var(--sol-cyan)" },
  applied: { border: "1.5px solid color-mix(in srgb, var(--sol-green) 60%, transparent)", color: "var(--sol-green)" },
  skipped: { border: "1.5px dashed color-mix(in srgb, var(--sol-border) 60%, transparent)", color: "var(--sol-text-dim)" },
  failed: { border: "1.5px dashed color-mix(in srgb, var(--sol-red) 70%, transparent)", color: "var(--sol-red)" },
  removed: { border: "1.5px dashed color-mix(in srgb, var(--sol-border) 60%, transparent)", color: "var(--sol-text-dim)" },
};

/** A chart card's frame under a change, one quiet mark: a thin solid outline
 *  in the status colour over the ghost tint while proposed or failed, the
 *  accepted outline alone once accepted. Never dashed: a proposed goal is a
 *  violet flag and a tint, not a box of dashes. */
export function changeFrameStyle(status: OrgChangeStatus, unresolved?: boolean): CSSProperties {
  const color = unresolved ? CHIP_STATUS.failed.color : CHIP_STATUS[status].color;
  const tint = unresolved || status === "proposed" || status === "failed";
  // The tint is mixed into the card's own colour, not laid over the canvas: a proposed card is as solid as a live one.
  return { border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`, ...(tint ? { background: `color-mix(in srgb, ${color} 9%, var(--sol-card))` } : {}) };
}

/** The frame styling of a ghost stub: the change frame, no plate, 55% content. */
export function ghostFrameStyle(stub: OrgGhostStub): CSSProperties {
  return stub.solid
    ? { borderTopWidth: 3, borderTopColor: "var(--sol-cyan)", background: "var(--sol-card)" }
    : { ...changeFrameStyle(stub.status), borderTopWidth: 1 };
}
