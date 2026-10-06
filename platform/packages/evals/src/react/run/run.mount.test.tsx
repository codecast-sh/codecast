/**
 * The Run group, mounted in happy-dom over a real handler behind
 * localTransport: a product that keeps freezes and run folders (codecast's
 * shape) and one with rows alone (union's). The run page draws a scored rep
 * (gates failing first, checks, floors, history, the judge, landing on the
 * address's gate); an unscored rep's rubric as the rows it will be held to;
 * the run's problems in its header; a running rep's liveness beside its
 * verdict; the host's tabs, copies and verdict foot;
 * and, where the product keeps no freezes, no Moment tab, no freeze link and
 * no freeze or change requests. The Timeline orders a run's story on its own
 * clock, rules its days, filters by lane and folds a long body.
 */
import { describe, expect, it } from 'bun:test';
import { useSyncExternalStore, type ReactNode } from 'react';
import type { EvalsBridgeRequest, FreezeResponse, RunProblem, RunResponse, RunRowCore } from '../../contract';
import { NIGHT, installDom, rep } from '../../mountKit';
import type { EvalsSources, QuerySurface, RunDetail } from '../../query';

const { win, act, until, mount, click } = await installDom('https://host.test/evals');
const { localTransport } = await import('../../client');
const { createEvalsHandler } = await import('../../query');
const R = await import('..');

// ── A product: one surface, one freeze, reps in every state ─────────────────

const FREEZE = 'fa01';
const rows: RunRowCore[] = [
  rep('outreach', FREEZE, 0, 1, 0.9, { id: 'r-pass' }),
  rep('outreach', FREEZE, 0, 2, 0.3, { id: 'r-fail', status: 'fail', gatesFailed: ['no-leak'], missedFloors: ['warmth'] }),
  rep('outreach', FREEZE, 0, 3, null, { id: 'r-unscored' }),
  rep('outreach', FREEZE, 1, 1, null, { id: 'r-crash', status: 'crash' }),
  rep('outreach', FREEZE, 1, 2, null, { id: 'r-stalled', status: 'crash' }),
];
const SURFACES: QuerySurface[] = [{ id: 'outreach', title: 'Outreach', route: null, model: null }];
const policy = { passed: (r: { status: string }) => r.status === 'pass', ruler: () => null };

const steps = (n: number): RunProblem[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, seq: 10 + i, label: 'inject reply', error: `persona ${i} could not reply` }));
const none: RunDetail = { result: null, score: null, scoreVersions: [], rubric: null, sends: [], judge: null, logTail: null };
const DETAIL: Record<string, RunDetail> = {
  'r-fail': {
    ...none,
    score: {
      pass: false, score: 0.3, passMark: 0.7,
      gates: [
        { id: 'tone', pass: true, evidence: { summary: 'held' } },
        { id: 'no-leak', title: 'No private data', pass: false, decidedBy: 'mechanical', evidence: { summary: 'leaked a phone number', scanned: 1, excerpts: [{ where: 'reply', text: '555-0100' }] } },
      ],
      checks: [
        { id: 'warmth', ask: 'Is it warm?', weight: 0.6, score: 0.4, must: 0.5, reasoning: 'Curt.' },
        { id: 'clarity', weight: 0.4, score: 0.9 },
      ],
      missedFloors: [{ id: 'warmth', score: 0.4, must: 0.5 }],
    },
    scoreVersions: [
      { file: 'score.json', scoredAt: NIGHT(1), judgeModel: 'judge-2', score: 0.3, pass: false, legacy: false },
      { file: `score.${NIGHT(0)}.json`, scoredAt: NIGHT(0), judgeModel: 'judge-1', score: 0.6, pass: false, legacy: false },
    ],
    sends: [{ seq: 1, at: NIGHT(0), label: null, rail: 'sms', to: 'Dana', audience: 'contact', text: 'Call me at 555-0100', chars: 19 }],
    judge: { model: 'judge-2', prompt: 'Grade this reply', reply: '{"score":0.3}', costUsd: 0.002 },
  },
  'r-unscored': {
    ...none,
    rubric: { criteria: null, passMark: 0.7, gates: [{ id: 'no-leak', title: 'No private data', decidedBy: 'mechanical' }], checks: [{ id: 'warmth', ask: 'Is it warm?', weight: 0.6, must: 0.5 }] },
    problems: steps(8),
  },
  'r-crash': { ...none, rubric: { criteria: 'Be kind and brief.', passMark: 0.7 }, logTail: 'TypeError: boom', problems: [{ id: 'f', fatal: true, error: 'driver died' }, ...steps(1)] },
  'r-stalled': { ...none, problems: [{ id: 'f', fatal: true, label: 'drive', error: 'the virtual clock stalled' }] },
};

