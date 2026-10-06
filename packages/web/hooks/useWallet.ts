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

/** `feed` false reads the store without subscribing: an always-mounted
 *  surface (the shell's usage meter) feeds only in the sync host window, and
 *  followers read the wallet the host replicates to them. */
export function useWallet(feed = true): { wallet: WalletSummary | null; ready: boolean } {
  const { ready } = useSyncCollection("wallet", api.wallet.mine, feed ? {} : "skip");
  const stored = useInboxStore((s) => s.wallet);
  const anchor = stored?.period_anchor ?? null;
  const now = useNowWhen((t) => (anchor === null ? "" : String(periodAt(anchor, t).start)), PERIOD_CHECK_MS);
  const wallet = useMemo(() => (stored ? summaryAt(stored, now) : null), [stored, now]);
  return { wallet, ready };
}
