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
 * heredoc-friendly. Stdin holds a single body, so only one '-' is allowed —
 * a second one throws for the CLI wrapper to report.
 */
export function expandStdinArgs(args: string[], readStdin: () => string = readStdinRaw): string[] {
  let stdinUsed = false;
  return args.map((arg) => {
    if (arg !== "-") return arg;
    if (stdinUsed) {
      throw new Error("Only one argument can be read from stdin ('-')");
    }
    stdinUsed = true;
    return readStdinBody(readStdin);
  });
}
