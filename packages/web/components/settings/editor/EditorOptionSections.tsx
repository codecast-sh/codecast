// Appearance, Editing and Saving: one row per setting, each control showing
// the value in effect and, beside it, where that value comes from. A value the
// vimrc decides carries a `vimrc` mark naming the option; a value set here
// carries a reset that hands it back to the vimrc (or the default), struck
// through vimrc mark included when the choice here overrides it. Until the
// vimrc has been read, a row it could decide shows a pending mark and holds
// its control, rather than a default that may not be what runs.

import { Minus, Plus, RotateCcw } from "lucide-react";
import { SettingsBadge, SettingsOptionGroup, SettingsRow, SettingsSection } from "../ui";
import { Switch } from "../../ui/switch";
import { cn } from "../../../lib/utils";
import {
  DEFAULT_EDITOR_SETTINGS,
  FONT_SIZE_RANGE,
  LINE_HEIGHTS,
  TAB_SIZES,
  VIMRC_OPTION_FOR,
  setEditorSetting,
  type EditorSettingKey,
  type EditorSettings,
  type ResolvedEditorSettings,
} from "../../../lib/code/editorSettings";

const LINE_NUMBER_LABEL: Record<EditorSettings["lineNumbers"], string> = { absolute: "On", relative: "Relative", off: "Off" };

function show<K extends EditorSettingKey>(key: K, v: EditorSettings[K]): string {
  if (key === "lineNumbers") return LINE_NUMBER_LABEL[v as EditorSettings["lineNumbers"]];
  if (typeof v === "boolean") return v ? "on" : "off";
  return String(v);
}

/** Whether a row waits on the vimrc: the vimrc could decide it and nothing
 *  chosen here does. */
const waitsOnVimrc = (k: EditorSettingKey, resolved: ResolvedEditorSettings, pending: boolean) =>
  pending && !!VIMRC_OPTION_FOR[k] && resolved.source[k] !== "set";

