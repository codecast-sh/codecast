/**
 * The Bisect group, mounted in happy-dom under a host at another base path:
 * the free answer lights the first class that differs; a pinned answer shows
 * its commit and offers no plan; a narrowed one is priced and started through
 * the host's bisect actions, and a host without them gets the answer alone;
 * a live bisect draws its ruler and rail, with Stop only through the host; a
 * commit names its session only through a host that reads one; a kept patch
 * opens through the host's usePatch; the list puts running bisects first;
 * and a product whose /health turns bisect, attribution or commits off shows
 * none of these pages.
 */
import { describe, expect, it } from 'bun:test';
import type { Attribution, AttributionAnswer, BisectPlan, BisectResponse, BisectState, BisectSummary, Candidate, CommitRef, CommitResponse, EvalsBridgeRequest, Endpoint, HealthResponse } from '../../contract';
import { NIGHT, installDom, rep } from '../../mountKit';
import type { ReactNode } from 'react';
import type { BisectActions, EvalsHostInput } from '../host';

const { until, mount, click } = await installDom('https://host.test/lab');
const { evalsPaths, localTransport } = await import('../../client');
const { ATTRIBUTION_CLASSES, EVALS_VIEW_ROUTE_KEYS, matchRoute } = await import('../../contract');
const { createEvalsHandler } = await import('../../query');
// The group's own barrel and the provider: the other groups' code is not on this test's path.
const R = { ...(await import('.')), ...(await import('../EvalsProvider')) };
/** The whole area, loaded where a case routes through it. */
const area = async () => (await import('../EvalsApp')).EvalsApp;

const BASE = '/lab';
const paths = evalsPaths(BASE);

// ── A product with bisects: records, commits and two bisects ─────────────────

const SHA = (n: number) => n.toString(16).padStart(2, '0').repeat(20);

function commit(n: number, extra: Partial<CommitRef> = {}): CommitRef {
  return { sha: SHA(n), subject: `change ${n}`, author: 'ada', at: NIGHT(n), session: null, mainSha: SHA(n), onMain: true, ...extra };
}

const end = (night: number, sha: string): Endpoint => ({ batch: NIGHT(night), sha, mainSha: sha, dirty: false, treePatch: null, footing: { model: 'model-a', ruler: 'ruler-a' }, at: NIGHT(night) });

const source = (confidence: 'pinned' | 'narrowed' | 'empty', candidates: Candidate[]): AttributionAnswer => ({
  kind: 'source', confidence, candidates, narrowedBy: [{ batch: NIGHT(1), sha: SHA(2), verdict: 'good', reps: 3 }], epochs: [], noDeclaredSourceMoved: false, rangeCommits: candidates.length, reason: null,
});

function attribution(answer: AttributionAnswer): Attribution {
  return {
    surface: 'outreach',
    good: end(0, SHA(1)),
    bad: end(3, SHA(4)),
    mode: 'flip',
    flipped: [{ freezeId: 'fb02cafe', name: 'the broken moment', visibility: 'private', direction: 'broke', before: ['r-good'], after: ['r-bad'] }],
    checklist: ATTRIBUTION_CLASSES.map((c) => ({ class: c, differs: c === answer.kind, detail: `the ${c} line` })),
    answer,
    promptDiffs: [],
    examples: [{ freeze: 'fb02cafe', name: 'the broken moment', direction: 'broke', input: 'hello', before: 'old reply', after: 'new reply', note: 'the gate failed' }],
  };
}

const CANDIDATES: Candidate[] = [
  { kind: 'commit', commit: commit(3, { session: 'jx7abcd' }), renderClass: null },
  { kind: 'commit', commit: commit(2), renderClass: null },
  { kind: 'patch', base: SHA(4), treePatch: 'ee'.repeat(20), renderClass: null },
];

const ANSWERS: Record<string, Attribution> = {
  footing: attribution({ kind: 'footing', change: 'model', from: 'model-a', to: 'model-b' }),
  pinned: attribution(source('pinned', CANDIDATES.slice(0, 1))),
  narrowed: attribution(source('narrowed', CANDIDATES)),
};

