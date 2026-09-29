// "Ask this session": the pure half of the web panel. The answer arrives as
// plain text citing `cast read` numbers (msg 12, msg 40–42); the action also
// returns which message row each cited number is, so the client never guesses
// how the web timeline lines up with `cast read` numbering.

import { ConvexError } from "convex/values";
import { citationSpans, spanLines } from "@codecast/convex/convex/lib/sessionAskCitations";

export const ASK_CITE_HREF = "#ask-cite-";

/** Turn every citation the action resolved into a markdown link to its
 *  message (a range links to the first message in it that resolved). A
 *  citation the action could not resolve stays plain text. */
export function linkAskCitations(answer: string, citations: ReadonlyArray<{ line: number; message_id: string }>): string {
  const idByLine = new Map(citations.map((c) => [c.line, c.message_id]));
  let out = "";
  let at = 0;
  for (const span of citationSpans(answer)) {
    const id = spanLines(span).map((l) => idByLine.get(l)).find(Boolean);
    if (!id) continue;
    out += answer.slice(at, span.start) + `[${span.text}](${ASK_CITE_HREF}${id})`;
    at = span.end;
  }
  return out + answer.slice(at);
}

/** The message id a citation link points at, or null for any other link. */
export function askCiteTarget(href: string | undefined): string | null {
  return href?.startsWith(ASK_CITE_HREF) ? href.slice(ASK_CITE_HREF.length) || null : null;
}

/** What the reader sees when an ask fails: the server's coded refusals in the
 *  panel's own words, anything else as a retry. */
export function askErrorMessage(error: unknown): string {
  const data = error instanceof ConvexError ? (error.data as { code?: string; message?: string } | string) : undefined;
  const code = typeof data === "object" ? data?.code : undefined;
  const message = typeof data === "object" ? data?.message : typeof data === "string" ? data : undefined;
  switch (code) {
    case "RATE_LIMITED":
      return message?.replace(/^Too many questions this hour; retry in/, "You have asked a lot this hour. Try again in") ?? "You have asked a lot this hour. Try again later.";
    case "INVALID":
      return message ?? "That question could not be asked.";
    case "NOT_FOUND":
      return "This session could not be found.";
    case "FORBIDDEN":
      return "You do not have access to read this session.";
    case "UNAUTHENTICATED":
      return "Sign in to ask about this session.";
    default:
      return "Could not answer just now. Try again in a moment.";
  }
}
