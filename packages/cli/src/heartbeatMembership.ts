// Which sessions the daemon may stop heartbeating.
//
// A session joins the heartbeat set two ways. A resume, a spawn, an SDK or
// app-server bind, or a park puts it there because this daemon runs or holds
// it. A transcript sync puts it there because a process was found writing it.
// The second kind had no way out: the health sweep only looks at sessions with
// a pane, so a session whose process exited kept beating until the daemon
// restarted. One laptop beat 173 sessions with 39 live processes, a line host
// kept every finished hand reading live, and 64% of the fleet's heartbeat
// batches named sessions the server had no row for (2026-11-10).

export interface TranscriptBeatFacts {
  /** The daemon holds a pane for it (resume cache). */
  hasPane: (sessionId: string) => boolean;
  /** This daemon parked it; a parked session beats as hibernated. */
  parked: (sessionId: string) => boolean;
  /** The process its registry file names is still running. */
  processAlive: (sessionId: string) => boolean;
}

/** The transcript-added sessions with nothing left behind them. */
export function deadTranscriptBeats(transcriptAdded: Iterable<string>, facts: TranscriptBeatFacts): string[] {
  const dead: string[] = [];
  for (const id of transcriptAdded) {
    if (facts.hasPane(id) || facts.parked(id) || facts.processAlive(id)) continue;
    dead.push(id);
  }
  return dead;
}

/** How many flushes in a row the server must disown a session before the daemon stops beating it. */
export const UNKNOWN_BEAT_STRIKES = 3;

/**
 * The sessions to stop beating after one batch answer. The server lists the
 * ids it has no row for; a beat to one does nothing, so an id disowned
 * UNKNOWN_BEAT_STRIKES flushes running leaves the set. Several flushes, not
 * one: a session's first beat can land before its registration does.
 * `strikes` is the caller's memory between flushes; a known id is forgotten.
 */
export function strikeUnknownBeats(strikes: Map<string, number>, sent: readonly string[], unknown: readonly string[] | undefined, limit = UNKNOWN_BEAT_STRIKES): string[] {
  const disowned = new Set(unknown ?? []);
  const drop: string[] = [];
  for (const id of sent) {
    if (!disowned.has(id)) { strikes.delete(id); continue; }
    const count = (strikes.get(id) ?? 0) + 1;
    if (count >= limit) { strikes.delete(id); drop.push(id); }
    else strikes.set(id, count);
  }
  return drop;
}
