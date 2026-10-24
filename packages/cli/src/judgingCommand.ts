// Setting up judging (docs/architecture/learning-loop.md LL4): the pass a
// session follows to give a project judges a person can trust, and the one
// tool it needs that the product's own commands cannot give it, a judge tried
// on a moment exactly as codecast will run it (LL8).
//
//   cast line judging [--project <ref>] [--judge <name>]   the pass, written out for the project
//   cast line judges try <judge> <moment.json|-|mo-N>... [--extract] [--prompt] [--json]
//
// The pass is judgingSetup.md, principle level, its one home. The web's
// "Set up judging" and "Improve this judge" start a session in the project's
// checkout that runs `cast line judging` and follows it (web lib/line/setupJudging.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InvalidArgumentError, type Command } from "commander";
import { fmt } from "./colors.js";
import { apiPost, type PublishDeps } from "./castApi.js";
import { lineProjectFor, scopeFor } from "./lineScope.js";
import { JUDGES_DIR, fileVersion } from "./momentsHost.js";
import { execFileAsync } from "./proc.js";
import { judgeRequest, narrowBrief, parseJudgeReply, parseJudgeSpec, type ExpectationsBrief, type JudgeFinding, type JudgeSpec } from "@codecast/shared/contracts/judges";
import { JUDGE_BACKENDS, parseExtractorOutput, type JudgeBackend, type MomentRecord } from "@codecast/shared/contracts/moments";
import { subscriptionModelCall } from "./subscriptionCall.js";
import type { ModelCallResult, ModelCallSpec } from "@codecast/shared/contracts/modelCall";
import setupPass from "./judgingSetup.md" with { type: "text" };
import { momentOn, registerJudgeFixCommands, showMoment, type MomentShown } from "./judgeFixCommand.js";
import { tryAgentReviews, type ReviewClaim } from "./agentReviewsHost.js";
import { AGENT_FINDINGS_TURN, agentJudgePrompt, parseAgentFindings, type AgentFinding } from "@codecast/shared/contracts/agentJudges";

function fail(message: string, code = 2): never {
  console.error(fmt.error(message));
  process.exit(code);
}

/** What the pass starts from: the whole project, or one judge people want better, with the cases they marked wrong. */
export type JudgingFocus = { judge?: string };

export function focusText(project: string, focus: JudgingFocus): string {
  if (!focus.judge) {
    return `Give ${project} the judges it needs: what it should learn from, drafted, tried on real recent data and brought to a person as one card. Where it already has judges, make them right before adding more.`;
  }
  return [
    `Start from one judge, ${focus.judge}, which a person wants better. For each case it got wrong, ask one question first: was the fact it needed missing from what it was shown, or there and misread?`,
    "A missing fact is fixed in what the judge reads (its extractor, or the product's equivalent); a misread one in the judge's prompt, or in an expectation too vague to grade against.",
    "The wrong cases are the test: try the judge on them before and after your change, beside cases it already gets right, and bring the difference on the card. The rest of this pass applies to this one judge.",
  ].join(" ");
}

/** The pass for one project, as a session reads it. `ref` is what the commands in it take. */
export function renderJudgingSetup(project: { title: string; ref: string }, focus: JudgingFocus = {}): string {
  return setupPass
    .replaceAll("{{focus}}", focusText(project.title, focus))
    .replaceAll("{{project.name}}", project.title)
    .replaceAll("{{project.ref}}", project.ref);
}

/** A tried moment as the judge will read it: an extractor's output (or a kept moment) with the judge's kind, read now. */
export function momentForTry(raw: unknown, spec: Pick<JudgeSpec, "moment">, subject: string, now: number): MomentRecord | { error: string } {
  const out = parseExtractorOutput(raw);
  if ("error" in out) return out;
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const at = out.at ?? (typeof r.event_at === "number" ? r.event_at : now);
  return {
    ...out,
    kind: typeof r.kind === "string" ? r.kind : spec.moment,
    subject: typeof r.subject === "string" ? r.subject : subject,
    event_at: at,
    extracted_at: now,
    gap_ms: typeof r.gap_ms === "number" ? r.gap_ms : 0,
    extractor: { path: "tried by hand", version: "draft" },
  };
}

export type TryOutcome = {
  moment: string;
  result: ModelCallResult;
  findings?: JudgeFinding[];
  uncited?: number;
  unparsed?: boolean;
};

