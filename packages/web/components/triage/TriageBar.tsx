"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { EyeOff, MoreHorizontal, PinOff, Sparkles } from "lucide-react";
import { cn } from "../../lib/utils";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { isInboxSessionView } from "../../lib/inboxRouting";
import { focusedActionSessionId } from "../../shortcuts/actions";
import { KeyCap, MenuKeyCaps, ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "../ui/dropdown-menu";
import { CTX_SURFACE, CtxItem, CtxSeparator } from "../ui/context-menu";
import { PRIMARY_VERBS, SECONDARY_VERBS, type TriageVerb } from "./verbs";
import { useTriageActions } from "./useTriageActions";
import { isTriageBarCompact, toggleTriageBarCompact } from "./graduation";

// The triage bar: one quiet row under the composer, in the composer's own
// column. At rest it says three words — Defer, Stash, Kill — the verbs that
// settle nearly every card. Nothing else is printed: the chord and the
// meaning of each verb live in its hover tooltip, and the rest of the
// vocabulary (dormant, hide, pin, label) sits one click away behind the
// "more" button, chords shown beside each. The bar acts on the row the
// chords act on (focusedActionSessionId), so what the mouse learns transfers
// to the keys. Hidden by preference means gone — nothing floats over the
// composer; the palette command and the shortcuts panel bring it back.

type Flash = { verb: TriageVerb; key: number };

function VerbButton({ verb, disabled, onRun }: { verb: TriageVerb; disabled: boolean; onRun: () => void }) {
  const Icon = verb.icon;
  return (
    <ShortcutTooltip side="top" label={verb.label} action={verb.action} hint={verb.blurb}>
      <button
        type="button"
        disabled={disabled}
        onClick={onRun}
        data-triage-verb={verb.id}
        className={cn(
          "flex items-center gap-1.5 h-6 px-2 rounded-[5px] transition-colors duration-150",
          "text-sol-text-muted active:scale-[0.97] outline-none focus-visible:ring-1 focus-visible:ring-sol-cyan/40",
          "disabled:opacity-35 disabled:pointer-events-none",
          verb.hover,
        )}
      >
        <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
        <span className="cq-triage-word text-[11px] leading-none">{verb.label}</span>
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
    // Raw prefs, un-normalized: `?? false` would erase the unset→false
    // transition the first toggle produces and skip that re-render.
    (st) => st.clientState.ui?.triage_bar_compact,
    (st) => st.clientState.ui?.inbox_shortcuts_hidden,
    (st) => st.clientState.ui?.zen_mode ?? false,
    (st) => Object.keys(st.sessions).length > 0,
  ]);
  const onInboxView = isInboxSessionView(pathname, s.currentConversation?.source);
  const activeId = focusedActionSessionId(s, onInboxView) ?? null;
  const activePinned = activeId ? (s.sessions[activeId]?.is_pinned ?? false) : false;

  const triage = useTriageActions(onInboxView);

  const [flash, setFlash] = useState<Flash | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // Finishing the intro tour points here: a one-time glow that says "the
  // verbs you just practiced live on this row."
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
  if (!onInboxView || (s.clientState.ui?.zen_mode ?? false)) return null;
  if (Object.keys(s.sessions).length === 0) return null;
  if (isTriageBarCompact(s.clientState.ui)) return null;

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
  // `mx-auto conv-col px-2 sm:px-4`). A hairline the width of that column is
  // the only separator, so the verbs read as the row under the compose box.
  return (
    <div
      data-triage-bar
      className={cn(
        "cq-container flex-shrink-0 hidden md:block select-none",
        "text-[10px] text-sol-text-dim bg-sol-bg transition-colors duration-500",
        glow && "bg-sol-cyan/[0.04]",
      )}
    >
      <div className="mx-auto conv-col px-2 sm:px-4">
        <div
          className={cn(
            "flex items-center gap-0.5 h-7 border-t transition-colors duration-500",
            glow ? "border-sol-cyan/40" : "border-sol-border/25",
          )}
        >
          {PRIMARY_VERBS.map((v) => (
            <VerbButton key={v.id} verb={v} disabled={disabled} onRun={() => run(v)} />
          ))}

          <DropdownMenu>
            <ShortcutTooltip side="top" label="More">
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label="More triage actions"
                  data-triage-more
                  className={cn(
                    "flex items-center justify-center w-6 h-6 rounded-[5px] text-sol-text-dim transition-colors duration-150",
                    "outline-none focus-visible:ring-1 focus-visible:ring-sol-cyan/40",
                    "hover:text-sol-text hover:bg-sol-bg-alt data-[state=open]:text-sol-text data-[state=open]:bg-sol-bg-alt",
                    "disabled:opacity-35 disabled:pointer-events-none",
                  )}
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>
              </DropdownMenuTrigger>
            </ShortcutTooltip>
            <DropdownMenuContent align="start" side="top" sideOffset={6} collisionPadding={8} className={CTX_SURFACE}>
              {SECONDARY_VERBS.map((v) => {
                const pinned = v.id === "pin" && activePinned;
                return (
                  <CtxItem
                    key={v.id}
                    icon={pinned ? PinOff : v.icon}
                    shortcut={v.action}
                    danger={v.danger}
                    onSelect={() => run(v)}
                  >
                    {pinned ? "Unpin" : v.label}
                  </CtxItem>
                );
              })}
              <CtxSeparator />
              <CtxItem icon={Sparkles} onSelect={() => useInboxStore.getState().setTriageNuxOpen(true)}>
                How the inbox works
              </CtxItem>
              <CtxItem icon={EyeOff} onSelect={toggleTriageBarCompact}>
                Hide this bar
              </CtxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {flash && <FlashLine flash={flash} />}

          <ShortcutTooltip side="top" label="Shortcuts and the tour" action="ui.toggleShortcutsHelp">
            <button
              type="button"
              onClick={() => useInboxStore.getState().toggleShortcutsPanel()}
              aria-label="Keyboard shortcuts"
              className="ml-auto flex items-center justify-center w-6 h-6 rounded-[5px] outline-none focus-visible:ring-1 focus-visible:ring-sol-cyan/40 hover:bg-sol-bg-alt transition-colors duration-150"
            >
              <KeyCap size="xs">?</KeyCap>
            </button>
          </ShortcutTooltip>
        </div>
      </div>
    </div>
  );
}
