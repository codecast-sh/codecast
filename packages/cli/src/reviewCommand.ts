// `cast review` — review notes on files and lines, batched, then handed to an
// agent in one message.
//
// The gesture it replaces: reading a diff, spotting five things, and typing
// five separate messages to a session that is already working. A note is
// cheap to write and goes nowhere until you send the batch, so reading and
// dispatching stop competing.
//
// A note is a review_comments row (packages/convex/convex/reviewNotes.ts), so
// the web diff view shows the same notes this command lists. The batch is
// scoped to the worktree: two worktrees of one repository hold different
// diffs, so they hold different batches.

import { execFileSync } from "child_process";
import path from "path";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./publish.js";
import { readLocalGitContext } from "./prCommand.js";
import { buildReviewBatchPrompt, reviewNoteLocation } from "@codecast/shared/comments";

export type ReviewNoteRow = {
  _id: string;
  file_path?: string;
  line_number?: number;
  line_end?: number;
  content: string;
  diff_identity?: string;
  sent_at?: number;
  created_at: number;
};

// ── Pure pieces ──────────────────────────────────────────────────────────────

export type ReviewTarget = {
  filePath: string;
  /** Absent means the note is about the whole file. */
  lineNumber?: number;
  lineEnd?: number;
};

/**
 * `path:42` · `path:10-20` · `path:file` · `path`.
 *
 * Split on the LAST colon so a path that contains one still parses, and treat
 * a suffix that is neither a line, a range nor the word `file` as part of the
 * path rather than guessing.
 */
export function parseReviewTarget(input: string): ReviewTarget {
  const colon = input.lastIndexOf(":");
  if (colon <= 0) return { filePath: input };
  const head = input.slice(0, colon);
  const suffix = input.slice(colon + 1);
  if (suffix === "file" || suffix === "") return { filePath: head };
  const single = /^(\d+)$/.exec(suffix);
  if (single) return { filePath: head, lineNumber: Number(single[1]) };
  const range = /^(\d+)-(\d+)$/.exec(suffix);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return { filePath: head, lineNumber: Math.min(start, end), lineEnd: Math.max(start, end) };
  }
  return { filePath: input };
}

/**
 * Is this note still about the file the reviewer read?
 *
 * A note with no stamp (one written before the field existed, or on a path git
 * cannot hash) is never called stale: an unprovable claim of staleness would
 * train the reader to ignore the flag.
 */
export function isStale(stored: string | undefined, current: string | undefined): boolean {
  return !!stored && !!current && stored !== current;
}

/** `1`-based position in the listing, a full id, or an unambiguous id prefix. */
export function resolveNoteRef(notes: ReviewNoteRow[], ref: string): ReviewNoteRow {
  const index = /^\d+$/.test(ref) ? Number(ref) : 0;
  if (index >= 1 && index <= notes.length) return notes[index - 1];
  const matches = notes.filter((n) => n._id === ref || n._id.startsWith(ref));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`${ref} matches ${matches.length} notes — use the number from cast review ls`);
  throw new Error(`No review note matches ${ref}`);
}

/** The listing: one line of place per note, the note's own lines under it. */
export function formatReviewList(notes: ReviewNoteRow[], staleIds: ReadonlySet<string> = new Set()): string {
  if (notes.length === 0) return "No review notes in this worktree.";
  const out: string[] = [];
  notes.forEach((note, i) => {
    const flags = [
      staleIds.has(note._id) ? "stale" : "",
      note.sent_at ? "sent" : "",
    ].filter(Boolean);
    out.push(
      `${String(i + 1).padStart(2)}. ${note.file_path ?? "?"} · ${reviewNoteLocation(note as any)}` +
        (flags.length ? `  [${flags.join(", ")}]` : ""),
    );
    for (const line of note.content.split("\n")) out.push(`    ${line}`);
  });
  return out.join("\n");
}

// ── Git ──────────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function repoRootOf(cwd: string): string | null {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

/**
 * The stamp a note carries: the content hash of the file as the reviewer read
 * it. That is the modified side of the diff, so the stamp moves exactly when
 * the lines a note points at could have moved — and, unlike hashing the diff
 * text, committing the very same content does not fake a change.
 */
export function fileDiffIdentity(repoRoot: string, relPath: string): string | undefined {
  const blob = git(["hash-object", "--", relPath], repoRoot);
  return blob ? `blob:${blob.slice(0, 12)}` : undefined;
}

/** The path as the repository names it: relative to the root, posix separators. */
export function repoRelativePath(repoRoot: string, cwd: string, input: string): string {
  const abs = path.resolve(cwd, input);
  const rel = path.relative(repoRoot, abs);
  return rel.split(path.sep).join("/");
}

// ── The command ──────────────────────────────────────────────────────────────

function realCwd(): string {
  return process.env.CODECAST_CWD ?? process.cwd();
}

function requireRepoRoot(cwd: string): string {
  const root = repoRootOf(cwd);
  if (!root) {
    console.error("cast review works inside a git checkout — no repository here.");
    process.exit(1);
  }
  return root;
}

async function loadBatch(
  deps: PublishDeps,
  repoRoot: string,
  includeSent: boolean,
): Promise<ReviewNoteRow[]> {
  const rows = await apiPost(deps, "/cli/review/list", { git_root: repoRoot, include_sent: includeSent }, { read: true });
  return Array.isArray(rows) ? rows : [];
}

