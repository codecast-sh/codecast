import { parseWith, resolveCommand, type Tree } from './tree';
import { VERBS, type Answer } from './verbs';
import { loadWorld, saveWorld, withLock, type FakeWorld, type WorldSeed } from './world';

// The fake `cast`: one call in, the answer prod would give out, the world
// moved. Null means the fake does not model the call; the guard then does
// what it always did.

export const DECLINE_EXIT = 125;

/**
 * One call's answer. An argv the CLI refuses at parse time (an unknown
 * option, a missing argument) is answered with commander's own words and
 * marked `cli`: no real CLI runs for it anywhere, since an argv it parsed
 * after all would run its action. (Groups that print their help after the
 * error print it in prod; the fake gives the error line alone.)
 */
export function answer(argv: string[], stdin: string, w: FakeWorld, tree: Tree): Answer | null {
  if (argv.some((a) => a === '--help' || a === '-h') || argv[0] === 'help') return null;
  const hit = resolveCommand(tree, argv);
  if (!hit) return null;
  const handler = VERBS[hit.node.path.join(' ')];
  if (!handler) return null;
  const r = parseWith(hit.node, hit.rest, stdin);
  w.seq++;
  if ('error' in r) return { out: `${r.error}\n`, exit: 1, ...(r.error.startsWith('error: ') ? { cli: true as const } : {}) };
  return handler(r.parsed, { w });
}

/**
 * The fake as its holder keeps it: a world file that only the holder can
 * write, loaded, answered and saved under a lock for each call. The harness
 * holds one in-process for a run (prompt-dry-run.ts --fake), so the agent
 * can neither edit the world nor forge an answer; bin.ts holds one for a
 * call made by hand.
 */
export function openFake(o: { worldPath: string; seed?: WorldSeed; tree: Tree }): (argv: string[], stdin: string) => Answer | null {
  return (argv, stdin) =>
    withLock(o.worldPath, () => {
      const w = loadWorld(o.worldPath, o.seed);
      const a = answer(argv, stdin, w, o.tree);
      if (a && !a.cli) saveWorld(o.worldPath, w);
      return a;
    });
}

/** Whether a call would read stdin: the CLI reads it only for a `-` argument or option value. */
export const wantsStdin = (argv: string[]): boolean => argv.includes('-');
