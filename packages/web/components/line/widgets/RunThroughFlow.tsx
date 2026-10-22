"use client";
// "Run through" on a session (docs/architecture/flows.md FL4, FL6): the pool
// of flows, each drawn on pick, and the press that asks this session to send
// its own change through the one picked. The session does the run (it knows
// what its change is and names its task); the review says what starts first,
// since agent stations start sessions of their own.
import { useMemo, useState } from "react";
import { Route } from "lucide-react";
import { flowPathWords } from "@codecast/shared/contracts/flowPool";
import { useInboxStore } from "../../../store/inboxStore";
import { useWorkflows } from "../../../hooks/useSyncWorkflows";
import { appPool, type AppFlow } from "../../../lib/line/flowPool";
import { flowDiagram } from "../../../lib/line/flowDiagram";
import { flowRunLedger } from "../../consequential/ledgers";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { FlowDiagram } from "./FlowDiagram";
import "../workspace/workspace.css";

/** What the session is asked: run its change through the flow, named after what the change does, and say how it ended. */
export function runThroughMessage(flow: Pick<AppFlow, "slug" | "label">): string {
  return `Run your change through the ${flow.label} flow: \`cast flow run ${flow.slug} --title "<what your change does>"\`. When it ends, tell me where it stopped or that it passed.`;
}

/** Every step a run of the flow visits on its passing path, segments opened up, as the review counts them. */
function passingSteps(flow: AppFlow) {
  return flowDiagram(flow).steps.flatMap((s) => (s.inner.length ? s.inner : [s])).map((s) => ({ label: s.label, kind: s.kind }));
}

export function RunThroughFlow({ conversationId, sessionTitle }: { conversationId: string; sessionTitle: string }) {
  const [open, setOpen] = useState(false);
  // The flow under review: held here, so the review outlives the popover that picked it.
  const [reviewing, setReviewing] = useState<AppFlow | null>(null);
  const send = (flow: AppFlow) => {
    setReviewing(null);
    useInboxStore.getState().sendMessage(conversationId, runThroughMessage(flow));
  };
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="cq-sq6 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-sol-blue/10 text-sol-blue border border-sol-blue/30 hover:bg-sol-blue/20 transition-colors" title="Run this session's change through a flow" data-run-through>
            <Route className="w-3 h-3" />
            <span className="cq-sq2">Run through</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[640px] max-w-[calc(100vw-2rem)] p-0 border-sol-border bg-sol-bg" data-run-through-pool>
          {/* Mounted only while open: the pool's feed is read when someone looks, never by every header. */}
          <PoolPicker onRun={(flow) => { setOpen(false); setReviewing(flow); }} />
        </PopoverContent>
      </Popover>
      {reviewing ? <SwitchReview ledger={ledgerFor(reviewing, sessionTitle)} onClose={() => setReviewing(null)} onConfirm={() => send(reviewing)} /> : null}
    </>
  );
}

function ledgerFor(flow: AppFlow, session: string) {
  const d = flowDiagram(flow);
  const stops = d.steps.flatMap((s) => [...s.side, ...s.inner.flatMap((i) => i.side)]).filter((r) => r.tone === "stop").map((r) => r.outcome);
  return flowRunLedger({ flow: flow.label, session, stations: passingSteps(flow), ends: [...(d.end ? [d.end] : []), ...stops] });
}

function PoolPicker({ onRun }: { onRun: (flow: AppFlow) => void }) {
  const { workflows } = useWorkflows();
  const pool = useMemo(() => appPool(workflows).filter((f) => f.takes.includes("branch")), [workflows]);
  const [picked, setPicked] = useState<string>("change");
  const flow = pool.find((f) => f.slug === picked) ?? pool[0];
  if (!flow) return null;
  return (
    <div className="lw-widget rtf">
      <ul className="rtf-list" role="listbox" aria-label="Flows">
        {pool.map((f) => (
          <li key={f.slug}>
            <button type="button" role="option" aria-selected={f.slug === flow.slug} className="rtf-row" onClick={() => setPicked(f.slug)} onDoubleClick={() => onRun(f)} data-run-through-flow={f.slug}>
              <span className="lw-flow-kind" data-kind={f.kind}>{f.kind === "line" ? "Line" : "Segment"}</span>
              <b>{f.label}</b>
              <span className="rtf-path">{flowPathWords(f).path}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="rtf-preview">
        <FlowDiagram flow={flow} compact />
      </div>
      <footer className="rtf-foot">
        <span className="rtf-desc">{flow.description}</span>
        <button type="button" className="rtf-go" onClick={() => onRun(flow)} data-run-through-go={flow.slug}>Run through {flow.label}</button>
      </footer>
    </div>
  );
}
