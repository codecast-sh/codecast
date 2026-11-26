// What a station's panel says it did on a run (FlowStationPanel): its state in words, and, for a report of the round
// the run is in, its outcome, note, the step it left for the person and the session that ran it. A station of an
// own-results round (the personal Ship) reads as its round's view says (personalRound.ts), as the journey, the diagram
// and the run report do: an earlier round's report is not this round's, so it says its state only. Pure.
import { stationResult } from "../ship/stationResult";
import { personalRound, type RoundState } from "../ship/personalRound";

type Entry = { node_id: string; status: string; outcome?: string; session_id?: string; result_preview?: string | null };
type Flow = Parameters<typeof personalRound>[0];
export type StationRun = { status: string; outcome: string | null; note: string | null; left: string | null; session: string | null };

/** A station's state in its round as the panel's run line keys it. */
const ROUND_STATUS: Record<RoundState, string> = { idle: "pending", running: "running", done: "completed", nothing: "nothing", back: "back", stopped: "failed", failed: "failed", unknown: "unknown" };

/** The panel's run line for a station on a run, or null when the run has nothing of it to say (not run, or not this round). */
export function stationRun(flow: Flow, id: string, run: { node_statuses?: ReadonlyArray<Entry> | null } & Record<string, any> | null | undefined): StationRun | null {
  if (!run) return null;
  const visits = run.node_statuses?.filter((n) => n.node_id === id) ?? [];
  const last = visits[visits.length - 1];
  const round = personalRound(flow, run as Parameters<typeof personalRound>[1]);
  if (round) {
    const result = last?.status === "completed" ? stationResult(last.result_preview) : null;
    const inRound = round.station(id);
    if (inRound.state === "idle") return null;
    const status = ROUND_STATUS[inRound.state];
    // Another round's report, or a station at work, says its state only.
    if (!round.ofRound(id) || !last || inRound.state === "running") return { status, outcome: null, note: null, left: null, session: inRound.state === "running" && round.ofRound(id) ? last?.session_id ?? null : null };
    // Its outcome is what its result says, never the runner's "success" for a station that exited 0 and failed.
    // A station that reported live on a run that ended short of Live, or that left the run, says what the end says.
    // One whose way out left the run stopped there; it did not fail.
    if (inRound.endSays) return { status: inRound.state === "stopped" ? "stopped" : status, outcome: inRound.endSays.end, note: inRound.endSays.why, left: result?.leftForYou ?? null, session: last.session_id ?? null };
    return { status, outcome: status !== "nothing" ? result?.outcome ?? null : null, note: inRound.note ?? result?.note ?? null, left: result?.leftForYou ?? null, session: last.session_id ?? null };
  }
  // Every other flow's station says how its last visit ran, as the runner reported it.
  if (!last) return null;
  return { status: last.status, outcome: last.outcome ?? null, note: null, left: null, session: last.session_id ?? null };
}
