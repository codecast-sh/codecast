// The errand a newcomer picked on the marketing page (`/welcome?ask=`), kept
// in this tab's storage across sign-in until it is asked. /welcome leads with
// it; the hosted inbox's empty state puts it in its composer when /welcome
// could not ask it (thinking was down), so the pick is never lost.
import { WELCOME_ASK_PARAM } from "./lanePaths";

const CARRIED_ASK_KEY = "codecast-welcome-ask";
/** Longer than any ask the marketing page links, short enough to refuse a
 *  pasted essay in a crafted link. */
const CARRIED_ASK_MAX = 300;

export function keepCarriedAsk(ask: string | null) {
  const text = ask?.trim();
  if (!text || text.length > CARRIED_ASK_MAX) return;
  try { sessionStorage.setItem(CARRIED_ASK_KEY, text); } catch {}
}

/** The kept errand, or null. */
export function carriedAsk(): string | null {
  try { return sessionStorage.getItem(CARRIED_ASK_KEY); } catch { return null; }
}

/** The errand from `?ask=` or kept across sign-in, or null. Read once, when
 *  /welcome's Start shows. */
export function takeCarriedAsk(): string | null {
  keepCarriedAsk(new URLSearchParams(window.location.search).get(WELCOME_ASK_PARAM));
  return carriedAsk();
}

/** Forgotten once it has been asked. */
export function forgetCarriedAsk() {
  try { sessionStorage.removeItem(CARRIED_ASK_KEY); } catch {}
}
