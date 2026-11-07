// A command an agent asks a person to run (`cast decide --run`): a decision
// whose card shows the exact `cast` command, answered Run or Don't run. A
// person's Run executes it on the session's machine, outside the session, so
// it is the person's act; the output comes back to the asking session as the
// answer. Shared by the CLI (parse on ask), the server (validate, settle,
// deliver), the daemon (run) and the apps (render, gate the Run press).

import { approvesSecretRead } from "./secrets";
import { shellArg, shellWords } from "./shellWords";

export const RUN_OPTION = "Run";
export const SKIP_OPTION = "Don't run";
export const RUN_OPTIONS: ReadonlyArray<{ label: string }> = [{ label: RUN_OPTION }, { label: SKIP_OPTION }];

/** waiting: on the card. queued: approved, sent to the machine. running: the machine took it. done/failed: it exited (failed = nonzero, or it could not start). skipped: a person chose Don't run, or the card closed unanswered. */
export type CommandRunState = "waiting" | "queued" | "running" | "done" | "failed" | "skipped";

export interface CommandRun {
  /** The words after `cast`, exactly as the machine runs them. */
  argv: string[];
  state: CommandRunState;
  /** The machine that runs it: the asking session's. */
  device_id?: string;
  /** Where it runs: the asking session's project folder, so workspace and repo resolve as they would for the agent. */
  cwd?: string;
  exit_code?: number;
  /** Combined stdout and stderr, the tail when long (MAX_RUN_OUTPUT). */
  output?: string;
  /** When the state last moved. */
  at?: number;
}

const MAX_ARGS = 64;
const MAX_CHARS = 8000;
export const MAX_RUN_OUTPUT = 6000;
/** How long the machine lets a run go before it stops it. */
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** The words of `line` as a run's argv, or why it cannot be one. Takes the line an agent would have pasted for the person (`cast …`, `! cast …`). */
export function parseRunCommand(line: string): { argv: string[] } | { error: string } {
  const words = shellWords(line.trim());
  while (words[0] === "!") words.shift();
  if (words[0] === "cast" || words[0] === "codecast") words.shift();
  if (!words.length) return { error: "--run needs the cast command to run, like \"cast role authority @ads --grant '[...]'\"" };
  if (words.some((w) => w === "|" || w === ";" || w === "&" || /^\d*[<>]/.test(w))) return { error: "--run is one cast command: no pipes, chains or redirects" };
  if (words.includes("-")) return { error: "--run has no stdin: write the value inline instead of '-'" };
  if (words[0] === "decide") return { error: "--run cannot ask for another cast decide" };
  if (words.length > MAX_ARGS || words.join(" ").length > MAX_CHARS) return { error: `--run is at most ${MAX_ARGS} words and ${MAX_CHARS} characters` };
  return { argv: words };
}

/** The command as the card shows it and a person would type it. */
export function commandLine(argv: readonly string[]): string {
  return ["cast", ...argv.map(shellArg)].join(" ");
}

/** Whether option `index` of `decision` runs its command. */
export function approvesCommandRun(decision: { run?: unknown; options: readonly { label: string }[] }, index: number): boolean {
  return !!decision.run && decision.options[index]?.label === RUN_OPTION;
}

/** Whether pressing option `index` is an act only the person may take: it approves an Ask first read or runs a command. Such a press confirms with Touch ID, and stays held in a tab an agent drives. */
export function approvesPersonsAct(decision: { category?: string; run?: unknown; options: readonly { label: string }[] }, index: number): boolean {
  return approvesSecretRead(decision, index) || approvesCommandRun(decision, index);
}

/** The tail of a run's output, at most MAX_RUN_OUTPUT characters. */
export function clipRunOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= MAX_RUN_OUTPUT ? trimmed : `…${trimmed.slice(-MAX_RUN_OUTPUT)}`;
}

/** What the asking session reads after its answer's tag once the run ends: the command, its exit, and its output. */
export function runResultText(run: { argv: readonly string[]; exit_code?: number; output?: string; state: CommandRunState }): string {
  const head = run.state === "done" ? `Ran \`${commandLine(run.argv)}\`: exit 0.` : `Ran \`${commandLine(run.argv)}\`: it failed${run.exit_code !== undefined ? ` (exit ${run.exit_code})` : ""}.`;
  const out = run.output?.trim();
  return out ? `${head}\n\n\`\`\`\n${out}\n\`\`\`` : head;
}
