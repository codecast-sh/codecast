// A personal Ship's stages on a run (ownRound.ts), as journeyOf reads them: each stage, branch and step is its station as
// its round's view says (personalRound.ts), the one view the diagram, a station's panel and the run report read too.
// Every other flow's stages read as their steps ran (journey.ts). Pure, with relative imports only: the phone reads it
// through the journey.
import { noteOf, type RoundView } from "./personalRound";
import { leftWords, stationResult } from "./stationResult";
import type { JourneyStage, StageState, StageStep } from "./journey";

type Status = { node_id: string; status: string; result_preview?: string | null; started_at?: number };
type Stage = { id: string; members: string[]; head?: string[]; tail?: string[] };
/** What journeyOf already reads of the run. */
type Reads<S extends Status, B extends Stage> = {
  statuses: ReadonlyArray<S>;
  statusOf: (id: string) => S | undefined;
  newest: (list: S[]) => S | undefined;
  inStage: (b: B, id: string) => boolean;
  latestOf: (b: B) => S | undefined;
  live: boolean;
  passed: boolean;
  paused: boolean;
};

/** How the step that posts a station's step left for the person says it. */
const LEFT_PREFIX = leftWords("");
const skippedResult = (preview: string | null | undefined) => { const r = stationResult(preview); return r?.outcome === "skipped" && !r.leftForYou; };
/** A branch as its station's round says. */
const BRANCH: Record<string, StageState> = { idle: "idle", running: "active", done: "done", nothing: "nothing", back: "back", stopped: "stopped", failed: "stopped", unknown: "unknown" };
/** A stage of its own (Deploy) between its reports: as its station's round says. */
const STAGE: Record<string, StageState> = { idle: "idle", running: "active", done: "done", nothing: "nothing", back: "back", stopped: "stopped", failed: "routed", unknown: "unknown" };

export function personalStages<S extends Status, B extends Stage>(view: RoundView, { statuses, statusOf, newest, inStage, latestOf, live, passed, paused }: Reads<S, B>) {
  // What a stage reported when it finished (stationResult.ts): its newest finished step of this round with a result, so
  // bookkeeping folded in after it (the step that posts what Deploy left for the person) does not hide it.
  const resultOf = (b: B) => {
    const last = newest(statuses.filter((n) => inStage(b, n.node_id) && n.status === "completed" && !!stationResult(n.result_preview) && view.ofRound(n.node_id)));
    return last ? stationResult(last.result_preview) : null;
  };
  const ranEmpty = (b: B) => { const r = resultOf(b); return latestOf(b)?.status === "completed" && r?.outcome === "skipped" && !r.leftForYou; };
  return {
    ranEmpty,
    /** A stage's state: its station's in this round. One the round has not reached is stopped where the run stopped. */
    stage(b: B, stopStage: string | null): StageState {
      const v = view.station(b.id).state;
      if (v === "idle") return b.id === stopStage ? "stopped" : passed ? "skipped" : "idle";
      return v === "running" && paused ? "waiting" : STAGE[v];
    },
    branch(br: B): StageState {
      const state = BRANCH[view.station(latestOf(br)?.node_id ?? br.members[br.members.length - 1]).state];
      return state === "active" && !live ? "idle" : state;
    },
    /**
     * A stage's steps: a step of an earlier round is marked so and says nothing of it; one that found work or failed is
     * marked failed, as it is, and one done (a Land that pushed before the run stopped) completed; one that found nothing
     * to do is skipped. Bookkeeping says nothing a person reads: the JSON a round opens with, or the words the stage's
     * own step already said.
     */
    steps(b: B, steps: StageStep[]): StageStep[] {
      const noteOfStep = (st: StageStep) => stationResult(statusOf(st.id)?.result_preview)?.note ?? st.said;
      const noted = new Set(statuses.filter((n) => !!stationResult(n.result_preview)?.note).map((n) => n.node_id));
      const quiet = (st: StageStep) => (!!b.head?.includes(st.id) && !!st.said?.startsWith("{"))
        || (!!b.tail?.includes(st.id) && noted.has(st.id) && steps.some((o) => o !== st && !b.tail!.includes(o.id) && !!noteOfStep(o) && noteOfStep(o) === noteOfStep(st)));
      return steps.map((st) => {
        const skipped = st.status === "completed" && skippedResult(statusOf(st.id)?.result_preview) ? { skipped: true } : {};
        if (!view.ofRound(st.id) && view.station(st.id).state !== "done") return { ...st, ...skipped, said: null, earlier: true };
        const { state, endSays } = view.station(st.id);
        const said = quiet(st) ? null : endSays ? endSays.why : noteOf({ result_preview: statusOf(st.id)?.result_preview }) ?? noteOfStep(st);
        return { ...st, ...skipped, said, ...(["back", "failed", "stopped"].includes(state) ? { status: "failed" } : state === "done" ? { status: "completed" } : {}) };
      });
    },
    /**
     * A stage as it ran: a finished stage whose result says it found nothing to do reads `nothing`; one that left the
     * person a step reads done, with it, in the words of the step that posted it, whole, where one did (a result's JSON
     * may be cut short). A stage this round has not reached carries nothing of an earlier round. A Deploy that reported
     * live on a run that ended short of Live says what the end says.
     */
    ranAs(b: B, state: StageState): Pick<JourneyStage, "state" | "note" | "left"> {
      const r = state === "idle" ? null : resultOf(b);
      if (!r) return { state };
      const finished = state === "done" || state === "nothing";
      const posted = newest(statuses.filter((n) => inStage(b, n.node_id) && n.status === "completed" && !!n.result_preview?.startsWith(LEFT_PREFIX)));
      const left = r.leftForYou ? posted?.result_preview!.slice(LEFT_PREFIX.length).trim() || r.leftForYou : null;
      const endSays = b.members.map((m) => view.station(m).endSays).find(Boolean);
      return { state: finished ? (ranEmpty(b) ? "nothing" : "done") : state, note: endSays ? endSays.why : r.note, left: finished ? left : null };
    },
  };
}
