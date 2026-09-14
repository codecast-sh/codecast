// The voice host reboots itself when it crashes.
//
// The shell's voice window is a headless host: hidden, or a strip or a few
// circles floating over somebody's work, with no chrome of its own for most
// of its life. A React boundary catching there paints "crashed, Retry" into a
// window nobody can see or click, and from then on every voice gesture in
// every other window forwards to a host that is not there — the float
// button, the walkie key and a huddle all go quietly dead until the app is
// restarted. Seen 2026-09-14 on the dev build: a Vite reload storm made the
// route's chunk import fail, the one automatic reload was already spent, and
// the host sat on the card for the rest of the day.
//
// So a boundary catch in that window is answered with a reload, not a card.
// Backed off, because a crash that returns on every boot (a code bug) would
// otherwise reload the window in a tight loop: the wait doubles with each
// crash that follows the last one closely, and resets once the host has run
// quietly for a while. React-free, so the arithmetic is pinned by a test.

/** A crash this long after the previous one starts the backoff over. */
export const VOICE_HOST_QUIET_MS = 5 * 60_000;
export const VOICE_HOST_RELOAD_MIN_MS = 3_000;
export const VOICE_HOST_RELOAD_MAX_MS = 60_000;

export type VoiceHostCrash = { count: number; at: number };

/** How long to wait before reloading, and the record to keep for next time. */
export function voiceHostReloadPlan(
  prev: VoiceHostCrash | null,
  now: number,
): { delayMs: number; next: VoiceHostCrash } {
  const count = prev && now - prev.at < VOICE_HOST_QUIET_MS ? prev.count + 1 : 0;
  const delayMs = Math.min(VOICE_HOST_RELOAD_MAX_MS, VOICE_HOST_RELOAD_MIN_MS * 2 ** count);
  return { delayMs, next: { count, at: now } };
}

const KEY = "voice_host_crash";

function readCrash(): VoiceHostCrash | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return typeof v?.count === "number" && typeof v?.at === "number" ? v : null;
  } catch {
    return null;
  }
}

let armed = false;

/** Schedule the reload. One per crash: a second boundary catching in the
 *  same broken render does not shorten or double the wait. */
export function scheduleVoiceHostReload(now = Date.now()): number | null {
  if (armed) return null;
  armed = true;
  const { delayMs, next } = voiceHostReloadPlan(readCrash(), now);
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // sessionStorage unavailable — the reload still happens, just unbacked.
  }
  setTimeout(() => window.location.reload(), delayMs);
  return delayMs;
}