const PLAN: BisectPlan = {
  surface: 'outreach', good: ANSWERS.narrowed.good, bad: ANSWERS.narrowed.bad, attribution: ANSWERS.narrowed,
  freezes: [{ id: 'fb02cafe', name: 'the broken moment', role: 'flipped' }, { id: 'fa01beef', name: 'a stable moment', role: 'control' }],
  reps: 3, candidates: CANDIDATES, classes: null,
  bound: { classes: 3, probes: 2, freezes: 2, reps: 3, maxReps: 24, perRepUsd: 0.01, judgePerRepUsd: 0.001, maxUsd: 0.5 },
  budgetUsd: 0.6, maxMinutes: 30, allCommits: false, needsConfirm: false, summary: 'Two probes at most, 24 reps, $0.50.',
};

const LIVE_ID = 'outreach-20261003T120000';
const DONE_ID = 'outreach-20261002T090000';

function state(id: string, live: boolean): BisectState {
  return {
    id, surface: 'outreach', seq: 4, status: live ? 'probing' : 'done', tier: 2,
    range: { good: NIGHT(0), bad: NIGHT(3) }, candidates: CANDIDATES, classes: null,
    probes: [
      { sha: SHA(1), kind: 'control-good', renderClass: null, batch: NIGHT(0), recorded: false, verdict: 'good', skipReason: null, costUsd: 0.03,
        reps: [{ freezeId: 'fb02cafe', runId: 'r-good', passed: true, score: 0.9 }, { freezeId: 'fb02cafe', runId: null, passed: null, score: null }] },
    ],
    spentUsd: 0.12, budgetUsd: 0.6, startedAt: NIGHT(2), updatedAt: NIGHT(2), finishedAt: live ? null : NIGHT(2.5), tmux: live ? 'evals-bisect' : null,
    answer: live ? null : { kind: 'culprit', commit: commit(3, { session: 'jx7abcd' }), separation: { kind: 'worse', p: 0.01 }, tier: 2 },
    plan: PLAN,
  };
}

const bisect = (id: string, live: boolean): BisectResponse => ({
  state: state(id, live), cursor: 4, logTail: ['probe 1 of 2'], stalled: false,
  steps: [{ seq: 1, at: NIGHT(2), kind: 'plan', sha: null, text: `between ${NIGHT(0)} and ${NIGHT(3)}` }],
  controls: { good: { passed: 3, reps: 3 }, bad: { passed: 0, reps: 3 }, separation: { kind: 'worse', p: 0.01 } },
});

const summary = (id: string, live: boolean, startedNight: number): BisectSummary => ({
  id, surface: 'outreach', good: NIGHT(0), bad: NIGHT(3), status: live ? 'probing' : 'done', outcome: live ? null : 'culprit',
  culprit: live ? null : SHA(3), spentUsd: 0.12, budgetUsd: 0.6, startedAt: NIGHT(startedNight), updatedAt: new Date().toISOString(), finishedAt: live ? null : NIGHT(startedNight + 0.5),
});

const commitAnswer = (sha: string, whole: boolean): CommitResponse => ({
  commit: commit(3, { session: 'jx7abcd' }), parents: [SHA(2)], body: `change 3\n\nWhy it changed.\nSession: jx7abcd`, whole,
  files: [{ path: 'prompts/outreach.md', status: 'M', additions: 2, deletions: 1 }], diff: '', truncated: false,
});

const health = (capabilities?: HealthResponse['capabilities']): HealthResponse => ({ root: '/repo', evalsHome: '/home', gitHead: SHA(9), runsIndexed: 24, index: { state: 'warm', done: 24, total: 24 }, pid: 1, startedAt: NIGHT(0), ...(capabilities ? { capabilities } : {}) });

/** The answers a full product gives, by route: what codecast's api child serves for these pages. */
function product(asked: string[] = []) {
  return localTransport(async (req: EvalsBridgeRequest) => {
    asked.push(`${req.method} ${req.path}${req.query && Object.keys(req.query).length ? `?${new URLSearchParams(req.query)}` : ''}`);
    const route = matchRoute(EVALS_VIEW_ROUTE_KEYS, req.method, req.path);
    const q = req.query ?? {};
    switch (route?.key) {
      case 'GET /health':
        return { status: 200, body: health() };
      case 'GET /overview':
        return { status: 200, body: { cadence: 'nightly', surfaces: [{ id: 'outreach', strip: [] }], moved: [], spendByDay: [], bisects: [] } };
      case 'GET /attribution':
        return { status: 200, body: q.good === NIGHT(1) ? ANSWERS.pinned : q.good === NIGHT(2) ? ANSWERS.footing : ANSWERS.narrowed };
      case 'GET /commit/:sha':
        return { status: 200, body: commitAnswer(route.params.sha, q.whole === 'true') };
      case 'GET /bisects':
        return { status: 200, body: { bisects: [summary(DONE_ID, false, 1), summary(LIVE_ID, true, 2)], running: LIVE_ID } };
      case 'GET /bisect/:id':
        return route.params.id === LIVE_ID || route.params.id === DONE_ID ? { status: 200, body: bisect(route.params.id, route.params.id === LIVE_ID) } : { status: 404, body: { error: 'no such bisect' } };
      default:
        return { status: 404, body: { error: 'no route' } };
    }
  }, 'fixture');
}

