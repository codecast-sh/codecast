import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ConvoMessage, Freeze, FreezeResolver, ProductionReply } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { redactSecrets } from '../../../cli/src/secretRedaction';
import { labelPath } from '../labels';
import { fixturesDir, homePaths, publicFreezesDir, treeRoot } from '../paths';
import { loadSurface, refFormsLine, surfaceMeta } from '../registry';
import { readConversation } from './convo';
import { judgeMomentOf } from './judge';

// `freeze create <surface>@<ref>`: the resolver picks the surface from the
// prefix (the platform hands it only {messageRef, runRef}), turns a fixture
// into a public freeze, and has the surface capture a real moment into a
// private one whose snapshot is redacted and content addressed.

export interface Fixture {
  asOf: string;
  snapshot: unknown;
  label?: unknown;
  /** The criteria a new freeze of it starts with; null means only gates grade it, unset takes the surface's default. Once its freeze exists the criterion lives there, not here. */
  judge?: string | null;
  notes?: string;
}

export function parseSurfaceRef(ref: string): { surface: string; rest: string } | null {
  const at = ref.indexOf('@');
  if (at <= 0) return null;
  return { surface: ref.slice(0, at), rest: ref.slice(at + 1) };
}

/** A fixture's path relative to packages/evals: what a public freeze's meta.snapshot holds. */
export const fixtureRel = (surface: string, kase: string): string => `fixtures/${surface}/${kase}.json`;
const evalsPkg = (): string => join(treeRoot(), 'packages', 'evals');

export function readFixture(surface: string, kase: string): Fixture {
  const path = join(fixturesDir(), surface, `${kase}.json`);
  if (!existsSync(path)) throw new UsageError(`no fixture ${fixtureRel(surface, kase)} in packages/evals`);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  return value;
};

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/** Redacts, writes content addressed, and returns the path relative to EVALS_HOME/snapshots. */
export function writeSnapshot(surface: string, snapshot: unknown): string {
  const text = `${redactSecrets(JSON.stringify(canonical(snapshot), null, 1))}\n`;
  const rel = `${surface}/${sha256(text).slice(0, 12)}.json`;
  const path = join(homePaths().snapshots, rel);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, text);
  return rel;
}

export const freezeMeta = (f: Pick<Freeze, 'meta'>) => (f.meta ?? {}) as { surface?: string; visibility?: string; snapshot?: string };

/** Where a freeze's snapshot sits: a committed fixture, a content addressed file, or a served dir. */
export function snapshotPath(f: Pick<Freeze, 'meta'>): string | null {
  const m = freezeMeta(f);
  if (!m.snapshot) return null;
  return m.visibility === 'public' ? join(evalsPkg(), m.snapshot) : join(homePaths().snapshots, m.snapshot);
}

export function hasSnapshot(f: Pick<Freeze, 'meta'>): boolean {
  const p = snapshotPath(f);
  return Boolean(p && existsSync(p));
}

export interface LoadedSnapshot {
  /** The snapshot content: a fixture's `snapshot`, a stored file, or for a served dir its captured.json. */
  snap: unknown;
  /** Set when the snapshot is a served dir (agent surfaces). */
  dir?: string;
  fixture?: Fixture;
}

