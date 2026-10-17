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

/** For tests: record an input at this moment. */
export function noteInputForTests(): void {
  lastInputAt = clock();
}
