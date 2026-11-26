"use client";
// A flow drawn with its stations open to read (docs/architecture/flows.md FL6):
// press a step and the panel under the drawing shows who does it, its model
// and limits, the words it runs (prompt, script, the document a person decides
// on), where each outcome sends the work, and on a run what that station did.
// The flow card, a run's card and the Flows library all draw a flow this way.
import { memo, useMemo, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { AppFlow } from "../../../lib/line/flowPool";
import { useFlowStations } from "../../../lib/line/flowStations";
import { stationView, type StationView } from "../../../lib/line/stationView";
import { flowRefOf } from "../../../lib/entityLinks";
import { MarkdownBlocks } from "../../tools/MarkdownRenderer";
import { CodeBlock } from "../../CodeBlock";
import { EntityIdPill } from "../../EntityIdPill";
import { FlowDiagram, type StepPick } from "./FlowDiagram";
import { WHO } from "../../../lib/line/flowWho";
import { leftWords } from "../../../lib/ship/stationResult";
import { stationRun } from "../../../lib/line/stationRun";
import Link from "next/link";

type RunLike = { node_statuses?: ReadonlyArray<{ node_id: string; status: string; outcome?: string; session_id?: string; result_preview?: string | null }> | null } & Record<string, any>;

/** The drawing, with any step open on a press. Pressing the open step again closes it. */
export const FlowExplorer = memo(function FlowExplorer({ flow, run = null, compact = false }: { flow: AppFlow; run?: RunLike | null; compact?: boolean }) {
  const [picked, setPicked] = useState<StepPick | null>(null);
  return (
    <>
      <FlowDiagram flow={flow} run={run as any} compact={compact} picked={picked?.id ?? null} onPick={(p) => setPicked((cur) => (cur?.id === p.id ? null : p))} />
      {picked ? <FlowStationPanel flow={flow} pick={picked} run={run} onClose={() => setPicked(null)} /> : null}
    </>
  );
});

const TEXT_WORD: Record<StationView["texts"][number]["kind"], string> = { prompt: "Prompt", guide: "Project's guidance", system: "System prompt", script: "Script", doc: "Decision document" };
const STATUS_WORD: Record<string, string> = { completed: "Done", running: "Running", failed: "Failed", pending: "Waiting", back: "Sent back", stopped: "Stopped", unknown: "Unknown" };


/** One station open under its drawing. `children`: what a host adds about it (a pipeline's when, who and recent runs), under its header.
 *  `inherited`: the prompt is the backbone's, so its tab says so beside the project's guidance. */
/** `title`: the station's name as the host draws it, when a step inside a frame would otherwise be named by its own node. */
/** `after`: what the host adds below what the station runs (its changes, its whole script). */
export function FlowStationPanel({ flow, pick, run, onClose, children, after, inherited = false, title }: { flow: AppFlow; pick: StepPick; run: RunLike | null; onClose: () => void; children?: ReactNode; after?: ReactNode; inherited?: boolean; title?: string }) {
  // A host that says who does the step itself (children) needs no fallback word for it in the header.
  const stations = useFlowStations(flow);
  const view = useMemo(() => stationView(flow, pick.id, pick.kind, stations), [flow, pick, stations]);
  const [tab, setTab] = useState(0);
  if (!view) return null;
  const Icon = WHO[view.who].icon;
  const wordOf = (kind: keyof typeof TEXT_WORD) => (kind === "prompt" && inherited ? "Inherited prompt" : TEXT_WORD[kind]);
  const text = view.texts[Math.min(tab, view.texts.length - 1)];
  const visits = run?.node_statuses?.filter((n) => n.node_id === view.id) ?? [];
  // What it did on the run (stationRun.ts): in an own-results round, as its round's view says.
  const line = stationRun(flow, view.id, run);
  return (
    <section className="fsp" data-flow-station={view.id} aria-label={`${view.label}: what this step does`}>
      <header className="fsp-head">
        <Icon className="fsp-who" aria-hidden strokeWidth={2} />
        <span className="fsp-name">{title ?? view.label}</span>
        {view.segment && !title ? <span className="fsp-in">in {view.segment}</span> : null}
        <span className="fsp-facts">
          {(view.facts.length ? view.facts : children ? [] : [WHO[view.who].word]).map((f, i) => <span key={i} className="fsp-fact">{f}</span>)}
        </span>
        <button type="button" className="fsp-close" onClick={onClose} aria-label="Close step"><X aria-hidden strokeWidth={2} /></button>
      </header>
      {children}
      {line ? (
        <div className="fsp-run" data-status={line.status}>
          <span className="fsp-run-state">{line.status === "nothing" ? "Skipped" : STATUS_WORD[line.status] ?? line.status}{visits.length > 1 ? ` · ${visits.length} visits` : ""}</span>
          {line.outcome ? <span className="fsp-run-outcome">{line.outcome}</span> : null}
          {line.session ? <EntityIdPill shortId={line.session} type="session" /> : null}
        </div>
      ) : null}
      {line?.note ? <div className="fsp-run-note">{line.note}</div> : null}
      {/* A step left for the person opens the task it was posted to. */}
      {line?.left ? (run?.task_short_id
        ? <Link className="fsp-run-left" href={`/tasks/${run.task_short_id}`}>{leftWords(line.left)}</Link>
        : <div className="fsp-run-left">{leftWords(line.left)}</div>) : null}
      {view.runsFlow ? (
        <div className="fsp-runs-flow">Runs <EntityIdPill shortId={flowRefOf(view.runsFlow)} type="flow" /></div>
      ) : null}
      {stations === undefined && !view.runsFlow ? <div className="fsp-text fsp-cold" aria-busy /> : text ? (
        <>
          {view.texts.length > 1 ? (
            <div className="fsp-tabs" role="tablist">
              {view.texts.map((t, i) => (
                <button key={t.kind} type="button" role="tab" aria-selected={t === text} className="fsp-tab" onClick={() => setTab(i)}>{wordOf(t.kind)}</button>
              ))}
            </div>
          ) : <div className="fsp-label">{wordOf(text.kind)}</div>}
          <div className="fsp-text" data-kind={text.kind}>
            {text.kind === "script" ? <CodeBlock code={text.text} language="bash" /> : <MarkdownBlocks content={text.text} />}
          </div>
        </>
      ) : null}
      {view.routes.length ? (
        <ul className="fsp-routes">
          {view.routes.map((r, i) => (
            <li key={i} className="fsp-route" data-ends={r.ends ? "" : undefined} data-taken={visits.length && run?.node_statuses?.some((n) => n.node_id === r.toId) ? "" : undefined}>
              <span className="fsp-route-when">{r.words}</span>
              <span className="fsp-route-arrow" aria-hidden>→</span>
              <span className="fsp-route-to">{r.to}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {after}
    </section>
  );
}
