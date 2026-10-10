// `cast signal`: the one typed door in (docs/architecture/the-line-end-to-end.md
// LE3). A finder, or a person, types what it saw; the server attaches it to
// one cause task by fingerprint, by a small judge call, or as a new cause
// (LE4), and reopens a cause still in watch (LE12).
//
//   cast signal add --source <s> --kind <k> --title <t> [--fingerprint <f>] [--project <ref>] [--detail -] [--url] [--subject] [--goal-hint] [--json]
//   cast signal ls [--task ct-N | --fingerprint <f>] [--project <ref>] [--source <s>] [--json]
//   cast signal show sg-N [--json]
//   cast signal move --fingerprint <f> --from ct-N [--to ct-M | --title <t> --project <ref>] [--json]
//   cast signal merge --issue <A> --into <B> [--json]
//   cast signal split --issue <C> --from <A> --source <s> --kind <k> --title <t> [--move sg-1,sg-2] [--json]
//   cast signal judge-defects <judge-defects.json> [--run <id>] [--json]
//   cast signal diagnosis sg-N --answer missing|misread [--fact] [--why] [--json]
//
// A product that brings findings (learning-loop.md LL3) files each one with
// --issue <its issue's key> instead of --fingerprint: the key is exactly one
// problem, and merge and split follow the product's own issue edits.
//
// Routes: /cli/signal/{add,ls,show} in http.ts (signals.ts). A signal lands in
// a project (line-profile.md LP1): --project, else the repo profile's
// `[line] project`, else none (the workspace). The server resolves the ref
// inside the write workspace, by the rule every --project flag uses.
import type { Command } from "commander";
import { readFileSync } from "fs";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { formatAge } from "./decideCommand.js";
import { loadWorkspaceRoster, resolveWorkspaceForRead, resolveWorkspaceForWrite, workspaceScope } from "./resolveWorkspace.js";
import { stdinText } from "./sendBody.js";
import { LineProfileError, loadLineProfile } from "./lineProfile.js";
import { slugifyHeading } from "@codecast/shared/vault";
import { SIGNAL_KINDS } from "@codecast/shared/contracts/signalFingerprint";
import { DIAGNOSIS_ANSWERS } from "@codecast/shared/contracts/judgeReview";

export { SIGNAL_KINDS };

export interface SignalAddOptions {
  source?: string;
  kind?: string;
  fingerprint?: string;
  title?: string;
  detail?: string;
  url?: string;
  subject?: string;
  goalHint?: string;
  role?: string;
  issue?: string;
  judge?: string;
  judgeVersion?: string;
  severity?: string;
}

export interface SignalRow {
  short_id: string;
  source: string;
  kind: string;
  fingerprint: string;
  title: string;
  detail_md?: string;
  evidence_url?: string;
  subject?: string;
  goal_hint?: string;
  role_handle?: string;
  judge?: string;
  judge_version?: string;
  severity?: number;
  merged_into?: string;
  split_from?: string;
  moment?: string;
  /** A judge's finding marked wrong, and its diagnosis (learning-loop.md LL11). */
  judge_review?: JudgeReviewView;
  /** On a case against a judge: the finding it was made from. */
  case_of?: string;
  observed_at: number;
  created_at: number;
  attach: "fingerprint" | "judge" | "similar" | "new" | "person" | "held";
  reopened: boolean;
  task_short_id?: string;
  task_title?: string;
  task_status?: string;
}

export type JudgeReviewView = {
  trigger: "label" | "dissolve";
  state: "waiting" | "diagnosing" | "diagnosed" | "failed";
  note?: string;
  sentence?: string;
  waiting_on?: string;
  answer?: "missing" | "misread" | "upheld";
  fact?: string;
  why?: string;
  against?: "judge" | "input" | "extractor";
};

const AGAINST_WORDS: Record<NonNullable<JudgeReviewView["against"]>, string> = {
  judge: "the judge's prompt",
  input: "what the product shows the judge",
  extractor: "the moment's extractor",
};

/** One line on where a wrong finding's diagnosis stands. */
export function judgeReviewLine(r: JudgeReviewView): string {
  const how = r.trigger === "label" ? "marked wrong" : "found wrong by a line run";
  if (r.state === "diagnosed" && r.answer === "upheld") return `${how}; the records show the finding holds${r.why ? `: ${r.why}` : ""}`;
  if (r.state === "diagnosed") {
    return `${how}; ${r.answer === "missing" ? "the fact the judge needed was missing from what it saw" : "the judge misread what it saw"}; filed against ${AGAINST_WORDS[r.against ?? "judge"]}${r.fact ? `. Fact: ${r.fact}` : ""}`;
  }
  if (r.state === "diagnosing") return `${how}; being diagnosed`;
  return `${how}; ${r.state === "failed" ? "diagnosis failed" : "waiting to be diagnosed"}${r.waiting_on ? `: ${r.waiting_on}` : ""}`;
}

