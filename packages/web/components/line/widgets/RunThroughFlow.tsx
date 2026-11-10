"use client";
// Ship on a session (docs/architecture/flows.md FL4, FL6): the session's change
// on its way to live. Before a run, the panel offers the team's flows (the
// team's default first and picked), each drawn as its stages with who acts at
// each, and Ship asks this session to send its own change through the one
// picked: the session is the run's subject, so what a stage finds comes back
// to it. While a run is in flight, or once one has ended, the chip says where
// the change is and the panel shows that run, with the person's part in it.
import { useMemo, useState } from "react";
import Link from "next/link";
import { Rocket } from "lucide-react";
import { useWorkspaceFeature } from "../../../lib/teamFeatures";
import { useInboxStore } from "../../../store/inboxStore";
import { usePoolFlowRows, useSessionFlowRuns, useTeamDefaultFlowSlug } from "../../../hooks/useSyncWorkflows";
import { useRunFlow } from "../../../hooks/useFlowObject";
import { appPool, defaultFlowOf, linesFirst, takesSessionChange, type AppFlow } from "../../../lib/line/flowPool";
import { flowAsks, flowDiagram } from "../../../lib/line/flowDiagram";
import { asksBeforeLand, journeyOf, journeyStages, journeyWords, runIsLive, type Journey } from "../../../lib/ship/journey";
import { flowRunLedger } from "../../consequential/ledgers";
import { isFlowPressMessage, runThroughMessage } from "../../../lib/line/flowMessages";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { JourneyView } from "../../ship/Journey";
import { HEADER_CHIP } from "../../../lib/headerChip";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import "../../ship/ship.css";

/** Shown only where the workspace has Flows on: off, the button is gone with the rest of the feature. */
export function RunThroughFlow(props: { conversationId: string; sessionTitle: string }) {
  return useWorkspaceFeature("line") ? <ShipButton {...props} /> : null;
}

/** The newest flow press this session was sent, when no run has started since: the run it asked for is starting. */
function useAskedAt(conversationId: string, newestRunAt: number): number | null {
  return useInboxStore((s) => {
    const msgs = (s.messages as Record<string, Array<{ role?: string; content?: string; timestamp?: number }>>)[conversationId] ?? [];
    for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 40; i--) {
      const m = msgs[i];
      if (m.role === "user" && typeof m.content === "string" && isFlowPressMessage(m.content)) return (m.timestamp ?? 0) > newestRunAt ? m.timestamp ?? null : null;
    }
    return null;
  });
}

/** The chip's words and tone for where the session's change is: a press asked for a run that has not started yet reads Starting. */
function chipOf(journey: Journey | null, asking: boolean): { words: string; tone: string } {
  if (asking && (!journey || !runIsLiveKind(journey))) return { words: "Starting", tone: "working" };
  const w = journeyWords(journey);
  // The header has little room: a stop says only that it stopped; the panel says where.
  return w.tone === "bad" ? { words: "Stopped", tone: "bad" } : w;
}
const runIsLiveKind = (j: Journey) => ["working", "starting", "session", "you"].includes(j.now.kind);

function ShipButton({ conversationId, sessionTitle }: { conversationId: string; sessionTitle: string }) {
  const [open, setOpen] = useState(false);
  // The flow under review: held here, so the review outlives the popover that picked it.
  const [reviewing, setReviewing] = useState<AppFlow | null>(null);
  // Picking a new flow after a run ended: the panel shows the picker instead of the last run.
  const [again, setAgain] = useState(false);
  const runs = useSessionFlowRuns(conversationId);
  const run = runs?.find(runIsLive) ?? runs?.[0] ?? null;
  const { flow: runFlow } = useRunFlow(run);
  const journey = useMemo(() => (run && runFlow ? journeyOf(runFlow, run) : null), [run, runFlow]);
  const askedAt = useAskedAt(conversationId, run?.created_at ?? 0);
  const chip = chipOf(journey, askedAt !== null);
  const send = (flow: AppFlow) => {
    setReviewing(null);
    setAgain(false);
    useInboxStore.getState().sendMessage(conversationId, runThroughMessage(flow));
  };
  const showRun = !!run && !!runFlow && !again && (runIsLive(run) || askedAt === null);
  return (
    <>
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setAgain(false); }}>
        <PopoverTrigger asChild>
          <button type="button" className={`cq-sq6 ${HEADER_CHIP} shp-chip`} data-tone={chip.tone} data-run-through data-ship-state={journey?.now.kind ?? "none"}>
            {chip.tone === "idle" ? <Rocket className="w-3 h-3" /> : <i className="shp-chip-dot" aria-hidden />}
            <span className="cq-sq2">{chip.words}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[600px] max-w-[calc(100vw-2rem)] p-0 border-sol-border bg-sol-bg overflow-hidden" data-run-through-pool>
          {showRun ? (
            <RunPanel run={run} flow={runFlow!} journey={journey!} onAgain={() => setAgain(true)} />
          ) : askedAt !== null && !again ? (
            <Starting at={askedAt} />
          ) : (
            // Mounted only while open: the pool's feed is read when someone looks, never by every header.
            <PoolPicker session={sessionTitle} onRun={(flow) => { setOpen(false); setReviewing(flow); }} />
          )}
        </PopoverContent>
      </Popover>
      {reviewing ? <SwitchReview ledger={ledgerFor(reviewing, sessionTitle)} onClose={() => setReviewing(null)} onConfirm={() => send(reviewing)} /> : null}
    </>
  );
}

