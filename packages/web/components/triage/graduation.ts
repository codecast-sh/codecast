import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";

// The triage bar starts verbose: icon, word, and keycaps on every verb, so a
// new user can read the whole vocabulary at a glance. Once the KEYBOARD has
// proven it knows the verbs (the chords, not the buttons), the labels are
// dead weight — offer, once, to compact the bar to icons. The offer is a
// choice, never an automatic re-layout: chrome that rearranges itself
// unprompted reads as a bug.

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
  if (store.clientState.ui?.triage_bar_compact) return;
  if (store.clientState.ui?.inbox_shortcuts_hidden) return;

  store.updateClientTips({ completed: [...(tips?.completed ?? []), GRADUATION_TIP] });
  toast("You have the triage keys down", {
    description: "Compact the bar to icons? Expand it again any time from the bar.",
    duration: 12000,
    action: {
      label: "Compact",
      onClick: () => useInboxStore.getState().updateClientUI({ triage_bar_compact: true }),
    },
  });
}
