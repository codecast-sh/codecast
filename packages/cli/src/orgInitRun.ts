// The bodies of the `cast org` staffing verbs and the analyzer prompt they
// build (docs/architecture/head-of-people-prompt.md; org-init.md O1, O2).
// orgInit.ts registers the verbs and loads this module inside each action, so
// the prompt and the proposal contract stay off the CLI boot
// graph (bench/bootGraph.guard.test.ts).
import * as fs from "fs";
import * as path from "path";
import { spawn } from "./proc.js";
import { fmt } from "./colors.js";
import { headOfPeoplePrompt } from "@codecast/shared/contracts/headOfPeoplePrompt";
import {
  ORG_CHANGE_KINDS, describeOrgChange, extractOrgProposal, orgChangeDependencies, orgChangeError, orgReviseOpError, orderOrgChanges, parseOrgProposalSpec,
  type OrgChange, type OrgProposalMode, type OrgReviseOp, type OrgSpecChange,
} from "@codecast/shared/contracts/orgProposal";
import { formatRelative } from "@codecast/shared/time";
import { metricLine } from "@codecast/shared/contracts/initiative";
import { reachedBreakdown, reachedTotal } from "@codecast/shared/contracts/orgAreas";
import { formatDuration, parseDuration } from "./stackCommand.js";
import { HEAD_OF_PEOPLE_HANDLE, isHeadOfPeopleRole, ORG_INIT_LABEL, type OrgInitDeps, type OrgInitMode, type OrgInitSummary } from "./orgInit.js";

// ── The prompt ───────────────────────────────────────────────────────────────
//
// The Head of People's own text (shared/contracts/headOfPeoplePrompt.ts), the
// same one its opening message carries, with the workspace, the person and
// the verbs' --team flag filled in.

export type PromptFacts = {
  mode: OrgInitMode;
  workspace: string;
  teamFlag?: string;
  summary: OrgInitSummary;
  /** A proposal of this kind still open: the reference states it as a fact. */
  open?: { short_id: string; title: string; decided: number; total: number; url: string };
};

export function buildOrgAnalyzerPrompt(opts: PromptFacts): string {
  return headOfPeoplePrompt({ workspace: opts.workspace, person: opts.summary.person ?? "the person who asked for this review", mode: opts.mode, team: opts.teamFlag, open: opts.open });
}

/** Where coverage stands before the proposal (I2), as `cast org inputs` prints it. */
export function coverageLine(c: OrgInitSummary["coverage"]): string {
  if (!c) return "";
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const initiatives = c.initiatives_active ? `${plural(c.initiatives_active, "active initiative")}${c.initiatives_without_owner ? `, ${c.initiatives_without_owner} with no owner` : ""}` : "no active initiatives";
  const outside = [c.outside_plans ? plural(c.outside_plans, "plan") : "", c.outside_areas ? `${plural(c.outside_areas, "area")} of commits and sessions in ${c.outside_repositories} ${c.outside_repositories === 1 ? "repository" : "repositories"}` : ""].filter(Boolean).join(" and ");
  const paused = c.with_lead_paused ? ` (${c.with_lead_paused} more ${c.with_lead_paused === 1 ? "has" : "have"} a paused one)` : "";
  return `${initiatives}; ${c.with_lead} of ${plural(c.with_work, "project")} with work ${c.with_lead === 1 ? "has" : "have"} a lead${paused}${outside ? `; outside any project: ${outside}` : ""}`;
}

// ── Guards and helpers ───────────────────────────────────────────────────────

/** An open analyzer proposal for the workspace, from the rows
 *  /cli/org/proposals returns (already scoped to the boundary). Init and
 *  review block each other: two analyzers proposing the same chart would post
 *  duplicate ghosts, and accepting both is safe only by accident of the
 *  handle clash. A person's own request does not block. */
