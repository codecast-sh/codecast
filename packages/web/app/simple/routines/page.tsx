// Routines: the things the assistant does on a schedule, each in a plain
// sentence with when it runs next, and pause and delete.
import { useState } from "react";
import { Link } from "react-router";
import { Clock } from "lucide-react";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useInboxStore } from "../../../store/inboxStore";
import { taskDisplayTitle, type TaskRow } from "../../../components/triggerTasks";
import { LANE_COPY, conversationPath, routineLastRun, routineSchedule } from "../../../components/simple/lane";
import { useLaneConversations, useLaneIds, useLaneRoutines } from "../../../components/simple/useLane";

const WORDS = LANE_COPY.routines;

function RoutineRow({ routine, now }: { routine: TaskRow; now: number }) {
  const [confirming, setConfirming] = useState(false);
  const store = useInboxStore.getState;
  const paused = routine.status === "paused";
  const last = routineLastRun(routine, now);
  return (
    <div className={`sl-routine${paused ? " is-paused" : ""}`}>
      <div className="sl-routine-title">{taskDisplayTitle(routine)}</div>
      <div className="sl-routine-when">
        <Clock size={14} aria-hidden />
        {routineSchedule(routine, now)}
      </div>
      {last ? <div className={`sl-routine-last${last.trouble ? " is-trouble" : ""}`}>{last.text}</div> : null}
      <div className="sl-routine-acts">
        {confirming ? (
          <>
            <span className="sl-muted" style={{ alignSelf: "center", padding: "0 0.5rem", fontSize: "0.9rem" }}>{WORDS.deleteAsk}</span>
            <button type="button" className="sl-btn is-danger is-small" onClick={() => store().deleteTrigger(routine._id)}>{WORDS.delete}</button>
            <button type="button" className="sl-btn is-no is-small" onClick={() => setConfirming(false)}>{WORDS.keep}</button>
          </>
        ) : (
          <>
            <button type="button" className="sl-btn is-no is-small" onClick={() => store().triggerAction(routine._id, paused ? "resume" : "pause")}>
              {paused ? WORDS.resume : WORDS.pause}
            </button>
            {routine.originating_conversation_id ? (
              <Link className="sl-btn is-no is-small" to={conversationPath(routine.originating_conversation_id)}>{WORDS.open}</Link>
            ) : null}
            <button type="button" className="sl-btn is-no is-small" onClick={() => setConfirming(true)}>{WORDS.delete}</button>
          </>
        )}
      </div>
    </div>
  );
}

export default function SimpleRoutines() {
  const now = useCoarseNow(60_000);
  const laneIds = useLaneIds(useLaneConversations());
  const { routines, ready } = useLaneRoutines(laneIds);
  return (
    <main>
      <h1 className="sl-page-title sl-rise">{WORDS.title}</h1>
      <p className="sl-lede sl-rise" style={{ ["--i" as any]: 1 }}>
        {WORDS.lede}
      </p>
      {routines.length === 0 ? (
        <div className="sl-empty sl-rise" style={{ ["--i" as any]: 2 }}>
          {ready ? WORDS.empty : WORDS.loading}
        </div>
      ) : (
        <div className="sl-list sl-rise" style={{ ["--i" as any]: 2 }}>
          {routines.map((r) => <RoutineRow key={r._id} routine={r} now={now} />)}
        </div>
      )}
    </main>
  );
}
