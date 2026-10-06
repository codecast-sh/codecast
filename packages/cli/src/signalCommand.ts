// `cast signal`: the one typed door in (docs/architecture/the-line-end-to-end.md
// LE3). A finder, or a person, types what it saw; the server attaches it to
// one cause task by fingerprint, by a small judge call, or as a new cause
// (LE4), and reopens a cause still in watch (LE12).
//
//   cast signal add --source <s> --kind <k> --title <t> [--fingerprint <f>] [--project <ref>] [--detail -] [--url] [--subject] [--goal-hint] [--json]
//   cast signal ls [--task ct-N] [--project <ref>] [--source <s>] [--json]
//   cast signal show sg-N [--json]
//
// Routes: /cli/signal/{add,ls,show} in http.ts (signals.ts). A signal lands in
// a project (line-profile.md LP1): --project, else the repo profile's
// `[line] project`, else none (the workspace). The server resolves the ref
// inside the write workspace, by the rule every --project flag uses.
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { formatAge } from "./decideCommand.js";
import { loadWorkspaceRoster, resolveWorkspaceForRead, resolveWorkspaceForWrite, workspaceScope } from "./resolveWorkspace.js";
import { stdinText } from "./sendBody.js";
import { LineProfileError, loadLineProfile } from "./lineProfile.js";
import { slugifyHeading } from "@codecast/shared/vault";
import { SIGNAL_KINDS } from "@codecast/shared/contracts/signalFingerprint";

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
  observed_at: number;
  created_at: number;
  attach: "fingerprint" | "judge" | "new" | "person";
  reopened: boolean;
  task_short_id?: string;
  task_title?: string;
  task_status?: string;
}

/** The wire body for `cast signal add`, or the one line that says what is missing.
 *  A finder passes its own fingerprint; a person filing by hand gets one from
 *  the source and title, so the same report filed twice joins one cause. */
export function signalAddBody(options: SignalAddOptions): Record<string, string> {
  const missing = (["source", "kind", "title"] as const).filter((k) => !options[k]?.trim());
  if (missing.length) throw new Error(`cast signal add needs ${missing.map((k) => `--${k}`).join(", ")}`);
  const kind = options.kind!.trim().toLowerCase();
  if (!(SIGNAL_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown kind "${options.kind}". Kinds: ${SIGNAL_KINDS.join(", ")}`);
  }
  const body: Record<string, string> = {
    source: options.source!.trim(),
    kind,
    fingerprint: options.fingerprint?.trim() || `${options.source!.trim()}:${slugifyHeading(options.title!)}`,
    title: options.title!.trim(),
  };
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
  new: "new cause",
  person: "attached by a person",
};

export function formatSignalList(rows: SignalRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No signals. File one: cast signal add --source person --kind bug --title \"...\"";
  return rows
    .map((s) => `${s.short_id}  ${s.source}/${s.kind}  ${s.title}  → ${s.task_short_id ?? "?"} (${ATTACH_WORDS[s.attach]}${s.reopened ? ", reopened it" : ""}; ${formatAge(now - s.created_at)})`)
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
    .option("--project <ref>", "Project to file it in: id, short id or title (default: the repo profile's [line] project, else none)")
    .option("--team <name|id|personal>", "Workspace to file it in (default: the repo profile's [line] team, else the session's team, else the directory's mapping)")
    .option("--json", "Machine-readable output")
    .action(async (options: SignalAddOptions & { team?: string; project?: string; json?: boolean }) => {
      let body: Record<string, string>;
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
      console.log(`${fmt.success(result.short_id)} → ${result.task_short_id} (${how}; ${result.signal_count} signal${result.signal_count === 1 ? "" : "s"})`);
      if (result.reopened) console.log(fmt.muted(`  ${result.task_short_id} was in watch and is open again`));
    });

  signal
    .command("ls")
    .alias("list")
    .description("List signals: one cause's, or the newest of the workspace or one project")
    .option("--task <ct>", "Only the signals attached to this cause")
    .option("--project <ref>", "Only this project's signals: id, short id or title")
    .option("--source <name>", "Only signals from this finder")
    .option("-n, --limit <n>", "How many", (v: string) => parseInt(v, 10))
    .option("--team <name|id|personal>", "Workspace to read (default: the active one)")
    .option("--json", "Machine-readable output")
    .action(async (options: { task?: string; project?: string; source?: string; limit?: number; team?: string; json?: boolean }) => {
      const result = await apiPost(deps, "/cli/signal/ls", {
        task: options.task,
        source: options.source,
        limit: options.limit,
        ...(options.task ? {} : await scopeFor(deps, options.team, false, options.project)),
      }, { read: true });
      const rows: SignalRow[] = result.signals ?? [];
      console.log(options.json ? JSON.stringify(rows, null, 2) : formatSignalList(rows));
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
      if (s.evidence_url) console.log(fmt.muted(`  ${s.evidence_url}`));
      if (result.cause) console.log(fmt.muted(`  ${s.task_short_id} ${s.task_status}: ${result.cause.signal_count} signals, ${result.cause.fingerprints.length} fingerprints`));
      if (s.detail_md) console.log(`\n${s.detail_md}`);
    });
}
