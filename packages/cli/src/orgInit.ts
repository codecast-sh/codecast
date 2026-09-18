// `cast org init`, `update`, `review`, `inputs`, `propose`, `proposals`,
// `apply`, `staff`, `health` (docs/architecture/org-init.md O1, O2;
// org-staffing.md S3, S4, S6, S8). The analyzer is an agent session briefed by
// the prompt orgInitRun.ts builds: it reads how work flows through the
// company and posts a proposal (op-N) whose changes a person accepts, edits or
// skips one by one. Nothing is applied by the analyzer.
//
// This module is on the CLI boot graph (bench/bootGraph.guard.test.ts), so it
// registers the verbs and holds the named rules only; every body, the prompt
// template and the contracts it embeds load inside each action from
// orgInitRun.ts.
import type { Command } from "commander";

/** The two prompt modes (S8). `cast org update` is review mode. */
export type OrgInitMode = "init" | "review";

export interface OrgInitDeps {
  cliPost: (urlPath: string, body: Record<string, any>) => Promise<any>;
  readWorkspace: (explicitTeam?: string) => Promise<{ kind: "team" | "personal"; [k: string]: any }>;
  workspaceArgs: (ws: any) => { team_id?: string };
  workspaceLabel: (ws: any) => string;
  /** The web origin, for the `/org?proposal=op-N` link a proposal prints. */
  webUrl: () => string;
  /** The session this `cast` runs inside, or undefined at a plain shell. A
   *  shell is the person; a session may propose but never apply. */
  callingSession: () => string | undefined;
  /** The directory `cast` runs in (symlinks resolved): the project path a
   *  provisioned standing session starts in. */
  realCwd: () => string;
}

// The three honesty rules every analyzer run carries. Named so the test can
// assert the prompt keeps them, whatever else the wording becomes.
export const ORG_INIT_HONESTY_RULES = {
  empty_yields_intake: "An empty or thin company yields an intake draft: one role that gathers what the people want to build, with a charter that says so. Never invent projects, plans or work to give a role something to own.",
  unreadable_is_unverified: "Anything you could not read (a private session, a repo you cannot open, a count at its cap) is reported as \"could not verify\", never as absent and never as estimated.",
  no_manufactured_work: "Never create tasks, plans, projects or sessions to support a proposal. The proposal cites what exists; the proposal is the only thing you create.",
} as const;

// Ground in what is happening, not in what was filed (S9). Plans go stale and
// tasks finish without being closed; the analyzer reads activity before
// records, brings the records in line first, and never staffs around a stale
// one. Named so the test can assert the prompt keeps them.
export const ORG_GROUNDING_RULES = {
  activity_first: "Read activity before records. Where the commits and the sessions are is the ground truth; every plan, task and project is a claim about that ground, to verify before you build on it.",
  done_is_sync: "A plan or task whose evidence says it is finished is a sync change, not a bottleneck: propose its status change, and count it out of every load you size.",
  untouched_is_not_a_seat: "Scopes follow where the commits and sessions are. A project whose path nobody touches is not a seat, and a plan nobody works is not a load; never staff around a stale record.",
  records_first: "Propose the changes that bring records in line first, in their own group ahead of every staffing change, so the chart you propose sits on the company as it is, not as it was filed.",
} as const;

/** Standing versus program roles (S10): every proposed role says which, with its end condition. */
export const ORG_TENURE_RULE = "Every role you propose is standing or a program, and the change says which and why. Standing is an area that outlives any plan: a business line, a platform. A program is a bounded effort with an end: one plan, a dated push, a migration; name what ends it and what happens then, a retirement or a review. When in doubt, a program: converting a program to standing later is one edit, while retiring a standing seat that should have been a program is a week of wakes.";

