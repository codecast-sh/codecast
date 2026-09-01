"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Check } from "lucide-react";
import { cn } from "../../lib/utils";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { getShortcutsForAction, matchShortcut, type ShortcutAction } from "../../shortcuts";
import { MenuKeyCaps } from "../KeyboardShortcutsHelp";
import { track } from "../../lib/analytics";
import { isInboxSessionView } from "../../lib/inboxRouting";
import { PARK_VERBS, TRIAGE_VERBS, type TriageVerb, type TriageVerbId } from "./verbs";

// The intro tour: four screens that teach the codecast loop — cards arrive,
// the inbox sorts them by who acts next, and you clear them with one
// keystroke each. The last screen is a practice inbox wired to the REAL
// chords: aria-modal suspends the app's own shortcut dispatch, so the same
// physical keys are safe to catch here and act only on the demo cards.
// Runs once (clientState.tips, synced cross device); replayable from the
// triage bar and the shortcuts panel.

export const NUX_TIP_ID = "nux-tour";

type CardState = "needs-input" | "working" | "dormant" | "done";

const STATE_META: Record<CardState, { label: string; dot: string; text: string }> = {
  "needs-input": { label: "needs input", dot: "bg-sol-yellow", text: "text-sol-yellow" },
  working: { label: "working", dot: "bg-sol-green", text: "text-sol-green" },
  dormant: { label: "dormant", dot: "bg-sol-blue", text: "text-sol-blue" },
  done: { label: "done", dot: "bg-sol-cyan", text: "text-sol-cyan" },
};

const STATE_ROWS: { state: CardState; name: string; line: string }[] = [
  { state: "needs-input", name: "Needs input", line: "Blocked on you: a question, a permission, a finished turn to review." },
  { state: "working", name: "Working", line: "Producing right now. Nothing to do yet." },
  { state: "dormant", name: "Dormant", line: "Parked on purpose. A machine wakes it; it never asks for your eyes." },
  { state: "done", name: "Done", line: "Delivered. Read it when you like, then clear it." },
];

type DemoCard = { id: string; title: string; sub: string; state: CardState; suggest: TriageVerbId };

const DEMO_CARDS: DemoCard[] = [
  { id: "c1", title: "Fix the flaky auth test", state: "needs-input", sub: "Asked: pin the seed, or quarantine the test?", suggest: "defer" },
  { id: "c2", title: "Nightly dependency audit", state: "working", sub: "Scanning 214 packages, no findings yet", suggest: "stash" },
  { id: "c3", title: "Write the release notes", state: "done", sub: "Draft delivered and published", suggest: "kill" },
];

function MiniCard({ card, focused, cleared, clearedBy }: {
  card: DemoCard;
  focused?: boolean;
  cleared?: boolean;
  clearedBy?: TriageVerb | null;
}) {
  const meta = STATE_META[card.state];
  return (
    <div
      className={cn(
        "overflow-hidden transition-all duration-300 ease-out",
        cleared ? "max-h-0 opacity-0 translate-x-6 mb-0" : "max-h-[72px] opacity-100 translate-x-0 mb-2",
      )}
    >
      <div
        className={cn(
          "rounded-lg border bg-sol-card px-3 py-2 transition-colors",
          focused ? "border-sol-cyan/60 ring-1 ring-sol-cyan/25" : "border-sol-border/40",
        )}
      >
        <div className="flex items-center gap-2">
          <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", meta.dot, card.state === "working" && "animate-pulse")} />
          <span className="text-xs text-sol-text truncate">{card.title}</span>
          <span className={cn("ml-auto text-[9px] uppercase tracking-[0.08em] shrink-0", meta.text)}>
            {clearedBy ? clearedBy.done.toLowerCase() : meta.label}
          </span>
        </div>
        <div className="mt-0.5 pl-3.5 text-[10px] text-sol-text-dim truncate">{card.sub}</div>
      </div>
    </div>
  );
}

/** Keycaps for an action, sized for the tour. */
function Caps({ action }: { action: ShortcutAction }) {
  return <MenuKeyCaps action={action} className="flex items-center gap-[2px]" />;
}

function StepShell({ title, lede, children }: { title: string; lede?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="px-8 pt-7 pb-2 animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
      <h2 className="font-serif text-[22px] leading-tight text-sol-text">{title}</h2>
      {lede && <p className="mt-2 text-[13px] leading-relaxed text-sol-text-muted max-w-[46ch]">{lede}</p>}
      <div className="mt-5">{children}</div>
    </div>
  );
}

