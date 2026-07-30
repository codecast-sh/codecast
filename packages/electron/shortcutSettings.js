// Pure logic for the OS-global shortcut settings: defaults, the legacy-key
// migration, and diff-only persistence. Kept free of electron/fs imports so it
// is unit-testable (shortcutSettings.test.js) — main.js owns the I/O.

const DEFAULT_SHORTCUTS = {
  toggleWindow: "CommandOrControl+Alt+Space",
  togglePalette: "Control+Alt+Space",
  newSession: "Control+Shift+N",
  toggleEnv: "CommandOrControl+Alt+L",
};

// newSession's pre-rename key and its only historical default. saveSettings
// used to persist the FULL shortcut map, so any machine that ever customized
// one shortcut froze this default into settings.json — migrating it verbatim
// would shadow the current Control+Shift+N default forever. Only a genuinely
// customized value carries over.
const LEGACY_COMPOSE_KEY = "toggleCompose";
const LEGACY_COMPOSE_DEFAULT = "CommandOrControl+Alt+N";

// Persisted `shortcuts` object from settings.json (may be undefined) → the
// effective bindings. "" survives the merge: it is the user's deliberate
// "no binding".
function mergeShortcuts(persisted) {
  const merged = { ...DEFAULT_SHORTCUTS, ...persisted };
  const legacy = merged[LEGACY_COMPOSE_KEY];
  if (legacy && legacy !== LEGACY_COMPOSE_DEFAULT && persisted?.newSession === undefined) {
    merged.newSession = legacy;
  }
  delete merged[LEGACY_COMPOSE_KEY];
  return merged;
}

// Effective bindings → the object to persist: only overrides that differ from
// DEFAULT_SHORTCUTS (including ""). Keys matching the default are dropped so
// future default changes reach every machine; retired keys are dropped so
// stale entries can't resurface.
function diffOverrides(shortcuts) {
  const overrides = {};
  for (const [key, acc] of Object.entries(shortcuts)) {
    if (!(key in DEFAULT_SHORTCUTS)) continue;
    if (acc !== DEFAULT_SHORTCUTS[key]) overrides[key] = acc;
  }
  return overrides;
}

module.exports = { DEFAULT_SHORTCUTS, mergeShortcuts, diffOverrides };