function ledgerFor(flow: AppFlow, session: string) {
  const d = flowDiagram(flow);
  const stops = d.steps.flatMap((s) => [...s.side, ...s.inner.flatMap((i) => i.side)]).filter((r) => r.tone === "stop").map((r) => r.outcome);
  const stages = journeyStages(flow).filter((s) => s.id !== "live");
  return flowRunLedger({ flow: flow.label, session, stages, asks: flowAsks(flow), ends: [...new Set(stops)] });
}

function Starting({ at }: { at: number }) {
  const now = useCoarseNow(1000);
  return (
    <div className="shp" data-ship-starting>
      <header className="shp-head"><b>Starting</b><span className="shp-sub">this session is starting the run · {Math.max(0, Math.round((now - at) / 1000))}s</span></header>
    </div>
  );
}

/** The session's run: its journey, who acts now, and the person's controls on it. */
function RunPanel({ run, flow, journey, onAgain }: { run: any; flow: AppFlow; journey: Journey; onAgain: () => void }) {
  const now = useCoarseNow(15_000);
  const live = runIsLive(run);
  return (
    <div className="shp" data-ship-run={run._id}>
      <header className="shp-head">
        <b>{flow.label}</b>
        {run.task_short_id ? <Link className="shp-task" href={`/tasks/${run.task_short_id}`}>{run.task_short_id}</Link> : null}
        <span className="shp-sub">{run.task_title ?? ""}</span>
        <Link className="shp-link" href={`/workflows/runs/${run._id}`}>Open run</Link>
      </header>
      <JourneyView journey={journey} run={run} now_ms={now} actions={
        live
          ? <button type="button" className="sj-btn" data-quiet onClick={() => void useInboxStore.getState().stopLineRun(run._id)} data-flow-stop={run._id}>Stop</button>
          : journey.now.kind === "stopped" && journey.now.stage === "Deploy"
            // The change is on main; only its deploy failed, and Ship again would land it again. Its target is a press away in the bar.
            ? null
            : <button type="button" className="sj-btn" data-primary={journey.now.kind === "stopped" || journey.now.kind === "failed" ? "" : undefined} onClick={onAgain} data-ship-again>Ship again</button>
      } />
    </div>
  );
}

function PoolPicker({ session, onRun }: { session: string; onRun: (flow: AppFlow) => void }) {
  const workflows = usePoolFlowRows();
  const teamSlug = useTeamDefaultFlowSlug();
  const { pool, fallback } = useMemo(() => {
    // Flows only: a segment runs one part of a change, never the change to live.
    const all = linesFirst(appPool(workflows).filter((f) => f.kind === "line" && takesSessionChange(f)));
    const d = defaultFlowOf(all, teamSlug);
    return { pool: d ? [d, ...all.filter((f) => f !== d)] : all, fallback: d };
  }, [workflows, teamSlug]);
  const [picked, setPicked] = useState<string | null>(null);
  const flow = pool.find((f) => f.slug === picked) ?? fallback ?? pool[0];
  const journey = useMemo(() => (flow ? journeyOf(flow, null) : null), [flow]);
  if (!flow || !journey) return null;
  return (
    <div className="shp" data-ship-picker>
      <header className="shp-head"><b>Ship</b><span className="shp-session" title={session}>{session}</span></header>
      {pool.length > 1 ? (
        <ul className="shp-flows" role="listbox" aria-label="Flows">
          {pool.map((f) => (
            <li key={f.slug}>
              <button type="button" role="option" aria-selected={f.slug === flow.slug} className="shp-flow" onClick={() => setPicked(f.slug)} onDoubleClick={() => onRun(f)} data-run-through-flow={f.slug}>
                <i className="shp-radio" aria-hidden />
                <b>{f.label}{f === fallback ? <span className="shp-default" data-run-through-default="">Default</span> : f.base ? <span className="shp-base">on {f.base}</span> : null}</b>
                <span className="shp-path">
                  <span className="shp-asks" data-asks={asksBeforeLand(journeyStages(f)) ? "" : undefined}>{asksBeforeLand(journeyStages(f)) ? "You approve" : "No approval"}</span>
                  {journeyStages(f).map((s) => s.label).join(" → ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="shp-preview" data-flow={flow.slug}>
        <JourneyView journey={journey} now_ms={0} />
      </div>
      <footer className="shp-foot">
        <span className="shp-flowname">{pool.length > 1 ? null : <>{flow.label}{flow === fallback ? <span className="shp-default">Default</span> : null}</>}</span>
        <button type="button" className="sj-btn" data-primary onClick={() => onRun(flow)} data-run-through-go={flow.slug}>Ship</button>
      </footer>
    </div>
  );
}
