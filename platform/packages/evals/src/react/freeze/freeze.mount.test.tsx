/**
 * The Freeze group, mounted in happy-dom over the real query handler behind
 * localTransport, under a base path that is not codecast's. A freeze page
 * opens on the pair either side of the newest break, paints the label,
 * production's reply, the moment and its cut, every rep and the prompt that
 * changed between the two cards, and the reader repicks and swaps the pair;
 * two runs compare side by side; the surface page's plate, compare drawer and
 * epoch sheet draw from the handler's own answers through the default slots;
 * and a product that keeps no freezes, or cannot attribute, is told so or
 * shown no launcher rather than an empty panel.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactNode } from 'react';
import { evalsBatchRef, type BatchesResponse, type CommitRef, type EpochResponse, type FreezeResponse, type RunDiffEntry, type RunRowCore, type SurfaceResponse } from '../../contract';
import type { EvalsSources, QuerySurface, RunDetail } from '../../query';

const win = new Window({ url: 'https://host.test/lab' });
const GLOBALS = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLInputElement: win.HTMLInputElement,
  Element: win.Element,
  SVGElement: win.SVGElement,
  Node: win.Node,
  Event: win.Event,
  KeyboardEvent: win.KeyboardEvent,
  MouseEvent: win.MouseEvent,
  PopStateEvent: win.PopStateEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [k, v] of Object.entries(GLOBALS)) {
  saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
  Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}
afterAll(async () => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  await win.happyDOM.close();
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { evalsPaths, localTransport, defaultFreezePair, shownRep, surfaceColumns } = await import('../../client');
const { createEvalsHandler } = await import('../../query');
const R = await import('..');

// ── A product: one surface, five nights, a freeze that breaks on the last ────
// The prompt changes that night as well, so the break sits on an epoch boundary
// and the two default cards saw different prompts.

const BASE = '/lab';
/** Every link the views should draw, under a base that is not codecast's. */
const P = evalsPaths(BASE).href;
const SURFACE = 'settle';
const BREAKS = 'aa11bb22-0000-4000-8000-000000000001';
const HOLDS = 'cc33dd44-0000-4000-8000-000000000002';
const NIGHT = (n: number) => new Date(Date.parse('2026-10-01T02:00:00.000Z') + n * 86_400_000).toISOString();
const HEAD = (n: number) => (n < 4 ? 'a'.repeat(40) : 'b'.repeat(40));
const NAMES: Record<string, string> = { [BREAKS]: 'waiting-on-a-reply', [HOLDS]: 'already-answered' };

function rep(freeze: string, night: number, seed: number): RunRowCore {
  const batch = NIGHT(night);
  const score = freeze === BREAKS && night >= 4 ? 0.3 + seed / 100 : 0.85 + seed / 100;
  return {
    id: `${SURFACE}-${freeze.slice(0, 8)}-n${night}-s${seed}`, surface: SURFACE, freezeId: freeze, freezeName: NAMES[freeze], visibility: freeze === BREAKS ? 'private' : 'public',
    seed, stamp: new Date(Date.parse(batch) + seed * 60_000).toISOString(), batch, batchAt: batch, cadence: 'nightly', status: score >= 0.7 ? 'pass' : 'fail',
    score, passMark: 0.7, gatesFailed: [], checks: { tone: score }, missedFloors: [], model: 'sonnet', judgeModel: 'judge-1', ruler: 'r1',
    gitHead: HEAD(night), mainSha: HEAD(night), dirty: false, offBranch: false, treePatch: null, sourceHashDisk: null, promptSha: night < 4 ? 'p1p1p1p1' : 'p2p2p2p2', freezeSha: null,
    liveReads: 0, costUsd: 0.01, judgeCostUsd: 0.002, realMs: 1000,
  };
}

const ROWS: RunRowCore[] = [];
for (let night = 0; night < 5; night++) for (const f of [BREAKS, HOLDS]) for (let seed = 1; seed <= 3; seed++) ROWS.push(rep(f, night, seed));
ROWS.reverse();

const rowOf = (id: string | null) => ROWS.find((r) => r.id === id)!;
const nightOf = (r: RunRowCore) => (r.batch! < NIGHT(4) ? 'before' : 'after');
const promptText = (runId: string, file: string) => {
  const r = rowOf(runId);
  if (file.endsWith('system.md')) return nightOf(r) === 'before' ? 'You settle threads.' : 'You settle threads, and never twice.';
  return `Thread for ${r.freezeName}`;
};
const FILES = ['call1/system.md', 'call1/prompt.md'];
const replyOf = (r: RunRowCore) => (r.status === 'pass' ? `Done: ${r.freezeName}` : `Still open: ${r.freezeName}`);

