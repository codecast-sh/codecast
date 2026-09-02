"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { MoreHorizontal, PanelBottomClose, Sparkles } from "lucide-react";
import { cn } from "../../lib/utils";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { isInboxSessionView } from "../../lib/inboxRouting";
import { focusedActionSessionId } from "../../shortcuts/actions";
import { MenuKeyCaps, ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { CtxItem, CtxSeparator, CTX_SURFACE } from "../ui/context-menu";
import { PRIMARY_VERBS, SECONDARY_VERBS, type TriageVerb } from "./verbs";
import { useTriageActions } from "./useTriageActions";
import { isTriageBarCompact, toggleTriageBarCompact } from "./graduation";

// The inbox's triage bar: one quiet row under the composer, in the composer's
// column, acting on the same row the chords act on (focusedActionSessionId),
// so what you learn by clicking transfers to the keyboard.
//
// At rest it shows only the three verbs that settle nearly every card — not
// now (defer), out of the way (stash), done (kill) — as icon + word. The
// chords live in the hover tooltips, never inline. Everything else (dormant,
// hide, pin, label, the tour, hiding the bar itself) sits one click away
// behind "more", a menu built from the same verb catalog. Hidden, the bar
// draws nothing at all; the command palette brings it back.

type Flash = { verb: TriageVerb; key: number };

function VerbButton({ verb, disabled, onRun }: {
  verb: TriageVerb;
  disabled: boolean;
  onRun: () => void;
}) {
  const Icon = verb.icon;
  return (
    <ShortcutTooltip side="top" label={verb.label} action={verb.action} hint={verb.blurb}>
      <button
        type="button"
        disabled={disabled}
        onClick={onRun}
        data-triage-verb={verb.id}
        className={cn(
          "flex items-center h-6 px-2 rounded-md transition-colors duration-150",
          "text-sol-text-muted active:scale-[0.97]",
          "disabled:opacity-35 disabled:pointer-events-none",
          verb.hover,
        )}
      >
        <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
        <span className="cq-triage-word ml-1.5 text-[11px] leading-none">{verb.label}</span>
      </button>
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = () => {
      if (timer) clearTimeout(timer);
      setGlow(true);
      timer = setTimeout(() => setGlow(false), 2600);
    };
    window.addEventListener("cc-triage-bar-glow", handler);
    return () => {
      window.removeEventListener("cc-triage-bar-glow", handler);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Zen strips the chrome by definition; the chords still work there. An
  // account with no sessions yet is on the CLI setup hero — a row of disabled
  // verbs under it would be noise, so the bar arrives with the first session.
  // Hidden is hidden: no corner button over the composer, no height.
  if (!onInboxView || (s.clientState.ui?.zen_mode ?? false) || compact) return null;
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
            "flex items-center gap-0.5 h-8 border-t transition-colors duration-500",
            glow ? "border-sol-cyan/40" : "border-sol-border/25",
          )}
        >
          {PRIMARY_VERBS.map((v) => (
            <VerbButton key={v.id} verb={v} disabled={disabled} onRun={() => run(v)} />
          ))}

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-triage-more
                aria-label="More triage actions"
                className={cn(
                  "flex items-center justify-center w-6 h-6 rounded-md transition-colors duration-150",
                  "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt",
                  "data-[state=open]:text-sol-text data-[state=open]:bg-sol-bg-alt",
                )}
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" sideOffset={6} className={CTX_SURFACE}>
              {SECONDARY_VERBS.map((v) => (
                <CtxItem
                  key={v.id}
                  icon={v.icon}
                  iconClassName={v.text}
                  shortcut={v.action}
                  danger={v.danger}
                  disabled={disabled}
                  onSelect={() => run(v)}
                >
                  {v.id === "pin" && activePinned ? "Unpin" : v.label}
                </CtxItem>
              ))}
              <CtxSeparator />
              <CtxItem icon={Sparkles} onSelect={() => useInboxStore.getState().setTriageNuxOpen(true)}>
                How the inbox works
              </CtxItem>
              <CtxItem icon={PanelBottomClose} onSelect={toggleTriageBarCompact}>
                Hide this bar
              </CtxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {flash && <FlashLine flash={flash} />}
        </div>
      </div>
    </div>
  );
}