/** One tried moment in words. */
export function formatTry(o: TryOutcome): string {
  const r = o.result;
  if (!r.ok && r.reason === "budget") {
    const most = typeof r.worst_case_usd === "number" ? ` One call on this moment costs at most $${r.worst_case_usd.toFixed(4)} on ${r.model}.` : "";
    return `${o.moment}: not sent. The team's monthly model budget is off or full; a team admin sets it in the team's settings.${most}`;
  }
  if (!r.ok) return `${o.moment}: failed, ${r.error} ($${r.cost_usd.toFixed(4)})`;
  if (o.unparsed) return `${o.moment}: the answer held no deviations list ($${r.cost_usd.toFixed(4)})\n${r.text.slice(0, 800)}`;
  const lines = [`${o.moment}: ${o.findings!.length} finding${o.findings!.length === 1 ? "" : "s"}${o.uncited ? `, ${o.uncited} citing no listed expectation (set aside)` : ""}, $${r.cost_usd.toFixed(4)} (${r.usage.input_tokens} tokens in, ${r.usage.output_tokens} out)`];
  for (const f of o.findings!) lines.push(`  ${f.expectation} severity ${f.severity}: ${f.what_happened}${f.quote ? `\n    "${f.quote}"` : ""}`);
  return lines.join("\n");
}

export async function repoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" } as any);
    return String(stdout).trim();
  } catch {
    return cwd;
  }
}

