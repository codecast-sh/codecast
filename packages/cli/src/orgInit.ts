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
  reader: "The summary is written for a person who has never seen this feature and has never heard of a role, a scope, a charter, a hand or a wake. It is the opening of a letter to that person: what you looked at, what you are asking them to accept, and what changes for them if they do. They read it on a phone before opening anything else, and they decide from it.",
  decision_first: "Once the letter has said how the goals are going, lead with the decision you are asking for: one or two sentences the reader could say yes or no to, before any count, any other name and any other finding. Everything after it explains that decision; nothing after it introduces a second one the reader has to find.",
  invented_words: "The words of this briefing (business line, seat, manager, hand, wake, standing, program, ledger, filing, anchor, frame, flag) are for your reasoning, and the page the person reads has settled on its own: a role is the thing you add, retire or move (say once that a role is an agent that keeps watching one area of work, and call it a role from then on, in the letter and in every ask), an area of work is what it looks after, and a role that stays is said as staying, not as standing. What a role may do in a day is not the reader's to decide and never appears: no limit, no count of what it may spend, no cost. The first screen carries the page's word and nothing else; a word the page does not use is explained in plain words the first time it appears, or not used at all, and that holds for every line of the summary, the asks, the evidence, what could not be verified and the findings, not the ask alone. A count of wakes never stands alone: wherever the number appears, say in your own words what one wake is, an agent starting up to read what changed and act on it; and such counts belong after the headings and in the changes, not on the first screen. The names of the inputs you read (an activity block, a health flag, a ledger, a frame) never reach the reader, who is told what the data showed. Something you propose to create is introduced once with what it is and what it will do, and called by those same words after that. An agent's handle (@product) comes after what that agent looks after, never instead of it. A project's or a plan's name appears as it is filed, capitalized or quoted, so it reads as a name and not as a word. A signal from the health report is told as what is happening, never by its name. A short id never stands in for a name.",
  numbers_mean_something: "A number says what it means for the reader, never only its value: what it counts, what it was before, and what changes because of it. Counts joined by commas are a defect. A number the reader cannot act on stays in the change, not in the summary.",
  readable_once: "Every sentence is one the reader understands on the first read. A sentence they would have to reread or decode is a defect in the summary, not a style choice: rewrite it in plainer words or cut it. Before you post, read the whole summary once more as that person, the lines after the ask included; a word they were not taught, a number without its meaning, or a sentence they would reread is rewritten before it goes out.",
} as const;

/** The asks (S19): the proposal is a few things asked of the person, with the
 *  changes folded inside each; the analyzer writes them at propose time. */
export const ORG_ASKS_RULE = "The proposal is a few asks, not a list of rows: a person answers three questions readily and a hundred and fifty not at all. Write the asks into the spec as `asks: [{ title, why, effect, seqs }]`, where seqs are the numbers of the changes the ask holds (1 is the first change) and every change is in exactly one ask; the post refuses a spec that leaves a change out or names one twice. The asks are the things your summary asks for, in the same words and the same order: when the summary says one, two, three, those are the asks. A title is the head of a card: a short line, about ten words, that names the act the person is agreeing to and reads with nothing else on the screen. The reason does not go in the title, it goes in why, one sentence; the counts and what changes for them when they accept go in effect, one line. A card is read by a person who has not read the letter and may never open it, so its three lines stand alone: each thing they name is named in full words on the card itself (the session by its title, the role by its name and its area), and nothing on a card points at something only the letter explains, such as a move or a lead named by a word the card did not introduce. The letter and the cards use one word for one thing, and the word is the page's: a standing agent is a role, never a lead, a seat, a watcher or a reader as a common noun (a role's own name, such as Infrastructure lead, stays its name), a session is a session, and a card names a thing in the same words the letter used for it. An effect line names only the things its title named: when accepting also does something the title did not say, the title is too narrow or the change belongs in another ask; widen the title or move the change, never the effect. Neither why nor effect runs past two short sentences: three asks with their Accept and Skip share one desktop screen with the letter, and a card that runs long pushes the third ask's buttons below the fold. The ask rules bind these lines too: no word the reader was not taught, every unit explained. A change that only serves another rides inside its ask (the filings a new agent's area rests on, its adopt, its routine) and never stands alone; keep the asks few.";

