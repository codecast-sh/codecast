// Typo recovery for `cast <unknown>`. The rule that shapes this: the failure
// path is what agents read, and an agent that mistypes `cast stat` must never
// be handed `cast stop` to run. So a suggestion is only ever a sibling at the
// level the unknown token sits on, and a destructive command (the table in
// destructiveCommands.ts) is offered only when the typed token is a near-miss
// of that very command. ct-49545.

import { levenshtein } from "@codecast/shared/contracts/levenshtein";
import { isDestructivePath } from "./destructiveCommands.js";

/** How far a typo may sit from a command before it stops being a typo of it. */
const MAX_DISTANCE = 3;

/** At most this many, so the line stays one line. */
const MAX_SUGGESTIONS = 3;

// How close a typo must sit to a destructive command before that command may be
// suggested at all. One edit off (`destory` → `destroy`) still reads as reaching
// for it; two does not. This is what keeps a benign typo from ever recovering
// into something irreversible, and it is measured against the command being
// offered — reaching for one destructive verb never unlocks its siblings.
const DESTRUCTIVE_INTENT_DISTANCE = 1;

/** A command as the suggester needs it: name, aliases, children. */
export type CommandNode = {
  name: string;
  aliases?: readonly string[];
  hidden?: boolean;
  description?: string;
  children?: readonly CommandNode[];
};

function tokens(node: CommandNode): string[] {
  return [node.name, ...(node.aliases ?? [])];
}

/** Edit distance where swapping two neighbouring letters is one edit, the
 *  commonest typo (`statsu` for `status`), not two. */
function typoDistance(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return levenshtein(a, b);
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/** A name a typo may be reaching for. A bare string is its own key and token. */
export type NearCandidate = string | {
  /** What comes back when it matches (a command path, an event name). */
  key: string;
  /** The words compared with what was typed (a name and its aliases). */
  tokens: readonly string[];
  /** A tighter reach for this one: a destructive command is offered only one edit off. */
  maxDistance?: number;
  /** Refuse the prefix shortcut (`sess` for `sessions`): destructive commands need a near-miss of the whole name. */
  noPrefix?: boolean;
};

/**
 * The candidates close enough to `typed` to be what it meant, nearest first.
 * The one ranking every "did you mean" in the CLI uses: a letter swap is one
 * edit, three or more letters that begin a name count as one edit, a word
 * reaches half its length in edits (at least one, at most three, so `foo` is
 * not offered `doc`, `flow` and `fork`), and only the nearest and next nearest
 * come back (`teamz` gets `teams`, not also `blame` and `learn` three edits
 * away), at most three. Case-insensitive.
 */
export function nearMatches(typed: string, candidates: readonly NearCandidate[]): string[] {
  const word = typed.toLowerCase();
  if (!word) return [];
  const reach = Math.min(MAX_DISTANCE, Math.max(1, Math.floor(word.length / 2)));
  const close = candidates
    .map((candidate) => {
      const { key, tokens: words, maxDistance, noPrefix } = typeof candidate === "string"
        ? { key: candidate, tokens: [candidate], maxDistance: undefined, noPrefix: false }
        : candidate;
      const distance = Math.min(...words.map((token) => {
        const t = token.toLowerCase();
        return !noPrefix && word.length >= 3 && t.startsWith(word) ? 1 : typoDistance(word, t);
      }));
      return { key, distance, limit: Math.min(reach, maxDistance ?? reach) };
    })
    .filter((entry) => entry.distance > 0 && entry.distance <= entry.limit)
    .sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key));
  const nearest = close[0]?.distance ?? 0;
  return close
    .filter((entry) => entry.distance <= nearest + 1)
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.key);
}

/**
 * The one "did you mean" line, or null for no matches. Pass the matches as
 * they should be typed: quoted whole commands (`'cast guide browser'`), or
 * bare names where the match is not a command (an event name, a config key).
 */
export function didYouMean(matches: readonly string[]): string | null {
  return matches.length ? `Next step: did you mean ${matches.join(", ")}?` : null;
}

/**
 * Sibling commands close enough to what was typed, as full command paths.
 *
 * Operands are walked as far as they resolve, so an unknown token nested under
 * a real group is compared against that group's children — never against the
 * top level, which would suggest unrelated commands.
 */
export function suggestCommands(
  root: readonly CommandNode[],
  operands: readonly string[],
): string[] {
  const { prefix, level, typed } = unresolved(root, operands);
  if (typed === undefined) return [];
  return nearMatches(typed, level
    .filter((node) => !node.hidden)
    .map((node) => {
      const destructive = isDestructivePath([...prefix, node.name]);
      return {
        key: [...prefix, node.name].join(" "),
        // A two-letter alias (`in` for goal) is too short to be a typo of
        // anything: `unin` is two edits from it and was offered `cast goal`.
        tokens: [node.name, ...(node.aliases ?? []).filter((alias) => alias.length > 2)],
        ...(destructive ? { maxDistance: DESTRUCTIVE_INTENT_DISTANCE, noPrefix: true } : {}),
      };
    }));
}

/**
 * The one line the unknown-command error adds, or null when nothing is close
 * enough. Plain prose on purpose: it goes to stderr for a human to read and an
 * agent to act on, and it names whole commands so either can run one verbatim.
 */
/**
 * Commands agents reach for under another name, keyed by the words typed, and
 * where each lives. The typo ranking knows only spelling, so `cast whoami`
 * got nothing and `cast deploys` was offered `cast replay`.
 */
