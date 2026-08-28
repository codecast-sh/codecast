// Substituting the store hook, without breaking every test file that runs later.
//
// `mock.module` is process-global: bun runs the whole suite in one process, so
// a substitution registered here answers for EVERY file that imports the store
// afterwards, not just the file that asked for it. Three ways a hand-rolled
// substitution has broken siblings:
//
//   - it dropped the module's other exports, so `store`, the actions and the
//     hooks disappeared;
//   - it replaced the hook with a bare arrow, so `useInboxStore.getState()`
//     went undefined and lib/calls/walkie.ts threw on import;
//   - it answered with a hand-written state, so a sibling rendering a real
//     component read `s.clientState.ui` off an object that had two keys.
//
// So the substitution keeps the real module, keeps the hook's own methods, and
// answers with the REAL state carrying only the overrides on top. A test states
// what it wants to control and inherits everything else.
//
// Why substitute at all: under `renderToStaticMarkup` zustand answers from
// `getInitialState` — React's server snapshot — so a `setState` before the
// render is simply not visible and every case would silently test the default.

import { mock } from "bun:test";

type State = Record<string, any>;

// Snapshotted, not held as a namespace: `mock.module` mutates the live module
// object in place, so a namespace read after the first substitution hands back
// the substitution — including its own `getState`, which recurses forever, and
// the `extra` exports of whichever file registered first. The spread copies the
// true exports once, on first import, before anything can be replaced.
const real = { ...(await import("../../store/inboxStore")) };
const realHook = real.useInboxStore;

/**
 * Replace the store hook with one that answers `{...realState, ...overrides()}`.
 *
 * `overrides` receives the real state, so a nested field can be built on top of
 * it, and runs per read, so a test can flip a field between renders. `extra`
 * replaces further exports of the module (e.g. `useTrackedStore`). Returns the
 * state reader, for a test that needs it directly.
 */
export function mockInboxStore(overrides: (real: State) => State, extra: State = {}) {
  const getState = () => {
    const base = realHook.getState();
    return { ...base, ...overrides(base) };
  };
  mock.module("../../store/inboxStore", () => ({
    ...real,
    useInboxStore: Object.assign(
      (selector: (s: State) => unknown) => selector(getState()),
      realHook,
      { getState },
    ),
    ...extra,
  }));
  return getState;
}
