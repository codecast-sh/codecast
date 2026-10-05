// Routines: the things the assistant does on a schedule, each in a plain
// sentence with when it runs next, and pause and delete.
import { useState } from "react";
import { Link } from "react-router";
import { Clock } from "lucide-react";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useInboxStore } from "../../../store/inboxStore";
import { lastRunHeadline, taskDisplayTitle, type TaskRow } from "../../../components/triggerTasks";
import { conversationPath, routineSchedule, whenSaid } from "../../../components/simple/lane";
import { useLaneConversations, useLaneIds, useLaneRoutines } from "../../../components/simple/useLane";

function RoutineRow({ routine, now }: { routine: TaskRow; now: number }) {
  const [confirming, setConfirming] = useState(false);
  const store = useInboxStore.getState;
  const paused = routine.status === "paused";
  const last = lastRunHeadline(routine);
  return (
    <div className={`sl-routine${paused ? " is-paused" : ""}`}>
      <div className="sl-routine-title">{taskDisplayTitle(routine)}</div>
      <div className="sl-routine-when">
        <Clock size={14} aria-hidden />
        {routineSchedule(routine, now)}
      </div>
      {last && routine.last_run_at ? (
        <div className="sl-routine-last">{`Last ran ${whenSaid(routine.last_run_at, now)}: ${last}`}</div>
      ) : null}
      <div className="sl-routine-acts">
        {confirming ? (
          <>
            <span className="sl-muted" style={{ alignSelf: "center", padding: "0 0.5rem", fontSize: "0.9rem" }}>Delete this routine?</span>
            <button type="button" className="sl-btn is-danger is-small" onClick={() => store().deleteTrigger(routine._id)}>Delete</button>
            <button type="button" className="sl-btn is-no is-small" onClick={() => setConfirming(false)}>Keep it</button>
          </>
        ) : (
          <>
            <button type="button" className="sl-btn is-no is-small" onClick={() => store().triggerAction(routine._id, paused ? "resume" : "pause")}>
              {paused ? "Turn back on" : "Pause"}
            </button>
            {routine.originating_conversation_id ? (
              <Link className="sl-btn is-no is-small" to={conversationPath(routine.originating_conversation_id)}>Open conversation</Link>
            ) : null}
            <button type="button" className="sl-btn is-no is-small" onClick={() => setConfirming(true)}>Delete</button>
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
      <h1 className="sl-page-title sl-rise">Routines</h1>
      <p className="sl-lede sl-rise" style={{ ["--i" as any]: 1 }}>
        Things I do for you on a schedule. To add one, just ask: "every weekday at 8, tidy my inbox".
      </p>
      {routines.length === 0 ? (
        <div className="sl-empty sl-rise" style={{ ["--i" as any]: 2 }}>
          {ready ? "No routines yet." : "Looking for your routines"}
        </div>
      ) : (
        <div className="sl-list sl-rise" style={{ ["--i" as any]: 2 }}>
          {routines.map((r) => <RoutineRow key={r._id} routine={r} now={now} />)}
        </div>
      )}
    </main>
  );
}
