// The bodies of the `cast org` staffing verbs and the analyzer prompt they
// build (docs/architecture/org-staffing.md S8; org-init.md O1, O2). orgInit.ts
// registers the verbs and loads this module inside each action, so the
// prompt, the capacity model and the proposal contract stay off the CLI boot
// graph (bench/bootGraph.guard.test.ts).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, spawnSync } from "./proc.js";
import { fmt } from "./colors.js";
import { renderCapacityModel } from "@codecast/shared/contracts/orgCapacity";
import {
  ORG_CHANGE_KINDS, describeOrgChange, extractOrgProposal, orgChangeError, orderOrgChanges, parseOrgProposalSpec,
  type OrgChange, type OrgProposalMode,
} from "@codecast/shared/contracts/orgProposal";
import { formatRelative } from "@codecast/shared/time";
import { CHIEF_OF_STAFF_HANDLE, ORG_ADOPT_RULE, ORG_INIT_HONESTY_RULES, ORG_INIT_LABEL, type OrgInitDeps, type OrgInitMode, type OrgInitSummary } from "./orgInit.js";

// ── The prompt (S8) ──────────────────────────────────────────────────────────
//
// Principle level: the company model, what to read, the capacity model and
// how to reason with it, how to design or review, how to write, what never
// to invent, and the one offer. The one prescriptive part is the spec shape,
// because `cast org propose` has to parse it.

/** The company model (S1), the words every surface and every prompt uses. */
export const COMPANY_MODEL = `A company is a workspace. Its executives are people: they own the budget, answer decisions and hire roles. A manager is a role: a standing agent with a scope, a charter, a brief and a daily budget of hands, wakes and tokens. A contributor is a hand: a session doing one piece of work, transient, reporting to a role or a person. A business line is a project, a lasting area of work with a charter; a program is a plan, a bounded effort under a project with a goal and success criteria. Staffing is which roles exist, what each owns, who each reports to and what each may spend. A proposal moves scope, people and budget together: staffing is budgeting.`;

/** The change kinds a proposal may carry and what each field means. */
function changeKindsReference(): string {
  return [
    `- role: { name, handle, scope?: { projects?: [ref], plans?: [ref] }, reports_to?: "@handle" | "me" | a member's name, charter?, trust?: "understand", caps?: { hands_per_day, wakes_per_day, tokens_per_day }, evidence?: [string] }. A new seat. Scope refs are a project's short id (pr-N), id or a title that matches one project; a plan's pl-N.`,
    `- projects: { changes: [{ op: "create", title, description?, project_path? } | { op: "merge", from, into }] }. Business lines the chart needs and does not have, or two that are one thing.`,
    `- move: { handle, reports_to?, scope_add?: [ref], scope_remove?: [ref], reason? }. A role under a different parent, or with a different scope, in one change.`,
    `- scope: { handle, add?: [ref], remove?: [ref] }. Only the scope.`,
    `- budget: { handle, caps: { hands_per_day?, wakes_per_day?, tokens_per_day? } }. Only the budget; say what it comes from.`,
    `- trust: { handle, trust: "understand" | "decide" | "direct" }. Propose it only with evidence the role has earned it; a person unlocks it.`,
    `- routine: { handle, title, prompt, every: "7d" | "1d" | ... }. Work the role should do on a cadence.`,
    `- project_meta: { project: ref, goal?, success_metrics?: [string], priority?: "p0".."p3", owner?: "@handle", non_goals?: [string], risks?: [string] }. A charter for a business line; only fields you can ground in the project's own tasks and docs.`,
    `- retire: { handle, reason? }. Last in the order; say where its work goes.`,
    `- adopt: { handle, conversation }. This session becomes the named role's standing session.`,
  ].join("\n");
}

const SPEC_EXAMPLE = JSON.stringify({
  title: "Staffing for <company>",
  summary_md: "Two paragraphs a founder reads on a phone: what you found, what you propose, what you expect to change.",
  mode: "init",
  changes: [
    {
      change: { kind: "role", name: "Head of Growth", handle: "growth", scope: { projects: ["pr-12"] }, reports_to: "me", charter: "One paragraph: what the seat owns, what it reports, what it raises." },
      rationale: "Why this change, in the reader's words.",
      evidence: [{ label: "14 sessions on ~/src/growth in 30 days", href: "https://codecast.sh/org?scope=pr-12" }],
      expected_effect: "What should be different at the next review, and how you will know.",
      risk: "What could go wrong, and what you would watch.",
    },
  ],
}, null, 2);

export function orgProposalTitle(mode: OrgInitMode, workspace: string): string {
  return mode === "init" ? `Staffing for ${workspace}` : `Company review: ${workspace}`;
}