// The arrival screen's cards cover all four states, one each, so the state
// screen that follows names exactly what was just seen.
const ARRIVAL_CARDS: DemoCard[] = [
  { id: "a1", title: "Fix the flaky auth test", state: "needs-input", sub: "Asked: pin the seed, or quarantine the test?", suggest: "defer" },
  { id: "a2", title: "Port the importer to bun", state: "working", sub: "Rewriting the stream reader", suggest: "stash" },
  { id: "a3", title: "Nightly dependency audit", state: "dormant", sub: "Wakes at 02:00 by trigger", suggest: "dormant" },
  { id: "a4", title: "Write the release notes", state: "done", sub: "Draft delivered and published", suggest: "kill" },
];

function StepInbox() {
  return (
    <StepShell
      title="An inbox for your agents"
      lede={<>Every card is one agent doing one piece of work. Cards arrive as agents finish or get stuck, the same way mail does.</>}
    >
      <div className="max-w-[380px] mx-auto">
        {ARRIVAL_CARDS.map((c, i) => (
          <div
            key={c.id}
            className="animate-in fade-in-0 slide-in-from-top-2 duration-300 [animation-fill-mode:backwards]"
            style={{ animationDelay: `${180 + i * 140}ms` }}
          >
            <MiniCard card={c} />
          </div>
        ))}
      </div>
    </StepShell>
  );
}

function StepStates() {
  return (
    <StepShell
      title="Sorted by who acts next"
      lede={<>The inbox asks one question of every card and files it by the answer.</>}
    >
      <div className="space-y-2.5">
        {STATE_ROWS.map((r, i) => (
          <div
            key={r.state}
            className="flex items-baseline gap-3 animate-in fade-in-0 slide-in-from-bottom-1 duration-300 [animation-fill-mode:backwards]"
            style={{ animationDelay: `${120 + i * 110}ms` }}
          >
            <span className={cn("w-2 h-2 rounded-full shrink-0 translate-y-[1px]", STATE_META[r.state].dot)} />
            <span className={cn("w-24 shrink-0 text-[12px] font-medium", STATE_META[r.state].text)}>{r.name}</span>
            <span className="text-[12px] leading-relaxed text-sol-text-muted">{r.line}</span>
          </div>
        ))}
      </div>
      <p className="mt-5 text-[11px] text-sol-text-dim flex items-center gap-1.5 flex-wrap">
        <Caps action="session.jumpIdle" /> jumps to the top card that needs you.
      </p>
    </StepShell>
  );
}

