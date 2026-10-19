// When the person last pressed a key or typed, so background bulk work (a
// coalesced inbox apply re-places every session and wakes every subscriber)
// can wait for a pause instead of landing between two keystrokes. Listeners
// are passive and capture-phase, so they see every key before any handler and
// cost a timestamp. Where there is no DOM (the Expo app) nothing is recorded
// and nothing waits.
let lastInputAt = Number.NEGATIVE_INFINITY;

const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const note = () => { lastInputAt = clock(); };
  window.addEventListener("keydown", note, { capture: true, passive: true });
  window.addEventListener("input", note, { capture: true, passive: true });
}

/** Milliseconds until input has been quiet for `quietMs`; 0 when it already has. */
export function msUntilInputQuiet(quietMs: number): number {
  const since = clock() - lastInputAt;
  return since >= quietMs ? 0 : quietMs - since;
}

/** A pause in the keys this long reads as "not typing". */
export const TYPING_QUIET_MS = 400;

/**
 * Run `fn` once input has been quiet for TYPING_QUIET_MS, or at the latest
 * `maxDeferMs` from now; at once when nobody is typing. Returns a cancel.
 */
export function whenInputQuiet(fn: () => void, maxDeferMs: number): () => void {
  const deadline = Date.now() + maxDeferMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const attempt = () => {
    const wait = msUntilInputQuiet(TYPING_QUIET_MS);
    if (wait > 0 && Date.now() + wait <= deadline) {
      timer = setTimeout(attempt, wait);
      return;
    }
    timer = null;
    fn();
  };
  attempt();
  return () => { if (timer !== null) clearTimeout(timer); timer = null; };
}

/** For tests: record an input at this moment. */
export function noteInputForTests(): void {
  lastInputAt = clock();
}