export type PromptFacts = {
  mode: OrgInitMode;
  workspace: string;
  teamFlag?: string;
  summary: OrgInitSummary;
  /** The session the analyzer runs in, when known: the adopt change names it. */
  session?: string;
};

export function buildOrgAnalyzerPrompt(opts: PromptFacts): string {
  const { mode, workspace, summary } = opts;
  const team = opts.teamFlag ? ` --team ${JSON.stringify(opts.teamFlag)}` : "";
  const roots = summary.git_roots.length ? summary.git_roots.map((r) => `  - ${r}`).join("\n") : "  (no git roots seen on recent sessions)";

  const purpose = mode === "init"
    ? `# Propose the organization for ${workspace}

You are designing the first staffing of this company: which roles own its work, what each owns, who each reports to, and what each may spend. The executives decide; you propose. Every change you post is a ghost on the org page until a person accepts, edits or skips it, and nothing is applied by you.`
    : `# Review the company: ${workspace}

You are reviewing how work flows through this company against the capacity model, and proposing the smallest changes that remove a bottleneck. The executives decide; you propose. Every change you post is a ghost on the org page until a person accepts, edits or skips it, and nothing is applied by you.`;

  const model = `## The company model

${COMPANY_MODEL}`;

  const glance = `## The company at a glance

${summary.projects} projects, ${summary.plans} plans, ${summary.tasks_open} open tasks, ${summary.members} members, ${summary.sessions_30d} sessions in 30 days, ${summary.roles} existing roles${summary.chief_of_staff ? ", a chief of staff" : ", no chief of staff"}.`;

  const read = `## What to read, before you form a view

1. \`cast org inputs${team} --json\`: projects with task counts, plans with progress, members with their sessions by path, git roots, insight themes, channels, existing roles and anchors, open decisions. Read it whole.
2. \`cast org health${team} --json\`: per role, per person and for the company, the load, spend and flow signals the capacity model needs, and the flags it raises. Every flag names its evidence.
3. Each git root's layout: \`ls\` the root and the package names one level down. This is the only reading outside codecast; do not walk the tree.
${roots}
4. The project charters (\`cast project show <ref>\`: goal, metrics, priority, owner, non goals, risks) and the roles' briefs (\`cast brief @handle\`), where they exist. A charter that is missing is itself a finding.`;

  const capacity = `## The capacity model

${renderCapacityModel()}

How to size with it. A scope is right when one agent can hold all of it in its head between wakes: the open tasks it must watch, the plans it directs, the hands it reads, the reports whose brief lines it reads. Count these from the inputs before you draw a seat. A role needs a report when its own scope holds a seam (a repo, a package, a project with its own plans) that would fit one agent and is past the thresholds when held together. A person needs a layer when the roles reporting straight to them pass the span. A role should be split when it has breached the model in consecutive reviews, along a seam its own work shows; it should be merged with a sibling when both are idle or both watch the same scope and talk to each other more than they ship. A project needs an owner when it has sessions, tasks or plans and no role's scope covers it. Budget is allocated from the person's total: a role's caps are what its evidence shows it needs, and the sum across their roles is what the person agreed to spend.`;

  const design = mode === "init" ? `## How to design from scratch

Start from the business lines and their goals, not from the people or the tools. For each line, ask what would have to be true in a month for it to be going well; that is the charter you propose when the project has none. Name one owner per line, then check the span of the person the owners report to. Allocate budget from that person's total. Size every role against the model with the counts you read. Explain every role with evidence a person can click: counts, session titles, commits, short ids. Where a line has no evidence of work, propose an intake draft instead of a role that owns nothing. Few roles with plain scopes beat a complete chart; proposing one role, or none, is a valid answer for a small company, and the summary should say why.` : `## How to review

Read the flags first, then the evidence behind each: the chatter graph (who sends to whom, against what they ship), decision latency, review stalls, unowned projects, unfiled tasks, idle roles, roles at their caps. For each bottleneck, propose the smallest change that removes it, and say what you expect to change by the next review and how you will know. Respect the stability rules: a role moved inside the cooldown is left alone, a split waits for the second breach, a retirement waits for the idle window. A quiet role in a quiet company is not a problem to fix; a chart that changes every week never settles. When nothing needs to change, post a proposal with no changes only if the summary carries a finding worth reading; otherwise say so in your state and end.`;

  const write = `## How to write

The output is one proposal, posted with \`cast org propose${team} --spec proposal.json\` (or \`--spec -\` with the JSON on stdin). It prints op-N and the page link. The spec:

\`\`\`json
${SPEC_EXAMPLE}
\`\`\`

Every change carries its own rationale, evidence a person can click (a label, and a link where one exists: a session, a task, a plan, a project, a commit), the effect you expect and the risk you see. Order the changes so a project comes before the role that owns it and a parent before its child; a retirement goes last. The summary is what a founder reads on a phone before opening anything: what you found, what you propose, what you expect to change, in plain words with the numbers that matter and nothing else.

The change kinds:

${changeKindsReference()}`;

  const honesty = `## What not to invent, and what to escalate

- ${ORG_INIT_HONESTY_RULES.empty_yields_intake}
- ${ORG_INIT_HONESTY_RULES.unreadable_is_unverified}
- ${ORG_INIT_HONESTY_RULES.no_manufactured_work}
- Do not name people as owners of anything the inputs do not show them working on, and do not propose roles for people who are not members.
- Never invent a metric a project's own tasks and docs cannot ground; a charter with a goal and no metrics is honest.
- Escalate, in the summary and as a decision to the person you report to, anything that changes what they spend or who does what: a budget past the defaults, a trust stage above understand, a retirement, a move of a person's direct report.`;

  const adopt = `## The offer

${ORG_ADOPT_RULE}${opts.session ? ` This session is \`${opts.session}\`; that is the adopt change's conversation.` : " This run is not inside a session it can name, so skip the offer and say so."} A chief of staff never rises above trust understand: it proposes and never applies.`;

  const end = `## When you are done

