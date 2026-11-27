// The scribe engine's view of the agents a run feeds, shared by the web scribe
// (lib/calls/transcription) and the phone's (mobile lib/calls/phoneScribe), so
// both hold a busy agent's words the same way.
import { addressesAgent, agentSpokenNames, MID_TURN_AGENT_STATUSES } from "@codecast/shared/contracts";
import { agentStatusAt } from "../liveness";
import { characterFor } from "../sessionIdentity";
import { findSessionRow } from "./findSessionRow";
import type { ScribePacing } from "./scribeEngine";

/** The sessions a live transcript feeds, by route target: its session routes
 *  (transcripts.getLive `routes`). The server owns the list (anyone in the
 *  room may add one), so pacing follows agents that joined after the run began. */
export function feedTargetsOf(live: { routes?: Array<{ kind: string; target: unknown }> } | null | undefined): string[] {
  return (live?.routes ?? []).filter((r) => r.kind === "session").map((r) => String(r.target));
}

/** Read from the store at every tick: busy while EVERY fed agent is mid-turn
 *  (the server holds context for a busy agent, so the scribe need not ask it
 *  to), and whether a line names one of them — the same names the server's
 *  own gate matches. */
export function storePacing(feedTargets: () => readonly string[], getState: () => any): ScribePacing {
  return {
    busy() {
      const st = getState();
      const rows = feedTargets().map((t) => findSessionRow(st, t)).filter(Boolean);
      const now = Date.now();
      return rows.length > 0 && rows.every((row) => MID_TURN_AGENT_STATUSES.has(agentStatusAt(row, now) ?? ""));
    },
    addressed(text) {
      const st = getState();
      return feedTargets().some((t) => {
        const row = findSessionRow(st, t);
        if (!row) return false;
        return addressesAgent(text, agentSpokenNames({ name: characterFor(row).name, agentType: row.agent_type }));
      });
    },
  };
}
