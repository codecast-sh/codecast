import { useStampNow } from "../lib/conversationFormat";

/**
 * A time as a view prints it ("3h", "Mar 4"), measured from the surface's
 * instant (useStampNow): the wall clock in the app, the fixtures' own instant
 * under a film, so a film's frames never depend on how long the page has been
 * open.
 */
export function StampTime({ ts, format }: { ts: number; format: (ts: number, now: number) => string }) {
  return <>{format(ts, useStampNow())}</>;
}