const COMMITS: CommitRef[] = [
  { sha: 'c'.repeat(40), subject: 'settle: never answer twice', author: 'Ada Lovelace', at: NIGHT(3.5), session: 'jx7abcdef', mainSha: 'c'.repeat(40), onMain: true },
  { sha: 'd'.repeat(40), subject: 'settle: tighten the prompt', author: 'Grace Hopper', at: NIGHT(3.7), session: null, mainSha: 'd'.repeat(40), onMain: true },
];

const SURFACES: QuerySurface[] = [{ id: SURFACE, title: 'Settle', route: 'call', model: 'sonnet' }];

function freezePage(id: string, rows: RunRowCore[]): Omit<FreezeResponse, 'epochs'> | null {
  const full = [BREAKS, HOLDS].find((f) => f.startsWith(id));
  if (!full) return null;
  const at = (m: number) => new Date(Date.parse(NIGHT(0)) - (10 - m) * 60_000).toISOString();
  const line = (n: number, direction: 'in' | 'out' | 'system', from: string, text: string) => ({ n, id: `m${n}`, at: at(n), channel: 'chat', isGroup: false, direction, from, text });
  return {
    freeze: {
      id: full, name: NAMES[full], surface: SURFACE, visibility: full === BREAKS ? 'private' : 'public', createdAt: NIGHT(-1), asOf: at(2),
      anchor: { kind: 'message', id: 'm2' }, subject: { kind: 'thread', id: 't1', title: 'Lunch on Friday' }, trigger: null, notes: null,
      judge: 'Settle the thread once, and only when it is settled.', tags: [], freezeSha: 'f'.repeat(40),
    },
    label: { verdict: 'waiting', why: 'The other side has not answered yet.' },
    labelSource: 'labels',
    moment: [line(1, 'in', 'Sam', 'Lunch on Friday?'), line(2, 'out', 'agent', 'Asked Sam about Friday.'), line(3, 'in', 'Sam', 'Friday works.'), line(4, 'system', 'tool', 'thread closed')],
    cutAt: 2,
    production: { messages: [line(5, 'out', 'agent', '{"state":"waiting"}')], verdict: { score: 0.9, pass: true, reasoning: 'Waited for Sam.' } },
    runs: rows.filter((r) => r.freezeId === full),
  };
}

/** A full product: freezes, each rep's anatomy, two-run diffs, prompt files and git. `attribution` false leaves git out. */
function product({ git = true, freezes = true } = {}) {
  const src: EvalsSources = {
    rows: async () => ROWS,
    surfaces: () => SURFACES,
    prompts: { files: () => FILES, text: promptText, size: (id, f) => promptText(id, f).length },
    run: async (row) => {
      const detail: RunDetail<RunRowCore> & { calls: Array<{ dir: string; system: string | null; prompt: string; reply: string | null }> } = {
        result: null,
        score: { pass: row.status === 'pass', score: row.score!, passMark: 0.7, gates: [], checks: [{ id: 'tone', weight: 1, score: row.score!, reasoning: row.status === 'pass' ? 'Waited, as it should.' : 'Answered a settled thread again.' }] },
        scoreVersions: [],
        rubric: null,
        sends: [],
        judge: null,
        logTail: null,
        calls: [{ dir: 'call1', system: promptText(row.id, 'call1/system.md'), prompt: promptText(row.id, 'call1/prompt.md'), reply: replyOf(row) }],
      };
      return detail;
    },
    pair: (a, b) => ({
      diff: rowOf(a).status === rowOf(b).status ? [] : [{ kind: 'check', id: 'tone', before: rowOf(a).score!, after: rowOf(b).score! } satisfies RunDiffEntry],
      replies: { a: replyOf(rowOf(a)), b: replyOf(rowOf(b)) },
    }),
    flipExamples: async (_surface, ids) => ids.map((id) => ({ freeze: id, name: NAMES[id], direction: 'broke' as const, input: 'Friday works.', before: 'Done.', after: 'Still open.', note: 'Answered twice.' })),
    ...(freezes ? { freezes: { counts: async () => () => ({ public: 1, private: 1 }), get: async (id: string, rows: RunRowCore[]) => freezePage(id, rows) } } : {}),
    ...(git
      ? {
          git: {
            verify: () => {},
            touching: () => COMMITS,
            between: () => COMMITS,
            commit: () => {
              throw new Error('not read here');
            },
            attribution: {} as never,
            meta: {} as never,
          },
        }
      : {}),
  };
  const policy = { passed: (r: { status: string }) => r.status === 'pass', ruler: (r: { ruler?: string | null }) => r.ruler ?? null };
  return createEvalsHandler(src, policy);
}

