// One Multiplayer sim run in full (docs/architecture/evals-ui.md 4.7): what
// broke, the deliveries as lanes with a playhead, the recorded order and its
// shrink, the replay lines, and what errored on the way. Props only; the page
// (pages/SimRunPage.tsx) loads the run and starts a shrink.

import { useEffect, useMemo, useState } from "react";
import { GitBranch, Pause, Play, Scissors } from "lucide-react";
import type { SimFailureResult, SimRunResponse } from "@codecast/shared/contracts/evalsApi";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { formatShortcutParts, getShortcutsForAction, useShortcutAction, useShortcutContext, type ShortcutAction } from "../../shortcuts";
import { useTabActive } from "../../hooks/usePagePresence";
import { evalsHref } from "./evalsPaths";
import { CopyCommand, EvalsLink, LogTail, StallChip, VerdictGlyph } from "./parts";
import { plural, shortSha, whenLabel } from "@platform/evals/client";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { DeliveryTimeline } from "./DeliveryTimeline";
import { OrderStrip } from "./OrderStrip";
import { parseOrder } from "../../store/__tests__/sim/replay";
import { splitOrderLine } from "../../store/__tests__/sim/shrink";
import { SimLabels } from "../../store/__tests__/sim/labels";
import { buildTimeline, failIndex, feedTone, keptIndexes, rowDiffSides, splitRowDiff, traceLabels } from "./simLanes";
import "./sim.css";
import { PLAY_STEP_MS } from "./simModel";
import { isJobStalled, type JobState } from "./simJobState";

export type ShrinkState = JobState;

export interface SimRunViewProps {
  data: SimRunResponse;
  shrink: ShrinkState;
  onShrink: () => void;
  /** Whether this pane answers the arrow keys (the active pane). */
  keysActive?: boolean;
}

