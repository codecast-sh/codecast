/**
 * `cast computer do`: several steps against one app in one process.
 *
 * Every separate `cast computer` command pays the CLI's startup and a helper
 * handshake, which dwarfs the accessibility work behind it; the Preview session
 * this was built from spent about fifty commands on one signature. A batch
 * keeps one client open, and each step runs through the same `execute` as the
 * single command, so a batched click and `cast computer click` are one code
 * path with one set of errors.
 *
 * Steps read the way the human sees the window. The shortcuts:
 *
 *   click "Sign"                 click by name (or #56, or --x/--y)
 *   click "Sign" --mouse         a real mouse click at its center
 *   action "insert signature" "Created January 27"
 *                                a Secondary Action, then the element
 *   set "Search" "invoice"       write a value
 *   type "hello"  paste "…"      text into the focused element
 *   press Return  hotkey cmd+s   keys
 *   scroll down "Messages"       scroll, optionally an element
 *   drag 472,655 233,135         press, move, release (names, #index or x,y)
 *   find "Created"               print matches; a bare click next acts on it
 *   wait "Created"               until it appears (--gone, --change, --timeout)
 *   snapshot                     the tree (takes --find, --under)
 *   shot                         a screenshot for the conversation
 *   sleep 500                    milliseconds
 *
 * Any step also takes the single command's flags (`--element-index 12`,
 * `--nth 2`, `--window-id 7`), and the batch's `--app` and window selector are
 * the default for each step.
 */

import { ComputerError } from "./errors.js";
import {
  createComputerClient,
  execute,
  validateVerb,
  type ComputerOptions,
  type ComputerRunDeps,
  type ComputerSink,
  type ComputerVerb,
} from "./run.js";
import { printStepResults, readStepPlan, runSteps, type StepResult } from "../stepBatch.js";
import { inlineImageMarker } from "../inlineImage.js";
import { asComputerError } from "./errors.js";

const ALIASES: Record<string, ComputerVerb> = {
  snapshot: "get-app-state",
  state: "get-app-state",
  "get-app-state": "get-app-state",
  find: "find",
  wait: "wait",
  click: "click",
  action: "perform-secondary-action",
  "perform-secondary-action": "perform-secondary-action",
  set: "set-value",
  "set-value": "set-value",
  type: "type-text",
  "type-text": "type-text",
  paste: "paste-text",
  "paste-text": "paste-text",
  press: "press-key",
  "press-key": "press-key",
  hotkey: "hotkey",
  scroll: "scroll",
  drag: "drag",
  "list-windows": "list-windows",
};

/** Flags that take a value; every other `--flag` is a switch. */
const VALUE_FLAGS = new Set([
  "app", "window-id", "window-index", "element-index", "element", "nth", "x", "y", "click-count",
  "mouse-button", "modifiers", "action", "direction", "pages", "text", "key", "value", "find", "under", "timeout",
  "to-x", "to-y", "to-element", "to-element-index",
]);

const camel = (flag: string) => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function invalid(message: string): ComputerError {
  return new ComputerError("invalid_argument", message);
}

/** A step's `--flags` as the options commander would have produced, and its positionals. */
export function parseStepFlags(args: string[]): { options: ComputerOptions; positional: string[] } {
  const options: Record<string, unknown> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name.startsWith("no-")) {
      options[camel(name.slice(3))] = false;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const value = args[++i];
      if (value === undefined) throw invalid(`--${name} needs a value`);
      options[camel(name)] = value;
      continue;
    }
    options[camel(name)] = true;
  }
  return { options: options as ComputerOptions, positional };
}

/** A positional target: `#56`/`56` or a name, as `--element`. */
function target(o: ComputerOptions, value: string | undefined): void {
  if (value !== undefined) o.element = value;
}

export interface ComputerBatchContext {
  /** The batch's `--app` and window selector, the default for every step. */
  defaults: ComputerOptions;
  /** The query of the last `find`, which a bare `click` or `action` acts on. */
  lastFound?: string;
}

