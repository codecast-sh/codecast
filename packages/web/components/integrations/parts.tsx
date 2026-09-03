// The small shapes the integrations panel repeats: a status dot, the mono
// ledger line under each provider, and the two-step destructive button.
//
// Kept together because they are the panel's visual grammar — a reader of one
// card learns them once and every card afterwards reads the same way. Tokens
// only (sol-*), so both themes work without a second palette.

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type DotTone = "ok" | "warn" | "bad" | "idle";

const DOT_COLOR: Record<DotTone, string> = {
  ok: "bg-sol-green",
  warn: "bg-sol-yellow",
  bad: "bg-sol-red",
  idle: "bg-sol-text-dim",
};

const TEXT_COLOR: Record<DotTone, string> = {
  ok: "text-sol-green",
  warn: "text-sol-yellow",
  bad: "text-sol-red",
  idle: "text-sol-text-dim",
};

/** A state in one glance: a filled dot and the word for it. */
export function StatusDot({ tone, children, className }: { tone: DotTone; children?: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px]", TEXT_COLOR[tone], className)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_COLOR[tone])} />
      {children}
    </span>
  );
}

/**
 * The ledger line: the facts about a connection in one monospace row, each
 * separated by a middot ("connected · team · by ashot · 2h ago"). Falsy parts
 * are dropped, so an unknown fact leaves no empty slot claiming to be one.
 */
export function LedgerLine({ parts, className }: { parts: Array<React.ReactNode>; className?: string }) {
  const kept = parts.filter(Boolean);
  if (kept.length === 0) return null;
  return (
    <div className={cn("truncate font-mono text-[10.5px] leading-relaxed text-sol-text-dim", className)}>
      {kept.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="px-1 opacity-50">·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

/**
 * A destructive action that asks once before it runs. Two steps, inline — no
 * native confirm(), which blocks the page and cannot be styled or automated.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  question,
  onConfirm,
  busy,
  busyLabel,
  className,
}: {
  label: string;
  confirmLabel?: string;
  /** What the reader is agreeing to, shown beside the confirm. */
  question?: string;
  onConfirm: () => void;
  busy?: boolean;
  busyLabel?: string;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  if (busy) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-sol-text-muted">
        <Loader2 className="h-3 w-3 animate-spin" />
        {busyLabel ?? "Working"}
      </span>
    );
  }
  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className={cn("text-[11px] text-sol-red hover:underline", className)}
      >
        {label}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      {question && <span className="text-[11px] text-sol-text-dim">{question}</span>}
      <button
        type="button"
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
        className="rounded bg-sol-red/15 px-2 py-0.5 text-[11px] font-medium text-sol-red hover:bg-sol-red/25"
      >
        {confirmLabel ?? label}
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="text-[11px] text-sol-text-muted hover:text-sol-text"
      >
        Cancel
      </button>
    </span>
  );
}

/** A compact bordered action that matches the settings kit's control weight. */
export function QuietButton({
  children,
  onClick,
  disabled,
  busy,
  title,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border border-sol-border px-2.5 text-xs text-sol-text",
        "transition-colors hover:bg-sol-bg-highlight disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
      {children}
    </button>
  );
}