const isFailure = (r: SimRunResponse["result"]): r is SimFailureResult => r.passed !== true;
const seconds = (ms: number | undefined) => (ms === undefined ? null : ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 1000).toFixed(1)} s`);

export function SimRunView({ data, shrink, onShrink, keysActive = true }: SimRunViewProps) {
  const { result, session, run, minimal, shrinking } = data;
  const failure = isFailure(result) ? result : null;
  const timeline = useMemo(() => buildTimeline(data.events, data.world), [data.events, data.world]);
  const labels = useMemo(() => SimLabels.from({ ...(data.world?.labels ?? {}), ...(failure?.labels ?? {}) }), [data.world, failure]);
  const failAt = failure ? failIndex(failure.delivery, timeline.count) : null;
  const order = useMemo(() => splitOrderLine(parseOrder(failure?.order ?? "")), [failure]);
  const recorded = order.channels.length ? order.channels : timeline.marks.map((m) => m.channel);
  const kept = useMemo(() => keptIndexes(recorded.length, minimal?.removed), [recorded.length, minimal]);
  const traces = useMemo(() => traceLabels(timeline.marks, labels), [timeline.marks, labels]);

  const [playhead, setPlayhead] = useState<number | null>(failAt);
  const [playing, setPlaying] = useState(false);
  const [trace, setTrace] = useState<string | null>(null);
  const [showKept, setShowKept] = useState(true);
  const last = timeline.count - 1;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setPlayhead((p) => {
        const next = p === null ? 0 : p + 1;
        if (next >= last) setPlaying(false);
        return Math.min(next, last);
      });
    }, PLAY_STEP_MS);
    return () => clearInterval(id);
  }, [playing, last]);

  const move = (to: number) => {
    setPlaying(false);
    setPlayhead(Math.max(0, Math.min(last, to)));
  };
  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (playhead === null || playhead >= last) setPlayhead(0);
    setPlaying(true);
  };

  const active = useTabActive() && keysActive && timeline.count > 0;
  useShortcutContext("evalsSim", active);
  useShortcutAction("evalsSim.prev", () => (active ? move((playhead ?? 0) - 1) : false));
  useShortcutAction("evalsSim.next", () => (active ? move(playhead === null ? 0 : playhead + 1) : false));
  useShortcutAction("evalsSim.first", () => (active ? move(0) : false));
  useShortcutAction("evalsSim.last", () => (active ? move(failAt ?? last) : false));
  useShortcutAction("evalsSim.play", () => (active ? togglePlay() : false));

  const at = playhead === null ? null : timeline.marks[playhead] ?? null;
  const stepAt = at ? [...timeline.steps].reverse().find((s) => s.at <= at.i) ?? null : null;

  return (
    <div className="ev-page evs-page" data-evals-page="sim-run" data-evs-result={failure ? "fail" : "pass"}>
      <nav className="evs-crumbs" aria-label="Where this run sits">
        <EvalsLink href={evalsHref.sim()}>Multiplayer sim</EvalsLink>
        <span>/</span>
        <span title={`Session ${session.id}`}>{session.unsessioned ? session.id : `session ${whenLabel(session.startedAt)}`}</span>
        {session.unsessioned && <span className="ev-chip">unsessioned, read-only</span>}
      </nav>

      <header className="evs-head">
        <h1 className="ev-page-title">
          <VerdictGlyph state={failure ? "fail" : "pass"} size={14} />
          <span className="ev-mono">{run.scenario}</span>
        </h1>
        <span className="ev-chips">
          <span className="ev-chip">{run.mode}</span>
          <span className="ev-chip">seed {run.seed}</span>
          <span className="ev-chip" title={result.gitHead ?? session.gitHead ?? "no head recorded"}>
            <GitBranch /> {shortSha(result.gitHead ?? session.gitHead)}
          </span>
          {(result.dirty ?? session.dirty) &&
            (session.treePatch ? (
              <EvalsLink className="ev-chip ev-chip--dirty" href={evalsHref.patch(session.treePatch)} title={`Uncommitted edits, kept as trees/${session.treePatch}.patch.gz: open them`}>
                dirty, patch {shortSha(session.treePatch, 6)}
              </EvalsLink>
            ) : (
              <span className="ev-chip ev-chip--dirty" title="Uncommitted edits, no patch kept">
                dirty
              </span>
            ))}
          {seconds(result.realMs ?? run.ms) && <span className="ev-chip">{seconds(result.realMs ?? run.ms)}</span>}
          {failure?.expected && (
            <EvalsLink className="ev-chip" href={`/tasks/${failure.expected}`} title="A red marker expected this failure">
              expected, red {failure.expected}
            </EvalsLink>
          )}
        </span>
        <div className="evs-head-stats">
          <div className="evs-stat">
            <b>{timeline.count}</b>
            <span>deliveries</span>
          </div>
          {minimal && (
            <div className="evs-stat" data-evs-needed>
              <b>{minimal.order.length}</b>
              <span>needed</span>
            </div>
          )}
          <div className="evs-stat">
            <b>{timeline.steps.length}</b>
            <span>steps</span>
          </div>
        </div>
      </header>

      {failure ? <FailureCard failure={failure} data={data} labels={labels} /> : <div className="ev-card px-4 py-3 text-[12.5px]">Passed after {timeline.count} deliveries. Kept with --keep, so its lanes are here to read.</div>}

      <section className="ev-card evs-tape" data-evs-tape>
        <div className="evs-tape-bar">
          <button type="button" className="ev-btn ev-btn--lg" onClick={togglePlay} disabled={!timeline.count} data-evs-play={playing ? "playing" : "paused"}>
            {playing ? <Pause /> : <Play />}
            {playing ? "Pause" : "Play"}
          </button>
          <span className="evs-keys">
            <ActionKeys action="evalsSim.prev" />
            <ActionKeys action="evalsSim.next" />
            step
            <ActionKeys action="evalsSim.play" />
            play
          </span>
          {minimal && (
            <label className="evs-keys" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={showKept} onChange={(e) => setShowKept(e.target.checked)} data-evs-show-kept />
              dim what the shrink removed
            </label>
          )}
          <span className="flex-1" />
          <span className="evs-legend" aria-label="Live feeds">
            {timeline.feeds.map((f) => (
              <span key={f}>
                <i style={{ background: feedTone(timeline.feeds, f) }} />
                {f || "live"}
              </span>
            ))}
          </span>
        </div>
        {traces.length > 0 && (
          <div className="evs-tape-bar evs-trace" data-evs-trace={trace ?? ""}>
            <span className="evs-note">Trace a label</span>
            {traces.map((t) => (
              <button key={t.label} type="button" className="ev-chip" aria-pressed={trace === t.label} onClick={() => setTrace(trace === t.label ? null : t.label)} title={`${t.count} deliveries touch ${t.label} (--trace ${t.label})`}>
                {t.label} <span className="ev-tabular evs-readout-dim">{t.count}</span>
              </button>
            ))}
          </div>
        )}
        <div className="evs-readout" data-evs-readout={at?.i ?? ""}>
          {at ? (
            <>
              <span className="evs-readout-n">
                #{at.i + 1} <span className="evs-readout-dim font-normal">of {timeline.count}</span>
              </span>
              <code>{at.channel}</code>
              <span>{at.label}</span>
              <span className="evs-readout-dim">
                by <code>{at.producer}</code>, enqueued #{at.seq}
              </span>
              {stepAt && <span className="evs-readout-dim">in step: {stepAt.label}</span>}
              {kept && <span className={kept.has(at.i) ? "ev-pass" : "evs-readout-dim"}>{kept.has(at.i) ? "needed" : "removed by the shrink"}</span>}
              {failAt === at.i && <span className="ev-fail">the check failed after this delivery</span>}
            </>
          ) : (
            <span className="evs-readout-dim">Drag across the lanes, or use the arrow keys, to step one delivery at a time.</span>
          )}
        </div>
        {timeline.count ? (
          <DeliveryTimeline timeline={timeline} failAt={failAt} failLabel={failure?.invariant.id ?? ""} playhead={playhead} onPlayhead={move} kept={kept} showKept={showKept} trace={trace} labels={labels} />
        ) : (
          <div className="px-4 py-6 text-[12px] ev-quiet">No deliveries recorded: the failure came before the first one.</div>
        )}
      </section>

      {failure && (
        <section className="ev-card">
          <OrderStrip channels={recorded} scripted={order.mark !== null} minimal={minimal} failAt={failAt} playhead={playhead} onPick={move} feeds={timeline.feeds} />
          <ShrinkBar minimal={!!minimal} shrinking={shrinking} shrink={shrink} onShrink={onShrink} recorded={recorded.length} />
        </section>
      )}

      <section className="ev-card evs-replay" data-evs-replay>
        <span>Trace</span>
        <CopyCommand command={data.replay.trace} />
        <span>Full order</span>
        <CopyCommand command={data.replay.order} />
        <span>Minimal order</span>
        {data.replay.minimal ? <CopyCommand command={data.replay.minimal} /> : <span className="evs-note">After a shrink, the shortest order that still fails the same way.</span>}
        {data.replay.bisect && (
          <>
            <span title="Probes each commit between the newest clean session where this passed and this run, deterministically: no reps, no spend">Bisect this failure</span>
            <span className="flex flex-col gap-1" data-evs-bisect-line>
              <CopyCommand command={data.replay.bisect} />
              <span className="evs-note">Free: it names the commit that broke this run. Run it from the checkout root.</span>
            </span>
          </>
        )}
      </section>

      {data.final && <FinalDetails final={data.final} />}
    </div>
  );
}

/** A registered shortcut's keys as keycaps, read from the registry so the hint never drifts from the binding. */
function ActionKeys({ action }: { action: ShortcutAction }) {
  const def = getShortcutsForAction(action)[0];
  if (!def) return null;
  return (
    <>
      {formatShortcutParts(def).map((k) => (
        <KeyCap key={k} size="xs">
          {k}
        </KeyCap>
      ))}
    </>
  );
}

function FailureCard({ failure, data, labels }: { failure: SimFailureResult; data: SimRunResponse; labels: SimLabels }) {
  const meaning = data.invariant?.meaning ?? failure.invariant.meaning;
  const sides = rowDiffSides(failure.invariant.id, failure.window?.name, data.world);
  const [showOmitted, setShowOmitted] = useState(false);
  const split = failure.row ? splitRowDiff(failure.row.diff, { message: failure.message, keys: data.invariant?.keys }) : null;
  const rows = split ? (showOmitted ? [...split.shown, ...split.omitted] : split.shown) : [];
  return (
    <section className="ev-card evs-fail" data-evs-failure={failure.invariant.id}>
      <div className="evs-fail-main">
        <div className="evs-fail-inv">
          <b>{failure.invariant.id}</b>
          {data.invariant?.keys.length ? <span className="evs-note">compares {data.invariant.keys.join(", ")}</span> : null}
        </div>
        <div className="evs-fail-meaning">{meaning}</div>
        <div className="evs-fail-where">
          At step <b>{failure.step}</b>, after <b className="ev-tabular">{failure.delivery}</b> deliveries.
        </div>
        {failure.message && <div className="evs-fail-msg">{failure.message}</div>}
        {failure.window && (
          <span className="ev-chips">
            <span className="ev-chip" title="The window the check read">window {failure.window.name}</span>
            <span className="ev-chip" title={`Who the window is signed in as (${failure.window.principal})`}>as {labels.relabel(failure.window.principal)}</span>
            <span className="ev-chip" title="The scope it held">{failure.window.scope}</span>
          </span>
        )}
      </div>
      <div className="evs-fail-diff">
        {failure.row ? (
          <>
            <div className="evs-diff-head">
              <code>{failure.row.table}</code>
              <span>{failure.row.label}</span>
              <span className="flex-1" />
              <span>{plural(split!.shown.length, "field")} {split!.shown.length === 1 ? "differs" : "differ"}</span>
            </div>
            <table className="evs-diff">
              <thead>
                <tr>
                  <th>field</th>
                  <th>{sides.server}</th>
                  <th>{sides.replica}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.field}>
                    <td>{d.field}</td>
                    <td className="evs-srv">{d.server}</td>
                    <td className="evs-rep">{d.replica}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {split!.omitted.length > 0 && (
              <button type="button" className="ev-btn evs-diff-more" aria-expanded={showOmitted} onClick={() => setShowOmitted((v) => !v)} data-evs-omitted={split!.omitted.length}>
                {showOmitted ? "Hide" : "Show"} {plural(split!.omitted.length, "field")} one side lacks and the other leaves empty
              </button>
            )}
          </>
        ) : (
          <div className="px-4 py-2 text-[12px] ev-quiet">The check names no row: the invariant holds over the whole window.</div>
        )}
      </div>
    </section>
  );
}

function ShrinkBar({ minimal, shrinking, shrink, onShrink, recorded }: { minimal: boolean; shrinking: SimRunResponse["shrinking"]; shrink: ShrinkState; onShrink: () => void; recorded: number }) {
  const running = !!shrinking || shrink.state === "running" || shrink.state === "starting";
  const job = shrink.state === "running" ? shrink.job : null;
  const now = useCoarseNow(30_000);
  const stalled = !!job && isJobStalled(job, now);
  return (
    <div className="evs-sweep" style={{ borderTop: "1px solid var(--ev-rule)" }} data-evs-shrink={minimal ? "done" : running ? "running" : shrink.state}>
      {running ? (
        <span className="evs-job" role="status">
          <Scissors className={`w-3.5 h-3.5 ${stalled ? "" : "ev-pulse"}`} />
          {shrinking
            ? `Shrinking, ${shrinking.phase === "prefix" ? "cutting the prefix" : "removing single deliveries"}: ${shrinking.attempts} attempts, shortest failing order ${shrinking.best} of ${shrinking.recorded}`
            : job
              ? job.progress.text || "Shrinking..."
              : "Starting the shrink..."}
          {job?.tmux && <code className="ev-mono">tmux {job.tmux}</code>}
          {stalled && <StallChip since={job!.updatedAt} data-evs-stalled />}
        </span>
      ) : (
        <>
          <button type="button" className="ev-btn ev-btn--lg ev-btn--go sol-btn-solid" onClick={onShrink} data-evs-shrink-button>
            <Scissors />
            {minimal ? "Shrink again" : "Shrink"}
          </button>
          <span className="evs-note">
            {minimal
              ? "The shrink's minimal order is above; a new one replaces it."
              : `Finds the shortest delivery order that still fails the same invariant on the same row. Up to 400 attempts or 10 minutes over ${recorded} deliveries.`}
          </span>
          {shrink.state === "failed" && <span className="ev-fail text-[11.5px]">{shrink.error}</span>}
          {shrink.state === "failed" && <LogTail lines={shrink.logTail ?? []} label="What the shrink printed before it ended" data-evs-shrink-log />}
        </>
      )}
    </div>
  );
}

function FinalDetails({ final }: { final: NonNullable<SimRunResponse["final"]> }) {
  const calls = final.calls.filter((c) => !c.ok);
  const actors = final.actors.filter((a) => !a.ok);
  const windows = Object.entries(final.windowErrors).filter(([, errs]) => errs.length);
  const count = calls.length + actors.length + windows.reduce((n, [, e]) => n + e.length, 0);
  return (
    <details className="ev-card evs-details" data-evs-final={count}>
      <summary>
        <VerdictGlyph state={count ? "fail" : "pass"} size={11} />
        What errored on the way
        <span className="evs-note">
          {count ? `${plural(calls.length, "call")}, ${plural(actors.length, "actor verb")}, ${plural(windows.length, "window")}` : "nothing"}, {final.writesSpent} server writes spent
        </span>
      </summary>
      <div className="evs-details-body">
        {calls.length > 0 && (
          <div>
            <div className="evs-section-title">Calls</div>
            {calls.map((c) => (
              <div key={`${c.seq}:${c.name}`} className="evs-err-row">
                <span>
                  #{c.seq} {c.kind} {c.name}
                </span>
                <span>{c.error ?? "failed"}</span>
              </div>
            ))}
          </div>
        )}
        {actors.length > 0 && (
          <div>
            <div className="evs-section-title">Actor verbs</div>
            {actors.map((a, k) => (
              <div key={k} className="evs-err-row">
                <span>
                  {a.actor} {a.verb}
                </span>
                <span>{a.error ?? "failed"}</span>
              </div>
            ))}
          </div>
        )}
        {windows.length > 0 && (
          <div>
            <div className="evs-section-title">Window errors</div>
            {windows.flatMap(([w, errs]) =>
              errs.map((e, k) => (
                <div key={`${w}:${k}`} className="evs-err-row">
                  <span>{w}</span>
                  <span>{e}</span>
                </div>
              )),
            )}
          </div>
        )}
        {!count && <span className="ev-quiet">Every call, verb and window ran clean.</span>}
      </div>
    </details>
  );
}