// The ask (S17): the summary is the first thing a founder reads, on a phone,
// about a feature they have never seen. Named so the test can assert the
// prompt keeps them, whatever else the wording becomes.
export const ORG_ASK_RULES = {
  reader: "The summary is written for a person who has never seen this feature and has never heard of a role, a scope, a charter, a hand, a wake or a budget in tokens. It is the opening of a letter to that person: what you looked at, what you are asking them to accept, what changes for them if they do, and what it costs. They read it on a phone before opening anything else, and they decide from it.",
  decision_first: "Lead with the decision you are asking for: one or two sentences the reader could say yes or no to, before any count, any name and any finding. Everything after it explains that decision; nothing after it introduces a second one the reader has to find.",
  invented_words: "The words of this briefing (business line, seat, manager, hand, wake, token, budget, allowance, standing, program, ledger, filing, anchor, frame, flag) are for your reasoning, and the page the person reads has settled on its own: a role is the thing you add, retire or move (say once that a role is an agent that keeps watching one area of work, and call it a role from then on, in the letter and in every ask), an area of work is what it looks after, a daily limit is what it may spend, and a role that stays is said as staying, not as standing. The first screen carries the page's word and nothing else; a word the page does not use is explained in plain words the first time it appears, or not used at all, and that holds for every line of the summary, the asks, the evidence, what could not be verified and the findings, not the ask alone. A count of wakes never stands alone: wherever the number appears, say in your own words what one wake is, an agent starting up to read what changed and act on it, the way a token count says what a token is; and such counts belong after the headings and in the changes, not on the first screen. The names of the inputs you read (an activity block, a health flag, a ledger, a frame) never reach the reader, who is told what the data showed. Something you propose to create is introduced once with what it is and what it will do, and called by those same words after that. An agent's handle (@product) comes after what that agent looks after, never instead of it. A project's or a plan's name appears as it is filed, capitalized or quoted, so it reads as a name and not as a word. A signal from the health report is told as what is happening, never by its name. A short id never stands in for a name.",
  numbers_mean_something: "A number says what it means for the reader, never only its value: what it counts, what it was before, and what changes because of it. Counts joined by commas are a defect. A number the reader cannot act on stays in the change, not in the summary.",
  cost_in_plain_words: "The cost is what the reader gives up by accepting, and on the first screen it is a comparison with today that a person can picture: the daily limits add up to more, less or about the same, and by roughly what share. Read that share from the limit that costs money, how much the roles may read and write in a day; the page prints the same comparison under the asks, and the two must agree. The arithmetic behind that comparison goes after the headings, in the units the limits are counted in, and there a unit of spend is explained where the cost is stated, as what it lets an agent do, the first time it appears. A budget stated as bare numbers is not a cost.",
  readable_once: "Every sentence is one the reader understands on the first read. A sentence they would have to reread or decode is a defect in the summary, not a style choice: rewrite it in plainer words or cut it. Before you post, read the whole summary once more as that person, the lines after the ask included; a word they were not taught, a number without its meaning, or a sentence they would reread is rewritten before it goes out.",
} as const;

/** The asks (S19): the proposal is a few things asked of the person, with the
 *  changes folded inside each; the analyzer writes them at propose time. */
export const ORG_ASKS_RULE = "The proposal is a few asks, not a list of rows: a person answers three questions readily and a hundred and fifty not at all. Write the asks into the spec as `asks: [{ title, why, effect, seqs }]`, where seqs are the numbers of the changes the ask holds (1 is the first change) and every change is in exactly one ask; the post refuses a spec that leaves a change out or names one twice. The asks are the things your summary asks for, in the same words and the same order: when the summary says one, two, three, those are the asks. A title is the head of a card: a short line, about ten words, that names the act the person is agreeing to and reads with nothing else on the screen. The reason does not go in the title, it goes in why, one sentence; the counts and what changes for them when they accept go in effect, one line. The ask rules bind these lines too: no word the reader was not taught, every unit explained. A change that only serves another rides inside its ask (the filings a new agent's area rests on, its adopt, its routine) and never stands alone; keep the asks few.";

/** The letter shape (S19): the summary is the author's first bubble in a
 *  conversation, and the page shows the words the propose step wrote and
 *  nothing else, so the first screen is decided here. */
export const ORG_LETTER_RULE = "The summary is a letter read in a chat bubble, on a phone, by a person who has not seen this workspace's records, and the page shows the words you write and nothing else. Its shape: one short paragraph that says what you are, what you looked at and that they decide; then one short paragraph per ask, in the asks' order, each ending in what accepting changes for the reader; then nothing, until a blank line and a bold heading open the rest of the letter. Those first paragraphs are the whole first screen, and the measure is that a person reads them in ten seconds and can say what is asked of them; a paragraph they would not read aloud in one breath is too long. The evidence, the counts, the arithmetic and the cost go in the paragraphs after the headings, which the page keeps behind the first screen, and in the changes themselves. An ask's why is one sentence and its effect is one sentence, in the voice of the letter and no longer: a reason that needs the evidence to be believed points at it instead of carrying it, and the effect names what the person will notice once they accept, never what the machine will do row by row; the rows are inside the card, folded, and the fold already lists each one.";

