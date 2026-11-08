// `cast expectations`: a project's expectations (docs/architecture/the-line-model.md
// LM5), one living document of how the project should behave, each line with
// the sources it came from. It changes only through proposals.
//
//   cast expectations show [ex-id|xp-N] [--project <ref>] [--at N] [--brief] [--json]
//   cast expectations propose <file|-> [--project <ref>] [--hold] [--json]
//   cast expectations apply <xp-N>
//   cast expectations drop <xp-N>
//   cast expectations routine [--project <ref>]
//
// Routes: /cli/expectations/{show,brief,propose,resolve} (convex/expectations.ts).
// The shapes, the proposal parser and the renderings are
// shared/contracts/expectations. The project is --project, else the repo
// profile's `[line] project`.
import fs from "node:fs";
import type { Command } from "commander";
import { apiPost, isOlderBackendRefusal, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { formatAge } from "./decideCommand.js";
import { stdinText } from "./sendBody.js";
import { lineProjectFor, scopeFor } from "./lineScope.js";
import { citationLine, isExpectationId, parseProposal, renderExpectations, renderProposal, type Expectation, type ExpectationOp, type ExpectationsVersion } from "@codecast/shared/contracts/expectations";
// The line template's proposer routine, the one prompt every pass follows,
// whether its trigger runs it daily or a person asks for one pass.
import routinePrompt from "../org-templates/line/org/prompts/expectations-daily.md" with { type: "text" };

/** The proposer routine's prompt for one project: its name and the ref the commands in it take. */
export function renderRoutine(project: { title: string; ref: string }): string {
  return routinePrompt.replaceAll("{{project.name}}", project.title).replaceAll("{{project.ref}}", project.ref);
}

type ShowResult = {
  project: { id: string; title: string };
  current_version: number;
  doc: ExpectationsVersion | null;
  versions: Array<{ version: number; summary: string; how: string; applied_at: number; applied_by: string; active: number }>;
  proposals: Array<{ short_id: string; status: string; summary: string; changes: number; card?: string; refused?: string; created_at: number }>;
  cursor: number | null;
  /** With an id: the one line it names, or the proposal with its changes. */
  line?: Expectation;
  proposal?: ShowResult["proposals"][number] & { base_version: number; ops?: ExpectationOp[]; applied_version?: number };
};

/** What `show` accepts as its one positional: a line id or a proposal id. */
export function showRefError(ref: string): string | null {
  if (isExpectationId(ref) || /^xp-\d+$/.test(ref)) return null;
  return `"${ref}" is not an expectation id. show takes a line (ex-<project>-<n>) or a proposal (xp-N); with neither it prints the whole document.`;
}

/** One line as show <ex-id> prints it: the line, its sources, where it stands. */
export function formatLine(r: ShowResult & { line: Expectation }): string {
  const e = r.line;
  const out = [`${e.id}: ${e.text}`, `  part: ${e.part}`];
  if (e.note) out.push(`  note: ${e.note}`);
  if (e.since) out.push(`  in force since ${e.since}`);
  out.push(e.status === "retired" ? `  retired in version ${e.changed_in}: ${e.retired_reason ?? ""}` : `  active in version ${r.doc?.version} of ${r.project.title}`);
  for (const c of e.citations) out.push(`  - ${citationLine(c)}`);
  return out.join("\n") + "\n";
}

/** One proposal as show <xp-N> prints it: its state, then each change against the current words. */
export function formatProposal(r: ShowResult & { proposal: NonNullable<ShowResult["proposal"]> }, now: number = Date.now()): string {
  const p = r.proposal;
  const state = p.status === "applied" && p.applied_version ? `applied as version ${p.applied_version}` : p.status;
  const head = `${p.short_id} (${state}, ${p.changes} change${p.changes === 1 ? "" : "s"} against version ${p.base_version} of ${r.project.title}, ${formatAge(now - p.created_at)})${p.card ? `, decision ${p.card}` : ""}`;
  const body = p.ops ? renderProposal({ summary: p.summary, ops: p.ops }, r.doc?.items ?? []) : p.summary;
  return [head, body, ...(p.refused ? [`could not apply: ${p.refused}`] : []), ...(p.status === "open" ? [`Apply: cast expectations apply ${p.short_id}   Close: cast expectations drop ${p.short_id}`] : [])].join("\n") + "\n";
}

/** A server older than the id argument rejects the whole call; narrow its full answer here instead. */
export function narrowLocally(r: ShowResult, ref: string): ShowResult | string {
  if (ref.startsWith("xp-")) {
    const proposal = r.proposals.find((p) => p.short_id === ref);
    return proposal ? { ...r, proposal: { ...proposal, base_version: (proposal as { base_version?: number }).base_version ?? r.current_version } } : `${ref} is not among ${r.project.title}'s ${r.proposals.length} most recent proposals: it belongs to another project (--project), or is older.`;
  }
  const line = r.doc?.items.find((e) => e.id === ref);
  return line ? { ...r, line } : `${r.project.title} has no line ${ref}: it belongs to another project (--project).`;
}

function fail(message: string): never {
  console.error(fmt.error(message));
  process.exit(1);
}

/** The proposal text: a file path, or the body itself ('-' already read from stdin). */
export function readProposalSource(arg: string): string {
  return fs.existsSync(arg) && fs.statSync(arg).isFile() ? fs.readFileSync(arg, "utf8") : arg;
}

/** The show page: the document, then its versions and the proposals still open. */
export function formatShow(r: ShowResult, now: number = Date.now()): string {
  if (!r.doc) {
    return `${r.project.title} has no expectations yet. Propose the first lines: cast expectations propose <file> --project "${r.project.title}"\n`;
  }
  const out = [renderExpectations(r.doc)];
  out.push(`Version ${r.doc.version} of ${r.current_version}, applied by ${r.doc.applied_by}${r.doc.how === "auto" ? " (applied on its own: additions a person said)" : r.doc.how === "stand_in" ? " (a session standing in, in a trial)" : ""}${r.doc.proposal ? ` from ${r.doc.proposal}` : ""}: ${r.doc.summary}`);
  const open = r.proposals.filter((p) => p.status === "open");
  for (const p of open) {
    out.push(`Open: ${p.short_id} (${p.changes} change${p.changes === 1 ? "" : "s"}, ${formatAge(now - p.created_at)}) ${p.summary}${p.card ? `, decision ${p.card}` : ""}${p.refused ? `\n  could not apply: ${p.refused}` : ""}`);
  }
  if (r.cursor) out.push(`Context read up to ${new Date(r.cursor).toISOString()}.`);
  return out.join("\n") + "\n";
}

/** The show result as `--json` prints it: the cursor also as a time, so a reader never converts epoch ms to find where its window starts. */
export const showJson = (r: ShowResult) => ({ ...r, cursor_at: r.cursor ? new Date(r.cursor).toISOString() : null });

export function formatProposeResult(r: { short_id: string; status: string; version: number; auto?: boolean; ask?: boolean }): string {
  if (r.status === "empty") return `${r.short_id} recorded the window read; nothing to change (version ${r.version}).`;
  if (r.status === "applied") return `${r.short_id} applied as version ${r.version}: it only adds lines a person said, in their quoted words.`;
  if (r.ask) return `${r.short_id} is open against version ${r.version} and waits on the project's person. Nobody is asked yet: ask them yourself with cast decide --proposal ${r.short_id}, an answer opening with Apply to land it and one opening with Keep to leave the lines as they are.`;
  return `${r.short_id} is open against version ${r.version}. Apply it with: cast expectations apply ${r.short_id}`;
}

export function registerExpectationsCommand(program: Command, deps: PublishDeps): void {
  const cmd = program.command("expectations").description(commandGroup("expectations").description);
  const scoped = (c: Command) => c
    .option("--project <ref>", "Project: id, short id or title (default: the repo profile's [line] project)")
    .option("--team <name|id|personal>", "Workspace (default: the repo profile's [line] team, else the session's team, else the directory's mapping)");

  scoped(cmd.command("show").alias("proposal").description("The project's expectations: every line with its sources, then versions and open proposals; or one line (ex-id) or proposal (xp-N), whose project the id names"))
    .argument("[id]", "One line (ex-<project>-<n>) or proposal (xp-N); --project is not needed with one")
    // Not --version: the program's own --version flag takes that word wherever it appears.
    .option("--at <version>", "The document at an earlier version, as a judge graded against it")
    .option("--brief", "What a judge reads: the active lines with ids, no sources")
    .option("--json", "Machine-readable output: {project, current_version, doc, versions, proposals, cursor, cursor_at}, plus line or proposal with an id")
    .action(async (ref: string | undefined, options: { project?: string; team?: string; at?: string; brief?: boolean; json?: boolean }, command: Command) => {
      if (command.args.length > 1) fail(`show takes one id; got ${command.args.join(" ")}`);
      const version = options.at !== undefined ? Number(options.at) : undefined;
      if (version !== undefined && !(Number.isInteger(version) && version > 0)) fail("--at takes a version number (1, 2, ...)");
      if (ref) {
        const refError = showRefError(ref.trim());
        if (refError) fail(refError);
        if (options.brief) fail("--brief prints the whole document; drop it to read one line or proposal");
        const id = ref.trim();
        // The id names its own project: only an explicit --project scopes the read, never the profile's default.
        const project = lineProjectFor(options.team, options.project);
        const scope = await scopeFor(deps, options.team, false, options.project);
        const body = { ...scope, id, ...(version !== undefined ? { version } : {}) };
        let r: ShowResult;
        try {
          r = await apiPost(deps, "/cli/expectations/show", body, { read: true, exitOnError: false });
        } catch (err) {
          if (!isOlderBackendRefusal(err)) fail(err instanceof Error ? err.message : String(err));
          if (!project) fail(`This server cannot find ${id}'s project from the id yet. Pass --project <ref>.`);
          const { id: _id, ...whole } = body;
          const narrowed = narrowLocally(await apiPost(deps, "/cli/expectations/show", { ...whole, project }, { read: true }), id);
          if (typeof narrowed === "string") fail(narrowed);
          r = narrowed;
        }
        if (options.json) console.log(JSON.stringify(showJson(r), null, 2));
        else process.stdout.write(r.line ? formatLine(r as ShowResult & { line: Expectation }) : formatProposal(r as ShowResult & { proposal: NonNullable<ShowResult["proposal"]> }));
        return;
      }
      const scope = await scopeFor(deps, options.team, false, lineProjectFor(options.team, options.project));
      const body = { ...scope, ...(version !== undefined ? { version } : {}) };
      if (options.brief) {
        const r = await apiPost(deps, "/cli/expectations/brief", body, { read: true });
        if (options.json) console.log(JSON.stringify(r, null, 2));
        else process.stdout.write(r.text);
        return;
      }
      const r: ShowResult = await apiPost(deps, "/cli/expectations/show", body, { read: true });
      if (options.json) console.log(JSON.stringify(showJson(r), null, 2));
      else process.stdout.write(formatShow(r));
    });

  scoped(cmd.command("propose").description("Propose additions, edits and retirements, each with its sources, from a JSON or markdown file").argument("<file>", stdinText("The proposal file")))
    .option("--hold", "Wait for the project's person even when it only adds lines a person said")
    .option("--json", "Machine-readable output")
    .addHelpText("after", `
Markdown form (JSON is the same fields: {summary, since?, until?, ops: [{op, ...}]}):

  # One line saying what changed and why
  since: 2026-10-04T00:00Z
  until: 2026-10-05T00:00Z

  ## add
  part: Calls and callers
  text: The expected behavior, in one sentence.
  - call cl-96:58 (2026-09-30): "the words that ground it"

  ## edit ex-callers-call-4
  text: The line as it should read now.
  - chat #callers/j17... (2026-10-04): "the words behind the change"

  ## retire ex-callers-call-9
  reason: Why it no longer holds.
  - decision sd-401 (2026-10-04): "the ruling that retired it"

Source kinds: call, chat, session, task, decision, commit, file, doc, desk, call_grade, signal, other.
A proposal that only adds lines applies on its own when each line quotes, with its date, a person's own words
the record holds (a chat line they typed, a decision they answered, or what they said on a call) and says what
that quote says, in words the two share. Anything else waits for the project's person, and the session that
proposed it asks them with its own decision: cast decide --proposal xp-N.
since/until record the window of team context read; the newest until is the next read's start.`)
    .action(async (file: string, options: { project?: string; team?: string; hold?: boolean; json?: boolean }) => {
      let proposal;
      try {
        proposal = parseProposal(readProposalSource(file));
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      const scope = await scopeFor(deps, options.team, true, lineProjectFor(options.team, options.project));
      const r = await apiPost(deps, "/cli/expectations/propose", { ...scope, ...proposal, ...(options.hold ? { hold: true } : {}) });
      if (options.json) console.log(JSON.stringify(r, null, 2));
      else console.log(formatProposeResult(r));
    });

  scoped(cmd.command("routine").description("The pass that reads the team's recent context and proposes changes, written out for the project; a session follows it to run one pass now"))
    .action(async (options: { project?: string; team?: string }) => {
      const scope = await scopeFor(deps, options.team, false, lineProjectFor(options.team, options.project));
      const r = await apiPost(deps, "/cli/expectations/brief", scope, { read: true });
      const ref = options.project?.trim() || r.project.title;
      process.stdout.write(renderRoutine({ title: r.project.title, ref: /\s/.test(ref) ? `"${ref}"` : ref }));
    });

  for (const action of ["apply", "drop"] as const) {
    cmd.command(action)
      .description(action === "apply" ? "Apply a proposal as the next version" : "Close a proposal without applying it")
      .argument("<proposal>", "The proposal: xp-N")
      .action(async (ref: string) => {
        const r = await apiPost(deps, "/cli/expectations/resolve", { proposal: ref, action, ...(deps.detectCurrentSessionId() ? { conversation_id: deps.detectCurrentSessionId() } : {}) });
        console.log(r.status === "applied" ? `${r.short_id} applied: the expectations are at version ${r.version}.` : `${r.short_id} dropped.`);
      });
  }
}