/** Which of these notes no longer match the file on disk. */
export function staleIdsOf(repoRoot: string, notes: ReviewNoteRow[]): Set<string> {
  const current = new Map<string, string | undefined>();
  const stale = new Set<string>();
  for (const note of notes) {
    if (!note.file_path) continue;
    if (!current.has(note.file_path)) current.set(note.file_path, fileDiffIdentity(repoRoot, note.file_path));
    if (isStale(note.diff_identity, current.get(note.file_path))) stale.add(note._id);
  }
  return stale;
}

export function registerReviewCommand(program: Command, deps: PublishDeps): void {
  const review = program
    .command("review")
    .description("Collect review notes on files and lines, then hand the batch to a session")
    .addHelpText("after", `
  cast review add src/api.ts:42 "this leaks on the error path"
  cast review add src/api.ts:10-20 "extract this"
  cast review add src/api.ts:file "the whole module needs a test"
  cast review ls                       the batch, with stale notes flagged
  cast review send jx7abcd             deliver the batch to a session
  cast review send --dry-run           print exactly what would be sent
  cast review rm 2                     drop a note by its number in ls

Notes live with the repository's other comments, so the web diff view shows the
same ones. The batch belongs to this worktree; sending stamps the notes sent,
and editing one puts it back in the batch.
`);

  review
    .command("add")
    .description("Write a note on a file, a line, or a range")
    .argument("<target>", "<path>:<line> | <path>:<start>-<end> | <path>:file | <path>")
    .argument("<note>", "what you want done there")
    .option("--json", "as JSON")
    .action(async (target: string, note: string, options: { json?: boolean }) => {
      const cwd = realCwd();
      const repoRoot = requireRepoRoot(cwd);
      const parsed = parseReviewTarget(target);
      const filePath = repoRelativePath(repoRoot, cwd, parsed.filePath);
      const noteRow = {
        file_path: filePath,
        line_number: parsed.lineNumber,
        line_end: parsed.lineEnd,
        content: note,
      };
      const gitContext = readLocalGitContext(repoRoot);
      const result = await apiPost(deps, "/cli/review/add", {
        git_root: repoRoot,
        repository: gitContext.repository ?? undefined,
        ref: git(["rev-parse", "HEAD"], repoRoot) ?? undefined,
        ...noteRow,
        diff_identity: fileDiffIdentity(repoRoot, filePath),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`ok note on ${filePath} · ${reviewNoteLocation(noteRow)}`);
    });

  review
    .command("ls")
    .description("The batch for this worktree")
    .option("--all", "include notes already sent")
    .option("--json", "as JSON")
    .action(async (options: { all?: boolean; json?: boolean }) => {
      const repoRoot = requireRepoRoot(realCwd());
      const notes = await loadBatch(deps, repoRoot, !!options.all);
      const stale = staleIdsOf(repoRoot, notes);
      if (options.json) {
        console.log(JSON.stringify(notes.map((n) => ({ ...n, stale: stale.has(n._id) })), null, 2));
        return;
      }
      console.log(formatReviewList(notes, stale));
    });

  review
    .command("send")
    .description("Hand the batch to a session, in one message")
    .argument("[session]", "session short id, uuid or conversation id (default: this session)")
    .option("--dry-run", "print the message instead of sending it")
    .option("--json", "as JSON")
    .action(async (session: string | undefined, options: { dryRun?: boolean; json?: boolean }) => {
      const repoRoot = requireRepoRoot(realCwd());
      const notes = await loadBatch(deps, repoRoot, false);
      if (notes.length === 0) {
        console.error("No unsent review notes in this worktree.");
        process.exit(1);
      }
      const stale = staleIdsOf(repoRoot, notes);

      if (options.dryRun) {
        // Built from the same shared formatter the server uses, so the preview
        // is the message and not an approximation of it.
        console.log(buildReviewBatchPrompt({
          actorName: "You",
          notes: notes.map((n) => ({
            file_path: n.file_path ?? "",
            line_number: n.line_number,
            line_end: n.line_end,
            content: n.content,
            stale: stale.has(n._id),
          })),
        }));
        return;
      }

      const target = session ?? deps.detectCurrentSessionId();
      if (!target) {
        console.error("Name the session to send to: cast review send <session>");
        process.exit(1);
      }
      const result = await apiPost(deps, "/cli/review/send", {
        git_root: repoRoot,
        conversation_ref: target,
        stale_ids: [...stale],
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`ok sent ${result.sent} ${result.sent === 1 ? "note" : "notes"} to ${target}`);
    });

  review
    .command("edit")
    .description("Rewrite a note; an edited note goes back in the batch")
    .argument("<ref>", "the number from cast review ls, or the note id")
    .argument("<note>", "the new text")
    .action(async (ref: string, note: string) => {
      const repoRoot = requireRepoRoot(realCwd());
      const target = resolveNoteRef(await loadBatch(deps, repoRoot, true), ref);
      await apiPost(deps, "/cli/review/edit", { comment_id: target._id, content: note });
      console.log(`ok note on ${target.file_path ?? "?"} rewritten`);
    });

  review
    .command("rm")
    .description("Drop notes from the batch")
    .argument("<refs...>", "numbers from cast review ls, or note ids")
    .action(async (refs: string[]) => {
      const repoRoot = requireRepoRoot(realCwd());
      const notes = await loadBatch(deps, repoRoot, true);
      // Resolve every reference against ONE listing before deleting any of
      // them: deleting as we go would renumber the notes the later arguments
      // name, and `cast review rm 1 2` would drop the wrong second note.
      const targets = refs.map((ref) => resolveNoteRef(notes, ref));
      for (const target of targets) {
        await apiPost(deps, "/cli/review/rm", { comment_id: target._id });
      }
      console.log(`ok dropped ${targets.length} ${targets.length === 1 ? "note" : "notes"}`);
    });
}