/** A long running session is a role that has not been named (org-roles-run-work.md R2). */
export const ORG_UNNAMED_ROLES_RULE = "A session older than a week with a standing purpose is a role that has not been named. The inputs list the long running sessions with the facts to judge them by (`sessions.long_running`): how long each has run, how many helper sessions it started, the routines that wake it, its pinned state, its first message and the projects it touched. A session that keeps returning to one area of work, that wakes on a routine, or that has started helpers by the hundred is managing that area already, whatever it was first opened for; a long session that is one large task ends when the task ends, and is not a role. Propose each session that already works as a role as a role change whose seat is the session itself, so accepting names it rather than replaces it: nothing restarts, its history stays, and the sessions it started stay under it. Everything about the role is read from the session, not designed: its name is the session's title, its area is the projects it touched, it reports to the person who owns it, and its charter is drafted from its pinned state and its first message, written as the job it has been doing and never as today's status. Its daily limit is set at or above what it already does in a day, so the limit never stops work that runs today. Tell the person what naming changes and what it does not, and when the session is private, that a team's role can be seen by the team. Such a role is evidence of where work is managed, so read it before you size any new role over the same area. In a finding, name the long running sessions you considered and did not propose, each with its reason in a few words, so the person can name one you left out.";

/** When the analyzer offers to become the chief of staff (S8, last bullet). */
export const ORG_ADOPT_RULE = "When the company has no chief of staff and holds two or more roles or three or more projects, counted after the changes in this proposal, add one adopt change for a chief-of-staff role you propose in the same proposal. The conversation it names is the workspace's standing anchor when one exists (`cast anchor ls --json`, the row for this workspace): the chief of staff is that agent, and adopting it keeps every Slack and chat binding as an alias and restarts nothing. Only a workspace with no anchor adopts this session. Offer it once, last, and let the person decide; a company below that size does not need a standing reviewer yet.";

export type OrgInitSummary = {
  projects: number;
  plans: number;
  tasks_open: number;
  members: number;
  sessions_30d: number;
  roles: number;
  git_roots: string[];
  /** Whether a chief-of-staff role already exists (the adopt rule's first test). */
  chief_of_staff: boolean;
  /** Records the activity block (S9) says are behind what happened: the
   *  glance names them so the reader knows sync changes come first. */
  stale: { plans: number; tasks: number; projects: number };
};

export const ORG_INIT_LABEL = "org-init";
export const CHIEF_OF_STAFF_HANDLE = "chief-of-staff";

const TEAM_OPT = ["--team <name|id|personal>", "Team workspace (default: the active workspace); personal for your own"] as const;

/** commander collector for a flag that repeats. */
function collectValues(value: string, previous: string[]): string[] { return [...previous, value]; }

