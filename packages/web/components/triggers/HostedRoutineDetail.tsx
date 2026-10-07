"use client";

// A routine's own page in hosted mode (plan pl-840): what the person gets,
// when it runs, what came of each run, and the four things they can do with
// it. The developer trigger page (app/triggers/[id]/page.tsx) keeps its id
// chip, vitals, briefing and provenance; none of that means anything to
// someone who said yes to a reminder. The words are the list row's
// (TriggerRow PlainNextRun, hostedSchedule.ts), so the row and its page say
// a routine one way.

import { useState } from "react";
import { HOSTED_PAGE_FRAME, HOSTED_PAGE_PAD } from "../../lib/hostedPage";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { PageHeading } from "../PageHeading";
import { useInboxStore } from "../../store/inboxStore";
import { useModeWords } from "../../lib/surfaces";
import { useTriggerRuns, type TriggerRun } from "../TriggerRunHistory";
import { describeTaskCadence } from "../triggerCadence";
import { isTriggerEditable } from "../../lib/triggerEditable";
import { ARMED_STATUSES, routineSummaryForPerson, taskDisplayTitle, type TaskRow } from "../triggerTasks";
import { describeHostedCadence, plainNextRun } from "./hostedSchedule";

const VERB = "rounded-md px-2.5 py-1.5 text-[13px] text-sol-text-muted transition-colors hover:bg-sol-bg-alt hover:text-sol-text disabled:opacity-50";

/** When a run happened, as a person dates a message: "Today at 8:00 AM",
 *  "Sunday, Oct 4 at 6:00 PM". */
function runWhen(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date(now)) - startOf(d)) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })} at ${time}`;
}

function RunRow({ run, now }: { run: TriggerRun; now: number }) {
  const when = runWhen(run.created_at, now);
  if (run.kind === "skipped_precheck") {
    return <li className="py-2.5 text-[13px] text-sol-text-dim">{when}: skipped</li>;
  }
  const what = run.idle_summary?.trim() || run.title?.trim();
  return (
    <li>
      <Link href={`/conversation/${run._id}`} className="group flex items-baseline gap-3 py-2.5 no-underline">
        <span className="shrink-0 text-[13px] tabular-nums text-sol-text-dim">{when}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-sol-text group-hover:underline underline-offset-2">{what || "Open the result"}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 self-center text-sol-text-dim opacity-0 transition-opacity group-hover:opacity-100" />
      </Link>
    </li>
  );
}

export function HostedRoutineDetail({ task: t, now }: { task: TaskRow; now: number }) {
  const router = useRouter();
  const words = useModeWords();
  const triggerAction = useInboxStore((s) => s.triggerAction);
  const deleteTrigger = useInboxStore((s) => s.deleteTrigger);
  const runs = useTriggerRuns(t._id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showInstruction, setShowInstruction] = useState(false);

  const armed = ARMED_STATUSES.has(t.status);
  const paused = t.status === "paused";
  const summary = routineSummaryForPerson(t);
  const schedule = describeHostedCadence(t) ?? describeTaskCadence(t);
  const next = plainNextRun(t, now);
  const noun = words.trigger.toLowerCase();

  const remove = () => {
    deleteTrigger(t._id);
    toast(`${words.trigger} deleted`, { description: taskDisplayTitle(t) });
    router.push("/triggers");
  };

  return (
    <div className="h-full overflow-y-auto" data-main-scroll>
      <div className={`${HOSTED_PAGE_FRAME} ${HOSTED_PAGE_PAD} py-6`}>
        <Link href="/triggers" data-page-head className="inline-flex items-center gap-1 text-[13px] text-sol-text-dim no-underline transition-colors hover:text-sol-text">
          <ArrowLeft className="h-3.5 w-3.5" /> {words.triggers}
        </Link>

        <div className="mt-5" data-page-head>
          <PageHeading title={taskDisplayTitle(t)} />
          {summary && <p className="mt-2 text-[15px] leading-relaxed text-sol-text-muted">{summary}</p>}
          <p className="mt-3 text-[13px] text-sol-text-dim">
            {schedule}
            {paused ? " · Paused" : next ? ` · ${next}` : ""}
          </p>
        </div>

        {/* Quiet verbs in ink: the person's controls, not a dashboard's. */}
        <div className="-ml-2.5 mt-4 flex flex-wrap items-center gap-0.5">
          {armed && t.status !== "running" && (
            <button className={VERB} onClick={() => { triggerAction(t._id, "runNow"); toast("Running it now"); }}>Run now</button>
          )}
          {armed && (paused
            ? <button className={VERB} onClick={() => triggerAction(t._id, "resume")}>Resume</button>
            : <button className={VERB} onClick={() => triggerAction(t._id, "pause")}>Pause</button>)}
          {!armed && (
            <button className={VERB} onClick={() => { triggerAction(t._id, "reactivate"); toast(words.triggerRerun); }}>Run again</button>
          )}
          {isTriggerEditable(t.status) && (
            <Link href={`/triggers?task=${t._id}&edit=1`} className={`${VERB} no-underline`}>Edit</Link>
          )}
          {confirmDelete ? (
            <span className="inline-flex items-center gap-1 pl-1.5 text-[13px] text-sol-text-muted">
              Delete this {noun}?
              <button className={`${VERB} text-sol-red hover:text-sol-red`} onClick={remove}>Delete it</button>
              <button className={VERB} onClick={() => setConfirmDelete(false)}>Keep</button>
            </span>
          ) : (
            <button className={VERB} onClick={() => setConfirmDelete(true)}>Delete</button>
          )}
        </div>

        <section className="mt-8">
          <h2 className="text-[13px] font-medium text-sol-text">Results</h2>
          {runs === undefined ? (
            <p className="mt-2 text-[13px] text-sol-text-dim">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="mt-2 text-[13px] text-sol-text-dim">
              {next && !paused ? `Nothing yet. The first result arrives in your inbox ${next.replace(/^Next: /, "")}.` : "Nothing yet."}
            </p>
          ) : (
            <ul className="mt-1 divide-y divide-sol-border/40">
              {runs.map((run) => <RunRow key={run.run_key} run={run} now={now} />)}
            </ul>
          )}
        </section>

        {t.prompt?.trim() && (
          <section className="mt-8">
            <button
              aria-expanded={showInstruction}
              onClick={() => setShowInstruction((v) => !v)}
              className="inline-flex items-center gap-1 text-[13px] text-sol-text-dim transition-colors hover:text-sol-text"
            >
              <ChevronRight className={`h-3.5 w-3.5 transition-transform ${showInstruction ? "rotate-90" : ""}`} />
              What I do each time
            </button>
            {showInstruction && (
              <p className="mt-2 whitespace-pre-wrap pl-[18px] text-[13px] leading-relaxed text-sol-text-muted">{t.prompt.trim()}</p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
