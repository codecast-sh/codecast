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
import * as fs from "fs";
import { spawn } from "child_process";
import type { Command } from "commander";
import { fmt } from "./colors.js";
import { ORG_PROPOSAL_FENCE, ORG_PROPOSAL_OPTIONS, orgProposalBlock } from "@codecast/shared/contracts";

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

export function summarizeInputs(inputs: any): OrgInitSummary {
  return {
    projects: inputs?.projects?.length ?? 0,
    plans: inputs?.plans?.length ?? 0,
    tasks_open: Object.entries(inputs?.tasks?.by_status ?? {}).filter(([k]) => k !== "done" && k !== "dropped").reduce((n, [, v]) => n + Number(v), 0),
    members: inputs?.members?.length ?? 0,
    sessions_30d: inputs?.sessions?.total ?? 0,
    roles: inputs?.org?.roles?.length ?? 0,
    git_roots: (inputs?.git_roots ?? []).map((g: any) => g.git_root).filter(Boolean),
  };
}

const EXAMPLE_ROLE = orgProposalBlock({
  kind: "role",
  name: "Head of Growth",
  handle: "growth",
  scope: { projects: ["pr-12"], plans: ["pl-40"] },
  reports_to: "me",
  charter: "One paragraph: what the seat owns, what it reports, what it raises.",
  trust: "understand",
  caps: { hands_per_day: 6, wakes_per_day: 40, tokens_per_day: 400000 },
  evidence: ["14 sessions on ~/src/growth in 30 days", "pl-40 is 3 of 9 done"],
});
const EXAMPLE_PROJECTS = orgProposalBlock({ kind: "projects", changes: [{ op: "create", title: "Platform", description: "Shared infra the other projects lean on", project_path: "/abs/path/if/known" }, { op: "merge", from: "pr-3", into: "pr-12" }] });
const EXAMPLE_MOVE = orgProposalBlock({ kind: "move", handle: "growth", scope_add: ["pr-15"], scope_remove: [], reports_to: "@product", reason: "pr-15 has no owner and its sessions run on growth's repo" });
const EXAMPLE_RETIRE = orgProposalBlock({ kind: "retire", handle: "ops", reason: "no scope event in 21 days, no hands, no wakes" });