export function registerOrgInitCommands(program: Command, deps: OrgInitDeps): void {
  const org = program.commands.find((c) => c.name() === "org");
  if (!org) throw new Error("cast org group is not registered; register it before the init commands");
  const run = async () => await import("./orgInitRun.js");

  org
    .command("inputs")
    .description("The evidence the org analyzer reads: projects, plans, members, sessions, git roots, insights, channels, roles, open decisions (30 days, capped)")
    .option(...TEAM_OPT)
    .option("--json", "Machine-readable output (the whole payload)")
    .action(async (options: any) => (await run()).showInputs(deps, options));

  org
    .command("init")
    .description("Propose the first organization for the company: spawns an analyzer session that reads how work flows and posts a proposal (op-N) for the person to decide on the org page or with cast org apply")
    .option("--here", "Print the analyzer prompt for the current agent to act on instead of spawning a session")
    .option(...TEAM_OPT)
    .action(async (options: any) => (await run()).runAnalyzer(deps, "init", { ...options, spawn: !options.here }));

  org
    .command("update")
    .description("Review the company against the capacity model and propose the smallest changes that remove a bottleneck (the same run as cast org review, spawned)")
    .option("--here", "Print the review prompt for the current agent to act on instead of spawning a session")
    .option(...TEAM_OPT)
    .action(async (options: any) => (await run()).runAnalyzer(deps, "review", { ...options, spawn: !options.here }));

  org
    .command("review")
    .description("The company review: prints the review prompt for the current agent (the chief of staff's routine runs this); --spawn runs it in a fresh session")
    .option("--spawn", "Run the review in a fresh session instead of printing the prompt here")
    .option("--here", "Print the prompt here (the default)")
    .option(...TEAM_OPT)
    .action(async (options: any) => (await run()).runAnalyzer(deps, "review", { ...options, spawn: !!options.spawn && !options.here }));

  org
    .command("propose")
    .description("Post a staffing proposal from a spec (the analyzer's output): prints op-N and the org page link")
    .requiredOption("--spec <file|->", "The proposal spec as JSON: { title, summary_md, mode, changes: [{ change, rationale, evidence, expected_effect, risk }] }; '-' reads stdin")
    .option("--supersedes <op-N>", "The open proposal this one replaces: your own earlier review (same author, role, or the role's session); the org page then says so and offers Withdraw on the older one")
    .option(...TEAM_OPT)
    .option("--json", "Machine-readable output")
    .action(async (options: any) => (await run()).propose(deps, options));

  org
    .command("revise")
    .description("Revise your own open proposal (op-N) from the session that posted it: remove a change, amend one, add one. Authoring, not deciding: a person still accepts each change on the org page, and a change they already decided is refused by name.")
    .argument("<op-N>", "The proposal to revise")
    .option("--remove <seq>", "Remove change #seq (repeat for several)", collectValues, [])
    .option("--amend <seq>", "Amend change #seq with --edits and/or --rationale")
    .option("--edits <json|file>", "For --amend: an object patch over the change's own keys, the shape an edit on the org page takes, e.g. '{\"caps\":{\"wakes_per_day\":6}}'")
    .option("--rationale <text>", "For --amend: the new rationale")
    .option("--add <file|->", "Add changes from JSON: one spec change { change, rationale, evidence?, expected_effect?, risk? } or a list of them; '-' reads stdin (repeat for several files)", collectValues, [])
    .option("--note <text>", "One line in your words, shown beside every change this revise touches")
    .option("--ops <file|->", "The ops as JSON instead of the flags: [{ op: \"remove\"|\"amend\", seq, edits?, rationale?, note? } | { op: \"add\", change, note? }]")
    .option("--json", "Machine-readable output")
    .action(async (ref: string, options: any) => (await run()).revise(deps, ref, options));

  org
    .command("proposals")
    .description("Staffing proposals for the workspace, open first")
    .option("--all", "Include resolved and withdrawn proposals")
    .option("--withdraw <op-N>", "Withdraw an open proposal instead of listing")
    .option(...TEAM_OPT)
    .option("--json", "Machine-readable output")
    .action(async (options: any) => (await run()).listProposals(deps, options));

  org
    .command("apply")
    .description("For a proposal (op-N): print its changes, their status and the org page link, where a person accepts, edits or skips each one (the page is the only door; S4). For a template's decision stack (ds-N): apply the answered decisions as before.")
    .argument("<ref>", "A proposal (op-N) or, for templates that still use one, a decision stack (ds-N)")
    .option(...TEAM_OPT)
    .option("--no-provision", "Stacks only: create roles without provisioning their standing sessions")
    .option("--json", "Machine-readable output")
    .action(async (ref: string, options: any) => (await run()).apply(deps, ref, options));

  org
    .command("staff")
    .description("Hire the Chief of Staff: the role, its standing session, a weekly company review, and the first review now. Idempotent per company.")
    .option("--adopt", "This session becomes the chief of staff's standing session instead of provisioning a new one")
    .option("--seat <existing|fresh>", "With a standing agent already in the workspace: seat it (default, nothing restarts) or start a fresh session and retire it in the same act")
    .option("-C, --dir <path>", "Project directory the provisioned standing session starts in (default: current; ignored with --adopt)")
    .option("--every <duration>", "How often the company review runs", "7d")
    .option(...TEAM_OPT)
    .option("--json", "Machine-readable output")
    .action(async (options: any) => (await run()).staff(deps, options));

  org
    .command("health")
    .description("Flow signals per role, per person and for the company, with the flags the capacity model raises")
    .option(...TEAM_OPT)
    .option("--json", "Machine-readable output (the whole payload)")
    .action(async (options: any) => (await run()).health(deps, options));
}
