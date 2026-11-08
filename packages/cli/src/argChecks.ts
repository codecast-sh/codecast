// Argument checks that fail before any network call, shared by the session and
// memory commands (search, feed, sessions, decisions, learn, bookmark, ...).
// Each one turns a value the server would reject with a validator dump, or
// silently ignore, into one line that names the valid values.

import { InvalidArgumentError } from "commander";
import { normalizeWorkStateFilter, WORK_STATE_FILTERS } from "@codecast/shared/contracts";
import { inferEntityTypeFromShortId } from "@codecast/shared/entities";
import { verbTypoNextStep } from "./commandSuggestion.js";

/** Where an agent finds a session id: appended to every "no such session" line. */
export const SESSION_ID_HINT = "Find session ids with `cast sessions` or `cast search <words>`.";

/**
 * Commander parser for a count flag (-n, --limit, -p, --page): a whole number
 * of 1 or more. Commander prints "option '-n, --limit <n>' argument 'abc' is
 * invalid. <this message>" and exits 1.
 */
export function countOption(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n < 1) {
    throw new InvalidArgumentError("Pass a whole number of 1 or more.");
  }
  return n;
}

/** countOption with a ceiling, for a count the server caps (timeline's 1 to 150). */
export function boundedCountOption(max: number): (value: string) => number {
  return (value: string) => {
    const n = countOption(value);
    if (n > max) throw new InvalidArgumentError(`Pass a whole number from 1 to ${max}.`);
    return n;
  };
}

/** Commander parser for a message count that may be 0 (search's -A/-B/-C). */
export function nonNegativeCountOption(value: string): number {
  if (!/^\d+$/.test(value.trim())) throw new InvalidArgumentError("Pass a whole number of 0 or more.");
  return Number(value);
}

/**
 * Commander parser for --state. The server treats a value it does not know as
 * no filter at all, so `--state bogus` used to list every session; here it
 * fails and lists the valid ones. Aliases the server accepts (blocked, parked,
 * running, ...) pass through unchanged; "all" clears the filter.
 */
export function stateOption(value: string): string | undefined {
  // "all" is no filter, as the server and older help documented it.
  if (value.trim().toLowerCase() === "all") return undefined;
  if (normalizeWorkStateFilter(value) === null) {
    throw new InvalidArgumentError(`Use one of: ${WORK_STATE_FILTERS.join(", ")}, or all.`);
  }
  return value;
}

/**
 * Commander parser for an enum flag (--status, --type, --kind, --state):
 * commander prints "option '-s, --status <status>' argument 'bogus' is
 * invalid. Use one of: ..." and exits 1, before any call. Case-insensitive;
 * returns the value lowercased.
 */
export function choiceOption(choices: readonly string[]): (value: string) => string {
  return (value: string) => {
    const v = value.trim().toLowerCase();
    if (!choices.includes(v)) throw new InvalidArgumentError(`Use one of: ${choices.join(", ")}.`);
    return v;
  };
}

/**
 * The error for a verb a positional-dispatch command does not have (`cast
 * stack lss`, `cast teams mapz`). It reads like commander's own refusal for a
 * group (`error: unknown command 'lss'`, the near match, where the list is),
 * so a typo reads the same whichever way the command parses its verb.
 * `verbs` are matched (aliases included); `shown` is the list printed, when it
 * should leave aliases out; `bare` says what the command does with no verb.
 */
export function unknownVerbError(
  path: string,
  typed: string,
  verbs: readonly string[],
  opts: { shown?: readonly string[]; bare?: string } = {},
): string {
  const near = verbTypoNextStep(path.split(" "), verbs, typed);
  const shown = (opts.shown ?? verbs).join(", ");
  return [
    `error: unknown command '${typed}'`,
    ...(near ? [near] : []),
    `Commands: ${shown}${opts.bare ? ` (${opts.bare})` : ""}. Run 'cast ${path} --help' for each.`,
  ].join("\n");
}

/** unknownVerbError for an optional action argument: null when the action is known or absent.
 *  Without it the bad word fell through to the list view and exited 0. */
export function unknownActionError(
  command: string,
  action: string | undefined,
  actions: readonly string[],
  opts: { shown?: readonly string[]; bare?: string } = { bare: "omit it to list" },
): string | null {
  if (action === undefined || actions.includes(action)) return null;
  return unknownVerbError(command, action, actions, opts);
}

/**
 * The one line for an id that names nothing the caller can see, in every
 * area: `No plan pl-9 that you can see. Find it with: cast plan ls --all`.
 * `find` is the read that lists the real ids (a command), or a whole sentence
 * saying where they are (SESSION_ID_HINT). No "Error:" prefix: the line is
 * the error, and every not-found line in the CLI reads the same.
 */
export function notFoundLine(kind: string, id: string, find: string): string {
  return `No ${kind} ${id} that you can see. ${find.startsWith("cast ") ? `Find it with: ${find}` : find}`;
}

/** notFoundLine on stderr, then exit 1. */
export function exitNotFound(kind: string, id: string, find: string): never {
  console.error(notFoundLine(kind, id, find));
  process.exit(1);
}

/** A server's "not found" for a session, with where to find ids. Other errors unchanged. */
export function withSessionIdHint(message: string): string {
  if (/^access denied$/i.test(message.trim())) {
    return `${message.trim()}: that session is private to its owner, or in a team you are not a member of. \`cast teams\` lists yours; the owner can share it`;
  }
  return /not found|no (such )?(session|conversation)/i.test(message) ? `${message}. ${SESSION_ID_HINT}` : message;
}

/** The date forms --start/--end take, for the line that rejects one. */
export const DATE_FORMS = "Use 7d, 2w, 24h, yesterday, or a date like 2026-09-01.";

// Prefixed ids the CLI hands out that are not reference kinds (no pill renders
// them, so they stay out of the shared SHORT_ID_PREFIX registry), and the
// words a person uses for registry kinds whose type name differs.
const CLI_ONLY_ID_KINDS: Record<string, string> = { ds: "stack", mg: "migration batch", eg: "event group", mw: "metric watch" };
const KIND_WORDS: Record<string, string> = { initiative: "goal" };

/** What kind of thing a prefixed short id names (`ct-5` is a task), or null for any other shape. */
export function idKindOf(input: string): string | null {
  const t = input.trim().toLowerCase();
  const registered = inferEntityTypeFromShortId(t);
  if (registered) return KIND_WORDS[registered] ?? registered;
  const prefix = /^([a-z]+)-[a-z0-9]+$/.exec(t)?.[1];
  return prefix ? CLI_ONLY_ID_KINDS[prefix] ?? null : null;
}

/**
 * The refusal for an id of the wrong shape, checked before any call. When the
 * input is another kind's id it says which (`ct-5 is a task, not a trigger`);
 * otherwise that it is not an id of the wanted kind. `find` is the clause that
 * says where real ids come from ("cast trigger ls lists them").
 */
export function wrongKindIdError(input: string, wanted: { kind: string; example: string; find: string }): string {
  const kind = idKindOf(input);
  const head = kind && kind !== wanted.kind ? `${input} is a ${kind}, not a ${wanted.kind}.` : `"${input}" is not a ${wanted.kind} id.`;
  const Kind = wanted.kind[0]!.toUpperCase() + wanted.kind.slice(1);
  return `${head} ${Kind} ids look like ${wanted.example}; ${wanted.find}.`;
}
