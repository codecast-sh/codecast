// @platform/keys — the keyboard layer.
//
// Two halves. The chord engine (engine.ts): chord sequences, context stacks
// and vim-style pending buffers; it knows nothing about any application's
// actions. The action catalog (catalog.ts and friends): typed action defs
// matched flat against KeyboardEvents, the dispatch guards (inputs, modals,
// key-owning surfaces), the React provider, and user-editable binding
// settings. Each app registers its own action ids and bindings against either
// half; the cheat sheet (cheatsheet.ts) renders both as one keymap.

export {
  KeyEngine,
  keyEngine,
  isMac,
  eventToken,
  parseSpec,
  tokenParts,
  type Binding,
  type KeyContext,
  type EngineState,
} from "./engine";

export {
  createShortcutCatalog,
  detectMac,
  hasOpenModal,
  isEditableTarget,
  inputGuardBypass,
  altChordDirection,
  type ShortcutDef,
  type ShortcutCatalog,
} from "./catalog";

export {
  ShortcutDispatcher,
  createKeydownHandler,
  type ShortcutHandler,
  type KeydownOptions,
} from "./dispatch";

export { setShortcutHandler } from "./listener";

export {
  createShortcutProvider,
  type ShortcutContextValue,
  type ShortcutProviderKit,
} from "./provider";

export {
  createShortcutSettings,
  bindShortcutStorage,
  type ShortcutBindings,
  type LegacyShortcutId,
  type ShortcutSettingsConfig,
  type ShortcutSettings,
  type ShortcutOverrideStorage,
} from "./settings";

export {
  engineCheatSheet,
  catalogCheatSheet,
  type CheatSheetEntry,
} from "./cheatsheet";