End your turn with \`cast state --status done\` naming op-N and the page link. The person decides on the org page, or at a shell with \`cast org apply op-N\`. Do not run apply yourself: a session may not apply staffing.`;

  return [purpose, model, glance, read, capacity, design, write, honesty, adopt, end].join("\n\n") + "\n";
}

// ── Guards and helpers ───────────────────────────────────────────────────────

/** An open analyzer proposal for the workspace, from the rows
 *  /cli/org/proposals returns (already scoped to the boundary). Init and
 *  review block each other: two analyzers proposing the same chart would post
 *  duplicate ghosts, and accepting both is safe only by accident of the
 *  handle clash. A person's own request does not block. */
export function findOpenOrgProposal(
  proposals: Array<{ short_id: string; title: string; mode?: OrgProposalMode; status?: string; decided?: number; total?: number; changes?: any[] }> | null | undefined,
): { short_id: string; title: string; decided: number; total: number } | null {
  const hit = (proposals ?? []).find((p) => (p.status ?? "open") === "open" && (p.mode === "init" || p.mode === "review"));
  if (!hit) return null;
  const total = hit.total ?? hit.changes?.length ?? 0;
  const decided = hit.decided ?? (hit.changes ?? []).filter((c: any) => c.status && c.status !== "proposed").length;
  return { short_id: hit.short_id, title: hit.title, decided, total };
}

/** Stacks (ds-N) keep the older apply order; one sort for both. */
export function orderForApply<T extends { context_md?: string | null }>(decisions: T[]): T[] {
  return orderOrgChanges(decisions, (d) => extractOrgProposal(d.context_md));
}

export function summarizeInputs(inputs: any): OrgInitSummary {
  const roles: any[] = inputs?.org?.roles ?? [];
  return {
    projects: inputs?.projects?.length ?? 0,
    plans: inputs?.plans?.length ?? 0,
    tasks_open: Object.entries(inputs?.tasks?.by_status ?? {}).filter(([k]) => k !== "done" && k !== "dropped").reduce((n, [, v]) => n + Number(v), 0),
    members: inputs?.members?.length ?? 0,
    sessions_30d: inputs?.sessions?.total ?? 0,
    roles: roles.length,
    git_roots: (inputs?.git_roots ?? []).map((g: any) => g.git_root).filter(Boolean),
    chief_of_staff: roles.some((r) => r?.handle === CHIEF_OF_STAFF_HANDLE),
  };
}