/** The letter shape (S19): the summary is the author's first bubble in a
 *  conversation, and the page shows the words the propose step wrote and
 *  nothing else, so the first screen is decided here. */
export const ORG_LETTER_RULE = "The summary is a letter read in a chat bubble, on a phone, by a person who has not seen this workspace's records, and the page shows the words you write and nothing else. Its shape: one short paragraph that says what you are, what you looked at and that they decide; then one short paragraph on how the company's goals are going, which the initiatives rule shapes; then one short paragraph per ask, in the asks' order, each ending in what accepting changes for the reader; then nothing, until a blank line and a bold heading open the rest of the letter. Those first paragraphs are the whole first screen, and the measure is that a person reads them in ten seconds and can say what is asked of them; a paragraph they would not read aloud in one breath is too long. The page keeps about 1,800 characters, roughly 250 words, before the first heading on the first screen; a letter longer than that before its heading folds after its first paragraph and the asks vanish from the screen, so the introduction is two sentences, the goals paragraph two or three, each ask's paragraph two or three, and every count and every piece of evidence waits until after the headings. The evidence, the counts, the arithmetic and the cost go in the paragraphs after the headings, which the page keeps behind the first screen, and in the changes themselves. An ask's why is one sentence and its effect is one sentence, in the voice of the letter and no longer: a reason that needs the evidence to be believed points at it instead of carrying it, and the effect names what the person will notice once they accept, never what the machine will do row by row; the rows are inside the card, folded, and the fold already lists each one.";

/** A long running session is a role that has not been named (org-roles-run-work.md R2). */
export const ORG_UNNAMED_ROLES_RULE = "A session older than a week with a standing purpose is a role that has not been named. `sessions.long_running` lists the candidates with what to judge them by: age, helpers, the routines that wake it, its pinned state, its first message, its work share by project. None of those rows is a role, whatever it reports to: the roles are `org.roles`, and a session that reports to a role is that role's hand. A session is a standing job when it keeps returning to one area, or a routine wakes it to do the same job again, however small its spend, and the job has no end its row names. A session that is one task, one feature build, one experiment, one dated watch or a monitor left on a finished fix ends with that work: at most a program whose end is that plan or task, never a standing role. A session quiet for more than two weeks has ended and is not a seat; the seats are the rows still active this week. Propose a standing session as a role change whose seat is the session itself, so accepting names it and replaces nothing: it keeps its history and its helpers. Naming keeps the reporting line the session has today, the person who runs it, and the card says so. Read the role from the session rather than design it: its name is the session's title; its area is where most of its work is, the one project that holds most of its row's `projects` counts (tasks touched, commits of the window, messages naming the project, and being bound there), never a project it did not touch, and never one with a single task and nothing else beside it; its charter is drafted from its pinned state and first message as the job it does, not today's status. A private session named as a team role becomes visible to the team; say so. A standing session is evidence of where its area is managed, so read it before proposing any new role over that area. An area a role watches, or a paused role once watched, is no reason to skip the name or to fold the session into that role in a finding; where it belongs under that role, say so as a separate move change in the same ask, so the person can take the name and skip the move. In a finding, name every row of `sessions.long_running` you did not propose, with its reason in a few words: a row in neither the seats nor that list is a row you did not read.";

/** Two shapes people asked for on the 2026-09-18 huddle: a role that watches
 *  one agent's mistakes, and a role a person reports to (org-roles-run-work.md R6). */
