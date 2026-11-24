"use client";
// Ship on a session (docs/architecture/flows.md FL4, FL6): the session's change
// on its way to live. Before a run, the panel offers the team's flows (the
// team's default first and picked), each drawn as its stages with who acts at
// each, and Ship asks this session to send its own change through the one
// picked: the session is the run's subject, so what a stage finds comes back
// to it. While a run is in flight, or once one has ended, the chip says where
// the change is and the panel shows that run, with the person's part in it.
import { createContext, useContext, useMemo, useState } from "react";
import Link from "next/link";
import { Rocket, X } from "lucide-react";
import { useWorkspaceFeature } from "../../../lib/teamFeatures";
import { useInboxStore } from "../../../store/inboxStore";
import { usePoolFlowRows, useSessionFlowRuns, useTeamDefaultFlowSlug } from "../../../hooks/useSyncWorkflows";
import { useRunFlow } from "../../../hooks/useFlowObject";
import { repositoryOfRemote, sessionRemoteOf, sessionRootOf, sessionWorkspaceOf, useRepoFlows } from "../../../hooks/useRepoFlows";
import { appPool, linesFirst, namedForRepo, type AppFlow } from "../../../lib/line/flowPool";
import { defaultFlowOf, takesSessionChange } from "@codecast/shared/contracts/flowPool";
import { approvalOf, approvalWords, journeyOf, journeyStages, journeyWords, runIsLive, type Journey, type TargetState } from "../../../lib/ship/journey";
import { landedSha, reachShip, reachTargets } from "../../../lib/ship/sessionShip";
import { useDeployReach, type DeployReachRow } from "../../../hooks/useDeployReach";
import { shipLedgerFor } from "../../consequential/shipLedger";
import { pressFromSig, pressSig, runThroughMessage, type Press, type PressMsg } from "../../../lib/line/flowMessages";
import { sessionIdleAt } from "../../../lib/liveness";
import { formatElapsed } from "../../../lib/taskLine";
import { toolRowKind } from "../../../lib/modernRow";
import { recordedIds } from "../../../lib/ship/runRecord";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "../../ui/sheet";
import { BELOW_SM, useMediaQuery } from "../../../hooks/useIsPhone";
import { JourneyView } from "../../ship/Journey";
import { HEADER_CHIP } from "../../../lib/headerChip";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useJourneyViewer } from "../../../hooks/useJourneyViewer";
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
  const phone = useMediaQuery(BELOW_SM);
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
  const viewer = useJourneyViewer(run);
  const journey = useMemo(() => (run && runFlow ? journeyOf(runFlow, run, targets, viewer) : null), [run, runFlow, targets, viewer]);
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
  const onOpenChange = (o: boolean) => { setOpen(o); if (!o) setAgain(false); };
  // The chip stays in the header at every width (the squeeze sheds its words, never the chip): Ship is one press away.
  const trigger = (
    <button type="button" className={`${HEADER_CHIP} shp-chip`} aria-label={chip.words} title={chip.words} data-tone={chip.tone} data-run-through data-ship-state={journey?.now.kind ?? "none"}>
      {chip.tone === "idle" ? <Rocket className="w-3 h-3" /> : <i className="shp-chip-dot" aria-hidden />}
      <span className="cq-sq2">{chip.words}</span>
    </button>
  );
  const panel = showRun ? (
    <RunPanel conversationId={conversationId} run={run} flow={runFlow!} journey={journey!} targets={reach ? targets : undefined} notice={notice} onAgain={() => setAgain(true)} />
  ) : starting && !again ? (
    <Starting press={press!} onOpen={() => { setOpen(false); openMessage(conversationId, press!.id); }} />
  ) : (
    // Mounted only while open: the pool's feed is read when someone looks, never by every header.
    <>{again ? null : notice}<PoolPicker conversationId={conversationId} session={sessionTitle} onRun={(flow) => { setOpen(false); setReviewing(flow); }} /></>
  );
  return (
    <>
      {phone ? (
        // A phone opens it as a sheet from the bottom, the width of the screen.
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent side="bottom" hideClose aria-describedby={undefined} className="p-0 border-sol-border bg-sol-bg shp-sheet" data-run-through-pool>
            <SheetTitle className="sr-only">Ship</SheetTitle>
            <InSheet.Provider value={true}>{panel}</InSheet.Provider>
          </SheetContent>
        </Sheet>
      ) : (
        <Popover open={open} onOpenChange={onOpenChange}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent align="end" className="w-[600px] max-w-[calc(100vw-2rem)] p-0 border-sol-border bg-sol-bg overflow-hidden" data-run-through-pool>
            {panel}
          </PopoverContent>
        </Popover>
      )}
      {reviewing ? <SwitchReview ledger={shipLedgerFor(reviewing, sessionTitle)} onClose={() => setReviewing(null)} onConfirm={() => send(reviewing)} /> : null}
    </>
  );
}

