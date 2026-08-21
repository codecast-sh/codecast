import { test, expect, describe } from "bun:test";
import { createShortcutSettings, bindShortcutStorage, type ShortcutBindings } from "./settings";

// Ported from codecast's electron shortcutSettings.test.js, generalized to a
// fixture config with the same shape: a retired id whose value migrates to a
// renamed one, and a historical default that must not carry over.

const DEFAULTS = {
  toggleWindow: "CommandOrControl+Alt+Space",
  create: "Control+Shift+N",
  toggleEnv: "CommandOrControl+Alt+L",
};

const settings = createShortcutSettings({
  defaults: DEFAULTS,
  legacy: {
    // create's pre-rename id and its only historical default. Early builds
    // persisted the FULL shortcut map, so any machine that ever customized one
    // shortcut froze this default into storage — migrating it verbatim would
    // shadow the current default forever. Only a genuinely customized value
    // carries over.
    legacyCreate: { renameTo: "create", historicalDefault: "CommandOrControl+Alt+N" },
  },
});

describe("merge", () => {
  test("no persisted settings → pure defaults", () => {
    expect(settings.merge(undefined)).toEqual(DEFAULTS);
  });

  test("frozen legacy default does NOT shadow the current default", () => {
    const merged = settings.merge({
      toggleWindow: "CommandOrControl+Alt+Space",
      legacyCreate: "CommandOrControl+Alt+N",
      toggleEnv: "CommandOrControl+Alt+L",
    });
    expect(merged.create).toBe("Control+Shift+N");
    expect("legacyCreate" in merged).toBe(false);
  });

  test("genuinely customized legacy value migrates to the renamed id", () => {
    const merged = settings.merge({ legacyCreate: "CommandOrControl+Shift+K" });
    expect(merged.create).toBe("CommandOrControl+Shift+K");
  });

  test("explicit value on the renamed id wins over the legacy one", () => {
    const merged = settings.merge({
      legacyCreate: "CommandOrControl+Shift+K",
      create: "Control+Shift+Y",
    });
    expect(merged.create).toBe("Control+Shift+Y");
  });

  test('removed binding ("") survives the merge and the legacy migration', () => {
    const merged = settings.merge({ create: "", legacyCreate: "CommandOrControl+Shift+K" });
    expect(merged.create).toBe("");
  });
});

describe("diffOverrides", () => {
  test("persists only non-default values, including removals", () => {
    const overrides = settings.diffOverrides({
      ...DEFAULTS,
      create: "",
      toggleEnv: "CommandOrControl+Alt+E",
    });
    expect(overrides).toEqual({ create: "", toggleEnv: "CommandOrControl+Alt+E" });
  });

  test("drops retired keys so a legacy id can't resurface", () => {
    const overrides = settings.diffOverrides({ ...DEFAULTS, legacyCreate: "CommandOrControl+Alt+N" });
    expect(overrides).toEqual({});
  });

  test("round trip: default-valued map persists as empty overrides", () => {
    expect(settings.diffOverrides(settings.merge(undefined))).toEqual({});
  });
});

describe("bindShortcutStorage", () => {
  test("load merges from storage; save writes overrides only", () => {
    let persisted: ShortcutBindings | undefined = { legacyCreate: "CommandOrControl+Shift+K" };
    const store = bindShortcutStorage(settings, {
      read: () => persisted,
      write: (o) => { persisted = o; },
    });

    const effective = store.load();
    expect(effective.create).toBe("CommandOrControl+Shift+K");

    store.save({ ...effective, toggleEnv: "CommandOrControl+Alt+E" });
    expect(persisted).toEqual({
      create: "CommandOrControl+Shift+K",
      toggleEnv: "CommandOrControl+Alt+E",
    });
    // The migrated value now persists under the current id and round-trips.
    expect(store.load().create).toBe("CommandOrControl+Shift+K");
  });
});
