"use client";
// A repo's pipeline drawn (docs/architecture/pipeline.md PL2, PL6, PL7): the
// change lane on top, main between, the release lane below, so a station's
// scope is where it sits. Both lanes are FlowDiagram over the one model
// (lib/line/pipelineModel.ts), each step with its mark: the project's own
// steps accented, inherited ones calm, a release step with no command quiet,
// and the changes standing on each now. Main says, per target, what waits,
// what is going out and what is live. A station opens its panel under the
// drawing. `compact` is the list's strip: the same drawing, no routes, no panel.
import { memo, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { FlowDiagram, type StepPick } from "../widgets/FlowDiagram";
import { routeTail } from "../../../lib/line/flowDiagram";
import { FlowStationPanel } from "../widgets/FlowStationPanel";
import { agoWords, spanWords, laneStationDetails, pipelineStation, stationRuns, WHO_WORDS, type MainTarget, type PipelineLane, type PipelineModel } from "../../../lib/line/pipelineModel";
import type { AppFlow } from "../../../lib/line/flowPool";
import type { Pipeline, PipelineStation } from "../../../lib/line/pipelineTypes";
import { runHref } from "../../../lib/decisionLinks";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useEditWhere } from "../../../hooks/usePipelines";
import { EditComposer, type ComposerStart } from "./EditComposer";
import { pipelineCheckout } from "../../../lib/line/pipelineModel";
import { groupsOf, meaningfulCommand, opsFor, type EditOp } from "../../../lib/line/pipelineEdit";
import "./pipeline.css";

type LaneName = "change" | "release";
type Picked = { lane: LaneName; pick: StepPick } | null;

/** A session's title as a person reads it, markup a prompt pasted into it left out; never its id. */
const sessionTitle = (title: string | null | undefined) => (title ?? "").replace(/<\/?[a-z_][^>]*>/gi, " ").replace(/\s+/g, " ").trim() || "untitled session";

/** One deploy on the Deploys page. */
const deployHref = (teamId: string | null, deploy: string) => `/deploys?${teamId ? `team=${teamId}&` : ""}deploy=${encodeURIComponent(deploy)}`;

/** A deploy named by its dp-N, opening it on Deploys; a record named otherwise (a commit) is not shown. */
function DeployRef({ teamId, deploy }: { teamId: string | null; deploy: string }) {
  return /^dp-\d+$/.test(deploy) ? <Link href={deployHref(teamId, deploy)} className="rpl-target-ref">{deploy}</Link> : null;
}

/** Where a lane's shared failure route goes, in plain words: the release's own "Back to the line" step reports the
 *  failure back to the line. */
const sharedWords = (r: { outcome: string; leadsTo: string | null; toId: string }) => (r.toId === "returned" || /back to the line/i.test(r.outcome) ? "reported back" : `sent to ${r.leadsTo ?? r.outcome}`);

/** What "in flight" counts, as parts that add up to it. */
function FlightWords({ flight, total }: { flight: PipelineModel["change"]["flight"]; total: number }) {
  const parts = [
    flight.working ? `${flight.working} at a station` : null,
    flight.waiting ? `${flight.waiting} waiting for the deploy` : null,
    flight.paused ? `${flight.paused} paused` : null,
    flight.elsewhere ? `${flight.elsewhere} between stations` : null,
  ].filter(Boolean);
  return <span className="rpl-lane-flight" title="This repo's changes whose run through the flow has not ended"><b className="lw-num">{total}</b> in flight{parts.length ? ` · ${parts.join(" · ")}` : ""}</span>;
}

/** What starts a deploy to a target, in a word or two. */
const POLICY_WORDS: Record<MainTarget["policy"], string> = { press: "on a press", release: "with each release", auto: "on green CI" };
const TONE_WORDS = { going: "going out", failed: "failed", waiting: "waiting", current: "up to date", unknown: "not read", stuck: "stuck" } as const;

