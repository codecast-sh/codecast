import * as fs from "fs";

/**
 * Stdin supplied to `cast send <session> -` has one newline added by the
 * transport (for example, the newline immediately before a heredoc delimiter).
 * Remove only that one newline. Any earlier newline is message content.
 */
export function removeStdinTransportNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

export function prepareSessionSendBody(text: string, fromStdin: boolean): string {
  return fromStdin ? removeStdinTransportNewline(text) : text;
}

function readStdinRaw(): string {
  return fs.readFileSync(0, "utf-8");
}

/** The stdin body for a '-' argument, with the one transport newline stripped. */
export function readStdinBody(readStdin: () => string = readStdinRaw): string {
  return prepareSessionSendBody(readStdin(), true);
}

/**
 * The one convention for text-taking commands (send, spawn, fork, trigger add,
 * comments, doc content): a '-' argument reads that body from stdin,
 * heredoc-friendly.
 *
 * Multiple '-' arguments split the one stdin body into sections on lines that
 * contain only `---`, one section per '-' in order. This is what lets a whole
 * fork/spawn fan-out of multi-line briefs travel in ONE invocation. A single
 * '-' never splits — a lone `---` line there is content (e.g. a markdown
 * rule), not a separator.
 */
export function expandStdinArgs(args: string[], readStdin: () => string = readStdinRaw): string[] {
  const dashCount = args.filter((a) => a === "-").length;
  if (dashCount === 0) return args;

  const body = readStdinBody(readStdin);
  let sections: string[];
  if (dashCount === 1) {
    sections = [body];
  } else {
    sections = body.split(/\r?\n---\r?\n/);
    if (sections.length !== dashCount) {
      throw new Error(
        `${dashCount} '-' arguments need ${dashCount} stdin sections separated by lines containing only "---", but stdin has ${sections.length}`
      );
    }
  }

  let next = 0;
  return args.map((arg) => (arg === "-" ? sections[next++] : arg));
}
