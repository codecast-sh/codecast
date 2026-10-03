import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { codecastFreezeStore } from '../adapters/freezes';
import { evalsHome, homePaths } from '../paths';
import { writeSite } from './publish';

// The published site is email gated, and the gate captures an address rather
// than keeping anyone out, so nothing in it may name a private freeze: not
// its id, not the id prefix every run folder of it carries, not its name
// (which cites the real session or task it froze). This builds the site from
// the real EVALS_HOME into a temp dir and scans every byte, and proves the
// scan on a synthetic home where a private run sits next to a public one.

interface PrivateFreeze {
  id: string;
  name: string | null;
}

/**
 * Every freeze in a home's freezes dir. That dir is private by construction (a
 * public freeze is committed under packages/evals instead), and the guard reads
 * it without the publish code's own isPublicFreeze, so a broken predicate there
 * cannot also blind the guard.
 */
function privateFreezes(home: string): PrivateFreeze[] {
  const dir = homePaths(home).freezes;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .flatMap((n) => {
      try {
        const f = JSON.parse(readFileSync(join(dir, n), 'utf8')) as { id?: string; name?: string | null };
        return f.id ? [{ id: f.id, name: f.name ?? null }] : [];
      } catch {
        return [];
      }
    });
}

const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesUnder(join(dir, n)) : [join(dir, n)]));

/**
 * One line per file that names a private freeze, by kind and id prefix only,
 * so a failure never echoes the private name into a log.
 */
function scanSite(site: string, freezes: PrivateFreeze[]): string[] {
  const out: string[] = [];
  for (const path of filesUnder(site)) {
    const text = readFileSync(path, 'utf8');
    const rel = relative(site, path);
    for (const f of freezes) {
      const prefix = f.id.slice(0, 8);
      if (text.includes(f.id)) out.push(`${rel}: private freeze ${prefix} (full id)`);
      else if (new RegExp(`(?<![0-9a-f])${prefix}(?![0-9a-f])`).test(text)) out.push(`${rel}: private freeze ${prefix} (id prefix, as in a run folder name)`);
      if (f.name && f.name.length >= 8 && text.includes(f.name)) out.push(`${rel}: private freeze ${prefix} (its name)`);
    }
  }
  return out;
}

/**
 * A temp home that reads the real one and writes nowhere near it: run, freeze,
 * snapshot and label dirs are symlinked (writeSite only reads them), small
 * files and the index cache are copied, and html/scratch are left out, so the
 * site lands in the temp dir.
 */
function mirrorHome(real: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'evals-publish-guard-'));
  for (const name of readdirSync(real)) {
    if (name === 'html' || name === 'scratch') continue;
    const from = join(real, name);
    if (!statSync(from).isDirectory()) cpSync(from, join(tmp, name));
    else if (name === 'index') cpSync(from, join(tmp, name), { recursive: true });
    else symlinkSync(from, join(tmp, name));
  }
  return tmp;
}

async function buildSiteIn(home: string): Promise<string> {
  const prior = process.env.CODECAST_EVALS_HOME;
  process.env.CODECAST_EVALS_HOME = home;
  try {
    // Ten years: wide enough to reach every run writeSite would ever list.
    return await writeSite({ since: '520w' });
  } finally {
    if (prior === undefined) delete process.env.CODECAST_EVALS_HOME;
    else process.env.CODECAST_EVALS_HOME = prior;
  }
}

