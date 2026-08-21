// The non-React half of the catalog runtime: a handler registry with decline
// semantics, plus the keydown resolution loop that turns one KeyboardEvent
// into at most one action dispatch. The React provider (provider.tsx) is a
// thin binding over this, so the behavior is testable without rendering.

import { ShortcutCatalog, hasOpenModal, isEditableTarget, inputGuardBypass } from './catalog';

export type ShortcutHandler = () => boolean | void;

// Several components may register for one action (e.g. each mounted list view
// registers list.down). Dispatch walks them: a handler returning false
// declines and passes to the next; true handles and stops; void handles but
// lets the rest run. Returns whether anyone handled it.
export class ShortcutDispatcher<A extends string> {
  private handlers = new Map<A, Set<ShortcutHandler>>();
  private contexts = new Set<string>();

  register(action: A, handler: ShortcutHandler): () => void {
    if (!this.handlers.has(action)) this.handlers.set(action, new Set());
    this.handlers.get(action)!.add(handler);
    return () => {
      const set = this.handlers.get(action);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(action);
      }
    };
  }

  setContext(ctx: string, active: boolean): void {
    if (active) this.contexts.add(ctx);
    else this.contexts.delete(ctx);
  }

  hasContext(ctx: string): boolean {
    return this.contexts.has(ctx);
  }

  dispatch(action: A): boolean {
    const actionHandlers = this.handlers.get(action);
    if (!actionHandlers || actionHandlers.size === 0) return false;
    let handled = false;
    for (const handler of actionHandlers) {
      const result = handler();
      if (result === false) continue;
      handled = true;
      if (result === true) break;
    }
    return handled;
  }
}

export interface KeydownOptions<A extends string> {
  // Regions that are input-like beyond real editables (a review region, a
  // surface that owns its own single-letter keys). Focus inside a match is
  // treated like focus in an input: only skipInputCheck bindings fire, and the
  // region's own keydown handler still receives the key.
  inputLikeSelector?: string;
  // Surfaces that own the keyboard outright (an embedded terminal lives on
  // Ctrl chords, and a capture-phase window listener would eat them before the
  // surface sees the key). While focus is inside `selector`, only the `allow`
  // actions may fire; everything else falls through to the surface.
  keyboardOwners?: { selector: string; allow: A[] }[];
  onShortcutUsed?: (action: A) => void;
}

function isInputTarget(e: KeyboardEvent, inputLikeSelector?: string): boolean {
  const el = e.target as HTMLElement;
  if (!el) return false;
  if (isEditableTarget(el)) return true;
  if (inputLikeSelector && typeof el.closest === 'function' && el.closest(inputLikeSelector)) return true;
  return false;
}

// The resolution loop: first matching def wins. An open modal dialog owns the
// keyboard — no shortcut may act on the surface behind it, whether the key was
// pressed inside the dialog or focus escaped to body; only worksInModal
// app-chrome shortcuts fire.
export function createKeydownHandler<A extends string>(
  catalog: ShortcutCatalog<A>,
  dispatcher: ShortcutDispatcher<A>,
  opts: KeydownOptions<A> = {},
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    const inInput = isInputTarget(e, opts.inputLikeSelector);
    const modalOpen = hasOpenModal();
    const target = e.target as HTMLElement | null;
    const owner = opts.keyboardOwners?.find(o => target?.closest?.(o.selector));

    for (const def of catalog.shortcuts) {
      if (owner && !owner.allow.includes(def.action)) continue;
      if (!catalog.matchShortcut(e, def)) continue;
      if (modalOpen && !def.worksInModal) continue;
      if (def.when && !dispatcher.hasContext(def.when)) continue;
      if (inInput && !inputGuardBypass(def, target)) continue;

      if (dispatcher.dispatch(def.action)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        opts.onShortcutUsed?.(def.action);
        return;
      }
    }
  };
}
