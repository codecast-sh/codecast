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
import { EntityIdPill } from "../../EntityIdPill";
import { agoWords, spanWords, laneStationDetails, pipelineStation, stationRuns, WHO_WORDS, type MainTarget, type PipelineLane, type PipelineModel } from "../../../lib/line/pipelineModel";
import type { AppFlow } from "../../../lib/line/flowPool";
import type { Pipeline } from "../../../lib/line/pipelineTypes";
import { runHref } from "../../../lib/decisionLinks";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import "./pipeline.css";

type LaneName = "change" | "release";
type Picked = { lane: LaneName; pick: StepPick } | null;

/** One deploy on the Deploys page. */
const deployHref = (teamId: string | null, deploy: string) => `/deploys?${teamId ? `team=${teamId}&` : ""}deploy=${encodeURIComponent(deploy)}`;

/** A deploy named by its dp-N, opening it on Deploys; a record named otherwise (a commit) is not shown. */
function DeployRef({ teamId, deploy }: { teamId: string | null; deploy: string }) {
  return /^dp-\d+$/.test(deploy) ? <Link href={deployHref(teamId, deploy)} className="rpl-target-ref">{deploy}</Link> : null;
}

/** What starts a deploy to a target, in a word or two. */
const POLICY_WORDS: Record<MainTarget["policy"], string> = { press: "on a press", release: "with each release", auto: "on green CI" };
const TONE_WORDS = { going: "going out", failed: "failed", waiting: "waiting", current: "up to date", unknown: "not read", stuck: "stuck" } as const;

export const PipelineDiagram = memo(function PipelineDiagram({ model, pipeline, teamId, compact = false }: { model: PipelineModel; pipeline: Pipeline; teamId: string | null; compact?: boolean }) {
  const [picked, setPicked] = useState<Picked>(null);
  if (compact) return <PipelineStrip model={model} />;
  const onPick = (lane: LaneName) => (p: StepPick) => setPicked((cur) => (cur?.lane === lane && cur.pick.id === p.id ? null : { lane, pick: p }));
  const lane = (name: LaneName, l: PipelineLane, head: ReactNode, run: PipelineModel["release"]["run"] = null) => (
    <section className="rpl-lane" data-lane={name} aria-label={name === "change" ? "Every change" : "Every release"}>
      {head}
      <FlowDiagram flow={l.drawn} diagram={l.diagram} run={run} marks={l.marks} quietRoutes picked={picked?.lane === name ? picked.pick.id : null} onPick={onPick(name)} />
      {picked?.lane === name ? <StationPanel lane={name} l={l} model={model} pipeline={pipeline} pick={picked.pick} run={run} onClose={() => setPicked(null)} /> : null}
    </section>
  );
  return (
    <div className="rpl">
      {lane("change", model.change, <LaneHead title="Every change" l={model.change} live={model.change.inFlight ? `${model.change.inFlight} in flight` : null} edit />)}
      <MainRail model={model} teamId={teamId} />
      {lane("release", model.release, <LaneHead title="Every release" l={model.release} live={model.release.run ? "going out" : null} outside={model.release.outside} stuck={model.release.stuck} teamId={teamId} />, model.release.run)}
    </div>
  );
});