/** Whether the panel is in the phone's sheet, which has no corner close of its own: each panel's head carries one. */
const InSheet = createContext(false);
function SheetCloser() {
  return useContext(InSheet) ? (
    <SheetClose className="shp-close" aria-label="Close Ship"><X className="w-4 h-4" aria-hidden /></SheetClose>
  ) : null;
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
        <SheetCloser />
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

/** Where a run leaves its change on main: shipping again takes whatever the checkout holds now, not that change. */
const LANDED_NOW = new Set<Journey["now"]["kind"]>(["landed", "deploying", "live", "merged"]);

/** Whether the session edited a file after `since` outside the `except` windows: an edit or write call among its loaded messages, newest first. */
function useEditedSince(conversationId: string, since: number | null, except: ReadonlyArray<readonly [number, number]>): boolean {
  // The conversation's own list: it changes only when its messages do, never on another row's heartbeat.
  const msgs = useInboxStore((s) => (s.messages as Record<string, Array<{ timestamp: number; tool_calls?: Array<{ name?: string }> }>>)[conversationId]);
  const windows = except.map(([from, to]) => `${from}-${to}`).join(",");
  return useMemo(() => {
    if (!since || !msgs) return false;
    for (let i = msgs.length - 1; i >= 0 && msgs[i].timestamp > since; i--) {
      const t = msgs[i].timestamp;
      if (except.some(([from, to]) => t >= from && t <= to)) continue;
      if (msgs[i].tool_calls?.some((c) => { const kind = toolRowKind(String(c?.name ?? "")); return kind === "edit" || kind === "write"; })) return true;
    }
    return false;
    // `except` is read through `windows`, its value, so a fresh array each render does not rescan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs, since, windows]);
}

/** The session's run: its journey, who acts now, and the person's controls on it. */
function RunPanel({ conversationId, run, flow, journey, targets, notice, onAgain }: { conversationId: string; run: any; flow: AppFlow; journey: Journey; targets?: TargetState[]; notice?: React.ReactNode; onAgain: () => void }) {
  const now = useCoarseNow(15_000);
  const live = runIsLive(run);
  const stop = journey.now.kind === "stopped" || journey.now.kind === "failed" ? journey.now : null;
  // A run that landed its change offers another only once the session has edited something the run did not take: since
  // it started, outside the session's own fix rounds, whose edits went out with it.
  // A step's id as journeyOf reads it: a run of an older version of the flow may have named it otherwise.
  const idOf = recordedIds(flow, run);
  const fixing = (run.node_statuses ?? [])
    .filter((n: { node_id: string }) => flow.nodes.some((x) => x.id === idOf(n.node_id) && x.backend === "subject"))
    .map((n: { started_at?: number; completed_at?: number }) => [n.started_at ?? 0, n.completed_at ?? Infinity] as const);
  const edited = useEditedSince(conversationId, live ? null : run.created_at ?? null, fixing);
  const spent = LANDED_NOW.has(journey.now.kind) && !edited;
  return (
    <div className="shp" data-ship-run={run._id}>
      <header className="shp-head">
        <b>{flow.label}</b>
        {run.task_short_id ? <Link className="shp-task" href={`/tasks/${run.task_short_id}`}>{run.task_short_id}</Link> : null}
        <span className="shp-sub">{run.task_title ?? ""}</span>
        <Link className="shp-link" href={`/workflows/runs/${run._id}`}>Open run</Link>
        <SheetCloser />
      </header>
      {notice}
      <JourneyView journey={journey} run={run} now_ms={now} targets={targets}
        actions={live
          ? <button type="button" className="sj-btn" data-quiet onClick={() => void useInboxStore.getState().stopLineRun(run._id)} data-flow-stop={run._id}>Stop</button>
          // A stop's bar places Ship again itself; a finished run offers it plainly, a landed one only with new edits.
          : stop || spent ? null : <button type="button" className="sj-btn" onClick={onAgain} data-ship-again>Ship again</button>}
        again={(primary) => <button type="button" className="sj-btn" data-primary={primary ? "" : undefined} data-quiet={primary ? undefined : ""} onClick={onAgain} data-ship-again>Ship again</button>} />
    </div>
  );
}

/** Ship again from a run's card in the thread: the same flow, through the same review a first Ship goes through. */
export function ShipAgainButton({ flow, conversationId, sessionTitle, primary }: { flow: AppFlow; conversationId: string; sessionTitle: string; primary: boolean }) {
  const [reviewing, setReviewing] = useState(false);
  return (
    <>
      <button type="button" className="sj-btn" data-primary={primary ? "" : undefined} data-quiet={primary ? undefined : ""} onClick={() => setReviewing(true)} data-ship-again>Ship again</button>
      {reviewing ? <SwitchReview ledger={shipLedgerFor(flow, sessionTitle)} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); useInboxStore.getState().sendMessage(conversationId, runThroughMessage(flow)); }} /> : null}
    </>
  );
}

