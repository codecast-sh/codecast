import { existsSync, readFileSync } from 'node:fs';

import { Command, CommanderError, Option } from 'commander';

import { expandCommandStdinDashes } from '../../../../cli/src/sendBody';

// The real CLI's own command tree (`cast agent-context --json`), the one the
// dry-run guard already reads: every command path, alias, positional and
// flag. The fake parses each argv with a commander program built from it, so
// what the CLI refuses before reaching the server (an unknown option, a
// missing argument) is refused here in commander's own words, and a handler
// receives options and arguments exactly as the CLI's action would, a '-'
// already read from stdin by the CLI's own expansion (sendBody.ts), which
// keys on the stdin note in each description the tree carries.

export interface TreeFlag {
  flags: string;
  description?: string;
  long?: string;
  type: 'value' | 'boolean' | 'optional-value';
  default?: unknown;
  variadic?: boolean;
  negated?: boolean;
  global?: boolean;
}

export interface TreeCommand {
  path: string[];
  aliases?: string[];
  args?: Array<{ name: string; required: boolean; variadic: boolean; description?: string }>;
  flags: TreeFlag[];
  subcommands?: unknown[];
  runsBare?: boolean;
}

export interface Tree {
  version?: string;
  commands: TreeCommand[];
}

export function readTree(path: string): Tree | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Tree) : null;
}

/** The deepest command the argv's leading words name (aliases count), and the words after them. */
export function resolveCommand(tree: Tree, argv: string[]): { node: TreeCommand; rest: string[] } | null {
  let node: TreeCommand | null = null;
  let depth = 0;
  for (;;) {
    const word = argv[depth];
    if (word === undefined || word.startsWith('-')) break;
    const prefix = argv.slice(0, depth);
    const hit = tree.commands.find((c) => c.path.length === depth + 1 && c.path.slice(0, depth).every((w, i) => w === prefix[i]) && (c.path[depth] === word || c.aliases?.includes(word)));
    if (!hit) break;
    node = hit;
    // The rest of the path is the canonical one, so an alias resolves its children too.
    argv = [...hit.path, ...argv.slice(depth + 1)];
    depth++;
  }
  return node ? { node, rest: argv.slice(depth) } : null;
}

export interface Parsed {
  args: Array<string | string[] | undefined>;
  opts: Record<string, any>;
}

/** The argv after a command's path, parsed as commander parses it for the CLI, or commander's own error text. */
export function parseWith(node: TreeCommand, rest: string[], stdin = ''): { parsed: Parsed } | { error: string } {
  const cmd = new Command(node.path.at(-1));
  let err = '';
  cmd.exitOverride().configureOutput({ writeOut: () => {}, writeErr: (s) => (err += s) });
  for (const a of node.args ?? []) cmd.argument(`${a.required ? '<' : '['}${a.name}${a.variadic ? '...' : ''}${a.required ? '>' : ']'}`, a.description ?? '');
  for (const f of node.flags) {
    if (f.global || f.long === '--help' || f.long === '--version') continue;
    const o = new Option(f.flags, f.description ?? '');
    // A flag whose default is a list is repeatable in the CLI (`-o a -o b`).
    if (Array.isArray(f.default)) o.argParser((v: string, prev: string[] | undefined) => [...(prev ?? []), v]).default([]);
    else if (f.default !== undefined) o.default(f.default);
    cmd.addOption(o);
  }
  let parsed: Parsed | null = null;
  let stdinError = '';
  cmd.hook('preAction', (c) => {
    try {
      expandCommandStdinDashes(c, () => stdin);
    } catch (e) {
      stdinError = `Error: ${(e as Error).message}`;
    }
  });
  cmd.action((...xs: any[]) => {
    const n = (node.args ?? []).length;
    parsed = { args: xs.slice(0, n), opts: cmd.opts() };
  });
  try {
    cmd.parse(rest, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) return { error: err.trimEnd() || e.message };
    throw e;
  }
  if (stdinError) return { error: stdinError };
  return parsed ? { parsed } : { error: err.trimEnd() };
}