/** Loads a freeze's snapshot; a stored file whose bytes no longer hash to its name fails. */
export function loadSnapshot(f: Pick<Freeze, 'meta'>): LoadedSnapshot {
  const m = freezeMeta(f);
  const path = snapshotPath(f);
  if (!path || !existsSync(path)) throw new Error(`snapshot missing here: ${m.snapshot ?? '(none)'}; it lives in EVALS_HOME on the machine that captured it`);
  if (statSync(path).isDirectory()) {
    const captured = join(path, 'captured.json');
    return { snap: existsSync(captured) ? JSON.parse(readFileSync(captured, 'utf8')) : {}, dir: path };
  }
  const bytes = readFileSync(path);
  if (m.visibility === 'public') {
    const fixture = JSON.parse(bytes.toString('utf8')) as Fixture;
    return { snap: fixture.snapshot, fixture };
  }
  const want = path.replace(/^.*\//, '').replace(/\.json$/, '');
  const got = sha256(bytes).slice(0, 12);
  if (got !== want) throw new SnapshotMismatch(`snapshot ${m.snapshot} hashes to ${got}: it changed after capture`);
  return { snap: JSON.parse(bytes.toString('utf8')) };
}

export class SnapshotMismatch extends Error {}

/** A fixture's inline label, else EVALS_HOME/labels/<surface>/<freezeId>.json, else none. */
export function loadLabel(f: Freeze, loaded?: LoadedSnapshot): unknown {
  if (loaded?.fixture?.label !== undefined) return loaded.fixture.label;
  const m = freezeMeta(f);
  const path = labelPath(m.surface ?? '', f.id);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

/**
 * The criteria a new freeze starts with. A fixture's criterion lives on its
 * committed freeze once one exists (auditPublicTree refuses a second copy in
 * the fixture), so a freeze made again from that fixture takes the existing
 * freeze's; a fixture with no freeze yet seeds it from its own `judge`; else
 * the surface's default.
 */
export function defaultJudgeFor(input: Pick<Freeze, 'meta'>): string | null {
  const m = freezeMeta(input);
  if (!m.surface) return null;
  if (m.visibility === 'public' && m.snapshot) {
    const dir = publicFreezesDir();
    const committed = existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => n.endsWith('.json'))
          .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as Freeze)
          .find((f) => freezeMeta(f).snapshot === m.snapshot)
      : undefined;
    if (committed) return committed.judge ?? null;
    const path = join(evalsPkg(), m.snapshot);
    if (existsSync(path)) {
      const fixture = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
      if (fixture.judge !== undefined) return fixture.judge || null;
    }
  }
  return surfaceMeta(m.surface)?.criteria ?? null;
}

export function codecastFreezeResolver(): FreezeResolver {
  return {
    async resolve(input) {
      if (input.runRef) throw new UsageError('--run is not used here: name the surface in the ref instead, like title@jx7c6zk:142 or settle@fixture:<case>');
      const parsed = parseSurfaceRef(input.messageRef ?? '');
      if (!parsed || !surfaceMeta(parsed.surface)) {
        const what = parsed ? `${parsed.surface} is not a surface` : `a ref names its surface, <surface>@<ref>`;
        throw new UsageError(`${what}: ${await refFormsLine()}`);
      }
      const { surface, rest } = parsed;
      if (rest.startsWith('fixture:')) {
        const kase = rest.slice('fixture:'.length);
        const fixture = readFixture(surface, kase);
        return {
          name: `${surface} ${kase}`,
          anchor: { kind: 'message', id: `fixture:${kase}` },
          subject: { kind: 'synthetic', id: `${surface}:${kase}`, title: `${surface} ${kase}` },
          asOf: fixture.asOf,
          trigger: { type: surface },
          meta: { surface, visibility: 'public', snapshot: fixtureRel(surface, kase) },
        };
      }
      const impl = await loadSurface(surface);
      if (!rest) throw new UsageError(impl.refForms);
      const captured = await impl.capture(rest, { readConversation });
      const snapshot = captured.snapshotRef ?? writeSnapshot(surface, captured.snapshot ?? null);
      return {
        name: captured.name ?? `${surface} ${rest}`,
        anchor: captured.anchor,
        subject: captured.subject,
        asOf: captured.asOf,
        trigger: captured.trigger ?? { type: surface },
        meta: { ...captured.meta, surface, visibility: 'private', snapshot, captured_at: new Date().toISOString() },
      };
    },
  };
}

const surfaceOf = (f: Pick<Freeze, 'meta'>): string => String(freezeMeta(f).surface ?? '');

/** A freeze's snapshot as the conversation views see it; null when the snapshot is not on this machine. */
export async function describeFreeze(f: Freeze): Promise<ConvoMessage[] | null> {
  if (!hasSnapshot(f) || !surfaceMeta(surfaceOf(f))) return null;
  const impl = await loadSurface(surfaceOf(f));
  return impl.describe(loadSnapshot(f).snap);
}

/** A freeze's snapshot as the judge reads it (judgeMomentOf); null when the snapshot is not on this machine. */
export async function judgeMomentOfFreeze(f: Freeze): Promise<ConvoMessage[] | null> {
  if (!hasSnapshot(f) || !surfaceMeta(surfaceOf(f))) return null;
  return judgeMomentOf(await loadSurface(surfaceOf(f)), loadSnapshot(f).snap, f.asOf);
}

/** What prod actually produced after the moment, when the surface knows. */
export async function productionReplyOf(f: Freeze): Promise<ProductionReply | null> {
  if (!hasSnapshot(f) || !surfaceMeta(surfaceOf(f))) return null;
  const impl = await loadSurface(surfaceOf(f));
  return impl.productionReply?.(loadSnapshot(f).snap) ?? null;
}
