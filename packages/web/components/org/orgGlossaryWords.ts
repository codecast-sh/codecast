// The product's eight words (docs/architecture/org-staffing.md S17), defined
// in one place: one sentence each, and an example drawn from the reader's own
// workspace when the tree, the health read or the open proposal carry one.
// Nothing else in the product restates a definition; surfaces link here.
import type { OrgTree } from "./orgTypes";
import type { OrgHealth, OrgProposalRow } from "./orgStaffingTypes";
import { CHIEF_OF_STAFF_HANDLE } from "./orgStaffingTypes";
import { capsLine } from "./staffingModel";

export type GlossaryWord = "role" | "scope" | "charter" | "hand" | "wake" | "budget" | "proposal" | "chief_of_staff";

export type GlossaryEntry = {
  word: GlossaryWord;
  /** The word as the reader sees it. */
  term: string;
  /** The one sentence that defines it. */
  definition: string;
  /** From the reader's own workspace when there is one; else a general one. */
  example: string;
  /** Whether the example came from their workspace. */
  own: boolean;
};

export const GLOSSARY_ORDER: GlossaryWord[] = ["role", "scope", "charter", "hand", "wake", "budget", "proposal", "chief_of_staff"];

export const GLOSSARY_TERM: Record<GlossaryWord, string> = {
  role: "Role, a standing agent",
  scope: "Scope, an area of work",
  charter: "Charter",
  hand: "Hand",
  wake: "Wake",
  budget: "Budget, a daily limit",
  proposal: "Proposal",
  chief_of_staff: "Chief of staff",
};

const DEFINITION: Record<GlossaryWord, string> = {
  role: "A standing agent with a name, an area of work to look after, and a daily limit; it watches that area and leaves the rest alone.",
  scope: "The projects and plans a standing agent looks after: what lands in front of it, and what it never sees.",
  charter: "A short written statement of what a project or a standing agent is for, so an agent can tell its own work from someone else's.",
  hand: "One session doing one piece of work under a standing agent, gone when that work is done.",
  wake: "One turn a standing agent takes when something calls it: a message, a schedule, or a change inside its area of work.",
  budget: "The most a standing agent may do in one day, counted in hands, wakes and tokens, the units of text a model reads and writes.",
  proposal: "A list of changes to the org that an agent wrote; you accept, edit or skip each one, and nothing moves until you do.",
  chief_of_staff: "The standing agent that reads how work moves through the company and writes a proposal on a schedule.",
};

