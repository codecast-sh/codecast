import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { formatSize } from "../../lib/repoView";

type PeerTransfer = {
  phase: "asking" | "receiving" | "unpacking" | "done" | "failed";
  from?: string;
  mode?: "direct" | "relay";
  bytes?: number;
  total?: number;
  reason?: string;
  started_at: number;
  updated_at: number;
  cancel_requested_at?: number;
};

// The daemon repeats its last report every few seconds; a row this old has no
// daemon behind it, and its Cancel would never be read.
export const PEER_TRANSFER_STALE_MS = 30_000;

// A session folder on its way from another of the owner's machines
// (conversations.peer_transfer, written by the daemon about once a second).
export function PeerTransferStrip({ conversationId, onRetry }: { conversationId: string; onRetry: () => void }) {
  const s = useTrackedStore([
    (st) => (st.conversations[conversationId] as any)?.peer_transfer,
    (st) => st.peerTransferCancels[conversationId],
  ]);
  const pt = (s.conversations[conversationId] as any)?.peer_transfer as PeerTransfer | null | undefined;
  const live = !!pt && pt.phase !== "done" && pt.phase !== "failed";
  const now = useNowWhen((t) => (live && t - pt!.updated_at > PEER_TRANSFER_STALE_MS ? "stalled" : ""), 5_000);
  if (!pt || pt.phase === "done") return null;
  const stalled = live && now - pt.updated_at > PEER_TRANSFER_STALE_MS;
  const failed = pt.phase === "failed" || stalled;
  const cancelling = !failed && (!!pt.cancel_requested_at || s.peerTransferCancels[conversationId] === pt.started_at);
  const label = stalled ? "Transfer stopped"
    : failed ? "Fetch failed"
    : cancelling ? "Cancelling"
    : pt.phase === "asking" ? "Asking your machines"
    : pt.phase === "unpacking" ? "Unpacking"
    : `Receiving from ${pt.from ?? "another machine"}`;
  const receiving = pt.phase === "receiving" && !failed && !cancelling;
  const showBar = receiving && pt.bytes !== undefined && !!pt.total;
  const pct = showBar ? Math.min(100, Math.round((pt.bytes! / pt.total!) * 100)) : 0;
  const size = receiving && pt.total ? (pt.bytes !== undefined ? `${formatSize(pt.bytes)} of ${formatSize(pt.total)}` : formatSize(pt.total)) : null;
  const store = useInboxStore.getState;
  return (
    <div data-peer-transfer={stalled ? "stalled" : cancelling ? "cancelling" : pt.phase} className={`flex items-center gap-2 px-4 py-1.5 text-[12px] ${failed ? "bg-sol-red/10 text-sol-red" : "bg-sol-orange/10 text-sol-orange"}`}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${failed ? "bg-sol-red" : "bg-sol-orange animate-pulse"}`} />
      <span className="shrink-0">{label}</span>
      {pt.phase === "failed" && pt.reason && <span className="min-w-0 truncate opacity-70" title={pt.reason}>{pt.reason}</span>}
      {!failed && pt.mode && (
        <span className="shrink-0 rounded border border-sol-orange/40 px-1 text-[10px] uppercase tracking-wide opacity-80">{pt.mode === "direct" ? "Direct" : "Relay"}</span>
      )}
      {showBar && (
        <span role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="flex-1 h-1.5 min-w-[60px] max-w-[160px] bg-sol-border/30 rounded-full overflow-hidden">
          <span className="block h-full bg-sol-orange" style={{ width: `${pct}%` }} />
        </span>
      )}
      {size && <span className="shrink-0 tabular-nums opacity-70">{size}</span>}
      {failed ? (
        <span className="shrink-0 ml-auto flex items-center gap-3">
          <button type="button" onClick={() => { store().dismissPeerTransfer(conversationId, pt.started_at); onRetry(); }} className="font-medium hover:underline">Try again</button>
          <button type="button" onClick={() => store().dismissPeerTransfer(conversationId, pt.started_at)} className="font-medium opacity-70 hover:underline">Dismiss</button>
        </span>
      ) : !cancelling && (
        <button type="button" onClick={() => store().cancelPeerTransfer(conversationId, pt.started_at)} className="shrink-0 ml-auto font-medium hover:underline">Cancel</button>
      )}
    </div>
  );
}
