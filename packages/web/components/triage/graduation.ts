import { toast } from "sonner";
import { useInboxStore, type ClientUI } from "../../store/inboxStore";

/**
 * Whether the bar is hidden to a corner button. Legacy `inbox_shortcuts_hidden`
 * (the old hint strip's dismissal, which nothing can unset anymore) maps here
 * — the user said no to the teaching chrome. Their own compact toggle, once
 * touched, wins outright. ONE derivation, shared by the bar and the graduation
 * offer, so the two can never disagree about it.
 */
export function isTriageBarCompact(ui: ClientUI | undefined): boolean {
  return ui?.triage_bar_compact ?? ui?.inbox_shortcuts_hidden ?? false;
}

/** The one writer of the compact pref: the bar's own "Hide this bar", the
 *  graduation offer, and the palette's "Show/hide triage bar" all call it. */
export function toggleTriageBarCompact() {
  const store = useInboxStore.getState();
  store.updateClientUI({ triage_bar_compact: !isTriageBarCompact(store.clientState.ui) });
}

// The triage bar starts as a quiet row of verbs under the composer. Once the
// KEYBOARD has proven it knows them (the chords, not the buttons), the row is
// dead weight — offer, once, to hide it. The offer is a choice, never an
// automatic re-layout: chrome that rearranges itself unprompted reads as a
// bug.

const COUNT_KEY = "cc-triage-key-uses";
const GRADUATION_TIP = "triage-fluent";
const THRESHOLD = 12;

export function noteTriageKeyUse() {
  if (typeof window === "undefined") return;
  let count = 0;
  try {
    count = (parseInt(localStorage.getItem(COUNT_KEY) ?? "0", 10) || 0) + 1;
    localStorage.setItem(COUNT_KEY, String(count));
  } catch {
    return;
  }
  if (count < THRESHOLD) return;

  const store = useInboxStore.getState();
  if (!store.clientStateInitialized) return;
  const tips = store.clientState.tips;
  if (tips?.level === "none") return;
  // Offered once, ever, across devices (completed syncs as a set union).
  if (tips?.completed?.includes(GRADUATION_TIP)) return;
  if (isTriageBarCompact(store.clientState.ui)) return;

  store.updateClientTips({ completed: [...(tips?.completed ?? []), GRADUATION_TIP] });
  toast("You have the triage keys down", {
    description: "Hide the bar? \"Show triage bar\" in the command palette brings it back.",
    duration: 12000,
    action: {
      label: "Hide",
      onClick: () => useInboxStore.getState().updateClientUI({ triage_bar_compact: true }),
    },
  });
}