function LaneHead({ title, l, live, outside = null, stuck = null, edit = false, teamId = null }: { title: string; l: PipelineLane; live: string | null; outside?: string | null; stuck?: PipelineModel["release"]["stuck"]; edit?: boolean; teamId?: string | null }) {
  return (
    <header className="rpl-lane-head">
      <span className="rpl-lane-title">{title}</span>
      <span className="rpl-lane-flow">{l.flow.label}</span>
      {l.flow.base && l.flow.base !== l.flow.slug ? <span className="rpl-lane-fact">extends {l.flow.base}</span> : null}
      <span className="rpl-lane-fact" data-tone={l.own ? "own" : undefined}>{l.flow.base === null ? "this repo's own" : l.own ? `${l.own} own · ${l.inherited} inherited` : "all inherited"}</span>
      {l.flow.removed.length ? <span className="rpl-lane-fact">skips {l.flow.removed.join(", ")}</span> : null}
      {l.shared ? <span className="rpl-lane-fact" title={`${l.shared.outcome}: ${routeTail(l.shared)}`}>a failing step → {l.shared.leadsTo ?? l.shared.outcome}</span> : null}
      {stuck ? <span className="rpl-lane-stuck"><Link href={deployHref(teamId, stuck.deploy)}>{stuck.deploy}</Link> stuck {spanWords(stuck.for)}{stuck.outside ? " · sent outside codecast, never reported live" : ""}</span>
        : outside ? <span className="rpl-lane-outside">going out {outside} · steps not tracked</span>
        : live ? <span className="rpl-lane-live">{live}</span> : null}
      {/* ct-98678 puts Edit on each station; until then a change to this flow is a sentence in a conversation. */}
      {edit ? <span className="rpl-lane-edit">change it in a conversation: <code>cast flow edit {l.flow.slug}</code></span> : null}
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
  const named = groups.filter((g) => g.session?.short_id);
  const rest = groups.length - Math.min(named.length, 3);
  return (
    <span className="rpl-waiting">
      {named.slice(0, 3).map((g) => <EntityIdPill key={g.key} shortId={g.session!.short_id!} />)}
      {rest > 0 ? <span className="rpl-target-how">+{rest}</span> : null}
    </span>
  );
}

const OWN_WORDS = { added: "added here", changed: "changed here", inherited: "inherited" } as const;
const RUN_WORDS: Record<string, string> = { running: "running", pending: "waiting", paused: "paused", completed: "done", failed: "failed" };

/** One station open: what it runs (FlowStationPanel), and the pipeline's facts about it: scope, own or inherited, when, recent runs. */
function StationPanel({ lane, l, model, pipeline, pick, run, onClose }: { lane: LaneName; l: PipelineLane; model: PipelineModel; pipeline: Pipeline; pick: StepPick; run: PipelineModel["release"]["run"]; onClose: () => void }) {
  const flow = useMemo<AppFlow>(() => ({ ...l.drawn, where: "team", workflowId: null, stationDetails: laneStationDetails(l.flow) }), [l]);
  const station = pipelineStation(pipeline, lane, pick.id);
  const now = useCoarseNow(60_000);
  const recent = lane === "change" && station ? stationRuns(model.change.runs, station.id) : [];
  return (
    <FlowStationPanel flow={flow} pick={pick} run={run} onClose={onClose} inherited={station?.own === "inherited" || !!station?.guide}>
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
          {station.waits ? <span className="rpl-fact">waits for the deploy · sends none</span> : null}
          {/* ct-98678: the station's Edit opens here (an edit drafted as a session's change, pipeline.md PL5). */}
          <StationEditSlot />
        </div>
      ) : null}
      {lane === "release" && station?.targets?.length ? (
        <ul className="rpl-cmds" aria-label="Command by target">
          {station.targets.map((t) => (
            <li key={t.name} className="rpl-cmd"><span className="rpl-cmd-target">{t.name}</span>{t.runs ? <code className="rpl-cmd-text">{t.runs}</code> : <span className="rpl-cmd-none">no command · passes</span>}</li>
          ))}
        </ul>
      ) : null}
      {recent.length ? (
        <ul className="rpl-runs" aria-label="Recent runs">
          {recent.map((r) => (
            <li key={r._id}>
              <Link href={runHref(r._id)} className="rpl-run" data-status={r.status}>
                <span className="rpl-run-state">{RUN_WORDS[r.status] ?? r.status}</span>
                <span className="rpl-run-title">{r.task_title || "Change"}</span>
                {r.task_short_id ? <span className="rpl-run-ref">{r.task_short_id}</span> : null}
                <span className="rpl-run-at">{agoWords(r.updated_at ?? r.created_at, now)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </FlowStationPanel>
  );
}

/** The Edit slot ct-98678 fills: nothing until an edit can be drafted from here. */
function StationEditSlot() {
  return null;
}

/** A pipeline as a compact strip (the list's card): each lane its passing path as named steps, main its targets.
 *  Narrower than a strip reads (the card under 440px), each lane folds to one line of figures. */
function PipelineStrip({ model }: { model: PipelineModel }) {
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
          // A fan-out reads as its branches side by side, each by its own name.
          const name = st.kind === "parallel" && st.inner.length ? st.inner.map((x) => x.label).join(" + ") : st.label;
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