/** A host's bisect actions that record what they were asked. */
function actions(log: string[]): BisectActions {
  return {
    plan: async (req) => (log.push(`plan ${req.freezes ? req.freezes.join(',') : 'default'} x${req.reps}`), PLAN),
    start: async (req) => (log.push(`start ${req.surface} ${req.good}..${req.bad}`), { id: 'outreach-20261004T080000', tmux: null }),
    stop: async (id) => (log.push(`stop ${id}`), { ok: true }),
  };
}

/** A host at /lab that records where it was sent. */
function hostAt(extra: EvalsHostInput = {}, went: string[] = []): EvalsHostInput {
  return { basePath: BASE, useNavigate: () => (href: string) => void went.push(href), ...extra };
}

async function page(node: ReactNode, host: EvalsHostInput, transport = product()) {
  return mount(<R.EvalsProvider transport={transport} host={host}>{node}</R.EvalsProvider>);
}

const viewOf = <V extends string>(path: string, query = '') => paths.parse(`${BASE}${path}`, query) as Extract<ReturnType<typeof paths.parse>, { view: V }>;

// ── The tests ───────────────────────────────────────────────────────────────

describe('the free answer', () => {
  it('lights the first class that differs, reads the ones before it as same, and leaves the rest unreached', async () => {
    const m = await page(<R.AttributionView attribution={ANSWERS.narrowed} />, hostAt());
    const states = m.all('[data-evb-class]').map((li) => `${li.getAttribute('data-evb-class')}:${li.getAttribute('data-state')}`);
    expect(states).toEqual(['footing:same', 'freeze:same', 'live-reads:same', 'source:answer', 'noise:after']);
    expect(m.q('[data-evb-answer]')!.getAttribute('data-evb-answer')).toBe('source');
    expect(m.q('[data-evb-confidence]')!.getAttribute('data-evb-confidence')).toBe('narrowed');
    // Oldest candidate first, the patch last, and every link under the host's base.
    expect(m.all('[data-evb-candidate]').map((c) => c.getAttribute('data-evb-candidate'))).toEqual([SHA(2), SHA(3), 'patch']);
    const links = m.all('a').map((a) => a.getAttribute('href')!);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((h) => h.startsWith(`${BASE}/`))).toBe(true);
    // A flip's before and after stay side by side: the default pair draws no stacking box.
    expect(m.q('[data-evb-examples] [data-ev-flip="broke"] .ev-pair')).not.toBeNull();
    expect(m.q('[data-evb-examples] .ev-pair-box')).toBeNull();
    await m.unmount();
  });

  it('opens a candidate commit and a kept patch in place, the patch through the host or as not kept', async () => {
    const withPatch = hostAt({ usePatch: (sha) => ({ data: { sha, files: [{ path: 'a.md', additions: 1, deletions: 0 }], diff: '', truncated: false }, loading: false, error: null }) });
    for (const [host, word] of [[withPatch, 'patch eeeeeeeeee'], [hostAt(), 'keeps no tree patches']] as const) {
      const m = await page(<R.CandidateList candidates={CANDIDATES} surface="outreach" />, host);
      await click(m.q('[data-evb-candidate="patch"]')!);
      expect(m.q('.ev-b-cand-body')!.textContent).toContain(word);
      await click(m.q(`[data-evb-candidate="${SHA(3)}"]`)!);
      await until(() => expect(m.q(`[data-evb-commit="${SHA(3)}"]`)).not.toBeNull());
      expect(m.q('[data-evb-commit]')!.textContent).toContain('prompts/outreach.md');
      await m.unmount();
    }
  });

  it('names a commit\'s session only through a host that reads one, and shows the message whole otherwise', async () => {
    const pill = ({ id }: { id: string }) => <span data-test-session={id} />;
    const reads = hostAt({ ui: { SessionPill: pill }, commitSession: { id: (t) => (t.startsWith('jx7') ? t : null), strip: (msg) => msg.replace(/\nSession: .*$/m, '') } });
    const view = <R.CommitPanelView data={commitAnswer(SHA(3), false)} whole={false} onWhole={() => {}} />;
    const a = await page(view, reads);
    expect(a.q('[data-test-session]')!.getAttribute('data-test-session')).toBe('jx7abcd');
    expect(a.q('.ev-b-commit-body')!.textContent).toBe('Why it changed.');
    await a.unmount();
    const b = await page(view, hostAt({ ui: { SessionPill: pill } }));
    expect(b.q('[data-test-session]')).toBeNull();
    expect(b.q('.ev-b-commit-body')!.textContent).toContain('Session: jx7abcd');
    await b.unmount();
  });
});