const handle = (h: string) => `@${h.replace(/^@/, "")}`;
const listOf = (xs: string[], max = 2) => xs.length <= max ? xs.join(" and ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`;

/**
 * The eight entries with examples from this workspace. A role with a scope
 * names the role example and the scope example; a charter on a role or a
 * project names the charter; the health read names hands and wakes; caps
 * name the budget; the open proposal names the proposal; the chief's seat
 * names itself. Where the workspace has none of that yet, the example says
 * what one would be.
 */
export function glossaryEntries(tree: OrgTree | null | undefined, health: OrgHealth | null | undefined, proposal: Pick<OrgProposalRow, "short_id" | "changes" | "counts"> | null | undefined): GlossaryEntry[] {
  const roles = (tree?.roles ?? []).filter((r) => r.status !== "retired");
  const chief = roles.find((r) => r.handle === CHIEF_OF_STAFF_HANDLE) ?? null;
  const scoped = roles.find((r) => r.scope_names.projects.length + r.scope_names.plans.length > 0 && r.handle !== CHIEF_OF_STAFF_HANDLE) ?? roles.find((r) => r.handle !== CHIEF_OF_STAFF_HANDLE) ?? roles[0] ?? null;
  const chartered = roles.find((r) => r.charter?.trim()) ?? null;
  const capped = roles.find((r) => r.caps) ?? null;
  const healthRole = health?.roles.find((r) => r.load.live_hands > 0) ?? health?.roles.find((r) => r.spend.wakes_cap > 0) ?? health?.roles[0] ?? null;
  const healthName = (id: string) => roles.find((r) => r._id === id)?.handle ?? healthRole?.handle ?? "";

  const roleEx = scoped
    ? { text: `${handle(scoped.handle)}, ${scoped.name}${scoped.scope_names.projects.length ? `, looks after ${listOf(scoped.scope_names.projects.map((p) => p.title))}` : ""}.`, own: true }
    : { text: "A Head of Platform that looks after the Platform project and nothing else.", own: false };
  const scopeEx = scoped && scoped.scope_names.projects.length + scoped.scope_names.plans.length > 0
    ? { text: `${handle(scoped.handle)} looks after ${[scoped.scope_names.projects.length ? `${scoped.scope_names.projects.length} ${scoped.scope_names.projects.length === 1 ? "project" : "projects"}` : "", scoped.scope_names.plans.length ? `${scoped.scope_names.plans.length} ${scoped.scope_names.plans.length === 1 ? "plan" : "plans"}` : ""].filter(Boolean).join(" and ")}: ${listOf([...scoped.scope_names.projects.map((p) => p.title), ...scoped.scope_names.plans.map((p) => p.title)], 3)}.`, own: true }
    : { text: "The Platform project and the two plans under it; a task filed elsewhere never reaches that agent.", own: false };
  const charterEx = chartered
    ? { text: `${handle(chartered.handle)}: "${trimTo(chartered.charter!, 110)}"`, own: true }
    : { text: "\"Owns the sync layer, the daemon and every release of the CLI.\"", own: false };
  const handEx = healthRole && healthRole.load.live_hands > 0
    ? { text: `${handle(healthName(healthRole.role_id))} has ${healthRole.load.live_hands} ${healthRole.load.live_hands === 1 ? "hand" : "hands"} working right now.`, own: true }
    : { text: "A session you start from a task under a standing agent is one of its hands; it ends when the task does.", own: false };
  const wakeEx = healthRole && healthRole.spend.wakes_cap > 0
    ? { text: `${handle(healthName(healthRole.role_id))} has used ${healthRole.spend.wakes_today} of ${healthRole.spend.wakes_cap} wakes today.`, own: true }
    : { text: "A message sent to a standing agent, or its weekly review coming due, is one wake.", own: false };
  const budgetEx = capped
    ? { text: `${handle(capped.handle)}: ${capsLine(capped.caps)} a day.`, own: true }
    : { text: "2 hands, 8 wakes and 200,000 tokens a day.", own: false };
  const total = proposal ? (proposal.counts?.total ?? proposal.changes.length) : 0;
  const decided = proposal ? (proposal.counts?.decided ?? proposal.changes.filter((c) => c.status !== "proposed").length) : 0;
  const proposalEx = proposal
    ? { text: `${proposal.short_id}, the one open now: ${total} ${total === 1 ? "change" : "changes"}, ${decided} decided.`, own: true }
    : { text: "op-12: 90 changes, none decided yet.", own: false };
  const chiefEx = chief
    ? { text: `${handle(chief.handle)}, ${chief.status === "paused" ? "hired and paused" : "hired"}${chief.caps ? `, ${capsLine(chief.caps)} a day` : ""}.`, own: true }
    : { text: "Not hired here yet; \"Hire a Chief of Staff\" on the Staffing tab seats one.", own: false };

  const examples: Record<GlossaryWord, { text: string; own: boolean }> = {
    role: roleEx, scope: scopeEx, charter: charterEx, hand: handEx, wake: wakeEx, budget: budgetEx, proposal: proposalEx, chief_of_staff: chiefEx,
  };
  return GLOSSARY_ORDER.map((word) => ({ word, term: GLOSSARY_TERM[word], definition: DEFINITION[word], example: examples[word].text, own: examples[word].own }));
}

function trimTo(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The short "how this works" page (S17): what the org page and a proposal
 * are for, in four short paragraphs a person can read in under a minute.
 * The glossary below it is where the words are defined; this text uses them.
 */
export const HOW_THIS_WORKS: { heading: string; body: string }[] = [
  {
    heading: "What you are looking at",
    body: "The org page is the reporting chart of your workspace: the people, the standing agents they hired, and every session under them. Each standing agent has an area of work it looks after, so it knows what to pick up and what to leave alone.",
  },
  {
    heading: "Where a proposal comes from",
    body: "An agent reads how work actually moves through the company: which plans finished, which tasks nobody touched, where decisions pile up. It then writes a proposal: a list of changes to the org, each with the evidence behind it. The chief of staff is the standing agent that does this on a schedule; you can also ask for one review at any time.",
  },
  {
    heading: "What accepting does",
    body: "Nothing moves until you accept a change. Accept applies that one change; edit lets you adjust it first; skip leaves things as they are. Every accepted change can be undone from the chart, except where its own line says otherwise. Accepting a whole group applies each change in it the same way.",
  },
  {
    heading: "Talking it over",
    body: "The agent that wrote the proposal is in the pane with you. Ask why a change is there, say what is wrong in plain words, or tell it to drop something, and it answers and revises the list under you. You accept what is left.",
  },
];
