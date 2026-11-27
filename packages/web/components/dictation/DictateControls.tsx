// The composer's mic, drawn the way Claude's composer draws it: a mic and a
// small caret for its settings while idle; Cancel (✕) and Finish (✓) while it
// records. Shown only once the person has turned dictation on (Settings ›
// Voice); a team without an OpenAI BAA sees the mic disabled with the reason.
// The behaviour lives in useDictation; this is only the buttons.
import { useState, type MouseEvent, type ReactElement } from "react";
import { Check, ChevronDown, Loader2, Mic, X } from "lucide-react";
import { DICTATION_LANGUAGES, dictationStopLine, teamVendorBlock } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { readDictationLanguage, writeDictationLanguage } from "../../lib/dictation/host";
import type { DictationControls } from "../../lib/dictation/useDictation";

/** "dock": the session composer's row buttons (expand, stash). "bare": the
 *  comment and chat box, beside its small square send. */
export type DictateSize = "dock" | "bare";

const SIZES: Record<DictateSize, { button: string; caret: string; icon: string }> = {
  dock: { button: "w-7 h-7 rounded-full", caret: "w-4 h-7 rounded-full", icon: "w-3.5 h-3.5" },
  bare: { button: "w-6 h-6 rounded-md", caret: "w-4 h-6 rounded-md", icon: "w-3.5 h-3.5" },
};

const BASE = "transition-colors flex items-center justify-center shrink-0";
const QUIET = "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg/50";

const dictationOn = (s: { currentUser?: unknown }) => (s.currentUser as { dictation_enabled?: boolean } | null | undefined)?.dictation_enabled === true;

export function DictateControls(props: { dictation: DictationControls; size?: DictateSize; onMenuClosed?: () => void }) {
  const enabled = useInboxStore(dictationOn);
  // A recording outlives the switch going off mid-sentence: its ✕ and ✓ stay.
  if (!enabled && !props.dictation.active) return null;
  return <DictateButtons {...props} />;
}

function DictateButtons({ dictation, size = "dock", onMenuClosed }: { dictation: DictationControls; size?: DictateSize; onMenuClosed?: () => void }) {
  const blocked = useInboxStore((s) => {
    const id = s.clientState.ui?.active_team_id;
    const team = id ? (s.teams ?? []).find((t: any) => t?._id === id) : null;
    return teamVendorBlock(team as any, "openai");
  });
  const sz = SIZES[size];
  // Keep the keyboard in the box: a press on these never takes focus from it.
  const keepFocus = (e: MouseEvent) => e.preventDefault();
  const tip = (button: ReactElement, label: string) => (
    <ShortcutTooltip label={label} side="top">
      {button}
    </ShortcutTooltip>
  );

  if (dictation.active) {
    const finishing = dictation.state.phase === "finishing";
    return (
      <div className="flex items-center gap-0.5" data-dictation={dictation.state.phase}>
        {tip(
          <button type="button" onMouseDown={keepFocus} onClick={() => dictation.cancel()} className={`${BASE} ${sz.button} ${QUIET}`} aria-label="Cancel dictation">
            <X className={sz.icon} />
          </button>,
          "Cancel dictation",
        )}
        {tip(
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => void dictation.finish()}
            disabled={finishing}
            aria-busy={finishing || undefined}
            className={`${BASE} ${sz.button} text-sol-blue bg-sol-blue/20 hover:bg-sol-blue/30 disabled:cursor-wait`}
            aria-label="Finish dictation"
          >
            {finishing ? <Loader2 className={`${sz.icon} animate-spin`} /> : <Check className={sz.icon} />}
          </button>,
          finishing ? "Finishing…" : "Finish dictation",
        )}
      </div>
    );
  }

  const failed = dictation.state.error;
  const reason = blocked ?? failed ?? dictationStopLine(dictation.state.stopped);
  const mic = (
    <button
      type="button"
      onMouseDown={keepFocus}
      onClick={() => dictation.start()}
      disabled={!!blocked}
      data-dictation-reason={reason ?? undefined}
      className={`${BASE} ${sz.button} ${blocked ? "text-sol-text-dim/30 cursor-not-allowed" : failed ? "text-sol-red hover:bg-sol-red/10" : QUIET}`}
      aria-label="Dictate"
    >
      <Mic className={sz.icon} />
    </button>
  );
  return (
    <div className="flex items-center" data-dictation="idle">
      {tip(blocked ? <span className="inline-flex">{mic}</span> : mic, reason ?? "Dictate")}
      {!blocked && <LanguageMenu caretClass={`${BASE} ${sz.caret} ${QUIET}`} onClosed={onMenuClosed} />}
    </div>
  );
}

function LanguageMenu({ caretClass, onClosed }: { caretClass: string; onClosed?: () => void }) {
  const [choice, setChoice] = useState<string | null>(readDictationLanguage);
  return (
    <DropdownMenu onOpenChange={(open) => open && setChoice(readDictationLanguage())}>
      <ShortcutTooltip label="Dictation settings" side="top">
        <DropdownMenuTrigger asChild>
          <button type="button" className={caretClass} aria-label="Dictation settings">
            <ChevronDown className="w-3 h-3" />
          </button>
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent
        side="top"
        align="end"
        className="w-48 max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))]"
        onCloseAutoFocus={(e) => {
          if (!onClosed) return;
          e.preventDefault();
          onClosed();
        }}
      >
        <DropdownMenuLabel className="text-xs px-2 pt-1.5 pb-1">Dictation settings</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-sol-text-muted text-xs font-normal px-2 pt-1 pb-1">Language</DropdownMenuLabel>
        {DICTATION_LANGUAGES.map((l) => (
          <DropdownMenuCheckboxItem
            key={l.code ?? "auto"}
            checked={l.code === choice}
            onCheckedChange={() => {
              writeDictationLanguage(l.code);
              setChoice(l.code);
            }}
            className="text-xs"
          >
            {l.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
