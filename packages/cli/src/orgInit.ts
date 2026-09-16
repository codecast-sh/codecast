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

/** When the analyzer offers to become the chief of staff (S8, last bullet). */
export const ORG_ADOPT_RULE ="When the company has no chief of staff and holds two or more roles or three or more projects, add one adopt change: this session becomes the standing session of a chief-of-staff role you propose in the same proposal. Offer it once, last, and let the person decide; a company below that size does not need a standing reviewer yet.";

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

const TEAM_OPT = ["--team <name|id>", "Team workspace (default: the active workspace)"] as const;

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
    .option(...TEAM_OPT)
    .option("--json", "Machine-readable output")
    .action(async (options: any) => (await run()).propose(deps, options));

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
    .option("--no-provision", "Stacks only: create roles without provisioning their standing sessions")
    .option("--json", "Machine-readable output")
    .action(async (ref: string, options: any) => (await run()).apply(deps, ref, options));

  org
    .command("staff")
    .description("Hire the Chief of Staff: the role, its standing session, a weekly company review, and the first review now. Idempotent per company.")
    .option("--adopt", "This session becomes the chief of staff's standing session instead of provisioning a new one")
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
