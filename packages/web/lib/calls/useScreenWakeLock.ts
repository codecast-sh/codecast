import { useWatchEffect } from "../../hooks/useWatchEffect";

// Keep the screen on while somebody is in a call.
//
// A phone on a desk in a call its owner is only listening to is idle as far
// as the phone can tell: remote video plays muted (the sound comes from
// separate audio elements), which does not hold the screen on iOS or Android,
// and a call with cameras off has no video at all. The screen locks, the page
// is suspended, the media drops. A screen wake lock is the browser's own
// answer. The browser releases it whenever the page is hidden, so it is asked
// for again each time the page comes back to the front.
//
// Store free, so the guest's page (which boots without the app) and a
// member's stage can hold the same lock the same way. A browser without the
// API, or one that refuses (low battery, a power saver), simply does not hold
// the screen: nothing here is worth telling anybody about.

type Sentinel = { release: () => Promise<void>; released: boolean };

export function useScreenWakeLock(active: boolean): void {
  useWatchEffect(() => {
    const wakeLock = typeof navigator === "undefined" ? undefined : (navigator as any).wakeLock;
    if (!active || !wakeLock?.request) return;
    let lock: Sentinel | null = null;
    let over = false;
    const hold = async () => {
      if (over || document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        const next: Sentinel = await wakeLock.request("screen");
        // Left the call while the browser was answering.
        if (over) void next.release().catch(() => {});
        else lock = next;
      } catch {}
    };
    void hold();
    document.addEventListener("visibilitychange", hold);
    return () => {
      over = true;
      document.removeEventListener("visibilitychange", hold);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
