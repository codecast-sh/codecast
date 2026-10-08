// Hosted mode's one way of saying the link is down. The developer header's
// sync chip carries this state there; hosted desktop has no header, so the
// composer's status line, a bubble that has not gone yet, and the sidebar's
// foot say it here, all from connectionChipCopy, so the three never drift.
import { connectionChipCopy, useAppOffline, type ConnectionChipCopy } from "../../hooks/useAppOffline";

/** The sentence for a dropped link: with a message waiting to go, what will
 *  happen to it; otherwise just the state. */
export function hostedConnectionWords(copy: ConnectionChipCopy, sending: boolean): string {
  if (sending) return "Waiting for a connection. This sends when you're back online.";
  return copy.label === "Offline" ? "You're offline" : "Reconnecting…";
}

/** Live: the link's copy while it is down, else null. */
export function useHostedConnection(): ConnectionChipCopy | null {
  return connectionChipCopy(useAppOffline());
}

/** The sidebar foot's line while the link is down; nothing while it is up. */
export function HostedConnectionFoot() {
  const copy = useHostedConnection();
  if (!copy) return null;
  return (
    <span data-cc-connection-foot role="status" title={copy.detail} className="flex min-w-0 items-center gap-1.5 px-3 pb-1 text-[11.5px] text-sol-text-muted">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sol-text-dim" />
      <span className="truncate">{hostedConnectionWords(copy, false)}</span>
    </span>
  );
}
