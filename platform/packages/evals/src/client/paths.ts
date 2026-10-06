// Every Evals address under one base, both ways: `parse` reads a location
// into the view it names, and `href` builds every link. A host mounts the
// area at its own base (codecast: /evals; union: /admin/evals/v2), so this is
// the only place that knows the sub-paths. Pure: no React, no store.
//
// An address may be stored by a host's tab system (codecast persists tabs to
// IndexedDB and syncs them to Convex), so it carries identifiers only: a
// surface, a freeze id's first 8 characters (the api resolves the prefix),
// run ids (surface, freeze prefix, seed and stamp), a stamp, a sha, a bisect
// id. A batch with any other name rides as its hash (evalsBatchRef), which
// each page resolves against the batches it loaded. `canonicalPath` brings
// any typed or older address to that form.

import { EVALS_SHA_RE, evalsBatchRef } from '../contract';

export type EvalsView =
  | { view: 'home'; cadence: string | null }
  | { view: 'surface'; surface: string; batch: string | null; compare: string | null }
  | { view: 'freeze'; freezeId: string; batch: string | null; a: string | null; b: string | null }
  | { view: 'run'; runId: string }
  | { view: 'compare'; a: string; b: string }
  | { view: 'bisect-list' }
  | { view: 'bisect-new'; surface: string | null; good: string | null; bad: string | null; freeze: string | null; all?: boolean }
  | { view: 'bisect'; id: string }
  | { view: 'sim' }
  | { view: 'sim-run'; session: string; run: string }
  | { view: 'commit'; sha: string; surface: string | null }
  | { view: 'patch'; sha: string }
  | { view: 'not-found'; path: string };

export type EvalsViewName = EvalsView['view'];

const enc = encodeURIComponent;

/** How an address names a freeze: its id's first 8 characters, which the api resolves to the freeze. */
export const FREEZE_REF_LENGTH = 8;
export const freezeRef = (freezeId: string): string => freezeId.slice(0, FREEZE_REF_LENGTH);
/** A freeze param that names a freeze (bisect/new?freeze=): its prefix. */
const freezeParam = (f: string | null | undefined): string | null => (f ? freezeRef(f) : null);