export const PipelineDiagram = memo(function PipelineDiagram({ model, pipeline, teamId, compact = false }: { model: PipelineModel; pipeline: Pipeline; teamId: string | null; compact?: boolean }) {
  const [picked, setPicked] = useState<Picked>(null);
  // One edit composed at a time, under the lane it edits; opening it closes a station's panel.
  const [composing, setComposing] = useState<ComposerStart | null>(null);
  const where = useEditWhere(compact ? null : pipeline);
  if (compact) return <PipelineStrip model={model} />;
  const onPick = (lane: LaneName) => (p: StepPick) => { setComposing(null); setPicked((cur) => (cur?.lane === lane && cur.pick.id === p.id ? null : { lane, pick: p })); };
  const compose = (start: ComposerStart) => { setPicked(null); setComposing(start); };
  const firstStation = (l: PipelineLane) => l.flow.stations.find((s) => s.main && s.who !== "rule")?.id ?? null;
  const lane = (name: LaneName, l: PipelineLane, head: ReactNode, run: PipelineModel["release"]["run"] = null) => (
    <section className="rpl-lane" data-lane={name} aria-label={name === "change" ? "Every change" : "Every release"}>
      {head}
      <FlowDiagram flow={l.drawn} diagram={l.diagram} run={run} marks={l.marks} quietRoutes picked={picked?.lane === name ? picked.pick.id : null} onPick={onPick(name)}
        onAdd={(after) => compose({ lane: name, op: "add", station: after ?? firstStation(l), at: after ? "after" : "before" })} />
      {picked?.lane === name ? <StationPanel lane={name} l={l} model={model} pipeline={pipeline} pick={picked.pick} run={run} onClose={() => setPicked(null)} onEdit={(op, station) => compose({ lane: name, op, station, at: "after" })} /> : null}
      {composing?.lane === name ? <EditComposer key={`${composing.op}:${composing.station}:${composing.at}`} pipeline={pipeline} start={composing} where={where} recent={pipelineCheckout(pipeline).recent} onClose={() => setComposing(null)} /> : null}
    </section>
  );
  return (
    <div className="rpl">
      {lane("change", model.change, <LaneHead title="Every change" l={model.change} live={null} flight={model.change} onEdit={() => compose({ lane: "change", op: "add", station: firstStation(model.change), at: "after" })} />)}
      <MainRail model={model} teamId={teamId} />
      {lane("release", model.release, <LaneHead title="Every release" l={model.release} live={model.release.run ? "going out" : null} outside={model.release.outside} stuck={model.release.stuck} teamId={teamId} onEdit={() => compose({ lane: "release", op: "when", station: firstStation(model.release), at: "after" })} />, model.release.run)}
    </div>
  );
});

/** A lane's head: what it is, how much of it is the repo's own, what it is doing now, and Edit. `flight`: the change
 *  lane's changes in flight, said as parts that add up to the whole. */
function LaneHead({ title, l, live, outside = null, stuck = null, onEdit, teamId = null, flight = null }: { title: string; l: PipelineLane; live: string | null; outside?: string | null; stuck?: PipelineModel["release"]["stuck"]; onEdit: () => void; teamId?: string | null; flight?: PipelineModel["change"] | null }) {
  // A release step with no command passes: the lane says how many of its steps do something.
  const steps = l.diagram.steps.filter((st) => st.kind !== "join");
  const running = steps.filter((st) => !l.marks[st.id]?.passes).length;
  return (
    <header className="rpl-lane-head">
      <span className="rpl-lane-title">{title}</span>
      {l.flow.base && l.flow.base !== l.flow.slug ? <span className="rpl-lane-fact">extends {l.flow.base}</span> : null}
      <span className="rpl-lane-fact" data-tone={l.own ? "own" : undefined}>{l.flow.base === null ? "this repo's own" : l.own ? `${l.own} own · ${l.inherited} inherited` : "all inherited"}</span>
      {l.flow.removed.length ? <span className="rpl-lane-fact">skips {l.flow.removed.join(", ")}</span> : null}
      {running < steps.length ? <span className="rpl-lane-fact">{running} of {steps.length} steps run something</span> : null}
      {l.shared ? <span className="rpl-lane-fact" title={`${l.shared.outcome}: ${routeTail(l.shared)}`}>a failing step is {sharedWords(l.shared)}</span> : null}
      {flight?.inFlight ? <FlightWords flight={flight.flight} total={flight.inFlight} /> : null}
      {stuck ? <span className="rpl-lane-stuck"><Link href={deployHref(teamId, stuck.deploy)}>{stuck.deploy}</Link> stuck {spanWords(stuck.for)}{stuck.outside ? " · sent outside codecast, never reported live" : ""}</span>
        : outside ? <span className="rpl-lane-outside">going out {outside} · steps not tracked</span>
        : live ? <span className="rpl-lane-live">{live}</span> : null}
      {l.proposals.length ? <span className="rpl-lane-fact" data-tone="own">{l.proposals.length} proposed</span> : null}
      <button type="button" className="rpl-lane-editbtn" onClick={onEdit} data-pipeline-edit>Edit</button>
    </header>
  );
}