/** A product with rows and surfaces alone: no freezes, no prompts, no git. */
const rowsOnly = () => createEvalsHandler({ rows: async () => ROWS, surfaces: () => SURFACES }, { passed: (r) => r.status === 'pass', ruler: () => null });

async function ask<T>(handle: ReturnType<typeof product>, path: string, query: Record<string, string> = {}): Promise<T> {
  const res = await localTransport(handle).send({ method: 'GET', path, query });
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as T;
}

// ── Mounting ────────────────────────────────────────────────────────────────

const tick = (ms = 0) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** Ticks until `check` stops throwing, so a slow machine waits longer instead of failing. */
async function until(check: () => void, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return check();
    } catch (e) {
      if (Date.now() > end) throw e;
      await tick(10);
    }
  }
}

async function mount(node: ReactNode) {
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(node));
  await tick(5);
  return {
    container,
    q: (sel: string) => container.querySelector(sel) as unknown as HTMLElement | null,
    all: (sel: string) => [...container.querySelectorAll(sel)] as unknown as HTMLElement[],
    unmount: () => act(async () => root.unmount()),
  };
}

const click = (el: Element | null, init: { shiftKey?: boolean } = {}) =>
  act(async () => {
    if (!el) throw new Error('nothing to click');
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ...init }) as unknown as Event);
  });

/** The area at `href`: the address moves to it (the default host reads the query from the location), and EvalsApp routes its path. */
function app(handle: ReturnType<typeof product>, href: string) {
  win.history.replaceState(null, '', href);
  return (
    <R.EvalsProvider transport={localTransport(handle)} host={{ basePath: BASE }}>
      <R.EvalsApp path={href.split('?')[0]} />
    </R.EvalsProvider>
  );
}

const query = (href: string) => new URLSearchParams(href.split('?')[1] ?? '');

// ── The freeze page ─────────────────────────────────────────────────────────

