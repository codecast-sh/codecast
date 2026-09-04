import * as fs from "fs";
import type { Command } from "commander";

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

/**
 * The one way a command opts a text option or positional into the '-'
 * convention: describe it with `stdinText(...)`. The help then promises it,
 * and `expandCommandStdinDashes` (run once from the program's preAction hook)
 * keeps the promise, so no action handler reads stdin for '-' itself.
 *
 * `many` is for variadics (fork directions, spawn prompts): several '-' split
 * one stdin body on `---` lines, one section per '-'.
 */
const STDIN_DASH_NOTE = "'-' reads it from stdin (heredoc-friendly)";
const STDIN_DASH_MANY_NOTE = "'-' reads it from stdin (several '-' split stdin on lines containing only ---)";

export function stdinText(description: string, opts: { many?: boolean } = {}): string {
  return `${description}; ${opts.many ? STDIN_DASH_MANY_NOTE : STDIN_DASH_NOTE}`;
}

export function takesStdinDash(description: string | undefined): boolean {
  return !!description && (description.includes(STDIN_DASH_NOTE) || description.includes(STDIN_DASH_MANY_NOTE));
}

/**
 * Expand every '-' value of a parsed command whose help carries the stdin
 * note, in one stdin read: positionals first (in declared order), then options
 * (in declared order), so a command mixing both still maps `---` sections
 * predictably. Runs after commander parsed the values and before the action
 * sees them, which is why the action handlers never see a bare '-'.
 */
export function expandCommandStdinDashes(cmd: Command, readStdin: () => string = readStdinRaw): void {
  type Slot = { get: () => unknown; set: (v: unknown) => void };
  const slots: Slot[] = [];
  cmd.registeredArguments.forEach((arg, i) => {
    if (!takesStdinDash(arg.description)) return;
    slots.push({ get: () => cmd.processedArgs[i], set: (v) => { cmd.processedArgs[i] = v; } });
  });
  for (const opt of cmd.options) {
    if (!takesStdinDash(opt.description)) continue;
    const key = opt.attributeName();
    slots.push({ get: () => cmd.getOptionValue(key), set: (v) => cmd.setOptionValue(key, v) });
  }

  // Flatten to one arg list (a variadic contributes each element), expand once, write back.
  const flat: string[] = [];
  const widths: number[] = [];
  for (const slot of slots) {
    const v = slot.get();
    if (Array.isArray(v)) { widths.push(v.length); flat.push(...v); }
    else if (typeof v === "string") { widths.push(-1); flat.push(v); }
    else widths.push(0);
  }
  if (!flat.includes("-")) return;

  const expanded = expandStdinArgs(flat, readStdin);
  let next = 0;
  slots.forEach((slot, k) => {
    const width = widths[k];
    if (width === -1) slot.set(expanded[next++]);
    else if (width > 0) { slot.set(expanded.slice(next, next + width)); next += width; }
  });
}

/**
 * Boundary check for every write body the CLI posts: a top-level string that is
 * exactly "-" is a '-' the parser did not expand, i.e. a text flag that is not
 * described with stdinText(). Nobody means a bare hyphen as a title, body or
 * comment, so failing loudly here beats storing the dash (which is how a task
 * once shipped with "-" as its whole description).
 */
export function rejectBareDash(body: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(body)) {
    if (value === "-") {
      throw new Error(
        `${key} is a bare '-', but that flag does not read stdin. Pass the text inline, or describe the flag with stdinText() so '-' reads the heredoc.`
      );
    }
  }
}
