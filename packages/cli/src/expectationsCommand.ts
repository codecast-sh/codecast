// `cast expectations`: a project's expectations (docs/architecture/the-line-model.md
// LM5), one living document of how the project should behave, each line with
// the sources it came from. It changes only through proposals.
//
//   cast expectations show [--project <ref>] [--at N] [--brief] [--json]
//   cast expectations propose <file|-> [--project <ref>] [--hold] [--json]
//   cast expectations apply <xp-N>
//   cast expectations drop <xp-N>
//
// Routes: /cli/expectations/{show,brief,propose,resolve} (convex/expectations.ts).
// The shapes, the proposal parser and the renderings are
// shared/contracts/expectations. The project is --project, else the repo
// profile's `[line] project`.
import fs from "node:fs";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { formatAge } from "./decideCommand.js";
import { stdinText } from "./sendBody.js";
import { lineProjectFor, scopeFor } from "./signalCommand.js";
import { parseProposal, renderExpectations, type ExpectationsVersion } from "@codecast/shared/contracts/expectations";

type ShowResult = {
  project: { id: string; title: string };
  current_version: number;
  doc: ExpectationsVersion | null;
  versions: Array<{ version: number; summary: string; how: string; applied_at: number; applied_by: string; active: number }>;
  proposals: Array<{ short_id: string; status: string; summary: string; changes: number; card?: string; refused?: string; created_at: number }>;
  cursor: number | null;
};

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
  out.push(`Version ${r.doc.version} of ${r.current_version}, applied by ${r.doc.applied_by}${r.doc.how === "auto" ? " (applied on its own: additions a person said)" : ""}${r.doc.proposal ? ` from ${r.doc.proposal}` : ""}: ${r.doc.summary}`);
  const open = r.proposals.filter((p) => p.status === "open");
  for (const p of open) {
    out.push(`Open: ${p.short_id} (${p.changes} change${p.changes === 1 ? "" : "s"}, ${formatAge(now - p.created_at)}) ${p.summary}${p.card ? `, card ${p.card}` : ""}${p.refused ? `\n  could not apply: ${p.refused}` : ""}`);
  }
  if (r.cursor) out.push(`Context read up to ${new Date(r.cursor).toISOString()}.`);
  return out.join("\n") + "\n";
}

/** The show result as `--json` prints it: the cursor also as a time, so a reader never converts epoch ms to find where its window starts. */
export const showJson = (r: ShowResult) => ({ ...r, cursor_at: r.cursor ? new Date(r.cursor).toISOString() : null });

export function formatProposeResult(r: { short_id: string; status: string; version: number; auto?: boolean; card?: string; card_error?: string }): string {
  if (r.status === "empty") return `${r.short_id} recorded the window read; nothing to change (version ${r.version}).`;
  if (r.status === "applied") return `${r.short_id} applied as version ${r.version}: it only adds lines a person said, in their quoted words.`;
  if (r.card) return `${r.short_id} waits on the project's person: card ${r.card}. Their answer applies or drops it.`;
  return `${r.short_id} is open against version ${r.version}. A person applies it with: cast expectations apply ${r.short_id}${r.card_error ? `\n(No card was posted: ${r.card_error})` : ""}`;
}

export function registerExpectationsCommand(program: Command, deps: PublishDeps): void {
  const cmd = program.command("expectations").description(commandGroup("expectations").description);
  const scoped = (c: Command) => c
    .option("--project <ref>", "Project: id, short id or title (default: the repo profile's [line] project)")
    .option("--team <name|id|personal>", "Workspace (default: the repo profile's [line] team, else the session's team, else the directory's mapping)");

  scoped(cmd.command("show").description("The project's expectations: every line with its sources, then versions and open proposals"))
    // Not --version: the program's own --version flag takes that word wherever it appears.
    .option("--at <version>", "The document at an earlier version, as a judge graded against it")
    .option("--brief", "What a judge reads: the active lines with ids, no sources")
    .option("--json", "Machine-readable output")
    .action(async (options: { project?: string; team?: string; at?: string; brief?: boolean; json?: boolean }) => {
      const version = options.at !== undefined ? Number(options.at) : undefined;
      if (version !== undefined && !(Number.isInteger(version) && version > 0)) fail("--at takes a version number (1, 2, ...)");
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
that quote says, in words the two share. Anything else waits for the project's person: a card in their queue
when a session proposes it.
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

  for (const action of ["apply", "drop"] as const) {
    cmd.command(action)
      .description(action === "apply" ? "Apply a proposal as the next version (a person's act)" : "Close a proposal without applying it (a person's act)")
      .argument("<proposal>", "The proposal: xp-N")
      .action(async (ref: string) => {
        const r = await apiPost(deps, "/cli/expectations/resolve", { proposal: ref, action, ...(deps.detectCurrentSessionId() ? { conversation_id: deps.detectCurrentSessionId() } : {}) });
        console.log(r.status === "applied" ? `${r.short_id} applied: the expectations are at version ${r.version}.` : `${r.short_id} dropped.`);
      });
  }
}
