"use client";
// The one flow for a switch whose on position costs something: it starts paid
// agent sessions, hands an agent a power, shares data, or sends something out.
// Pressing the control while it is off never turns it on. It opens a review
// that carries the weight in structure: the numbers that start now and the
// pace after, what it costs and can touch, what stays with the person, and
// how to stop. Turning on is the review's own button, which names what it
// starts. Turning off is one press, since stopping is the safe direction.
//
// A site passes a ledger (plain data, so it can be built from the store and
// tested without a browser) and its two writes. The trigger is the site's own
// control when it has one (`trigger`), so a chip, a switch or a row button all
// open the same review.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { KeyCap } from "../KeyCap";
import { isMac } from "../../shortcuts/registry";

/** A number the review leads with: how many start, how fast, how much. */
export type SwitchFigure = { value: string; label: string; tone?: "warn" };

/** One fact about the on position: a short key, its value, and a second line when the value needs one. */
export type SwitchRow = { k: string; v: string; sub?: string; tone?: "warn" | "ok"; href?: string };

export type SwitchLedger = {
  /** What turns on, as the control names it: "Auto-start". */
  name: string;
  /** What it turns on for: a project, a role, a connector. */
  subject: string;
  /** What starts and at what pace, as numbers. */
  figures: SwitchFigure[];
  /** The power that changes hands, when turning on gives more than the name says: drawn as a band under the numbers. */
  lead?: { v: string; sub?: string };
  /** What it costs and can touch: spend, where it works, what ships, what else it switches. */
  rows: SwitchRow[];
  /** What stays in the person's hands while it is on, when the rows do not already say. */
  yours?: string[];
  /** How to stop it, and what stopping leaves running. */
  stop: string;
  /** The confirm button's words: the act and its first effect ("Turn on, start 5 now"). */
  confirm: string;
  /** Why it cannot be turned on from here; the confirm button is disabled and says this. */
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
    // The modifier makes turning on a chord: a stray Enter, or one meant for the page behind, does nothing.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); confirm.current(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [blocked]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        hideClose
        // Focus rests on Cancel, so Enter or Space on open backs out.
        onOpenAutoFocus={(e) => { e.preventDefault(); cancel.current?.focus(); }}
        className="w-[30rem] max-w-[94vw] gap-0 border-sol-border bg-sol-bg p-0 text-sol-text sm:rounded-xl"
        data-switch-review={l.name}
      >
        <header className="flex items-start justify-between gap-3 border-b border-sol-border/60 px-5 py-3.5">
          <DialogTitle className="flex min-w-0 flex-col gap-0.5 text-[15px] font-semibold leading-tight tracking-normal text-sol-text">
            <span>{l.name}</span>
            <span className="truncate text-[12.5px] font-normal text-sol-text-muted" data-switch-subject>{l.subject}</span>
          </DialogTitle>
          <span className="inline-flex shrink-0 items-center gap-1.5 pt-0.5 text-[11px] tabular-nums text-sol-text-dim" aria-hidden>
            Off <span className="text-sol-text-dim/60">→</span> <b className="font-semibold text-sol-orange">On</b>
          </span>
        </header>
        <DialogDescription className="sr-only">What turning on {l.name} for {l.subject} starts, what it costs, and how to stop it.</DialogDescription>

        {l.figures.length > 0 && (
          <dl className="grid grid-flow-col auto-cols-fr gap-px border-b border-sol-border/60 bg-sol-border/40" data-switch-figures>
            {l.figures.map((f) => (
              <div key={f.label} className="flex flex-col gap-0.5 bg-sol-bg px-4 py-3">
                <dd className={`text-[26px] font-semibold leading-none tabular-nums ${f.tone ? TONE[f.tone] : "text-sol-text"}`} data-switch-figure={f.label}>{f.value}</dd>
                <dt className="text-[11px] leading-tight text-sol-text-muted">{f.label}</dt>
              </div>
            ))}
          </dl>
        )}

        {l.lead && (
          <p className="flex flex-col gap-0.5 border-b border-sol-orange/30 bg-sol-orange/10 px-5 py-2.5 text-[12.5px] leading-snug text-sol-text" data-switch-lead>
            <b className="font-semibold">{l.lead.v}</b>
            {l.lead.sub && <span className="text-[11.5px] text-sol-text-muted">{l.lead.sub}</span>}
          </p>
        )}

        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2.5 px-5 py-4 text-[12.5px] leading-snug" data-switch-rows>
          {l.rows.map((r) => (
            <div key={r.k} className="contents" data-switch-row={r.k}>
              <dt className="text-sol-text-dim">{r.k}</dt>
              <dd className="min-w-0 break-words">
                {r.href
                  ? <a href={r.href} className={`${r.tone ? TONE[r.tone] : "text-sol-text"} underline decoration-sol-border underline-offset-2 hover:decoration-current`}>{r.v}</a>
                  : <span className={r.tone ? TONE[r.tone] : "text-sol-text"}>{r.v}</span>}
                {r.sub && <span className="block text-[11.5px] text-sol-text-muted">{r.sub}</span>}
              </dd>
            </div>
          ))}
          {l.yours && l.yours.length > 0 && (
            <div className="contents" data-switch-row="Yours">
              <dt className="text-sol-text-dim">Stays yours</dt>
              <dd className="flex flex-col gap-0.5 text-sol-text">
                {l.yours.map((y) => <span key={y} className="flex items-baseline gap-1.5"><span aria-hidden className="text-sol-green">✓</span>{y}</span>)}
              </dd>
            </div>
          )}
          <div className="contents" data-switch-row="Stop">
            <dt className="text-sol-text-dim">To stop</dt>
            <dd className="text-sol-text">{l.stop}</dd>
          </div>
        </dl>

        <footer className="flex items-center justify-between gap-3 border-t border-sol-border/60 bg-sol-bg-alt/40 px-5 py-3 sm:rounded-b-xl">
          <button ref={cancel} type="button" onClick={onClose} className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-sol-border px-3 text-[12.5px] text-sol-text-muted hover:text-sol-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/50" data-switch-cancel>
            Keep off <KeyCap size="xs">esc</KeyCap>
          </button>
          <button type="button" disabled={blocked} onClick={onConfirm} title={l.blocked} className="inline-flex h-8 min-w-0 items-center gap-2 whitespace-nowrap rounded-md bg-sol-orange px-3.5 text-[12.5px] font-semibold text-sol-bg hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-orange/50 disabled:cursor-not-allowed disabled:bg-sol-border disabled:text-sol-text-dim" data-switch-confirm>
            {l.blocked ?? l.confirm}
            {!blocked && <span className="inline-flex items-center gap-0.5"><KeyCap size="xs" tone="onAccent">{isMac ? "⌘" : "ctrl"}</KeyCap><KeyCap size="xs" tone="onAccent">↵</KeyCap></span>}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