const COMMAND_INTENTS: Record<string, string> = {
  whoami: "'cast auth status' (this machine's sign-in), 'cast teams members' (the people you work with)",
  "daemon status": "'cast status' (daemon, connection and sync)",
  deploys: "'cast ship mark --surface <name>' (record a deploy)",
  conflicts: "'cast similar --file <path>' (sessions that touched the same file)",
  "doc comments": "'cast doc show <id> -c' (read a doc's comments; 'cast doc comment <id> \"…\"' adds one)",
  "task comments": "'cast task show <id> --only comments' (-c for all of them; 'cast task comment' adds one)",
};

/** The intent line for what was typed, matching its first one or two words. */
export function commandIntentNextStep(operands: readonly string[]): string | null {
  const two = operands.slice(0, 2).join(" ");
  const where = COMMAND_INTENTS[two] ?? COMMAND_INTENTS[operands[0] ?? ""];
  return where ? `Next step: ${where}` : null;
}

export function unknownCommandNextStep(
  root: readonly CommandNode[],
  operands: readonly string[],
): string | null {
  const intent = commandIntentNextStep(operands);
  if (intent) return intent;
  const suggestions = suggestCommands(root, operands);
  const mentions = commandsMentioning(root, operands);
  const mentioned = mentions.paths.filter((path) => !suggestions.includes(path));
  const lines = [
    ...(suggestions.length ? [didYouMean(suggestions.map((path) => `'cast ${path}'`))!] : []),
    // `hooks` is one edit from `hosts`, and still the agent wanted the setting.
    ...(mentioned.length ? [`${suggestions.length ? "Or" : "Next step"}: these commands mention '${mentions.typed}': ${mentioned.map((path) => `'cast ${path}'`).join(", ")}`] : []),
  ];
  return lines.length ? lines.join("\n") : null;
}

/** At most this many commands named by what their description mentions. */
const MAX_MENTIONS = 4;

/**
 * When no command name is near the typed word, the siblings whose description
 * mentions it as a word: an agent guessing `cast hooks` or `cast watchers` is
 * looking for a thing, and the commands that manage it say so. Destructive
 * commands are never offered this way.
 */
export function commandsMentioning(
  root: readonly CommandNode[],
  operands: readonly string[],
): { typed: string; paths: string[] } {
  const { prefix, level, typed } = unresolved(root, operands);
  if (typed === undefined || typed.length < 4 || !/^[a-z][a-z-]*$/i.test(typed)) return { typed: typed ?? "", paths: [] };
  const word = new RegExp(`\\b${typed}s?\\b`, "i");
  const paths = level
    .filter((node) => !node.hidden && node.description && word.test(node.description))
    .filter((node) => !isDestructivePath([...prefix, node.name]))
    .slice(0, MAX_MENTIONS)
    .map((node) => [...prefix, node.name].join(" "));
  return { typed, paths };
}

/** Walk the operands as far as they name commands: the path walked, the
 *  level the first unknown word sits on, and that word. */
function unresolved(root: readonly CommandNode[], operands: readonly string[]) {
  const prefix: string[] = [];
  let level: readonly CommandNode[] = root;
  for (const operand of operands) {
    const match = level.find((node) => tokens(node).includes(operand));
    if (!match) return { prefix, level, typed: operand as string | undefined };
    prefix.push(match.name);
    level = match.children ?? [];
  }
  return { prefix, level, typed: undefined as string | undefined };
}

/**
 * The same next step for a command that takes its verb as a positional
 * (`cast decide shwo`, `cast stack lss`): `verbs` are its subcommands, `path`
 * the command words before them. Null when the typed word is near none.
 */
export function verbTypoNextStep(path: readonly string[], verbs: readonly string[], typed: string): string | null {
  let root: CommandNode[] = verbs.map((name) => ({ name }));
  for (const word of [...path].reverse()) root = [{ name: word, children: root }];
  return unknownCommandNextStep(root, [...path, typed]);
}

/** Commander's Command, structurally — enough to walk the registered tree. */
type CommanderLike = {
  name(): string;
  aliases?(): string[];
  description?(): string;
  commands?: readonly CommanderLike[];
  _hidden?: boolean;
};

/** The registered command tree, as the suggester wants it. */
export function commandTree(parent: CommanderLike): CommandNode[] {
  return (parent.commands ?? []).map((cmd) => ({
    name: cmd.name(),
    aliases: cmd.aliases?.() ?? [],
    hidden: cmd._hidden === true,
    ...(cmd.description ? { description: cmd.description() } : {}),
    children: commandTree(cmd),
  }));
}

// The one line a command gets in its parent's command list (`cast --help`,
// `cast accounts --help`). A command's description is often several
// paragraphs, with its own examples and subcommand tables, written for the
// command's own --help. Printed whole in a list, commander re-wraps those
// hard-broken lines into the description column and the root help ran past
// a thousand lines, so a list shows only the lead: the first paragraph, cut
// to its first sentence when it runs on. The full text stays on the
// command's own --help.

/** Longest lead kept whole; a longer first paragraph is cut to its first sentence. */
const MAX_LEAD = 110;

export function listDescription(description: string): string {
  const firstParagraph = description.trim().split(/\n\s*\n/)[0] ?? "";
  // A lead that introduces a list ("three independent axes:") ends on the colon.
  const lead = firstParagraph.split("\n").map((line) => line.trim()).filter(Boolean).join(" ").replace(/:$/, "");
  if (lead.length <= MAX_LEAD) return lead;
  // A sentence ends at . ! or ? followed by a space and a capital or a
  // backtick, so "e.g. jx7c6zk" and "v1.2" never cut a lead short.
  const sentence = lead.match(/^(.+?[.!?])\s+(?=[A-Z`(])/);
  return sentence ? sentence[1]! : lead;
}
