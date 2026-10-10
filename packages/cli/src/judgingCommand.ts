// Setting up judging (docs/architecture/learning-loop.md LL4): the pass a
// session follows to give a project judges a person can trust, and the one
// tool it needs that the product's own commands cannot give it, a judge tried
// on a moment exactly as codecast will run it (LL8).
//
//   cast line judging [--project <ref>] [--judge <name>]   the pass, written out for the project
//   cast line judges try <judge> <moment.json|->... [--prompt] [--json]
//
// The pass is judgingSetup.md, principle level, its one home. The web's
// "Set up judging" and "Improve this judge" start a session in the project's
// checkout that runs `cast line judging` and follows it (web lib/line/setupJudging.ts).
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { fmt } from "./colors.js";
import { apiPost, type PublishDeps } from "./castApi.js";
import { lineProjectFor, scopeFor } from "./signalCommand.js";
import { JUDGES_DIR, fileVersion } from "./momentsHost.js";
import { execFileAsync } from "./proc.js";
import { judgeRequest, parseJudgeReply, parseJudgeSpec, type ExpectationsBrief, type JudgeFinding, type JudgeSpec } from "@codecast/shared/contracts/judges";
import { parseExtractorOutput, type MomentRecord } from "@codecast/shared/contracts/moments";
import type { ModelCallResult, ModelCallSpec } from "@codecast/shared/contracts/modelCall";
import setupPass from "./judgingSetup.md" with { type: "text" };

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

async function repoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" } as any);
    return String(stdout).trim();
  } catch {
    return cwd;
  }
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
  if (!fs.existsSync(arg)) fail(`No moment file at ${arg}: give the JSON an extractor printed, or - for stdin`);
  return fs.readFileSync(arg, "utf8");
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
  judges
    .command("try")
    .description("Run a judge on moments exactly as codecast will, on the team's model budget; nothing is filed or kept")
    .argument("<judge>", `A judge name (${JUDGES_DIR}/<name>.md) or its file`)
    .argument("<moments...>", "Moment files: the JSON an extractor printed (blocks, refs, at), or - for stdin")
    .option("--team <name|id|personal>", "Workspace whose budget pays and whose projects' expectations it reads")
    .option("--prompt", "Print the exact request for the first moment and send nothing")
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
Its opening comment lines may set "// quiet: 10m" and "// timeout: 90s".`)
    .action(async (judgeRef: string, momentArgs: string[], options: { team?: string; prompt?: boolean; json?: boolean }) => {
      const root = await repoRoot(process.cwd());
      const { spec, file } = readJudge(root, judgeRef);
      const briefs: ExpectationsBrief[] = [];
      for (const project of spec.projects) {
        const b = await apiPost(deps, "/cli/expectations/brief", await scopeFor(deps, options.team, false, project), { read: true });
        briefs.push({ project: b.project.title, version: b.version, text: b.text, ids: b.ids ?? [] });
      }
      if (!briefs.some((b) => b.ids.length)) console.error(fmt.warning(`None of ${spec.projects.join(", ")} has active expectations, so every finding will be set aside: propose them first (cast expectations propose).`));
      const ids = briefs.flatMap((b) => b.ids);
      const version = (await fileVersion(file)).slice(0, 10);
      const outcomes: TryOutcome[] = [];
      for (const arg of momentArgs) {
        const name = arg === "-" ? "stdin" : path.basename(arg);
        let raw: unknown;
        try {
          raw = JSON.parse(readMoment(arg));
        } catch {
          fail(`${name} is not JSON: give the output an extractor printed`);
        }
        const moment = momentForTry(raw, spec, name, Date.now());
        if ("error" in moment) fail(`${name}: ${moment.error}`);
        const request: ModelCallSpec = judgeRequest(spec, briefs, moment, Date.now());
        if (options.prompt) {
          if (options.json) console.log(JSON.stringify(request, null, 2));
          else console.log(`# ${spec.name} ${version} on ${spec.model}, up to ${spec.max_tokens} tokens out\n\n## System\n${request.system}\n\n## Prompt\n${request.prompt}`);
          return;
        }
        const { siteUrl, apiToken } = deps.getCliEndpoint();
        const scope = await scopeFor(deps, options.team, false);
        let result: ModelCallResult;
        try {
          const resp = await fetch(`${siteUrl}/cli/model/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_token: apiToken, ...scope, ...request, label: `Judge try ${spec.name}` }),
          });
          const body: any = await resp.json();
          result = body && typeof body.ok === "boolean" ? body : { ok: false, reason: "failed", error: body?.error ?? `the server answered ${resp.status}`, cost_usd: 0, model: spec.model };
        } catch (err: any) {
          result = { ok: false, reason: "failed", error: err?.message ?? String(err), cost_usd: 0, model: spec.model };
        }
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