/** One model call on the team's budget, as codecast's own judging makes it; a failure is a result, never a throw. */
export async function callModel(deps: PublishDeps, scope: Record<string, unknown>, request: ModelCallSpec, label: string): Promise<ModelCallResult> {
  const { siteUrl, apiToken } = deps.getCliEndpoint();
  try {
    const resp = await fetch(`${siteUrl}/cli/model/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: apiToken, ...scope, ...request, label }),
    });
    const body: any = await resp.json();
    return body && typeof body.ok === "boolean" ? body : { ok: false, reason: "failed", error: body?.error ?? `the server answered ${resp.status}`, cost_usd: 0, model: request.model };
  } catch (err: any) {
    return { ok: false, reason: "failed", error: err?.message ?? String(err), cost_usd: 0, model: request.model };
  }
}

/** One judge call where the source's judges make theirs: on the team's budget (callModel), or on this machine's Claude Code login. */
export async function judgeCall(on: JudgeBackend, deps: PublishDeps, scope: Record<string, unknown>, request: ModelCallSpec, label: string): Promise<ModelCallResult> {
  return on === "subscription" ? await subscriptionModelCall(request) : await callModel(deps, scope, request, label);
}

/**
 * Where these judges make their calls unless told otherwise: their source's
 * judge_on (`cast sources set <source> --judge-on`), so a replay of a judge
 * spends where the published judge does. api when none of them is published.
 */
export async function judgeBackendOf(deps: PublishDeps, scope: Record<string, unknown>, judges: string[]): Promise<JudgeBackend> {
  const ls = await apiPost(deps, "/cli/moments/ls", { ...scope, limit: 1 }, { read: true, exitOnError: false }).catch(() => null);
  const on = (ls?.judges ?? []).find((j: any) => judges.includes(j.name))?.judge_on;
  return on === "subscription" ? "subscription" : "api";
}

/** A --on value, checked. */
export function judgeBackendOption(v: string): JudgeBackend {
  if (!(JUDGE_BACKENDS as readonly string[]).includes(v)) throw new InvalidArgumentError(`one of ${JUDGE_BACKENDS.join(", ")}`);
  return v as JudgeBackend;
}

function readJudge(root: string, ref: string): { spec: JudgeSpec; file: string } {
  const file = fs.existsSync(ref) && ref.endsWith(".md") ? path.resolve(ref) : path.join(root, JUDGES_DIR, `${ref}.md`);
  if (!fs.existsSync(file)) fail(`No judge at ${path.relative(root, file) || file}: a judge is ${JUDGES_DIR}/<name>.md in the product's repository`);
  const spec = parseJudgeSpec(path.basename(file, ".md"), fs.readFileSync(file, "utf8"));
  if ("error" in spec) fail(spec.error);
  return { spec, file };
}

function readMoment(arg: string): string {
  if (arg === "-") return fs.readFileSync(0, "utf8");
  if (!fs.existsSync(arg)) fail(`No moment file at ${arg}: give the JSON an extractor printed, - for stdin, or a stored moment's mo-N`);
  return fs.readFileSync(arg, "utf8");
}

/** A moment handed to `try`: its record as the judge reads it, and for a stored one (mo-N) what codecast holds of it. */
type TriedMoment = { name: string; record: MomentRecord; shown?: MomentShown };

/** One agent judge session tried on a moment: what it found, beside what the published judge found there. */
export type AgentTryOutcome = {
  moment: string;
  ok: boolean;
  error?: string;
  findings: AgentFinding[];
  /** What the published judge of this name found on this moment, newest run first; absent for a moment given as a file. */
  before?: Array<{ judge_version: string; findings: Array<{ what: string; severity: number }> }>;
  account: string;
  took_ms: number;
  notional_usd: number;
  /** The session's run directory: its prompt, stream and both answers. */
  dir: string;
};

/** An agent judge's try in words: each moment's findings, then the published judge's beside them. */
export function formatAgentTry(o: AgentTryOutcome): string {
  const head = `${o.moment}: ${o.ok ? `${o.findings.length} finding${o.findings.length === 1 ? "" : "s"}` : `failed, ${o.error}`}, ${Math.round(o.took_ms / 60_000)}m on ${o.account}, $${o.notional_usd.toFixed(2)} at list price`;
  const lines = [head, ...o.findings.map((f) => `  severity ${f.severity}: ${f.what}`)];
  const last = o.before?.[0];
  if (last) lines.push(`  published ${last.judge_version.slice(0, 10)} found ${last.findings.length}:`, ...last.findings.map((f) => `    severity ${f.severity}: ${f.what}`));
  lines.push(`  session: ${o.dir}`);
  return lines.join("\n");
}

async function tryAgentJudge(root: string, spec: JudgeSpec, version: string, moments: TriedMoment[], options: { proposal?: string; prompt?: boolean; json?: boolean; dir?: string }): Promise<void> {
  const agent = spec.agent!;
  if (options.proposal) fail(`${spec.name} is an agent judge: its session reads no expectations, so a proposal changes nothing it sees. Change its prompt${agent.claude_md ? ` or ${agent.claude_md}` : ""} in this checkout and try that.`);
  const claudeMd = agent.claude_md ? fs.readFileSync(path.join(root, JUDGES_DIR, agent.claude_md), "utf8") : undefined;
  const claims: ReviewClaim[] = moments.map(({ name, record, shown }, i) => ({
    review: `try-${i + 1}-${name.replace(/[^A-Za-z0-9_-]/g, "_")}`,
    moment: name,
    subject: record.subject,
    source: String(shown?.moment.source ?? ""),
    judge: { name: spec.name, version, model: spec.model, root, agent: { ...agent, ...(claudeMd ? { claude_md: claudeMd } : {}) } },
    turns: [agentJudgePrompt(spec.prompt, record, record.who ?? null), AGENT_FINDINGS_TURN],
    deadline: Date.now() + agent.timeout_ms,
  }));
  if (options.prompt) {
    console.log(options.json ? JSON.stringify({ turns: claims[0]!.turns, claude_md: claudeMd ?? null }, null, 2) : `# ${spec.name} ${version}, an agent session on ${spec.model}\n\n## First turn\n${claims[0]!.turns[0]}\n\n## Second turn\n${claims[0]!.turns[1]}`);
    return;
  }
  const under = options.dir ? path.resolve(options.dir) : fs.mkdtempSync(path.join(os.tmpdir(), "judge-try-"));
  fs.mkdirSync(under, { recursive: true });
  const runs = await tryAgentReviews(claims, { root, under, log: (l) => console.error(fmt.muted(l)) });
  const outcomes: AgentTryOutcome[] = runs.map(({ claim, dir, result }, i) => {
    const text = typeof result.findings_text === "string" ? result.findings_text : "";
    const findings = result.ok ? parseAgentFindings(text) : null;
    const shown = moments[i]!.shown;
    return {
      moment: claim.moment,
      ok: !!findings,
      ...(findings ? {} : { error: String(result.error ?? "the findings turn held no findings list") }),
      findings: findings ?? [],
      ...(shown ? { before: (shown.runs ?? []).filter((r: any) => r.judge === spec.name).map((r: any) => ({ judge_version: String(r.judge_version), findings: (r.findings ?? []).map((f: any) => ({ what: String(f.what ?? f.what_happened ?? ""), severity: Number(f.severity) || 0 })) })) } : {}),
      account: String(result.account),
      took_ms: Number(result.took_ms) || 0,
      notional_usd: Number(result.notional_usd) || 0,
      dir,
    };
  });
  if (options.json) console.log(JSON.stringify({ judge: spec.name, version, model: spec.model, outcomes }, null, 2));
  else {
    for (const o of outcomes) console.log(formatAgentTry(o));
    if (outcomes.length > 1) console.log(`\n${outcomes.length} moments, $${outcomes.reduce((s, o) => s + o.notional_usd, 0).toFixed(2)} at list price in all.`);
  }
  if (outcomes.some((o) => !o.ok)) process.exitCode = 1;
}

export function registerJudgingCommands(line: Command, deps: PublishDeps): void {
  line
    .command("judging")
    .description("The pass a session follows to set up or improve a project's judges, written out for the project (learning-loop.md LL4)")
    .option("--project <ref>", "Project: id, short id or title (default: the repo profile's [line] project)")
    .option("--team <name|id|personal>", "Workspace (default: the repo profile's [line] team, else the session's team)")
    .option("--judge <name>", "Start from this one judge, to improve it")
    .action(async (options: { project?: string; team?: string; judge?: string }) => {
      const scope = await scopeFor(deps, options.team, false, lineProjectFor(options.team, options.project));
      const r = await apiPost(deps, "/cli/expectations/brief", scope, { read: true });
      const ref = options.project?.trim() || r.project.title;
      process.stdout.write(renderJudgingSetup({ title: r.project.title, ref: /\s/.test(ref) ? `"${ref}"` : ref }, { judge: options.judge?.trim() || undefined }));
    });

  const judges = line.command("judges").description("Codecast judges in this repository's .codecast/judges (learning-loop.md LL8)");
  registerJudgeFixCommands(judges, deps);
  judges
    .command("try")
    .description("Run a judge on moments exactly as codecast will, on the team's model budget; nothing is filed or kept")
    .argument("<judge>", `A judge name (${JUDGES_DIR}/<name>.md) or its file`)
    .argument("<moments...>", "Moments: the JSON an extractor printed, - for stdin, or a stored moment's mo-N")
    .option("--team <name|id|personal>", "Workspace whose budget pays and whose projects' expectations it reads")
    .option("--extract", "Extract each mo-N afresh with this checkout's extractor instead of reading its kept body")
    .option("--prompt", "Print the exact request for the first moment and send nothing")
    .option("--proposal <xp-N>", "Judge under the expectations as they would read with this open proposal applied")
    .option("--on <backend>", "Where the calls run: api (the team's budget) or subscription (this machine's Claude Code login); default the judge's source's judge_on", judgeBackendOption)
    .option("--dir <dir>", "An agent judge's sessions: where their run directories go (default a new one under the system's temp)")
    .option("--json", "Machine-readable output")
    .addHelpText("after", `
A judge file is a header between two --- lines, then its prompt:

  ---
  moment: conversation          the moment kind it reads (its extractor's file name)
  projects: Agent Quality       the projects whose expectations it grades against
  model: (optional)             default the cheap model
  max_tokens: (optional)        default 2000
  mode: shadow                  shadow records findings and files nothing; live files them
  ---
  What good looks like for this kind of moment, and what a person would feel as a miss.

Codecast adds the clock, each project's active expectations with their ids, the moment
fenced as data, and the answer format; the prompt does not repeat them.

An extractor (.codecast/moments/<kind>.ts) reads the event on stdin and prints one moment:
  {"blocks": [{"type": "message", "direction": "in|out", "channel": "sms", "at": "<iso>",
               "sender": "...", "body": "...", "delivery": "delivered"},
              {"type": "facts", "title": "...", "facts": [{"label": "...", "value": "..."}]},
              {"type": "text", "title": "...", "text": "..."}],
   "refs": [{"label": "thread", "id": "t_81", "table": "threads"}], "at": "<iso>"}
Its opening comment lines may set "// quiet: 10m" and "// timeout: 90s".

An agent judge (runner: agent) runs as the reviewing machines run it: a Claude Code
session in this checkout, on a saved profile with room, with this checkout's prompt,
CLAUDE.md and gateway. Each session runs to its end; nothing is filed. With a mo-N,
the output sets what the published judge found on that moment beside what this one finds.`)
    .action(async (judgeRef: string, momentArgs: string[], options: { team?: string; extract?: boolean; prompt?: boolean; json?: boolean; proposal?: string; on?: JudgeBackend; dir?: string }) => {
      const root = await repoRoot(process.cwd());
      const { spec, file } = readJudge(root, judgeRef);
      const version = (await fileVersion(file)).slice(0, 10);
      // Charged to (and moments read from) the judge's first project's workspace.
      const callScope = await scopeFor(deps, options.team, false, spec.projects[0]);
      // Moments are the workspace's, read without a project.
      const { project: _project, ...momentScope } = callScope;
      const moments: TriedMoment[] = [];
      for (const arg of momentArgs) {
        if (/^mo-\d+$/.test(arg)) {
          const shown = await showMoment(deps, momentScope, arg);
          const record = await momentOn({ root, fresh: !!options.extract }, shown, spec);
          if ("error" in record) fail(`${arg}: ${record.error}`);
          moments.push({ name: arg, record, shown });
          continue;
        }
        const name = arg === "-" ? "stdin" : path.basename(arg);
        let raw: unknown;
        try {
          raw = JSON.parse(readMoment(arg));
        } catch {
          fail(`${name} is not JSON: give the output an extractor printed`);
        }
        const record = momentForTry(raw, spec, name, Date.now());
        if ("error" in record) fail(`${name}: ${record.error}`);
        moments.push({ name, record });
      }
      if (spec.agent) return tryAgentJudge(root, spec, version, moments, options);
      const briefs: ExpectationsBrief[] = [];
      // A proposal belongs to one project: the judge's other projects read their lines as they stand.
      let proposed = false;
      const briefOf = async (scope: Record<string, unknown>) => {
        if (!options.proposal) return apiPost(deps, "/cli/expectations/brief", scope, { read: true });
        try {
          const b = await apiPost(deps, "/cli/expectations/brief", { ...scope, proposal: options.proposal }, { read: true });
          proposed = true;
          return b;
        } catch (err) {
          if (!/not found in/.test(err instanceof Error ? err.message : String(err))) throw err;
          return apiPost(deps, "/cli/expectations/brief", scope, { read: true });
        }
      };
      for (const project of spec.projects) {
        const b = await briefOf(await scopeFor(deps, options.team, false, project));
        briefs.push(narrowBrief({ project: b.project.title, version: b.version, text: b.text, ids: b.ids ?? [] }, spec.parts));
      }
      if (options.proposal && !proposed) fail(`${options.proposal} is not a proposal of ${spec.projects.join(", ")}, the projects ${spec.name} grades against`);
      if (!briefs.some((b) => b.ids.length)) console.error(fmt.warning(`None of ${spec.projects.join(", ")} has active expectations, so every finding will be set aside: propose them first (cast expectations propose).`));
      const ids = briefs.flatMap((b) => b.ids);
      const outcomes: TryOutcome[] = [];
      for (const { name, record: moment } of moments) {
        const request: ModelCallSpec = judgeRequest(spec, briefs, moment, Date.now());
        if (options.prompt) {
          if (options.json) console.log(JSON.stringify(request, null, 2));
          else console.log(`# ${spec.name} ${version} on ${spec.model}, up to ${spec.max_tokens} tokens out\n\n## System\n${request.system}\n\n## Prompt\n${request.prompt}`);
          return;
        }
        options.on ??= await judgeBackendOf(deps, callScope, [spec.name]);
        const result = await judgeCall(options.on, deps, callScope, request, `Judge try ${spec.name}`);
        const outcome: TryOutcome = { moment: name, result };
        if (result.ok) {
          const parsed = parseJudgeReply(result.text, ids);
          if (parsed) Object.assign(outcome, parsed);
          else outcome.unparsed = true;
        }
        outcomes.push(outcome);
        if (!options.json) console.log(formatTry(outcome));
        if (!result.ok && result.reason === "budget") break;
      }
      if (options.json) console.log(JSON.stringify({ judge: spec.name, version, model: spec.model, expectations: briefs.map((b) => ({ project: b.project, version: b.version })), outcomes }, null, 2));
      else if (outcomes.length > 1) console.log(`\n${outcomes.length} moments, $${outcomes.reduce((s, o) => s + o.result.cost_usd, 0).toFixed(4)} in all.`);
    });
}
