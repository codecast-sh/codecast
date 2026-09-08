// A batch of review notes, rendered for the agent that will act on them.
//
// A note says where to look and what the reviewer wants; it never quotes the
// code, because the agent reads the file itself and a pasted snippet is stale
// the moment the tree moves. That is the shape Orca's diff notes settled on
// (diff-comments-format.ts): File, then Line / Lines / Scope, then the note.
//
// It lives in shared because two callers render it — Convex builds the message
// a session receives, and `cast review send --dry-run` shows the human exactly
// what will be sent. Two implementations would drift and the preview would
// stop being a preview.

import { FOREIGN_TEXT_CAPS, fenceForeignText, inlineForeignText } from "../contracts/fence";

export type ReviewNoteLike = {
  file_path: string;
  /** Absent or 0 means the note is about the whole file. */
  line_number?: number | null;
  line_end?: number | null;
  content: string;
  /** The diff the note was written against no longer matches the tree. */
  stale?: boolean;
};

/** `Scope: file` | `Line: 42` | `Lines: 10-20`. */
export function reviewNoteLocation(note: ReviewNoteLike): string {
  const start = note.line_number ?? 0;
  if (!start) return "Scope: file";
  const end = note.line_end ?? 0;
  return end && end !== start ? `Lines: ${start}-${end}` : `Line: ${start}`;
}

/**
 * One note. The body is fenced rather than quoted: it reaches the agent as a
 * prompt, so it needs provenance the way any other text written by someone
 * else does, and a note containing "ignore the above" must read as quoted
 * material. `authorName` names the source inside the fence.
 */
export function formatReviewNote(note: ReviewNoteLike, authorName: string): string {
  const lines = [`File: ${inlineForeignText(note.file_path)}`, reviewNoteLocation(note)];
  if (note.stale) {
    lines.push("Stale: the file changed after this note was written — check the note still applies.");
  }
  lines.push(
    fenceForeignText(note.content, `review note by ${authorName}`, {
      maxChars: FOREIGN_TEXT_CAPS.descriptionChars,
    }),
  );
  return lines.join("\n");
}

export type ReviewBatchPromptOptions = {
  actorName: string;
  notes: ReviewNoteLike[];
  /** `owner/repo`, when the notes name one. */
  repository?: string;
  /** The commit the notes were written against. */
  ref?: string;
  /** The batch's page in the web app, when there is one. */
  url?: string | null;
};

/**
 * The whole batch, in the shape a single code comment already arrives in
 * (codeComments.buildCodeCommentPrompt): who wrote it, where to read before
 * answering, then the notes.
 */
export function buildReviewBatchPrompt(opts: ReviewBatchPromptOptions): string {
  const count = opts.notes.length;
  const where = opts.repository
    ? ` on ${inlineForeignText(opts.repository)}${opts.ref ? `@${opts.ref.slice(0, 7)}` : ""}`
    : "";
  const lines: string[] = [
    `${opts.actorName} left ${count} review ${count === 1 ? "note" : "notes"}${where}.`,
    "",
    `Read each spot in the repository${opts.ref ? ` at commit ${opts.ref}` : ""} before answering. ` +
      "Where a note asks for a change, make the change and say what you did.",
    "",
  ];

  // The batch budget is spent by dropping whole notes, never by cutting the
  // rendered string: a cut lands inside a fence and leaves it unclosed, which
  // is exactly the escape the fence exists to prevent.
  const rendered: string[] = [];
  let spent = lines.join("\n").length;
  let dropped = 0;
  for (const note of opts.notes) {
    const block = formatReviewNote(note, opts.actorName);
    if (rendered.length && spent + block.length + 2 > FOREIGN_TEXT_CAPS.blockChars) {
      dropped += 1;
      continue;
    }
    rendered.push(block);
    spent += block.length + 2;
  }
  lines.push(rendered.join("\n\n"));
  if (dropped) {
    lines.push("");
    lines.push(`${dropped} further ${dropped === 1 ? "note is" : "notes are"} not shown here — run \`cast review ls\`.`);
  }

  if (opts.url) {
    lines.push("");
    lines.push(`The notes: ${opts.url}`);
  }
  return lines.join("\n");
}
