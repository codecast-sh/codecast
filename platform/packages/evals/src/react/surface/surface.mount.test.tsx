/**
 * The Surface group, mounted in happy-dom over the shared query handler
 * behind localTransport. Two products: union's shape (rows, surfaces and a
 * gate its backend decided; no pass mark, no model or judge on record, no
 * bisects, commits or prompts) and a full one with codecast's header fields,
 * bisects, a change feed and a host's own What moved kind. The wall sorts the
 * worse surface first and hides what the product cannot answer; a surface
 * shows its gate as data, its header as far as the product fills it, and
 * pins a column through the host's router.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactNode } from 'react';
import type { EvalsBridgeRequest, RunRowCore } from '../../contract';
import type { EvalsSources, QuerySurface } from '../../query';

const win = new Window({ url: 'https://host.test/evals' });
const GLOBALS = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLInputElement: win.HTMLInputElement,
  Element: win.Element,
  Node: win.Node,
  Event: win.Event,
  KeyboardEvent: win.KeyboardEvent,
  MouseEvent: win.MouseEvent,
  PopStateEvent: win.PopStateEvent,
  CSS: { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) },
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
const { localTransport } = await import('../../client');
const { createEvalsHandler } = await import('../../query');
const R = await import('..');

// ── Two products over the same four nights ───────────────────────────────────

const NIGHT = (n: number) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + n * 86_400_000).toISOString();

function rep(surface: string, freeze: string, night: number, seed: number, score: number, extra: Partial<RunRowCore> = {}): RunRowCore {
  const batch = NIGHT(night);
  return {
    id: `${surface}-${freeze}-seed${seed}-${batch}`, surface, freezeId: freeze, freezeName: `moment ${freeze}`, visibility: 'private',
    seed, stamp: batch, batch, batchAt: batch, cadence: 'nightly', status: score >= 0.7 ? 'pass' : 'fail',
    score, passMark: 0.7, gatesFailed: [], checks: {}, missedFloors: [], model: null, judgeModel: null, ruler: null,
    gitHead: null, mainSha: null, dirty: false, offBranch: false, treePatch: null, sourceHashDisk: null, promptSha: null, freezeSha: null,
    liveReads: 0, costUsd: 0.01, judgeCostUsd: 0.001, realMs: 1000, ...extra,
  };
}

const FREEZES = ['fa01', 'fb02', 'fc03', 'fd04', 'fe05', 'ff06'];

/** Three reps a freeze a night; on `breaks`, every freeze but fa01 falls to 0.1 on the last night (six freezes, so the fall separates). */
function rowsFor(surface: string, breaks: boolean, extra: Partial<RunRowCore> = {}): RunRowCore[] {
  const out: RunRowCore[] = [];
  for (let night = 0; night < 4; night++)
    for (const f of FREEZES) for (let seed = 1; seed <= 3; seed++) out.push(rep(surface, f, night, seed, breaks && night === 3 && f !== 'fa01' ? 0.1 : 0.9, extra));
  return out.reverse();
}

const policy = { passed: (r: { status: string }) => r.status === 'pass', ruler: () => null, stallAfterMs: 5 * 60_000 };

const GATE_RED = { rule: 'Jeffreys: a gate case holds while its 95% failure range tops out at 10% or under', status: 'red' as const, detail: '1 of 2 gate cases under the bar; over: fb02' };
const GATE_GREEN = { rule: 'Jeffreys: a gate case holds while its 95% failure range tops out at 10% or under', status: 'green' as const, detail: '2 of 2 gate cases under the bar' };

/** Union's shape: rows and surfaces with a gate, and no pass mark. */
function unionProduct() {
  const rows = [...rowsFor('outreach', true), ...rowsFor('triage', false)];
  const surfaces: QuerySurface[] = [
    { id: 'outreach', title: 'outreach', route: null, model: null, passMark: null, gate: GATE_RED },
    { id: 'triage', title: 'triage', route: null, model: null, passMark: null, gate: GATE_GREEN },
  ];
  return createEvalsHandler({ rows: async () => rows, surfaces: () => surfaces }, policy);
}