export const ORG_ASKED_FOR_RULES = {
  agent_quality: "A role over agent quality watches one agent's recurring mistakes and turns each finding into a change to that agent's prompt. When you propose one, its charter says that in those words, names the agent it watches, and its routine runs the cast-lessons harvest every week over that agent's sessions (`cast-lessons` reads the corrections people made in those sessions and proposes the prompt lines that would have prevented each), so the role's week is a list of prompt changes with the correction behind each, never a report.",
  goal_tracker: "A person who reports to a role is asking for a goal tracker, not a gatekeeper: one place that keeps their few high level goals, reads their sessions against those goals, and keeps them making progress on what matters. It is never permission to do things. When you propose a chief of staff, or any role a person reports to, the ask says that in the reader's words, so nobody reads reporting to an agent as answering to one.",
} as const;

/** Initiatives are the top of the tree the analyzer reads, and the letter's
 *  second paragraph (initiatives-projects-role-page.md I1). */
export const ORG_INITIATIVES_RULE = "An initiative is a goal the company set for itself, carried by the projects added to it on purpose and driven by one owner, a person or a role. It is the top of the tree you read: the initiatives, then the projects in each, then the plans and tasks inside a project, then the roles that lead and the sessions that do the work. The inputs list the open initiatives in `coverage.initiatives`, each with its status, its owner, the health its owner last reported and when, its target date, and its projects with their leads. Read them before anything else, and weigh every project, plan and role by what it does for the initiative it serves. How an initiative is doing is two readings set side by side: what its owner last said, and what its projects show, which is work closing or stalled, a plan past its target, a project with no lead, an update that is weeks old. When the two disagree, say both. The goals are yours to propose, as changes a person accepts, and never yours to apply. When the evidence shows one shared goal that no initiative holds, propose it: the projects' own goals and charters point at the same end, or a call or a chat thread names it as what the company is trying to reach. The change is `initiative`, with the goal's name, one sentence that says what reaching it looks like, the projects whose work carries it, and the owner when the evidence shows who drives that work, the person or the role that already leads most of its projects. When a project's work serves an initiative that does not list it, propose `initiative_projects`. When an active initiative has no owner, that is the first finding of the review, ahead of every record and every role, because nobody drives that goal; propose `initiative_owner` naming who drives it, and say in the finding why that person or role. A shared goal you only suspect is a finding, not a change: a goal set on a guess costs a person the work of taking it back. Every goal change goes in the goals ask, before the seats, and is worded for a person who has not read the letter. The letter says how the goals are going before it asks for anything. Its second paragraph gives each active initiative one sentence: the initiative by its name, how it is going, and the one thing most in its way. With more than four, name those at risk, off track or without an owner and count the rest. Call them initiatives, which is the word on the page the reader opens, never goals or objectives, and the first time the word appears say in a few words that an initiative is a goal the company set, with the projects that carry it. A company with no initiatives has not yet said what it is trying to reach: the paragraph says that in one sentence, and the goal the projects point at, when there is one, is the `initiative` change the goals ask carries.";

/** Every project with work has a lead, and work outside any project gets a
 *  project and then a lead (initiatives-projects-role-page.md I2). */
