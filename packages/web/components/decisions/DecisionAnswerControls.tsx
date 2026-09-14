"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Square, CheckSquare } from "lucide-react";
import type { SessionDecisionItem, DecisionAnswerInput } from "../../store/inboxStore";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { hasOpenModal } from "../../shortcuts";

// The answer footer, per kind (docs/architecture/decisions-as-documents.md
// D1 / D4): single = one option (digits 1 to 9, or a typed answer); multi =
// checkboxes and a submit; rank = the options in an order the reader moves
// with up / down and a submit; form = one input per field and a submit.
//
// Answering is the caller's: this component only builds the DecisionAnswerInput
// (store answerDecision takes it and delivers the message). `keys` claims the
// digit keys on window in capture phase, the same way SessionDecisionCard
// does, so exactly one surface on screen should pass it.
export function DecisionAnswerControls({
  decision,
  onAnswer,
  onDismiss,
  keys = false,
  size = "full",
  recommendation,
}: {
  decision: SessionDecisionItem;
  onAnswer: (input: DecisionAnswerInput) => void;
  onDismiss?: () => void;
  keys?: boolean;
  size?: "full" | "compact";
  /** The option a role on the ladder recommended (the latest hop with one). */
  recommendation?: number;
}) {
  const kind = decision.kind ?? "single";
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [order, setOrder] = useState<number[]>(() => decision.options.map((_, i) => i));
  const [values, setValues] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {};
    for (const f of decision.form?.fields ?? []) init[f.key] = f.type === "bool" ? false : f.type === "select" ? (f.options?.[0] ?? "") : "";
    return init;
  });
  const [error, setError] = useState<string | null>(null);

  const answerSingle = useCallback((index: number) => onAnswer({ index }), [onAnswer]);
  const answerText = useCallback(() => {
    const t = otherText.trim();
    if (!t) return;
    onAnswer({ text: t });
  }, [onAnswer, otherText]);

  const submit = useCallback(() => {
    if (kind === "multi") {
      if (picked.length === 0) return setError("Pick at least one option.");
      onAnswer({ json: [...picked].sort((a, b) => a - b) });
    } else if (kind === "rank") {
      onAnswer({ json: order });
    } else if (kind === "form") {
      for (const f of decision.form?.fields ?? []) {
        const v = values[f.key];
        if (f.type !== "bool" && (v === "" || v === undefined)) return setError(`${f.label} is required.`);
        if (f.type === "number" && Number.isNaN(Number(v))) return setError(`${f.label} must be a number.`);
      }
      const out: Record<string, any> = {};
      for (const f of decision.form?.fields ?? []) out[f.key] = f.type === "number" ? Number(values[f.key]) : values[f.key];
      onAnswer({ json: out });
    }
  }, [kind, picked, order, values, decision.form, onAnswer]);

  const move = useCallback((from: number, dir: -1 | 1) => {
    setOrder((o) => {
      const to = from + dir;
      if (to < 0 || to >= o.length) return o;
      const next = [...o];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  }, []);

  // Digits answer a single; on a multi they toggle; Enter submits a multi,
  // rank or form; t opens the typed answer; x dismisses. Capture phase, so
  // the global shortcut layer cannot eat the digits first. Exactly one
  // surface on screen may pass `keys`; stopImmediatePropagation is the belt
  // for a second claimant on the same window (two open stacks would answer
  // two decisions on one digit otherwise).
  useWatchEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal()) return;
      const target = e.target as HTMLElement | null;
      const editing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.tagName === "SELECT");
      if (editing) {
        if (target === otherRef.current) {
          if (e.key === "Escape") { e.preventDefault(); setOtherOpen(false); }
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); answerText(); }
        } else if (kind === "form" && e.key === "Enter" && !e.shiftKey && target?.tagName !== "TEXTAREA") {
          e.preventDefault(); submit();
        }
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        const n = Number(e.key) - 1;
        if (n >= decision.options.length) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (kind === "single") answerSingle(n);
        else if (kind === "multi") setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));
        return;
      }
      if (e.key === "Enter" && kind !== "single") { e.preventDefault(); e.stopImmediatePropagation(); submit(); return; }
      if ((e.key === "t" || e.key === "T") && kind === "single") {
        e.preventDefault(); e.stopImmediatePropagation();
        setOtherOpen(true); setTimeout(() => otherRef.current?.focus(), 0);
        return;
      }
      if ((e.key === "x" || e.key === "X") && onDismiss) { e.preventDefault(); e.stopImmediatePropagation(); onDismiss(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [keys, kind, decision.options.length, answerSingle, answerText, submit, onDismiss]);

  const compact = size === "compact";
  const btn = (primary: boolean) =>
    `group flex items-center gap-2 rounded border transition-colors ${compact ? "px-2.5 py-1.5 text-[12px]" : "px-3 py-2 text-sm"} ${
      primary
        ? "border-sol-yellow/40 text-sol-text hover:bg-sol-yellow hover:text-sol-bg"
        : "border-sol-border text-sol-text-muted hover:border-sol-text-dim hover:text-sol-text"
    }`;
  const submitBtn = (
    <button onClick={submit} className={`${btn(true)} border-sol-green/40 hover:bg-sol-green`}>
      {keys && <KeyCap size="xs">return</KeyCap>}
      <span>Send this answer</span>
    </button>
  );
  const recTag = (i: number) => recommendation === i && <span className="text-[10px] text-sol-cyan">recommended</span>;
  const defaultTag = (i: number) => decision.default_option === i && !decision.blocking && <span className="text-[10px] text-sol-text-dim">proceeding with this</span>;

  const dismissBtn = onDismiss && (
    <button onClick={onDismiss} className="flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-red transition-colors" title="Dismiss without answering — the agent is not told">
      {keys && <KeyCap size="xs">x</KeyCap>}<span>dismiss</span>
    </button>
  );

  const body = useMemo(() => {
    if (kind === "single") {
      return (
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
          {decision.options.map((o, n) => (
            <button key={n} onClick={() => answerSingle(n)} className={`${btn(n === (recommendation ?? 0))} w-full sm:w-auto text-left`} title={o.description}>
              {keys && n < 9 && <KeyCap size="xs">{String(n + 1)}</KeyCap>}
              <span>{o.label.replace(" (Recommended)", "")}</span>
              {recTag(n)}{defaultTag(n)}
            </button>
          ))}
          <button onClick={() => { setOtherOpen(true); setTimeout(() => otherRef.current?.focus(), 0); }} className={`${btn(false)} w-full sm:w-auto`}>
            {keys && <KeyCap size="xs">t</KeyCap>}<span>type an answer</span>
          </button>
        </div>
      );
    }
    if (kind === "multi") {
      return (
        <div className="space-y-1.5">
          {decision.options.map((o, n) => {
            const on = picked.includes(n);
            return (
              <button key={n} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== n) : [...p, n]))} className={`w-full flex items-center gap-2.5 text-left rounded border px-3 py-2 text-sm transition-colors ${on ? "border-sol-yellow/50 bg-sol-yellow/10 text-sol-text" : "border-sol-border text-sol-text-muted hover:text-sol-text"}`}>
                {on ? <CheckSquare className="w-4 h-4 text-sol-yellow shrink-0" /> : <Square className="w-4 h-4 shrink-0" />}
                {keys && n < 9 && <KeyCap size="xs">{String(n + 1)}</KeyCap>}
                <span className="min-w-0 flex-1">{o.label}</span>
                {recTag(n)}
              </button>
            );
          })}
          <div className="flex items-center gap-3 pt-1">{submitBtn}<span className="text-[11px] text-sol-text-dim">{picked.length} picked</span></div>
        </div>
      );
    }
    if (kind === "rank") {
      return (
        <div className="space-y-1.5">
          {order.map((optIndex, pos) => (
            <div key={optIndex} className="flex items-center gap-2.5 rounded border border-sol-border px-3 py-2 text-sm text-sol-text">
              <span className="font-mono text-[11px] text-sol-text-dim w-5">{pos + 1}.</span>
              <span className="min-w-0 flex-1">{decision.options[optIndex]?.label}</span>
              {recTag(optIndex)}
              <button onClick={() => move(pos, -1)} disabled={pos === 0} className="p-1 rounded hover:bg-sol-card disabled:opacity-30" title="Move up"><ArrowUp className="w-3.5 h-3.5" /></button>
              <button onClick={() => move(pos, 1)} disabled={pos === order.length - 1} className="p-1 rounded hover:bg-sol-card disabled:opacity-30" title="Move down"><ArrowDown className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          <div className="flex items-center gap-3 pt-1">{submitBtn}<span className="text-[11px] text-sol-text-dim">first is most preferred</span></div>
        </div>
      );
    }
    const fields = decision.form?.fields ?? [];
    const input = "w-full bg-sol-card border border-sol-border rounded px-2 py-1.5 text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-blue/50";
    return (
      <div className="space-y-2.5">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="block text-[11px] uppercase tracking-wide text-sol-text-dim mb-1">{f.label}</span>
            {f.type === "bool" ? (
              <button onClick={() => setValues((v) => ({ ...v, [f.key]: !v[f.key] }))} className="flex items-center gap-2 text-sm text-sol-text">
                {values[f.key] ? <CheckSquare className="w-4 h-4 text-sol-yellow" /> : <Square className="w-4 h-4 text-sol-text-dim" />}
                <span>{values[f.key] ? "yes" : "no"}</span>
              </button>
            ) : f.type === "select" ? (
              <select value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className={input}>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input type={f.type === "number" ? "number" : "text"} value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className={input} />
            )}
          </label>
        ))}
        <div className="pt-1">{submitBtn}</div>
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, decision.options, decision.form, picked, order, values, keys, recommendation, compact, answerSingle, move, submit]);

  return (
    <div>
      {body}
      {error && <div className="mt-2 text-[12px] text-sol-red">{error}</div>}
      {otherOpen && kind === "single" && (
        <div className="mt-3">
          <textarea
            ref={otherRef}
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            rows={3}
            placeholder="Answer in your own words — this goes to the agent as a message."
            className="w-full bg-sol-card border border-sol-border rounded px-2 py-1.5 text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-blue/50"
            onKeyDown={(e) => {
              if (keys) return; // the window listener handles it
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); answerText(); }
              if (e.key === "Escape") setOtherOpen(false);
            }}
          />
          <div className="flex items-center gap-2 mt-1 text-[11px] text-sol-text-dim">
            <button onClick={answerText} className="flex items-center gap-1 hover:text-sol-text"><KeyCap size="xs">return</KeyCap><span>send</span></button>
            <button onClick={() => setOtherOpen(false)} className="flex items-center gap-1 hover:text-sol-text"><KeyCap size="xs">esc</KeyCap><span>cancel</span></button>
          </div>
        </div>
      )}
      {dismissBtn && <div className="mt-3 flex items-center gap-4">{dismissBtn}</div>}
    </div>
  );
}

