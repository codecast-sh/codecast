"use client";
// The one flow for a switch whose on position costs something: it starts paid
// agent sessions, hands an agent a power, shares data, or sends something out.
// Pressing the control while it is off never turns it on. It opens a review
// that carries the weight in structure, never in sentences: numbers up top,
// then label and value rows that each fit a glance, and a confirm button that
// names the act. Turning off is one press, since stopping is the safe direction.
//
// A site passes a ledger (plain data, so it can be built from the store and
// tested without a browser) and its two writes. The trigger is the site's own
// control when it has one (`trigger`), so a chip, a switch or a row button all
// open the same review.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { KeyCap } from "../KeyCap";
import { isMac } from "../../shortcuts/registry";

/** A number the review leads with: how many start, how fast, how much. The label is a few words. */
export type SwitchFigure = { value: string; label: string; tone?: "warn" };

/** One fact: a short key and a value a glance takes in (a number, a name, a state). `list` names the things it covers. */
export type SwitchRow = { k: string; v: string; tone?: "warn" | "ok"; list?: string[] };

export type SwitchLedger = {
  /** What turns on, as the control names it: "Auto-start". */
  name: string;
  /** What it turns on for: a project, a role, a pull request. */
  subject: string;
  /** The state change the header names, when it is not Off to On. */
  shift?: [string, string];
  /** A fact that should stop the person, drawn loudest of all: "Checks failing". */
  alert?: string;
  figures: SwitchFigure[];
  /** A handover of decisions, as two columns of short items. */
  hands?: { its: string[]; yours: string[] };
  rows: SwitchRow[];
  /** How to stop it, as a short value; absent for a one-time act (its undo is a row). */
  stop?: string;
  /** The confirm button: the act. */
  confirm: string;
  /** The back-out button, when it is not "Keep off". */
  keep?: string;
  /** Why it cannot be done from here; the confirm button is disabled and says this. */
  blocked?: string;
};

export type SwitchTriggerProps = { on: boolean; press: () => void; reviewing: boolean };

export type ConsequentialSwitchProps = {
  on: boolean;
  ledger: SwitchLedger;
  onTurnOn: () => void;
  onTurnOff: () => void;
  /** The site's own control. `press` opens the review while off and turns off while on. Without it: a "Review" button while off, the state and "Turn off" while on. */
  trigger?: (p: SwitchTriggerProps) => ReactNode;
  /** Class for the default trigger's buttons, so it wears the site's button style. */
  className?: string;
  /** The default off button's word. */
  label?: string;
  /** Attributes for the default trigger (a site's test hooks, a title). */
  triggerProps?: Record<string, string | undefined>;
};

const TONE = { warn: "text-sol-orange", ok: "text-sol-green" } as const;

export function ConsequentialSwitch({ on, ledger, onTurnOn, onTurnOff, trigger, className, label = "Review", triggerProps }: ConsequentialSwitchProps) {
  const [reviewing, setReviewing] = useState(false);
  const press = () => (on ? onTurnOff() : setReviewing(true));
  return (
    <>
      {trigger ? trigger({ on, press, reviewing }) : on ? (
        <span className="inline-flex items-center gap-2" {...triggerProps} data-consequential="on">
          <span className="inline-flex items-center gap-1 text-sol-green"><i aria-hidden className="h-1.5 w-1.5 rounded-full bg-sol-green" />On</span>
          <button type="button" className={className} onClick={onTurnOff} data-consequential-off>Turn off</button>
        </span>
      ) : (
        <button type="button" className={className} aria-haspopup="dialog" aria-expanded={reviewing} onClick={press} {...triggerProps} data-consequential="off">{label}</button>
      )}
      {reviewing && <SwitchReview ledger={ledger} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); onTurnOn(); }} />}
    </>
  );
}

