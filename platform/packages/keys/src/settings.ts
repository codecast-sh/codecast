// User-editable binding settings: defaults merge, a legacy-id rename map, and
// overrides-only persistence with the storage injected. Pure logic — no fs, no
// electron — so the app shell (desktop main process, web settings page) owns
// the I/O. Generalized from codecast's electron shortcutSettings.js, whose
// migration taught the two rules encoded here:
//
// - A persisted value equal to a retired id's historical default is a frozen
//   default, not a customization: early builds persisted the FULL map on any
//   change, so migrating it verbatim would shadow the current default forever.
//   Only a genuinely customized value carries over to the renamed id.
// - Persist only overrides that differ from the defaults (including "", the
//   user's deliberate "no binding"). Keys matching the default are dropped so
//   future default changes reach every machine; retired keys are dropped so
//   stale entries can't resurface.

export type ShortcutBindings = Record<string, string>;

export interface LegacyShortcutId {
  /** Current id the legacy value carries over to. */
  renameTo: string;
  /** The retired id's historical default; a persisted value equal to it is a
      frozen default and must not carry over. */
  historicalDefault?: string;
}

export interface ShortcutSettingsConfig {
  defaults: ShortcutBindings;
  /** Retired id → where its value migrates. */
  legacy?: Record<string, LegacyShortcutId>;
}

export interface ShortcutSettings {
  defaults: ShortcutBindings;
  /** Persisted overrides (may be undefined) → the effective bindings. ""
      survives the merge: it is the user's deliberate "no binding". */
  merge(persisted?: ShortcutBindings): ShortcutBindings;
  /** Effective bindings → the object to persist: only overrides that differ
      from the defaults (including ""). */
  diffOverrides(bindings: ShortcutBindings): ShortcutBindings;
}

export function createShortcutSettings(config: ShortcutSettingsConfig): ShortcutSettings {
  const { defaults, legacy = {} } = config;

  function merge(persisted?: ShortcutBindings): ShortcutBindings {
    const merged: ShortcutBindings = { ...defaults, ...persisted };
    for (const [legacyId, m] of Object.entries(legacy)) {
      const value = merged[legacyId];
      if (value && value !== m.historicalDefault && persisted?.[m.renameTo] === undefined) {
        merged[m.renameTo] = value;
      }
      delete merged[legacyId];
    }
    return merged;
  }

  function diffOverrides(bindings: ShortcutBindings): ShortcutBindings {
    const overrides: ShortcutBindings = {};
    for (const [key, acc] of Object.entries(bindings)) {
      if (!(key in defaults)) continue;
      if (acc !== defaults[key]) overrides[key] = acc;
    }
    return overrides;
  }

  return { defaults, merge, diffOverrides };
}

// The persistence seam: the app injects how the overrides object is read and
// written (a settings.json field, localStorage, a server row) and gets
// load/save in effective-bindings terms.
export interface ShortcutOverrideStorage {
  read(): ShortcutBindings | undefined;
  write(overrides: ShortcutBindings): void;
}

export function bindShortcutStorage(
  settings: ShortcutSettings,
  storage: ShortcutOverrideStorage,
): { load(): ShortcutBindings; save(bindings: ShortcutBindings): void } {
  return {
    load: () => settings.merge(storage.read()),
    save: (bindings) => storage.write(settings.diffOverrides(bindings)),
  };
}
