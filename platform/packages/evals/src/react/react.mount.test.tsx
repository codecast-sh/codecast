/**
 * The React foundation, mounted in happy-dom over a real handler: the shared
 * query handler behind localTransport, as union's browser adapter and
 * eaiden's server run it. The provider reads /health and the views load
 * through its own cache; the shell paints each connection state; the nav
 * follows the product's capabilities and the host's sections; the search,
 * the links and the keys go through the host; live views follow /changes;
 * and every slot a host leaves out has a working default.
 */
import { describe, expect, it } from 'bun:test';
import { useSyncExternalStore } from 'react';
import type { EvalsBridgeRequest, RunRowCore } from '../contract';
import { NIGHT, installDom, rep } from '../mountKit';
import type { EvalsSources, QuerySurface } from '../query';

const { win, act, tick, until, mount, typeInto } = await installDom('https://host.test/evals');
const { localTransport } = await import('../client');
const { createEvalsHandler } = await import('../query');
const R = await import('.');

// ── A product: two surfaces, four nights, one freeze that breaks ─────────────

function rowsFor(surface: string): RunRowCore[] {
  const out: RunRowCore[] = [];
  for (let night = 0; night < 4; night++)
    for (const f of ['fa01', 'fb02']) for (let seed = 1; seed <= 3; seed++) out.push(rep(surface, f, night, seed, f === 'fb02' && night === 3 ? 0.2 : 0.9));
  return out.reverse();
}

const SURFACES: QuerySurface[] = [
  { id: 'outreach', title: 'Outreach', route: null, model: null },
  { id: 'sims', title: 'Simulations', route: null, model: null },
];
const policy = { passed: (r: { status: string }) => r.status === 'pass', ruler: () => null, stallAfterMs: 5 * 60_000 };

/** Union's shape: rows and surfaces alone, so no bisects, commits or change feed. */
function rowsOnly() {
  const rows = [...rowsFor('outreach'), ...rowsFor('sims')];
  return createEvalsHandler({ rows: async () => rows, surfaces: () => SURFACES }, policy);
}

/** A product with a change feed and bisects; `rows` can move under it. */
function fullProduct() {
  const state = { rows: rowsFor('outreach') };
  const src: EvalsSources = {
    rows: async () => state.rows,
    surfaces: () => SURFACES.slice(0, 1),
    health: () => ({ root: '/repo', evalsHome: '/home/evals', gitHead: 'abcdef1234567890', runsIndexed: state.rows.length, index: { state: 'building', done: 12, total: 48 }, pid: 1, startedAt: NIGHT(0) }),
    changes: {},
    bisects: { summaries: () => [], running: () => null, get: () => null },
  };
  return { state, handle: createEvalsHandler(src, policy) };
}

// ── Mounting ────────────────────────────────────────────────────────────────

/** The wall as a page sees it: the surfaces from GET /overview. */
function WallPage() {
  const { data, loading } = R.useEvalsResource('GET /overview', {});
  if (loading && !data) return <p className="ev-note">Reading the wall...</p>;
  return (
    <ul data-test-wall>
      {data?.surfaces.map((s) => (
        <li key={s.id}>{s.id}</li>
      ))}
    </ul>
  );
}

// ── The tests ───────────────────────────────────────────────────────────────

describe('the shell over a product with rows and surfaces alone', () => {
  it('reaches /health, then paints the page under the nav, with the transport marked and the panels it cannot fill hidden', async () => {
    const m = await mount(
      <R.EvalsProvider transport={localTransport(rowsOnly(), 'fixture')}>
        <R.EvalsApp path="/evals" pages={{ home: WallPage }} />
      </R.EvalsProvider>,
    );
    const shell = m.q('[data-evals-shell]')!;
    await until(() => expect(m.all('[data-test-wall] li')).toHaveLength(2));
    expect(shell.getAttribute('data-evals-connection')).toBe('connected');
    expect(shell.getAttribute('data-evals-view')).toBe('home');
    expect(m.all('[data-test-wall] li').map((li) => li.textContent)).toEqual(['outreach', 'sims']);
    // No bisects in this product: the section is not drawn. Surfaces is the current one.
    expect(m.all('[data-evals-section]').map((a) => a.getAttribute('data-evals-section'))).toEqual(['surfaces']);
    expect(m.q('[data-evals-section="surfaces"]')!.getAttribute('aria-current')).toBe('page');
    const status = m.q('[data-evals-status]')!;
    expect(status.textContent).toContain('fixture');
    expect(status.textContent).toContain('48 runs');
    // No commits: no tool head, and the search does not offer a sha.
    expect(status.textContent).not.toContain('tool');
    expect(m.q('[data-evals-search] input')!.getAttribute('placeholder')).toBe('surface, run, batch or freeze');
    // A warm index draws no progress line.
    expect(m.q('[data-evals-index]')).toBeNull();
    await m.unmount();
  });

  it('says what the product does not show, and what no address names', async () => {
    const transport = localTransport(rowsOnly());
    const at = async (path: string) => {
      const m = await mount(
        <R.EvalsProvider transport={transport}>
          <R.EvalsApp path={path} />
        </R.EvalsProvider>,
      );
      const text = m.q('[data-ev-empty]')?.textContent ?? '';
      await m.unmount();
      return text;
    };
    expect(await at('/evals/bisect')).toContain('This product has no page for the bisects.');
    expect(await at('/evals/nowhere/at/all')).toContain('No Evals page here');
  });
});

