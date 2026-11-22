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
import { repositoryOfRemote, sessionRemoteOf, sessionRootOf, useRepoFlows } from "../../../hooks/useRepoFlows";
import { appPool, linesFirst, type AppFlow } from "../../../lib/line/flowPool";
import { defaultFlowOf, takesSessionChange } from "@codecast/shared/contracts/flowPool";
import { asksBeforeLand, journeyOf, journeyStages, journeyWords, runIsLive, type Journey, type TargetState } from "../../../lib/ship/journey";
import { landedSha, reachShip, reachTargets } from "../../../lib/ship/sessionShip";
import { useDeployReach, type DeployReachRow } from "../../../hooks/useDeployReach";
import { shipLedgerFor } from "../../consequential/shipLedger";
import { pressFromSig, pressSig, runThroughMessage, type Press, type PressMsg } from "../../../lib/line/flowMessages";
import { sessionIdleAt } from "../../../lib/liveness";
import { formatElapsed } from "../../../lib/taskLine";
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

function usePress(conversationId: string, newestRunAt: number): Press | null {
  const sig = useInboxStore((s) => pressSig((s.messages as Record<string, PressMsg[]>)[conversationId] ?? [], newestRunAt));
  return useMemo(() => pressFromSig(sig), [sig]);
}

/** Whether the session has settled: its turn is over, so a press it answered without a run will not start one. Unknown is not settled. */
function useSettled(conversationId: string): boolean {
  // Settling can come from time alone (a heartbeat that stops), so the read follows a clock as well as the row.
  const now = useCoarseNow(15_000);
  return useInboxStore((s) => {
    const row = ((s as any).sessions?.[conversationId] ?? (s as any).conversations?.[conversationId]) as Parameters<typeof sessionIdleAt>[0] | undefined;
    return row ? sessionIdleAt(row, now) : false;
  });
}

/** The chip's words and tone for where the session's change is. The header has little room: a stop says only that it stopped. */
function chipOf(journey: Journey | null, reach: DeployReachRow | undefined, landed: boolean): { words: string; tone: string } {
  // A change on main with no deploy of its own to wait on reads where the deploy records put it, as its inbox card does.
  if (journey?.now.kind === "landed" && landed) return reach ? reachShip(reach) : { words: "Landed", tone: "ok" };
  const w = journeyWords(journey);
  return w.tone === "bad" ? { words: "Stopped", tone: "bad" } : w;
}

const openMessage = (conversationId: string, messageId: string) => useInboxStore.getState().requestNavigate(conversationId, { scrollToMessageId: messageId });