describe('the freeze page', () => {
  it('opens on the pair either side of the newest break, and paints the label, production and the moment cut where it was frozen', async () => {
    const m = await mount(app(product(), P.freeze(BREAKS)));
    await until(() => expect(m.q(`[data-evals-freeze="${BREAKS}"]`)).not.toBeNull());
    const surface = await ask<SurfaceResponse>(product(), `/surface/${SURFACE}`);
    const pick = defaultFreezePair(ROWS.filter((r) => r.freezeId === BREAKS), surface.ledger.find((r) => r.freezeId === BREAKS)!.cells, null);
    expect(pick.flip?.direction).toBe('broke');
    expect(rowOf(pick.a).status).toBe('pass');
    expect(rowOf(pick.b).status).toBe('fail');
    await until(() => expect(m.q(`[data-ev-card-slot="B"] [data-ev-reply="${pick.b}"]`)).not.toBeNull());
    expect(m.q(`[data-ev-card-slot="A"] [data-ev-reply="${pick.a}"]`)).not.toBeNull();

    expect(m.q('[data-ev-label-verdict]')!.textContent).toContain('waiting');
    expect(m.q('[data-ev-production]')!.textContent).toContain('{"state":"waiting"}');
    const lines = m.all('[data-ev-moment-line]');
    expect(lines.map((l) => l.getAttribute('data-ev-moment-line'))).toEqual(['before', 'before', 'after', 'after']);
    // The cut sits right before the first line after it.
    expect(m.q('[data-ev-frozen-cut]')!.parentElement!.querySelector('[data-ev-moment-line]')!.getAttribute('data-ev-moment-line')).toBe('after');
    await m.unmount();
  });

  it('draws every rep as a dot with the break notched and A and B ringed, and the prompt change between the two cards', async () => {
    const m = await mount(app(product(), P.freeze(BREAKS)));
    await until(() => expect(m.q('[data-ev-prompt-changed]')).not.toBeNull());
    expect(m.all('[data-ev-rep]').length).toBe(ROWS.filter((r) => r.freezeId === BREAKS && shownRep(r)).length);
    expect(m.all('[data-ev-strip-flip="broke"]').length).toBe(1);
    expect(m.all('[data-ev-epoch-band]').length).toBe(2);
    const order = [...m.q('[data-ev-cards]')!.children].map((c) => (c.hasAttribute('data-ev-card-slot') ? c.getAttribute('data-ev-card-slot') : c.hasAttribute('data-ev-prompt-changed') ? 'banner' : 'other'));
    expect(order).toEqual(['A', 'banner', 'B']);
    expect(m.q('[data-ev-card-slot="A"]')!.textContent).toContain('before the flip');
    expect(m.q('[data-ev-card-slot="B"]')!.textContent).toContain('after the flip');
    expect(m.q('[data-ev-prompt-changed]')!.textContent).toContain('1 file differs');
    // A prompt change is a new epoch, not a verdict: the banner borrows no pass, fail or gate colour.
    expect([...m.q('[data-ev-prompt-changed]')!.classList].filter((c) => /^ev-(pass|fail|gate)$/.test(c))).toEqual([]);
    expect(m.q('[data-ev-pair-why]')!.textContent).toMatch(/newest flip/);
    await m.unmount();
  });

  it('links under the host base path: the surface, each card, and the attribution launcher for this freeze and the pair', async () => {
    const m = await mount(app(product(), P.freeze(BREAKS)));
    await until(() => expect(m.q('[data-ev-card-slot="B"] [data-ev-reply]')).not.toBeNull());
    expect(m.q(`a[href="${P.surface(SURFACE)}"]`)).not.toBeNull();
    const launcher = m.q('[data-ev-attribute]')!.getAttribute('href')!;
    expect(launcher.startsWith(`${P.bisectList()}/new?`)).toBe(true);
    expect(query(launcher).get('freeze')).toBe(BREAKS.slice(0, 8));
    expect(query(launcher).get('good')).toBe(evalsBatchRef(NIGHT(3)));
    expect(query(launcher).get('bad')).toBe(evalsBatchRef(NIGHT(4)));
    expect(m.q('[data-ev-copy] code')!.textContent).toBe(`./evals freeze replay ${BREAKS} --reps 3`);
    await m.unmount();
  });

  it('sets A then B from clicks on the dots, reads each new rep, and swaps them', async () => {
    const m = await mount(app(product(), P.freeze(BREAKS)));
    await until(() => expect(m.q('[data-ev-card-slot="B"] [data-ev-reply]')).not.toBeNull());
    const early = ROWS.filter((r) => r.freezeId === BREAKS && r.batch === NIGHT(0));
    await click(m.q(`[data-ev-rep="${early[0].id}"]`));
    await until(() => expect(m.q(`[data-ev-card-slot="A"] [data-ev-reply="${early[0].id}"]`)).not.toBeNull());
    expect(m.q('[data-ev-next-slot]')!.getAttribute('data-ev-next-slot')).toBe('b');
    await click(m.q(`[data-ev-rep="${early[1].id}"]`));
    await until(() => expect(m.q(`[data-ev-card-slot="B"] [data-ev-reply="${early[1].id}"]`)).not.toBeNull());
    // The same prompt on both, and a picked pair tells its own story.
    expect(m.q('[data-ev-prompt-same]')!.textContent).toMatch(/Same prompt/);
    expect(m.q('[data-ev-pair-title]')!.getAttribute('data-ev-pair-title')).toBe('picked');
    await click(m.q('[data-ev-swap]'));
    await until(() => expect(m.q(`[data-ev-card-slot="A"] [data-ev-reply="${early[1].id}"]`)).not.toBeNull());
    expect(m.q(`[data-ev-selected-rep="${early[1].id}"]`)!.textContent).toBe('A');
    // Production against B, through the default segmented toggle.
    await click(m.all('[role="radio"]').find((b) => b.textContent === 'prod and B') ?? null);
    expect(m.q('[data-ev-cards]')!.getAttribute('data-ev-cards')).toBe('prod-b');
    expect(m.q('[data-ev-cards]')!.children[0].hasAttribute('data-ev-production')).toBe(true);
    await m.unmount();
  });

  it('opens on the two reps a flip link names', async () => {
    const [a, b] = [ROWS.find((r) => r.freezeId === BREAKS && r.batch === NIGHT(1))!, ROWS.find((r) => r.freezeId === BREAKS && r.batch === NIGHT(4))!];
    const m = await mount(app(product(), P.freeze(BREAKS, { a: a.id, b: b.id })));
    await until(() => expect(m.q(`[data-ev-card-slot="B"] [data-ev-reply="${b.id}"]`)).not.toBeNull());
    expect(m.q(`[data-ev-card-slot="A"] [data-ev-reply="${a.id}"]`)).not.toBeNull();
    await m.unmount();
  });

  it('says plainly when the freeze is not kept, and hides the launcher where the product cannot attribute', async () => {
    const missing = await mount(app(product(), P.freeze('00000000')));
    await until(() => expect(missing.container.textContent).toContain('No freeze with this id'));
    expect(missing.q(`a[href="${P.home()}"]`)).not.toBeNull();
    await missing.unmount();

    const noGit = await mount(app(product({ git: false }), P.freeze(BREAKS)));
    await until(() => expect(noGit.q(`[data-evals-freeze="${BREAKS}"]`)).not.toBeNull());
    expect(noGit.q('[data-ev-attribute]')).toBeNull();
    await noGit.unmount();
  });

  it('shows a product that keeps no freezes no freeze page, rather than a missing freeze', async () => {
    const m = await mount(app(rowsOnly(), P.freeze(BREAKS)));
    await until(() => expect(m.container.textContent).toContain('This product has no page for the freeze'));
    expect(m.container.textContent).not.toContain('No freeze with this id');
    await m.unmount();
  });
});

