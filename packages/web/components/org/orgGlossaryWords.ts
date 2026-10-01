// The words the org page uses (docs/architecture/org-staffing.md S17),
// defined in one place: one sentence each, and an example drawn from the
// reader's own workspace when the tree, the health read or the open proposal
// carry one. Nothing else in the product restates a definition; surfaces link
// here. One word per thing: a role (never a seat or an agent), its area, its
// sessions, its triggers, a proposal, a goal.
import type { OrgTree } from "./orgTypes";
import type { OrgHealth, OrgProposalRow } from "./orgStaffingTypes";
import { HEAD_OF_PEOPLE_HANDLE, isHeadOfPeopleRole } from "./orgStaffingTypes";

export type GlossaryWord = "role" | "area" | "charter" | "session" | "trigger" | "proposal" | "goal" | "head_of_people";

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

export const GLOSSARY_ORDER: GlossaryWord[] = ["role", "area", "charter", "session", "trigger", "proposal", "goal", "head_of_people"];

export const GLOSSARY_TERM: Record<GlossaryWord, string> = {
  role: "Role",
  area: "Area",
  charter: "Charter",
  session: "Sessions",
  trigger: "Trigger",
  proposal: "Proposal",
  goal: "Goal",
  head_of_people: "Head of people",
};

const DEFINITION: Record<GlossaryWord, string> = {
  role: "An agent with a name and a face that keeps working for you: it reports to someone, and sessions report to it.",
  area: "The projects and plans a role looks after; a role with no area still runs its check and answers what it is asked.",
  charter: "A short written statement of what a role or a project is for, so a role can tell its own work from someone else's.",
  session: "The pieces of work under a role, each in its own thread; the role answers them so you do not have to.",
  trigger: "What wakes a role on its own: its check on a schedule, or a session under it that is waiting; a message from you wakes it too.",
  proposal: "A change to the org that the head of people suggests in conversation; you accept it, skip it or ask about it, and nothing moves until you accept.",
  goal: "Something the company is trying to reach, with the projects that carry it and the person or role that drives it.",
  head_of_people: "The role at your side: it keeps your goals in view, looks after whatever no other role has taken, and reviews the org with you.",
};