/** Where a setting's value comes from, and the way back to it. */
export function SourceMark({ k, resolved, pending = false }: { k: EditorSettingKey; resolved: ResolvedEditorSettings; pending?: boolean }) {
  if (waitsOnVimrc(k, resolved, pending)) {
    return (
      <SettingsBadge tone="muted" className="font-mono opacity-60" title="Reading your vimrc">
        vimrc
      </SettingsBadge>
    );
  }
  const source = resolved.source[k];
  const vimrcValue = resolved.vimrc[k];
  const option = VIMRC_OPTION_FOR[k];
  const vimrcBadge =
    vimrcValue !== undefined && option ? (
      <SettingsBadge
        tone={source === "vimrc" ? "violet" : "muted"}
        className={cn("font-mono", source === "set" && "line-through opacity-70")}
        title={source === "set" ? `Your vimrc sets ${option} (${show(k, vimrcValue)}); the choice here wins` : `From your vimrc: ${option}`}
      >
        vimrc{source === "set" ? ` ${show(k, vimrcValue)}` : ""}
      </SettingsBadge>
    ) : null;
  return (
    <span className="flex items-center gap-1.5">
      {vimrcBadge}
      {source === "set" && (
        <button
          type="button"
          onClick={() => setEditorSetting(k, undefined)}
          className="rounded p-1 text-sol-text-dim hover:bg-sol-bg-highlight/50 hover:text-sol-text"
          title={vimrcValue !== undefined ? `Follow vimrc (${show(k, vimrcValue)})` : `Back to default (${show(k, DEFAULT_EDITOR_SETTINGS[k])})`}
          aria-label={vimrcValue !== undefined ? "Follow vimrc" : "Back to default"}
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function Stepper({ value, min, max, onChange, label, unit }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string; unit?: string }) {
  const btn = "flex h-7 w-7 items-center justify-center text-sol-text-muted hover:text-sol-text disabled:opacity-40";
  return (
    <div role="group" aria-label={label} className="flex items-center rounded-md border border-sol-border bg-sol-bg-alt">
      <button type="button" className={btn} disabled={value <= min} onClick={() => onChange(value - 1)} aria-label={`Smaller ${label.toLowerCase()}`}>
        <Minus className="h-3 w-3" />
      </button>
      <span className="w-12 text-center font-mono text-xs tabular-nums text-sol-text">
        {value}
        {unit && <span className="text-sol-text-dim">{unit}</span>}
      </span>
      <button type="button" className={btn} disabled={value >= max} onClick={() => onChange(value + 1)} aria-label={`Larger ${label.toLowerCase()}`}>
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}

const pills = (values: readonly (string | number)[], label: (v: string) => string = (v) => v) => values.map((v) => ({ value: String(v), label: label(String(v)) }));

export function EditorOptionSections({ resolved, vimrcPending = false }: { resolved: ResolvedEditorSettings; vimrcPending?: boolean }) {
  const v = resolved.values;
  const mark = (k: EditorSettingKey) => <SourceMark k={k} resolved={resolved} pending={vimrcPending} />;
  /** The control, held (dim, inert) while its value waits on the vimrc. */
  const held = (k: EditorSettingKey, control: React.ReactNode) =>
    waitsOnVimrc(k, resolved, vimrcPending) ? (
      <div className="pointer-events-none opacity-40" aria-busy="true" inert>
        {control}
      </div>
    ) : (
      control
    );
  return (
    <>
      <SettingsSection title="Appearance">
        <SettingsRow label="Font size">
          {mark("fontSize")}
          <Stepper label="Font size" unit="px" value={v.fontSize} min={FONT_SIZE_RANGE.min} max={FONT_SIZE_RANGE.max} onChange={(n) => setEditorSetting("fontSize", n)} />
        </SettingsRow>
        <SettingsRow label="Line height">
          {mark("lineHeight")}
          <SettingsOptionGroup
            variant="pill"
            label="Line height"
            value={String(v.lineHeight)}
            options={pills(LINE_HEIGHTS)}
            onChange={(x) => setEditorSetting("lineHeight", Number(x))}
          />
        </SettingsRow>
        <SettingsRow label="Line numbers">
          {mark("lineNumbers")}
          {held(
            "lineNumbers",
            <SettingsOptionGroup
              variant="pill"
              label="Line numbers"
              value={v.lineNumbers}
              options={(["absolute", "relative", "off"] as const).map((x) => ({ value: x, label: LINE_NUMBER_LABEL[x] }))}
              onChange={(x) => setEditorSetting("lineNumbers", x as EditorSettings["lineNumbers"])}
            />,
          )}
        </SettingsRow>
        <SettingsRow label="Render whitespace">
          {mark("renderWhitespace")}
          {held("renderWhitespace", <Switch checked={v.renderWhitespace} onCheckedChange={(on) => setEditorSetting("renderWhitespace", on)} aria-label="Render whitespace" />)}
        </SettingsRow>
        <SettingsRow label="Inline blame">
          {mark("inlineBlame")}
          <Switch checked={v.inlineBlame} onCheckedChange={(on) => setEditorSetting("inlineBlame", on)} aria-label="Inline blame" />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Editing">
        <SettingsRow label="Soft wrap">
          {mark("softWrap")}
          {held("softWrap", <Switch checked={v.softWrap} onCheckedChange={(on) => setEditorSetting("softWrap", on)} aria-label="Soft wrap" />)}
        </SettingsRow>
        <SettingsRow label="Tab size">
          {mark("tabSize")}
          {held(
            "tabSize",
            <SettingsOptionGroup
              variant="pill"
              label="Tab size"
              value={String(v.tabSize)}
              options={pills(TAB_SIZES.includes(v.tabSize as (typeof TAB_SIZES)[number]) ? TAB_SIZES : [...TAB_SIZES, v.tabSize].sort((a, b) => a - b))}
              onChange={(x) => setEditorSetting("tabSize", Number(x))}
            />,
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Saving">
        <SettingsRow label="Autosave">
          {mark("autosave")}
          <SettingsOptionGroup
            variant="pill"
            label="Autosave"
            value={v.autosave}
            options={[
              { value: "off", label: "Off" },
              { value: "delay", label: "After 1s", title: "A second after the last edit" },
              { value: "focus", label: "On focus change", title: "When the editor loses focus or the file leaves it" },
            ]}
            onChange={(x) => setEditorSetting("autosave", x as EditorSettings["autosave"])}
          />
        </SettingsRow>
        <SettingsRow label="Format on save">
          {mark("formatOnSave")}
          <Switch checked={v.formatOnSave} onCheckedChange={(on) => setEditorSetting("formatOnSave", on)} aria-label="Format on save" />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
