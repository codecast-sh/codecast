// The person's editor settings (Settings > Editor), and the one place every
// editor feature reads them from.
//
// Stored as what the person chose and nothing else: `clientState.ui.code_editor`
// holds only the keys they set, stamped and synced like every ui preference,
// so their choices follow them to every device. A key they never set falls
// through to their vimrc, then to the editor's default. That is the precedence
// throughout: default < vimrc < an explicit choice here.
//
// No CodeMirror here: the settings page imports this, and must not pull the
// editor chunk in. The editor side (setup.editorSettingsExtension, autosave.ts)
// reads `explicitEditorSettings()` and follows `onEditorSettingsChange`.

import { useInboxStore, type ClientUI } from "../../store/inboxStore";
import { registerCodeCommand } from "./commands";
import type { CodeVimrcResponse } from "@codecast/shared/contracts";
import type { VimOptionValues } from "./vim/types";

export type VimModeSetting = "auto" | "on" | "off";
export type AutosaveMode = "off" | "delay" | "focus";
export type LineNumberSetting = "absolute" | "relative" | "off";

export interface EditorSettings {
  /** auto: on when a vimrc is found. */
  vimMode: VimModeSetting;
  /** Pixels, the editor text; the gutter is a pixel smaller. */
  fontSize: number;
  /** A multiple of the font size. */
  lineHeight: number;
  lineNumbers: LineNumberSetting;
  softWrap: boolean;
  renderWhitespace: boolean;
  /** off: Cmd-S and `:w` only. delay: a second after the last edit. focus:
   *  when the editor loses focus or the file leaves it. */
  autosave: AutosaveMode;
  formatOnSave: boolean;
  /** Display width of a tab, and the indent width a file whose text and
   *  language cannot say gets. */
  tabSize: number;
  /** The cursor line's session and age, dim at the line's end. */
  inlineBlame: boolean;
}

export type EditorSettingKey = keyof EditorSettings;
export type ExplicitEditorSettings = Partial<EditorSettings>;

/** The editor's own defaults. They match setup.DEFAULT_EDITOR_OPTIONS and the
 *  code theme (13px, 1.6), which a test holds them to. */
export const DEFAULT_EDITOR_SETTINGS: Readonly<EditorSettings> = Object.freeze({
  vimMode: "auto",
  fontSize: 13,
  lineHeight: 1.6,
  lineNumbers: "absolute",
  softWrap: false,
  renderWhitespace: false,
  autosave: "off",
  formatOnSave: false,
  tabSize: 4,
  inlineBlame: false,
});

export const FONT_SIZE_RANGE = { min: 10, max: 22 } as const;
export const LINE_HEIGHTS = [1.3, 1.45, 1.6, 1.8] as const;
export const TAB_SIZES = [2, 4, 8] as const;
/** How long after the last edit `autosave: "delay"` writes. */
export const AUTOSAVE_DELAY_MS = 1000;

// ── validation ──────────────────────────────────────────────────────────────