export function proposalUrl(deps: OrgInitDeps, shortId: string): string {
  return `${deps.webUrl().replace(/\/$/, "")}/org?proposal=${shortId}`;
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

async function membership(deps: OrgInitDeps, options: any): Promise<{ ws: any; args: { team_id?: string } }> {
  const ws = await deps.readWorkspace(options.team);
  return { ws, args: deps.workspaceArgs(ws) };
}

// ── inputs ───────────────────────────────────────────────────────────────────

export async function showInputs(deps: OrgInitDeps, options: any): Promise<void> {
  const { ws, args } = await membership(deps, options);
  const inputs = await deps.cliPost("/cli/org/analysis-inputs", args);
  if (!inputs) fail(`You are not a member of ${deps.workspaceLabel(ws)}.`);
  if (options.json) { console.log(JSON.stringify(inputs, null, 2)); return; }
  const s = summarizeInputs(inputs);
  console.log(`${fmt.highlight(inputs.workspace.name || deps.workspaceLabel(ws))} ${fmt.muted(`· ${inputs.window_days} days`)}`);
  console.log(`  ${s.projects} projects · ${s.plans} plans · ${s.tasks_open} open tasks (${inputs.tasks.unfiled_open} unfiled) · ${s.members} members · ${s.sessions_30d} sessions${inputs.sessions.truncated ? " (truncated)" : ""} · ${s.roles} roles`);
  for (const p of inputs.projects) console.log(`  ${fmt.muted("project")} ${p.short_id ?? ""} ${p.title} ${fmt.muted(`· ${p.tasks.open} open of ${p.tasks.total} tasks · ${p.plans} plans`)}`);
  // Roots group by repo for the eye; the prompt still lists every path,
  // because a worktree is what the analyzer has to read.
  const byRepo = new Map<string, { sessions: number; roots: number }>();
  for (const g of inputs.git_roots) { const k = g.repo ?? g.git_root; const cur = byRepo.get(k) ?? { sessions: 0, roots: 0 }; cur.sessions += g.sessions; cur.roots++; byRepo.set(k, cur); }
  for (const [repo, v] of byRepo) console.log(`  ${fmt.muted("repo")} ${repo} ${fmt.muted(`· ${v.sessions} sessions${v.roots > 1 ? ` across ${v.roots} checkouts` : ""}`)}`);
  for (const r of inputs.org.roles) console.log(`  ${fmt.muted("role")} @${r.handle} ${r.name} ${fmt.muted(`· ${r.idle ? "idle" : `${r.idle_days}d since a scope event`} · ${r.wakes_7d.total} wakes/7d${r.wakes_7d.days_at_cap ? ` (${r.wakes_7d.days_at_cap} days at cap)` : ""}${r.overlaps.length ? ` · overlaps ${r.overlaps.map((o: any) => `@${o.handle}`).join(", ")}` : ""}`)}`);
  if (inputs.org.projects_without_role.length) console.log(`  ${fmt.muted("no role:")} ${inputs.org.projects_without_role.map((p: any) => p.title).join(", ")}`);
  console.log(fmt.muted("  --json for the full payload"));
}

// ── init / update / review ───────────────────────────────────────────────────

export async function runAnalyzer(deps: OrgInitDeps, mode: OrgInitMode, options: { team?: string; spawn?: boolean }): Promise<void> {
  const { ws, args } = await membership(deps, options);
  const inputs = await deps.cliPost("/cli/org/analysis-inputs", args);
  if (!inputs) fail(`You are not a member of ${deps.workspaceLabel(ws)}.`);
  const workspace = inputs.workspace.name || deps.workspaceLabel(ws);
  // One proposal at a time per company. An analyzer parked on a usage limit
  // after posting looks dead from the queue; it is not, and a second run
  // would post a second set of ghosts. Printing the prompt is guarded the
  // same way, because the agent that reads it posts too.
  const listed = await deps.cliPost("/cli/org/proposals", { ...args, status: "open" });
  const open = findOpenOrgProposal(listed?.proposals);
  if (open) {
    fail(
      `${open.short_id} "${open.title}" is still open (${open.decided} of ${open.total} decided), so a second proposal is not started.\n` +
      `Decide it on the org page (${proposalUrl(deps, open.short_id)}) or with \`cast org apply ${open.short_id}\`, or withdraw it with \`cast org proposals --withdraw ${open.short_id}\`, before running this again.`,
    );
  }
  const prompt = buildOrgAnalyzerPrompt({ mode, workspace, teamFlag: options.team, summary: summarizeInputs(inputs), session: deps.callingSession() });
  if (!options.spawn) { process.stdout.write(prompt); return; }
  const code = await spawnAnalyzer(prompt, ORG_INIT_LABEL);
  if (code !== 0) process.exit(code);
}

// ── propose / proposals ──────────────────────────────────────────────────────

function readSpecText(spec: string): string {
  if (spec === "-") return fs.readFileSync(0, "utf8");
  if (!fs.existsSync(spec)) fail(`No such file: ${spec}`);
  return fs.readFileSync(spec, "utf8");
}

export async function propose(deps: OrgInitDeps, options: any): Promise<void> {
  const text = readSpecText(options.spec);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e: any) { fail(`The spec is not JSON: ${e?.message ?? e}`); }
  const parsed = parseOrgProposalSpec(raw);
  if (!parsed.spec) fail(`The spec has ${parsed.errors.length} fault${parsed.errors.length === 1 ? "" : "s"}:\n${parsed.errors.map((e) => `  - ${e}`).join("\n")}\nChange kinds: ${ORG_CHANGE_KINDS.join(", ")}.`);
  const { ws, args } = await membership(deps, options);
  const result = await deps.cliPost("/cli/org/propose", { ...args, ...parsed.spec, from_session: deps.callingSession() });
  if (!result || result.error) fail(result?.error ?? `You are not a member of ${deps.workspaceLabel(ws)}.`);
  if (options.json) { console.log(JSON.stringify({ ...result, url: proposalUrl(deps, result.short_id) }, null, 2)); return; }
  const n = result.changes?.length ?? parsed.spec.changes.length;
  console.log(`${fmt.success("✓")} ${fmt.highlight(result.short_id)} ${parsed.spec.title} ${fmt.muted(`· ${n} change${n === 1 ? "" : "s"} · ${parsed.spec.mode}`)}`);
  console.log(`  ${fmt.accent(proposalUrl(deps, result.short_id))}`);
  console.log(`  ${fmt.muted("at a shell:")} ${fmt.cmd(`cast org apply ${result.short_id}`)}`);
}

