"use client";
// The Replay view (line-workspace.md LW1): a real case played through the
// line like a debugger, ported from the Replay prototype. On the left the
// cases, each with its runs and how each ended; in the middle the line as a
// rail with the run's path drawn over it; on the right the step under the
// playhead (what it decided and why, its prompt, what it was handed), where it
// can be marked wrong, edited, handed to an agent or re-run on this case;
// along the bottom the transport (play, step, scrub, speed; Space and the
// arrows). The playhead is this view's own, so playing never rewrites the
// address; with the step drawer open the drawer follows the playhead, and a
// step chosen in the drawer moves the playhead to it.
import { useCallback, useMemo, useRef, useState } from "react";
import { decisionId, type LineRunModel } from "../../../../lib/line/lineModel";
import { openingVisit, runEndWords, visitOf } from "../../../../lib/line/replay";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { hasOpenModal } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { dayWords, durationWords } from "../../widgets";
import { useStepDrafts } from "../stepDrafts";
import { ReplayCases } from "./replay/ReplayCases";
import { ReplayRail } from "./replay/ReplayRail";
import { ReplayStep } from "./replay/ReplayStep";
import { ReplayTransport } from "./replay/ReplayTransport";
import type { LineViewProps } from "./types";
import "./replay/replay.css";

const SPEEDS = [1, 2, 4] as const;
const BEAT_MS = 1100;