const moment = (n: number, text: string, direction: 'in' | 'out') => ({ n, id: `m${n}`, at: NIGHT(0), channel: 'sms', isGroup: false, direction, from: direction === 'in' ? 'Dana' : 'agent', text });
const freezePage = (runs: RunRowCore[]): Omit<FreezeResponse, 'epochs'> => ({
  freeze: { id: FREEZE, name: `moment ${FREEZE}`, surface: 'outreach', visibility: 'private', createdAt: NIGHT(0), asOf: NIGHT(0), anchor: { kind: 'message', id: 'm1' }, subject: { kind: 'contact', id: 'c1', title: 'Dana' }, trigger: null, notes: null, judge: 'Be kind and brief.', tags: [], freezeSha: null },
  label: null,
  labelSource: null,
  moment: [moment(1, 'Can you call me?', 'in'), moment(2, 'Sure, when?', 'out')],
  cutAt: 1,
  production: { messages: [moment(2, 'Sure, when?', 'out')], verdict: { score: 0.8, pass: true } },
  runs: runs.filter((r) => r.freezeId === FREEZE),
});

/** Codecast's shape: freezes, run folders and a change feed. */
const fullSources: EvalsSources = {
  rows: async () => rows,
  surfaces: () => SURFACES,
  run: async (row) => DETAIL[row.id] ?? none,
  freezes: { counts: async () => () => ({ public: 0, private: 1 }), get: async (id, all) => (FREEZE.startsWith(id) ? freezePage(all) : null) },
  changes: {},
};

/** Union's shape: rows and surfaces alone. Every request is recorded. */
function rowsOnly() {
  const asked: string[] = [];
  const handle = createEvalsHandler({ rows: async () => rows, surfaces: () => SURFACES }, policy);
  return { asked, transport: localTransport((req: EvalsBridgeRequest) => (asked.push(req.path), handle(req))) };
}

// ── Mounting ────────────────────────────────────────────────────────────────

const subscribe = (fn: () => void) => (win.addEventListener('popstate', fn), () => win.removeEventListener('popstate', fn));
const pathname = () => win.location.pathname;

/** The area at the browser's own address, as a host with no router of its own mounts it. */
function Routed() {
  const path = useSyncExternalStore(subscribe, pathname, pathname);
  return <R.EvalsApp path={path} />;
}

async function openRun(id: string, hash = '', o: { transport?: ReturnType<typeof localTransport>; host?: Parameters<typeof R.EvalsProvider>[0]['host'] } = {}) {
  win.history.replaceState(null, '', `/evals/r/${id}${hash}`);
  const m = await mount(
    <R.EvalsProvider transport={o.transport ?? localTransport(createEvalsHandler(fullSources, policy))} host={o.host}>
      <Routed />
    </R.EvalsProvider>,
  );
  await until(() => expect(m.q(`[data-evals-run="${id}"]`)).not.toBeNull());
  return m;
}

const texts = (els: HTMLElement[]) => els.map((e) => e.textContent?.trim() ?? '');
const attrs = (els: HTMLElement[], name: string) => els.map((e) => e.getAttribute(name));

// ── The tests ───────────────────────────────────────────────────────────────