/** Whether a flow asks the person before the change lands, as a chip. */
function Asks({ flow }: { flow: AppFlow }) {
  const approval = approvalOf(flow);
  return <span className="shp-asks" data-asks={approval.kind === "never" ? undefined : approval.kind}>{approvalWords(approval)}</span>;
}

function PoolPicker({ conversationId, session, onRun }: { conversationId: string; session: string; onRun: (flow: AppFlow) => void }) {
  // The session's workspace, not the active one: the pool `cast flow run` reads where the session runs.
  const workspace = useInboxStore((s) => sessionWorkspaceOf(s as any, conversationId));
  const workflows = usePoolFlowRows(workspace);
  const teamSlug = useTeamDefaultFlowSlug(workspace ? (workspace.startsWith("team:") ? workspace.slice(5) : null) : undefined);
  // The session's checkout's own flows come first, as `cast flow run` takes them there.
  const remote = useInboxStore((s) => sessionRemoteOf(s as any, conversationId));
  const root = useInboxStore((s) => sessionRootOf(s as any, conversationId));
  const repository = repositoryOfRemote(remote);
  const repoFlows = useRepoFlows(root, repository);
  const { pool, fallback } = useMemo(() => {
    // Flows only: a segment runs one part of a change, never the change to live.
    const all = namedForRepo(linesFirst(appPool(workflows, repoFlows).filter((f) => f.kind === "line" && takesSessionChange(f))), repository);
    const d = defaultFlowOf(all, teamSlug);
    return { pool: d ? [d, ...all.filter((f) => f !== d)] : all, fallback: d };
  }, [workflows, repoFlows, repository, teamSlug]);
  const [picked, setPicked] = useState<string | null>(null);
  const flow = pool.find((f) => f.slug === picked) ?? fallback ?? pool[0];
  const journey = useMemo(() => (flow ? journeyOf(flow, null) : null), [flow]);
  if (!flow || !journey) return null;
  return (
    <div className="shp" data-ship-picker>
      <header className="shp-head"><b>Ship</b><span className="shp-session" title={session}>{session}</span><SheetCloser /></header>
      {pool.length > 1 ? (
        // A native radio group: one tab stop, arrow keys move the pick, Enter ships the picked flow.
        <div className="shp-flows" role="radiogroup" aria-label="Flows">
          {pool.map((f) => (
            <label key={f.slug} className="shp-flow" onDoubleClick={() => onRun(f)} data-run-through-flow={f.slug}>
              <input type="radio" className="shp-radio" name={`ship-flow-${conversationId}`} value={f.slug} checked={f.slug === flow.slug}
                onChange={() => setPicked(f.slug)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onRun(f); } }} />
              <b>{f.label}{f === fallback ? <span className="shp-default" data-run-through-default=""><span className="sr-only"> </span>Default</span> : f.base ? <span className="shp-base">on {f.base}</span> : null}</b>
              <span className="shp-path">{journeyStages(f).map((s) => s.label).join(" → ")}</span>
              <Asks flow={f} />
            </label>
          ))}
        </div>
      ) : null}
      <div className="shp-preview" data-flow={flow.slug}>
        <JourneyView journey={journey} now_ms={0} />
      </div>
      <footer className="shp-foot">
        {/* A lone flow has no list row, so its name and whether it asks the person sit here. */}
        <span className="shp-flowname">{pool.length > 1 ? null : <>{flow.label}{flow === fallback ? <span className="shp-default">Default</span> : null}<Asks flow={flow} /></>}</span>
        <button type="button" className="sj-btn" data-primary onClick={() => onRun(flow)} aria-label={pool.length > 1 ? (flow.label === "Ship" ? "Ship this change" : `Ship through ${flow.label}`) : undefined} data-run-through-go={flow.slug}>Ship</button>
      </footer>
    </div>
  );
}