describe('the connection', () => {
  it('waits while there is no transport, shows the failure with a retry, and connects when /health answers', async () => {
    let down = true;
    const handle = rowsOnly();
    const flaky = localTransport(async (req: EvalsBridgeRequest) => (down ? { status: 503, body: { error: 'the admin api is down' } } : handle(req)));
    const view = (t: typeof flaky | null) => (
      <R.EvalsProvider transport={t}>
        <R.EvalsApp path="/evals" pages={{ home: WallPage }} />
      </R.EvalsProvider>
    );
    const m = await mount(view(null));
    expect(m.q('[data-evals-shell]')!.getAttribute('data-evals-connection')).toBe('connecting');
    expect(m.q('[data-evals-connecting]')!.textContent).toBe('Reaching the evals...');

    await m.rerender(view(flaky));
    await until(() => expect(m.q('[data-evals-shell]')!.getAttribute('data-evals-connection')).toBe('unreachable'));
    expect(m.q('[data-evals-unreachable]')!.textContent).toContain('the admin api is down');
    expect(m.q('[data-test-wall]')).toBeNull();

    down = false;
    await act(async () => (m.q('[data-evals-unreachable] button') as HTMLButtonElement).click());
    await until(() => expect(m.all('[data-test-wall] li')).toHaveLength(2));
    expect(m.q('[data-evals-shell]')!.getAttribute('data-evals-connection')).toBe('connected');
    await m.unmount();
  });

  it("draws a host's own connection screen and state instead", async () => {
    const host = { useConnection: () => ({ state: 'no-daemon', screen: <div data-test-daemon>Start the daemon</div> }) };
    const m = await mount(
      <R.EvalsProvider transport={localTransport(rowsOnly())} host={host}>
        <R.EvalsApp path="/evals" pages={{ home: WallPage }} />
      </R.EvalsProvider>,
    );
    expect(m.q('[data-evals-shell]')!.getAttribute('data-evals-connection')).toBe('no-daemon');
    expect(m.q('[data-test-daemon]')).not.toBeNull();
    expect(m.q('[data-test-wall]')).toBeNull();
    await m.unmount();
  });
});

describe('the shell over a full product', () => {
  it("shows Bisects and the host's sections, the tool head, and the index's first build", async () => {
    const { handle } = fullProduct();
    const host = { basePath: '/lab', navSections: [{ key: 'sim', label: 'Multiplayer sim', href: '/lab/sim' }] };
    const m = await mount(
      <R.EvalsProvider transport={localTransport(handle)} host={host}>
        <R.EvalsApp path="/lab/sim" />
      </R.EvalsProvider>,
    );
    await until(() => expect(m.q('[data-evals-index]')).not.toBeNull());
    expect(m.all('[data-evals-section]').map((a) => [a.getAttribute('data-evals-section'), a.getAttribute('href')])).toEqual([
      ['surfaces', '/lab'],
      ['bisects', '/lab/bisect'],
      ['sim', '/lab/sim'],
    ]);
    expect(m.q('[data-evals-section="sim"]')!.getAttribute('aria-current')).toBe('page');
    expect(m.q('[data-evals-status]')!.textContent).toContain('tool abcdef12');
    const index = m.q('[data-evals-index]')!;
    expect(index.getAttribute('data-evals-index')).toBe('building');
    expect(index.textContent).toContain('12 of 48');
    expect((m.q('.ev-index-fill') as HTMLElement).style.width).toBe('25%');
    await m.unmount();
  });

  it('hands a live view what changed, only while it is live and on screen, and keeps its cursor while away', async () => {
    const { state, handle } = fullProduct();
    const seen: string[][] = [];
    // The host's pane, which a test can hide and show.
    const pane = { visible: true, listeners: new Set<() => void>() };
    const setPane = (v: boolean) =>
      act(async () => {
        pane.visible = v;
        for (const fn of pane.listeners) fn();
      });
    const subscribe = (fn: () => void) => {
      pane.listeners.add(fn);
      return () => void pane.listeners.delete(fn);
    };
    const host = { useVisible: () => useSyncExternalStore(subscribe, () => pane.visible) };
    function LivePage() {
      R.useEvalsChanges(true, (c) => seen.push(c.runs.map((r) => r.id)));
      return null;
    }
    const fail = (id: string) => (state.rows = state.rows.map((r) => (r.id === id ? { ...r, score: 0.1, status: 'fail' } : r)));
    const m = await mount(
      <R.EvalsProvider transport={localTransport(handle)} host={host} poll={{ intervalMs: 15, pauseWhenHidden: true }}>
        <R.EvalsApp path="/evals" pages={{ home: LivePage }} />
      </R.EvalsProvider>,
    );
    await tick(40);
    expect(seen).toEqual([]);
    const [first, second] = [state.rows[0]!.id, state.rows[1]!.id];
    fail(first);
    await until(() => expect(seen).toEqual([[first]]));

    // Hidden: nothing is asked. Back on screen: what changed while away arrives.
    await setPane(false);
    fail(second);
    await tick(60);
    expect(seen).toEqual([[first]]);
    await setPane(true);
    await until(() => expect(seen).toEqual([[first], [second]]));
    await m.unmount();
  });
});