export function buildOrgAnalyzerPrompt(opts: { mode: OrgInitMode; workspace: string; teamFlag?: string; apply: boolean; summary: OrgInitSummary }): string {
  const { mode, workspace, summary } = opts;
  const team = opts.teamFlag ? ` --team ${JSON.stringify(opts.teamFlag)}` : "";
  const stackTitle = mode === "init" ? `Adopt the org for ${workspace}` : `Org update for ${workspace}`;
  const roots = summary.git_roots.length ? summary.git_roots.map((r) => `  - ${r}`).join("\n") : "  (no git roots seen on recent sessions)";

  const purpose = mode === "init"
    ? `# Propose an organization for ${workspace}

You are proposing the first org chart for this workspace: the roles that would own its work, what each owns, who each reports to, and why. A role here is a standing agent seat with a scope (projects and plans), a charter, a trust stage and daily caps; people sit above roles. The person who runs this workspace answers your proposal one role at a time; nothing exists until they do.`
    : `# Propose org changes for ${workspace}

You are reviewing the org chart this workspace already has against what its people actually did in the last 30 days, and proposing moves. The person who runs this workspace answers each move; nothing changes until they do.`;

  const goodOrg = `## What a good org for this workspace is

- Few roles, each with a scope a person could describe in one sentence, that together cover the work that is actually happening. A role earns its seat from evidence: sessions, tasks, plans and commits that already exist in its scope.
- Scopes follow the real seams: a repo or package boundary, a project with its own plans, a stream of sessions one person keeps returning to. A role whose scope you cannot point at in the inputs is not a role.
- The reporting line is shallow. Roles report to the person closest to the work, or to one coordinating role when several roles share a repo; never a chain built for symmetry.
- Every role starts at trust "understand" (read and report). Higher stages are a person's later act, not a proposal.
- Caps stay at the defaults unless the evidence says a scope is unusually busy or unusually quiet.
- The right size for a small workspace is often one or two roles. Proposing none is a valid answer when there is nothing to own yet; say so in the doc and post one intake decision instead.`;

  const evidence = `## What counts as evidence

Counts and names from the inputs: sessions per person per path, tasks and plans per project, insight themes and outcomes, labels, channels with activity, open decisions by category, and the repo layout you read yourself. Cite them by short id and title in each role's section. A session title is evidence; a guess about what a title implies is not.`;

  const honesty = `## What not to invent

- ${ORG_INIT_HONESTY_RULES.empty_yields_intake}
- ${ORG_INIT_HONESTY_RULES.unreadable_is_unverified}
- ${ORG_INIT_HONESTY_RULES.no_manufactured_work}
- Do not name people as owners of anything the inputs do not show them working on. Do not propose roles for people who are not members.`;

  const updateSignals = mode === "update" ? `
## Signals to read in update mode

The inputs carry an \`org\` block per role: idle (no event in its scope for 14 days), wakes per day against the wake cap, sibling overlaps, hands, and the projects no role covers. Also read \`tasks.unfiled_open\` and \`sessions.unfiled\`. Propose a move only where the evidence is plain: a project with sessions but no role, a role idle across the whole window, a role at its wake cap on most days, two siblings watching the same project. A quiet role in a quiet workspace is not a problem to fix.` : "";

  const steps = `## Steps

1. Read the inputs: \`cast org inputs${team} --json\`. Read them whole before forming a view.
2. For each git root below, read its top level: \`ls\` the root, and the package names (package.json, pyproject, go.mod, Cargo.toml, or the equivalent) one level down. This is the only reading outside codecast you need; do not walk the tree.
${roots}
3. Write the proposal doc: \`cast doc create "${mode === "init" ? "Org proposal" : "Org update"}: ${workspace}" -t design --content-file -\` with the body on stdin. One section per proposed ${mode === "init" ? "role" : "change"} with: name, handle, scope, reports to, charter paragraph, why (the evidence: counts and session titles), suggested trust stage (understand), caps. ${mode === "init" ? "A section for project changes when the inputs show work that has no project, or two projects that are one thing." : "A section for each move, retirement, or new role, and one for project changes when needed."} End with what you could not verify.
4. Create the stack: \`cast stack create "${stackTitle}"\` and note the ds-N it prints.
5. Post one decision per ${mode === "init" ? "proposed role" : "proposed change"} with \`cast decide\`, in an order where a role's parent comes before the role: \`cast decide "<question>" --kind single --stack ds-N --no-task -o "<option 1> :: <what happens>" -o "<option 2> :: <what happens>" -o "Skip :: nothing is created" --context - <<'EOF'\` and the context on stdin. The context is the doc section's reasoning in a few lines, then the block described below. Post one more decision for the project changes when you proposed any.
6. ${opts.apply
    ? "End your turn. The answers arrive here as messages. When every decision of the stack is answered, run `cast org apply ds-N` and report what it created."
    : "End your turn with `cast state --status done` naming the doc and the stack. The person runs `cast org apply ds-N` after answering."}`;

  const options = mode === "init"
    ? `The three options, in this order, for a role: ${ORG_PROPOSAL_OPTIONS.role.map((o) => `"${o}"`).join(", ")}. For project changes: ${ORG_PROPOSAL_OPTIONS.projects.map((o) => `"${o}"`).join(", ")}.`
    : `The three options, in this order: for a new role ${ORG_PROPOSAL_OPTIONS.role.map((o) => `"${o}"`).join(", ")}; for a move ${ORG_PROPOSAL_OPTIONS.move.map((o) => `"${o}"`).join(", ")}; for a retirement ${ORG_PROPOSAL_OPTIONS.retire.map((o) => `"${o}"`).join(", ")}; for project changes ${ORG_PROPOSAL_OPTIONS.projects.map((o) => `"${o}"`).join(", ")}.`;

  const block = `## The block \`cast org apply\` reads

Each decision's context ends with one fenced block tagged \`${ORG_PROPOSAL_FENCE}\`. \`cast org apply\` reads it back and acts on the answer, so the option order is fixed. ${options} The second option carries the person's text as changes: JSON with the same keys overrides fields, prose is folded into the charter.

Project refs are a project's short id (pr-N), id, or a title that matches one project; plan refs are pl-N. \`reports_to\` is "@handle" for a role, "me" or a member's name for a person.

A role:

${EXAMPLE_ROLE}

Project changes:

${EXAMPLE_PROJECTS}${mode === "update" ? `

A move (any of reports_to, scope_add, scope_remove):

${EXAMPLE_MOVE}

A retirement:

${EXAMPLE_RETIRE}` : ""}`;

  const counts = `## The workspace at a glance

${summary.projects} projects, ${summary.plans} plans, ${summary.tasks_open} open tasks, ${summary.members} members, ${summary.sessions_30d} sessions in 30 days, ${summary.roles} existing roles.`;

  return [purpose, counts, goodOrg, evidence, honesty, updateSignals, steps, block].filter(Boolean).join("\n\n") + "\n";
}

// The `cast` this process is: a script under bun (execPath + the script), or
// the compiled binary (execPath alone takes subcommands).
function selfCommand(): string[] {
  const script = process.argv[1];
  return script && /\.(ts|js)$/.test(script) && fs.existsSync(script) ? [process.execPath, script] : [process.execPath];
}