export function findOpenOrgProposal(
  proposals: Array<{ short_id: string; title: string; mode?: OrgProposalMode; status?: string; decided?: number; total?: number; changes?: any[]; counts?: { decided?: number; total?: number } }> | null | undefined,
): { short_id: string; title: string; decided: number; total: number } | null {
  const hit = (proposals ?? []).find((p) => (p.status ?? "open") === "open" && (p.mode === "init" || p.mode === "review"));
  if (!hit) return null;
  return { short_id: hit.short_id, title: hit.title, ...decidedCount(hit) };
}

/** Stacks (ds-N) keep the older apply order; one sort for both. */
export function orderForApply<T extends { context_md?: string | null }>(decisions: T[]): T[] {
  return orderOrgChanges(decisions, (d) => extractOrgProposal(d.context_md));
}

/** The person the Head of People reports to, as the inputs name them. */
function personOf(roles: any[]): string | undefined {
  const to = roles.find((r) => (!!r && isHeadOfPeopleRole(r)))?.reports_to;
  return typeof to === "string" && to.trim() && !to.startsWith("@") ? to : undefined;
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
    head_of_people: roles.some((r) => (!!r && isHeadOfPeopleRole(r))),
    ...((personOf(roles) ?? inputs?.members?.find((m: any) => m?.is_me)?.name) ? { person: personOf(roles) ?? inputs.members.find((m: any) => m?.is_me).name } : {}),
    stale: {
      plans: inputs?.activity?.stale?.plans?.length ?? 0,
      tasks: inputs?.activity?.stale?.tasks?.length ?? 0,
      projects: inputs?.activity?.stale?.projects?.length ?? 0,
    },
    ...(inputs?.coverage ? { coverage: {
      initiatives_active: inputs.coverage.active_initiatives ?? 0,
      initiatives_without_owner: inputs.coverage.active_without_owner ?? 0,
      with_work: inputs.coverage.with_work ?? 0,
      with_lead: inputs.coverage.with_lead ?? 0,
      with_lead_paused: inputs.coverage.with_lead_paused ?? 0,
      outside_plans: inputs.coverage.outside?.plans?.length ?? 0,
      outside_areas: inputs.coverage.outside?.areas?.length ?? 0,
      outside_repositories: new Set((inputs.coverage.outside?.areas ?? []).map((a: any) => a.repository)).size,
    } } : {}),
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
  // Who answers for the work (I1, I2): the initiatives, then the before count.
  for (const i of inputs.coverage?.initiatives ?? []) {
    const chain = i.chain?.length ? ` · under ${i.chain.map((c: any) => c.short_id).join(", under ")}` : "";
    const numbers = (i.metrics ?? []).map((m: any) => metricLine(m)).join(" · ");
    console.log(`  ${fmt.muted("initiative")} ${i.short_id} ${i.title} ${fmt.muted(`· ${i.status} · ${String(i.health).replace(/_/g, " ")} · ${i.owner ? (i.owner.handle ?? i.owner.name) : "no owner"}${chain}${i.projects_without_lead ? ` · ${i.projects_without_lead} of its projects with no lead` : ""}`)}`);
    if (numbers) console.log(`    ${fmt.muted(numbers)}`);
  }
  if (s.coverage) console.log(`  ${fmt.muted("coverage:")} ${coverageLine(s.coverage)}`);
  // Where the work is (S9): the busiest areas and the records behind them.
  for (const a of (inputs.activity?.areas ?? []).slice(0, 8)) console.log(`  ${fmt.muted("area")} ${a.repository ? `${a.repository}${a.path_prefix ? "/" : ""}` : ""}${a.path_prefix || fmt.muted(" (commits with no file list: could not verify)")} ${fmt.muted(`· ${a.commits_30d} commits · ${a.sessions_30d} sessions${a.authors?.length ? ` · ${a.authors.slice(0, 3).map((x: any) => x.name).join(", ")}` : ""}`)}`);
  if (s.stale.plans + s.stale.tasks + s.stale.projects) console.log(`  ${fmt.muted("stale:")} ${s.stale.plans} plans · ${s.stale.tasks} tasks · ${s.stale.projects} projects ${fmt.muted("(records behind the activity; a review proposes their status changes first)")}`);
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
  // Init refuses: two first charts would post duplicate ghosts. A review
  // with last week's proposal still open is the routine's ordinary Monday: the
  // prompt tells the reviewer to read what changed and add nothing until the
  // person has decided. Withdrawing is the person's act, never a hint here.
  if (open && mode === "init") {
    fail(
      `${open.short_id} "${open.title}" is still open (${open.decided} of ${open.total} decided), so a second proposal is not started.\n` +
      `Decide it on the org page (${proposalUrl(deps, open.short_id)}) before running this again.`,
    );
  }
  const prompt = buildOrgAnalyzerPrompt({ mode, workspace, teamFlag: options.team, summary: summarizeInputs(inputs), open: open ? { ...open, url: proposalUrl(deps, open.short_id) } : undefined });
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
  for (const n of parsed.notes ?? []) console.log(`  ${fmt.muted(`folded ${n}`)}`);
  if (options.supersedes && !/^op-\d+$/.test(options.supersedes)) fail(`--supersedes wants a proposal id like op-12 (got ${options.supersedes})`);
  const { ws, args } = await membership(deps, options);
  const result = await deps.cliPost("/cli/org/propose", { ...args, ...parsed.spec, from_session: deps.callingSession(), ...(options.supersedes ? { supersedes: options.supersedes } : {}) });
  if (!result || result.error) fail(result?.error ?? `You are not a member of ${deps.workspaceLabel(ws)}.`);
  if (options.json) { console.log(JSON.stringify({ ...result, url: proposalUrl(deps, result.short_id) }, null, 2)); return; }
  const n = result.changes?.length ?? parsed.spec.changes.length;
  console.log(`${fmt.success("✓")} ${fmt.highlight(result.short_id)} ${parsed.spec.title} ${fmt.muted(`· ${n} change${n === 1 ? "" : "s"} · ${parsed.spec.mode}`)}`);
  // The numbers are the server's: the parser may fold two spec rows into one,
  // so a change's number is read here, never counted from the spec.
  for (const row of result.changes ?? []) console.log(`  ${changeRow(row)}`);
  for (const a of parsed.spec.asks ?? []) console.log(`  ${fmt.muted(`ask: ${a.title} (${a.seqs.length} change${a.seqs.length === 1 ? "" : "s"})`)}`);
  console.log(`  ${fmt.accent(proposalUrl(deps, result.short_id))}`);
}

