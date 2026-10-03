// The non-React half of the catalog runtime: a handler registry with decline
// semantics, plus the keydown resolution loop that turns one KeyboardEvent
// into at most one action dispatch. The React provider (provider.tsx) is a
// thin binding over this, so the behavior is testable without rendering.

import { ShortcutCatalog, type ShortcutDef, hasOpenModal, isEditableTarget, inputGuardBypass } from './catalog';

/** How an action arrived: a key press the keydown handler matched, or a
 *  named dispatch (a palette row, a button, a menu). A handler that defers to
 *  the focused field's own key handling applies that only to a key press. */
export type DispatchSource = "key" | "named";

export type ShortcutHandler = (source: DispatchSource) => boolean | void;

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

  dispatch(action: A, source: DispatchSource = "named"): boolean {
    const actionHandlers = this.handlers.get(action);
    if (!actionHandlers || actionHandlers.size === 0) return false;
    let handled = false;
    for (const handler of actionHandlers) {
      const result = handler(source);
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

function isInputTarget(el: HTMLElement | null, inputLikeSelector?: string): boolean {
  if (!el) return false;
  if (isEditableTarget(el)) return true;
  if (inputLikeSelector && typeof el.closest === 'function' && el.closest(inputLikeSelector)) return true;
  return false;
}

export type KeyOwnership<A extends string> = Pick<KeydownOptions<A>, 'inputLikeSelector' | 'keyboardOwners'>;

// Whether a binding may act with focus at `target`, apart from the key itself
// and its `when` context: a key-owning surface lets through only its allowed
// actions, an open modal only worksInModal bindings, and an input (or an
// input-like region) only bindings that skip the input check. The keydown loop
// asks this per matching def, and a press that arrives outside it (a desktop
// Edit menu handing ⌘Z back to the page) asks the same question, so the two
// paths cannot disagree.
export function shortcutAllowedAt<A extends string>(
  target: Element | null,
  def: ShortcutDef<A>,
  opts: KeyOwnership<A> = {},
  modalOpen: boolean = hasOpenModal(),
): boolean {
  const el = target as HTMLElement | null;
  const owner = opts.keyboardOwners?.find(o => el?.closest?.(o.selector));
  if (owner && !owner.allow.includes(def.action)) return false;
  if (modalOpen && !def.worksInModal) return false;
  if (isInputTarget(el, opts.inputLikeSelector) && !inputGuardBypass(def, el)) return false;
  return true;
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
    const modalOpen = hasOpenModal();
    const target = e.target as HTMLElement | null;

    for (const def of catalog.shortcuts) {
      if (!catalog.matchShortcut(e, def)) continue;
      if (def.when && !dispatcher.hasContext(def.when)) continue;
      if (!shortcutAllowedAt(target, def, opts, modalOpen)) continue;
      if (def.noRepeat && e.repeat) {
        e.preventDefault();
        return;
      }

      if (dispatcher.dispatch(def.action, "key")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        opts.onShortcutUsed?.(def.action);
        return;
      }
    }
  };
}
