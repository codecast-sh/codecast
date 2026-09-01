"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronsDownUp, ChevronsUpDown, Sparkles } from "lucide-react";
import { cn } from "../../lib/utils";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { isInboxSessionView } from "../../lib/inboxRouting";
import { focusedActionSessionId } from "../../shortcuts/actions";
import { MenuKeyCaps, ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { PARK_VERBS, FILE_VERBS, type TriageVerb } from "./verbs";
import { useTriageActions } from "./useTriageActions";
import { isTriageBarCompact } from "./graduation";

// The inbox's triage bar: the four parking verbs (defer, dormant, stash,
// kill) plus pin and label. It lives in ONE place — under the composer, in
// the same column — and acts on the same row the chords act on
// (focusedActionSessionId), so what you learn by clicking transfers to the
// keyboard. Rest state is quiet (icon + word). Chords appear on hover of the
// bar, the same "ask then see" pattern the composer's send-options `?` uses.
// `triage_bar_compact` hides the row entirely: a corner button, no height.

type Flash = { verb: TriageVerb; key: number };

function VerbButton({ verb, disabled, engaged, onRun }: {
  verb: TriageVerb;
  disabled: boolean;
  /** Pin renders lit while the viewed session is pinned. */
  engaged?: boolean;
  onRun: () => void;
}) {
  const Icon = verb.icon;
  const btn = (
    <button
      type="button"
      disabled={disabled}
      onClick={onRun}
      data-triage-verb={verb.id}
      className={cn(
        "flex items-center h-6 px-2 rounded-[5px] transition-colors duration-150",
        "text-sol-text-muted active:scale-[0.97]",
        "disabled:opacity-35 disabled:pointer-events-none",
        verb.hover,
        engaged && cn(verb.text, verb.bg),
      )}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} fill={engaged ? "currentColor" : "none"} />
      <span className="cq-triage-word ml-1.5 text-[11px] leading-none">{verb.label}</span>
      <span className="cq-triage-caps" aria-hidden="true">
        <MenuKeyCaps action={verb.action} className="flex items-center gap-[2px]" />
      </span>
    </button>
  );
  // Chord is on the button only while the bar is hovered; the tooltip carries
  // it for the rest of the time (and on a narrow column, where the word goes
  // too). Same ShortcutTooltip the rest of the app uses for icon actions.
  return (
    <ShortcutTooltip side="top" label={verb.label} action={verb.action} hint={verb.blurb}>
      {btn}
    </ShortcutTooltip>
  );
}

/** "Deferred · ⌃Z to undo" — the just-happened line, teaching undo in place. */
function FlashLine({ flash }: { flash: Flash }) {
  return (
    <span
      key={flash.key}
      className={cn(
        "flex items-center gap-1.5 ml-2 whitespace-nowrap overflow-hidden min-w-0 shrink",
        "animate-in fade-in-0 slide-in-from-left-1 duration-200",
        flash.verb.text,
      )}
    >
      <span className="text-[10px] leading-none">{flash.verb.done}</span>
      <span className="flex items-center gap-1 text-sol-text-dim">
        <span aria-hidden>·</span>
        <MenuKeyCaps action="ui.undo" className="flex items-center gap-[2px]" />
        <span className="text-[10px] leading-none">to undo</span>
      </span>
    </span>
  );
}

