// The simple lane's home: one composer, then what needs you, what is
// happening and what is done.
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { CalendarClock } from "lucide-react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInboxStore } from "../../store/inboxStore";
import { ApprovalCard } from "../../components/simple/ApprovalCard";
import { Composer } from "../../components/simple/Composer";
import { ConversationRow } from "../../components/simple/ConversationRow";
import { ASKS, LANE_PATHS, conversationPath, greeting, homeBands, routineLastRun, routineSchedule, runsToday } from "../../components/simple/lane";
import { useLaneData, useLaneRoutines } from "../../components/simple/useLane";
import { useStartConversation } from "../../components/simple/startConversation";
import { taskDisplayTitle } from "../../components/triggerTasks";

const IDEAS = [ASKS.replies, ASKS.lunch, ASKS.morning];

const HOME_APPROVALS = 2;
const HOME_DONE = 6;

export default function SimpleHome() {
  const now = useCoarseNow(60_000);
  const name = useInboxStore((s) => (s.currentUser as any)?.name ?? null);
  const { conversations, laneIds, approvals, approvalCounts, titles, ready } = useLaneData();
  const { routines } = useLaneRoutines(laneIds);
  const bands = useMemo(() => homeBands(conversations, approvalCounts, now), [conversations, approvalCounts, now]);
  const today = useMemo(() => routines.filter((r) => runsToday(r, now)), [routines, now]);
  const start = useStartConversation();
  const navigate = useNavigate();
  const [seed, setSeed] = useState<{ text: string; at: number } | null>(null);
  const [allDone, setAllDone] = useState(false);

  const waitingRows = bands.waiting.filter((c) => !approvalCounts.get(String(c._id)));
  // First-run ideas only once the list is known to be empty; a cold cache
  // shows a quiet line instead of pretending there is nothing.
  const nothingYet = ready && conversations.length === 0;
  const loading = !ready && conversations.length === 0;
  let i = 0;

  return (
    <main>
      <h1 className="sl-hello sl-rise" style={{ ["--i" as any]: i++ }}>{greeting(now, name)}</h1>
      <p className="sl-lede sl-rise" style={{ ["--i" as any]: i++ }}>
        Hand me anything on your list. I'll check with you before I send an email or change your calendar.
      </p>
      <div className="sl-rise" style={{ ["--i" as any]: i++ }}>
        <Composer
          hero
          placeholder="What can I take off your plate?"
          seed={seed}
          onSend={(text) => navigate(conversationPath(start(text)))}
        />
        {nothingYet ? (
          <div className="sl-ideas">
            {IDEAS.map((idea) => (
              <button key={idea} type="button" className="sl-idea" onClick={() => setSeed({ text: idea, at: Date.now() })}>
                {idea}
              </button>
            ))}
          </div>
        ) : null}
        {loading ? <p className="sl-muted" style={{ margin: "1.2rem 0.2rem 0", fontSize: "0.9rem" }} role="status">Getting your conversations</p> : null}
      </div>

      {approvals.length > 0 || waitingRows.length > 0 ? (
        <section className="sl-section sl-rise" style={{ ["--i" as any]: i++ }} aria-label="Waiting on you">
          <h2 className="sl-section-head">
            Waiting on you <span className="sl-count">{approvals.length + waitingRows.length}</span>
            {approvals.length > HOME_APPROVALS ? <Link to={LANE_PATHS.approvals}>See all</Link> : null}
          </h2>
          <div style={{ display: "grid", gap: "0.85rem" }}>
            {approvals.slice(0, HOME_APPROVALS).map((d, n) => (
              <ApprovalCard key={d._id} decision={d} from={titles.get(String(d.conversation_id))} index={n} />
            ))}
            {waitingRows.length > 0 ? (
              <div className="sl-list">
                {waitingRows.map((row) => <ConversationRow key={row._id} row={row} state="waiting" now={now} />)}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {bands.working.length > 0 || today.length > 0 ? (
        <section className="sl-section sl-rise" style={{ ["--i" as any]: i++ }} aria-label="Happening now">
          <h2 className="sl-section-head">Happening now</h2>
          <div className="sl-list">
            {bands.working.map((row) => <ConversationRow key={row._id} row={row} state="working" now={now} />)}
            {today.map((r) => {
              const last = routineLastRun(r, now);
              return (
                <Link key={r._id} to={LANE_PATHS.routines} className="sl-row">
                  <CalendarClock size={16} className="sl-faint" aria-hidden />
                  <span className="sl-row-main">
                    <span className="sl-row-title" style={{ display: "block" }}>{taskDisplayTitle(r)}</span>
                    <span className="sl-row-sub" style={{ display: "block" }}>{routineSchedule(r, now)}</span>
                    {last?.trouble ? <span className="sl-row-sub is-trouble" style={{ display: "block" }}>{last.text}</span> : null}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      {bands.done.length > 0 ? (
        <section className="sl-section sl-rise" style={{ ["--i" as any]: i++ }} aria-label="Done lately">
          <h2 className="sl-section-head">
            Done lately <span className="sl-count">{bands.done.length}</span>
          </h2>
          <div className="sl-list">
            {(allDone ? bands.done : bands.done.slice(0, HOME_DONE)).map((row) => <ConversationRow key={row._id} row={row} state="done" now={now} />)}
          </div>
          {!allDone && bands.done.length > HOME_DONE ? (
            <button type="button" className="sl-btn is-no is-small" style={{ marginTop: "0.5rem" }} onClick={() => setAllDone(true)}>
              {`Show ${bands.done.length - HOME_DONE} more`}
            </button>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