describe('a scored rep', () => {
  it('draws the header, the gates failing first, the checks, floors, history and judge, and lands on the gate the address names', async () => {
    const m = await openRun('r-fail', '#gate-no-leak');
    expect(m.q('[data-ev-score]')!.textContent).toBe('0.30');
    expect(m.q('.ev-run-score-word')!.textContent).toBe('failed at gate no-leak');
    // The chips link to the surface and the freeze through the host's base path.
    const links = attrs(m.all('[data-ev-run-chips] a'), 'href');
    expect(links.some((h) => h!.startsWith('/evals/') && h!.includes('outreach'))).toBe(true);
    expect(links.some((h) => h!.startsWith('/evals/') && h!.includes(FREEZE))).toBe(true);
    expect(attrs(m.all('[data-ev-gates] [data-ev-gate]'), 'data-ev-gate')).toEqual(['no-leak', 'tone']);
    expect(m.q('[data-ev-gate="no-leak"]')!.getAttribute('data-ev-target')).toBe('true');
    expect(m.q('[data-ev-gate="no-leak"]')!.textContent).toContain('555-0100');
    expect(attrs(m.all('[data-ev-checks] [data-ev-check]'), 'data-ev-check')).toEqual(['warmth', 'clarity']);
    expect(m.q('[data-ev-check="warmth"]')!.textContent).toContain('floor 0.50');
    expect(m.q('[data-ev-missed-floors]')!.textContent).toContain('under its floor of 0.50');
    expect(m.all('[data-ev-score-history] tbody tr')).toHaveLength(2);
    expect(m.q('[data-ev-judge-call]')!.textContent).toContain('judge-2');
    expect(m.q('[data-ev-verdict-reply]')!.textContent).toContain('Call me at 555-0100');
    // With no commands from the host: the run's folder and the replay of its freeze.
    expect(texts(m.all('.ev-run-actions > .ev-btn')).slice(0, 2)).toEqual(['path', 'replay']);
    expect(m.q('[data-ev-tab="verdict"] .ev-tab-flag')).not.toBeNull();
    expect(m.q('[data-ev-problems]')).toBeNull();
    await m.unmount();
  });

  it("adds the host's tabs, copies and verdict foot, moves the tab through the address, and shows the moment and what the rep sent", async () => {
    const host = {
      useRunPanels: (run: RunResponse<any>) => [{ id: 'notes', label: 'Notes', count: 2, flag: 'two notes', body: <p data-test-notes>notes on {run.row.id}</p> }],
      run: {
        commands: (row: RunRowCore) => [{ text: `rescore ${row.id}`, what: 'the rescore command', label: 'rescore' }],
        VerdictFoot: ({ run }: { run: RunResponse<any> }) => <p data-test-foot>foot of {run.row.id}</p>,
      },
    };
    const m = await openRun('r-fail', '', { host });
    expect(attrs(m.all('[data-ev-tab]'), 'data-ev-tab')).toEqual(['verdict', 'moment', 'notes']);
    expect(m.q('[data-ev-tab="notes"] .ev-tab-count')!.textContent).toBe('2');
    expect(m.q('[data-ev-tab="notes"] .ev-tab-flag')!.getAttribute('title')).toBe('two notes');
    expect(texts(m.all('.ev-run-actions > .ev-btn'))[0]).toBe('rescore');
    expect(m.q('[data-test-foot]')!.textContent).toBe('foot of r-fail');
    // What the host draws keeps its own ground: the area's reset skips it.
    expect(m.q('[data-test-foot]')!.parentElement!.className).toBe('ev-host');

    await click(m.q('[data-ev-tab="notes"]')!);
    await until(() => expect(m.q('[data-test-notes]')!.textContent).toBe('notes on r-fail'));
    expect(m.q('[data-test-notes]')!.parentElement!.className).toBe('ev-host');
    expect(win.location.hash).toBe('#notes');

    await click(m.q('[data-ev-tab="moment"]')!);
    await until(() => expect(m.q('[data-ev-moment]')).not.toBeNull());
    expect(win.location.hash).toBe('#moment');
    expect(m.all('[data-ev-moment-line]')).toHaveLength(2);
    expect(m.q('[data-ev-send="1"]')!.textContent).toContain('to Dana');
    await click(m.q('[data-ev-overlay]')!);
    await until(() => expect(m.q('[data-ev-production]')).not.toBeNull());
    await m.unmount();
  });
});

