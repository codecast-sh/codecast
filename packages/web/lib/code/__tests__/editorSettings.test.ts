import { afterAll, describe, expect, test } from "bun:test";
import { useInboxStore } from "../../../store/inboxStore";
import {
  DEFAULT_EDITOR_SETTINGS,
  editorSetting,
  explicitEditorSettings,
  onEditorSettingsChange,
  resolveEditorSettings,
  sanitizeEditorSettings,
  setEditorSetting,
  hasVimConfig,
  settingsFromVimOptions,
  vimModeOn,
  vimOptionsFromSettings,
} from "../editorSettings";
import { resolveValues } from "../vim/editorOptions";
import { DEFAULT_EDITOR_OPTIONS } from "../setup";

// The store is shared across a run's files: put back what these tests replace.
const original = { updateClientUI: useInboxStore.getState().updateClientUI, clientState: useInboxStore.getState().clientState };
afterAll(() => useInboxStore.setState(original as never));

describe("precedence", () => {
  test("defaults when nothing decides", () => {
    const r = resolveEditorSettings({});
    expect(r.values).toEqual({ ...DEFAULT_EDITOR_SETTINGS });
    expect(new Set(Object.values(r.source))).toEqual(new Set(["default"]));
  });

  test("the vimrc beats a default, an explicit choice beats the vimrc", () => {
    const vimrc = settingsFromVimOptions({ number: true, relativenumber: true, wrap: true, tabstop: 2, list: true });
    expect(vimrc).toEqual({ lineNumbers: "relative", softWrap: true, tabSize: 2, renderWhitespace: true });
    const r = resolveEditorSettings({ softWrap: false, fontSize: 15 }, vimrc);
    expect(r.values.lineNumbers).toBe("relative");
    expect(r.source.lineNumbers).toBe("vimrc");
    expect(r.values.softWrap).toBe(false);
    expect(r.source.softWrap).toBe("set");
    // What the vimrc would have set stays visible where it lost.
    expect(r.vimrc.softWrap).toBe(true);
    expect(r.values.fontSize).toBe(15);
    expect(r.source.fontSize).toBe("set");
    expect(r.source.autosave).toBe("default");
  });

  test("vim options map to line numbers the way vim draws them", () => {
    expect(settingsFromVimOptions({ number: true })).toEqual({ lineNumbers: "absolute" });
    expect(settingsFromVimOptions({ number: false })).toEqual({ lineNumbers: "off" });
    expect(settingsFromVimOptions({ relativenumber: true })).toEqual({ lineNumbers: "relative" });
    expect(settingsFromVimOptions({ relativenumber: false })).toEqual({ lineNumbers: "off" });
    expect(settingsFromVimOptions({})).toEqual({});
    expect(settingsFromVimOptions(null)).toEqual({});
  });

  test("vim mode follows the vimrc only on auto", () => {
    expect(vimModeOn("auto", true)).toBe(true);
    expect(vimModeOn("auto", false)).toBe(false);
    expect(vimModeOn("on", false)).toBe(true);
    expect(vimModeOn("off", true)).toBe(false);
  });

  test("defaults agree with the editor core's", () => {
    expect(DEFAULT_EDITOR_SETTINGS.lineNumbers).toBe(DEFAULT_EDITOR_OPTIONS.lineNumbers);
    expect(DEFAULT_EDITOR_SETTINGS.softWrap).toBe(DEFAULT_EDITOR_OPTIONS.softWrap);
    expect(DEFAULT_EDITOR_SETTINGS.tabSize).toBe(DEFAULT_EDITOR_OPTIONS.tabSize);
  });
});