// The recorded answer, read-only, for an answered row: the chosen option(s)
// in order, or the form values, or the typed text.
export function DecisionRecordedAnswer({ decision }: { decision: Pick<SessionDecisionItem, "kind" | "status" | "options" | "answer_index" | "answer_text" | "answer_json"> }) {
  const kind = decision.kind ?? "single";
  if (decision.status !== "answered") return null;
  if (decision.answer_text) return <div className="text-sm text-sol-text">{decision.answer_text}</div>;
  if (kind === "form" && decision.answer_json && typeof decision.answer_json === "object") {
    return (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {Object.entries(decision.answer_json).map(([k, v]) => (
          <div key={k} className="contents"><dt className="text-sol-text-dim">{k}</dt><dd className="text-sol-text">{String(v)}</dd></div>
        ))}
      </dl>
    );
  }
  const list: number[] = Array.isArray(decision.answer_json) ? decision.answer_json : decision.answer_index !== undefined ? [decision.answer_index] : [];
  return (
    <ol className="space-y-1">
      {list.map((i, pos) => (
        <li key={i} className="flex items-center gap-2 text-sm text-sol-text">
          {kind === "rank" ? <span className="font-mono text-[11px] text-sol-text-dim w-5">{pos + 1}.</span> : <Check className="w-3.5 h-3.5 text-sol-green" />}
          <span>{decision.options[i]?.label ?? `option ${i + 1}`}</span>
        </li>
      ))}
    </ol>
  );
}