describe('the host seam', () => {
  it('routes links, the search and keys through the host, and reads the index the host offers', async () => {
    const went: string[] = [];
    const host = {
      useNavigate: () => (href: string) => went.push(href),
      useSearchIndex: (q: string) => (q === 'fb0' ? { freezes: [{ id: 'fb02cafe0000', name: 'the broken moment' }] } : null),
    };
    const m = await mount(
      <R.EvalsProvider transport={localTransport(rowsOnly())} host={host}>
        <R.EvalsApp path="/evals" pages={{ home: WallPage }} />
      </R.EvalsProvider>,
    );
    // A plain click on a link moves the host's pane; a modified one is the browser's.
    const mark = m.q('.ev-mark') as HTMLAnchorElement;
    await act(async () => mark.click());
    expect(went).toEqual(['/evals']);
    await act(async () => {
      mark.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }) as unknown as Event);
    });
    expect(went).toEqual(['/evals']);

    // The surfaces come from the wall's answer, already loaded.
    await until(() => expect(m.all('[data-test-wall] li')).toHaveLength(2));
    const input = m.q('[data-evals-search] input')!;
    await act(async () => input.focus());
    await typeInto(input, 'out');
    expect(m.all('.ev-search-item').map((b) => b.textContent)).toEqual(['surfaceoutreach']);
    await act(async () => {
      input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as unknown as Event);
    });
    expect(went.at(-1)).toBe('/evals/s/outreach');

    // A freeze no page has loaded comes from the host's index, after the debounce.
    await tick(150);
    await act(async () => input.focus());
    await typeInto(input, 'fb0');
    await until(() => expect(m.all('.ev-search-item').map((b) => b.textContent)).toContain('freezethe broken moment (fb02cafe)'));
    await m.unmount();
  });

  it('keeps each provider to its own answers: no cache is shared', async () => {
    const one = createEvalsHandler({ rows: async () => rowsFor('outreach'), surfaces: () => SURFACES.slice(0, 1) }, policy);
    const two = createEvalsHandler({ rows: async () => rowsFor('sims'), surfaces: () => SURFACES.slice(1) }, policy);
    const m = await mount(
      <>
        <R.EvalsProvider transport={localTransport(one)}>
          <WallPage />
        </R.EvalsProvider>
        <R.EvalsProvider transport={localTransport(two)}>
          <WallPage />
        </R.EvalsProvider>
      </>,
    );
    await until(() => expect(m.all('[data-test-wall]').map((w) => w.textContent)).toEqual(['outreach', 'sims']));
    await m.unmount();
  });

  it('merges a partial host over the defaults, slot by slot', () => {
    const KeyCap = () => null;
    const host = R.resolveEvalsHost({ basePath: '/x', ui: { KeyCap }, format: { duration: () => 'long' }, useNavigate: undefined });
    expect(host.basePath).toBe('/x');
    expect(host.ui.KeyCap).toBe(KeyCap);
    expect(host.ui.Sheet).toBe(R.defaultEvalsHost.ui.Sheet);
    expect(host.format.duration(0)).toBe('long');
    expect(host.format.timeAgo(0, 5 * 60_000)).toBe('5m');
    expect(host.useNavigate).toBe(R.defaultEvalsHost.useNavigate);
  });
});