export function TriageBar() {
  // Mounted once, in DashboardLayout's stage column, and self-gated to the
  // inbox session views — the same predicate the chords use for their
  // isOnInboxPage, so the bar and the keyboard always agree on the target.
  const pathname = usePathname();
  const s = useTrackedStore([
    (st) => isInboxSessionView(pathname, st.currentConversation?.source),
    (st) => focusedActionSessionId(st, isInboxSessionView(pathname, st.currentConversation?.source)) ?? null,
    (st) => {
      const id = focusedActionSessionId(st, isInboxSessionView(pathname, st.currentConversation?.source));
      return id ? (st.sessions[id]?.is_pinned ?? false) : false;
    },
    // The raw prefs, un-normalized: `?? false` here would erase the
    // unset→false transition the first compact toggle produces, and the bar
    // would not re-render on it.
    (st) => st.clientState.ui?.triage_bar_compact,
    (st) => st.clientState.ui?.inbox_shortcuts_hidden,
    (st) => st.clientState.ui?.zen_mode ?? false,
    (st) => Object.keys(st.sessions).length > 0,
  ]);
  const onInboxView = isInboxSessionView(pathname, s.currentConversation?.source);
  const activeId = focusedActionSessionId(s, onInboxView) ?? null;
  const activePinned = activeId ? (s.sessions[activeId]?.is_pinned ?? false) : false;
  const compact = isTriageBarCompact(s.clientState.ui);

  const triage = useTriageActions(onInboxView);

  const [flash, setFlash] = useState<Flash | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // Finishing the intro tour points here: a one-time glow that says "the
  // verbs you just practiced live on this bar."
  const [glow, setGlow] = useState(false);
  useEffect(() => {
    const onGlow = () => {
      setGlow(true);
      const t = setTimeout(() => setGlow(false), 2600);
      return t;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = () => { if (timer) clearTimeout(timer); timer = onGlow(); };
    window.addEventListener("cc-triage-bar-glow", handler);
    return () => {
      window.removeEventListener("cc-triage-bar-glow", handler);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Zen strips the chrome by definition; the chords still work there. An
  // account with no sessions yet is on the CLI setup hero — a row of disabled
  // verbs under it would be noise, so the bar arrives with the first session.
  if (!onInboxView || (s.clientState.ui?.zen_mode ?? false)) return null;
  if (Object.keys(s.sessions).length === 0) return null;

  const run = (verb: TriageVerb) => {
    if (!activeId) return;
    if (verb.id === "defer" || verb.id === "dormant") triage.park(activeId, verb.id, "button");
    else if (verb.id === "stash" || verb.id === "kill") triage.hide(activeId, verb.id, "button");
    else if (verb.id === "hide") triage.hide(activeId, "stash", "button", { hidden: true });
    else if (verb.id === "pin") triage.pin(activeId);
    else if (verb.id === "label") triage.label(activeId);
    // Label opens a picker; flashing "Labeled" before a label is chosen would
    // lie. Pin flashes its real direction.
    if (verb.id === "label") return;
    const done = verb.id === "pin" && activePinned ? { ...verb, done: "Unpinned" } : verb;
    setFlash({ verb: done, key: Date.now() });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 4000);
  };

  const disabled = !activeId;
  const toggleCompact = () => useInboxStore.getState().updateClientUI({ triage_bar_compact: !compact });

  // Minimized: a corner button, no layout height. Anchored to the same
  // conv-col as the composer so it sits in the box's left padding — not on
  // the typed text, and not fighting the call pill on the right.
  if (compact) {
    return (
      <div className="relative h-0 overflow-visible hidden md:block pointer-events-none">
        <div className="absolute inset-x-0 bottom-2.5 z-20">
          <div className="mx-auto conv-col px-2 sm:px-4">
            <ShortcutTooltip side="top" label="Triage actions">
              <button
                type="button"
                data-triage-bar="collapsed"
                onClick={toggleCompact}
                aria-label="Show triage actions"
                className={cn(
                  "pointer-events-auto flex items-center justify-center w-6 h-6 -translate-x-1/2 rounded-full",
                  "border border-sol-border/50 bg-sol-bg-alt/95 text-sol-text-dim",
                  "shadow-sm backdrop-blur-sm",
                  "hover:text-sol-text hover:border-sol-border hover:bg-sol-bg-alt",
                  "transition-colors duration-150 active:scale-[0.97]",
                  glow && "border-sol-cyan/50 text-sol-cyan",
                )}
              >
                <ChevronsUpDown className="w-3 h-3" />
              </button>
            </ShortcutTooltip>
          </div>
        </div>
      </div>
    );
  }

  // Same column and padding as the composer (ConversationView MessageInput:
  // `mx-auto conv-col px-2 sm:px-4`). A hairline the width of that column
  // — not the stage — is the only separator, so the verbs read as the row
  // under the compose box, next to send, not as a second app footer.
  return (
    <div
      data-triage-bar
      className={cn(
        "cq-container flex-shrink-0 hidden md:block select-none",
        "text-[10px] text-sol-text-dim bg-sol-bg",
        glow && "bg-sol-cyan/[0.04]",
      )}
    >
      <div className="mx-auto conv-col px-2 sm:px-4">
        <div
          className={cn(
            "flex items-center gap-0.5 h-7 border-t",
            glow ? "border-sol-cyan/40" : "border-sol-border/25",
          )}
        >
          {PARK_VERBS.map((v) => (
            <VerbButton key={v.id} verb={v} disabled={disabled} onRun={() => run(v)} />
          ))}
          <span className="w-px h-3.5 bg-sol-border/40 mx-1" aria-hidden />
          {FILE_VERBS.map((v) => (
            <VerbButton
              key={v.id}
              verb={v}
              disabled={disabled}
              engaged={v.id === "pin" && activePinned}
              onRun={() => run(v)}
            />
          ))}
          {flash && <FlashLine flash={flash} />}

          <span className="ml-auto flex items-center gap-0.5 pl-2">
            <ShortcutTooltip side="top" label="How the inbox works: a two minute tour">
              <button
                type="button"
                onClick={() => useInboxStore.getState().setTriageNuxOpen(true)}
                className="flex items-center justify-center w-6 h-6 rounded-[5px] text-sol-text-dim hover:text-sol-violet hover:bg-sol-violet/10 transition-colors duration-150"
                aria-label="Inbox tour"
              >
                <Sparkles className="w-3 h-3" />
              </button>
            </ShortcutTooltip>
            <ShortcutTooltip side="top" label="Hide the triage bar">
              <button
                type="button"
                onClick={toggleCompact}
                className="flex items-center justify-center w-6 h-6 rounded-[5px] text-sol-text-dim/70 hover:text-sol-text-muted hover:bg-sol-bg-alt transition-colors duration-150"
                aria-label="Hide the triage bar"
              >
                <ChevronsDownUp className="w-3 h-3" />
              </button>
            </ShortcutTooltip>
          </span>
        </div>
      </div>
    </div>
  );
}
