import { BOARD_VERBS } from '@codecast/shared/artifacts/board';

import { boardVerb } from './board';
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
  const path = hit.node.path.join(' ');
  // A board layout verb takes its own flags (the CLI's allowUnknownOption), so it gets the words as typed.
  if (hit.node.path[0] === 'board' && hit.node.path.length === 2 && BOARD_VERBS[hit.node.path[1]!]) {
    w.seq++;
    return boardVerb(hit.node.path[1]!, hit.rest, stdin, { w, stdin });
  }
  const handler = VERBS[path];
  if (!handler) return null;
  const r = parseWith(hit.node, hit.rest, stdin);
  w.seq++;
  if ('error' in r) return { out: `${r.error}\n`, exit: 1, ...(r.error.startsWith('error: ') ? { cli: true as const } : {}) };
  return handler(r.parsed, { w, stdin });
}

/**
 * The fake as its holder keeps it: a world file that only the holder can
 * write, loaded, answered and saved under a lock for each call. The harness
 * runs one per call in the closed world (prompt-dry-run.ts --fake), so the agent
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

/** Whether a call would read stdin: a `-` argument or option value, or a board verb that reads its items from it (the guard's reads_stdin). */
export const wantsStdin = (argv: string[]): boolean =>
  argv.includes('-') ||
  (argv[0] === 'board' && (['place', 'matrix', 'timeline', 'themes'].includes(argv[1] ?? '') || (argv[1] === 'apply' && !argv.includes('-f') && !argv.includes('--file'))));