describe('the default slots', () => {
  const ui = R.defaultEvalsHost.ui;

  it('diffs two texts by line, folding what held still', async () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'H', 'i', 'j'].join('\n');
    const m = await mount(<ui.DiffView oldStr={before} newStr={after} showLineNumbers contextLines={1} />);
    const lines = m.all('[data-ev-diff-view] > div').map((d) => d.className.replace('ev-diff-line ev-diff-line--', '').replace('ev-diff-', '') + ':' + d.textContent);
    expect(lines).toEqual(['gap:6 unchanged lines', 'same:77 g', 'del:8-h', 'add:8+H', 'same:99 i', 'add:10+j']);
    await m.unmount();
  });

  it('draws a toggle, a pair, a key cap, a sheet that closes on Escape, and a tooltip on the body', async () => {
    const picked: string[] = [];
    const closed: boolean[] = [];
    const m = await mount(
      <div data-ev-flip="broke">
        <ui.SegmentedToggle value="a" onChange={(k) => picked.push(k)} items={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B', count: 3 }]} />
        <ui.ExamplePair ex={{ input: 'hello', before: 'old reply', after: 'new reply', note: 'the gate failed' }} stack={false} />
        <ui.KeyCap size="xs">Enter</ui.KeyCap>
        <ui.Sheet.Root open onOpenChange={(o) => closed.push(o)}>
          <ui.Sheet.Content className="ev-test-sheet">
            <ui.Sheet.Title>Epoch 3</ui.Sheet.Title>
          </ui.Sheet.Content>
        </ui.Sheet.Root>
        <ui.HoverTip x={10} y={20}>
          a tip
        </ui.HoverTip>
      </div>,
    );
    const items = m.all('.ev-seg-item');
    expect(items.map((b) => [b.textContent, b.getAttribute('aria-checked')])).toEqual([
      ['A', 'true'],
      ['B3', 'false'],
    ]);
    await act(async () => items[1]!.click());
    expect(picked).toEqual(['b']);
    expect(m.q('.ev-pair-before')!.textContent).toBe('Beforefor: helloold reply');
    expect(m.q('.ev-pair-box')).toBeNull();
    expect(m.q('kbd.ev-kbd--xs')!.textContent).toBe('Enter');
    // Portaled: outside the container, on the body.
    const sheet = win.document.querySelector('[role="dialog"].ev-sheet.ev-test-sheet')!;
    expect(sheet.querySelector('.ev-sheet-title')!.textContent).toBe('Epoch 3');
    expect(win.document.querySelector('.ev-tip')!.textContent).toBe('a tip');
    await act(async () => {
      win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(closed).toEqual([false]);
    await m.unmount();
  });

  it('binds a page key, and leaves it to a field that has focus', async () => {
    const ran: string[] = [];
    function Keys() {
      R.useEvalsHost().useShortcuts({ next: { keys: 'j', label: 'Next', run: () => void ran.push('j') }, open: { keys: 'Mod+Enter', label: 'Open', run: () => void ran.push('open') } });
      return <input data-test-field />;
    }
    const m = await mount(<Keys />);
    const press = (key: string, init: { metaKey?: boolean } = {}, target: EventTarget = win.document.body as unknown as EventTarget) =>
      act(async () => {
        target.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }) as unknown as Event);
      });
    await press('j');
    await press('Enter');
    await press('Enter', { metaKey: true });
    await press('j', {}, m.q('[data-test-field]')!);
    expect(ran).toEqual(['j', 'open']);
    expect(R.defaultEvalsHost.keyParts('x', 'Mod+Enter')).toEqual(['Mod', 'Enter']);
    await m.unmount();
  });

  it('shows a running rep as live, and as stalled once its events stop', async () => {
    const now = Date.now();
    const row = (minutesAgo: number, status: RunRowCore['status'] = 'unscored') => ({ status, lastEventAt: new Date(now - minutesAgo * 60_000).toISOString() });
    const m = await mount(
      <>
        <R.LivenessChip row={row(1)} />
        <R.LivenessChip row={row(9)} />
        <R.LivenessChip row={row(9, 'pass')} />
        <R.LivenessChip row={{ status: 'unscored', lastEventAt: null }} />
      </>,
    );
    expect(m.all('[data-ev-liveness]').map((c) => [c.getAttribute('data-ev-liveness'), c.textContent])).toEqual([
      ['live', 'running'],
      ['stalled', 'stalled?'],
    ]);
    await m.unmount();
  });

  it('says a prompt diff by run ids needs a host that keeps the files', async () => {
    const m = await mount(<R.PromptDiff a="r1" b="r2" file="prompt.md" />);
    expect(m.q('.ev-pdiff-note')!.textContent).toBe('This product keeps no prompt files to compare.');
    await m.unmount();
    const host = { useRunFile: (id: string | null) => ({ text: id === 'r1' ? 'one\ntwo' : 'one\nthree', loading: false }) };
    const n = await mount(
      <R.EvalsProvider transport={null} host={host}>
        <R.PromptDiff a="r1" b="r2" file="prompt.md" />
      </R.EvalsProvider>,
    );
    expect(n.all('.ev-diff-line--del, .ev-diff-line--add').map((d) => d.textContent)).toEqual(['2-two', '2+three']);
    await n.unmount();
  });
});