/** Main: each target with what waits for it, what is going out and what is live there. */
function MainRail({ model, teamId }: { model: PipelineModel; teamId: string | null }) {
  const now = useCoarseNow(60_000);
  const deploysAt = (t: string) => `/deploys?${teamId ? `team=${teamId}&` : ""}target=${encodeURIComponent(t)}`;
  return (
    <section className="rpl-main" aria-label="Main">
      <span className="rpl-main-name">main</span>
      <ul className="rpl-targets">
        {model.main.targets.map((t) => (
          <li key={t.name} className="rpl-target" data-tone={t.tone}>
            <Link href={deploysAt(t.name)} className="rpl-target-link" title={`${t.name}: open on Deploys`}>
              <i className="rpl-dot" aria-hidden />
              <span className="rpl-target-name">{t.name}</span>
              <span className="rpl-target-state">
                {t.going?.stuck ? <>{t.going.deploy} stuck {spanWords(t.going.stuck)} · {t.going.outside ? "sent outside codecast, never reported live" : "never went live"}</>
                  : t.going ? <>going out{t.going.step ? ` · ${t.going.step}` : ""}{t.going.outside ? " · steps not tracked" : ""}</>
                  : t.tone === "waiting" ? <><b className="lw-num">{t.waiting}</b> waiting</>
                  : TONE_WORDS[t.tone]}
              </span>
            </Link>
            {(
              <span className="rpl-target-facts">
                {t.going && !t.going.stuck ? <DeployRef teamId={teamId} deploy={t.going.deploy} /> : t.failed ? <DeployRef teamId={teamId} deploy={t.failed.deploy} /> : null}
                {t.going && t.waiting ? <span className="rpl-target-how"><b className="lw-num">{t.waiting}</b> waiting</span> : null}
                {t.live ? <span className="rpl-target-live">live {t.live.version ? `${t.live.version} · ` : ""}{agoWords(t.live.at, now)}</span> : null}
                <span className="rpl-target-how">{t.runs === "push" ? "builds on push" : POLICY_WORDS[t.policy]}</span>
                {t.groups.length ? <Waiting groups={t.groups} /> : null}
              </span>
            )}
          </li>
        ))}
        {!model.main.targets.length ? <li className="rpl-target" data-tone="unknown"><span className="rpl-target-state">no targets declared</span></li> : null}
      </ul>
    </section>
  );
}

/** The sessions whose commits wait on main for a target. */
function Waiting({ groups }: { groups: MainTarget["groups"] }) {
  const sessions = groups.filter((g) => g.session);
  const rest = groups.length - Math.min(sessions.length, 3);
  return (
    <span className="rpl-waiting">
      {/* A session by its title; its id only on hover. */}
      {sessions.slice(0, 3).map((g) => (
        <Link key={g.key} href={`/conversation/${g.session!.conversation_id}`} className="rpl-waiting-session" title={g.session!.short_id ?? undefined}>
          {sessionTitle(g.session!.title)}
        </Link>
      ))}
      {rest > 0 ? <span className="rpl-target-how">+{rest}</span> : null}
    </span>
  );
}

const OWN_WORDS = { added: "added here", changed: "changed here", inherited: "inherited" } as const;
const RUN_WORDS: Record<string, string> = { running: "running", pending: "waiting", paused: "paused", completed: "done", failed: "failed" };