/** A run folder in the platform layout, enough for every page the site writes. */
function writeRun(runs: string, surface: string, freezeId: string, seed: number, stamp: string, batch: string): string {
  const scenario = `${surface}-${freezeId.slice(0, 8)}`;
  const id = `${scenario}-seed${seed}-${stamp}`;
  const dir = join(runs, id);
  mkdirSync(dir, { recursive: true });
  const startedAt = `${stamp.slice(0, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}.${stamp.slice(20, 23)}Z`;
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ scenario, seed, title: `${surface} run`, startedAt, endedBecause: 'done', steps: 1, virtualElapsedMs: 0, realElapsedMs: 1000, costUsd: 0.001 }));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ freezeId, notes: null, model: 'claude-haiku-4-5-20251001', route: 'call', batch, dry: false, liveReads: 0, judgeModel: 'claude-sonnet-5-5' }));
  writeFileSync(join(dir, 'score.json'), JSON.stringify({ pass: true, score: 0.8, passMark: 0.7, gates: [], checks: [], missedFloors: [], judgeCostUsd: 0.004, judgeModel: 'claude-sonnet-5-5', scoredAt: startedAt, scenario, seed }));
  writeFileSync(join(dir, 'sends.json'), '[]');
  writeFileSync(join(dir, 'events.jsonl'), '');
  return id;
}

describe('the published site names no private freeze', () => {
  const real = evalsHome();
  const realPrivate = privateFreezes(real);

  test.skipIf(realPrivate.length === 0)(
    'built from the real EVALS_HOME into a temp dir',
    async () => {
      const home = mirrorHome(real);
      try {
        const site = await buildSiteIn(home);
        expect(site.startsWith(home)).toBe(true);
        expect(filesUnder(site).map((p) => relative(site, p)).sort()).toEqual(['index.html', 'matrix.html', 'report.html']);
        expect(scanSite(site, realPrivate)).toEqual([]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    600_000,
  );

  test('a synthetic home: the private run stays out, the public one is in, and a planted leak is caught', async () => {
    const home = mkdtempSync(join(tmpdir(), 'evals-publish-guard-synth-'));
    try {
      // An empty private dir: what lists is the committed (public) freezes only.
      const pub = (await codecastFreezeStore({ privateDir: join(home, 'none') }).list()).find((f) => (f.meta as { surface?: string }).surface === 'title');
      if (!pub) throw new Error('packages/evals has no public title freeze to stand beside the private one');
      const priv: PrivateFreeze = { id: 'c0ffee12-3456-4789-8abc-def012345678', name: 'title jx7zzzz:42' };
      const paths = homePaths(home);
      mkdirSync(paths.freezes, { recursive: true });
      writeFileSync(
        join(paths.freezes, `${priv.id}.json`),
        JSON.stringify({ id: priv.id, name: priv.name, createdAt: '2026-10-01T00:00:00.000Z', anchor: { kind: 'message', id: 'jx7zzzz:42' }, subject: { kind: 'session', id: 'jx7zzzz', title: priv.name }, asOf: '2026-10-01T00:00:00.000Z', tags: [], judge: null, meta: { surface: 'title', visibility: 'private', snapshot: 'title/000000000000.json' } }),
      );
      const now = new Date(Date.now() - 60_000).toISOString().replace(/[:.]/g, '-');
      const batch = new Date(Date.now() - 120_000).toISOString();
      const privRun = writeRun(paths.runs, 'title', priv.id, 1, now, batch);
      const pubRun = writeRun(paths.runs, 'title', pub.id, 1, now, batch);

      const site = await buildSiteIn(home);
      expect(site).toBe(homePaths(home).site);
      const report = readFileSync(join(site, 'report.html'), 'utf8');
      // Not vacuous: the site did render this home's runs, just not the private one.
      expect({ pubRunShown: report.includes(pubRun), privRunShown: report.includes(privRun) }).toEqual({ pubRunShown: true, privRunShown: false });
      expect(scanSite(site, privateFreezes(home))).toEqual([]);

      writeFileSync(join(site, 'matrix.html'), `<td>${privRun}</td><p>${priv.name}</p>`);
      writeFileSync(join(site, 'index.html'), `<pre>${priv.id}</pre>`);
      expect(scanSite(site, [priv]).sort()).toEqual([
        'index.html: private freeze c0ffee12 (full id)',
        'matrix.html: private freeze c0ffee12 (id prefix, as in a run folder name)',
        'matrix.html: private freeze c0ffee12 (its name)',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});
