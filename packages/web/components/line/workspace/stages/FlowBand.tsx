"use client";
// The whole flow above the Map's lanes, one continuous line (learning-loop.md
// LL1): the stream stations that run once per moment (Moments, Expectations
// judged against, Judges, Grouping), then per problem the dispatcher, the run
// stations (the graph below) and the decision. Each stage carries its counts
// and opens its page as a drawer from the right (`stage=`), the graph staying
// in view behind it. Stream stations run per moment, not per run, so their
// figures are counters (arrived, failed, cost, version), never run tallies.
import { memo, useMemo, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { useLineStages, useSyncLineStages } from "../../../../hooks/useLineStages";
import { useProjectExpectations, useSyncProjectExpectations } from "../../../../hooks/useSyncProjectExpectations";
import { openProposals } from "../../../../lib/expectations/view";
import { useTrialProjects, useTrialRuns } from "../../../../hooks/useSyncTrial";
import { DAY, agoWords, forYouOfLine, placementMix, sumArrivals, usd, versionWords } from "../../../../lib/line/flowStages";
import type { LineStage } from "../../../../lib/line/lineWorkspaceUrl";
import type { LineViewProps } from "../views/types";
import "./stages.css";

type Tone = "live" | "quiet" | "bad" | "warn" | "you" | undefined;
type Tile = { key: LineStage | "stations" | "decision"; name: string; n: ReactNode; unit: string; lines: Array<{ text: ReactNode; tone?: Tone }>; tone?: Tone; href?: string };

export const FlowBand = memo(function FlowBand({ model, workspace: ws, selection, select, href, projectId }: Pick<LineViewProps, "model" | "workspace" | "selection" | "select" | "href"> & { projectId: string | null }) {
  useSyncLineStages(projectId);
  useSyncProjectExpectations(projectId);
  const st = useLineStages(projectId);
  const exp = useProjectExpectations(projectId);
  const trial = useTrialProjects().find((p) => p._id === projectId) ?? null;
  const runs = useTrialRuns();
  const now = ws.now;
  const line = model.graphKey;

  const tiles = useMemo<Tile[]>(() => {
    const arrival = st ? sumArrivals(st.kinds, now) : null;
    const failed = st?.kinds.reduce((n, k) => n + k.counts.failed, 0) ?? 0;
        const live = st?.judges.filter((j) => !j.removed_at) ?? [];
    const week = live.reduce((a, j) => ({ runs: a.runs + j.week.runs, filed: a.filed + j.week.filed, failed: a.failed + j.week.failed, usd: a.usd + j.week.cost_usd }), { runs: 0, filed: 0, failed: 0, usd: 0 });
    const active = exp?.doc?.items.filter((e) => e.status === "active").length ?? null;
    const proposals = openProposals(exp).length;
    const mix = placementMix(ws.everySignals as never, projectId, now - 7 * DAY);
    const opened = mix.find((m) => m.key === "new")?.n ?? 0;
    const placed = mix.reduce((n, m) => n + m.n, 0);
    const running = runs.filter((r) => r.project_id === projectId && (r.status === "running" || r.status === "pending")).length;
    const d = trial?.dispatch;
    const forYou = forYouOfLine(ws.needs, line, ws.project?._id ?? null);
    const liveRuns = model.runs.filter((r) => r.status === "running" || r.status === "pending").length;
    // Each card: its name, one number, and at most two lines that fit a glance whole.
    return [
      {
        key: "moments", name: "Moments", n: arrival ? arrival.today : "–", unit: "today",
        tone: arrival?.tone === "live" ? "live" : arrival ? "quiet" : undefined,
        lines: !arrival ? [{ text: "reading…" }] : [
          // Nothing arriving is said plainly: when the last one came, never a rate that reads as traffic.
          arrival.tone === "live" ? { text: `${arrival.week.toLocaleString("en-US")} this week` } : { text: arrival.lastAt ? `last ${agoWords(arrival.lastAt, now)} ago` : "none yet", tone: "warn" },
          ...(failed ? [{ text: `${failed} failed`, tone: "bad" as Tone }] : []),
        ],
      },
      {
        key: "expectations", name: "Expectations", n: active ?? "–", unit: "lines",
        lines: [{ text: versionWords(exp?.current_version) ?? "none yet" }, ...(proposals ? [{ text: `${proposals} proposed`, tone: "you" as Tone }] : [])],
      },
      {
        key: "judges", name: "Judges", n: live.length || "–", unit: live.length === 1 ? "judge" : "judges",
        tone: week.failed ? "bad" : undefined,
        lines: !st ? [{ text: "reading…" }] : [
          { text: `${week.runs.toLocaleString("en-US")}${live.some((j) => j.week_capped) ? "+" : ""} reads /wk` },
          week.failed ? { text: `${week.failed} failed`, tone: "bad" } : { text: `${week.filed} filed /wk` },
        ],
      },
      {
        key: "grouping", name: "Grouping", n: ws.open, unit: "open",
        lines: [{ text: `${placed} placed /wk` }, { text: `${opened} new /wk` }],
      },
      {
        key: "dispatch", name: "Dispatch", n: <>{running}<small>/10</small></>, unit: "running",
        tone: d?.held ? "warn" : running ? "live" : undefined,
        lines: d === undefined ? [{ text: "not a trial" }] : !d ? [{ text: "starts nothing", tone: "warn" }] : [
          d.held ? { text: `held: ${d.held.split(/[:\s]/)[0]}`, tone: "warn" } : { text: "not held" },
          { text: `cap ${usd(d.cap_usd)}` },
        ],
      },
      {
        key: "stations", name: "Stations", n: model.runs.length, unit: "runs",
        tone: liveRuns ? "live" : undefined,
        lines: [{ text: `${liveRuns} running` }],
      },
      {
        // What For you lists for this line, its trial practice decisions included; it opens on exactly those.
        key: "decision", name: "Decision", n: forYou.total, unit: "for you", tone: forYou.total ? "you" : undefined,
        href: href({ view: "foryou", process: line, step: null, show: null, stage: null }),
        lines: forYou.practice ? [{ text: `${forYou.total - forYou.practice} real · ${forYou.practice} trial` }] : [{ text: "to answer" }],
      },
    ];
  }, [st, exp, ws.everySignals, ws.open, ws.needs, ws.project, projectId, now, runs, trial, line, model.runs, model.order, href]);

  const open = selection.stage;
  const tile = (t: Tile) => {
    const body = (
      <>
        <span className="lf-name">{t.name}{t.tone && <i className="lf-dot" data-tone={t.tone} data-pulse={t.tone === "live" ? "" : undefined} aria-hidden />}</span>
        <span className="lf-n"><b className="lw-num">{typeof t.n === "number" ? t.n.toLocaleString("en-US") : t.n}</b><span>{t.unit}</span></span>
        {t.lines.map((l, i) => <span key={i} className="lf-line" data-tone={l.tone}>{l.text}</span>)}
      </>
    );
    if (t.href) return <a key={t.key} className="lf-tile" href={t.href} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select({ view: "foryou", process: line, stage: null, step: null }); }} data-line-flow-stage={t.key}>{body}</a>;
    // The stations are the graph below: pressing them closes what is open over it.
    if (t.key === "stations") return <button key={t.key} type="button" className="lf-tile" onClick={() => select({ stage: null, step: null })} data-line-flow-stage={t.key}>{body}</button>;
    const key = t.key as LineStage;
    return (
      <a key={t.key} className="lf-tile" aria-current={open === key ? "true" : undefined} href={href({ stage: key, item: null })}
        onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select(open === key ? { stage: null } : { stage: key, item: null }); }} data-line-flow-stage={t.key}>
        {body}
      </a>
    );
  };
  const arrow = (k: string) => <ArrowRight key={`a-${k}`} className="lf-arrow" aria-hidden />;
  const stream = tiles.slice(0, 4);
  const perProblem = tiles.slice(4);
  return (
    <section className="lf" aria-label="The flow, end to end" data-line-flow data-squeezed={selection.stage || selection.step ? "" : undefined}>
      <div className="lf-seg" data-seg="stream">
        <span className="lf-seg-h">Per moment</span>
        <div className="lf-row">{stream.flatMap((t, i) => (i ? [arrow(t.key), tile(t)] : [tile(t)]))}</div>
      </div>
      {arrow("into")}
      <div className="lf-seg" data-seg="run">
        <span className="lf-seg-h">Per problem</span>
        <div className="lf-row">{perProblem.flatMap((t, i) => (i ? [arrow(t.key), tile(t)] : [tile(t)]))}</div>
      </div>
    </section>
  );
});