/** One station open: what it runs (FlowStationPanel), and the pipeline's facts about it: scope, own or inherited, when, recent runs. */
function StationPanel({ lane, l, model, pipeline, pick, run, onClose, onEdit }: { lane: LaneName; l: PipelineLane; model: PipelineModel; pipeline: Pipeline; pick: StepPick; run: PipelineModel["release"]["run"]; onClose: () => void; onEdit: (op: EditOp, station: string) => void }) {
  const flow = useMemo<AppFlow>(() => ({ ...l.drawn, where: "team", workflowId: null, stationDetails: laneStationDetails(l.flow) }), [l]);
  // The lane's flow holds proposed stations too, so a ghost opens like any station.
  const station = l.flow.stations.find((s) => s.id === pick.id) ?? pipelineStation(pipeline, lane, pick.id);
  const proposal = l.proposals.find((x) => (x.edit.op === "add" ? x.edit.id : x.edit.station) === station?.id) ?? null;
  const now = useCoarseNow(60_000);
  // "Here now" lists what the station's count counts, so a count and its list never disagree.
  const runs = lane === "change" && station ? stationRuns(model.change.runs, station.id, l.standing[station.id] ?? []) : { now: [], passed: [] };
  const inGroup = !!station && groupsOf(l.flow).has(station.id);
  const full = station?.runs ?? null;
  const short = full ? meaningfulCommand(full) : null;
  const pushTargets = lane === "release" ? model.release.targets.filter((t) => t.runs === "push") : [];
  return (
    // The panel names the station as the rail does; its prompt is "inherited" only where a backbone gives it.
    <FlowStationPanel flow={flow} pick={pick} run={run} onClose={onClose} title={station?.label} inherited={station?.own === "inherited" && l.flow.base !== null}
      after={<>
        {full && short !== full.trim() ? <details className="rpl-script"><summary>Full script</summary><pre>{full}</pre></details> : null}
        <StationRuns title="Here now" rows={runs.now} now={now} />
        <StationRuns title="Passed here" rows={runs.passed} now={now} />
      </>}>
      {station ? (
        <div className="rpl-facts">
          <span className="rpl-fact">{WHO_WORDS[station.who]}</span>
          <span className="rpl-fact">{lane === "change" ? "every change" : "every release"}</span>
          <span className="rpl-fact" data-tone={station.own === "inherited" ? undefined : "own"} title={station.changed?.join(", ") || undefined}>
            {station.own === "inherited" && l.flow.base ? `inherited from ${l.flow.base}` : OWN_WORDS[station.own]}
            {station.changed?.length ? `: ${station.changed.join(", ")}` : ""}
          </span>
          <span className="rpl-fact" data-mono={station.when?.length ? "" : undefined}>{station.when?.length ? `when ${station.when.join(", ")}` : "always"}</span>
          {lane === "release" && station.runs === null ? <span className="rpl-fact" data-tone="quiet">no command · passes</span> : null}
          {station.waits ? <span className="rpl-fact">waits for the deploy</span> : null}
          {proposal ? <Link href={`/conversation/${proposal.session.id}`} className="rpl-fact rpl-fact-link" data-tone="own">proposed · {sessionTitle(proposal.session.title)}</Link> : null}
          <StationEditSlot station={station} inGroup={inGroup} onEdit={onEdit} />
        </div>
      ) : null}
      {lane === "release" && (station?.targets?.length || pushTargets.length) ? (
        <ul className="rpl-cmds" aria-label="What each target runs here">
          {(station?.targets ?? []).map((t) => (
            <li key={t.name} className="rpl-cmd"><span className="rpl-cmd-target">{t.name}</span>{t.runs ? <code className="rpl-cmd-text">{meaningfulCommand(t.runs)}</code> : <span className="rpl-cmd-none">no command · passes</span>}</li>
          ))}
          {pushTargets.map((t) => <li key={t.name} className="rpl-cmd"><span className="rpl-cmd-target">{t.name}</span><span className="rpl-cmd-none">builds itself on push</span></li>)}
        </ul>
      ) : null}
    </FlowStationPanel>
  );
}