export const ORG_COVERAGE_RULE = "Every piece of work has a lead, and a paused lead is not one: `coverage` names such a project's role as `lead_paused` and counts the project as without a lead, so the proposal asks the person to resume it or to replace it as a change they accept or skip (a move that resumes it, or a role that replaces it and a retire), never as a finding alone, before it sizes anything over that area. `coverage` in the inputs says where that stands today: the projects with work planned or in progress, each with its lead (the role the project names, or the one role whose area lists it), the roles that watch a project none of them leads, and the work that sits outside any project: plans with open tasks and no project, open tasks with neither, and areas of a repository where commits and sessions landed and no project claims them. Propose leads until all of it is covered, from the initiative down: the projects of an active initiative first, then every other project with work. Wrap the project that exists: a new role's area is the project as it is filed, under its own name, and you never invent an area beside a project that already holds the work. A session that already works as a role is the first candidate to lead the projects it touched. An uncovered area's commits count every author in that repository, whoever they work for, while its sessions are this workspace's own: a repository with many commits and only a handful of this workspace's sessions is another company's work seen through a shared checkout, so it gets no project and no role, and one finding asks the person whether it belongs here. A new repository that one person alone has worked in, with no project and no task filed under it, is the same kind of question: whether it is this company's business is theirs to say, and neither a live site, a shipped version nor a plan filed for it settles that, so it gets a finding that asks and neither a project nor a role until they answer. Work outside any project that this workspace's own sessions and filed tasks show to be its business gets a project first, a `projects` create whose title says what the work is and whose path is where it lives, with `file` changes for the loose plans that belong to it, and then a lead, in the same proposal and in that order. Aim at about one role per project, and depart from that only with a reason the change states: two small projects next to each other share one lead, or one large project is split along its plans, each side filed under its own project first. A lead watches work that sessions and commits carry: a project whose open work is a person's own hand list (imported tickets, hiring, deals, filings, with no sessions and no commits under it) gets no role and one sentence in the letter saying why, and a tracker of one person's proposals is the same subject as the area they propose for and shares that area's lead rather than getting its own. Coverage is counted after the records are in line: a project whose work the evidence says is finished or untouched is paused, needs no lead and leaves the count. A lead for a small project is a small role, sized on the load that will reach it, and the letter says what full coverage costs, since every role spends from the same daily total. Leads that are alike, small roles that each wrap one existing project, are one ask; a lead that departs from one role per project, or costs markedly more than the others, is its own ask. After the headings, the letter carries one coverage line that says before and after in counts, in this form: \"9 of 12 projects had a lead; after, 12 of 12, and 2 new projects hold work that had none\". The before count is `coverage.with_lead` of `coverage.with_work`, corrected for the projects your own status changes pause; the after count is what stands once every change is accepted. When you stop short of full coverage, the line says how many are left and a finding says why.";

/** When the analyzer offers to become the chief of staff (S8, last bullet). */
export const ORG_ADOPT_RULE = "When the company has no chief of staff and holds two or more roles or three or more projects, counted after the changes in this proposal, add one adopt change for a chief-of-staff role you propose in the same proposal. The conversation it names is the workspace's standing agent when one exists (`cast anchor ls --json`, the row for this workspace): the chief of staff is that agent, and adopting it keeps every Slack and chat binding as an alias and restarts nothing. Only a workspace with no standing agent adopts this session. Offer it once, last, and let the person decide; a company below that size does not need a standing reviewer yet.";

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
  /** Where coverage stands before the proposal (I2): the glance states the
   *  counts the letter's coverage line starts from. Absent from a server that
   *  predates the block. */
  coverage?: { initiatives_active: number; initiatives_without_owner: number; with_work: number; with_lead: number; with_lead_paused?: number; outside_plans: number; outside_areas: number; outside_repositories: number };
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
    .command("log")
    .description("The record of org changes, newest first, with who made each change")
    .option("--role <handle>", "Only changes to this role (@handle, or-N, or id)")
    .option("--since <duration>", "Changes in the last duration, e.g. 7d, 12h, 30m, 2w")
    .option(...TEAM_OPT)
    .option("--json", "Machine-readable output")
    .action(async (options: any) => (await import("./orgHistoryRun.js")).showOrgLog(deps, options));

  org
    .command("undo")
    .description("Undo requires a person to review the change in History on the org page")
    .argument("[batch]", "The change to take back")
    .action(async () => (await import("./orgHistoryRun.js")).refuseOrgUndo(deps));

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
    .option("--edits <json|file>", "For --amend: an object patch over the change's own keys, the shape an edit on the org page takes, e.g. '{\"scope\":{\"add\":[\"pr-12\"]}}'")
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
