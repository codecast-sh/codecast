import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConvoMessage } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { fixturesDir, homePaths } from '../../paths';
import { EVERY_READ, fillAliases, recordSentence, servedReadKey, writeFrozenVerbs, writeServedRead } from '../../served';
import type { ReplayCtx, SurfaceMeta } from '../../surface';

// What role-wake and anchor-brief share: both replay one turn of a role's
// standing session against the world it reads. A real freeze points at a
// served dir `./evals snapshot` captured; a fixture names a synthetic world
// (fixtures/role-wake/worlds/<name>.json, shared by every fixture set in it)
// plus reads of its own, filed into the run dir the same way, so the guard
// answers both alike.

/** One read a fixture serves, as `snapshot` would have captured it. */
export interface FixtureRead {
  argv: string[];
  out: string;
  exit?: number;
}

/** A synthetic workspace several fixtures read: what `cast` answers inside it. */
export interface FixtureWorld {
  notes?: string;
  reads: FixtureRead[];
}

export interface StandingWorld {
  /** When the world was read: the "now" the turn happens at. */
  captured_at: string;
  /** A real freeze: the served dir, relative to EVALS_HOME/snapshots. */
  served?: string;
  /** A fixture: the synthetic world it reads, fixtures/role-wake/worlds/<world>.json. */
  world?: string;
  /** A fixture: reads of its own, served over the world's for the same argv (a seat's own `cast brief`). */
  reads?: FixtureRead[];
  /**
   * A fixture: the seat, as the values `./evals snapshot` takes as flags. They
   * fill the surface's servedAliases, so `role: docs` serves the world's
   * `brief @docs` as the bare `brief` the role types, as a capture would.
   */
  values?: Record<string, string>;
}

export const worldPath = (name: string): string => join(fixturesDir(), 'role-wake', 'worlds', `${name}.json`);

export function readWorld(name: string): FixtureWorld {
  const path = worldPath(name);
  if (!existsSync(path)) throw new UsageError(`no fixture world ${name}: expected packages/evals/fixtures/role-wake/worlds/${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureWorld;
}

/**
 * The served dir a replay's guard answers from. A fixture's world is closed:
 * it freezes every read, so a read it does not hold fails the frozen-reads
 * gate with its argv named instead of reaching the live workspace.
 */
export function servedDirFor(world: StandingWorld, ctx: Pick<ReplayCtx, 'runDir'>, meta: Pick<SurfaceMeta, 'servedAliases'>): string {
  if (world.served) {
    const dir = join(homePaths().snapshots, world.served);
    if (!existsSync(dir)) throw new Error(`served dir missing here: ${world.served}; it lives in EVALS_HOME on the machine that captured it`);
    return dir;
  }
  const reads = new Map<string, FixtureRead>();
  for (const r of [...(world.world ? readWorld(world.world).reads : []), ...(world.reads ?? [])]) reads.set(servedReadKey(r.argv), r);
  for (const a of fillAliases(meta.servedAliases, world.values ?? {}, { skipUnfilled: true })) {
    const from = reads.get(servedReadKey(a.from));
    if (from && !reads.has(servedReadKey(a.serve))) reads.set(servedReadKey(a.serve), { ...from, argv: a.serve });
  }
  const dir = join(ctx.runDir, 'served');
  mkdirSync(dir, { recursive: true });
  for (const r of reads.values()) writeServedRead(dir, r.argv, r.out, r.exit ?? 0);
  writeFrozenVerbs(dir, [EVERY_READ]);
  return dir;
}

export interface SnapshotDir {
  /** `<surface>/<name>`, what a snapshot's `served` holds. */
  served: string;
  dir: string;
  values: Record<string, string>;
  captured_at: string;
}

/** Every served dir `./evals snapshot <surface>` wrote, newest first. */
export function snapshotDirs(surface: string): SnapshotDir[] {
  const root = join(homePaths().snapshots, surface);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'captured.json')))
    .map((e) => {
      const c = JSON.parse(readFileSync(join(root, e.name, 'captured.json'), 'utf8')) as { values?: Record<string, string>; captured_at: string };
      return { served: `${surface}/${e.name}`, dir: join(root, e.name), values: c.values ?? {}, captured_at: c.captured_at };
    })
    .sort((a, b) => b.captured_at.localeCompare(a.captured_at));
}

/**
 * The served dir a ref names: one called exactly that, else the newest one
 * captured with `--<flag> <ref>` (a short id matches its full id either way).
 */
export function findSnapshot(surface: string, flag: string, ref: string, hint: string): SnapshotDir {
  const all = snapshotDirs(surface);
  const named = all.find((s) => s.served === `${surface}/${ref}`);
  if (named) return named;
  const v = (s: SnapshotDir) => s.values[flag] ?? '';
  const hit = all.find((s) => v(s) && (v(s) === ref || v(s).startsWith(ref) || ref.startsWith(v(s))));
  if (!hit) throw new UsageError(`no ${surface} snapshot for ${ref} in EVALS_HOME: capture its world first, ${hint}`);
  return hit;
}

/**
 * A model id the harness can pin: a Claude id, its context suffix kept, so a
 * 1M-context session replays on 1M context (the pin gate compares the bare
 * id, replay.ts); else nothing.
 */
export function claudeModel(id: unknown): string | undefined {
  const m = typeof id === 'string' ? id.trim() : '';
  return /^claude-/.test(m) ? m : undefined;
}

/**
 * What the agent is told about the run it is in. It sits after the
 * production text, so the turn under test reads as prod sent it; it only says
 * what is different here: the record behind the reads (`frozen`, the verbs
 * the served dir freezes), the refused writes, and where the words that would
 * have been posted go instead.
 */
export function harnessNote(frozen: string[], extra: string[] = []): string {
  return [
    '',
    '## Dry run (harness note)',
    '',
    [
      'This run grades how you handle this turn, so nothing you do reaches anyone.',
      recordSentence(frozen),
      'So run no command that writes: where you would send, post, decide, file or change something, say so in your last message instead, with the exact command you would have run.',
      ...extra,
      'Run every command in the foreground and wait for it; a turn that ends waiting on a background command ends this run with no message.',
      'End the turn with the message you would leave in this thread, verbatim and nothing else.',
    ].join(' '),
    '',
  ].join('\n');
}

/** The turn's opening as the judge and the conversation views see it. */
export function describeTurn(text: string, at: string, id: string): ConvoMessage[] {
  return [{ n: 1, id, at, channel: 'session', isGroup: false, direction: 'in', from: 'user', text }];
}