/** A step to the verb and options the single command would have run. */
export function planStep(ctx: ComputerBatchContext, args: string[]): { verb: ComputerVerb | "shot" | "sleep"; options: ComputerOptions } {
  const [word, ...rest] = args;
  const { options: flags, positional } = parseStepFlags(rest);
  const o: ComputerOptions = { ...ctx.defaults, ...flags };
  if (word === "sleep") {
    const ms = Number(positional[0]);
    if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) throw invalid("sleep takes milliseconds, 0 to 60000");
    return { verb: "sleep", options: { ...o, timeout: String(ms) } };
  }
  if (word === "shot" || word === "screenshot") return { verb: "shot", options: { ...o, screenshot: true } };
  const verb = ALIASES[word];
  if (!verb) throw invalid(`unknown step '${word}'. Steps: ${[...Object.keys(ALIASES).filter((k) => !k.includes("-")), "shot", "sleep"].join(", ")}`);
  const [first, second] = positional;
  switch (verb) {
    case "get-app-state":
      // A snapshot inside a batch is for reading; `shot` is for pictures.
      if (o.screenshot === undefined) o.screenshot = false;
      break;
    case "find":
      o.find ??= first;
      if (!o.find) throw invalid("find needs the text to look for");
      ctx.lastFound = o.find;
      break;
    case "wait":
      o.text ??= first;
      break;
    case "click":
      target(o, first);
      break;
    case "perform-secondary-action":
      o.action ??= first;
      target(o, second);
      break;
    case "set-value":
      target(o, first);
      o.value ??= second;
      break;
    case "scroll":
      o.direction ??= first;
      target(o, second);
      break;
    case "drag":
      // Each end is a name, #index, or x,y in window points.
      for (const [end, value] of [["from", first], ["to", second]] as const) {
        if (value === undefined) continue;
        const point = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value);
        if (end === "from") {
          if (point) [o.x, o.y] = [point[1], point[2]];
          else target(o, value);
        } else if (point) [o.toX, o.toY] = [point[1], point[2]];
        else o.toElement = value;
      }
      break;
    case "type-text":
    case "paste-text":
      o.text ??= first;
      break;
    case "press-key":
    case "hotkey":
      o.key ??= first;
      break;
  }
  const actsOnElement = verb === "click" || verb === "perform-secondary-action";
  if (actsOnElement && o.element === undefined && o.elementIndex === undefined && o.x === undefined && ctx.lastFound) {
    o.element = ctx.lastFound;
  }
  return { verb, options: o };
}

/** Run a batch and report each step. Returns the results for the caller's tally. */
export async function runComputerBatch(
  plan: string[],
  defaults: ComputerOptions,
  deps: ComputerRunDeps,
  opts: { keepGoing?: boolean } = {},
): Promise<{ results: StepResult[]; images: string[] }> {
  const ctx: ComputerBatchContext = { defaults };
  const images: string[] = [];
  const client = await createComputerClient(deps);
  try {
    const results = await runSteps(
      plan,
      (args) =>
        runStep(args).catch((err: unknown) => {
          // A step failure reads like the single command's: message, then its recovery.
          const error = asComputerError(err);
          throw new Error([error.message, ...error.toJSON().recovery].join("\n"));
        }),
      { keepGoing: opts.keepGoing },
    );
    return { results, images };
  } finally {
    client.shutdown();
  }

  async function runStep(args: string[]): Promise<string> {
    const { verb, options } = planStep(ctx, args);
    if (verb === "sleep") {
      await new Promise((r) => setTimeout(r, Number(options.timeout)));
      return `slept ${options.timeout}ms`;
    }
    const lines: string[] = [];
    const sink: ComputerSink = { log: (l) => lines.push(l), image: (abs) => images.push(abs), quietShots: true };
    if (verb === "shot") {
      const shotOptions = { ...options, screenshot: true };
      validateVerb("get-app-state", shotOptions, deps);
      const before = images.length;
      // The tree is not printed for a shot; the picture is the point.
      await execute("get-app-state", shotOptions, client, deps, { ...sink, log: () => {} });
      return images.length > before ? "screenshot below" : "no screenshot captured (Screen Recording may be missing)";
    }
    validateVerb(verb, options, deps);
    await execute(verb, options, client, deps, sink);
    return lines.join("\n");
  }
}

/** `cast computer do`: read the plan, run it, print each step, set the exit code. */
export async function runComputerDo(
  steps: string[],
  o: ComputerOptions & { keepGoing?: boolean },
  deps: ComputerRunDeps = {},
): Promise<void> {
  const plan = await readStepPlan(steps);
  if (!plan.length) {
    console.error('✗ no steps given. Try: cast computer do --app com.apple.Preview "click Sign" "wait Created"');
    return (deps.exit ?? process.exit)(1) as never;
  }
  const started = Date.now();
  const defaults: ComputerOptions = { app: o.app, windowId: o.windowId, windowIndex: o.windowIndex };
  try {
    const { results, images } = await runComputerBatch(plan, defaults, deps, { keepGoing: o.keepGoing });
    const failed = printStepResults(results, plan.length, started);
    for (const abs of images) console.log(inlineImageMarker(abs));
    if (failed) process.exitCode = 1;
  } catch (err) {
    const error = asComputerError(err);
    console.error(`✗ ${error.message}`);
    for (const line of error.toJSON().recovery) console.error(`  ${line}`);
    return (deps.exit ?? process.exit)(1) as never;
  }
}
