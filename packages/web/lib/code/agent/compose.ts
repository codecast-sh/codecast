// What the editor hands an agent: a quoted range of a file, as a pending quote
// in the session's composer (Cmd-L), as one message with an instruction
// (Cmd-K), or as the first message of a new session. Plain strings in and out:
// the editor reads the lines, this module words them the way every other quote
// in the app is worded (lib/quoteFormat), so the transcript draws them alike.

import { captureAnchor } from "@codecast/shared/comments";
import { formatQuotedReply, type PendingComment } from "../../quoteFormat";
import { genCommentId } from "../../reviewActions";

/** A range of whole lines of one file. */
export interface CodeRange {
  /** Absolute path on the machine that holds the file. */
  absPath: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** The selected text (whole lines when the selection was empty). */
  code: string;
  /** Fence language ("ts"), empty for plain text. */
  lang: string;
  /** The file's lines around the range, for the comment anchor; `lines[0]`
   *  is line `linesFrom`. */
  context: { linesFrom: number; lines: string[] };
}

/** `path:L12` or `path:L12-20`. */
export function rangeLabel(r: Pick<CodeRange, "absPath" | "startLine" | "endLine">): string {
  return `${r.absPath}:L${r.startLine}${r.endLine > r.startLine ? `-${r.endLine}` : ""}`;
}

/** A fence that no backtick run inside the code can close. */
function fence(code: string): string {
  let longest = 2;
  for (const m of code.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(longest + 1);
}

/** The quote's text: where it is, then the code fenced. */
export function codeQuoteText(r: CodeRange): string {
  const body = r.code.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const f = fence(body);
  return `${rangeLabel(r)}\n${f}${r.lang}\n${body}\n${f}`;
}

/** The pending quote Cmd-L adds to the linked session's composer. */
export function codeQuoteComment(r: CodeRange, now = Date.now()): PendingComment {
  const sparse: (string | undefined)[] = [];
  r.context.lines.forEach((line, i) => (sparse[r.context.linesFrom - 1 + i] = line));
  const anchorLines = captureAnchor(sparse, r.startLine, r.endLine);
  return {
    id: genCommentId(),
    messageId: `file:${r.absPath}`,
    blockIndex: r.startLine,
    quote: codeQuoteText(r),
    body: "",
    createdAt: now,
    filePath: r.absPath,
    fileLine: r.endLine,
    ...(anchorLines ? { anchorLines } : {}),
  };
}

/** The one message Cmd-K sends: the quoted range, then the instruction. */
export function instructionMessage(r: CodeRange, instruction: string): string {
  return formatQuotedReply(codeQuoteText(r), instruction.trim());
}

/** The new-session composer's opening text for agent.newSession. */
export function newSessionText(r: CodeRange): string {
  return `${formatQuotedReply(codeQuoteText(r))}\n\n`;
}

/** The store calls a send makes; the inbox store satisfies it, tests stub it. */
export interface SendPort {
  addOptimisticMessage(convId: string, content: string): string;
  sendMessage(convId: string, content: string, imageIds?: string[], clientId?: string): void;
}

/**
 * Send an instruction about a range to a session through the store's own send
 * path: the bubble shows at once, offline sends queue in the outbox and
 * delivery state renders as for any other message. Returns the client id.
 */
export function sendInstruction(store: SendPort, sessionId: string, r: CodeRange, instruction: string): string | null {
  const text = instructionMessage(r, instruction);
  if (!instruction.trim()) return null;
  const clientId = store.addOptimisticMessage(sessionId, text);
  store.sendMessage(sessionId, text, undefined, clientId);
  return clientId;
}

/** Fence language for a file name, by extension. */
export function fenceLang(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9+#-]{1,12}$/.test(ext) ? ext : "";
}
