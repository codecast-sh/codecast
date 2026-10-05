// The hosted assistant's wallet, store-fed: wallet.mine feeds the `wallet`
// singleton and the surface paints whatever the store holds (the cached
// summary first, then each live push). A period that ends while the screen is
// open writes nothing, so the query never re-runs for it; summaryAt applies
// the rollover here on a clock that re-renders only at a period boundary.
import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { periodAt, summaryAt, type WalletSummary } from "@codecast/convex/convex/lib/wallet";
import { useInboxStore } from "../store/inboxStore";
import { useNowWhen } from "./useCoarseNow";
import { useSyncCollection } from "./useSyncCollection";

const PERIOD_CHECK_MS = 60_000;

export function useWallet(): { wallet: WalletSummary | null; ready: boolean } {
  const { ready } = useSyncCollection("wallet", api.wallet.mine, {});
  const stored = useInboxStore((s) => s.wallet);
  const anchor = stored?.created_at ?? null;
  const now = useNowWhen((t) => (anchor === null ? "" : String(periodAt(anchor, t).start)), PERIOD_CHECK_MS);
  const wallet = useMemo(() => (stored ? summaryAt(stored, now) : null), [stored, now]);
  return { wallet, ready };
}
