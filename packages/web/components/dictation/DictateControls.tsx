// The composer's mic, drawn the way Claude's composer draws it: a mic and a
// small caret for its settings while idle; Cancel (✕) and Finish (✓) while it
// records, with a small dot left of ✕ fading in and out while the microphone
// listens, so a box already full of words still says the mic is on. Shown
// only once the person has turned dictation on (Settings › Voice); a person in
// any team without an OpenAI BAA sees the mic and caret dimmed, as the phone
// draws them, and a click on either says why (the rule the server's mint
// applies, dictation.authForDictation). A start that failed shows the
// struck-through mic (no colour needed: the grayscale tablet) named by its
// reason; useDictation says the reason once. The row keeps its width when
// blocked, and each target is 44px on a touch screen ([data-dictate-target],
// app/globals.css, where the dot sits inside ✕'s 44px).
// The behaviour lives in useDictation; this is only the buttons. Memoized: the
// controls and onMenuClosed a box passes are stable, so a keystroke in the box
// does not draw the mic again.
import { memo, useState, type MouseEvent, type ReactElement } from "react";
import { Check, ChevronDown, Loader2, Mic, MicOff, X } from "lucide-react";
import { toast } from "sonner";
import { teamVendorBlock } from "@codecast/shared/contracts";
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

/** "dock": the session composer's row buttons (expand, stash). "bare": the
 *  comment and chat box, beside its small square send. */
export type DictateSize = "dock" | "bare";

const BASE = "transition-colors flex items-center justify-center shrink-0";
const QUIET = "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg/50";

/** `secondary`: ✕ and ✓. Beside the dock's filled Send they are QUIET like
 *  the row's other icons; beside the bare box's bare send arrow they are
 *  muted further, so the arrow stays the strongest mark in the row. */
const SIZES: Record<DictateSize, { button: string; caret: string; icon: string; secondary: string }> = {
  dock: { button: "w-7 h-7 rounded-full", caret: "w-4 h-7 rounded-full", icon: "w-3.5 h-3.5", secondary: QUIET },
  bare: { button: "w-6 h-6 rounded-md", caret: "w-4 h-6 rounded-md", icon: "w-3.5 h-3.5", secondary: "text-sol-text-dim/55 hover:text-sol-text hover:bg-sol-bg/50" },
};

const dictationOn = (s: { currentUser?: unknown }) => (s.currentUser as { dictation_enabled?: boolean } | null | undefined)?.dictation_enabled === true;

export const DictateControls = memo(function DictateControls(props: { dictation: DictationControls; size?: DictateSize; onMenuClosed?: () => void }) {
  const enabled = useInboxStore(dictationOn);
  // A recording outlives the switch going off mid-sentence: its ✕ and ✓ stay.
  if (!enabled && !props.dictation.active) return null;
  return <DictateButtons {...props} />;
});

/** The first of the person's teams that may not send speech to OpenAI, as the
 *  line the mic shows; the server refuses the mint for the same teams. */
const openAiBlock = (s: { teams?: unknown[] }): string | null => {
  for (const team of s.teams ?? []) {
    const t = team as { name?: string; policy?: unknown } | null;
    if (teamVendorBlock(t, "openai")) return `Dictation is off: ${t?.name || "your team"} has no BAA with OpenAI yet.`;
  }
  return null;
};

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
    const finishing = dictation.state.phase === "finishing";
    return (
      // data-dictate-recording keeps the dot's room in every recording phase,
      // so the row does not move when the microphone opens.
      <div className="flex items-center gap-0.5" data-dictation={dictation.state.phase} data-dictate-recording>
        {dictation.state.phase === "listening" && <span data-dictate-live role="img" aria-label="Microphone on" />}
        {tip(
          <button type="button" data-dictate-target onMouseDown={keepFocus} onClick={() => dictation.cancel()} className={`${BASE} ${sz.button} ${sz.secondary}`} aria-label="Cancel dictation">
            <X className={sz.icon} />
          </button>,
          "Cancel dictation",
        )}
        {tip(
          <button
            type="button"
            data-dictate-target
            onMouseDown={keepFocus}
            onClick={() => void dictation.finish()}
            disabled={finishing}
            aria-busy={finishing || undefined}
            // Quiet like ✕: Send stays the one primary in the row.
            className={`${BASE} ${sz.button} ${sz.secondary} disabled:cursor-wait`}
            aria-label="Finish dictation"
          >
            {finishing ? <Loader2 className={`${sz.icon} animate-spin`} /> : <Check className={sz.icon} />}
          </button>,
          finishing ? "Finishing…" : "Finish dictation",
        )}
      </div>
    );
  }

  // A failed start keeps its reason on the struck mic until the next press. A
  // recording that stopped by itself said why in its toast; the mic is plain again.
  const failed = blocked ? null : dictation.state.error;
  const reason = blocked ?? failed;
  if (blocked) {
    // Blocked, as the phone draws it: mic and caret dimmed, both still pressable,
    // and a press says why (a touch screen has no hover to show the tooltip).
    // One toast however often it is pressed.
    const explain = () => toast.error(blocked, { id: "dictation-blocked", position: "top-center" });
    const dim = `${BASE} text-sol-text-dim/40 cursor-not-allowed`;
    return (
      <div className="flex items-center gap-0.5" data-dictation="idle" data-dictation-blocked>
        {tip(
          <button type="button" data-dictate-target onMouseDown={keepFocus} onClick={explain} aria-disabled data-dictation-reason={blocked} className={`${dim} ${sz.button}`} aria-label={blocked}>
            <Mic className={sz.icon} />
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