function decidedCount(p: any): { decided: number; total: number } {
  const changes: any[] = p.changes ?? [];
  return { decided: p.decided ?? changes.filter((c) => c.status && c.status !== "proposed").length, total: p.total ?? changes.length };
}

export async function listProposals(deps: OrgInitDeps, options: any): Promise<void> {
  const { ws, args } = await membership(deps, options);
  if (options.withdraw) {
    if (!/^op-\d+$/.test(options.withdraw)) fail(`--withdraw wants a proposal id like op-12 (got ${options.withdraw})`);
    const r = await deps.cliPost("/cli/org/proposal/withdraw", { proposal: options.withdraw, from_session: deps.callingSession() });
    if (r?.error) fail(r.error);
    if (options.json) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`${fmt.success("✓")} withdrew ${options.withdraw}`);
    return;
  }
  const listed = await deps.cliPost("/cli/org/proposals", options.all ? args : { ...args, status: "open" });
  if (!listed) fail(`You are not a member of ${deps.workspaceLabel(ws)}.`);
  if (options.json) { console.log(JSON.stringify(listed, null, 2)); return; }
  const rows: any[] = listed.proposals ?? [];
  if (!rows.length) { console.log(fmt.muted(options.all ? "No proposals." : "No open proposals. cast org review proposes one; --all lists resolved ones.")); return; }
  const now = Date.now();
  for (const p of rows) {
    const { decided, total } = decidedCount(p);
    const author = p.author?.kind === "user" ? "a person" : p.author?.kind === "role" ? "a role" : "a session";
    console.log(`  ${fmt.highlight(p.short_id)} ${p.title} ${fmt.muted(`· ${p.status ?? "open"} · ${p.mode ?? ""} · ${decided}/${total} decided · ${author} · ${formatRelative(p.created_at ?? now, now)}`)}`);
  }
}

// ── apply ────────────────────────────────────────────────────────────────────

/** The two prompts the walk needs; tests inject fakes, the shell gets readline
 *  and $EDITOR. */
export type ApplyIo = {
  ask: (question: string) => Promise<string>;
  /** Hand the text to the person, return what they saved. */
  edit: (text: string) => Promise<string>;
};

function shellIo(): ApplyIo {
  if (!process.stdin.isTTY) fail("cast org apply walks the changes at a terminal. Without one, pass --all to accept every remaining change in order, or decide on the org page.");
  return {
    ask: async (question) => {
      const rl = await import("readline");
      const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
      try { return await new Promise<string>((resolve) => iface.question(question, resolve)); } finally { iface.close(); }
    },
    edit: async (text) => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-org-")), "change.json");
      fs.writeFileSync(file, text + "\n");
      const editor = process.env.VISUAL || process.env.EDITOR || "vi";
      const r = spawnSync(editor, [file], { stdio: "inherit", shell: true });
      if (r.status !== 0) throw new Error(`${editor} exited ${r.status}`);
      return fs.readFileSync(file, "utf8");
    },
  };
}

export async function apply(deps: OrgInitDeps, ref: string, options: any, io?: ApplyIo): Promise<void> {
  if (/^ds-\d+$/.test(ref)) return applyStack(deps, ref, options);
  if (!/^op-\d+$/.test(ref)) fail(`Usage: cast org apply op-N (or ds-N for a template stack); got ${ref}`);
  return applyProposal(deps, ref, options, io);
}

type WalkResult = { seq: number; line: string; verdict: "accept" | "skip" | "quit"; status?: string; note?: string; error?: string };