function ShipButton({ conversationId, sessionTitle }: { conversationId: string; sessionTitle: string }) {
  const [open, setOpen] = useState(false);
  // The flow under review: held here, so the review outlives the popover that picked it.
  const [reviewing, setReviewing] = useState<AppFlow | null>(null);
  // Picking a new flow after a run ended: the panel shows the picker instead of the last run.
  const [again, setAgain] = useState(false);
  const runs = useSessionFlowRuns(conversationId);
  const run = runs?.find(runIsLive) ?? runs?.[0] ?? null;
  const { flow: runFlow } = useRunFlow(run);
  // A change the run left on main: where the deploy records put it, on every target it touches.
  const landed = run ? landedSha(run) : null;
  const reach = useDeployReach(landed);
  const targets = useMemo(() => reachTargets(reach), [reach]);
  const journey = useMemo(() => (run && runFlow ? journeyOf(runFlow, run, targets) : null), [run, runFlow, targets]);
  const press = usePress(conversationId, run?.created_at ?? 0);
  const settled = useSettled(conversationId);
  const live = runIsLive(run);
  // A press the session answered and then settled without starting a run: it will not start one.
  const declined = !!press?.reply && settled && !live;
  const starting = !!press && !declined && !live;
  const chip = starting ? { words: "Starting", tone: "working" } : declined && !run ? { words: "Not run", tone: "idle" } : chipOf(journey, reach, !!landed);
  const send = (flow: AppFlow) => {
    setReviewing(null);
    setAgain(false);
    useInboxStore.getState().sendMessage(conversationId, runThroughMessage(flow));
  };
  const showRun = !!run && !!runFlow && !again && !starting;
  const notice = declined && press ? <PressNotice press={press} onRead={() => { setOpen(false); openMessage(conversationId, press.reply!.id); }} /> : null;
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
            <RunPanel run={run} flow={runFlow!} journey={journey!} targets={reach ? targets : undefined} notice={notice} onAgain={() => setAgain(true)} />
          ) : starting && !again ? (
            <Starting press={press!} onOpen={() => { setOpen(false); openMessage(conversationId, press!.id); }} />
          ) : (
            // Mounted only while open: the pool's feed is read when someone looks, never by every header.
            <>{again ? null : notice}<PoolPicker conversationId={conversationId} session={sessionTitle} onRun={(flow) => { setOpen(false); setReviewing(flow); }} /></>
          )}
        </PopoverContent>
      </Popover>
      {reviewing ? <SwitchReview ledger={shipLedgerFor(reviewing, sessionTitle)} onClose={() => setReviewing(null)} onConfirm={() => send(reviewing)} /> : null}
    </>
  );
}


/** A press the session has not answered with a run yet: how long ago it went, and the message itself a press away. */
function Starting({ press, onOpen }: { press: Press; onOpen: () => void }) {
  const now = useCoarseNow(press.at > Date.now() - 60_000 ? 1000 : 15_000);
  return (
    <div className="shp" data-ship-starting>
      <header className="shp-head">
        <b>Starting</b>
        <span className="shp-sub">asked {formatElapsed(press.at, now)} ago · no run yet</span>
        <button type="button" className="shp-link" onClick={onOpen} data-ship-press-open>Open message</button>
      </header>
    </div>
  );
}

/** A press the session answered without starting a run: when, its answer, and the answer itself a press away. */
function PressNotice({ press, onRead }: { press: Press; onRead: () => void }) {
  const now = useCoarseNow(15_000);
  return (
    <section className="shp-declined" data-ship-declined>
      <header><b>Not run</b><span>Ship pressed {formatElapsed(press.at, now)} ago</span><button type="button" className="shp-link" onClick={onRead} data-ship-reply-open>Read reply</button></header>
      <blockquote>{press.reply!.text}</blockquote>
    </section>
  );
}

/** The session's run: its journey, who acts now, and the person's controls on it. */
function RunPanel({ run, flow, journey, targets, notice, onAgain }: { run: any; flow: AppFlow; journey: Journey; targets?: TargetState[]; notice?: React.ReactNode; onAgain: () => void }) {
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
      {notice}
      <JourneyView journey={journey} run={run} now_ms={now} targets={targets} actions={
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

function PoolPicker({ conversationId, session, onRun }: { conversationId: string; session: string; onRun: (flow: AppFlow) => void }) {
  const workflows = usePoolFlowRows();
  const teamSlug = useTeamDefaultFlowSlug();
  // The session's checkout's own flows come first, as `cast flow run` takes them there.
  const remote = useInboxStore((s) => sessionRemoteOf(s as any, conversationId));
  const root = useInboxStore((s) => sessionRootOf(s as any, conversationId));
  const repoFlows = useRepoFlows(root, repositoryOfRemote(remote));
  const { pool, fallback } = useMemo(() => {
    // Flows only: a segment runs one part of a change, never the change to live.
    const all = linesFirst(appPool(workflows, repoFlows).filter((f) => f.kind === "line" && takesSessionChange(f)));
    const d = defaultFlowOf(all, teamSlug);
    return { pool: d ? [d, ...all.filter((f) => f !== d)] : all, fallback: d };
  }, [workflows, repoFlows, teamSlug]);
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
