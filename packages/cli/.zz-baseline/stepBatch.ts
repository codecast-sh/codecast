/**
 * Several steps in one invocation, shared by `cast browser do` and
 * `cast computer do`.
 *
 * Both exist for the same reason: the work behind one step is tens of
 * milliseconds and starting the `cast` process is one to three seconds, so a
 * six step flow spent almost all its time loading the CLI six times. The parts
 * that do not depend on what a step drives live here: reading the plan,
 * splitting a step into arguments, the stop at the first failure, and the
 * report. Each caller supplies only how to run one step.
 *
 * A batch stops at the first failing step by default. Later steps almost always
 * depend on earlier ones, and carrying on buries the real error under the
 * failures it caused.
 */

import { fmt, icons } from "./colors.js";

export interface StepResult {
  step: string;
  ok: boolean;
  /** What happened, in the same voice as the single command. */
  output: string;
  /** Set when the step failed. */
  error?: string;
}

/**
 * Split a step into arguments, honouring quotes so a typed string may contain
 * spaces: `type #e7 "hello world" --submit`.
 */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && line[i + 1] === quote) cur += line[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** The steps as given, or one per line from stdin when the only step is `-`
 *  (the same convention as `cast send -`). */
export async function readStepPlan(steps: string[]): Promise<string[]> {
  if (steps.length !== 1 || steps[0] !== "-") return steps;
  const stdin = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
  });
  return stdin.split("\n").map((l) => l.trim()).filter(Boolean);
}

export interface RunStepsOptions {
  keepGoing?: boolean;
  /**
   * Runs after a step succeeds, as a courtesy to the next one (a settle, an
   * audit). A note it returns is appended to that step's output. It never
   * fails the step: the step already worked, and recording it twice, once as
   * a success and once as a failure, would abort a batch that did its job.
   */
  afterStep?: (args: string[]) => Promise<string | null | void>;
}

/** Run every step in order, stopping at the first failure unless told not to.
 *  Blank lines and `#` comments are skipped. */
export async function runSteps(
  steps: string[],
  runOne: (args: string[], raw: string) => Promise<string>,
  opts: RunStepsOptions = {},
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    const args = tokenize(step);
    if (!args.length || args[0].startsWith("#")) continue;
    try {
      const output = await runOne(args, step);
      results.push({ step, ok: true, output });
      const note = await opts.afterStep?.(args).catch(() => null);
      if (note) results[results.length - 1].output += `\n! ${note}`;
    } catch (err) {
      results.push({ step, ok: false, output: "", error: err instanceof Error ? err.message : String(err) });
      if (!opts.keepGoing) break;
    }
  }
  return results;
}

/** One line per step with its output indented under it, then the tally.
 *  Returns the number of failed steps. */
export function printStepResults(results: StepResult[], planLength: number, startedAt: number): number {
  for (const r of results) {
    console.log(`${r.ok ? fmt.success(icons.check) : fmt.error(icons.cross)} ${fmt.highlight(r.step)}`);
    const body = r.ok ? r.output : (r.error ?? "");
    if (body) console.log(body.split("\n").map((l) => `    ${l}`).join("\n"));
  }
  const failed = results.filter((r) => !r.ok).length;
  const skipped = planLength - results.length;
  console.log(
    fmt.muted(
      `\n${results.length - failed}/${planLength} steps in ${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
        (skipped ? ` — ${skipped} not attempted after the failure` : ""),
    ),
  );
  return failed;
}