// ── Two runs side by side ───────────────────────────────────────────────────

describe('the compare page', () => {
  const a = ROWS.find((r) => r.freezeId === BREAKS && r.batch === NIGHT(3))!;
  const b = ROWS.find((r) => r.freezeId === BREAKS && r.batch === NIGHT(4))!;

  it('draws both sides, what moved, both replies and the prompt that changed, with a swap under the base path', async () => {
    const m = await mount(app(product(), P.compare(a.id, b.id)));
    await until(() => expect(m.q('[data-evals-compare]')).not.toBeNull());
    expect(m.all('[data-ev-cmp-side]').map((s) => s.getAttribute('data-ev-cmp-side'))).toEqual(['A', 'B']);
    expect(m.q('[data-ev-diff="check:tone"]')!.getAttribute('data-ev-diff-tone')).toBe('broke');
    expect(m.q('[data-ev-diff="check:tone"] a')!.getAttribute('href')).toBe(P.run(b.id, 'check-tone'));
    expect(m.container.textContent).toContain(replyOf(a));
    expect(m.container.textContent).toContain(replyOf(b));
    expect(m.all('[data-ev-prompt-diff]').length).toBeGreaterThan(0);
    expect(m.q('[data-ev-swap]')!.getAttribute('href')).toBe(P.compare(b.id, a.id));
    await m.unmount();
  });

  it('says plainly when a run is not in the index', async () => {
    const m = await mount(app(product(), P.compare(a.id, 'settle-nope')));
    await until(() => expect(m.container.textContent).toContain('One of these runs is not in the index'));
    await m.unmount();
  });
});

// ── The parts the surface page borrows ──────────────────────────────────────