const SIM_MOVED = { at: NIGHT(3), surface: null, kind: 'sim-failure', scenario: 'two-tabs' };

/** A full product: codecast's header fields, freezes, bisects, a change feed and a host kind in What moved. */
function fullProduct() {
  const rows = rowsFor('settle', true, { model: 'claude-sonnet-5-5', judgeModel: 'claude-haiku-5' });
  const surfaces = [{ id: 'settle', title: 'Settle', route: 'call', model: 'claude-sonnet-5-5' }];
  const running = { id: 'bis-1', surface: 'settle', status: 'probing' as const, outcome: null, culprit: null, finishedAt: null, good: 'abc1234', bad: 'def5678', startedAt: NIGHT(3), updatedAt: new Date().toISOString(), budgetUsd: 5, spentUsd: 1.25 };
  const src: EvalsSources<RunRowCore, (typeof surfaces)[number], typeof SIM_MOVED> = {
    rows: async () => rows,
    surfaces: () => surfaces,
    info: () => ({ criteria: 'The reply settles the thread without asking again.', sources: ['prompts/settle.md'], reps: { check: 3 }, maxUsdPerRep: 0.05 }),
    freezes: { counts: async () => () => ({ public: 2, private: 1 }), get: async () => null },
    bisects: { summaries: () => [running], running: () => 'bis-1', get: () => null },
    changes: {},
    overview: () => ({ moved: [SIM_MOVED] }),
  };
  return createEvalsHandler(src, policy);
}

/** A server from before capabilities: /health names none, so every panel draws (codecast today). */
function withoutCapabilities(handle: ReturnType<typeof createEvalsHandler>) {
  return async (req: EvalsBridgeRequest) => {
    const reply = await handle(req);
    if (req.path === '/health') delete (reply.body as { capabilities?: unknown }).capabilities;
    return reply;
  };
}

// ── Mounting ────────────────────────────────────────────────────────────────

const tick = (ms = 0) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

async function until(check: () => void, timeoutMs = 4_000) {
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
    q: (sel: string) => container.querySelector(sel) as unknown as HTMLElement | null,
    all: (sel: string) => [...container.querySelectorAll(sel)] as unknown as HTMLElement[],
    unmount: () => act(async () => root.unmount()),
  };
}