describe('before a score', () => {
  it("draws the rubric's gates and checks as the rows they will be, pending, and its problems in the header", async () => {
    const m = await openRun('r-unscored');
    expect(m.q('[data-ev-rubric="unscored"]')!.textContent).toContain('Pass mark 0.70');
    // The rubric names its gates and checks, so no "no criteria" line stands in for them.
    expect(m.q('[data-ev-rubric]')!.textContent).not.toContain('no criteria');
    const gate = m.q('[data-ev-rubric-gates] [data-ev-gate="no-leak"]')!;
    expect(gate.getAttribute('data-ev-gate-pending')).toBe('true');
    expect(gate.textContent).toContain('No private data');
    expect(gate.querySelector('[data-ev-verdict="unscored"]')).not.toBeNull();
    expect(gate.id).toBe('gate-no-leak');
    const check = m.q('[data-ev-rubric-checks] [data-ev-check="warmth"]')!;
    expect(check.textContent).toContain('Is it warm?');
    expect(check.textContent).toContain('floor 0.50');
    expect(check.querySelector('.ev-bar, svg.ev-scorebar')).toBeNull();

    const problems = m.q('[data-ev-problems]')!;
    expect(problems.getAttribute('data-ev-problems')).toBe('8');
    expect(problems.querySelector('header')!.textContent).toBe('8 steps failed without stopping the run');
    expect(problems.querySelectorAll('li')).toHaveLength(6);
    expect(problems.querySelector('li')!.textContent).toBe('#10inject reply:persona 0 could not reply');
    expect(problems.textContent).toContain("and 2 more in the run's log");
    expect(m.q('[data-ev-problems-fatal]')).toBeNull();
    await m.unmount();
  });

  it('keeps a rubric of words alone as it was, and a fatal problem with the crash unless the log tail already tells it', async () => {
    const crash = await openRun('r-crash');
    expect(crash.q('[data-ev-crash] pre')!.textContent).toBe('TypeError: boom');
    expect(crash.q('[data-ev-problems-fatal]')).toBeNull();
    expect(crash.q('[data-ev-problems]')!.querySelector('header')!.textContent).toBe('1 step failed without stopping the run');
    expect(crash.q('[data-ev-rubric="crash"]')!.textContent).toContain('Be kind and brief.');
    expect(crash.q('[data-ev-rubric-gates]')).toBeNull();
    await crash.unmount();

    const stalled = await openRun('r-stalled');
    expect(stalled.q('[data-ev-crash]')).toBeNull();
    const fatal = stalled.q('[data-ev-problems-fatal]')!;
    expect(fatal.querySelector('header')!.textContent).toEndWith('The run failed: drive');
    expect(fatal.querySelector('pre')!.textContent).toBe('the virtual clock stalled');
    await stalled.unmount();
  });
});

describe('a product with rows alone', () => {
  it('draws no Moment tab and no freeze link, and asks for no freeze and no change feed', async () => {
    const { asked, transport } = rowsOnly();
    const m = await openRun('r-unscored', '#moment', { transport });
    expect(attrs(m.all('[data-ev-tab]'), 'data-ev-tab')).toEqual(['verdict']);
    expect(m.q('[data-ev-panel]')!.getAttribute('data-ev-panel')).toBe('verdict');
    const chips = m.q('[data-ev-run-chips]')!;
    expect(chips.textContent).toContain(`moment ${FREEZE}`);
    expect([...chips.querySelectorAll('a')].some((a) => a.getAttribute('href')!.includes(FREEZE))).toBe(false);
    expect(m.q('[data-ev-verdict-tab]')!.textContent).toContain('No score and no rubric on record for this rep.');
    // A landing rep on a product with no change feed: a few polls' worth of time, and still no /changes.
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    expect(asked.filter((p) => p.startsWith('/freeze') || p === '/changes')).toEqual([]);
    expect(asked).toContain(`/run/r-unscored`);
    await m.unmount();
  });
});