/** One change as the shell names it: its number in the proposal (the n of
 *  `op-N#n` and of `cast org revise`), then what it does. */
function changeRow(row: { seq: number; line?: string; change?: unknown }): string {
  return `${fmt.muted(`#${row.seq}`)} ${row.line ?? describeOrgChange(row.change as OrgChange)}`;
}

// ── revise (S18) ─────────────────────────────────────────────────────────────

/** JSON from a flag value: inline text when it parses, else a file ('-' is stdin). */
function readJsonArg(value: string, flag: string): unknown {
  const text = value === "-" || fs.existsSync(value) ? readSpecText(value) : value;
  try { return JSON.parse(text); } catch (e: any) { fail(`${flag} is not JSON (inline text or a file): ${e?.message ?? e}`); }
}

const seqOf = (raw: string, flag: string): number => {
  const n = Number(String(raw).replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) fail(`${flag} wants a change number like 3 (got ${raw})`);
  return n;
};

/** The ops the flags describe, in the order remove, amend, add. Pure over
 *  `readJson`, so the test drives it; `--ops` hands the list over as is,
 *  with `--note` filled in where an op has none. */
export function buildReviseOps(options: any, readJson: (value: string, flag: string) => unknown = readJsonArg): OrgReviseOp[] {
  const note = options.note ? { note: String(options.note) } : {};
  let ops: OrgReviseOp[] = [];
  if (options.ops) {
    const raw = readJson(options.ops, "--ops");
    if (!Array.isArray(raw)) fail("--ops wants a JSON list of ops");
    ops = raw.map((o: any) => (o && typeof o === "object" && options.note && o.note === undefined ? { ...o, ...note } : o));
  } else {
    for (const r of options.remove ?? []) ops.push({ op: "remove", seq: seqOf(r, "--remove"), ...note });
    if (options.amend !== undefined) {
      if (options.edits === undefined && !options.rationale) fail("--amend wants --edits (a JSON patch over the change's keys), --rationale <text>, or both");
      ops.push({ op: "amend", seq: seqOf(options.amend, "--amend"), ...(options.edits !== undefined ? { edits: readJson(options.edits, "--edits") as Record<string, unknown> } : {}), ...(options.rationale ? { rationale: String(options.rationale) } : {}), ...note });
    } else if (options.edits !== undefined || options.rationale) fail("--edits and --rationale go with --amend <seq>");
    for (const file of options.add ?? []) {
      const raw = readJson(file, "--add");
      for (const c of Array.isArray(raw) ? raw : [raw]) ops.push({ op: "add", change: c as OrgSpecChange, ...note });
    }
  }
  if (!ops.length) fail("Nothing to do: give --remove <seq>, --amend <seq> with --edits or --rationale, --add <file>, or --ops <file>");
  const faults = ops.map((o, i) => { const f = orgReviseOpError(o); return f ? `  - ops[${i}]: ${f}` : null; }).filter(Boolean);
  if (faults.length) fail(`The revise is not valid:\n${faults.join("\n")}`);
  return ops;
}

