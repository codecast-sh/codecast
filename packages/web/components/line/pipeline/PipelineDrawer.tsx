"use client";
// The pipeline page's drawer (pipeline.md PL6): a station's whole story beside
// the overview (a bottom sheet on a phone). What kind of step it is, the
// proposed edit on it if any, when it runs, who does it and where a failure
// goes, its prompt or command, the changes here now and those that passed,
// its other routes (side routes live here, never on the overview), and Edit /
// Add a step after. The same drawer holds the list of what waits on main and
// the edit composer. Esc or the close button closes it.
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useFlowStations } from "../../../lib/line/flowStations";
import { stationView } from "../../../lib/line/stationView";
import { routeTail, type SideRoute } from "../../../lib/line/flowDiagram";
import { editWords, groupsOf, meaningfulCommand, opsFor, type EditOp } from "../../../lib/line/pipelineEdit";
import { agoWords, laneStationDetails, pipelineStation, stationRuns, WHO_WORDS, type PipelineLane, type PipelineModel } from "../../../lib/line/pipelineModel";
import { targetWords, waitingSessions } from "../../../lib/line/pipelineView";
import type { AppFlow } from "../../../lib/line/flowPool";
import type { Pipeline } from "../../../lib/line/pipelineTypes";
import { runHref } from "../../../lib/decisionLinks";

/** The drawer's frame: closes on Esc, the close button, or a press on the page behind it. */
export function PipelineDrawer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="pd-scrim" onClick={onClose} aria-hidden />
      <aside className="pd lw-widget" role="dialog" aria-label={label} data-pipeline-drawer>
        <button type="button" className="pd-x" onClick={onClose} aria-label="Close"><X aria-hidden strokeWidth={2} /></button>
        {children}
      </aside>
    </>
  );
}

const RUN_WORDS: Record<string, string> = { running: "running", pending: "waiting", paused: "paused", completed: "done", failed: "failed" };
const KIND_WORDS = { agent: "agent", command: "command", person: "person", rule: "routing", eval: "graded check", deploy: "deploy" } as const;