describe('a product whose reps lack parts', () => {
  // Union's shape in full: no freezes, no model, judge or pass mark on record, no pair to weigh. An eval result keeps its score on the row and the judge's words, with no score file; a simulation answers nothing and is held to its gates alone.
  const judged: RunDetail = { ...none, judge: { model: null, prompt: '', reply: 'Clear and warm.', costUsd: null }, sends: [{ seq: 1, at: NIGHT(0), label: null, rail: null, to: null, audience: 'reply', text: 'Thursday works.', chars: 15 }] };
  const sim: RunDetail = { ...none, score: { pass: false, score: 0.3, passMark: 0, gates: [{ id: 'no-leak', pass: false, evidence: { summary: 'leaked' } }], checks: [{ id: 'warmth', ask: 'Is it warm?', weight: 1, score: 0.3 }] }, without: ['reply'] };
  const crashed: RunDetail = { ...none, rubric: { criteria: null, passMark: 0, gates: [{ id: 'no-leak', title: 'No private data' }] }, without: ['reply'] };
  const transport = () =>
    localTransport(createEvalsHandler({ rows: async () => rows, surfaces: () => SURFACES, models: false, marks: false, run: async (row) => (row.id === 'r-pass' ? judged : row.id === 'r-crash' ? crashed : sim) }, policy));

  it('draws a graded result as graded: its reply as the judge read it and what the judge said, with no mark it was never held to and no model, judge, lock, head or compare', async () => {
    const m = await openRun('r-pass', '', { transport: transport() });
    expect(m.q('[data-ev-score]')!.textContent).toBe('0.90');
    const tab = m.q('[data-ev-verdict-tab]')!;
    expect(m.q('[data-ev-verdict-reply]')!.textContent).toContain('as the judge read it');
    expect(m.q('[data-ev-verdict-reply]')!.textContent).toContain('Thursday works.');
    expect(m.q('[data-ev-judge-said]')!.textContent).toContain('Clear and warm.');
    expect(m.q('[data-ev-judge-call]')).toBeNull();
    for (const word of ['not judged', 'No score', 'no model']) expect(tab.textContent).not.toContain(word);
    expect(m.q('.ev-ruler-big-mark')).toBeNull();
    expect(m.q('[data-ev-seed-strip] .ev-strip-mark')).toBeNull();
    const chips = m.q('[data-ev-run-chips]')!.textContent!;
    for (const word of ['no model', 'not judged', 'private', 'none']) expect(chips).not.toContain(word);
    expect(m.q('[data-ev-lock]')).toBeNull();
    expect(m.q('[data-ev-compare-open]')).toBeNull();
    expect(m.q('.ev-run-hints')!.textContent).not.toContain('compare');
    await m.unmount();
  });

  it('draws no reply section for a rep that answers nothing, and still its gates', async () => {
    const m = await openRun('r-fail', '', { transport: transport() });
    expect(m.q('[data-ev-verdict-reply]')).toBeNull();
    expect(m.q('[data-ev-verdict-tab]')!.textContent).not.toContain('No reply on record');
    expect(attrs(m.all('[data-ev-gate]'), 'data-ev-gate')).toEqual(['no-leak']);
    await m.unmount();
  });

  it('draws no pass mark anywhere on a page, whatever its score sheet or rubric carries', async () => {
    // A scored rep: the ruler, the seed strip, the checks' total and each check's bar.
    let m = await openRun('r-fail', '', { transport: transport() });
    for (const mark of ['.ev-ruler-big-mark', '[data-ev-seed-strip] .ev-strip-mark', '.ev-scorebar-mark']) expect(m.q(mark)).toBeNull();
    expect(m.all('.ev-scorebar').length).toBeGreaterThan(0);
    expect(m.q('[data-ev-verdict-tab]')!.textContent).not.toContain('against');
    await m.unmount();
    // A crashed rep that answers nothing: its rubric names the gates, no mark, and no reply it was never going to give.
    m = await openRun('r-crash', '', { transport: transport() });
    const rubric = m.q('[data-ev-rubric]')!.textContent!;
    expect(rubric).toContain('A rep that finishes is held to this.');
    expect(rubric).toContain('It passes when every gate holds.');
    for (const word of ['Pass mark', 'replies']) expect(rubric).not.toContain(word);
    expect(m.q('.ev-ruler-big-mark')).toBeNull();
    await m.unmount();
  });

  it('has no compare page', async () => {
    win.history.replaceState(null, '', '/evals/compare?a=r-pass&b=r-fail');
    const m = await mount(
      <R.EvalsProvider transport={transport()}>
        <Routed />
      </R.EvalsProvider>,
    );
    await until(() => expect(m.container.textContent).toContain('This product has no page for the comparison'));
    await m.unmount();
  });
});