export async function revise(deps: OrgInitDeps, ref: string, options: any): Promise<void> {
  if (!/^op-\d+$/.test(ref)) fail(`Usage: cast org revise op-N [--remove <seq>] [--amend <seq> --edits <json> | --rationale <text>] [--add <file>] [--note <text>]; got ${ref}`);
  const ops = buildReviseOps(options);
  const from_session = deps.callingSession();
  if (!from_session) fail("cast org revise runs inside the session that posted the proposal (or the standing session of the role that did); at a plain shell, decide it on the org page instead");
  const r = await deps.cliPost("/cli/org/proposal/revise", { proposal: ref, ops, from_session });
  if (!r || r.error) fail(r?.error ?? `Could not revise ${ref}.`);
  if (options.json) { console.log(JSON.stringify({ ...r, url: proposalUrl(deps, ref) }, null, 2)); return; }
  const { decided, total } = decidedCount(r);
  console.log(`${fmt.success("✓")} ${fmt.highlight(ref)} revised ${fmt.muted(`· ${decided} of ${total} decided`)}`);
  for (const j of r.revisions ?? []) console.log(`  ${revisionLine(j)}`);
  console.log(`${fmt.muted("The person decides what is left on the org page:")} ${fmt.accent(proposalUrl(deps, ref))}`);
}

/** One journal entry as a line: what happened to which change, and the note. */
function revisionLine(j: any): string {
  const what = j.op === "removed" ? fmt.error("removed") : j.op === "added" ? fmt.success("added") : fmt.accent("amended");
  const detail = j.op === "amended" && j.was && j.was !== j.line ? `${j.line} ${fmt.muted(`(was: ${j.was})`)}` : j.line;
  return `${what} ${fmt.muted(`#${j.seq}`)} ${detail}${j.note ? ` ${fmt.muted(`· ${j.note}`)}` : ""}`;
}

/** The list carries `counts`, the get carries the change rows; one reading. */
function decidedCount(p: any): { decided: number; total: number } {
  if (p.counts && typeof p.counts.total === "number") return { decided: p.counts.decided ?? 0, total: p.counts.total };
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
    // Who posted it decides who may supersede or withdraw it, so the line
    // carries the author's short id and name, not just its kind.
    const a = p.author ?? {};
    const who = a.kind === "user" ? "a person" : a.kind === "role" ? `@${a.handle ?? a.name ?? "role"}` : "session";
    const author = `${who}${a.kind !== "user" && a.short_id ? ` ${a.short_id}` : ""}${a.kind === "session" && a.title ? ` "${a.title}"` : a.kind === "user" && a.name ? ` ${a.name}` : ""}`;
    console.log(`  ${fmt.highlight(p.short_id)} ${p.title} ${fmt.muted(`· ${p.status ?? "open"} · ${p.mode ?? ""} · ${decided}/${total} decided · ${author} · ${formatRelative(p.created_at ?? now, now)}`)}`);
  }
}

