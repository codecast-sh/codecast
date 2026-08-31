"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronsDownUp, ChevronsUpDown, Sparkles } from "lucide-react";
import { cn } from "../../lib/utils";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { isInboxSessionView } from "../../lib/inboxRouting";
import { focusedActionSessionId } from "../../shortcuts/actions";
import { formatShortcutParts, getShortcutsForAction } from "../../shortcuts";
import { KeyCap, MenuKeyCaps, ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { PARK_VERBS, FILE_VERBS, type TriageVerb } from "./verbs";
import { useTriageActions } from "./useTriageActions";
import { isTriageBarCompact } from "./graduation";

// The inbox's triage bar: the four parking verbs (defer, dormant, stash,
// kill) plus pin and label, as buttons with their chords rendered. It lives
// in ONE place — the bottom edge of the inbox view — and acts on the same
// row the chords act on (focusedActionSessionId), so what you learn by
// clicking transfers one-to-one to the keyboard. Verbose by default (icon,
// word, keycaps); `triage_bar_compact` drops the words once the keys are
// second nature (see graduation.ts).

type Flash = { verb: TriageVerb; key: number };

function VerbButton({ verb, compact, disabled, engaged, onRun }: {
  verb: TriageVerb;
  compact: boolean;
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
        "flex items-center gap-1.5 h-6 rounded-[5px] transition-colors",
        compact ? "px-1.5" : "px-2",
        "text-sol-text-muted active:scale-[0.97]",
        "disabled:opacity-35 disabled:pointer-events-none",
        verb.hover,
        engaged && cn(verb.text, verb.bg),
      )}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} fill={engaged ? "currentColor" : "none"} />
      {!compact && <span className="cq-triage-word text-[11px] leading-none">{verb.label}</span>}
      {!compact && <MenuKeyCaps action={verb.action} className="cq-triage-caps flex items-center gap-[2px]" />}
    </button>
  );
  // Verbose mode already shows label + caps, so the tooltip carries the
  // meaning; compact mode's tooltip carries all three.
  return compact
    ? <ShortcutTooltip side="top" label={verb.label} action={verb.action} hint={verb.blurb}>{btn}</ShortcutTooltip>
    : <ShortcutTooltip side="top" label={verb.blurb}>{btn}</ShortcutTooltip>;
}

/** The ⌃J / K pair, built from the real binding so non-mac shows Ctrl. */
function NavPairCaps() {
  const next = getShortcutsForAction("session.next")[0];
  const prev = getShortcutsForAction("session.prev")[0];
  if (!next || !prev) return null;
  const nextParts = formatShortcutParts(next);
  const prevKey = formatShortcutParts(prev).slice(-1)[0];
  return (
    <span className="flex items-center gap-[2px]">
      {nextParts.map((p, i) => <KeyCap key={i} size="xs">{p}</KeyCap>)}
      <span className="text-sol-text-dim/40">/</span>
      <KeyCap size="xs">{prevKey}</KeyCap>
    </span>
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

  return (
    <div
      data-triage-bar
      className={cn(
        "cq-container flex-shrink-0 h-8 pl-1.5 pr-2 border-t bg-sol-bg-alt/30 hidden md:flex items-center gap-0.5",
        "text-[10px] text-sol-text-dim select-none overflow-hidden transition-all duration-500",
        glow
          ? "border-sol-cyan/50 shadow-[inset_0_1px_0_color-mix(in_srgb,var(--sol-cyan)_35%,transparent)] bg-sol-cyan/[0.06]"
          : "border-sol-border/30",
      )}
    >
      {PARK_VERBS.map((v) => (
        <VerbButton key={v.id} verb={v} compact={compact} disabled={disabled} onRun={() => run(v)} />
      ))}
      <span className="w-px h-3.5 bg-sol-border/40 mx-1" aria-hidden />
      {FILE_VERBS.map((v) => (
        <VerbButton
          key={v.id}
          verb={v}
          compact={compact}
          disabled={disabled}
          engaged={v.id === "pin" && activePinned}
          onRun={() => run(v)}
        />
      ))}
      {flash && <FlashLine flash={flash} />}

      <span className="ml-auto flex items-center gap-2.5 pl-2">
        {!compact && (
          <span className="cq-triage-hints flex items-center gap-2.5 text-sol-text-dim">
            <span className="flex items-center gap-1">
              <NavPairCaps /> nav
            </span>
            <span className="flex items-center gap-1">
              <MenuKeyCaps action="session.jumpIdle" className="flex items-center gap-[2px]" /> next up
            </span>
          </span>
        )}
        <ShortcutTooltip side="top" label="How the inbox works: a two minute tour">
          <button
            type="button"
            onClick={() => useInboxStore.getState().setTriageNuxOpen(true)}
            className="flex items-center gap-1 h-6 px-1.5 rounded-[5px] text-sol-text-dim hover:text-sol-violet hover:bg-sol-violet/10 transition-colors"
          >
            <Sparkles className="w-3 h-3" />
            {!compact && <span className="cq-triage-word text-[10px] leading-none">tour</span>}
          </button>
        </ShortcutTooltip>
        <ShortcutTooltip side="top" label="All shortcuts" action="ui.toggleShortcutsHelp">
          <button
            type="button"
            onClick={() => useInboxStore.getState().toggleShortcutsPanel()}
            className="flex items-center gap-1 h-6 px-1.5 rounded-[5px] hover:text-sol-text-muted hover:bg-sol-bg-alt transition-colors"
          >
            <KeyCap size="xs">?</KeyCap>
            {!compact && <span className="cq-triage-word">all shortcuts</span>}
          </button>
        </ShortcutTooltip>
        <ShortcutTooltip side="top" label={compact ? "Show the verb labels" : "Compact to icons"}>
          <button
            type="button"
            onClick={() => useInboxStore.getState().updateClientUI({ triage_bar_compact: !compact })}
            className="flex items-center h-6 px-1 rounded-[5px] text-sol-text-dim/70 hover:text-sol-text-muted hover:bg-sol-bg-alt transition-colors"
          >
            {compact ? <ChevronsUpDown className="w-3 h-3" /> : <ChevronsDownUp className="w-3 h-3" />}
          </button>
        </ShortcutTooltip>
      </span>
    </div>
  );
}
