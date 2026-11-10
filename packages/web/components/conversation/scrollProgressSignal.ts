// The transcript's scroll position, 0 at the top and 1 at the tail, held
// outside React state. The virtualizer reports it on every scroll event; a
// state write there re-rendered the whole ConversationView each frame. A
// reader subscribes (useSyncExternalStore) and derives only what it draws, so
// it re-renders when that changes and nothing else does.
export type ScrollProgressSignal = {
  get: () => number;
  set: (value: number) => void;
  /** Write without telling readers. Only for a write during the owner's own
   *  render, which redraws every reader anyway: a notification there would
   *  update another component mid-render. */
  seed: (value: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createScrollProgressSignal(initial: number): ScrollProgressSignal {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    seed: (next) => { value = next; },
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
