import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The key a served read is filed under: sha256 over each argument followed
 * by \x1f. The guard (packages/cli/scripts/prompt-dry-run-bin/cast) computes
 * the same with `printf '%s\x1f' "$@" | shasum -a 256`, so a read `snapshot`
 * captured is the read a replay is answered with.
 */
export function servedReadKey(argv: string[]): string {
  return createHash('sha256')
    .update(argv.map((a) => `${a}\x1f`).join(''))
    .digest('hex');
}

/**
 * A calls.log argv split back into its arguments. The guard's logged_argv
 * single-quotes any argument that is not a plain word ('it'\''s for a quote
 * inside), so a line splits into exactly the argv it logged; null when a quote
 * never closes. A line from before the guard quoted kept its argv space
 * joined, so a quoted phrase there reads as separate words.
 */
export function loggedArgv(line: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let word = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === "'") quoted = false;
      else cur += c;
    } else if (c === "'") [quoted, word] = [true, true];
    else if (c === '\\' && i + 1 < line.length) [cur, word] = [cur + line[++i], true];
    else if (c === ' ') {
      if (word) out.push(cur);
      [cur, word] = ['', false];
    } else [cur, word] = [cur + c, true];
  }
  if (quoted) return null;
  if (word) out.push(cur);
  return out;
}

/**
 * Files one read in a served dir where the guard looks for it: reads/<key>.out,
 * and its exit code beside it. `prefix` adds a reads/<key>.prefix marker, so
 * the guard answers any longer argv that starts with this one and has no
 * capture of its own (`read <id> --full` from `read <id>`).
 */
export function writeServedRead(dir: string, argv: string[], out: string, code: number, opts: { prefix?: boolean } = {}): void {
  const key = servedReadKey(argv);
  mkdirSync(join(dir, 'reads'), { recursive: true });
  writeFileSync(join(dir, 'reads', `${key}.out`), out);
  writeFileSync(join(dir, 'reads', `${key}.exit`), `${code}\n`);
  // The marker holds the argv as its key was made from it, so the guard matches a longer argv by string, without hashing.
  if (opts.prefix) writeFileSync(join(dir, 'reads', `${key}.prefix`), argv.map((a) => `${a}\x1f`).join(''));
}

/** The `frozen` line that freezes every read: a synthetic world answers from its record or not at all. */
export const EVERY_READ = '*';

/** The first words (or "w1 w2") the guard refuses to read live when no capture answers them; EVERY_READ freezes all. */
export function writeFrozenVerbs(dir: string, verbs: string[]): void {
  writeFileSync(join(dir, 'frozen'), `${verbs.join('\n')}\n`);
}

/** What a harness note says answers from a record, from the verbs a served dir freezes. */
export function recordSentence(frozen: string[]): string {
  const writes = 'every command that writes, posts or sends is refused.';
  if (frozen.includes(EVERY_READ)) return `Every \`cast\` read answers from a record of the workspace saved for this turn, and a read the record does not hold fails rather than reaching the live workspace; ${writes}`;
  if (!frozen.length) return `\`cast\` reads are live, and ${writes}`;
  const verbs = frozen.map((v) => `\`cast ${v}\``);
  const list = verbs.length > 1 ? `${verbs.slice(0, -1).join(', ')} and ${verbs.at(-1)}` : verbs[0];
  return `Reads under ${list} answer from a record saved when the turn was captured, and one the record does not hold fails; other reads are live, and ${writes}`;
}

/**
 * The moment a served dir's world stands at: the guard `git`
 * (packages/cli/scripts/prompt-dry-run-bin/git) answers every git call in a
 * repository from the history as of `at`, each root in `pins` at its pinned
 * commit and any other at its default branch's last commit before `at`.
 */
export interface Cut {
  at: string;
  pins: Record<string, string>;
}

/** Files the cut where the guard `git` reads it: `at`, `epoch` and one tab-separated `git <root> <sha>` line per pin. */
export function writeCut(dir: string, cut: Cut): void {
  const epoch = Math.floor(Date.parse(cut.at) / 1000);
  if (!Number.isFinite(epoch)) throw new Error(`a cut needs a capture time, not "${cut.at}"`);
  const pins = Object.entries(cut.pins).map(([root, sha]) => `git\t${root}\t${sha}`);
  writeFileSync(join(dir, 'cut'), `${[`at ${cut.at}`, `epoch ${epoch}`, ...pins].join('\n')}\n`);
}

/** What writeCut filed in a served dir; null for a dir captured before cuts existed. */
export function readCut(dir: string): Cut | null {
  const path = join(dir, 'cut');
  if (!existsSync(path)) return null;
  const cut: Cut = { at: '', pins: {} };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith('at ')) cut.at = line.slice(3);
    const [kind, root, sha] = line.split('\t');
    if (kind === 'git' && root && sha) cut.pins[root] = sha;
  }
  return cut;
}

/** What writeFrozenVerbs filed in a served dir. */
export function readFrozenVerbs(dir: string): string[] {
  const path = join(dir, 'frozen');
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

/**
 * A surface's served aliases with their placeholders filled: each `serve`
 * argv answers with what its `from` argv captured. A capture needs every
 * value (fillArgv throws); a fixture seat skips the aliases it has no value
 * for (a workspace agent has no role, so its bare `cast brief` is its own).
 */
export function fillAliases(aliases: Array<{ serve: string[]; from: string[] }> | undefined, values: Record<string, string>, opts: { skipUnfilled?: boolean } = {}): Array<{ serve: string[]; from: string[] }> {
  const filled = (t: string[]) => t.every((part) => [...part.matchAll(/\{(\w+)\}/g)].every((m) => values[m[1]!] !== undefined));
  return (aliases ?? []).filter((a) => !opts.skipUnfilled || (filled(a.serve) && filled(a.from))).map((a) => ({ serve: fillArgv(a.serve, values), from: fillArgv(a.from, values) }));
}

/** An argv template with its {placeholders} filled; a missing value is an error naming it. */
export function fillArgv(template: string[], values: Record<string, string>): string[] {
  return template.map((part) =>
    part.replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = values[k];
      if (v === undefined) throw new Error(`--${k} is required: the read ${template.join(' ')} names {${k}}`);
      return v;
    }),
  );
}