describe("the surface page's plate, drawer and sheet", () => {
  const handle = product();
  const provider = (node: ReactNode, h = handle) => (
    <R.EvalsProvider transport={localTransport(h)} host={{ basePath: BASE }}>
      {node}
    </R.EvalsProvider>
  );

  it('draws the plate from the ledger: the breaking freeze first, a numbered pin per pinned column, and wells that open the freeze at a batch', async () => {
    const surface = await ask<SurfaceResponse>(handle, `/surface/${SURFACE}`);
    const columns = surfaceColumns(surface.batches, 'ordinal', 900).list.filter((c) => !c.stats.dry);
    const picks: Array<[string, boolean]> = [];
    const flips = new Map([[BREAKS, 'broke' as const]]);
    const m = await mount(provider(<R.FreezeLedger rows={surface.ledger} columns={columns} pinned={NIGHT(3)} compare={NIGHT(4)} hover={null} onHover={() => {}} onPick={(b, second) => picks.push([b, second])} pairFlips={flips} />));
    expect(m.all('[data-ev-ledger-row]').map((r) => r.getAttribute('data-ev-ledger-row'))).toEqual([BREAKS, HOLDS]);
    expect(m.q(`[data-ev-ledger-row="${BREAKS}"]`)!.getAttribute('data-ev-pair-flip')).toBe('broke');
    expect(m.all('.ev-sf-plate-pin').map((p) => p.textContent)).toEqual(['1', '2']);
    expect(m.q(`[data-ev-ledger-row="${BREAKS}"] a.ev-sf-plate-link`)!.getAttribute('href')).toBe(P.freeze(BREAKS));
    expect(query(m.q(`[data-ev-ledger-row="${BREAKS}"] a.ev-sf-well-link`)!.getAttribute('href')!).get('batch')).toBeTruthy();
    await click(m.q(`[data-ev-col="${NIGHT(1)}"] button`), { shiftKey: true });
    expect(picks).toEqual([[NIGHT(1), true]]);
    await m.unmount();
  });

  it('weighs two batches in the drawer with the default slots: the verdict, the flipped freeze as a before and after pair, and the launcher with its key', async () => {
    const surface = await ask<SurfaceResponse>(handle, `/surface/${SURFACE}`);
    const res = await ask<BatchesResponse>(handle, '/batches', { surface: SURFACE, a: NIGHT(3), b: NIGHT(4) });
    const stats = (b: string) => surface.batches.find((s) => s.batch === b)!;
    const panel = (h = handle) => provider(<R.ComparePanel surface={SURFACE} route="call" a={stats(NIGHT(3))} b={stats(NIGHT(4))} res={res} loading={false} error={null} onClose={() => {}} />, h);
    const m = await mount(panel());
    await until(() => expect(m.q('[data-ev-attribute]')).not.toBeNull());
    expect(m.q('[data-ev-compare-verdict]')).not.toBeNull();
    expect(m.all('[data-ev-set]').map((s) => s.getAttribute('data-ev-set'))).toEqual(['1', '2']);
    expect(m.all('[data-ev-example]').map((e) => e.getAttribute('data-ev-example'))).toEqual(['broke']);
    expect(m.q('[data-ev-flip="broke"] .ev-pair-before')!.textContent).toContain('Done.');
    expect(m.q('[data-ev-example] a.ev-sf-example-name')!.getAttribute('href')!.startsWith(`${P.freeze(BREAKS)}?`)).toBe(true);
    const launcher = m.q('[data-ev-attribute]')!;
    expect(launcher.getAttribute('href')!.startsWith(`${P.bisectList()}/new?`)).toBe(true);
    expect(launcher.querySelector('kbd')!.textContent).toBe('b');
    expect(m.q('[data-ev-compare-prompt]')).not.toBeNull();
    await m.unmount();

    // The launcher shows until /health says the product cannot attribute.
    const noGit = await mount(panel(product({ git: false })));
    await until(() => expect(noGit.q('[data-ev-attribute]')).toBeNull());
    expect(noGit.q('[data-ev-compare-verdict]')).not.toBeNull();
    await noGit.unmount();

    // A product with rows alone keeps no prompt files and no freeze pages: no "What the model saw", and the flipped case is named, not linked.
    const bare = await mount(panel(rowsOnly()));
    await until(() => expect(bare.q('[data-ev-attribute]')).toBeNull());
    expect(bare.q('[data-ev-compare-flips]')).not.toBeNull();
    expect(bare.q('[data-ev-compare-prompt]')).toBeNull();
    expect(bare.q('a.ev-sf-example-name')).toBeNull();
    expect(bare.q('[data-ev-lock]')).toBeNull();
    await bare.unmount();
  });

  it('opens the epoch sheet through the default sheet: the prompts either side of the boundary and the commits in the window', async () => {
    const res = await ask<EpochResponse>(handle, '/epoch', { surface: SURFACE, n: '2' });
    let closed = 0;
    const m = await mount(provider(<R.EpochDiffSheet surface={SURFACE} n={2} res={res} loading={false} error={null} freezeNames={NAMES} onClose={() => closed++} />));
    const sheet = win.document.body.querySelector('[data-ev-epoch-sheet="2"]') as unknown as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(sheet.textContent).toContain('The prompt changed at epoch 2');
    expect([...sheet.querySelectorAll('[data-ev-epoch-freeze]')].map((e) => e.getAttribute('data-ev-epoch-freeze')).sort()).toEqual([BREAKS, HOLDS].sort());
    expect(sheet.querySelectorAll('[data-ev-commit]').length).toBe(COMMITS.length);
    expect(sheet.querySelector(`[data-ev-commit="${COMMITS[0].sha}"] a`)!.getAttribute('href')).toBe(P.commit(COMMITS[0].sha, { surface: SURFACE }));
    expect(sheet.querySelector('kbd')!.textContent).toBe('esc');
    await act(async () => void win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' })));
    expect(closed).toBe(1);
    await m.unmount();
  });

  it('registers the freeze and compare pages with EvalsApp', () => {
    expect(Object.keys(R.freezePages).sort()).toEqual(['compare', 'freeze']);
  });
});
