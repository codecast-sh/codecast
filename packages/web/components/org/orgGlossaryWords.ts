// The words the Org screen uses (docs/architecture/org-staffing.md S17),
// defined in one place: one sentence each, and an example drawn from the
// reader's own workspace when the tree, the health read, the open proposal or
// the company's goals and projects carry one. Nothing else in the product
// restates a definition; surfaces link here. One word, one meaning: a goal is
// the company's (never a person's priorities, which are their focus), a
// project is a body of work, a role is an agent (never a seat), and every
// sheet reads with the same three relations: Serves, Carried by, Now.
import type { OrgTree } from "./orgTypes";
import type { OrgHealth, OrgProposalRow } from "./orgStaffingTypes";
import { isHeadOfPeopleRole } from "./orgStaffingTypes";

export type GlossaryWord = "goal" | "project" | "serves" | "carried_by" | "now" | "role" | "area" | "charter" | "focus" | "session" | "trigger" | "proposal" | "head_of_people";

/** The company's goals and projects, for examples from the reader's own
 *  workspace. Optional: without them the company words use general ones. */
export type GlossaryCompany = {
  goals: readonly { _id: string; title: string; parent_initiative_id?: string; project_ids?: readonly string[] }[];
  projects: readonly { _id: string; title: string }[];
};

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

export const GLOSSARY_ORDER: GlossaryWord[] = ["goal", "project", "serves", "carried_by", "now", "role", "area", "charter", "focus", "session", "trigger", "proposal", "head_of_people"];

export const GLOSSARY_TERM: Record<GlossaryWord, string> = {
  goal: "Goal",
  project: "Project",
  serves: "Serves",
  carried_by: "Carried by",
  now: "Now",
  focus: "Focus",
  role: "Role",
  area: "Area",
  charter: "Charter",
  session: "Sessions",
  trigger: "Trigger",
  proposal: "Proposal",
  head_of_people: "Head of people",
};

const DEFINITION: Record<GlossaryWord, string> = {
  goal: "Something the company is trying to reach, measured by a number when it has one, with one person or role who answers for it.",
  project: "A body of work with a lead and a board of tasks, which says what it is for and which goals it serves.",
  serves: "What a thing is in service of: a project serves its goals, a goal serves the goal above it or the mission, and a role serves the goals it drives.",
  carried_by: "What moves a thing forward: a goal is carried by its projects and sub-goals, a project by the roles and people working on it, a person by the roles they host and the projects they lead.",
  now: "What is happening on a thing at this moment: the sessions at work on it, what waits on you, and any open proposal that would change it.",
  focus: "A person's own priorities, kept by the role they report to so it can match its work against them, as distinct from a goal, which is the company's.",
  role: "An agent with a name and a face that keeps working for you: it reports to someone, and sessions report to it.",
  area: "The projects and plans a role looks after; a role with no area still runs its check and answers what it is asked.",
  charter: "A short written statement of what a role or a project is for, so a role can tell its own work from someone else's.",
  session: "The pieces of work under a role, each in its own thread; the role answers them so you do not have to.",
  trigger: "What wakes a role on its own: its check on a schedule, or a session under it that is waiting; a message from you wakes it too.",
  proposal: "A change to the org that the head of people suggests in conversation; you accept it, skip it or ask about it, and nothing moves until you accept.",
  head_of_people: "The role that keeps the structure true: it reviews the org with you every week, proposes roles and owners, and looks after whatever no other role has taken.",
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
export function glossaryEntries(tree: OrgTree | null | undefined, health: OrgHealth | null | undefined, proposal: Pick<OrgProposalRow, "short_id" | "changes" | "counts"> | null | undefined, company?: GlossaryCompany | null): GlossaryEntry[] {
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
  // The company words: a goal with projects under it names all three
  // relations; a sub-goal names what it serves when no goal has projects.
  const projectTitle = new Map((company?.projects ?? []).map((p) => [p._id, p.title]));
  const goalTitle = new Map((company?.goals ?? []).map((g) => [g._id, g.title]));
  const carried = (company?.goals ?? []).map((g) => ({ g, projects: (g.project_ids ?? []).map((id) => projectTitle.get(id)).filter((t): t is string => !!t) })).find((x) => x.projects.length > 0) ?? null;
  const subGoal = (company?.goals ?? []).find((g) => g.parent_initiative_id && goalTitle.has(g.parent_initiative_id)) ?? null;
  const anyGoal = carried?.g ?? company?.goals[0] ?? null;
  const anyProject = carried ? carried.projects[0] : company?.projects[0]?.title ?? null;
  const goalEx = anyGoal
    ? { text: `"${anyGoal.title}"${carried ? `, carried by ${listOf(carried.projects)}` : ""}.`, own: true }
    : { text: "\"Increase top of funnel\": 10,000 cold emails a day by December, owned by the Outbound lead.", own: false };
  const projectEx = anyProject
    ? { text: `"${anyProject}"${carried ? `, which serves "${carried.g.title}"` : ""}.`, own: true }
    : { text: "\"Lead lists\": a lead, 22 tasks on its board, and the goal it moves.", own: false };
  const servesEx = carried
    ? { text: `"${carried.projects[0]}" serves "${carried.g.title}".`, own: true }
    : subGoal
      ? { text: `"${subGoal.title}" serves "${goalTitle.get(subGoal.parent_initiative_id!)}".`, own: true }
      : { text: "The Lead lists project serves the goal Increase top of funnel, which serves Make revenue.", own: false };
  const carriedEx = carried
    ? { text: `"${carried.g.title}" is carried by ${listOf(carried.projects.map((t) => `"${t}"`), 3)}.`, own: true }
    : { text: "Make revenue is carried by Increase top of funnel and two projects.", own: false };
  const nowEx = { text: "Two sessions at work on Lead lists, one decision waiting on you, and a proposal to give it a new lead.", own: false };
  const focusEx = { text: "\"Close the seed round (high)\": what you told the role you report to, so it brings you what moves it.", own: false };
  const headEx = head
    ? { text: `${handle(head.handle)}, ${head.status === "paused" ? "hired and paused" : "hired"}.`, own: true }
    : { text: "Not hired here yet; \"Hire a Head of People\" on the org page hires one.", own: false };

  const examples: Record<GlossaryWord, { text: string; own: boolean }> = {
    goal: goalEx, project: projectEx, serves: servesEx, carried_by: carriedEx, now: nowEx,
    role: roleEx, area: areaEx, charter: charterEx, focus: focusEx, session: sessionEx, trigger: triggerEx, proposal: proposalEx, head_of_people: headEx,
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
    body: "On the right is the company: its goals, the projects that carry them, and the people and roles who answer for each, as a document to read or a map. Each one opens as a sheet that reads the same way: what it serves, what carries it, and what is happening now. On the left is the conversation with whoever answers for what you are reading.",
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
