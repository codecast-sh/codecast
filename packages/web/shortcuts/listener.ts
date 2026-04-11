/**
 * HMR-stable capture-phase keydown listener.
 *
 * The listener is registered eagerly at module-evaluation time via an IIFE,
 * so it always fires *before* any useEffect-based addEventListener calls.
 * The handler ref is stored on `window` and survives Vite HMR
 * re-evaluations — only the ShortcutProvider swaps the callback.
 */

type KeyHandler = (e: KeyboardEvent) => void;

interface HandlerRef { current: KeyHandler | null }

const REF_KEY = '__cc_shortcut_handler';

// Eagerly register at module-evaluation time (runs before any React effects).
const handlerRef: HandlerRef = (() => {
  if (typeof window === 'undefined') return { current: null };
  let ref = (window as any)[REF_KEY] as HandlerRef | undefined;
  if (!ref) {
    ref = { current: null };
    (window as any)[REF_KEY] = ref;
    window.addEventListener('keydown', (e) => ref!.current?.(e), true);
  }
  return ref;
})();

export function setShortcutHandler(handler: KeyHandler | null): void {
  handlerRef.current = handler;
}