const handle = (h: string) => `@${h.replace(/^@/, "")}`;
const listOf = (xs: string[], max = 2) => xs.length <= max ? xs.join(" and ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`;

/**
 * The entries with examples from this workspace. A role with an area names
 * the role example and the area example; a charter on a role names the
 * charter; the health read names the sessions; the open proposal names the
 * proposal; the Head of People names itself. Where the workspace has none of that
 * yet, the example says what one would be.
 */
export function glossaryEntries(tree: OrgTree | null | undefined, health: OrgHealth | null | undefined, proposal: Pick<OrgProposalRow, "short_id" | "changes" | "counts"> | null | undefined): GlossaryEntry[] {
  const roles = (tree?.roles ?? []).filter((r) => r.status !== "retired");
  const head = roles.find((r) => isHeadOfPeopleRole(r)) ?? null;
  const scoped = roles.find((r) => r.scope_names.projects.length + r.scope_names.plans.length > 0 && !isHeadOfPeopleRole(r)) ?? roles.find((r) => !isHeadOfPeopleRole(r)) ?? roles[0] ?? null;
  const chartered = roles.find((r) => r.charter?.trim()) ?? null;
  const healthRole = health?.roles.find((r) => r.load.live_hands > 0) ?? null;
  const healthName = (id: string) => roles.find((r) => r._id === id)?.handle ?? healthRole?.handle ?? "";

  const roleEx = scoped
    ? { text: `${handle(scoped.handle)}, ${scoped.name}${scoped.scope_names.projects.length ? `, looks after ${listOf(scoped.scope_names.projects.map((p) => p.title))}` : ""}.`, own: true }
    : { text: "A Head of Platform that looks after the Platform project and nothing else.", own: false };
  const areaEx = scoped && scoped.scope_names.projects.length + scoped.scope_names.plans.length > 0
    ? { text: `${handle(scoped.handle)} looks after ${[scoped.scope_names.projects.length ? `${scoped.scope_names.projects.length} ${scoped.scope_names.projects.length === 1 ? "project" : "projects"}` : "", scoped.scope_names.plans.length ? `${scoped.scope_names.plans.length} ${scoped.scope_names.plans.length === 1 ? "plan" : "plans"}` : ""].filter(Boolean).join(" and ")}: ${listOf([...scoped.scope_names.projects.map((p) => p.title), ...scoped.scope_names.plans.map((p) => p.title)], 3)}.`, own: true }
    : { text: "The Platform project and the two plans under it; a task filed elsewhere belongs to another role.", own: false };
  const charterEx = chartered
    ? { text: `${handle(chartered.handle)}: "${trimTo(chartered.charter!, 110)}"`, own: true }
    : { text: "\"Owns the sync layer, the daemon and every release of the CLI.\"", own: false };
  const sessionEx = healthRole
    ? { text: `${handle(healthName(healthRole.role_id))} has ${healthRole.load.live_hands} ${healthRole.load.live_hands === 1 ? "session" : "sessions"} working right now.`, own: true }
    : { text: "A session a role starts for a task reports to that role, and ends when the task does.", own: false };
  const triggerEx = scoped
    ? { text: `${handle(scoped.handle)}'s check, and the trigger that fires when a session under it is waiting. Both are on its Triggers tab.`, own: true }
    : { text: "\"Check Platform\", every day: the role looks over its area and says what changed.", own: false };
  const total = proposal ? (proposal.counts?.total ?? proposal.changes.length) : 0;
  const decided = proposal ? (proposal.counts?.decided ?? proposal.changes.filter((c) => c.status !== "proposed").length) : 0;
  const proposalEx = proposal
    ? { text: `The one open now: ${total} ${total === 1 ? "change" : "changes"}, ${decided} decided.`, own: true }
    : { text: "\"Add a Platform lead and move the sync plans under it.\" Accept, Skip or Ask.", own: false };
  const goalEx = { text: "\"Ship the mobile app by March\", carried by two projects and driven by the Platform lead.", own: false };
  const headEx = head
    ? { text: `${handle(head.handle)}, ${head.status === "paused" ? "hired and paused" : "hired"}.`, own: true }
    : { text: "Not hired here yet; \"Hire a Head of People\" on the org page hires one.", own: false };

  const examples: Record<GlossaryWord, { text: string; own: boolean }> = {
    role: roleEx, area: areaEx, charter: charterEx, session: sessionEx, trigger: triggerEx, proposal: proposalEx, goal: goalEx, head_of_people: headEx,
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
 * The glossary beside it is where the words are defined; this text uses them.
 */
export const HOW_THIS_WORKS: { heading: string; body: string }[] = [
  {
    heading: "What you are looking at",
    body: "The org page is the reporting chart of your workspace: the people, their roles, and every session under them. A role can have an area it looks after, so it knows what to pick up and what to leave alone.",
  },
  {
    heading: "Where a proposal comes from",
    body: "The head of people reads how work actually moves through the company: which plans finished, which tasks nobody touched, where decisions pile up. Then it talks it over with you and makes small proposals as you go, each with the evidence behind it. It reviews the company every week; you can also ask for a review at any time.",
  },
  {
    heading: "What accepting does",
    body: "Nothing moves until you accept a change. Accept applies that one change; edit lets you adjust it first; skip leaves things as they are. Every accepted change can be undone from History, except where the change itself says otherwise. Accepting a whole group applies each change in it the same way.",
  },
  {
    heading: "Talking it over",
    body: "The role that made the proposal is in the conversation with you. Ask why a change is there, say what is wrong in plain words, or tell it to drop something, and it answers and revises the proposal. You accept what is left.",
  },
];