/** A key press as the browser delivers it: at the body, bubbling to the document and the window. */
const press = (key: string) =>
  act(async () => {
    win.document.body.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

/** A host that records where it was sent instead of moving. */
function recordingHost(extra: object = {}) {
  const went: Array<{ href: string; replace: boolean }> = [];
  return { went, host: { useNavigate: () => (href: string, o?: { replace?: boolean }) => void went.push({ href, replace: !!o?.replace }), ...extra } };
}

// ── The wall ────────────────────────────────────────────────────────────────

describe('the wall', () => {
  it('sorts the worse surface first and leaves out what a rows-only product cannot answer', async () => {
    const { went, host } = recordingHost();
    const m = await mount(
      <R.EvalsProvider transport={localTransport(unionProduct())} host={host}>
        <R.EvalsApp path="/evals" />
      </R.EvalsProvider>,
    );
    await until(() => expect(m.all('[data-ev-wall-row]')).toHaveLength(2));
    expect(m.all('[data-ev-wall-row]').map((r) => [r.getAttribute('data-ev-wall-row'), r.hasAttribute('data-ev-worse')])).toEqual([
      ['outreach', true],
      ['triage', false],
    ]);
    // No route, model or staleness on record: nothing drawn for them.
    expect(m.q('.ev-wall-route')).toBeNull();
    expect(m.q('[data-ev-stale]')).toBeNull();
    // No bisects: no foot and no attribute key, and b does nothing.
    expect(m.q('.ev-wall-foot')).toBeNull();
    expect(m.q('.ev-wall-keys')!.textContent).not.toContain('attribute');
    await press('b');
    expect(went).toEqual([]);
    // What moved names the flips, linked under the host's base.
    const flips = m.q('[data-ev-moved-kind="flips"]')!;
    expect(flips.textContent).toContain('outreach: 5 freezes broke');
    expect(flips.getAttribute('href')).toStartWith('/evals/s/outreach?batch=');
    // j selects the first row and Enter opens it, a worse one with the verdict's pair pinned.
    await press('j');
    await press('Enter');
    expect(went.map((w) => w.href)).toEqual([`/evals/s/outreach?batch=${encodeURIComponent(NIGHT(3))}&compare=${encodeURIComponent(NIGHT(2))}`]);
    await m.unmount();
  });

  it("draws open bisects, the attribute key, and the host's own foot and What moved kind for a full product", async () => {
    const { went, host } = recordingHost({
      basePath: '/lab',
      wall: {
        moved: (e: typeof SIM_MOVED) => ({ href: '/lab/sim', text: `sim ${e.scenario} broke`, mark: <svg data-test-mark /> }),
        movedKinds: ['sim failure'],
        Foot: () => <div data-test-foot>latest sim</div>,
      },
    });
    const m = await mount(
      <R.EvalsProvider transport={localTransport(withoutCapabilities(fullProduct()))} host={host}>
        <R.EvalsApp path="/lab" />
      </R.EvalsProvider>,
    );
    await until(() => expect(m.q('[data-ev-bisect-ribbon="bis-1"]')).not.toBeNull());
    expect(m.q('[data-ev-bisect-ribbon="bis-1"]')!.getAttribute('href')).toBe('/lab/bisect/bis-1');
    expect(m.q('[data-test-foot]')!.textContent).toBe('latest sim');
    expect(m.q('[data-test-foot]')!.parentElement!.className).toBe('ev-host');
    const own = m.q('[data-ev-moved-kind="sim-failure"]')!;
    expect(own.textContent).toContain('sim two-tabs broke');
    expect(own.getAttribute('href')).toBe('/lab/sim');
    expect(own.querySelector('[data-test-mark]')).not.toBeNull();
    // Route and model chips, as codecast draws them.
    expect(m.q('.ev-wall-route')!.textContent).toBe('call');
    expect(m.q('.ev-wall-model')!.textContent).toContain('sonnet-5-5');
    expect(m.q('.ev-wall-keys')!.textContent).toContain('attribute');
    await press('b');
    expect(went.at(-1)!.href).toStartWith('/lab/bisect/new?surface=settle');
    await m.unmount();
  });
});

// ── One surface ─────────────────────────────────────────────────────────────

describe('a surface', () => {
  it("shows a product's gate as data, with its own words and rule, and draws no pass mark where the product has none", async () => {
    const { went, host } = recordingHost();
    const m = await mount(
      <R.EvalsProvider transport={localTransport(unionProduct())} host={host}>
        <R.EvalsApp path="/evals/s/outreach" />
      </R.EvalsProvider>,
    );
    await until(() => expect(m.q('[data-evals-page="surface"]')).not.toBeNull());
    const gate = m.q('[data-ev-gate]')!;
    expect(gate.getAttribute('data-ev-gate')).toBe('red');
    expect(gate.getAttribute('title')).toBe(GATE_RED.rule);
    expect(gate.textContent).toBe(`gate failed${GATE_RED.detail}`);
    // Only the gate: no route, model, freeze or reps chips.
    expect(m.all('.ev-sf-head .ev-chips > .ev-chip')).toHaveLength(1);
    // Every rep drawn; the pass mark is the product's, and union has none.
    expect(m.all('[data-ev-dot]')).toHaveLength(72);
    expect(m.q('[data-ev-passmark]')).toBeNull();
    // Nothing records the model or judge, and the verdict says so.
    expect(m.q('[data-ev-latest-verdict]')!.getAttribute('data-ev-latest-verdict')).toBe('worse');
    expect(m.q('[data-ev-unfooted]')).not.toBeNull();
    // The ledger names each case, with no freeze page to open and no lock: the product keeps no freezes.
    expect(m.all('[data-ev-ledger-row]').length).toBeGreaterThan(0);
    expect(m.all('[data-ev-ledger] a')).toHaveLength(0);
    expect(m.q('[data-ev-lock]')).toBeNull();
    // No bisect probes toggle and no epoch or attribute keys.
    const toolbar = m.q('.ev-sf-toolbar')!.textContent!;
    expect(toolbar).toContain('dirty');
    expect(toolbar).not.toContain('bisect probes');
    const keys = m.q('.ev-sf-keys')!.textContent!;
    expect(keys).not.toContain('epoch diff');
    expect(keys).not.toContain('attribute');

    // A click on the plot pins the nearest column, in the address, through the host.
    const hit = m.q('[data-ev-seis-hit]')!;
    await act(async () => {
      hit.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 5000 }) as unknown as Event);
      hit.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 5000 }) as unknown as Event);
    });
    expect(went).toEqual([{ href: `/evals/s/outreach?batch=${encodeURIComponent(NIGHT(3))}`, replace: true }]);
    await m.unmount();
  });

  it('draws a held gate, and b attributes nothing where the product cannot attribute', async () => {
    const { went, host } = recordingHost({ useSearchParams: () => new URLSearchParams(`batch=${NIGHT(3)}`) });
    const m = await mount(
      <R.EvalsProvider transport={localTransport(unionProduct())} host={host}>
        <R.EvalsApp path="/evals/s/triage" />
      </R.EvalsProvider>,
    );
    await until(() => expect(m.q('[data-ev-gate]')).not.toBeNull());
    expect(m.q('[data-ev-gate]')!.getAttribute('data-ev-gate')).toBe('green');
    expect(m.q('[data-ev-gate]')!.textContent).toBe(`gate holds${GATE_GREEN.detail}`);
    expect(m.q('[data-ev-pin="1"]')).not.toBeNull();
    await press('b');
    await press('e');
    expect(went).toEqual([]);
    // [ steps the pin back a night; Escape lets it go.
    await press('[');
    await press('Escape');
    expect(went.map((w) => w.href)).toEqual([`/evals/s/triage?batch=${encodeURIComponent(NIGHT(2))}`, '/evals/s/triage']);
    await m.unmount();
  });

  it("shows a full product's header as codecast does: route, model, freezes, reps and cost cap, criteria, the 0.7 mark and every key", async () => {
    const { went, host } = recordingHost({ useSearchParams: () => new URLSearchParams(`batch=${NIGHT(3)}`) });
    const m = await mount(
      <R.EvalsProvider transport={localTransport(withoutCapabilities(fullProduct()))} host={host}>
        <R.EvalsApp path="/evals/s/settle" />
      </R.EvalsProvider>,
    );
    await until(() => expect(m.q('[data-evals-page="surface"]')).not.toBeNull());
    expect(m.q('[data-ev-gate]')).toBeNull();
    expect(m.all('.ev-sf-head .ev-chips > .ev-chip').map((c) => c.textContent)).toEqual(['call route', 'claude-sonnet-5-5', ' 2 public', ' 1 private', '3 reps a freeze, at most $0.050 a rep']);
    expect(m.q('.ev-sf-criteria-peek')!.textContent).toBe('The reply settles the thread without asking again.');
    expect(m.all('[data-ev-passmark]')).toHaveLength(1);
    expect(m.q('[data-ev-unfooted]')).toBeNull();
    expect(m.q('.ev-sf-toolbar')!.textContent).toContain('bisect probes');
    const keys = m.q('.ev-sf-keys')!.textContent!;
    expect(keys).toContain('epoch diff');
    expect(keys).toContain('attribute');
    // b attributes the pinned batch against the one before it.
    await press('b');
    expect(went.at(-1)!.href).toBe(`/evals/bisect/new?surface=settle&good=${encodeURIComponent(NIGHT(2))}&bad=${encodeURIComponent(NIGHT(3))}`);
    await m.unmount();
  });
});

describe('the gate chip alone', () => {
  it('tells an unread gate by a dotted ring and its own words', async () => {
    const m = await mount(<R.GateChip gate={{ rule: 'the rule', status: 'unknown', detail: '' }} />);
    const chip = m.q('[data-ev-gate]')!;
    expect(chip.getAttribute('data-ev-gate')).toBe('unknown');
    expect(chip.textContent).toBe('gate not read yet');
    expect(chip.querySelector('circle')!.getAttribute('stroke-dasharray')).toBe('1.6 1.6');
    await m.unmount();
  });
});
