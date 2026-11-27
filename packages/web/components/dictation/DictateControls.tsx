// The composer's mic, drawn the way Claude's composer draws it: a mic and a
// small caret for its settings while idle; Cancel (✕) while it records (Send,
// Enter or Create finish the words and send them), with a small dot left of ✕ fading in and out while the microphone
// listens, so a box already full of words still says the mic is on. Shown
// only once the person has turned dictation on (Settings › Voice); a person in
// any team without an OpenAI BAA sees the struck-through mic and the caret
// dimmed, and a click on either says why (the rule the server's mint applies,
// dictation.authForDictation; Settings › Voice says the same line). A start
// that failed shows the struck-through mic too (no colour needed: the
// grayscale tablet) named by its reason; useDictation says the reason once. The row keeps its width when
// blocked, and each target is 44px on a touch screen ([data-dictate-target],
// app/globals.css, where the dot sits inside ✕'s 44px).
// The behaviour lives in useDictation; this is only the buttons. Memoized: the
// controls and onMenuClosed a box passes are stable, so a keystroke in the box
// does not draw the mic again.
import { memo, useState, type MouseEvent, type ReactElement } from "react";
import { ChevronDown, Mic, MicOff, X } from "lucide-react";
import { toast } from "sonner";
import { DICTATION_LANGUAGES } from "@codecast/shared/contracts/dictation";
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
import { openAiBlock } from "../../lib/dictation/teamBlock";

/** "dock": the session composer's row buttons (expand, stash). "bare": the
 *  comment and chat box, beside its small square send. */
export type DictateSize = "dock" | "bare";

const BASE = "transition-colors flex items-center justify-center shrink-0";
const QUIET = "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg/50";

/** ✕: at the weight of the row's other secondary icons (stash, hand off,
 *  fork), so Send, or the bare box's send arrow, stays the strongest mark in
 *  the row, but with readable contrast (≥3:1) on the grayscale tablet rather
 *  than the row's 40% icon tint. */
const SECONDARY = "text-[var(--sol-text-dim)] hover:text-sol-text hover:bg-sol-bg/50";

const SIZES: Record<DictateSize, { button: string; caret: string; icon: string }> = {
  dock: { button: "w-7 h-7 rounded-full", caret: "w-4 h-7 rounded-full", icon: "w-3.5 h-3.5" },
  bare: { button: "w-6 h-6 rounded-md", caret: "w-4 h-6 rounded-md", icon: "w-3.5 h-3.5" },
};

const dictationOn = (s: { currentUser?: unknown }) => (s.currentUser as { dictation_enabled?: boolean } | null | undefined)?.dictation_enabled === true;

export const DictateControls = memo(function DictateControls(props: { dictation: DictationControls; size?: DictateSize; onMenuClosed?: () => void }) {
  const enabled = useInboxStore(dictationOn);
  // A recording outlives the switch going off mid-sentence: its ✕ stays.
  if (!enabled && !props.dictation.active) return null;
  return <DictateButtons {...props} />;
});

function DictateButtons({ dictation, size = "dock", onMenuClosed }: { dictation: DictationControls; size?: DictateSize; onMenuClosed?: () => void }) {
  const blocked = useInboxStore(openAiBlock);
  const sz = SIZES[size];
  // Keep the keyboard in the box: a press on these never takes focus from it.
  const keepFocus = (e: MouseEvent) => e.preventDefault();
  const tip = (button: ReactElement, label: string) => (
    <ShortcutTooltip label={label} side="top">
      {button}
    </ShortcutTooltip>
  );

  if (dictation.active) {
    return (
      // data-dictate-recording keeps the dot's room in every recording phase,
      // so the row does not move when the microphone opens.
      <div className="flex items-center gap-0.5" data-dictation={dictation.state.phase} data-dictate-recording>
        {dictation.state.phase === "listening" && <span data-dictate-live role="img" aria-label="Microphone on" />}
        {tip(
          <button type="button" data-dictate-target onMouseDown={keepFocus} onClick={() => dictation.cancel()} className={`${BASE} ${sz.button} ${SECONDARY}`} aria-label="Cancel dictation">
            <X className={sz.icon} />
          </button>,
          "Cancel dictation",
        )}
      </div>
    );
  }

  // A failed start keeps its reason on the struck mic until the next press. A
  // recording that stopped by itself said why in its toast; the mic is plain again.
  const failed = blocked ? null : dictation.state.error;
  const reason = blocked ?? failed;
  if (blocked) {
    // Blocked: the struck mic (its mark without colour; dimmed alone it read as
    // the row's other quiet icons) and the caret dimmed in its place, both
    // still pressable, and a press says why (a touch screen has no hover).
    // One toast however often it is pressed.
    const explain = () => toast.error(blocked, { id: "dictation-blocked", position: "top-center" });
    const dim = `${BASE} text-sol-text-dim/40 cursor-not-allowed`;
    return (
      <div className="flex items-center gap-0.5" data-dictation="idle" data-dictation-blocked>
        {tip(
          <button type="button" data-dictate-target onMouseDown={keepFocus} onClick={explain} aria-disabled data-dictation-reason={blocked} className={`${dim} ${sz.button}`} aria-label={blocked}>
            <MicOff className={sz.icon} />
          </button>,
          blocked,
        )}
        <button type="button" data-dictate-target onMouseDown={keepFocus} onClick={explain} aria-disabled className={`${dim} ${sz.caret}`} aria-label="Dictation settings">
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>
    );
  }
  const MicGlyph = failed ? MicOff : Mic;
  const mic = (
    <button
      type="button"
      data-dictate-target
      onMouseDown={keepFocus}
      onClick={() => dictation.start()}
      data-dictation-reason={reason ?? undefined}
      className={`${BASE} ${sz.button} ${failed ? "text-sol-red hover:bg-sol-red/10" : QUIET}`}
      aria-label={failed ?? "Dictate"}
    >
      <MicGlyph className={sz.icon} />
    </button>
  );
  return (
    <div className="flex items-center gap-0.5" data-dictation="idle">
      {tip(mic, reason ?? "Dictate")}
      <LanguageMenu caretClass={`${BASE} ${sz.caret} ${QUIET}`} onClosed={onMenuClosed} />
    </div>
  );
}

function LanguageMenu({ caretClass, onClosed }: { caretClass: string; onClosed?: () => void }) {
  const [choice, setChoice] = useState<string | null>(readDictationLanguage);
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setChoice(readDictationLanguage());
      }}
    >
      <ShortcutTooltip label="Dictation settings" side="top" held={open}>
        <DropdownMenuTrigger asChild>
          <button type="button" data-dictate-target className={caretClass} aria-label="Dictation settings">
            <ChevronDown className="w-3 h-3" />
          </button>
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent
        side="top"
        align="end"
        data-dictation-menu
        // Above a dialog's overlay (the create-task dialog is z-[10001]): the
        // menu is portalled to the body, out of the dialog's stacking.
        className="z-[10002] w-48 max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))]"
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
