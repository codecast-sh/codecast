/**
 * HMR-stable capture-phase keydown listener.
 *
 * The listener is registered eagerly at module-evaluation time via an IIFE,
 * so it always fires *before* any useEffect-based addEventListener calls.
 * The handler ref is stored on `window` and survives dev-server HMR
 * re-evaluations — only the provider swaps the callback. The window key
 * predates the extraction (it shipped inside codecast) and stays unchanged so
 * an app upgrading from an inlined copy hands off to the same slot.
 *
 * Being first is also what makes key claims work: a surface that owns the
 * keyboard while it is up (an overlay holding focus) claims keys here, ahead
 * of the shortcut dispatcher and of every page listener in every phase.
 */

type KeyHandler = (e: KeyboardEvent) => void;

/** Returns true when it took the key. The claim calls preventDefault itself
 *  when the browser's default must not run. */
export type KeyClaim = (e: KeyboardEvent) => boolean;

interface HandlerRef { current: KeyHandler | null; claims?: KeyClaim[] }

const REF_KEY = '__cc_shortcut_handler';

function install(win: Window): HandlerRef {
  let ref = (win as any)[REF_KEY] as HandlerRef | undefined;
  if (!ref) {
    const slot: HandlerRef = { current: null, claims: [] };
    ref = slot;
    (win as any)[REF_KEY] = slot;
    win.addEventListener('keydown', (e) => {
      // The newest claim first: an overlay opened over another owns its keys.
      const claims = slot.claims ?? [];
      for (let i = claims.length - 1; i >= 0; i--) {
        if (claims[i]!(e)) {
          e.stopImmediatePropagation();
          return;
        }
      }
      slot.current?.(e);
    }, true);
  }
  ref.claims ??= [];
  return ref;
}

// Eagerly register at module-evaluation time (runs before any React effects).
const handlerRef: HandlerRef = typeof window === 'undefined' ? { current: null } : install(window);

export function setShortcutHandler(handler: KeyHandler | null): void {
  handlerRef.current = handler;
}

/**
 * Own the keys `claim` takes while it is registered. A claimed key stops in
 * the first window listener: no shortcut, no page listener (window or
 * document, capture or bubble) and no React handler sees it. Returns the
 * release.
 *
 * The current window's slot is used, installed if a test swapped the window
 * after this module loaded; in an app the slot was installed at load.
 */
export function claimKeys(claim: KeyClaim): () => void {
  if (typeof window === 'undefined') return () => {};
  const claims = install(window).claims!;
  claims.push(claim);
  return () => {
    const at = claims.indexOf(claim);
    if (at !== -1) claims.splice(at, 1);
  };
}
