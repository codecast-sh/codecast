"use client";
// A repo's pipeline page (docs/architecture/pipeline.md PL2, PL6, PL7): the
// repo's name with Edit pipeline and Share; four figures (changes in flight,
// what waits on main, the main target's state, proposed edits); then each
// lane as a left gutter saying when it runs and one track across the width
// with only its passing path; main between them as one calm row; a station's
// story in a drawer. The list page's card draws the same tracks, small
// (PipelineStrip). The model is lib/line/pipelineModel.ts and
// lib/line/pipelineView.ts; this only draws.
import { memo, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ShareControl } from "../../ShareControl";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useEditWhere } from "../../../hooks/usePipelines";
import { pipelineCheckout, pipelineHref, type PipelineModel } from "../../../lib/line/pipelineModel";
import { statTiles, targetWords, trackOf, waitingSessions, type StatTile } from "../../../lib/line/pipelineView";
import { entityRoute } from "../../../lib/entityLinks";
import { deploysFocusHref } from "../../../lib/deploys/focus";
import type { EditOp } from "../../../lib/line/pipelineEdit";
import type { Pipeline } from "../../../lib/line/pipelineTypes";
import { PipelineTrack } from "./PipelineTrack";
import { FlightDetails, MainDetails, PipelineDrawer, StationDetails } from "./PipelineDrawer";
import { EditComposer, type ComposerStart } from "./EditComposer";
import { CheckoutsSection } from "./CheckoutsSection";
import "./pipeline.css";

type LaneName = "change" | "release";
type Open = { kind: "station"; lane: LaneName; id: string } | { kind: "compose"; start: ComposerStart } | { kind: "main" } | { kind: "flight" } | null;

const LANE_WORDS: Record<LaneName, { title: string; does: string }> = {
  change: { title: "Every change", does: "on its own branch" },
  release: { title: "Every release", does: "once per target" },
};