const oneOf =
  <T extends string>(...values: T[]) =>
  (v: unknown): v is T =>
    typeof v === "string" && (values as string[]).includes(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const intIn = (min: number, max: number) => (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

const VALID: { [K in EditorSettingKey]: (v: unknown) => v is EditorSettings[K] } = {
  vimMode: oneOf("auto", "on", "off"),
  fontSize: intIn(FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max),
  lineHeight: (v): v is number => typeof v === "number" && v >= 1 && v <= 2.5,
  lineNumbers: oneOf("absolute", "relative", "off"),
  softWrap: isBool,
  renderWhitespace: isBool,
  autosave: oneOf("off", "delay", "focus"),
  formatOnSave: isBool,
  tabSize: intIn(1, 16),
  inlineBlame: isBool,
};

const KEYS = Object.keys(VALID) as EditorSettingKey[];

/** What was stored, keeping only keys that are valid now: a value written by
 *  a newer build, or by hand, never reaches an editor as garbage. */
export function sanitizeEditorSettings(raw: unknown): ExplicitEditorSettings {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (VALID[k](v)) out[k] = v;
  }
  return out as ExplicitEditorSettings;
}

// ── precedence ──────────────────────────────────────────────────────────────

/** The settings a vimrc speaks to, and the vim option behind each. */
export const VIMRC_OPTION_FOR: Partial<Record<EditorSettingKey, string>> = {
  lineNumbers: "number / relativenumber",
  softWrap: "wrap",
  renderWhitespace: "list",
  tabSize: "tabstop",
};

/** The settings a vimrc's global options decide (per-filetype `autocmd`
 *  options stay with each language and are not settings). */
export function settingsFromVimOptions(v: VimOptionValues | null | undefined): ExplicitEditorSettings {
  if (!v) return {};
  const out: ExplicitEditorSettings = {};
  if (v.relativenumber) out.lineNumbers = "relative";
  else if (v.number !== undefined || v.relativenumber !== undefined) out.lineNumbers = v.number ? "absolute" : "off";
  if (v.wrap !== undefined) out.softWrap = v.wrap;
  if (v.list !== undefined) out.renderWhitespace = v.list;
  if (v.tabstop !== undefined && VALID.tabSize(v.tabstop)) out.tabSize = v.tabstop;
  return out;
}

/** The inverse, for vim: the person's choices as the vim options they stand
 *  for, which vim layers over the vimrc's global `set` lines so a `:set`
 *  typed later still changes them. */
export function vimOptionsFromSettings(explicit: ExplicitEditorSettings): VimOptionValues {
  const out: VimOptionValues = {};
  if (explicit.lineNumbers !== undefined) {
    out.number = explicit.lineNumbers !== "off";
    out.relativenumber = explicit.lineNumbers === "relative";
  }
  if (explicit.softWrap !== undefined) out.wrap = explicit.softWrap;
  if (explicit.renderWhitespace !== undefined) out.list = explicit.renderWhitespace;
  if (explicit.tabSize !== undefined) out.tabstop = explicit.tabSize;
  return out;
}

export type SettingSource = "default" | "vimrc" | "set";

export interface ResolvedEditorSettings {
  values: EditorSettings;
  source: Record<EditorSettingKey, SettingSource>;
  /** What the vimrc would set for each key it speaks to, even where an
   *  explicit choice wins over it. */
  vimrc: ExplicitEditorSettings;
}

/** default < vimrc < explicit, per key. `vimrc` is only what applies: pass
 *  nothing when vim is off, since a vimrc's options ride with vim. */
export function resolveEditorSettings(explicit: ExplicitEditorSettings, vimrc: ExplicitEditorSettings = {}): ResolvedEditorSettings {
  const values = { ...DEFAULT_EDITOR_SETTINGS } as EditorSettings;
  const source = {} as Record<EditorSettingKey, SettingSource>;
  for (const k of KEYS) {
    if (explicit[k] !== undefined) {
      (values as unknown as Record<string, unknown>)[k] = explicit[k];
      source[k] = "set";
    } else if (vimrc[k] !== undefined) {
      (values as unknown as Record<string, unknown>)[k] = vimrc[k];
      source[k] = "vimrc";
    } else source[k] = "default";
  }
  return { values, source, vimrc };
}

/** Whether a vimrc response holds any config: what "auto" turns vim on for. */
export function hasVimConfig(r: CodeVimrcResponse | null | undefined): boolean {
  return !!r && (r.sources.some((s) => s.content.trim()) || !!r.overlay?.content.trim());
}

/** Whether vim runs, from the setting and whether a vimrc was found. */
export function vimModeOn(mode: VimModeSetting, vimrcFound: boolean): boolean {
  return mode === "auto" ? vimrcFound : mode === "on";
}

// ── the stored choices ──────────────────────────────────────────────────────

/** `code_editor` is not part of ClientUI's declared shape: the ui bag is
 *  open (v.any() on the server) and every key in it is stamped and synced,
 *  so the settings live there under one key without widening the store type. */
const UI_KEY = "code_editor";

type Ui = (ClientUI & { [UI_KEY]?: unknown }) | null | undefined;
const rawOf = (ui: Ui) => ui?.[UI_KEY];

let cachedRaw: unknown = undefined;
let cached: ExplicitEditorSettings = {};

/** The keys the person set, validated. Stable while nothing changes. */
export function explicitEditorSettings(): ExplicitEditorSettings {
  const raw = rawOf(useInboxStore.getState().clientState?.ui as Ui);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = sanitizeEditorSettings(raw);
  }
  return cached;
}

/** One setting as it stands without a vimrc (explicit, else default). */
export function editorSetting<K extends EditorSettingKey>(key: K): EditorSettings[K] {
  return explicitEditorSettings()[key] ?? DEFAULT_EDITOR_SETTINGS[key];
}

/** Set one setting, or clear it (`undefined`) so it follows the vimrc and the
 *  default again. Applies to every open editor at once and syncs to the
 *  person's other devices. */
export function setEditorSetting<K extends EditorSettingKey>(key: K, value: EditorSettings[K] | undefined): void {
  const current = explicitEditorSettings();
  if (current[key] === value) return;
  if (value !== undefined && !VALID[key](value)) return;
  const next: ExplicitEditorSettings = { ...current };
  if (value === undefined) delete next[key];
  else next[key] = value;
  useInboxStore.getState().updateClientUI({ [UI_KEY]: next } as Partial<ClientUI>);
}

/** Called after any setting changes, here or on another device. Returns the
 *  unsubscribe. A change is a reference change of the stored bag, which only
 *  a write produces, so this never runs for unrelated store traffic. */
export function onEditorSettingsChange(cb: (settings: ExplicitEditorSettings) => void): () => void {
  let last = rawOf(useInboxStore.getState().clientState?.ui as Ui);
  return useInboxStore.subscribe((s) => {
    const raw = rawOf(s.clientState?.ui as Ui);
    if (raw === last) return;
    last = raw;
    cb(explicitEditorSettings());
  });
}

/** React: the explicit settings, re-rendering only when they change. */
export function useExplicitEditorSettings(): ExplicitEditorSettings {
  useInboxStore((s) => rawOf(s.clientState?.ui as Ui));
  return explicitEditorSettings();
}

// ── commands ────────────────────────────────────────────────────────────────

let commandsRegistered = false;

/** `settings.open` (the palette, a vim map, the status bar) opens Settings >
 *  Editor. Registered once, with the editor core. */
export function registerEditorSettingsCommands(): void {
  if (commandsRegistered) return;
  commandsRegistered = true;
  registerCodeCommand("settings.open", () => useInboxStore.getState().openSettingsModal("editor"));
}
