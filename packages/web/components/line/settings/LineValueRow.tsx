"use client";
// One value of the line profile as a row of the settings page: what it
// controls, the value the line runs with, where it came from (the file or the
// default), and the journey of an edit. The value is a button; return opens
// it in place, return again (or leaving it) sends, escape puts it back, and
// backspace on the row returns a value the file sets to its default.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { LineValueSource } from "@codecast/shared/contracts/lineProfile";
import type { EditState } from "./useLineProfileEdits";
import { KeyCap } from "../../KeyboardShortcutsHelp";

/**
 * A value edited where it sits. `onCommit` answers an error to show beside
 * the field (and keeps it open), or nothing when the text was taken.
 */
export function InlineEdit({ text, placeholder, multiline, disabled, label, display, onCommit, onReset }: {
  text: string;
  placeholder?: string;
  multiline?: boolean;
  disabled?: boolean;
  label: string;
  /** What the closed field shows; the text by default. */
  display?: ReactNode;
  onCommit: (text: string) => string | null | void;
  onReset?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const open = draft !== null;
  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    field.current?.select();
  }, [open]);

  const close = (refocus: boolean) => {
    setDraft(null);
    setError(null);
    if (refocus) requestAnimationFrame(() => button.current?.focus());
  };
  const commit = (refocus: boolean) => {
    if (draft === null) return;
    if (draft === text) return close(refocus);
    const err = onCommit(draft);
    if (err) { setError(err); return; }
    close(refocus);
  };
  const onFieldKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "Enter" && (!multiline || !e.shiftKey)) { e.preventDefault(); commit(true); }
  };
  const onButtonKey = (e: KeyboardEvent) => {
    if ((e.key === "Backspace" || e.key === "Delete") && onReset && !disabled) { e.preventDefault(); onReset(); }
  };

  if (open) {
    const common = {
      value: draft,
      placeholder,
      "aria-label": label,
      "aria-invalid": error ? true : undefined,
      onChange: (e: { target: { value: string } }) => { setDraft(e.target.value); setError(null); },
      onKeyDown: onFieldKey,
      onBlur: () => commit(false),
      className: "lset-input",
      "data-lset-input": true,
    };
    return (
      <span className="lset-edit">
        {multiline
          ? <textarea ref={field} rows={Math.min(6, Math.max(2, draft.split("\n").length + 1))} {...common} />
          : <input ref={field} {...common} />}
        {multiline && !error && <span className="lset-field-hint"><KeyCap size="xs">Shift</KeyCap><KeyCap size="xs">↵</KeyCap> new line · <KeyCap size="xs">↵</KeyCap> save</span>}
        {error && <span className="lset-field-error" role="alert">{error}</span>}
      </span>
    );
  }
  return (
    // Read only stays focusable (aria-disabled, not disabled), so the page's
    // arrow walk and a screen reader still reach the value.
    <button
      ref={button}
      type="button"
      className="lset-value"
      aria-disabled={disabled || undefined}
      onClick={() => { if (!disabled) setDraft(text); }}
      onKeyDown={onButtonKey}
      aria-label={`${label}: ${text || "unset"}${disabled ? ", read only" : ", press return to edit"}`}
      data-lset-focus
      data-empty={text ? undefined : "true"}
    >
      {/* The example lives in the open field only: shown closed, it reads as a value. */}
      {display ?? (text || "unset")}
    </button>
  );
}

/** Where a value came from, said in two words. */
export function SourceTag({ source }: { source: LineValueSource | null }) {
  if (!source) return <span className="lset-src" data-src="unknown" title="Published by an older cast, which did not say">?</span>;
  return (
    <span className="lset-src" data-src={source} title={source === "file" ? "Set in the line's file" : "Not set in the file: the line's default"}>
      {source === "file" ? "file" : "default"}
    </span>
  );
}

/** How long a plain "saved" stays beside the value it changed. */
const SAVED_SHOWN_MS = 8_000;

/** An edit's journey, beside the value it changes. */
export function EditStatus({ s, device, now, onDismiss }: { s: EditState | undefined; device: string; now: number; onDismiss: () => void }) {
  if (!s) return null;
  // The edit's row outlives the moment: a quiet save from earlier says nothing.
  if (s.state === "saved" && !s.note && now - s.at > SAVED_SHOWN_MS) return null;
  if (s.state === "sending" || s.state === "waiting" || s.state === "publishing") {
    if (s.state === "sending" && !s.slow) return <span className="lset-status" data-state="sending"><span className="lset-lamp" />sending</span>;
    if (s.slow) {
      // A machine that never answers leaves the edit showing; putting it back
      // stops showing it, and nothing reached the file.
      return (
        <span className="lset-status" data-state="warn" role="status">
          No answer from {device} yet.
          <button type="button" className="lset-putback" onClick={onDismiss} title="Stop showing this edit. Nothing has reached the file.">put back</button>
        </span>
      );
    }
    return (
      <span className="lset-status" data-state="waiting" title={`${device} writes the file, then republishes it`}>
        <span className="lset-lamp" />{s.state === "waiting" ? `writing on ${device}` : "republishing"}
      </span>
    );
  }
  if (s.state === "saved") {
    return s.note
      ? <span className="lset-status" data-state="warn" role="status">{s.note}<button type="button" className="lset-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button></span>
      // A saved mark fades by itself (settings.css) and stays out of the way after.
      : <span key={s.at} className="lset-status" data-state="saved" role="status">saved</span>;
  }
  if (s.state !== "refused") return null;
  return (
    <span className="lset-status" data-state="refused" role="alert">
      <span className="lset-refused-text">{s.message}</span>
      <button type="button" className="lset-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
    </span>
  );
}

/** A labelled row: what it controls on the left, the value and its state on
 *  the right. A value the file sets offers its way back to the default
 *  (`onReset`, also backspace on the value), naming what that default is. */
export function LineValueRow({ label, what, unit, children, source, status, note, refused, onReset, defaultText }: {
  label: string;
  what: string;
  unit?: string;
  children: ReactNode;
  source: LineValueSource | null;
  status?: ReactNode;
  note?: string | null;
  refused?: boolean;
  onReset?: () => void;
  defaultText?: string;
}) {
  return (
    <div className="lset-row" data-lset-row data-source={source ?? "unknown"} data-refused={refused ? "true" : undefined}>
      <div className="lset-key">
        <span className="lset-label">{label}</span>
        <span className="lset-what">{what}</span>
      </div>
      <div className="lset-val">
        <div className="lset-val-line">
          {children}
          {unit && <span className="lset-unit">{unit}</span>}
          <SourceTag source={source} />
          {source === "file" && onReset && (
            <button type="button" className="lset-to-default" onClick={onReset} title={`Remove it from the file; the line then uses the default: ${defaultText || "unset"}`} data-lset-to-default>
              use default
            </button>
          )}
        </div>
        {note && <p className="lset-note" data-lset-note>{note}</p>}
        {status}
      </div>
    </div>
  );
}
