// A hosted conversation's way of saying the link is down, beside the reply:
// the composer's status line and a bubble that has not gone yet say it from
// connectionChipCopy, as the header's sync chip does, so they never drift.
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