function spawnAnalyzer(prompt: string, label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const [bin, ...pre] = selfCommand();
    const child = spawn(bin, [...pre, "spawn", "--label", label, "-"], { stdio: ["pipe", "inherit", "inherit"], env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function fail(message: string): never {
  console.error(fmt.error(message));
  process.exit(1);
}

export const ORG_INIT_LABEL = "org-init";

export function registerOrgInitCommands(program: Command, deps: OrgInitDeps): void {
  const org = program.commands.find((c) => c.name() === "org");
  if (!org) throw new Error("cast org group is not registered; register it before the init commands");

  org
    .command("inputs")
    .description("The evidence the org analyzer reads: projects, plans, members, sessions, git roots, insights, channels, roles, open decisions (30 days, capped)")
    .option("--team <name|id>", "Team workspace (default: the active workspace)")
    .option("--json", "Machine-readable output (the whole payload)")
    .action(async (options: any) => {
      const ws = await deps.readWorkspace(options.team);
      const inputs = await deps.cliPost("/cli/org/analysis-inputs", deps.workspaceArgs(ws));
      if (!inputs) fail(`You are not a member of ${deps.workspaceLabel(ws)}.`);
      if (options.json) { console.log(JSON.stringify(inputs, null, 2)); return; }
      const s = summarizeInputs(inputs);
      console.log(`${fmt.highlight(inputs.workspace.name || deps.workspaceLabel(ws))} ${fmt.muted(`· ${inputs.window_days} days`)}`);
      console.log(`  ${s.projects} projects · ${s.plans} plans · ${s.tasks_open} open tasks (${inputs.tasks.unfiled_open} unfiled) · ${s.members} members · ${s.sessions_30d} sessions${inputs.sessions.truncated ? " (truncated)" : ""} · ${s.roles} roles`);
      for (const p of inputs.projects) console.log(`  ${fmt.muted("project")} ${p.short_id ?? ""} ${p.title} ${fmt.muted(`· ${p.tasks.open} open of ${p.tasks.total} tasks · ${p.plans} plans`)}`);
      for (const g of inputs.git_roots) console.log(`  ${fmt.muted("repo")} ${g.repo ?? g.git_root} ${fmt.muted(`· ${g.sessions} sessions`)}`);
      for (const r of inputs.org.roles) console.log(`  ${fmt.muted("role")} @${r.handle} ${r.name} ${fmt.muted(`· ${r.idle ? "idle" : `${r.idle_days}d since a scope event`} · ${r.wakes_7d.total} wakes/7d${r.wakes_7d.days_at_cap ? ` (${r.wakes_7d.days_at_cap} days at cap)` : ""}${r.overlaps.length ? ` · overlaps ${r.overlaps.map((o: any) => `@${o.handle}`).join(", ")}` : ""}`)}`);
      if (inputs.org.projects_without_role.length) console.log(`  ${fmt.muted("no role:")} ${inputs.org.projects_without_role.map((p: any) => p.title).join(", ")}`);
      console.log(fmt.muted("  --json for the full payload"));
    });

  const runAnalyzer = (mode: OrgInitMode) => async (options: any) => {
    const ws = await deps.readWorkspace(options.team);
    const inputs = await deps.cliPost("/cli/org/analysis-inputs", deps.workspaceArgs(ws));
    if (!inputs) fail(`You are not a member of ${deps.workspaceLabel(ws)}.`);
    const prompt = buildOrgAnalyzerPrompt({
      mode,
      workspace: inputs.workspace.name || deps.workspaceLabel(ws),
      teamFlag: options.team,
      apply: !!options.apply,
      summary: summarizeInputs(inputs),
    });
    if (options.here) { process.stdout.write(prompt); return; }
    const code = await spawnAnalyzer(prompt, ORG_INIT_LABEL);
    if (code !== 0) process.exit(code);
  };

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
    .action(async (stackRef: string, options: any) => {
      if (!/^ds-\d+$/.test(stackRef)) fail(`Usage: cast org apply ds-N (got ${stackRef})`);
      const shown = await deps.cliPost("/cli/stack/show", { stack: stackRef });
      if (shown?.error) fail(shown.error);
      const decisions: any[] = shown.decisions ?? [];
      const results: any[] = [];
      for (const d of decisions) {
        const ref = d.short_id ?? d._id;
        const r = await deps.cliPost("/cli/org/apply-decision", { decision: ref, provision: options.provision !== false });
        results.push({ ...r, question: d.question });
        if (options.json) continue;
        const tag = r.status === "applied" ? fmt.success("applied") : r.status === "error" ? fmt.error("error") : fmt.muted(r.status);
        console.log(`  ${tag} ${fmt.muted(ref)} ${d.question}`);
        if (r.note) console.log(`      ${fmt.muted(r.note)}`);
        if (r.error) console.log(`      ${fmt.error(r.error)}`);
      }
      if (options.json) { console.log(JSON.stringify({ stack: shown.stack, results }, null, 2)); return; }
      const applied = results.filter((r) => r.status === "applied").length;
      const pending = results.filter((r) => r.status === "unanswered").length;
      const errors = results.filter((r) => r.status === "error").length;
      console.log(`${fmt.success(`${applied} applied`)}${pending ? `, ${pending} unanswered` : ""}${errors ? `, ${fmt.error(`${errors} failed`)}` : ""} of ${results.length} in ${shown.stack?.short_id ?? stackRef}${pending ? fmt.muted(" — rerun after the rest are answered") : ""}`);
    });
}
