import { useEffect, useRef } from "react";

/** Calls `done` once `ms` of real time has passed without a hold (a pointer
 *  resting on it), counting again from the start whenever `key` changes; a
 *  null key waits. Real time, so a throttled background tab still lets go,
 *  unless `untilSeen`: then the time counts only while the page is visible,
 *  so whoever was in another tab still gets to read it. */
export function useLinger(key: string | number | null, ms: number, done: () => void, untilSeen = false) {
  const held = useRef(false);
  const doneNow = useRef(done);
  doneNow.current = done;
  useEffect(() => {
    if (key === null) return;
    let left = ms;
    let last = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      if (!held.current && !(untilSeen && document.hidden)) left -= now - last;
      last = now;
      if (left <= 0) {
        clearInterval(tick);
        doneNow.current();
      }
    }, 100);
    return () => clearInterval(tick);
  }, [key, ms, untilSeen]);
  return { hold: (on: boolean) => void (held.current = on) };
}