/** A stable colour for a session's avatar, from its name. */
const AVATAR = ["orange", "blue", "violet", "green", "magenta", "cyan", "yellow"] as const;
const avatarOf = (key: string) => AVATAR[[...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR.length];

export const PipelineDiagram = memo(function PipelineDiagram({ model, pipeline, teamId, compact = false }: { model: PipelineModel; pipeline: Pipeline; teamId: string | null; compact?: boolean }) {
  const [open, setOpen] = useState<Open>(null);
  const where = useEditWhere(compact ? null : pipeline);
  const now = useCoarseNow(60_000);
  const close = useCallback(() => setOpen(null), []);
  const tiles = useMemo(() => statTiles(model, now), [model, now]);
  const tracks = useMemo(() => ({ change: trackOf(model, "change", now), release: trackOf(model, "release", now) }), [model, now]);
  if (compact) return <PipelineStrip model={model} />;
  const firstStation = (l: PipelineModel["change"] | PipelineModel["release"]) => l.flow.stations.find((s) => s.main && s.who !== "rule")?.id ?? null;
  const compose = (lane: LaneName, op: EditOp, station: string | null) => setOpen({ kind: "compose", start: { lane, op, station, at: "after" } });
  const sessions = waitingSessions(model);
  // A "+" between two stations: after the one before it, else before the first.
  const add = (lane: LaneName) => (after: string | null, before: string | null) => setOpen({ kind: "compose", start: { lane, op: "add", station: after ?? before, at: after ? "after" : "before" } });
  const tileOpen = (t: StatTile) => { if (t.open && t.open.kind !== "deploy") setOpen(t.open.kind === "station" ? { kind: "station", lane: t.open.lane, id: t.open.station } : { kind: t.open.kind }); };

  const lane = (name: LaneName) => {
    return (
      <section className="pv-lane" data-lane={name} aria-label={LANE_WORDS[name].title}>
        <div className="pv-gutter">
          <div className="pv-gutter-title">{LANE_WORDS[name].title}</div>
          <div className="pv-gutter-does">{LANE_WORDS[name].does}</div>
        </div>
        <div className="pv-lane-body">
          <PipelineTrack items={tracks[name]} picked={open?.kind === "station" && open.lane === name ? open.id : null} onOpen={(id) => setOpen({ kind: "station", lane: name, id })} onAdd={add(name)} />
        </div>
      </section>
    );
  };

  return (
    <div className="pv" data-pipeline-overview>
      <header className="pv-head">
        <div className="pv-head-text">
          <Link href="/flows" className="pv-crumb">Pipelines</Link>
          <h2 className="pv-title">{model.name}</h2>
        </div>
        <span className="pv-head-actions">
          <button type="button" className="pv-btn" onClick={() => compose("change", "add", firstStation(model.change))} data-pipeline-edit>Edit pipeline</button>
          <ShareControl label="pipeline" path={pipelineHref(model.repository)} />
        </span>
      </header>
      <div className="pv-stats">
        {tiles.map((t) => {
          const inner = <><span className="pv-stat-v">{t.value}{t.small ? <small>{t.small}</small> : null}</span><span className="pv-stat-l">{t.label}</span></>;
          return t.open?.kind === "deploy"
            ? <Link key={t.key} href={entityRoute("deploy", t.open.deploy) ?? "#"} className="pv-stat" data-tone={t.tone} data-pv-tile={t.key}>{inner}</Link>
            : <button key={t.key} type="button" className="pv-stat" data-tone={t.tone} onClick={() => tileOpen(t)} disabled={!t.open} data-pv-tile={t.key}>{inner}</button>;
        })}
      </div>
      {lane("change")}
      <section className="pv-lane pv-main" aria-label="main">
        <div className="pv-gutter">
          <div className="pv-gutter-title pv-mono">main</div>
          <div className="pv-gutter-does">{model.main.waiting ? `${model.main.waiting} waiting` : model.main.reading ? "reading what waits" : "nothing waiting"}</div>
        </div>
        <div className="pv-targets">
          {model.main.targets.map((t) => {
            // The deploy its words are about (going out, else failed, else live while nothing waits), highlighted on the Deploys page.
            const dp = t.going?.deploy ?? t.failed?.deploy ?? (t.waiting ? null : t.live?.deploy) ?? null;
            const body = <><i className="pv-led" data-tone={t.tone} aria-hidden /><b>{t.name}</b><span>{targetWords(t, now)}</span></>;
            // Deploys belong to a team: a personal pipeline's targets have no page to open.
            if (!teamId) return <span key={t.name} className="pv-target" data-tone={t.tone} data-pv-target={t.name}>{body}</span>;
            const href = deploysFocusHref({ team: teamId, repository: model.repository, target: t.name, focus: dp ? { kind: "deploy", id: dp } : null });
            return <Link key={t.name} href={href} className="pv-target" data-tone={t.tone} title={`Open ${t.name} on the Deploys page`} data-pv-target={t.name}>{body}</Link>;
          })}
          {sessions.length ? (
            <button type="button" className="pv-waiting" onClick={() => setOpen({ kind: "main" })} data-pipeline-waiting>
              <span className="pv-avatars" aria-hidden>{sessions.slice(0, 4).map((s) => <i key={s.key} data-c={avatarOf(s.key)} title={s.title} />)}</span>
              <span className="pv-waiting-words">{model.main.waiting} {model.main.waiting === 1 ? "change" : "changes"} by {sessions.length} {sessions.length === 1 ? "session" : "sessions"} →</span>
            </button>
          ) : null}
        </div>
      </section>
      {lane("release")}
      <CheckoutsSection pipeline={pipeline} teamId={teamId} />
      {open ? (
        <PipelineDrawer label={open.kind === "main" ? "Waiting to ship" : open.kind === "flight" ? "Changes in flight" : open.kind === "compose" ? "Edit the pipeline" : "Station"} onClose={close}>
          {open.kind === "station" ? (
            <StationDetails key={`${open.lane}:${open.id}`} lane={open.lane} l={open.lane === "change" ? model.change : model.release} model={model} pipeline={pipeline} id={open.id} onEdit={(op, station) => compose(open.lane, op, station)} />
          ) : open.kind === "main" ? (
            <MainDetails model={model} teamId={teamId} />
          ) : open.kind === "flight" ? (
            <FlightDetails model={model} onStation={(id) => setOpen({ kind: "station", lane: "change", id })} />
          ) : (
            <EditComposer key={`${open.start.lane}:${open.start.op}:${open.start.station}`} pipeline={pipeline} start={open.start} where={where} recent={pipelineCheckout(pipeline).recent} onClose={close} />
          )}
        </PipelineDrawer>
      ) : null}
    </div>
  );
});

/** A pipeline as the list's card draws it: the same tracks, small, with main's targets between. */
export function PipelineStrip({ model }: { model: PipelineModel }) {
  const now = useCoarseNow(60_000);
  const change = useMemo(() => trackOf(model, "change", now), [model, now]);
  const release = useMemo(() => trackOf(model, "release", now), [model, now]);
  return (
    <div className="pv-strip">
      <div className="pv-strip-row"><span className="pv-strip-title">Every change</span><PipelineTrack items={change} small /></div>
      <div className="pv-strip-row" data-row="main">
        <span className="pv-strip-title pv-mono">main</span>
        <span className="pv-targets">{model.main.targets.map((t) => <span key={t.name} className="pv-target" data-tone={t.tone}><i className="pv-led" data-tone={t.tone} aria-hidden /><b>{t.name}</b><span>{targetWords(t, now)}</span></span>)}</span>
      </div>
      <div className="pv-strip-row"><span className="pv-strip-title">Every release</span><PipelineTrack items={release} small /></div>
    </div>
  );
}