function dec(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

function withQuery(path: string, query: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

const SURFACE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const BISECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const FOLDER_RE = /^[A-Za-z0-9._-]{1,160}$/;
const HEX_RE = /^[0-9a-f]{4,64}$/;
const FREEZE_ID_RE = /^[0-9a-f-]{4,36}$/;
const CADENCES_RE = /^[a-z]{1,24}$/;
const FRAGMENT_RE = /^[a-z0-9-]{1,80}$/i;
const RUN_ID_RE = /^([a-z][a-z0-9-]*?)-([0-9a-f]{8})-seed(\d+)-\d{4}-\d{2}-\d{2}T[\d-]+Z$/;
const BATCH_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** A view whose every part is an identifier a tab list may keep, or null when one part is not. */
function identifiersOnly(v: EvalsView): EvalsView | null {
  const surface = (x: string | null) => x === null || SURFACE_ID_RE.test(x);
  const run = (x: string | null) => x === null || RUN_ID_RE.test(x);
  switch (v.view) {
    case 'home':
      return { ...v, cadence: v.cadence && CADENCES_RE.test(v.cadence) ? v.cadence : null };
    case 'surface':
      return surface(v.surface) ? v : null;
    case 'freeze':
      return FREEZE_ID_RE.test(v.freezeId) && run(v.a) && run(v.b) ? v : null;
    case 'run':
      return run(v.runId) ? v : null;
    case 'compare':
      return run(v.a) && run(v.b) ? v : null;
    case 'bisect-new':
      return surface(v.surface) && (v.freeze === null || FREEZE_ID_RE.test(v.freeze)) ? v : null;
    case 'bisect':
      return BISECT_ID_RE.test(v.id) ? v : null;
    case 'sim-run':
      return FOLDER_RE.test(v.session) && FOLDER_RE.test(v.run) ? v : null;
    case 'commit':
    case 'patch':
      return HEX_RE.test(v.sha) && (v.view === 'patch' || surface(v.surface)) ? v : null;
    case 'bisect-list':
    case 'sim':
      return v;
    case 'not-found':
      return null;
  }
}

/** The tab of the area's local nav a view belongs to. */
export function evalsSection(v: EvalsView): 'surfaces' | 'bisects' | 'sim' | null {
  switch (v.view) {
    case 'bisect-list':
    case 'bisect-new':
    case 'bisect':
      return 'bisects';
    case 'sim':
    case 'sim-run':
      return 'sim';
    case 'not-found':
      return null;
    default:
      return 'surfaces';
  }
}

/**
 * What the search box knows: the wall's surfaces and their batches, the
 * freezes a page loaded, and what `GET /search` found in the index for the
 * text typed (freezes and runs by id prefix).
 */
export interface EvalsSearchKnown {
  surfaces: string[];
  /** Batch name to the surfaces that ran it. */
  batches: Record<string, string[]>;
  freezes: Array<{ id: string; name: string }>;
  runs?: Array<{ id: string; surface: string; freezeName: string | null }>;
}

export interface EvalsSearchTarget {
  kind: 'surface' | 'run' | 'batch' | 'freeze' | 'commit';
  label: string;
  href: string;
}

/** The known batches a search names: the one it names whole, else those whose id (not a time) it begins, at 8 characters or more. */
function searchBatches(q: string, known: EvalsSearchKnown): string[] {
  if (BATCH_RE.test(q) || q in known.batches) return [q];
  const lower = q.toLowerCase();
  return lower.length >= 8 ? Object.keys(known.batches).filter((b) => !BATCH_RE.test(b) && b.toLowerCase().startsWith(lower)) : [];
}

/** Whether the batches the area knows are named by when they began (codecast), or by an id (a product's run id). */
export const batchesAreStamps = (known: EvalsSearchKnown): boolean => Object.keys(known.batches).every((b) => BATCH_RE.test(b));

/** Every address of the area mounted at `basePath`. */
export function evalsPaths(basePath: string) {
  const base = `/${basePath.replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
  const at = (sub = '') => `${base}${sub}` || '/';
  const baseSegs = base.split('/').slice(1).filter(Boolean);
  const isPathRe = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/?#]|$)`);

  /** Every link into the area. */
  const href = {
    home: (opts: { cadence?: string | null } = {}) => withQuery(at(), { cadence: opts.cadence }),
    surface: (surface: string, opts: { batch?: string | null; compare?: string | null } = {}) => withQuery(at(`/s/${enc(surface)}`), { batch: evalsBatchRef(opts.batch), compare: evalsBatchRef(opts.compare) }),
    /** `a` and `b` open the freeze with those two runs on its cards, not its own default pair. */
    freeze: (freezeId: string, opts: { batch?: string | null; a?: string | null; b?: string | null } = {}) => withQuery(at(`/f/${enc(freezeRef(freezeId))}`), { batch: evalsBatchRef(opts.batch), a: opts.a, b: opts.b }),
    /** `anchor` is a gate or check fragment: `gate-no-leak`, `check-criteria`. */
    run: (runId: string, anchor?: string) => `${at(`/r/${enc(runId)}`)}${anchor ? `#${anchor}` : ''}`,
    compare: (a: string, b: string) => withQuery(at('/compare'), { a, b }),
    bisectList: () => at('/bisect'),
    /** `all` searches every commit in the range, not only those touching declared sources (--all-commits). */
    bisectNew: (opts: { surface?: string | null; good?: string | null; bad?: string | null; freeze?: string | null; all?: boolean } = {}) =>
      withQuery(at('/bisect/new'), { surface: opts.surface, good: evalsBatchRef(opts.good), bad: evalsBatchRef(opts.bad), freeze: freezeParam(opts.freeze), all: opts.all ? '1' : null }),
    bisect: (id: string) => at(`/bisect/${enc(id)}`),
    sim: () => at('/sim'),
    simRun: (session: string, run: string) => at(`/sim/${enc(session)}/${enc(run)}`),
    /** One commit, its diff limited to the surface's declared sources when a surface is named. */
    commit: (sha: string, opts: { surface?: string | null } = {}) => withQuery(at(`/c/${enc(sha)}`), { surface: opts.surface }),
    /** One kept tree patch: the uncommitted edits a dirty rep ran on. */
    patch: (sha: string) => at(`/p/${enc(sha)}`),
  };

  /** The href a view is at: the inverse of parse. */
  function hrefFor(v: EvalsView): string {
    switch (v.view) {
      case 'home':
        return href.home({ cadence: v.cadence });
      case 'surface':
        return href.surface(v.surface, { batch: v.batch, compare: v.compare });
      case 'freeze':
        return href.freeze(v.freezeId, { batch: v.batch, a: v.a, b: v.b });
      case 'run':
        return href.run(v.runId);
      case 'compare':
        return href.compare(v.a, v.b);
      case 'bisect-list':
        return href.bisectList();
      case 'bisect-new':
        return href.bisectNew(v);
      case 'bisect':
        return href.bisect(v.id);
      case 'sim':
        return href.sim();
      case 'sim-run':
        return href.simRun(v.session, v.run);
      case 'commit':
        return href.commit(v.sha, { surface: v.surface });
      case 'patch':
        return href.patch(v.sha);
      case 'not-found':
        return v.path;
    }
  }

  /** The view a location names. Anything under the base that names no view is `not-found`, never a guess. */
  function parse(pathname: string, search: string | URLSearchParams = ''): EvalsView {
    const path = pathname.split('#')[0]!.split('?')[0]!;
    const q = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;
    const get = (k: string) => q.get(k) || null;
    const raw = path.replace(/\/+$/, '').split('/').slice(1);
    const miss = { view: 'not-found', path: pathname } as const;
    if (baseSegs.some((s, i) => raw[i] !== s)) return miss;
    const segs = raw.slice(baseSegs.length).map(dec);
    if (segs.some((s) => s === null || s === '')) return miss;
    const [a, b, c] = segs as string[];
    switch (segs.length) {
      case 0:
        return { view: 'home', cadence: get('cadence') };
      case 1:
        if (a === 'compare') {
          const x = get('a');
          const y = get('b');
          return x && y ? { view: 'compare', a: x, b: y } : miss;
        }
        if (a === 'bisect') return { view: 'bisect-list' };
        if (a === 'sim') return { view: 'sim' };
        return miss;
      case 2:
        if (a === 's') return { view: 'surface', surface: b!, batch: get('batch'), compare: get('compare') };
        if (a === 'f') return { view: 'freeze', freezeId: b!, batch: get('batch'), a: get('a'), b: get('b') };
        if (a === 'c') return { view: 'commit', sha: b!, surface: get('surface') };
        if (a === 'p') return { view: 'patch', sha: b! };
        if (a === 'r') return { view: 'run', runId: b! };
        if (a === 'bisect' && b === 'new') return { view: 'bisect-new', surface: get('surface'), good: get('good'), bad: get('bad'), freeze: get('freeze'), ...(get('all') === '1' ? { all: true } : {}) };
        if (a === 'bisect') return { view: 'bisect', id: b! };
        return miss;
      case 3:
        if (a === 'sim') return { view: 'sim-run', session: b!, run: c! };
        return miss;
      default:
        return miss;
    }
  }

  return {
    basePath: at(),
    href,
    hrefFor,
    parse,
    /** Whether a path is an address of this area. */
    isPath: (path: string): boolean => isPathRe.test(path),

    /**
     * The address a tab list keeps for a path of this area: the same view,
     * spelled with identifiers only. A full freeze id becomes its prefix and a
     * named batch its hash; a path that names no view, or names one through
     * anything but an identifier, becomes the wall. A fragment (a gate or a
     * tab) stays when it is a plain word.
     */
    canonicalPath(path: string): string {
      const [beforeHash, fragment = ''] = path.split('#');
      const [pathname, query = ''] = beforeHash!.split('?');
      const v = identifiersOnly(parse(pathname!, query));
      if (!v) return href.home();
      const out = hrefFor(v);
      return FRAGMENT_RE.test(fragment) ? `${out}#${fragment}` : out;
    },

    /** Where a page that names a surface by a signal's subject opens (codecast's Line page): that surface, else the wall. */
    senseHref(subject: string | null | undefined): string {
      return subject && /^[a-z][a-z0-9-]*$/.test(subject) ? href.surface(subject) : href.home();
    },

    /** The tab title for an address: what the view is about, not its path. */
    tabLabel(path: string): string {
      const [pathname, query = ''] = path.split('#')[0]!.split('?');
      const v = parse(pathname!, query);
      switch (v.view) {
        case 'home':
        case 'not-found':
          return 'Evals';
        case 'surface':
          return v.surface;
        case 'freeze':
          return `Freeze ${v.freezeId.slice(0, 8)}`;
        case 'run': {
          const m = v.runId.match(/^(.+?)-[0-9a-f]{8}-seed(\d+)-/);
          return m ? `${m[1]} seed ${m[2]}` : 'Run';
        }
        case 'compare':
          return 'Compare runs';
        case 'bisect-list':
          return 'Bisects';
        case 'bisect-new':
          return v.surface ? `Attribute ${v.surface}` : 'Attribute';
        case 'bisect':
          return `Bisect ${v.id}`;
        case 'sim':
          return 'Multiplayer sim';
        case 'sim-run':
          return v.run;
        case 'commit':
          return `Commit ${v.sha.slice(0, 8)}`;
        case 'patch':
          return `Patch ${v.sha.slice(0, 8)}`;
      }
    },

    /**
     * Where a search can go, best first. It accepts a surface id, a run id or
     * its prefix, a batch name, a freeze id prefix and a sha. A hex string
     * that names no known freeze reads as a commit, which opens its commit page.
     */
    searchTargets(input: string, known: EvalsSearchKnown): EvalsSearchTarget[] {
      const q = input.trim();
      if (!q) return [];
      const lower = q.toLowerCase();
      const out: EvalsSearchTarget[] = [];
      for (const s of known.surfaces) {
        if (s === lower) out.unshift({ kind: 'surface', label: s, href: href.surface(s) });
        else if (s.startsWith(lower) || s.includes(lower)) out.push({ kind: 'surface', label: s, href: href.surface(s) });
      }
      if (RUN_ID_RE.test(q) || known.runs?.some((r) => r.id === q)) out.push({ kind: 'run', label: q, href: href.run(q) });
      for (const r of known.runs ?? []) if (r.id !== q && r.id.toLowerCase().startsWith(lower)) out.push({ kind: 'run', label: r.id, href: href.run(r.id) });
      // A batch by its whole name, or by a prefix of an id that is not a time (a product whose batch is its run's id).
      for (const b of searchBatches(q, known)) for (const s of known.batches[b] ?? []) out.push({ kind: 'batch', label: `${s} at batch ${b}`, href: href.surface(s, { batch: b }) });
      if (lower.length >= 3) {
        for (const f of known.freezes) if (f.id.toLowerCase().startsWith(lower)) out.push({ kind: 'freeze', label: `${f.name} (${f.id.slice(0, 8)})`, href: href.freeze(f.id) });
      }
      if (EVALS_SHA_RE.test(lower) && !out.some((t) => t.kind === 'freeze')) out.push({ kind: 'commit', label: `commit ${lower.slice(0, 12)}`, href: href.commit(lower) });
      return out.slice(0, 8);
    },
  };
}

export type EvalsPaths = ReturnType<typeof evalsPaths>;
/** The links of an area: what a model that builds an href takes. */
export type EvalsHrefs = EvalsPaths['href'];