/** A station's changes: here now since when, or when they passed it. */
function StationRuns({ title, rows, now }: { title: string; rows: Array<{ run: PipelineModel["change"]["runs"][number]; at: number }>; now: number }) {
  if (!rows.length) return null;
  return (
    <div className="rpl-runs-group">
      <div className="fsp-label">{title}</div>
      <ul className="rpl-runs" aria-label={title}>
        {rows.map(({ run: r, at }) => (
          <li key={r._id}>
            <Link href={runHref(r._id)} className="rpl-run" data-status={r.status} title={r.task_short_id ?? undefined}>
              <span className="rpl-run-state">{RUN_WORDS[r.status] ?? r.status}</span>
              <span className="rpl-run-title">{r.task_title || "Change"}</span>
              <span className="rpl-run-at">{agoWords(at, now)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A station's edits from its panel (pipeline.md PL5): the one it most likely needs, and a station after it (after its
 *  group, for a branch of one). */
function StationEditSlot({ station, inGroup, onEdit }: { station: Pick<PipelineStation, "id" | "prompt" | "runs" | "who">; inGroup: boolean; onEdit: (op: EditOp, station: string) => void }) {
  const ops = opsFor(station, inGroup);
  const first: EditOp | null = ops.has("guide") ? "guide" : ops.has("run") ? "run" : ops.has("when") ? "when" : null;
  return (
    <span className="rpl-edit-slot">
      {first ? <button type="button" className="rpl-lane-editbtn" onClick={() => onEdit(first, station.id)} data-station-edit>Edit</button> : null}
      <button type="button" className="rpl-lane-editbtn" onClick={() => onEdit("add", station.id)}>Add after</button>
    </span>
  );
}

/** A pipeline as a compact strip (the list's card): each lane its passing path as named steps, main its targets.
 *  Narrower than a strip reads (the card under 440px), each lane folds to one line of figures. */
export function PipelineStrip({ model }: { model: PipelineModel }) {
  return (
    <div className="rpl-strip">
      <StripLane title="Every change" l={model.change} live={model.change.inFlight ? `${model.change.inFlight} in flight` : null} />
      <div className="rpl-strip-row" data-row="main">
        <span className="rpl-strip-title">main</span>
        <span className="rpl-strip-path">
          {model.main.targets.map((t) => (
            <span key={t.name} className="rpl-strip-target" data-tone={t.tone}>
              <i className="rpl-dot" aria-hidden />{t.name}
              <span className="rpl-strip-state">{t.going?.stuck ? `stuck ${spanWords(t.going.stuck)}` : t.going ? "going out" : t.tone === "waiting" ? `${t.waiting} waiting` : TONE_WORDS[t.tone]}</span>
            </span>
          ))}
        </span>
      </div>
      <StripLane title="Every release" l={model.release} bad={!!model.release.stuck} live={model.release.stuck ? `${model.release.stuck.deploy} stuck ${spanWords(model.release.stuck.for)}` : model.release.run || model.release.outside ? "going out" : null} />
    </div>
  );
}

function StripLane({ title, l, live, bad = false }: { title: string; l: PipelineLane; live: string | null; bad?: boolean }) {
  const steps = l.diagram.steps;
  return (
    <div className="rpl-strip-row">
      <span className="rpl-strip-title">{title}</span>
      <ol className="rpl-strip-path">
        {steps.map((st) => {
          const mark = l.marks[st.id];
          const name = st.label;
          const here = mark?.here ?? 0;
          return (
            <li key={st.id} className="rpl-strip-step" data-passes={mark?.passes ? "" : undefined} data-here={here ? "" : undefined} title={mark?.hereNames?.join("\n")}>
              {name}{here ? <b className="rpl-strip-here">{here} here</b> : null}
            </li>
          );
        })}
      </ol>
      <span className="rpl-strip-sum">{steps.length} steps{live ? ` · ${live}` : ""}</span>
      {live ? <span className="rpl-strip-live" data-tone={bad ? "bad" : undefined}>{live}</span> : null}
    </div>
  );
}