// ── apply ────────────────────────────────────────────────────────────────────

export async function apply(deps: OrgInitDeps, ref: string, options: any): Promise<void> {
  if (/^ds-\d+$/.test(ref)) return applyStack(deps, ref, options);
  if (!/^op-\d+$/.test(ref)) fail(`Usage: cast org apply op-N (or ds-N for a template stack); got ${ref}`);
  return showProposal(deps, ref, options);
}

/** A proposal is decided on the org page and nowhere else (S4): the server
 *  refuses a decide from any token or session. The shell prints what the page
 *  will show, the counts, and the link. */
export async function showProposal(deps: OrgInitDeps, ref: string, options: any): Promise<void> {
  const shown = await deps.cliPost("/cli/org/proposal", { proposal: ref });
  if (!shown || shown.error) fail(shown?.error ?? `No proposal ${ref}.`);
  const p = shown.proposal ?? shown;
  const changes: any[] = orderOrgChanges(shown.changes ?? p.changes ?? [], (c: any) => c.change as OrgChange);
  const url = proposalUrl(deps, ref);
  if (options.json) { console.log(JSON.stringify({ ...p, changes, url }, null, 2)); return; }
  const { decided, total } = decidedCount({ changes });
  console.log(`${fmt.highlight(p.short_id ?? ref)} ${p.title ?? ""} ${fmt.muted(`· ${p.status ?? "open"} · ${decided} of ${total} decided`)}`);
  if (p.summary_md) for (const line of String(p.summary_md).split("\n")) console.log(`  ${fmt.muted(line)}`);
  // Rows print in APPLY order, not by seq: a role before its adopt, the adopt
  // before its routine, a record sync before a seat. A row that seats or needs
  // another says so on its own line.
  const depends = orgChangeDependencies(changes.map((c: any) => ({ seq: c.seq, change: c.change as OrgChange })));
  console.log(fmt.muted("  in apply order (a row that seats or depends on another says so):"));
  for (const row of changes) {
    console.log(`  ${statusTag(row.status)} ${changeRow(row)}${row.applied_note ? ` ${fmt.muted(row.applied_note)}` : ""}`);
    const dep = row.depends ?? depends[row.seq];
    if (dep) console.log(`      ${fmt.muted(dep)}`);
  }
  if (p.revisions?.length) {
    console.log(fmt.muted("  revised by its author, in order:"));
    for (const j of p.revisions) console.log(`    ${revisionLine(j)}`);
  }
  console.log(`${fmt.muted("Decide it on the org page:")} ${fmt.accent(url)}`);
}

function statusTag(status?: string): string {
  return status === "applied" ? fmt.success("applied") : status === "failed" ? fmt.error("failed") : status === "accepted" ? fmt.success("accepted") : status === "skipped" ? fmt.muted("skipped") : status === "removed" ? fmt.muted("removed") : fmt.muted(status ?? "proposed");
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
  if (options.adopt && !session) fail("--adopt makes THIS session the head of people's standing session, so it runs inside a session. At a shell, run it without --adopt to provision one.");
  let every_ms: number;
  try { every_ms = parseDuration(String(options.every ?? "7d")); } catch (e: any) { fail(`--every: ${e?.message ?? e}`); }
  // A provisioned standing session needs a project path, like every other
  // provisioning verb; an adopted session keeps its own.
  const project_path = options.adopt ? undefined : options.dir ? path.resolve(String(options.dir).replace(/^~/, process.env.HOME || "~")) : deps.realCwd();
  if (options.seat && options.seat !== "existing" && options.seat !== "fresh") fail("--seat takes existing or fresh");
  const r = await deps.cliPost("/cli/org/staff", { ...args, every_ms, seat: options.seat, model: options.model, ...(options.adopt ? { adopt_conversation_id: session } : { project_path }), from_session: session });
  if (!r || r.error) fail(r?.error ?? `You are not a member of ${deps.workspaceLabel(ws)}.`);
  if (options.json) { console.log(JSON.stringify(r, null, 2)); return; }
  const role = r.role ?? {};
  console.log(`${fmt.success("✓")} ${r.already_existed ? "already staffed" : r.adopted ? "adopted" : "hired"} ${fmt.highlight(role.name ?? "Head of People")} ${fmt.muted(`@${role.handle ?? HEAD_OF_PEOPLE_HANDLE}${role.short_id ? ` · ${role.short_id}` : ""}`)}`);
  if (r.standing?.short_id) console.log(`  ${fmt.muted("standing session:")} ${r.standing.short_id}${r.adopted ? fmt.muted(r.seated === "existing" && !options.adopt ? " (the workspace's standing agent, seated; nothing restarted)" : " (this session)") : ""}`);
  if (r.previous_standing?.short_id) console.log(`  ${fmt.muted("previous standing agent retired; its thread is kept:")} ${r.previous_standing.short_id}`);
  if (r.routine?.short_id) console.log(`  ${fmt.muted("company review:")} every ${formatDuration(every_ms)} ${fmt.muted(`(${r.routine.short_id})`)}`);
  if (!r.already_existed) console.log(`  ${fmt.muted("first review: running now; cast org proposals lists it when posted")}`);
}