describe("choices seeded into vim", () => {
  test("each choice becomes the vim option it stands for, and maps back", () => {
    for (const lineNumbers of ["absolute", "relative", "off"] as const) {
      expect(settingsFromVimOptions(vimOptionsFromSettings({ lineNumbers })).lineNumbers).toBe(lineNumbers);
    }
    expect(vimOptionsFromSettings({ softWrap: true, renderWhitespace: false, tabSize: 2, fontSize: 15 })).toEqual({ wrap: true, list: false, tabstop: 2 });
    expect(vimOptionsFromSettings({})).toEqual({});
  });

  test("a choice beats the vimrc's global set and its filetype setlocal", () => {
    const report = { options: { global: { tabstop: 8, wrap: false }, byFiletype: { go: { tabstop: 4 } } } };
    const seed = vimOptionsFromSettings({ tabSize: 2, softWrap: true });
    expect(resolveValues(report as never, "TypeScript", seed)).toMatchObject({ tabstop: 2, wrap: true });
    expect(resolveValues(report as never, "Go", seed)).toMatchObject({ tabstop: 2, wrap: true });
    expect(resolveValues(report as never, "Go")).toMatchObject({ tabstop: 4, wrap: false });
    expect(resolveValues(null, undefined, seed)).toEqual(seed);
  });

  test("auto turns vim on only for a response with config in it", () => {
    expect(hasVimConfig(null)).toBe(false);
    expect(hasVimConfig({ sources: [{ path: "/h/.vimrc", content: "  \n" }], overlay: null } as never)).toBe(false);
    expect(hasVimConfig({ sources: [], overlay: { path: "/h/o", content: "set nu" } } as never)).toBe(true);
  });
});

describe("validation", () => {
  test("keeps only valid keys", () => {
    expect(sanitizeEditorSettings({ fontSize: 14, lineNumbers: "weird", autosave: "delay", tabSize: 0, softWrap: "yes", junk: 1 })).toEqual({
      fontSize: 14,
      autosave: "delay",
    });
    expect(sanitizeEditorSettings(null)).toEqual({});
    expect(sanitizeEditorSettings("x")).toEqual({});
  });
});

describe("persistence", () => {
  test("a setting is written to the synced ui bag, cleared, and followed", () => {
    // The real updateClientUI stamps and dispatches; stand in with a plain
    // write to the same bag, which is what the stamped sync carries.
    const writes: Record<string, unknown>[] = [];
    useInboxStore.setState({
      clientState: { ...original.clientState, ui: {} },
      updateClientUI: (p: Record<string, unknown>) => {
        writes.push(p);
        useInboxStore.setState((s) => ({ clientState: { ...s.clientState, ui: { ...s.clientState.ui, ...p } } }) as never);
      },
    } as never);
    const seen: unknown[] = [];
    const off = onEditorSettingsChange((s) => seen.push(s));

    setEditorSetting("autosave", "delay");
    expect(writes).toEqual([{ code_editor: { autosave: "delay" } }]);
    expect(editorSetting("autosave")).toBe("delay");
    setEditorSetting("fontSize", 15);
    expect(explicitEditorSettings()).toEqual({ autosave: "delay", fontSize: 15 });
    // Unchanged and invalid writes never reach the store.
    setEditorSetting("fontSize", 15);
    setEditorSetting("fontSize", 99);
    expect(writes.length).toBe(2);
    // Cleared: follows the vimrc and the default again.
    setEditorSetting("autosave", undefined);
    expect(explicitEditorSettings()).toEqual({ fontSize: 15 });
    expect(editorSetting("autosave")).toBe("off");
    expect(seen).toEqual([{ autosave: "delay" }, { autosave: "delay", fontSize: 15 }, { fontSize: 15 }]);

    // Another device's write lands as a server push into the same bag.
    useInboxStore.setState((s) => ({ clientState: { ...s.clientState, ui: { ...s.clientState.ui, code_editor: { vimMode: "off" } } } }) as never);
    expect(editorSetting("vimMode")).toBe("off");
    expect(seen.length).toBe(4);
    // Unrelated ui traffic does not notify.
    useInboxStore.setState((s) => ({ clientState: { ...s.clientState, ui: { ...s.clientState.ui, theme: "dark" } } }) as never);
    expect(seen.length).toBe(4);
    off();
  });
});

describe("persistence through the real store action", () => {
  test("stamps code_editor so it syncs last-writer-wins across devices", () => {
    useInboxStore.setState({ updateClientUI: original.updateClientUI, clientState: { ...original.clientState, ui: {} } } as never);
    setEditorSetting("lineNumbers", "relative");
    const ui = useInboxStore.getState().clientState.ui as Record<string, unknown>;
    expect(ui.code_editor).toEqual({ lineNumbers: "relative" });
    expect(typeof ui["code_editor:ts"]).toBe("number");
    expect(editorSetting("lineNumbers")).toBe("relative");
  });
});
