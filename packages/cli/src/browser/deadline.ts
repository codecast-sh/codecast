/**
 * One wall-clock budget for a whole `cast browser` verb.
 *
 * A verb is a chain of waits, each with its own reasonable limit: the bridge
 * host coming up, the extension reconnecting, a tab created (45 s), an engine
 * run (120 s), one retry after a stall. Stacked, a verb could sit for minutes,
 * so agents wrapped every browser call in `timeout` and read exit 124 with no
 * idea what had been stuck. The budget caps the chain: when it is spent the
 * verb says which stage it was in and what to run, and exits 124 as `timeout`
 * would.
 *
 * Synchronous engine runs block the event loop, so a timer alone cannot cut
 * them short: runEngine caps each run's own timeout at `remainingMs()`, and
 * the timer fires the moment the run returns.
 */

import { fmt, icons } from "../colors.js";

export const DEADLINE_ENV = "CAST_BROWSER_DEADLINE";
export const DEFAULT_DEADLINE_S = 90;
/** The exit status of a verb whose budget ran out, the same as `timeout(1)`. */
export const DEADLINE_EXIT = 124;

/** Verbs that wait on purpose (a person, a condition, a recording) or install
 *  something: their own flags bound them. */
export const NO_DEADLINE = new Set(["login", "handoff", "subscribe", "wait", "record", "trace", "flight", "start", "raw", "bridge-host", "reap"]);

let timer: ReturnType<typeof setTimeout> | null = null;
let expire: (() => void) | null = null;
let deadlineAt: number | null = null;
let stage = "starting";
let armedVerb = "";

/** The budget in seconds: `--deadline`, else the environment, else the
 *  default. 0 turns it off. Null for an unreadable value. */
export function deadlineSeconds(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = flag ?? env[DEADLINE_ENV];
  if (raw === undefined || raw === "") return DEFAULT_DEADLINE_S;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Name what the verb is waiting on now, for the message if the budget runs out. */
export function setStage(label: string): void {
  stage = label;
}

/** Milliseconds left in the budget, or undefined when none is armed. */
export function remainingMs(now = Date.now()): number | undefined {
  return deadlineAt === null ? undefined : Math.max(0, deadlineAt - now);
}

/** What to run next, given the stage the verb was stuck in. */
export function deadlineHint(stuck: string, seconds: number): string {
  const longer = `allow longer with --deadline ${Math.max(seconds * 2, 120)}`;
  if (/extension|bridge|Chrome's/i.test(stuck)) return `\`cast browser extension status\` says whether the Chrome extension is connected; or ${longer}`;
  if (/^opening .*navigate, load/.test(stuck)) return `the page never finished loading: check that its server answers, or ${longer}`;
  return `the machine may be overloaded: run it again, or ${longer}`;
}

/**
 * Start (or restart) the budget for `verb`. A `do` flow re-arms it per step,
 * so a long flow is bounded step by step rather than as a whole.
 */
export function armVerbDeadline(verb: string, seconds: number, write: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): void {
  disarmVerbDeadline();
  armedVerb = verb;
  if (seconds <= 0 || NO_DEADLINE.has(verb)) return;
  deadlineAt = Date.now() + seconds * 1000;
  stage = "starting";
  expire = () => {
    write(`${fmt.error(icons.cross)} cast browser ${armedVerb} gave up after ${seconds}s while ${stage}`);
    write(`  ${fmt.muted(deadlineHint(stage, seconds))}`);
    process.exit(DEADLINE_EXIT);
  };
  timer = setTimeout(expire, seconds * 1000);
  // Never the reason the process stays up: a verb that finished exits.
  timer.unref?.();
}

/** End the verb now if its budget is spent. Called after a synchronous run
 *  that the budget cut short, before its failure is read as the verb's own. */
export function expireIfSpent(now = Date.now()): void {
  if (deadlineAt === null || now < deadlineAt || !expire) return;
  const fire = expire;
  disarmVerbDeadline();
  fire();
}

/** Stop the budget (tests, and verbs that hand over to a long wait). */
export function disarmVerbDeadline(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  expire = null;
  deadlineAt = null;
}
