// `cast org init`, `cast org update`, `cast org inputs`, `cast org apply`
// (docs/architecture/org-init.md O1, O2). The analyzer is an agent session
// briefed by the prompt below: it reads the workspace's evidence, writes a
// proposal doc, and asks for the org as a decision stack. Nothing is created
// until a person answers; `cast org apply` turns the answers into roles.
//
// The prompt is principle level: what a good org for this workspace is, what
// evidence counts, and what must never be invented. The one prescriptive part
// is the machine-readable block each decision carries, because `apply` has to
// read it back.
import type { Command } from "commander";

export type OrgInitMode = "init" | "update";

export interface OrgInitDeps {
  cliPost: (urlPath: string, body: Record<string, any>) => Promise<any>;
  readWorkspace: (explicitTeam?: string) => Promise<{ kind: "team" | "personal"; [k: string]: any }>;
  workspaceArgs: (ws: any) => { team_id?: string };
  workspaceLabel: (ws: any) => string;
}

// The three honesty rules every analyzer run carries. Named so the test can
// assert the prompt keeps them, whatever else the wording becomes.
export const ORG_INIT_HONESTY_RULES = {
  empty_yields_intake: "An empty or thin workspace yields an intake draft: one role that gathers what the people want to build, with a charter that says so. Never invent projects, plans or work to give a role something to own.",
  unreadable_is_unverified: "Anything you could not read (a private session, a repo you cannot open, a count at its cap) is reported as \"could not verify\", never as absent and never as estimated.",
  no_manufactured_work: "Never create tasks, plans, projects or sessions to support a proposal. The proposal cites what exists; the stack is the only thing you create besides the doc.",
} as const;

export type OrgInitSummary = {
  projects: number;
  plans: number;
  tasks_open: number;
  members: number;
  sessions_30d: number;
  roles: number;
  git_roots: string[];
};

export const ORG_INIT_LABEL = "org-init";

export function registerOrgInitCommands(program: Command, deps: OrgInitDeps): void {
  const org = program.commands.find((c) => c.name() === "org");
  if (!org) throw new Error("cast org group is not registered; register it before the init commands");

  org
    .command("inputs")
    .description("The evidence the org analyzer reads: projects, plans, members, sessions, git roots, insights, channels, roles, open decisions (30 days, capped)")
    .option("--team <name|id>", "Team workspace (default: the active workspace)")
    .option("--json", "Machine-readable output (the whole payload)")
    .action(async (options: any) => (await import("./orgInitRun.js")).showInputs(deps, options));

  const runAnalyzer = (mode: OrgInitMode) => async (options: any) => (await import("./orgInitRun.js")).runAnalyzer(deps, mode, options);

  org
    .command("init")
    .description("Propose an org for the workspace: spawns an analyzer session that writes a proposal doc and a decision stack")
    .option("--here", "Print the analyzer prompt for the current agent to act on instead of spawning a session")
    .option("--apply", "Tell the analyzer to run cast org apply itself once every decision is answered")
    .option("--team <name|id>", "Team workspace (default: the active workspace)")
    .action(runAnalyzer("init"));

  org
    .command("update")
    .description("Propose org changes from what drifted: unfiled work, idle roles, roles at their wake cap, sibling overlaps, projects with no role")
    .option("--here", "Print the analyzer prompt for the current agent to act on instead of spawning a session")
    .option("--apply", "Tell the analyzer to run cast org apply itself once every decision is answered")
    .option("--team <name|id>", "Team workspace (default: the active workspace)")
    .action(runAnalyzer("update"));

  org
    .command("apply")
    .description("Act on an answered org stack: create the accepted roles, scopes, charters and standing sessions; apply moves and retirements. Safe to rerun.")
    .argument("<stack>", "The stack (ds-N) cast org init posted")
    .option("--no-provision", "Create roles without provisioning their standing sessions")
    .option("--json", "Machine-readable output")
    .action(async (stackRef: string, options: any) => (await import("./orgInitRun.js")).applyStack(deps, stackRef, options));
}
