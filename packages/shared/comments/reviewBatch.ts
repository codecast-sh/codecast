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

export type ReviewVerdict = "approved" | "changes_requested" | "commented";

export type ReviewBatchPromptOptions = {
  actorName: string;
  notes: ReviewNoteLike[];
  /** `owner/repo`, when the notes name one. */
  repository?: string;
  /** The commit the notes were written against. */
  ref?: string;
  /** The batch's page in the web app, when there is one. */
  url?: string | null;
  /** The pull request the review is on, when it is a review and not a batch of notes. */
  pullRequest?: { number: number; url?: string | null };
  /** The verdict a submitted review carries. Absent for notes handed over without one. */
  verdict?: ReviewVerdict;
  /** The review's summary, as the reviewer wrote it. */
  summary?: string | null;
};

const VERDICT_TEXT: Record<ReviewVerdict, string> = {
  approved: "approved",
  changes_requested: "requested changes on",
  commented: "commented on",
};

/** What the agent is expected to do with a review of each verdict. */
const VERDICT_JOB: Record<ReviewVerdict, string> = {
  approved:
    "The review approves the change. Answer anything the notes ask, and otherwise carry on with the merge as the pull request's own instructions say.",
  changes_requested:
    "The review blocks the merge until these points are met. Make each change, push to the same branch, and reply on GitHub to the notes you addressed (`cast pr comment --reply`) so the threads show the resolution.",
  commented:
    "The review is feedback without a verdict. Act on what asks for a change, answer what asks a question, and say what you did.",
};

/**
 * The whole batch, in the shape a single code comment already arrives in
 * (codeComments.buildCodeCommentPrompt): who wrote it, where to read before
 * answering, then the notes.
 */
export function buildReviewBatchPrompt(opts: ReviewBatchPromptOptions): string {
  const count = opts.notes.length;
  const at = opts.ref ? `@${opts.ref.slice(0, 7)}` : "";
  const where = opts.pullRequest
    ? ` ${inlineForeignText(opts.repository ?? "")}#${opts.pullRequest.number}${at}`
    : opts.repository
      ? ` on ${inlineForeignText(opts.repository)}${at}`
      : "";
  const notesPhrase = `${count} review ${count === 1 ? "note" : "notes"}`;
  const lines: string[] = opts.verdict
    ? [
        `${opts.actorName} ${VERDICT_TEXT[opts.verdict]}${where}` +
          (count ? ` with ${notesPhrase}.` : "."),
        "",
        VERDICT_JOB[opts.verdict],
        "",
      ]
    : [
        `${opts.actorName} left ${notesPhrase}${where}.`,
        "",
        `Read each spot in the repository${opts.ref ? ` at commit ${opts.ref}` : ""} before answering. ` +
          "Where a note asks for a change, make the change and say what you did.",
        "",
      ];
  if (opts.summary?.trim()) {
    lines.push(fenceForeignText(opts.summary.trim(), `review summary by ${opts.actorName}`, {
      maxChars: FOREIGN_TEXT_CAPS.descriptionChars,
    }));
    lines.push("");
  }
  if (opts.verdict && count) {
    lines.push(`Read each spot in the repository${opts.ref ? ` at commit ${opts.ref}` : ""} before answering.`);
    lines.push("");
  }

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

  const link = opts.pullRequest?.url ?? opts.url;
  if (link) {
    lines.push("");
    lines.push(`${opts.verdict ? "The review" : "The notes"}: ${link}`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
