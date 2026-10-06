/**
 * Test-only plumbing shared by the React mount tests (`react/*.mount.test.tsx`,
 * `react/<group>/*.mount.test.tsx`): a happy-dom window installed as the
 * globals React and the views read, restored after the file's tests, plus
 * mounting, waiting and a run row builder. No product module imports this
 * file, so the layer guard never walks it.
 *
 * A test calls `installDom` before it imports React's DOM side or the react
 * barrel (dynamically), because both read the globals as they load.
 */
import { afterAll } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactNode } from 'react';
import type { RunRowCore } from './contract';

export async function installDom(url: string) {
  const win = new Window({ url });
  const globals = {
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
    getComputedStyle: win.getComputedStyle.bind(win),
    CSS: win.CSS,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [k, v] of Object.entries(globals)) {
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

  const tick = (ms = 0) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

  /** Ticks until `check` stops throwing, so a slow machine waits longer instead of failing. */
  async function until<T>(check: () => T, timeoutMs = 3_000): Promise<T> {
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
      rerender: (next: ReactNode) => act(async () => root.render(next)),
      unmount: () => act(async () => root.unmount()),
    };
  }

  /** A plain click as a reader makes it: bubbling and cancelable, so a link's own handler can take it. */
  const click = (el: Element, init: { metaKey?: boolean } = {}) =>
    act(async () => {
      el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, ...init }) as unknown as Event);
    });

  /** Types into a controlled input the way React hears it: the native setter, then an input event. */
  const typeInto = async (input: HTMLElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    });
  };

  return { win, act, tick, until, mount, click, typeInto };
}

/** Midnight UTC on the nth night from 2026-10-01: a batch stamp. */
export const NIGHT = (n: number) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + n * 86_400_000).toISOString();

/** One rep of `freeze` on `surface` in the nth night's batch; a null score is unscored, and `extra` overrides any field. */
export function rep(surface: string, freeze: string, night: number, seed: number, score: number | null, extra: Partial<RunRowCore> = {}): RunRowCore {
  const batch = NIGHT(night);
  return {
    id: `${surface}-${freeze}-seed${seed}-${batch}`, surface, freezeId: freeze, freezeName: `moment ${freeze}`, visibility: 'private',
    seed, stamp: batch, batch, batchAt: batch, cadence: 'nightly', status: score === null ? 'unscored' : score >= 0.7 ? 'pass' : 'fail',
    score, passMark: 0.7, gatesFailed: [], checks: {}, missedFloors: [], model: null, judgeModel: null, ruler: null,
    gitHead: null, mainSha: null, dirty: false, offBranch: false, treePatch: null, sourceHashDisk: null, promptSha: null, freezeSha: null,
    liveReads: 0, costUsd: 0.01, judgeCostUsd: 0.001, realMs: 1000, ...extra,
  };
}