describe('attributing a regression', () => {
  const at = (good: string) => viewOf<'bisect-new'>('/bisect/new', `surface=outreach&good=${good}&bad=${NIGHT(3)}`);

  it('shows a pinned answer\'s commit and no plan', async () => {
    const log: string[] = [];
    const m = await page(<R.BisectNewPage view={at(NIGHT(1))} />, hostAt({ useBisectActions: () => actions(log) }));
    await until(() => expect(m.q('[data-evb-answer="source"]')).not.toBeNull());
    await until(() => expect(m.q(`[data-evb-commit="${SHA(3)}"]`)).not.toBeNull());
    expect(m.q('[data-evb-plan]')).toBeNull();
    expect(log).toEqual([]);
    await m.unmount();
  });

  it('prices a narrowed range through the host, starts it, and goes to the new bisect under the host\'s base', async () => {
    const log: string[] = [];
    const went: string[] = [];
    const m = await page(<R.BisectNewPage view={at(NIGHT(0))} />, hostAt({ useBisectActions: () => actions(log) }, went));
    await until(() => expect(m.q('[data-evb-plan="priced"]')).not.toBeNull());
    expect(m.q('[data-evb-cost]')!.textContent).toContain('Two probes at most');
    // The one-bisect lock: the running bisect holds Start, and is named with a link.
    expect(m.q('[data-evb-blocked]')!.getAttribute('data-evb-blocked')).toBe(LIVE_ID);
    expect((m.q('[data-evb-start]') as HTMLButtonElement).disabled).toBe(true);
    // A bisect already over this range is listed before anyone pays again.
    expect(m.all('[data-evb-prior-row]').map((r) => r.getAttribute('data-evb-prior-row'))).toContain(DONE_ID);
    // The first plan is the default set (one request: seeding the defaults costs no second).
    expect(log).toEqual(['plan default x3']);
    await m.unmount();

    // A free machine: Start goes through the host and lands on the new bisect.
    const free = localTransport(async (req) => {
      if (req.path === '/bisects') return { status: 200, body: { bisects: [], running: null } };
      return (await product().send(req)) as never;
    }, 'fixture');
    const n = await page(<R.BisectNewPage view={at(NIGHT(0))} />, hostAt({ useBisectActions: () => actions(log) }, went), free);
    await until(() => expect((n.q('[data-evb-start]') as HTMLButtonElement | null)?.disabled).toBe(false));
    await click(n.q('[data-evb-start]')!);
    await until(() => expect(went).toEqual([paths.href.bisect('outreach-20261004T080000')]));
    expect(went[0]!.startsWith(`${BASE}/bisect/`)).toBe(true);
    expect(log.at(-1)).toBe(`start outreach ${NIGHT(0)}..${NIGHT(3)}`);
    await n.unmount();
  });

  it('gives a host without bisect actions the free answer alone, with no plan to price', async () => {
    const m = await page(<R.BisectNewPage view={at(NIGHT(0))} />, hostAt());
    await until(() => expect(m.q('[data-evb-attribution="source"]')).not.toBeNull());
    expect(m.q('[data-evb-plan]')).toBeNull();
    expect(m.q('.ev-b-grid')).toBeNull();
    await m.unmount();
  });
});

