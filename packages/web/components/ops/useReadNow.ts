// Read now on failing watches (metrics.readNow through the store): the press
// stays busy until every watch asked has an answer newer than the press (a
// value or another error lands on its row), or 30s pass.
import { useState } from "react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInboxStore } from "../../store/inboxStore";
import type { OpsWatch } from "./opsTypes";

const WAIT_MS = 30_000;

export function useReadNow(watches: readonly Pick<OpsWatch, "_id" | "updated_at">[]): { asking: boolean; readNow: () => void } {
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const now = useCoarseNow(askedAt === null ? 60_000 : 2_000);
  const answered = askedAt !== null && watches.every((w) => w.updated_at > askedAt);
  const asking = askedAt !== null && !answered && now - askedAt < WAIT_MS;
  const readNow = () => {
    if (!watches.length) return;
    setAskedAt(Date.now());
    useInboxStore.getState().readOpsWatchesNow(watches.map((w) => w._id));
  };
  return { asking, readNow };
}