describe('a running rep', () => {
  it('wears "running" while its events keep coming and the stall chip once they stop; a graded rep wears neither', async () => {
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const reps = [rep('sims', 'fs01', 0, 1, null, { id: 'r-live', lastEventAt: at(1) }), rep('sims', 'fs01', 0, 2, null, { id: 'r-quiet', lastEventAt: at(20) })];
    // A rubric that names its own mark: the ruler, the seed strip and the rubric card all draw that one.
    const held: RunDetail = { ...none, rubric: { criteria: null, passMark: 0.5, gates: [{ id: 'no-leak', title: 'No private data' }] } };
    const transport = localTransport(createEvalsHandler({ rows: async () => reps, surfaces: () => [{ id: 'sims', title: 'Sims', route: null, model: null }], run: async () => held }, policy));

    let m = await openRun('r-live', '', { transport });
    expect(m.q('.ev-run-score-word [data-ev-liveness]')!.getAttribute('data-ev-liveness')).toBe('live');
    await m.unmount();
    m = await openRun('r-quiet', '', { transport });
    const chip = m.q('.ev-run-score-word [data-ev-liveness]')!;
    expect(chip.getAttribute('data-ev-liveness')).toBe('stalled');
    expect(chip.textContent).toBe('stalled?');
    expect(m.q('[data-ev-ruler] .ev-ruler-big-mark')!.getAttribute('title')).toBe('pass mark 0.5');
    // x = 8 + 0.5 * (240 - 16)
    expect(m.q('[data-ev-seed-strip] .ev-strip-mark')!.getAttribute('x1')).toBe('120');
    expect(m.q('[data-ev-rubric]')!.textContent).toContain('Pass mark 0.50, after every gate holds.');
    await m.unmount();
    m = await openRun('r-fail');
    expect(m.q('[data-ev-liveness]')).toBeNull();
    await m.unmount();
  });
});

describe('the Timeline', () => {
  const T0 = Date.parse('2026-08-13T09:00:00.000Z');
  const H = 3_600_000;
  const long = 'x'.repeat(900);
  const items = [
    { id: 'line', at: T0 + 1_500, lane: 'slack', where: '#union', context: 'Team A', tone: 'cyan' as const, body: <span>Hi all</span>, length: 6 },
    { id: 'beat', at: T0 + 1_900, lane: 'beat', marker: 'scripted beat: Dana speaks in #union' },
    { id: 'mail', at: T0 + 2 * 24 * H + 5 * H, lane: 'email', where: 'Dana Whitfield', context: 'Re: terms', body: <span>{long}</span>, length: long.length },
    { id: 'text', at: T0 - 7 * H, lane: 'text', where: 'Sam', body: <span>early</span>, length: 5 },
  ];

  async function draw(node: ReactNode) {
    return mount(<R.EvalsProvider transport={null}>{node}</R.EvalsProvider>);
  }

  it('orders the story on its clock, rules its days, filters by lane and folds a long body', async () => {
    const m = await draw(<R.Timeline items={items} origin={T0} lanes={[{ key: 'slack', label: 'slack' }, { key: 'text', label: 'text' }, { key: 'email', label: 'email' }, { key: 'beat', label: 'beats' }, { key: 'call', label: 'calls' }]} />);
    expect(attrs(m.all('[data-ev-timeline-item]'), 'data-ev-timeline-item')).toEqual(['text', 'beat', 'line', 'mail']);
    expect(attrs(m.all('[data-ev-timeline-day]'), 'data-ev-timeline-day')).toEqual(['-1', '0', '2']);
    expect(m.q('[data-ev-timeline-item="text"] .ev-tl-when')!.textContent).toBe('D-1 17:00');
    expect(m.q('[data-ev-timeline-marker] .ev-tl-marker-text')!.textContent).toBe('scripted beat: Dana speaks in #union');
    expect(m.q('[data-ev-timeline-item="line"] .ev-tl-where')!.getAttribute('data-ev-tone')).toBe('cyan');
    // A lane with nothing in it is not offered.
    expect(texts(m.all('[role="radio"]'))).toEqual(['everything4', 'slack1', 'text1', 'email1', 'beats1']);

    const more = m.q('[data-ev-timeline-item="mail"] .ev-tl-more')!;
    expect(m.q('[data-ev-timeline-item="mail"] .ev-tl-folded')).not.toBeNull();
    expect(m.q('[data-ev-timeline-item="line"] .ev-tl-more')).toBeNull();
    await click(more);
    expect(m.q('[data-ev-timeline-item="mail"] .ev-tl-folded')).toBeNull();
    expect(more.textContent).toBe('show less');

    await click(m.all('[role="radio"]').find((b) => b.textContent!.startsWith('email'))!);
    expect(attrs(m.all('[data-ev-timeline-item]'), 'data-ev-timeline-item')).toEqual(['mail']);
    await m.unmount();
  });

  it('draws nothing for an empty story', async () => {
    const m = await draw(<R.Timeline items={[]} origin={T0} />);
    expect(m.q('[data-ev-timeline]')).toBeNull();
    await m.unmount();
  });
});