function StepVerbs() {
  return (
    <StepShell
      title="Reply, or park it"
      lede={<>Open the top card and read it. If it needs words, reply. If not, one keystroke files it. The keys work from an empty composer.</>}
    >
      <div className="space-y-1">
        {TRIAGE_VERBS.map((v, i) => {
          const Icon = v.icon;
          return (
            <div
              key={v.id}
              className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-sol-bg-alt/60 animate-in fade-in-0 slide-in-from-bottom-1 duration-300 [animation-fill-mode:backwards]"
              style={{ animationDelay: `${100 + i * 80}ms` }}
            >
              <Icon className={cn("w-3.5 h-3.5 shrink-0", v.text)} strokeWidth={1.75} />
              <span className={cn("w-16 shrink-0 text-[12px] font-medium", v.text)}>{v.label}</span>
              <span className="text-[11px] text-sol-text-muted leading-snug flex-1">{v.blurb}</span>
              <Caps action={v.action} />
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-[11px] text-sol-text-dim flex items-center gap-1.5">
        Every verb is undoable: <Caps action="ui.undo" />
      </p>
    </StepShell>
  );
}

function StepPractice({ cleared, clearedBy, onClear, onFinish }: {
  cleared: Record<string, boolean>;
  clearedBy: Record<string, TriageVerb | undefined>;
  onClear: (verb: TriageVerb) => void;
  onFinish: () => void;
}) {
  const remaining = DEMO_CARDS.filter((c) => !cleared[c.id]);
  const focus = remaining[0] ?? null;
  const doneAll = remaining.length === 0;
  const anyCleared = DEMO_CARDS.some((c) => cleared[c.id]);
  const suggested = focus ? PARK_VERBS.find((v) => v.id === focus.suggest) : null;

  return (
    <StepShell
      title={doneAll ? "Inbox zero" : "Clear these three"}
      lede={doneAll
        ? <>That is the whole loop: open the top card, reply or park it, land on the next.</>
        : <>These are practice cards. Park each one — the highlighted card is next, and any parking verb works.</>}
    >
      {doneAll ? (
        <div className="flex flex-col items-center py-6 animate-in fade-in-0 zoom-in-95 duration-300">
          <span className="flex items-center justify-center w-12 h-12 rounded-full bg-sol-green/15 text-sol-green">
            <Check className="w-6 h-6" strokeWidth={2.5} />
          </span>
          <button
            type="button"
            autoFocus
            onClick={onFinish}
            className="mt-6 px-4 h-8 rounded-md bg-sol-cyan/15 text-sol-cyan text-[12px] font-medium hover:bg-sol-cyan/25 transition-colors"
          >
            Start triaging
          </button>
          <p className="mt-3 text-[10px] text-sol-text-dim flex items-center gap-1.5">
            <Caps action="ui.undo" /> still brings the last one back
          </p>
        </div>
      ) : (
        <div className="max-w-[400px] mx-auto">
          {DEMO_CARDS.map((c) => (
            <MiniCard
              key={c.id}
              card={c}
              focused={focus?.id === c.id}
              cleared={!!cleared[c.id]}
              clearedBy={clearedBy[c.id] ?? null}
            />
          ))}
          <div className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-sol-text-dim min-h-[24px]">
            {suggested && (
              <>
                try <Caps action={suggested.action} />
                <span className={suggested.text}>{suggested.label.toLowerCase()}</span>
                {anyCleared && (
                  <span className="flex items-center gap-1.5 ml-2 text-sol-text-dim/80">
                    · <Caps action="ui.undo" /> undoes
                  </span>
                )}
              </>
            )}
          </div>
          {/* The same buttons the real bar carries, so the mouse path teaches
              the bar's location as it clears the cards. */}
          <div className="mt-1.5 flex items-center justify-center gap-1">
            <span className="text-[10px] text-sol-text-dim/70 mr-1">or click</span>
            {PARK_VERBS.map((v) => {
              const Icon = v.icon;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => onClear(v)}
                  className={cn(
                    "flex items-center gap-1 h-6 px-1.5 rounded-[5px] text-[10px] text-sol-text-muted transition-colors",
                    v.hover,
                  )}
                >
                  <Icon className="w-3 h-3" strokeWidth={1.75} />
                  {v.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </StepShell>
  );
}

const STEP_COUNT = 4;

export function TriageNux() {
  const [step, setStep] = useState(0);
  // One atomic object so a chord and its undo stay pure updater functions
  // (StrictMode double-invokes updaters; side effects inside them double).
  const [practice, setPractice] = useState<{
    cleared: Record<string, boolean>;
    by: Record<string, TriageVerb | undefined>;
    order: string[];
  }>({ cleared: {}, by: {}, order: [] });
  const cleared = practice.cleared;
  const clearedBy = practice.by;
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    track("nux_tour_opened", {});
    containerRef.current?.focus();
  }, []);
  useEffect(() => { track("nux_tour_step", { step }); }, [step]);

  const close = useCallback((outcome: "finished" | "skipped") => {
    const store = useInboxStore.getState();
    const tips = store.clientState.tips;
    if (outcome === "finished") {
      store.updateClientTips({ completed: [...(tips?.completed ?? []), NUX_TIP_ID] });
    } else {
      store.updateClientTips({ dismissed: [...(tips?.dismissed ?? []), NUX_TIP_ID] });
    }
    track(outcome === "finished" ? "nux_tour_finished" : "nux_tour_skipped", { step });
    store.setTriageNuxOpen(false);
    // Point at the live bar: the verbs just practiced are sitting on it.
    if (outcome === "finished") window.dispatchEvent(new Event("cc-triage-bar-glow"));
  }, [step]);

  const clearFocused = useCallback((verb: TriageVerb) => {
    setPractice((p) => {
      const focus = DEMO_CARDS.find((c) => !p.cleared[c.id]);
      if (!focus) return p;
      return {
        cleared: { ...p.cleared, [focus.id]: true },
        by: { ...p.by, [focus.id]: verb },
        order: [...p.order, focus.id],
      };
    });
  }, []);

  const undoClear = useCallback(() => {
    setPractice((p) => {
      const last = p.order[p.order.length - 1];
      if (!last) return p;
      return {
        cleared: { ...p.cleared, [last]: false },
        by: { ...p.by, [last]: undefined },
        order: p.order.slice(0, -1),
      };
    });
  }, []);

  const practiceDone = DEMO_CARDS.every((c) => cleared[c.id]);

  // One window listener, capture phase: the app's own dispatcher is already
  // suspended by aria-modal, but Escape and the practice chords must not
  // leak into anything else either.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        close("skipped");
        return;
      }
      if (step < STEP_COUNT - 1) {
        if (e.key === "ArrowRight" || e.key === "Enter") {
          e.preventDefault(); e.stopPropagation();
          setStep((s) => Math.min(s + 1, STEP_COUNT - 1));
        } else if (e.key === "ArrowLeft") {
          e.preventDefault(); e.stopPropagation();
          setStep((s) => Math.max(s - 1, 0));
        }
        return;
      }
      // Practice: the real chords, against the demo cards only.
      for (const verb of PARK_VERBS) {
        for (const def of getShortcutsForAction(verb.action)) {
          if (matchShortcut(e, def)) {
            e.preventDefault(); e.stopPropagation();
            clearFocused(verb);
            return;
          }
        }
      }
      for (const def of getShortcutsForAction("ui.undo")) {
        if (matchShortcut(e, def)) {
          e.preventDefault(); e.stopPropagation();
          undoClear();
          return;
        }
      }
      if (practiceDone && e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        close("finished");
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [step, close, clearFocused, undoClear, practiceDone]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="How codecast works"
      className="fixed inset-0 z-[10050] flex items-center justify-center p-4"
    >
      <div
        className="absolute inset-0 bg-black/45 backdrop-blur-[3px] animate-in fade-in-0 duration-200"
        onClick={() => close("skipped")}
      />
      <div
        ref={containerRef}
        tabIndex={-1}
        className="relative w-full max-w-[600px] rounded-2xl border border-sol-border/60 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden outline-none animate-in fade-in-0 zoom-in-95 duration-200"
      >
        <div className="min-h-[380px]">
          {step === 0 && <StepInbox />}
          {step === 1 && <StepStates />}
          {step === 2 && <StepVerbs />}
          {step === 3 && (
            <StepPractice
              cleared={cleared}
              clearedBy={clearedBy}
              onClear={clearFocused}
              onFinish={() => close("finished")}
            />
          )}
        </div>

        <div className="flex items-center px-8 py-4 border-t border-sol-border/30">
          {/* Once practice is cleared the body's "Start triaging" owns the
              close; a skip here would record a dismissal after a completion. */}
          <button
            type="button"
            onClick={() => close("skipped")}
            className={cn(
              "text-[11px] text-sol-text-dim hover:text-sol-text-muted transition-colors",
              practiceDone && "invisible",
            )}
          >
            Skip tour
          </button>
          <div className="flex items-center gap-1.5 mx-auto">
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Step ${i + 1}`}
                aria-current={i === step ? "step" : undefined}
                onClick={() => setStep(i)}
                className={cn(
                  "h-1.5 rounded-full transition-all duration-300",
                  i === step ? "w-5 bg-sol-cyan" : "w-1.5 bg-sol-text-dim/30 hover:bg-sol-text-dim/60",
                )}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {step > 0 && !practiceDone && (
              <button
                type="button"
                onClick={() => setStep((s) => s - 1)}
                className="px-3 h-7 rounded-md text-[11px] text-sol-text-muted hover:bg-sol-bg-alt transition-colors"
              >
                Back
              </button>
            )}
            {step < STEP_COUNT - 1 ? (
              <button
                type="button"
                onClick={() => setStep((s) => s + 1)}
                className="px-3.5 h-7 rounded-md bg-sol-cyan/15 text-sol-cyan text-[11px] font-medium hover:bg-sol-cyan/25 transition-colors"
              >
                Next
              </button>
            ) : practiceDone ? null : (
              <span className="text-[10px] text-sol-text-dim tabular-nums">
                {DEMO_CARDS.filter((c) => !cleared[c.id]).length} left
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Mounted on the inbox page. Auto-opens the tour once per account, only when
// there is something real behind it (the user has sessions), never over the
// CLI setup hero, and never when tips are off. Established users — anyone the
// tips system already grades phase 3+ — never get the unprompted modal; for
// them the tour stays a replay entry on the bar and the shortcuts panel.
export function TriageNuxGate() {
  const pathname = usePathname();
  const s = useTrackedStore([
    (st) => st.triageNuxOpen,
    (st) => st.clientStateInitialized,
    (st) => {
      const t = st.clientState.tips;
      return !!(t?.completed?.includes(NUX_TIP_ID) || t?.dismissed?.includes(NUX_TIP_ID));
    },
    (st) => st.clientState.tips?.level === "none",
    (st) => Object.keys(st.sessions).length > 0,
    (st) => isInboxSessionView(pathname, st.currentConversation?.source),
  ]);
  const onInboxView = isInboxSessionView(pathname, s.currentConversation?.source);
  const open = s.triageNuxOpen;
  const initialized = s.clientStateInitialized;
  const tips = s.clientState.tips;
  const done = !!(tips?.completed?.includes(NUX_TIP_ID) || tips?.dismissed?.includes(NUX_TIP_ID));
  const off = tips?.level === "none";
  const hasSessions = Object.keys(s.sessions).length > 0;
  // Same thresholds as useTips.currentPhase: 8+ tips absorbed = phase 3.
  const veteran = (tips?.seen?.length ?? 0) + (tips?.completed?.length ?? 0) >= 8;

  useEffect(() => {
    if (open || !onInboxView || !initialized || done || off || veteran || !hasSessions) return;
    // A beat after landing, so the tour never races the page paint.
    const t = setTimeout(() => useInboxStore.getState().setTriageNuxOpen(true), 1500);
    return () => clearTimeout(t);
  }, [open, onInboxView, initialized, done, off, veteran, hasSessions]);

  if (!open) return null;
  return <TriageNux />;
}