/** The review itself: controlled, for a site that opens it from somewhere other than a trigger of its own. */
export function SwitchReview({ ledger: l, onClose, onConfirm }: { ledger: SwitchLedger; onClose: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef(onConfirm);
  confirm.current = onConfirm;
  const blocked = !!l.blocked;
  useEffect(() => {
    if (blocked) return;
    // The modifier makes confirming a chord: a stray Enter, or one meant for the page behind, does nothing.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); confirm.current(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [blocked]);
  const rows = l.stop ? [...l.rows, { k: "To stop", v: l.stop }] : l.rows;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        hideClose
        // Focus rests on the back-out button, so Enter or Space on open backs out.
        onOpenAutoFocus={(e) => { e.preventDefault(); cancel.current?.focus(); }}
        // One column that never grows past the dialog: every part may shrink, nothing may push the edge.
        className="w-[30rem] max-w-[calc(100vw-1.5rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden border-sol-border bg-sol-bg p-0 text-sol-text sm:rounded-xl [&>*]:min-w-0"
        data-switch-review={l.name}
      >
        <header className="flex items-start justify-between gap-3 border-b border-sol-border/60 px-5 py-3.5" data-switch-part>
          <DialogTitle className="flex min-w-0 flex-col gap-0.5 text-[15px] font-semibold leading-tight tracking-normal text-sol-text">
            <span className="truncate">{l.name}</span>
            <span className="truncate text-[12.5px] font-normal text-sol-text-muted" title={l.subject} data-switch-subject>{l.subject}</span>
          </DialogTitle>
          <span className="inline-flex shrink-0 items-center gap-1.5 pt-0.5 text-[11px] tabular-nums text-sol-text-dim" aria-hidden>
            {l.shift?.[0] ?? "Off"} <span className="text-sol-text-dim/60">→</span> <b className="font-semibold text-sol-orange">{l.shift?.[1] ?? "On"}</b>
          </span>
        </header>
        <DialogDescription className="sr-only">{l.name}: {l.subject}. {l.confirm}.</DialogDescription>

        {l.alert && (
          <p className="flex items-center gap-2 bg-sol-red px-5 py-2.5 text-[14px] font-semibold text-sol-bg" role="alert" data-switch-alert data-switch-part>
            <span aria-hidden>!</span><span className="min-w-0 truncate">{l.alert}</span>
          </p>
        )}

        {l.hands && (
          <div className="grid grid-cols-2 gap-px border-b border-sol-border/60 bg-sol-border/40 text-[12.5px] leading-snug" data-switch-hands data-switch-part>
            <div className="flex min-w-0 flex-col gap-1 px-5 py-3" style={{ background: "color-mix(in srgb, var(--sol-orange) 12%, var(--sol-bg))" }}>
              <b className="text-[11px] font-semibold uppercase tracking-wide text-sol-orange">It decides</b>
              {l.hands.its.map((x) => <span key={x} className="text-sol-text">{x}</span>)}
            </div>
            <div className="flex min-w-0 flex-col gap-1 bg-sol-bg px-5 py-3">
              <b className="text-[11px] font-semibold uppercase tracking-wide text-sol-green">You decide</b>
              {l.hands.yours.map((x) => <span key={x} className="text-sol-text">{x}</span>)}
            </div>
          </div>
        )}

        {l.figures.length > 0 && (
          // As many tiles a row as fit; a narrow window wraps them instead of squeezing.
          <dl className="grid gap-px border-b border-sol-border/60 bg-sol-border/40 [grid-template-columns:repeat(auto-fit,minmax(6.5rem,1fr))]" data-switch-figures data-switch-part>
            {l.figures.map((f) => (
              <div key={f.label} className="flex min-w-0 flex-col gap-0.5 bg-sol-bg px-4 py-3">
                <dd className={`truncate text-[24px] font-semibold leading-none tabular-nums ${f.tone ? TONE[f.tone] : "text-sol-text"}`} title={f.value} data-switch-figure={f.label}>{f.value}</dd>
                <dt className="text-[11px] leading-tight text-sol-text-muted">{f.label}</dt>
              </div>
            ))}
          </dl>
        )}

        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-5 py-3.5 text-[12.5px] leading-snug" data-switch-rows data-switch-part>
          {rows.map((r) => (
            <div key={r.k} className="contents" data-switch-row={r.k}>
              <dt className="truncate text-sol-text-dim">{r.k}</dt>
              <dd className="min-w-0">
                <span className={`block truncate ${"tone" in r && r.tone ? TONE[r.tone] : "text-sol-text"}`} title={r.v}>{r.v}</span>
                {"list" in r && r.list?.map((x) => <span key={x} className="block truncate text-[11.5px] text-sol-text-muted" title={x}>{x}</span>)}
              </dd>
            </div>
          ))}
        </dl>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-sol-border/60 bg-sol-bg-alt/40 px-5 py-3 sm:rounded-b-xl" data-switch-part>
          <button ref={cancel} type="button" onClick={onClose} className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-sol-border px-3 text-[12.5px] text-sol-text-muted hover:text-sol-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/50" data-switch-cancel>
            {l.keep ?? "Keep off"} <KeyCap size="xs">esc</KeyCap>
          </button>
          <button type="button" disabled={blocked} onClick={onConfirm} title={l.blocked ?? l.confirm} className="ml-auto inline-flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md bg-sol-orange px-3.5 text-[12.5px] font-semibold text-sol-bg hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-orange/50 disabled:cursor-not-allowed disabled:bg-sol-border disabled:text-sol-text-dim" data-switch-confirm>
            <span className="min-w-0 truncate">{l.blocked ?? l.confirm}</span>
            {!blocked && <span className="inline-flex shrink-0 items-center gap-0.5"><KeyCap size="xs" tone="onAccent">{isMac ? "⌘" : "ctrl"}</KeyCap><KeyCap size="xs" tone="onAccent">↵</KeyCap></span>}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
