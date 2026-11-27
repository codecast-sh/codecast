import { useState } from "react";

const CLOSED_BUCKETS = { stashed: false, dismissed: false };
export type HiddenBucketsOpen = typeof CLOSED_BUCKETS;

/**
 * Open state of the sidebar's Stashed / Closed buckets. Ephemeral and
 * CLOSED by default: closed on every load, and re-closed whenever `filterKey`
 * (the chip filter's value) changes. Callers pass the filter's VALUE, never a
 * function's identity: the panel's filter callback turns over on every
 * placement tick, and keying on it shut an open bucket under the reader every
 * few seconds.
 */
export function useHiddenBucketsOpen(filterKey: string) {
  const [open, setOpen] = useState<HiddenBucketsOpen>(CLOSED_BUCKETS);
  const [seenKey, setSeenKey] = useState(filterKey);
  if (seenKey !== filterKey) {
    setSeenKey(filterKey);
    setOpen(CLOSED_BUCKETS);
  }
  return [open, setOpen] as const;
}