/** One station: everything about it, and its edits. */
export function StationDetails({ lane, l, model, pipeline, id, onEdit }: { lane: "change" | "release"; l: PipelineLane; model: PipelineModel; pipeline: Pipeline; id: string; onEdit: (op: EditOp, station: string) => void }) {
  const flow = useMemo<AppFlow>(() => ({ ...l.drawn, where: "team", workflowId: null, stationDetails: laneStationDetails(l.flow) }), [l]);
  const station = l.flow.stations.find((s) => s.id === id) ?? pipelineStation(pipeline, lane, id);
  const step = l.diagram.steps.flatMap((s) => [s, ...s.inner]).find((s) => s.id === id);
  const stations = useFlowStations(flow);
  // A segment of one step keeps its words on that step: read them there.
  const nodeId = step && step.inner.length === 1 ? step.inner[0].id : id;
  const view = useMemo(() => stationView(flow, nodeId, step?.kind ?? "agent", stations), [flow, nodeId, step?.kind, stations]);
  const now = useCoarseNow(60_000);
  const groups = groupsOf(l.flow);
  const group = groups.get(id);
  const beside = group ? l.flow.stations.filter((s) => groups.get(s.id) === group && s.id !== id).map((s) => s.label) : [];
  const proposal = l.proposals.find((x) => (x.edit.op === "add" ? x.edit.id : x.edit.station) === id) ?? null;
  const runs = lane === "change" && station ? stationRuns(model.change.runs, station.id, l.standing[station.id] ?? []) : { now: [], passed: [] };
  const [fullScript, setFullScript] = useState(false);
  if (!station) return null;

  const routes: SideRoute[] = step ? [...step.side, ...step.inner.flatMap((x) => x.side)] : [];
  const back = routes.find((r) => r.tone === "back");
  const failure = back ? routeTail(back) : l.shared ? (l.shared.toId === "returned" ? "reported back to the line" : routeTail(l.shared)) : routes.some((r) => r.tone === "stop") ? "stops the run" : null;
  const prompt = view?.texts.find((t) => t.kind === "prompt")?.text ?? station.prompt ?? null;
  const guide = station.guide ?? view?.texts.find((t) => t.kind === "guide")?.text ?? null;
  const command = station.runs ?? null;
  const inherited = station.own === "inherited" && l.flow.base !== null;
  const ops = opsFor(station, !!group);
  const first: EditOp | null = ops.has("guide") ? "guide" : ops.has("run") ? "run" : ops.has("when") ? "when" : null;
  const pushTargets = lane === "release" ? model.release.targets.filter((t) => t.runs === "push") : [];
  const label = (sid: string) => l.flow.stations.find((s) => s.id === sid)?.label ?? sid;

  return (
    <div className="pd-body">
      <div className="pd-crumb">{lane === "change" ? "Every change" : "Every release"} · {KIND_WORDS[station.who]}</div>
      <h2 className="pd-title">{station.label}</h2>
      {proposal ? (
        <div className="pd-note">
          <b>Edit proposed</b> · {editWords(proposal.edit, label).replace(/^\w/, (c) => c.toLowerCase())} · <Link href={`/conversation/${proposal.session.id}`}>{proposal.session.title}</Link>
        </div>
      ) : null}
      <dl className="pd-kv">
        <dt>Runs</dt>
        <dd>{lane === "change" ? "on every change" : "once per release, for each target"}{beside.length ? `, beside ${beside.join(" and ")}` : ""}{station.when?.length ? `, when a change touches ${station.when.join(", ")}` : ""}</dd>
        <dt>Who</dt>
        <dd>{WHO_WORDS[station.who]}{station.agent ? ` · ${station.agent}` : ""}{station.model ? ` · ${station.model}` : ""}</dd>
        {failure ? <><dt>On failure</dt><dd>{failure}</dd></> : null}
        <dt>Comes from</dt>
        <dd>{inherited ? `${l.flow.base}, as the team keeps it` : station.own === "changed" ? `this repo's edit of ${l.flow.base}` : "this repo's own flow"}</dd>
      </dl>
      {prompt ? <><div className="pd-sec">{inherited ? "Inherited prompt" : "Prompt"}</div><pre className="pd-pre pd-prose">{prompt}</pre></> : null}
      {guide ? <><div className="pd-sec">This repo's guidance</div><pre className="pd-pre pd-prose">{guide}</pre></> : null}
      {lane === "release" && (station.targets?.length || pushTargets.length) ? (
        <>
          <div className="pd-sec">What each target runs here</div>
          {(station.targets ?? []).map((t) => <div key={t.name} className="pd-row"><span>{t.name}</span>{t.runs ? <code>{meaningfulCommand(t.runs)}</code> : <span className="pd-dim">no command · passes</span>}</div>)}
          {pushTargets.map((t) => <div key={t.name} className="pd-row"><span>{t.name}</span><span className="pd-dim">builds itself on push</span></div>)}
        </>
      ) : command ? (
        <>
          <div className="pd-sec">Command</div>
          <pre className="pd-pre">{fullScript ? command : meaningfulCommand(command)}</pre>
          {meaningfulCommand(command) !== command.trim() ? <button type="button" className="pd-link" onClick={() => setFullScript((v) => !v)}>{fullScript ? "Show the command" : "Show the full script"}</button> : null}
        </>
      ) : lane === "release" && station.runs === null ? <><div className="pd-sec">Command</div><div className="pd-dim">No command set: it passes.</div></> : null}
      <Runs title="Here now" rows={runs.now} now={now} />
      <Runs title="Passed here" rows={runs.passed} now={now} />
      {routes.length ? (
        <>
          <div className="pd-sec">Other routes</div>
          {routes.map((r, i) => <div key={i} className="pd-row"><span>{r.outcome}</span><span className="pd-dim">{routeTail(r)}</span></div>)}
        </>
      ) : null}
      <div className="pd-actions">
        {first ? <button type="button" className="pv-btn" onClick={() => onEdit(first, station.id)} data-station-edit>Edit {station.label}</button> : null}
        <button type="button" className="pv-btn" onClick={() => onEdit("add", station.id)}>Add a step after</button>
      </div>
    </div>
  );
}

function Runs({ title, rows, now }: { title: string; rows: Array<{ run: PipelineModel["change"]["runs"][number]; at: number }>; now: number }) {
  if (!rows.length) return null;
  return (
    <>
      <div className="pd-sec">{title} · {rows.length}</div>
      {rows.map(({ run: r, at }) => (
        <Link key={r._id} href={runHref(r._id)} className="pd-row pd-run" data-status={r.status} title={r.task_short_id ?? undefined}>
          <span className="pd-run-title">{r.task_title || "Change"}</span>
          <span className="pd-dim">{RUN_WORDS[r.status] ?? r.status} · {agoWords(at, now)}</span>
        </Link>
      ))}
    </>
  );
}

/** What waits on main: each target in words, then the sessions whose commits wait, most first. */
export function MainDetails({ model, teamId }: { model: PipelineModel; teamId: string | null }) {
  const now = useCoarseNow(60_000);
  const sessions = waitingSessions(model);
  return (
    <div className="pd-body">
      <div className="pd-crumb">main</div>
      <h2 className="pd-title">Waiting to ship</h2>
      <div className="pd-sec">Targets</div>
      {model.main.targets.map((t) => (
        <Link key={t.name} href={`/deploys?${teamId ? `team=${teamId}&` : ""}target=${encodeURIComponent(t.name)}`} className="pd-row">
          <span><i className="pv-led" data-tone={t.tone} aria-hidden /> {t.name}</span><span className="pd-dim">{targetWords(t, now)}</span>
        </Link>
      ))}
      <div className="pd-sec">By session · {sessions.length}</div>
      {sessions.map((s) => s.conversationId
        ? <Link key={s.key} href={`/conversation/${s.conversationId}`} className="pd-row"><span className="pd-run-title">{s.title}</span><span className="pd-dim">{s.commits} {s.commits === 1 ? "commit" : "commits"}</span></Link>
        : <div key={s.key} className="pd-row"><span className="pd-run-title">{s.title}</span><span className="pd-dim">{s.commits} {s.commits === 1 ? "commit" : "commits"}</span></div>)}
    </div>
  );
}
