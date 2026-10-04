"use client";
// One value of the line profile as a row of the settings page: what it
// controls, the value the line runs with, where it came from (the file or the
// default), and the journey of an edit. The value is a button; return opens
// it in place, return again (or leaving it) sends, escape puts it back, and
// backspace on the row returns a value the file sets to its default.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { LineValueSource } from "@codecast/shared/contracts/lineProfile";
import type { EditState } from "./useLineProfileEdits";

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
        {error && <span className="lset-field-error" role="alert">{error}</span>}
      </span>
    );
  }
  return (
    <button
      ref={button}
      type="button"
      className="lset-value"
      disabled={disabled}
      onClick={() => setDraft(text)}
      onKeyDown={onButtonKey}
      aria-label={`${label}: ${text || "unset"}${disabled ? "" : ", press return to edit"}`}
      data-lset-focus
      data-empty={text ? undefined : "true"}
    >
      {display ?? (text || placeholder || "unset")}
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

/** An edit's journey, beside the value it changes. */
export function EditStatus({ s, device, now, onDismiss }: { s: EditState | undefined; device: string; now: number; onDismiss: () => void }) {
  if (!s) return null;
  if (s.state === "sending") return <span className="lset-status" data-state="sending"><span className="lset-lamp" />sending</span>;
  if (s.state === "waiting") {
    const slow = now - s.at > 30_000;
    return <span className="lset-status" data-state="waiting" title={`The edit is with ${device}, which writes the file and republishes`}><span className="lset-lamp" />{slow ? `no answer from ${device} yet` : `writing on ${device}`}</span>;
  }
  if (s.state === "saved") {
    return s.note
      ? <span className="lset-status" data-state="warn" role="status">{s.note}<button type="button" className="lset-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button></span>
      // A saved mark fades by itself (settings.css) and stays out of the way after.
      : <span key={s.at} className="lset-status" data-state="saved" role="status">saved</span>;
  }
  return (
    <span className="lset-status" data-state="refused" role="alert">
      <span className="lset-refused-text">{s.message}</span>
      <button type="button" className="lset-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
    </span>
  );
}

/** A labelled row: what it controls on the left, the value and its state on the right. */
export function LineValueRow({ label, what, unit, children, source, status, note, refused }: {
  label: string;
  what: string;
  unit?: string;
  children: ReactNode;
  source: LineValueSource | null;
  status?: ReactNode;
  note?: string | null;
  refused?: boolean;
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
        </div>
        {note && <p className="lset-note" data-lset-note>{note}</p>}
        {status}
      </div>
    </div>
  );
}
