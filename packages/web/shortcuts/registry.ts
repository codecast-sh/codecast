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
import { SHORTCUTS, type ShortcutAction, type ShortcutDef } from '@codecast/shared/contracts/shortcutCatalog';

export { SHORTCUTS, type ShortcutAction, type ShortcutDef };
export { hasOpenModal, isEditableTarget, inputGuardBypass, altChordDirection };

export const shortcutCatalog = createShortcutCatalog(SHORTCUTS);

export const isMac = shortcutCatalog.isMac;
export const matchShortcut = shortcutCatalog.matchShortcut;
export const getShortcutsForAction = shortcutCatalog.getShortcutsForAction;
export const getShortcutsByContext = shortcutCatalog.getShortcutsByContext;
export const formatShortcutParts = shortcutCatalog.formatShortcutParts;
export const formatAcceleratorParts = shortcutCatalog.formatAcceleratorParts;
export const formatShortcutLabel = shortcutCatalog.formatShortcutLabel;