describe('one bisect', () => {
  it('draws the live ruler and rail, and stops through the host', async () => {
    const log: string[] = [];
    const m = await page(<R.BisectPage view={viewOf<'bisect'>(`/bisect/${LIVE_ID}`)} />, hostAt({ useBisectActions: () => actions(log) }));
    await until(() => expect(m.q(`[data-evb-bisect="${LIVE_ID}"]`)).not.toBeNull());
    expect(m.q('[data-evb-status]')!.getAttribute('data-evb-status')).toBe('probing');
    expect(m.all('[data-evb-tile]')).toHaveLength(3);
    expect(m.q('[data-evb-control="good"] [data-evb-tally]')!.textContent).toBe('1 of 2 landed');
    // A landed rep links to its run under the host's base.
    expect(m.q('[data-evb-control="good"] a')!.getAttribute('href')).toBe(paths.href.run('r-good'));
    expect(m.q('[data-evb-rail]')!.textContent).toContain('tmux attach -t evals-bisect');
    await click(m.q('[data-evb-stop]')!);
    await until(() => expect(log).toEqual([`stop ${LIVE_ID}`]));
    await m.unmount();
  });

  it('offers no Stop without the host\'s actions, and reads a finished bisect to its culprit', async () => {
    const live = await page(<R.BisectPage view={viewOf<'bisect'>(`/bisect/${LIVE_ID}`)} />, hostAt());
    await until(() => expect(live.q('[data-evb-rail]')).not.toBeNull());
    expect(live.q('[data-evb-stop]')).toBeNull();
    await live.unmount();

    const done = await page(<R.BisectPage view={viewOf<'bisect'>(`/bisect/${DONE_ID}`)} />, hostAt());
    await until(() => expect(done.q('[data-evb-result="culprit"]')).not.toBeNull());
    expect(done.q('[data-evb-controls]')!.getAttribute('data-evb-controls')).toBe('worse');
    await until(() => expect(done.q(`[data-evb-result] [data-evb-commit="${SHA(3)}"]`)).not.toBeNull());
    expect(done.q('.ev-b-tile--culprit')).not.toBeNull();
    await done.unmount();
  });

  it('answers an unknown id with a not-found state that links home to the list', async () => {
    const m = await page(<R.BisectPage view={viewOf<'bisect'>('/bisect/outreach-20250101T000000')} />, hostAt());
    await until(() => expect(m.q('[data-ev-empty]')).not.toBeNull());
    expect(m.q('[data-ev-empty]')!.textContent).toContain('No bisect with this id');
    expect(m.q('[data-ev-empty] a')!.getAttribute('href')).toBe(paths.href.bisectList());
    await m.unmount();
  });
});

describe('the list', () => {
  it('reads every bisect through the page, running first, and opens one through the host', async () => {
    const went: string[] = [];
    const m = await page(<R.BisectListPage view={{ view: 'bisect-list' }} />, hostAt({}, went));
    await until(() => expect(m.all('[data-evb-row]')).toHaveLength(2));
    expect(m.all('[data-evb-row]').map((r) => r.getAttribute('data-evb-row'))).toEqual([LIVE_ID, DONE_ID]);
    expect(m.q(`[data-evb-row="${DONE_ID}"]`)!.textContent).toContain(`culprit ${SHA(3).slice(0, 7)}`);
    await click(m.q(`[data-evb-row="${DONE_ID}"] td`)!);
    expect(went).toEqual([paths.href.bisect(DONE_ID)]);
    await m.unmount();
  });
});

describe('the area routes the group by what the product can answer', () => {
  it('routes each bisect and code address to its page through EvalsApp', async () => {
    const EvalsApp = await area();
    const m = await page(<EvalsApp path={`${BASE}/bisect`} />, hostAt());
    await until(() => expect(m.q('[data-evals-page="bisect-list"]')).not.toBeNull());
    await m.unmount();
    const c = await page(<EvalsApp path={`${BASE}/c/${SHA(3)}`} />, hostAt());
    await until(() => expect(c.q('[data-evals-page="commit"]')).not.toBeNull());
    await c.unmount();
  });

  it('shows none of these pages where /health turns bisect, attribution and commits off', async () => {
    const EvalsApp = await area();
    const rows = [rep('outreach', 'fa01', 0, 1, 0.9), rep('outreach', 'fa01', 1, 1, 0.2)];
    const handle = createEvalsHandler({ rows: async () => rows, surfaces: () => [{ id: 'outreach', title: 'Outreach', route: null, model: null }] }, { passed: (r) => r.status === 'pass', ruler: () => null });
    const transport = localTransport(handle, 'fixture');
    for (const path of ['/bisect', '/bisect/new?surface=outreach', `/bisect/${LIVE_ID}`, `/c/${SHA(3)}`, `/p/${SHA(3)}`]) {
      const m = await page(<EvalsApp path={`${BASE}${path.split('?')[0]}`} />, hostAt(), transport);
      await until(() => expect(m.q('[data-ev-empty]')?.textContent ?? '').toContain('This product has no page for'));
      expect(m.q('[data-evals-page]')).toBeNull();
      await m.unmount();
    }
  });
});