export function ReplayView({ model, selection, select }: LineViewProps) {
  const run: LineRunModel | null = useMemo(() => {
    if (selection.run) {
      const r = model.runs.find((x) => x.id === selection.run);
      if (r) return r;
    }
    if (selection.case) {
      const r = model.runs.find((x) => x.caseId === selection.case);
      if (r) return r;
    }
    return model.runs.find((r) => r.visits.length > 0) ?? model.runs[0] ?? null;
  }, [model.runs, selection.run, selection.case]);

  const drawerOpen = !!selection.step && !!model.steps[selection.step];
  const visits = run?.visits ?? [];

  // The playhead: this view's own, reset when the run changes.
  const [head, setHead] = useState<{ run: string; i: number } | null>(null);
  const cur = !run || !visits.length ? 0
    : head?.run === run.id ? Math.min(head.i, visits.length - 1)
    : openingVisit(visits, selection.step);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [allExits, setAllExits] = useState(false);
  const [rerun, setRerun] = useState<{ run: string; node: string } | null>(null);

  const go = useCallback((i: number) => {
    if (!run || !run.visits.length) return;
    const to = Math.max(0, Math.min(run.visits.length - 1, i));
    setHead((h) => (h?.run === run.id && h.i === to ? h : { run: run.id, i: to }));
    const node = run.visits[to].node;
    if (drawerOpen && node !== selection.step) select({ step: node });
  }, [run, drawerOpen, selection.step, select]);

  // A step chosen elsewhere (the drawer's arrows, a route chip) moves the playhead to its visit.
  const [seenStep, setSeenStep] = useState(selection.step);
  if (selection.step !== seenStep) {
    setSeenStep(selection.step);
    if (run && selection.step && visits[cur]?.node !== selection.step) {
      const j = visitOf(visits, selection.step, cur);
      if (j >= 0) setHead({ run: run.id, i: j });
    }
  }

  // Playing: a beat per step, faster at 2x and 4x, stopping at the end or at a person still to answer.
  const live = useRef({ cur, go, visits });
  live.current = { cur, go, visits };
  useWatchEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const { cur: c, go: g, visits: vs } = live.current;
      if (c >= vs.length - 1 || vs[c]?.status === "waiting") { setPlaying(false); return; }
      g(c + 1);
    }, BEAT_MS / speed);
    return () => clearInterval(t);
  }, [playing, speed]);

  const togglePlay = useCallback(() => {
    if (!playing && cur >= visits.length - 1) go(0);
    setPlaying((p) => !p);
  }, [playing, cur, visits.length, go]);
  const stepTo = useCallback((i: number) => { setPlaying(false); go(i); }, [go]);
  const nextSpeed = useCallback(() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s as 1) + 1) % SPEEDS.length]), []);

  // Keys: Space plays, the arrows step (the drawer's own when it is open), Home and End jump.
  const active = useTabActive();
  useWatchEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (drawerOpen) return;
      else if (e.key === "ArrowRight") { e.preventDefault(); stepTo(cur + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); stepTo(cur - 1); }
      else if (e.key === "Home") { e.preventDefault(); stepTo(0); }
      else if (e.key === "End") { e.preventDefault(); stepTo(visits.length - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, togglePlay, stepTo, drawerOpen, cur, visits.length]);

  const pickRun = useCallback((r: LineRunModel) => {
    setPlaying(false);
    setRerun(null);
    setHead({ run: r.id, i: openingVisit(r.visits, null) });
    select({ run: r.id }, r.caseId);
  }, [select]);

  const onRailStep = useCallback((id: string) => {
    const j = visitOf(visits, id, cur);
    if (j >= 0) { setPlaying(false); go(j); }
    else select({ step: id });
  }, [visits, cur, go, select]);
  const openStep = useCallback((id: string) => select({ step: id }), [select]);

  // Decisions on this run someone marked wrong, and steps with an unsaved edit: marks on the rail and the scrubber.
  const wrong = useMemo(() => {
    const s = new Set<string>();
    if (run) for (const v of run.visits) if (model.steps[v.node]?.decisions.find((d) => d.id === decisionId(run.id, v.node))?.label?.verdict === "wrong") s.add(v.node);
    return s;
  }, [model.steps, run]);
  const drafts = useStepDrafts();
  const drafted = useMemo(() => new Set(Object.keys(drafts)), [drafts]);

  if (!model.runs.length || !run) {
    return <div className="lw-empty" data-line-view="replay"><b>No runs to replay yet</b>A run of this line shows here once one starts, and plays a step at a time.</div>;
  }
  const v = visits[cur];
  const issue = run.caseId ? model.issues.find((i) => i.id === run.caseId) : null;
  const meta = [
    issue && issue.findings > 0 ? `${issue.findings} ${issue.findings === 1 ? "finding" : "findings"}` : null,
    runEndWords(run),
    dayWords(run.at),
    durationWords(run.durationMs),
  ].filter(Boolean).join(" · ");

  return (
    <div className="rp" data-line-view="replay" data-drawer={drawerOpen ? "" : undefined}>
      <div className="rp-grid">
      <ReplayCases model={model} runId={run.id} onRun={pickRun} />

      <header className="rp-casehead">
        <div className="rp-ch-text">
          <span className="rp-ch-title" title={run.caseTitle}>{run.caseTitle}</span>
          <span className="rp-ch-meta">{run.caseRef && <b>{run.caseRef}</b>}{meta}</span>
        </div>
        {run.caseId && <button type="button" className="lw-act" onClick={() => select({ view: "timeline", case: run.caseId })}>Its timeline</button>}
      </header>

      <section className="rp-railwrap" aria-label="The line">
        <div className="rp-legend">
          <span className="lw-kind" data-kind="agent">agent</span>
          <span className="lw-kind" data-kind="script">script</span>
          <span className="lw-kind" data-kind="person">you</span>
          <button type="button" className="lw-filter rp-exits" aria-pressed={allExits} onClick={() => setAllExits((x) => !x)} title="Every way the graph allows, not only the ones this case took">All exits</button>
        </div>
        <ReplayRail model={model} run={run} cur={cur} wrong={wrong} drafted={drafted} allExits={allExits} onStep={onRailStep} />
      </section>

      <main className="rp-inspector">
        {v ? (
          <ReplayStep
            key={`${run.id}:${cur}`}
            model={model}
            run={run}
            visit={v}
            openStep={openStep}
            onNext={() => stepTo(cur + 1)}
            onJump={stepTo}
            rerunning={rerun?.run === run.id && rerun.node === v.node}
            setRerunning={(on) => setRerun(on ? { run: run.id, node: v.node } : null)}
          />
        ) : (
          <div className="lw-empty"><b>Not started</b>{run.outcome.text}</div>
        )}
      </main>

      {visits.length > 0 && (
        <ReplayTransport run={run} cur={cur} playing={playing} speed={speed} wrong={wrong} onGo={stepTo} onPlay={togglePlay} onSpeed={nextSpeed} />
      )}
      </div>
    </div>
  );
}
