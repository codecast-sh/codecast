import { useState } from "react";
import { useWatchEffect } from "./useWatchEffect";

/** How long a read waits on a reconnecting daemon before saying so. */
export const FILE_STALL_MS = 4000;

/** True once `waiting` has held for FILE_STALL_MS for the same `key`; the
 *  second value starts the wait over (a Retry). */
export function useStalled(waiting: boolean, key: string): [boolean, () => void] {
  const [stalled, setStalled] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useWatchEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setStalled(key), FILE_STALL_MS);
    return () => clearTimeout(t);
  }, [waiting, key, attempt]);
  const retry = () => {
    setStalled(null);
    setAttempt((n) => n + 1);
  };
  return [waiting && stalled === key, retry];
}