export async function applyProposal(deps: OrgInitDeps, ref: string, options: any, io?: ApplyIo): Promise<WalkResult[]> {
  // A session may propose; only a person applies. The server refuses too
  // (from_session on decide); the CLI says why before asking anything.
  const session = deps.callingSession();
  if (session) fail(`cast org apply is refused inside a session: a session may propose staffing but a person decides it. Ask them to open ${proposalUrl(deps, ref)} or run \`cast org apply ${ref}\` at a shell.`);
  const shown = await deps.cliPost("/cli/org/proposal", { proposal: ref });
  if (!shown || shown.error) fail(shown?.error ?? `No proposal ${ref}.`);
  const p = shown.proposal ?? shown;
  const changes: any[] = shown.changes ?? p.changes ?? [];
  const url = proposalUrl(deps, ref);
  const results: WalkResult[] = [];

  if (options.all) {
    const r = await deps.cliPost("/cli/org/proposal/accept-all", { proposal: ref });
    if (r?.error) fail(r.error);
    const rows: any[] = r?.results ?? r?.changes ?? [];
    for (const row of rows) results.push({ seq: row.seq, line: row.change ? describeOrgChange(row.change) : String(row.seq), verdict: "accept", status: row.status, note: row.applied_note ?? row.note, error: row.error });
    if (options.json) { console.log(JSON.stringify({ proposal: ref, results }, null, 2)); return results; }
    for (const row of results) console.log(`  ${statusTag(row.status)} ${fmt.muted(`#${row.seq}`)} ${row.line}${row.note ? ` ${fmt.muted(row.note)}` : ""}${row.error ? ` ${fmt.error(row.error)}` : ""}`);
    console.log(closingLine(results, ref, url));
    return results;
  }

  const pending = orderOrgChanges(changes.filter((c) => (c.status ?? "proposed") === "proposed"), (c) => c.change as OrgChange);
  const { decided, total } = decidedCount({ changes });
  console.log(`${fmt.highlight(p.short_id ?? ref)} ${p.title ?? ""} ${fmt.muted(`· ${decided} of ${total} decided · ${url}`)}`);
  if (p.summary_md) for (const line of String(p.summary_md).split("\n")) console.log(`  ${fmt.muted(line)}`);
  if (!pending.length) { console.log(fmt.muted("Nothing left to decide.")); return results; }
  const prompter = io ?? shellIo();

  for (const row of pending) {
    const change = row.change as OrgChange;
    console.log("");
    console.log(`${fmt.accent(`#${row.seq}`)} ${fmt.highlight(describeOrgChange(change))}`);
    if (row.rationale) console.log(`  ${row.rationale}`);
    for (const e of row.evidence ?? []) console.log(`  ${fmt.muted("evidence:")} ${e.label}${e.href ? ` ${fmt.muted(e.href)}` : ""}`);
    if (row.expected_effect) console.log(`  ${fmt.muted("expect:")} ${row.expected_effect}`);
    if (row.risk) console.log(`  ${fmt.muted("risk:")} ${row.risk}`);

    let verdict: "accept" | "skip" | "quit" | null = null;
    let edits: OrgChange | undefined;
    while (!verdict) {
      const a = (await prompter.ask("  accept, edit, skip, or quit? [a/e/s/q] ")).trim().toLowerCase();
      if (a === "a" || a === "accept" || a === "y" || a === "yes") verdict = "accept";
      else if (a === "s" || a === "skip" || a === "n" || a === "no") verdict = "skip";
      else if (a === "q" || a === "quit") verdict = "quit";
      else if (a === "e" || a === "edit") {
        const text = await prompter.edit(JSON.stringify(change, null, 2));
        let parsed: any;
        try { parsed = JSON.parse(text); } catch (err: any) { console.log(`  ${fmt.error(`not JSON: ${err?.message ?? err}`)}`); continue; }
        if (parsed && typeof parsed === "object" && !parsed.kind) parsed.kind = change.kind;
        const fault = orgChangeError(parsed);
        if (fault) { console.log(`  ${fmt.error(fault)}`); continue; }
        if (parsed.kind !== change.kind) { console.log(`  ${fmt.error(`the kind stays ${change.kind}; skip this change and propose another for a different kind`)}`); continue; }
        edits = parsed;
        console.log(`  ${fmt.muted("edited:")} ${describeOrgChange(edits!)}`);
        verdict = "accept";
      }
    }
    if (verdict === "quit") {
      results.push({ seq: row.seq, line: describeOrgChange(change), verdict });
      console.log(fmt.muted(`Stopped. The rest stay proposed: rerun cast org apply ${ref}, or decide them at ${url}.`));
      break;
    }
    const r = await deps.cliPost("/cli/org/proposal/decide", { change_id: row._id ?? `${ref}#${row.seq}`, verdict, ...(edits ? { edits } : {}) });
    const out: WalkResult = { seq: row.seq, line: describeOrgChange(edits ?? change), verdict, status: r?.status ?? (r?.error ? "failed" : verdict === "skip" ? "skipped" : "applied"), note: r?.applied_note ?? r?.note, error: r?.error };
    results.push(out);
    console.log(`  ${statusTag(out.status)}${out.note ? ` ${fmt.muted(out.note)}` : ""}${out.error ? ` ${fmt.error(out.error)}` : ""}`);
  }
  if (options.json) console.log(JSON.stringify({ proposal: ref, results }, null, 2));
  else if (results.every((r) => r.verdict !== "quit")) console.log(closingLine(results, ref, url));
  return results;
}

function statusTag(status?: string): string {
  return status === "applied" ? fmt.success("applied") : status === "failed" || status === "error" ? fmt.error("failed") : fmt.muted(status ?? "decided");
}

function closingLine(results: WalkResult[], ref: string, url: string): string {
  const applied = results.filter((r) => r.status === "applied").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed" || r.status === "error").length;
  return `${fmt.success(`${applied} applied`)}${skipped ? `, ${skipped} skipped` : ""}${failed ? `, ${fmt.error(`${failed} failed`)}` : ""} of ${results.length} in ${ref}${failed ? fmt.muted(` — the failed ones stay proposed: rerun cast org apply ${ref} and edit them, or see ${url}`) : ""}`;
}

/** Template stacks (ds-N) keep the decision stack path. */
export async function applyStack(deps: OrgInitDeps, stackRef: string, options: any): Promise<void> {
  const shown = await deps.cliPost("/cli/stack/show", { stack: stackRef });
  if (shown?.error) fail(shown.error);
  const decisions: any[] = orderForApply(shown.decisions ?? []);
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
  console.log(`${fmt.success(`${applied} applied`)}${pending ? `, ${pending} unanswered` : ""}${errors ? `, ${fmt.error(`${errors} failed`)}` : ""} of ${results.length} in ${shown.stack?.short_id ?? stackRef}${pending || errors ? fmt.muted(` — rerun cast org apply ${shown.stack?.short_id ?? stackRef} after ${pending ? "the rest are answered" : ""}${pending && errors ? " and " : ""}${errors ? "the failed ones are answered again with changes" : ""}`) : ""}`);
}

// ── staff ────────────────────────────────────────────────────────────────────

export async function staff(deps: OrgInitDeps, options: any): Promise<void> {
  const { ws, args } = await membership(deps, options);
  const session = deps.callingSession();
  if (options.adopt && !session) fail("--adopt makes THIS session the chief of staff's standing session, so it runs inside a session. At a shell, run it without --adopt to provision one.");
  if (!/^\d+(m|h|d|w)$/.test(String(options.every ?? "7d"))) fail(`--every wants a duration like 7d or 1d (got ${options.every})`);
  const r = await deps.cliPost("/cli/org/staff", { ...args, every: options.every ?? "7d", ...(options.adopt ? { adopt_conversation_id: session } : {}), from_session: session });
  if (!r || r.error) fail(r?.error ?? `You are not a member of ${deps.workspaceLabel(ws)}.`);
  if (options.json) { console.log(JSON.stringify(r, null, 2)); return; }
  const role = r.role ?? r;
  console.log(`${fmt.success("✓")} ${r.created === false || r.existing ? "already staffed" : "hired"} ${fmt.highlight(role.name ?? "Chief of Staff")} ${fmt.muted(`@${role.handle ?? CHIEF_OF_STAFF_HANDLE}${role.short_id ? ` · ${role.short_id}` : ""}`)}`);
  if (r.standing?.short_id || r.conversation_short_id) console.log(`  ${fmt.muted("standing session:")} ${r.standing?.short_id ?? r.conversation_short_id}${options.adopt ? fmt.muted(" (this session)") : ""}`);
  if (r.routine?.short_id ?? r.trigger?.short_id) console.log(`  ${fmt.muted("company review:")} every ${options.every ?? "7d"} ${fmt.muted(`(${r.routine?.short_id ?? r.trigger?.short_id})`)}`);
  if (r.proposal?.short_id) console.log(`  ${fmt.muted("first review:")} ${r.proposal.short_id} ${fmt.accent(proposalUrl(deps, r.proposal.short_id))}`);
  else console.log(`  ${fmt.muted("first review: running now; cast org proposals lists it when posted")}`);
}

// ── health ───────────────────────────────────────────────────────────────────

const SEVERITY_TAG: Record<string, (s: string) => string> = { blocker: fmt.error, warn: fmt.warning, info: fmt.muted };
function flagLine(f: any, indent: string): string {
  const tag = (SEVERITY_TAG[f.severity] ?? fmt.muted)(String(f.severity ?? "info").padEnd(7));
  return `${indent}${tag} ${f.code}${f.detail ? ` ${fmt.muted(String(f.detail))}` : ""}`;
}
const k = (n?: number | null) => n == null ? "?" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

export async function health(deps: OrgInitDeps, options: any): Promise<void> {
  const { ws, args } = await membership(deps, options);
  const h = await deps.cliPost("/cli/org/health", args);
  if (!h) fail(`You are not a member of ${deps.workspaceLabel(ws)}.`);
  if (options.json) { console.log(JSON.stringify(h, null, 2)); return; }
  const now = Date.now();
  const roles: any[] = h.roles ?? [];
  const people: any[] = h.people ?? [];
  const company = h.company ?? {};
  const flags = (xs: any[] | undefined) => xs ?? [];
  const total = roles.reduce((n, r) => n + flags(r.flags).length, 0) + people.reduce((n, p) => n + flags(p.flags).length, 0) + flags(company.flags).length;
  console.log(`${fmt.highlight(h.workspace?.name ?? deps.workspaceLabel(ws))} ${fmt.muted(`· ${roles.length} roles · ${people.length} people · ${total} flag${total === 1 ? "" : "s"}${h.generated_at ? ` · ${formatRelative(h.generated_at, now)}` : ""}`)}`);
  for (const r of roles) {
    const l = r.load ?? {}; const s = r.spend ?? {}; const f = r.flow ?? {};
    console.log(`  ${fmt.accent(`@${r.handle}`)}${r.short_id ? ` ${fmt.muted(r.short_id)}` : ""}${r.idle_days != null ? ` ${fmt.muted(`· ${r.idle_days}d since a scope event`)}` : ""}`);
    console.log(`    ${fmt.muted("load")}  ${l.open_tasks ?? 0} open · ${l.in_flight ?? 0} in flight · ${l.active_plans ?? 0} plans · ${l.live_hands ?? 0} hands · ${l.direct_reports ?? 0} reports`);
    console.log(`    ${fmt.muted("spend")} ${s.wakes_today ?? 0}/${s.wakes_cap ?? "?"} wakes today (${k(s.wakes_7d_avg)}/d over 7d) · ${k(s.tokens_today)}/${k(s.tokens_cap)} tokens${s.cap_hits_7d ? ` · ${s.cap_hits_7d} cap hits/7d` : ""}`);
    console.log(`    ${fmt.muted("flow")}  ${f.decisions_7d ?? 0} decisions/7d${f.median_recommend_min != null ? ` · ${f.median_recommend_min}m to recommend` : ""} · ${f.escalations_7d ?? 0} escalated · ${f.done_7d ?? 0} done/7d · ${f.review_stalls ?? 0} review stalls${f.sends_7d ? ` · sends ${(f.sends_7d.to ?? []).reduce((n: number, x: any) => n + (x.n ?? 0), 0)} out / ${(f.sends_7d.from ?? []).reduce((n: number, x: any) => n + (x.n ?? 0), 0)} in` : ""}`);
    for (const fl of flags(r.flags)) console.log(flagLine(fl, "    "));
  }
  for (const p of people) {
    const dw = p.decisions_waiting ?? {};
    console.log(`  ${fmt.accent(p.name ?? p.user_id)} ${fmt.muted(`· ${p.direct_roles ?? 0} direct roles · ${dw.n ?? 0} decisions waiting${dw.oldest_min ? ` (oldest ${dw.oldest_min}m)` : ""}`)}`);
    for (const fl of flags(p.flags)) console.log(flagLine(fl, "    "));
  }
  const unowned: any[] = company.unowned_projects ?? [];
  const noGoal: any[] = company.plans_without_goal ?? [];
  const noCharter: any[] = company.projects_without_charter ?? [];
  console.log(`  ${fmt.accent("company")} ${fmt.muted(`· ${unowned.length} unowned project${unowned.length === 1 ? "" : "s"}${unowned.length ? ` (${unowned.map((x) => x.title ?? x.id).join(", ")})` : ""} · ${company.unfiled_tasks ?? 0} unfiled tasks · ${noCharter.length} without a charter · ${noGoal.length} plan${noGoal.length === 1 ? "" : "s"} without a goal`)}`);
  for (const fl of flags(company.flags)) console.log(flagLine(fl, "    "));
  if (!total) console.log(fmt.muted("  no flags"));
}
