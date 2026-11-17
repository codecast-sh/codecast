import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { servedReadKey } from '../served';
import type { Roster } from './capture';
import { newWorld, type FakeWorld, type Role, type WorldSeed } from './cast/world';

// The world a fake starts a replay from, read from the replay's own record:
// the roster from any `org ls --json` the served dir captured (handle to
// standing session and title), and the calling session from the seat the
// surface names. Nothing here reads the live workspace.

/** The executable that answers one call by hand, outside a harness (the guard's DRY_RUN_FAKE). */
export const FAKE_BIN = join(import.meta.dir, 'bin.ts');
/** The module prompt-dry-run.ts --fake loads in-process (openFake). */
export const FAKE_MODULE = join(import.meta.dir, 'cast', 'index.ts');

const ID = /\bjx[0-9a-z]{5}\b|\b(?:ct|tr|sd|pl)-\d+\b/g;

/** Every id the served record's reads and the prompt name: the targets that exist in this replay's world besides what the turn makes. Null when there is no record to go on. */
export function knownIds(dir: string | undefined, prompt = ''): string[] | null {
  const reads = dir ? join(dir, 'reads') : '';
  if (!reads || !existsSync(reads)) return null;
  const ids = new Set<string>(prompt.match(ID) ?? []);
  for (const f of readdirSync(reads)) if (f.endsWith('.out')) for (const id of readFileSync(join(reads, f), 'utf8').match(ID) ?? []) ids.add(id);
  return [...ids].sort();
}

/** Every JSON object a read in the served dir answered with. */
function servedJson(dir: string | undefined): any[] {
  const reads = dir ? join(dir, 'reads') : '';
  if (!reads || !existsSync(reads)) return [];
  return readdirSync(reads).flatMap((f) => {
    if (!f.endsWith('.out')) return [];
    const text = readFileSync(join(reads, f), 'utf8');
    if (!text.startsWith('{')) return [];
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  });
}

/** Every role and person an `org ls --json` read in the served dir holds. */
export function rosterFromServed(dir: string | undefined): Roster {
  const roles: Record<string, Role> = {};
  const people: Record<string, string> = {};
  for (const org of servedJson(dir)) {
    if (!Array.isArray(org.anchors) || !Array.isArray(org.roles)) continue;
    const anchors = new Map<string, string>((org.anchors ?? []).map((a: any) => [a.anchor_id, a.short_id]));
    for (const r of org.roles ?? []) {
      const session = anchors.get(r.anchor_id);
      if (r.handle && session) roles[r.handle] = { session, title: r.name };
    }
    for (const p of org.people ?? []) if (p.handle && p.name) people[p.handle] = p.name;
  }
  return { roles, people };
}

/** The seat's brief narrative as a `brief --json` read holds it, so `brief edit --old` patches what the role really had. */
function narrativeFromServed(dir: string | undefined, handle: string): string | undefined {
  const brief = servedJson(dir).find((b) => typeof b.narrative === 'string' && (b.role?.handle ?? '').replace(/^@/, '') === handle);
  return brief?.narrative;
}

/**
 * The seed for a replay: its roster, and the caller as the seat's standing
 * session with the seat's brief. A seat the roster does not hold (a synthetic
 * world) is still a role: it joins the roster under a stand-in session id, so
 * the fake answers its role's commands as the role's.
 */
export function seedFor(serveDir: string | undefined, seat?: { handle?: string; session?: string; title?: string }, prompt = ''): WorldSeed {
  const { roles, people } = rosterFromServed(serveDir);
  const handle = seat?.handle?.replace(/^@/, '');
  let self = seat?.session ?? (handle ? roles[handle]?.session : undefined);
  if (handle && !roles[handle]) {
    self ??= newWorld().self;
    roles[handle] = { session: self, title: seat?.title ?? handle };
  }
  const brief = handle ? narrativeFromServed(serveDir, handle) : undefined;
  const known = knownIds(serveDir, prompt);
  const channels = channelsFromServed(serveDir);
  return { roles, people, ...(self ? { self } : {}), ...(brief !== undefined ? { brief } : {}), ...(known ? { known } : {}), ...(channels ? { channels } : {}) };
}

/** The writes a run made that the fake answered as done (calls.log FAKED lines), as the argv after `cast`. */
export const fakedWrites = (calls: string[]): string[] => calls.filter((l) => l.startsWith('FAKED ')).map((l) => l.slice('FAKED '.length));
/** The writes the fake answered with prod's error (FAKEERR): attempted, not done. */
export const failedWrites = (calls: string[]): string[] => calls.filter((l) => l.startsWith('FAKEERR ')).map((l) => l.slice('FAKEERR '.length));

/**
 * What the judge reads beside the turn's words when its writes ran: the
 * commands themselves. Without the fake a turn names each write in its last
 * message; with it, the turn simply runs them, and a judge shown only the
 * words would read a reply that was sent as one never sent.
 */
export const ranLine = (writes: string[], failed: string[] = []): string =>
  [
    ...(writes.length ? ['(The turn ran these commands, and a stand-in for the workspace answered each as done, as production would:)', ...writes.map((w) => `cast ${w}`)] : []),
    ...(failed.length ? ['(These it ran failed, with the error production gives, so they did nothing:)', ...failed.map((w) => `cast ${w}`)] : []),
  ].join('\n');

/** Where the harness keeps what the agent must not write (its fake's world, the calls it answered): beside the run dir, never in it. */
export const harnessDirOf = (runSubdir: string): string => `${runSubdir}.harness`;

/** The channel names a `chat channels` read in the served record lists, or null when it captured none. */
export function channelsFromServed(dir: string | undefined): string[] | null {
  if (!dir) return null;
  for (const argv of [['chat', 'channels', '--json'], ['chat', 'channels']]) {
    const file = join(dir, 'reads', `${servedReadKey(argv)}.out`);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    try {
      const rows = JSON.parse(text);
      const list = Array.isArray(rows) ? rows : rows.channels ?? [];
      return list.map((c: any) => String(c.name ?? '').toLowerCase()).filter(Boolean);
    } catch {
      return [...new Set([...text.matchAll(/#([a-z0-9][a-z0-9_-]*)/gi)].map((m) => m[1]!.toLowerCase()))];
    }
  }
  return null;
}

/** The world a finished agent run left, or null when it ran without the fake. */
export function fakeWorldOf(runSubdir: string): FakeWorld | null {
  const path = join(harnessDirOf(runSubdir), 'fake-world.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FakeWorld) : null;
}
