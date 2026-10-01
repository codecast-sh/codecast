// `cast org init`, `update`, `review`, `inputs`, `propose`, `proposals`,
// `apply`, `staff`, `health` (docs/architecture/org-init.md O1, O2;
// org-staffing.md S3, S4, S6, S8, S24). The analyzer is an agent session
// briefed by the Head of People prompt (shared/contracts/headOfPeoplePrompt.ts): it reads how work flows through
// the company, then talks it through with the person and posts small
// proposals (op-N) whose changes a person accepts, edits or skips one by one.
// Nothing is applied by the analyzer.
//
// This module is on the CLI boot graph (bench/bootGraph.guard.test.ts), so it
// registers the verbs only; every body and the prompt load inside each action
// from orgInitRun.ts.
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
  /** HTTP for blobs outside the API (a release snapshot's upload and download); global fetch when absent. */
  fetchUrl?: typeof fetch;
}

export type OrgInitSummary = {
  projects: number;
  plans: number;
  tasks_open: number;
  members: number;
  sessions_30d: number;
  roles: number;
  git_roots: string[];
  /** Whether a head-of-people role already exists. */
  head_of_people: boolean;
  /** The person the Head of People reports to, when one is seated: the prompt's {person}. */
  person?: string;
  /** Records the activity block (S9) says are behind what happened. */
  stale: { plans: number; tasks: number; projects: number };
  /** Where coverage stands (I2). Absent from a server that predates the block. */
  coverage?: { initiatives_active: number; initiatives_without_owner: number; with_work: number; with_lead: number; with_lead_paused?: number; outside_plans: number; outside_areas: number; outside_repositories: number };
};

export const ORG_INIT_LABEL = "org-init";
export const HEAD_OF_PEOPLE_HANDLE = "head-of-people";

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
    .description("Review the company and propose the structure that matches how the work runs (the same run as cast org review, spawned)")
    .option("--here", "Print the review prompt for the current agent to act on instead of spawning a session")
    .option(...TEAM_OPT)
    .action(async (options: any) => (await run()).runAnalyzer(deps, "review", { ...options, spawn: !options.here }));

  org
    .command("review")
    .description("The company review: prints the review prompt for the current agent (the head of people's routine runs this); --spawn runs it in a fresh session")
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
    .description("Hire the Head of People: the role, its standing session, a weekly company review, and the first review now. Idempotent per company.")
    .option("--adopt", "This session becomes the head of people's standing session instead of provisioning a new one")
    .option("--seat <existing|fresh>", "With a standing agent already in the workspace: seat it (default, nothing restarts) or start a fresh session and retire it in the same act")
    .option("-C, --dir <path>", "Project directory the provisioned standing session starts in (default: current; ignored with --adopt)")
    .option("--every <duration>", "How often the company review runs", "7d")
    .option("--model <id>", "Model for a freshly provisioned standing session (for example claude-opus-5-5)")
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
