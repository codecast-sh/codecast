/**
 * HMR-stable capture-phase keydown listener.
 *
 * Registered once at module-evaluation time via a window global, so it
 * always fires *before* any useEffect-based addEventListener calls.
 * The handler ref survives Vite HMR re-evaluations — only the
 * ShortcutProvider swaps the callback, the listener itself never moves.
 */

type KeyHandler = (e: KeyboardEvent) => void;

interface HandlerRef { current: KeyHandler | null }

const REF_KEY = '__cc_shortcut_handler';

function getRef(): HandlerRef {
  if (typeof window === 'undefined') return { current: null };
  let ref = (window as any)[REF_KEY] as HandlerRef | undefined;
  if (!ref) {
    ref = { current: null };
    (window as any)[REF_KEY] = ref;
    window.addEventListener('keydown', (e) => ref!.current?.(e), true);
  }
  return ref;
}

export function setShortcutHandler(handler: KeyHandler | null): void {
  getRef().current = handler;
}
