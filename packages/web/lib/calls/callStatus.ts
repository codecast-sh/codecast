/** Is anybody in this call now? A huddle's record stays live for a short
 *  grace after the room empties (transcripts.HUDDLE_GRACE_MS) so a rejoin
 *  carries on the same call; inside it the room is empty and the call reads
 *  as over until somebody is back. */
export function isCallLive(c: { status: string; idle_since?: number | null }): boolean {
  return c.status === "live" && !c.idle_since;
}
