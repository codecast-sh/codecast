// Codecast's binding of the @platform/keys action catalog. The mechanics —
// chord matching (incl. the mac Option dead-key fallback), input/modal guards,
// keycap formatting — live in the package. The action ids and their default
// bindings live in @codecast/shared/contracts/shortcutCatalog, where the CLI
// and the server can read them too. This file builds the live catalog: the
// defaults with the person's own bindings (keyBindings.ts) applied on top.

import {
  createShortcutCatalog,
  hasOpenModal,
  isEditableTarget,
  inputGuardBypass,
  altChordDirection,
} from '@platform/keys';
import { useSyncExternalStore } from 'react';
import { SHORTCUTS, type ShortcutAction, type ShortcutDef } from '@codecast/shared/contracts/shortcutCatalog';
import { applyKeyBindings, type KeyBindingOverride } from '@codecast/shared/contracts/keyBindings';

export { SHORTCUTS, type ShortcutAction, type ShortcutDef };
export { hasOpenModal, isEditableTarget, inputGuardBypass, altChordDirection };

// One object for the life of the page: the keydown handler holds it, so a
// rebinding rebuilds the catalog and copies it in rather than replacing it.
export const shortcutCatalog = createShortcutCatalog<ShortcutAction>(SHORTCUTS);

let appliedOverrides: KeyBindingOverride[] = [];
let version = 0;
const listeners = new Set<() => void>();

/** Applies the person's bindings (client_state.ui.key_bindings) to the live
 *  catalog. Every chord match, label and help row reads the result. */
export function setKeyBindings(overrides: KeyBindingOverride[] | undefined): void {
  const next = overrides ?? [];
  if (JSON.stringify(next) === JSON.stringify(appliedOverrides)) return;
  appliedOverrides = next;
  const live = applyKeyBindings(SHORTCUTS, next, shortcutCatalog.isMac);
  Object.assign(shortcutCatalog, createShortcutCatalog<ShortcutAction>(live, { isMac: shortcutCatalog.isMac }));
  version++;
  for (const fn of [...listeners]) fn();
}

/** The bindings the live catalog was built from. */
export function getKeyBindings(): KeyBindingOverride[] {
  return appliedOverrides;
}

/** Re-renders when the bindings change. For surfaces that list or label keys. */
export function useKeyBindingsVersion(): number {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => version,
    () => version,
  );
}

/** An action's first live binding as keycap parts (null when unbound),
 *  re-rendering when the person rebinds it. Every key hint reads this. */
export function useShortcutParts(action: ShortcutAction | undefined): string[] | null {
  useKeyBindingsVersion();
  const def = action ? shortcutCatalog.getShortcutsForAction(action)[0] : undefined;
  return def ? shortcutCatalog.formatShortcutParts(def) : null;
}

/** A title naming an action's live binding: "Label (⌘K)", or just the label
 *  when the action is unbound. */
export function withShortcut(label: string, action: ShortcutAction): string {
  const keys = shortcutCatalog.formatShortcutLabel(action);
  return keys ? `${label} (${keys})` : label;
}

export const isMac = shortcutCatalog.isMac;
export const matchShortcut: typeof shortcutCatalog.matchShortcut = (e, def) => shortcutCatalog.matchShortcut(e, def);
export const getShortcutsForAction: typeof shortcutCatalog.getShortcutsForAction = (action) => shortcutCatalog.getShortcutsForAction(action);
export const getShortcutsByContext: typeof shortcutCatalog.getShortcutsByContext = (when) => shortcutCatalog.getShortcutsByContext(when);
export const formatShortcutParts: typeof shortcutCatalog.formatShortcutParts = (def) => shortcutCatalog.formatShortcutParts(def);
export const formatAcceleratorParts: typeof shortcutCatalog.formatAcceleratorParts = (acc) => shortcutCatalog.formatAcceleratorParts(acc);
export const formatShortcutLabel: typeof shortcutCatalog.formatShortcutLabel = (action) => shortcutCatalog.formatShortcutLabel(action);

/** Whether a key event is any of an action's live chords. For a page that
 *  reads its own keys rather than registering with the dispatcher, so a
 *  rebinding reaches it too. */
export function matchesAction(e: KeyboardEvent, action: ShortcutAction): boolean {
  return shortcutCatalog.getShortcutsForAction(action).some((def) => shortcutCatalog.matchShortcut(e, def));
}