// ── assistant ────────────────────────────────────────────────────────────────
// Hire an Executive Assistant (org-staffing.md S30): the person's right hand.
// Global (every workspace, theirs alone) unless --team names one; --personal
// keeps a team's assistant in the person's own boundary.

export async function assistant(deps: OrgInitDeps, options: any): Promise<void> {
  const session = deps.callingSession();
  if (options.adopt && !session) fail("--adopt makes THIS session the assistant's standing session, so it runs inside a session. At a shell, run it without --adopt to provision one.");
  let reach: any = { reach: "global" };
  if (options.team) {
    const { ws, args } = await membership(deps, options);
    if (!args.team_id) fail(`You are not a member of ${deps.workspaceLabel(ws)}.`);
    reach = { reach: "team", team_id: args.team_id };
  } else if (options.personal) fail("--personal goes with --team: a global Executive Assistant is always yours alone.");
  const project_path = options.adopt ? undefined : options.dir ? path.resolve(String(options.dir).replace(/^~/, process.env.HOME || "~")) : deps.realCwd();
  const r = await deps.cliPost("/cli/org/assistant", { reach, personal: !!options.personal, given_name: options.name, handle: options.handle, avatar: options.avatar, model: options.model, ...(options.adopt ? { adopt_conversation_id: session } : { project_path }), from_session: session });
  if (!r || r.error) fail(r?.error ?? "Could not hire an Executive Assistant.");
  if (options.json) { console.log(JSON.stringify(r, null, 2)); return; }
  const role = r.role ?? {};
  const where = reach.reach === "global" ? "across every workspace" : options.personal ? "for the team, yours alone" : "for the team";
  console.log(`${fmt.success("✓")} ${r.already_existed ? "already standing" : r.adopted ? "adopted" : "hired"} ${fmt.highlight(role.given_name ?? "Executive Assistant")} ${fmt.muted(`· Executive Assistant, ${where} · @${role.handle}${role.short_id ? ` · ${role.short_id}` : ""}`)}`);
  if (r.standing?.short_id) console.log(`  ${fmt.muted("standing session:")} ${r.standing.short_id}${r.adopted ? fmt.muted(" (this session)") : ""}`);
  if (reach.reach === "global" && !r.already_existed) console.log(`  ${fmt.muted("it is pinned in the app header on every page; cast role update --given-name renames it")}`);
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
  // Each role as its area reads (org-staffing.md S29): the status word, when
  // it last checked and checks next, its own latest line, the sessions
  // waiting under it and the signals that matter. The counts behind the
  // status are in --json; the words here are the ones a person reads.
  for (const r of roles) {
    const a = r.area ?? {};
    const check = a.check ?? {};
    const checked = a.checked_at ? `checked ${formatRelative(a.checked_at, now)}` : "never checked";
    const nextCheck = check.status === "paused" ? "check paused" : check.run_at ? `next check ${formatRelative(check.run_at, now)}` : check.status ? `check ${check.status}` : "no check";
    console.log(`  ${fmt.accent(`@${r.handle}`)}${r.short_id ? ` ${fmt.muted(r.short_id)}` : ""} ${fmt.highlight(String(a.status ?? "").replace(/_/g, " "))} ${fmt.muted(`· ${checked} · ${nextCheck}`)}`);
    if (a.status_line && a.status !== "on_track") console.log(`    ${a.status_line}`);
    if (a.reached && reachedTotal(a.reached) > 0) console.log(`    ${fmt.muted("reached")} ${reachedBreakdown(a.reached)}`);
    if (a.standing) console.log(`    ${fmt.muted("says")}  ${a.standing.project}: ${a.standing.text}${a.standing.written_on ? fmt.muted(` (${a.standing.written_on})`) : ""}`);
    for (const w of a.waiting ?? []) console.log(`    ${fmt.muted("waits")} ${w.short_id} ${w.title}${w.state ? fmt.muted(` · ${w.state}`) : ""} ${fmt.muted(`· ${w.why} ${formatRelative(w.since, now)}`)}`);
    for (const sg of a.signals ?? []) console.log(`    ${(SEVERITY_TAG[sg.severity] ?? fmt.muted)(String(sg.severity).padEnd(7))} ${sg.text}`);
    for (const fl of flags(r.flags).filter((f: any) => f.severity !== "info")) console.log(flagLine(fl, "    "));
  }
  for (const p of people) {
    const dw = p.decisions_waiting ?? {};
    console.log(`  ${fmt.accent(p.name ?? p.user_id)} ${fmt.muted(`· ${p.direct_roles ?? 0} direct roles · ${dw.n ?? 0} decisions waiting${dw.oldest_min ? ` (oldest ${dw.oldest_min}m)` : ""}`)}`);
    for (const fl of flags(p.flags)) console.log(flagLine(fl, "    "));
  }
  const unowned: any[] = company.unowned_projects ?? [];
  const watched: any[] = company.watched_without_lead ?? [];
  const noGoal: any[] = company.plans_without_goal ?? [];
  const noCharter: any[] = company.projects_without_charter ?? [];
  const unfiledPlans: any[] = company.unfiled_plans ?? [];
  console.log(`  ${fmt.accent("company")} ${fmt.muted(`· ${unowned.length} unowned project${unowned.length === 1 ? "" : "s"}${unowned.length ? ` (${unowned.map((x) => x.title ?? x.id).join(", ")})` : ""}${watched.length ? ` · ${watched.length} watched by two roles with no lead (${watched.map((x) => `${x.title ?? x.id}: ${(x.roles ?? []).map((h: string) => `@${h}`).join(", ")}`).join("; ")})` : ""} · ${company.unfiled_tasks ?? 0} unfiled tasks · ${unfiledPlans.length} unfiled plan${unfiledPlans.length === 1 ? "" : "s"} with open work · ${noCharter.length} without a charter · ${noGoal.length} plan${noGoal.length === 1 ? "" : "s"} without a goal`)}`);
  // Warnings and blockers print one per line; info flags (a charter missing on
  // each of forty plans) collapse to one line per code with a few examples,
  // and --json keeps every row.
  const info = flags(company.flags).filter((f) => f.severity === "info");
  for (const fl of flags(company.flags).filter((f) => f.severity !== "info")) console.log(flagLine(fl, "    "));
  const byCode = new Map<string, any[]>();
  for (const fl of info) byCode.set(fl.code, [...(byCode.get(fl.code) ?? []), fl]);
  for (const [code, rows] of byCode) {
    const shown = rows.slice(0, 3).map((f) => String(f.detail ?? "")).filter(Boolean);
    console.log(`    ${fmt.muted("info   ")} ${code} ${fmt.muted(`× ${rows.length}: ${shown.join("; ")}${rows.length > shown.length ? `; +${rows.length - shown.length} more (--json)` : ""}`)}`);
  }
  if (!total) console.log(fmt.muted("  no flags"));
}
