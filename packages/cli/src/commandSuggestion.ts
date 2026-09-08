// Typo recovery for `cast <unknown>`. The rule that shapes this: the failure
// path is what agents read, and an agent that mistypes `cast stat` must never
// be handed `cast stop` to run. So a suggestion is only ever a sibling at the
// level the unknown token sits on, and a destructive command (the table in
// destructiveCommands.ts) is offered only when the typed token is a near-miss
// of that very command. ct-49545.

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
  children?: readonly CommandNode[];
};

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[b.length]!;
}

function tokens(node: CommandNode): string[] {
  return [node.name, ...(node.aliases ?? [])];
}

function distanceTo(typed: string, node: CommandNode): number {
  return Math.min(...tokens(node).map((token) => levenshtein(typed, token)));
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
  const prefix: string[] = [];
  let level: readonly CommandNode[] = root;
  let typed: string | undefined;
  for (const operand of operands) {
    const match = level.find((node) => tokens(node).includes(operand));
    if (!match) {
      typed = operand;
      break;
    }
    prefix.push(match.name);
    level = match.children ?? [];
  }
  if (typed === undefined) return [];

  return level
    .filter((node) => !node.hidden)
    .map((node) => ({
      path: [...prefix, node.name].join(" "),
      distance: distanceTo(typed, node),
      limit: isDestructivePath([...prefix, node.name]) ? DESTRUCTIVE_INTENT_DISTANCE : MAX_DISTANCE,
    }))
    .filter((entry) => entry.distance > 0 && entry.distance <= entry.limit)
    .sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.path);
}

/**
 * The one line the unknown-command error adds, or null when nothing is close
 * enough. Plain prose on purpose: it goes to stderr for a human to read and an
 * agent to act on, and it names whole commands so either can run one verbatim.
 */
export function unknownCommandNextStep(
  root: readonly CommandNode[],
  operands: readonly string[],
): string | null {
  const suggestions = suggestCommands(root, operands);
  if (!suggestions.length) return null;
  return `Next step: did you mean ${suggestions.map((path) => `'cast ${path}'`).join(", ")}?`;
}

/** Commander's Command, structurally — enough to walk the registered tree. */
type CommanderLike = {
  name(): string;
  aliases?(): string[];
  commands?: readonly CommanderLike[];
  _hidden?: boolean;
};

/** The registered command tree, as the suggester wants it. */
export function commandTree(parent: CommanderLike): CommandNode[] {
  return (parent.commands ?? []).map((cmd) => ({
    name: cmd.name(),
    aliases: cmd.aliases?.() ?? [],
    hidden: cmd._hidden === true,
    children: commandTree(cmd),
  }));
}