/** The wire body for `cast signal add`, or the one line that says what is missing.
 *  A finder passes its own fingerprint; a person filing by hand gets one from
 *  the source and title, so the same report filed twice joins one cause. */
export function signalAddBody(options: SignalAddOptions): Record<string, string | number | boolean> {
  if (options.issue?.trim() && options.fingerprint?.trim()) throw new Error("Give --issue or --fingerprint, not both: an issue's key is its fingerprint");
  const missing = (["source", "kind", "title"] as const).filter((k) => !options[k]?.trim());
  if (missing.length) throw new Error(`cast signal add needs ${missing.map((k) => `--${k}`).join(", ")}`);
  const kind = options.kind!.trim().toLowerCase();
  if (!(SIGNAL_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown kind "${options.kind}". Kinds: ${SIGNAL_KINDS.join(", ")}`);
  }
  const body: Record<string, string | number | boolean> = {
    source: options.source!.trim(),
    kind,
    fingerprint: options.issue?.trim() || options.fingerprint?.trim() || `${options.source!.trim()}:${slugifyHeading(options.title!)}`,
    title: options.title!.trim(),
  };
  if (options.issue?.trim()) body.issue = true;
  if (options.judge?.trim()) body.judge = options.judge.trim();
  if (options.judgeVersion?.trim()) body.judge_version = options.judgeVersion.trim();
  if (options.severity?.trim()) {
    const severity = Number(options.severity);
    if (!Number.isFinite(severity)) throw new Error(`--severity takes a number, not "${options.severity}"`);
    body.severity = severity;
  }
  if (options.detail?.trim()) body.detail_md = options.detail.trim();
  if (options.url?.trim()) body.evidence_url = options.url.trim();
  if (options.subject?.trim()) body.subject = options.subject.trim();
  if (options.goalHint?.trim()) body.goal_hint = options.goalHint.trim();
  if (options.role?.trim()) body.role_handle = options.role.trim().replace(/^@/, "");
  return body;
}

const ATTACH_WORDS: Record<SignalRow["attach"], string> = {
  fingerprint: "same fingerprint",
  judge: "judged the same problem",
  similar: "read like this problem's findings",
  new: "new cause",
  person: "attached by a person",
  held: "held: no cause holds its key and no finder opens one",
};

export function formatSignalList(rows: SignalRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No signals. File one: cast signal add --source person --kind bug --title \"...\"";
  return rows
    .map((s) => `${s.short_id}  ${s.source}/${s.kind}  ${s.title}  → ${s.task_short_id ?? "no cause"} (${ATTACH_WORDS[s.attach]}${s.reopened ? ", reopened it" : ""}; ${formatAge(now - s.created_at)})`)
    .join("\n");
}

function fail(message: string): never {
  console.error(fmt.error(message));
  process.exit(1);
}

const cwd = () => process.env.CODECAST_CWD || process.cwd();

/** This checkout's line profile defaults (LP2): the workspace and project its work goes to. */
export function lineDefaults(): { team?: string; project?: string } {
  try {
    const { profile } = loadLineProfile(cwd());
    return { team: profile.team ?? undefined, project: profile.project ?? undefined };
  } catch (err) {
    if (err instanceof LineProfileError) fail(err.message);
    throw err;
  }
}

/** The project a write files under: the one named, else the repo profile's
 *  `[line] project`, but only when the write lands in the profile's own
 *  workspace. A --team naming another workspace (personal, say) gets no
 *  project from the profile, since that project lives in the profile's team. */
export function lineProjectFor(team: string | undefined, project: string | undefined): string | undefined {
  if (project?.trim()) return project;
  const defaults = lineDefaults();
  const norm = (v: string | undefined) => v?.trim().toLowerCase() || undefined;
  if (norm(team) && norm(team) !== norm(defaults.team)) return undefined;
  return defaults.project;
}

/** The named workspace, else the repo profile's `[line] team`, else the
 *  server's own rule (the session's team, the directory). A write naming a
 *  team that is not one of yours stops here. `project` rides along for the
 *  server to resolve inside that workspace. */
export async function scopeFor(deps: PublishDeps, team: string | undefined, write: boolean, project?: string) {
  team ||= lineDefaults().team;
  const base = { project_path: cwd(), conversation_id: deps.detectCurrentSessionId() ?? undefined, ...(project?.trim() ? { project: project.trim() } : {}) };
  if (!team) return base;
  const roster = await loadWorkspaceRoster(async () => await apiPost(deps, "/cli/teams", {}, { read: true }));
  try {
    return { ...base, ...workspaceScope(write ? resolveWorkspaceForWrite(roster, team) : resolveWorkspaceForRead(roster, team)) };
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export function registerSignalCommand(program: Command, deps: PublishDeps): void {
  const signal = program.command("signal").description(commandGroup("signal").description);

  signal
    .command("add")
    .description("File one observation; it attaches to a cause task by fingerprint, by judgment, or as a new cause")
    .option("--source <name>", "The finder: sentry, posthog, evals, agentwatch, insight, lesson, org_health, issue, person, ...")
    .option("--kind <kind>", `What it saw: ${SIGNAL_KINDS.join(", ")}`)
    .option("--fingerprint <key>", "The stable key the finder computes (error group, eval surface+check, cluster id); the dedupe key. Default: <source>:<title slug>")
    .option("--title <text>", "One line, in the finder's words")
    .option("--detail <markdown>", stdinText("The observation"))
    .option("--url <url>", "Where a person can see it")
    .option("--subject <ref>", "The file, surface, prompt id or route it concerns; from a finder that judges behavior, the expectation it breaks (ex-<project>-<n>)")
    .option("--goal-hint <key>", "The initiative metric the finder believes it threatens")
    .option("--role <handle>", "The role whose run introduced what it saw (the fix-loop finder); counted on the health board")
    .option("--issue <key>", "The product's own issue this finding belongs to (instead of --fingerprint): it joins exactly that issue's problem, never another by judgment")
    .option("--judge <name>", "The product's judge that made this finding")
    .option("--judge-version <v>", "That judge's version")
    .option("--severity <n>", "How bad the judge rated it, on the product's scale")
    .option("--project <ref>", "Project to file it in: id, short id or title (default: the repo profile's [line] project, else none)")
    .option("--team <name|id|personal>", "Workspace to file it in (default: the repo profile's [line] team, else the session's team, else the directory's mapping)")
    .option("--json", "Machine-readable output")
    .action(async (options: SignalAddOptions & { team?: string; project?: string; json?: boolean }) => {
      let body: Record<string, string | number | boolean>;
      try {
        body = signalAddBody(options);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      const project = lineProjectFor(options.team, options.project);
      const result = await apiPost(deps, "/cli/signal/add", { ...body, ...(await scopeFor(deps, options.team, true, project)) });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const how = ATTACH_WORDS[result.attach as SignalRow["attach"]] ?? result.attach;
      console.log(result.task_short_id
        ? `${fmt.success(result.short_id)} → ${result.task_short_id} (${how}; ${result.signal_count} signal${result.signal_count === 1 ? "" : "s"})`
        : `${fmt.success(result.short_id)} (${how})`);
      if (result.reopened) console.log(fmt.muted(`  ${result.task_short_id} was in watch and is open again`));
    });

  signal
    .command("ls")
    .alias("list")
    .description("List signals: one cause's, or the newest of the workspace or one project")
    .option("--task <ct>", "Only the signals attached to this cause")
    .option("--fingerprint <key>", "Only the signals filed under this fingerprint in the workspace, however old")
    .option("--project <ref>", "Only this project's signals: id, short id or title")
    .option("--source <name>", "Only signals from this finder")
    .option("-n, --limit <n>", "How many", (v: string) => parseInt(v, 10))
    .option("--team <name|id|personal>", "Workspace to read (default: the active one)")
    .option("--json", "Machine-readable output")
    .action(async (options: { task?: string; fingerprint?: string; project?: string; source?: string; limit?: number; team?: string; json?: boolean }) => {
      const result = await apiPost(deps, "/cli/signal/ls", {
        task: options.task,
        fingerprint: options.fingerprint,
        source: options.source,
        limit: options.limit,
        ...(options.task ? {} : await scopeFor(deps, options.team, false, options.project)),
      }, { read: true });
      const rows: SignalRow[] = result.signals ?? [];
      console.log(options.json ? JSON.stringify(rows, null, 2) : formatSignalList(rows));
    });

  signal
    .command("move")
    .description("Move one fingerprint's signals off a cause: to another cause, or to a new cause of their own")
    .requiredOption("--fingerprint <key>", "The fingerprint whose signals move")
    .requiredOption("--from <ct>", "The cause they are attached to now")
    .option("--to <ct>", "The cause they move to (default: a new cause)")
    .option("--title <text>", "A new cause's title (default: the newest signal's)")
    .option("--project <ref>", "A new cause's project: id, short id or title")
    .option("--team <name|id|personal>", "Workspace (default: the active one)")
    .option("--json", "Machine-readable output")
    .action(async (options: { fingerprint: string; from: string; to?: string; title?: string; project?: string; team?: string; json?: boolean }) => {
      const result = await apiPost(deps, "/cli/signal/move", {
        fingerprint: options.fingerprint,
        from: options.from,
        to: options.to,
        title: options.title,
        ...(await scopeFor(deps, options.team, true, options.project)),
      });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`${fmt.success(String(result.moved))} signal${result.moved === 1 ? "" : "s"} moved ${result.from} → ${result.to}${result.created ? " (new cause)" : ""}`);
    });

  signal
    .command("merge")
    .description("Follow a product's merge of two issues: the merged issue's problem folds into the survivor's, and its key resolves there from now on")
    .requiredOption("--issue <key>", "The issue that was merged away")
    .requiredOption("--into <key>", "The issue it was merged into")
    .option("--team <name|id|personal>", "Workspace (default: the repo profile's [line] team, else the active one)")
    .option("--json", "Machine-readable output")
    .action(async (options: { issue: string; into: string; team?: string; json?: boolean }) => {
      const result = await apiPost(deps, "/cli/signal/merge", { issue: options.issue, into: options.into, ...(await scopeFor(deps, options.team, true)) });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else if (result.already) console.log(fmt.muted(`${result.issue} was already merged into ${result.into}`));
      else console.log(`${fmt.success(result.issue)} → ${result.into}${result.problem ? ` (${result.problem}${result.folded ? `; ${result.folded} folded into it with ${result.moved} signal${result.moved === 1 ? "" : "s"}` : ""})` : " (no problem open yet)"}`);
    });

  signal
    .command("split")
    .description("Follow a product's split of an issue: the new issue opens its own problem, filed with this signal, and takes the signals named")
    .requiredOption("--issue <key>", "The new issue's key")
    .requiredOption("--from <key>", "The issue it was split off")
    .option("--move <signals>", "Signals (sg-N, comma separated) that now belong to the new issue")
    .option("--source <name>", "The finder")
    .option("--kind <kind>", `What it saw: ${SIGNAL_KINDS.join(", ")}`)
    .option("--title <text>", "The new issue's title")
    .option("--detail <markdown>", stdinText("The new issue's description"))
    .option("--url <url>", "Where a person can see it")
    .option("--subject <ref>", "The expectation it breaks, or what it concerns")
    .option("--judge <name>", "The product's judge")
    .option("--judge-version <v>", "That judge's version")
    .option("--severity <n>", "How bad the judge rated it")
    .option("--project <ref>", "Project to file it in: id, short id or title")
    .option("--team <name|id|personal>", "Workspace (default: the repo profile's [line] team, else the active one)")
    .option("--json", "Machine-readable output")
    .action(async (options: SignalAddOptions & { from: string; move?: string; team?: string; project?: string; json?: boolean }) => {
      let body: Record<string, string | number | boolean>;
      try {
        body = signalAddBody({ ...options, fingerprint: undefined });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      const move = (options.move ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const project = lineProjectFor(options.team, options.project);
      const result = await apiPost(deps, "/cli/signal/split", { ...body, from: options.from, ...(move.length ? { move } : {}), ...(await scopeFor(deps, options.team, true, project)) });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`${fmt.success(result.short_id)} → ${result.task_short_id} (split off ${result.split_from}${result.moved ? `; ${result.moved} signal${result.moved === 1 ? "" : "s"} moved` : ""})`);
    });

  signal
    .command("show")
    .description("One signal, with the cause it attached to")
    .argument("<signal>", "sg-N")
    .option("--json", "Machine-readable output")
    .action(async (ref: string, options: { json?: boolean }) => {
      const result = await apiPost(deps, "/cli/signal/show", { signal: ref }, { read: true });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const s: SignalRow = result.signal;
      console.log(formatSignalList([s]));
      console.log(fmt.muted(`  fingerprint ${s.fingerprint}${s.subject ? ` · subject ${s.subject}` : ""}${s.goal_hint ? ` · goal ${s.goal_hint}` : ""}`));
      const judged = [s.judge ? `judge ${s.judge}${s.judge_version ? ` ${s.judge_version}` : ""}` : null, typeof s.severity === "number" ? `severity ${s.severity}` : null, s.merged_into ? `merged into ${s.merged_into}` : null, s.split_from ? `split from ${s.split_from}` : null].filter(Boolean);
      if (judged.length) console.log(fmt.muted(`  ${judged.join(" · ")}`));
      if (s.evidence_url) console.log(fmt.muted(`  ${s.evidence_url}`));
      if (s.moment) console.log(fmt.muted(`  moment ${s.moment}`));
      if (s.judge_review) console.log(fmt.muted(`  ${judgeReviewLine(s.judge_review)}`));
      if (result.cause) console.log(fmt.muted(`  ${s.task_short_id} ${s.task_status}: ${result.cause.signal_count} signals, ${result.cause.fingerprints.length} fingerprints${result.cause.issue_key ? ` · issue ${result.cause.issue_key}${result.cause.merged_keys?.length ? ` (also ${result.cause.merged_keys.join(", ")})` : ""}` : ""}`));
      if (s.detail_md) console.log(`\n${s.detail_md}`);
    });

  // Improving a judge (learning-loop.md LL11): a line run's proof hands over
  // the findings that were the judge's own mistake, and the judge-review
  // graph records what diagnosing one found.
  signal
    .command("judge-defects")
    .description("Mark wrong the judge's findings a line run's proof found were the judge's own mistake; each is diagnosed when its line may")
    .argument("<file>", "The run's judge-defects.json: a list of {judge, finding, sentence, name}")
    .option("--run <id>", "The line run whose proof found them")
    .option("--json", "Machine-readable output")
    .action(async (file: string, options: { run?: string; json?: boolean }) => {
      let defects: unknown;
      try {
        defects = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        fail(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const rows = judgeDefectsBody(defects);
      if (typeof rows === "string") fail(rows);
      const result = await apiPost(deps, "/cli/signal/judge-defects", { defects: rows, ...(options.run?.trim() ? { run_id: options.run.trim() } : {}) });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      for (const r of result as Array<{ finding: string; short_id?: string; state?: string; waiting_on?: string; skipped?: string }>) {
        console.log(r.skipped
          ? fmt.muted(`${r.short_id ?? r.finding}: skipped, ${r.skipped}`)
          : `${fmt.success(r.short_id ?? r.finding)} marked wrong; ${r.state === "diagnosing" ? "diagnosis started" : `waiting${r.waiting_on ? `: ${r.waiting_on}` : ""}`}`);
      }
    });

  signal
    .command("diagnosis")
    .description("Record what diagnosing a wrong finding found, and file it as a case against the part of the judge at fault")
    .argument("<signal>", "The finding, sg-N")
    .requiredOption("--answer <missing|misread|upheld>", "missing: the fact needed to judge correctly was not in what the judge saw; misread: it was, and the judge got it wrong; upheld: the records show the finding was right")
    .option("--fact <text>", "The fact a correct judgment turns on")
    .option("--why <text>", "One or two sentences of evidence")
    .option("--json", "Machine-readable output")
    .action(async (ref: string, options: { answer: string; fact?: string; why?: string; json?: boolean }) => {
      const answer = options.answer.trim().toLowerCase();
      if (!(DIAGNOSIS_ANSWERS as readonly string[]).includes(answer)) fail(`--answer is one of ${DIAGNOSIS_ANSWERS.join(", ")}`);
      const result = await apiPost(deps, "/cli/signal/diagnosis", { signal: ref, answer, ...(options.fact?.trim() ? { fact: options.fact.trim() } : {}), ...(options.why?.trim() ? { why: options.why.trim() } : {}) });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`${fmt.success(ref)} ${judgeReviewLine(result.review)}${result.case_short_id ? ` → ${result.case_short_id}${result.task_short_id ? ` on ${result.task_short_id}` : ""}` : ""}`);
    });
}

/** judge-defects.json as the server takes it, or the one line that says what is wrong with it. */
export function judgeDefectsBody(raw: unknown): Array<{ finding: string; judge?: string; sentence?: string; name?: string }> | string {
  if (!Array.isArray(raw)) return "judge-defects.json is a JSON list of {judge, finding, sentence, name}";
  const out: Array<{ finding: string; judge?: string; sentence?: string; name?: string }> = [];
  for (const d of raw) {
    const finding = typeof d?.finding === "string" ? d.finding.trim() : "";
    if (!finding) return "every entry names its finding";
    const text = (k: string) => (typeof d[k] === "string" && d[k].trim() ? { [k]: d[k].trim() } : {});
    out.push({ finding, ...text("judge"), ...text("sentence"), ...text("name") });
  }
  return out;
}
