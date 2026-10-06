// One surface over time (docs/architecture/evals-ui.md 4.2), props only: the
// header, the filters, the seismograph with its cost track, the freeze ledger,
// the compare drawer and the epoch sheet. pages/SurfacePage.tsx connects it;
// the mount test and the fixture drive it directly.
//
// Pinning lives in the URL (?batch= and ?compare=), so a pinned pair is a link.
// The zoom, the axis and the facet are this view's own.
//
// The header shows what the product's surface carries: its gate when the
// product decides one, its route and model when it has them, and the freeze
// counts and a check's reps and cost cap when its sources add them (codecast).
// A key or a toggle for something the product cannot answer (attribution,
// bisect probes, epochs) is left out, by the capabilities on GET /health.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Globe, Lock } from "lucide-react";
import { batchLabel, baselineWords, newestBaseline, nextPins, noiseFlipWords, noiseFlipsShort, orderedPair, score2, separationTitle, shortModel, surfaceColumns, usd, verdictOfSet, type SurfaceAxis, type SurfaceCadence, type SurfaceFilters } from "../../client";
import { flipCounts, type BatchStats, type BatchVerdict, type BatchesResponse, type EpochResponse, type SurfaceInfo, type SurfaceResponse } from "../../contract";
import { ComparePanel, EpochDiffSheet, FreezeLedger } from "../freeze";
import { useEvalsCapabilities, useEvalsHost, useEvalsPaths } from "../hooks";
import { CostTrack } from "../run";
import { EvalsLink, SeparationMark, VerdictGlyph } from "../shell/parts";
import { GateChip } from "./GateChip";
import { Seismograph } from "./Seismograph";

/**
 * The header's fields beyond the neutral ones. The query adds the freeze
 * counts for a product that keeps freezes, and a product's own `info` may add
 * the rest (codecast: criteria, sources, reps, maxUsdPerRep). Each shows only
 * when present.
 */
export type SurfaceHeaderInfo = SurfaceInfo & {
  freezes?: { public: number; private: number };
  criteria?: string | null;
  sources?: string[];
  reps?: { check: number };
  maxUsdPerRep?: number;
};

export interface Loaded<T> {
  res: T | null;
  loading: boolean;
  error: string | null;
}

export interface SurfaceViewProps {
  data: SurfaceResponse;
  /** Every model this surface has run on, for the filter (kept across filtered answers). */
  models: string[];
  filters: SurfaceFilters;
  onFilters: (next: SurfaceFilters) => void;
  /** The pinned batch and the second pinned to compare against it (the URL's ?batch and ?compare). */
  pinned: string | null;
  compare: string | null;
  onPins: (pinned: string | null, compare: string | null) => void;
  /** GET /batches for the pinned pair. */
  batches: Loaded<BatchesResponse>;
  /** The epoch sheet: which epoch is open and GET /epoch for it. */
  epoch: Loaded<EpochResponse> & { n: number | null };
  onEpoch: (n: number | null) => void;
  onNavigate: (href: string) => void;
  /** This pane owns the keyboard. */
  keysActive: boolean;
  /** A refetch for new filters is in flight; the last answer stays on screen. */
  refreshing?: boolean;
}

/**
 * What the wall said about this surface, said again where its link lands:
 * the latest batch's verdict, what it was weighed against, and one click to
 * pin that comparison.
 */
function LatestVerdict({ v, stats, pinned, compare, onPins }: { v: BatchVerdict; stats: readonly BatchStats[]; pinned: string | null; compare: string | null; onPins: (pinned: string | null, compare: string | null) => void }) {
  const words = baselineWords(v.baseline);
  const base = newestBaseline(v, stats);
  const { broke, fixed, noise } = flipCounts(v.flips);
  const shown = (pinned === v.batch && compare === base) || (pinned === base && compare === v.batch);
  return (
    <div className="ev-sf-verdictline" data-ev-latest-verdict={v.separation.kind}>
      <div className="ev-sf-verdictline-main">
        <SeparationMark result={v.separation} showWord size={13} />
        <span className="ev-quiet ev-sf-nowrap" title={separationTitle(v)}>
          latest batch {batchLabel(v.batch, v.set.batchAt)}
        </span>
        {(broke > 0 || fixed > 0) && (
          <span className="ev-sf-nowrap" title="Freezes whose majority verdict changed against the baseline">
            {broke > 0 && <span className="ev-fail">{broke} broke</span>}
            {broke > 0 && fixed > 0 && ", "}
            {fixed > 0 && <span className="ev-pass">{fixed} fixed</span>}
          </span>
        )}
        {noise.length > 0 && (
          <span className="ev-sf-nowrap ev-quiet" title={noise.map(noiseFlipWords).join("\n")} data-ev-noise-flips={noise.length}>
            {noiseFlipsShort(noise)}
          </span>
        )}
        {v.unfooted && (
          <span className="ev-sf-nowrap ev-quiet" title="No rep on either side records its model or judge, so a change of model or judge cannot be told apart from a change of prompt" data-ev-unfooted>
            model and judge not on record
          </span>
        )}
        {base && !shown && (
          <button type="button" className="ev-btn" onClick={() => onPins(v.batch, base)} data-ev-compare-baseline title="Pin the latest batch and the newest batch of its baseline">
            Compare with its baseline
          </button>
        )}
      </div>
      <div className="ev-sf-verdictline-base ev-quiet" title={separationTitle(v)}>
        {words && v.baseline?.reps ? (
          <>
            <span className="ev-sf-basemark" aria-hidden />
            weighed against {words.long}
          </>
        ) : words ? (
          words.long
        ) : v.dry ? (
          "a dry render, weighed against nothing"
        ) : (
          "nothing earlier to weigh it against"
        )}
      </div>
    </div>
  );
}

function Toggle({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: ReactNode; title: string }) {
  return (
    <button type="button" className="ev-sf-toggle" aria-pressed={on} onClick={onClick} title={title}>
      <span className="ev-sf-toggle-box" aria-hidden />
      {children}
    </button>
  );
}

export function SurfaceView(props: SurfaceViewProps) {
  const { data, models, filters, onFilters, pinned, compare, onPins, batches, epoch, onEpoch, onNavigate, keysActive, refreshing } = props;
  const surface: SurfaceHeaderInfo = data.surface;
  const host = useEvalsHost();
  const { href: evalsHref } = useEvalsPaths();
  const can = useEvalsCapabilities();
  const { KeyCap, SegmentedToggle } = host.ui;
  const [axis, setAxis] = useState<SurfaceAxis>("time");
  const [facet, setFacet] = useState(false);
  const [zoom, setZoom] = useState<{ from: number; to: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const { ref: chartRef, width } = host.useContainerWidth(960);

  const inWindow = useMemo(() => {
    const sorted = [...data.batches].sort((a, b) => Date.parse(a.batchAt) - Date.parse(b.batchAt));
    return zoom ? sorted.filter((b) => Date.parse(b.batchAt) >= zoom.from && Date.parse(b.batchAt) <= zoom.to) : sorted;
  }, [data.batches, zoom]);
  const cols = useMemo(() => surfaceColumns(inWindow, axis, width), [inWindow, axis, width]);
  const graded = useMemo(() => cols.list.filter((c) => !c.stats.dry), [cols]);
  const runs = useMemo(() => (filters.dirty ? data.runs : data.runs.filter((r) => !r.dirty)), [data.runs, filters.dirty]);
  const allCols = useMemo(() => surfaceColumns(data.batches, "ordinal", 1000).byBatch, [data.batches]);
  const pair = pinned && compare && allCols.has(pinned) && allCols.has(compare) ? orderedPair(allCols, pinned, compare) : null;
  const freezeNames = useMemo(() => Object.fromEntries(data.ledger.map((r) => [r.freezeId, r.name])), [data.ledger]);
  const latest = [...data.batches].reverse().find((b) => !b.dry && b.reps > 0) ?? null;
  const totalFlips = data.ledger.reduce((s, r) => s + r.flips, 0);
  // The drawer's flips for the pinned pair, which the plate sorts and marks by.
  const pairRes = pair ? batches.res : null;
  const pairFlips = useMemo(() => (pairRes?.flips.ok ? new Map(pairRes.flips.flips.map((f) => [f.freezeId, f.direction])) : null), [pairRes]);
  const dirtyReps = data.runs.filter((r) => r.dirty).length;

  const pick = (batch: string, second: boolean) => {
    const [p, c] = nextPins(pinned, compare, batch, second);
    onPins(p, c);
  };

  const epochOf = (batch: string | null): number | null => {
    const at = batch ? allCols.get(batch)?.at : undefined;
    const sorted = [...data.epochs].sort((a, b) => a.n - b.n);
    if (at === undefined) return sorted.length ? sorted[sorted.length - 1].n : null;
    let n: number | null = null;
    for (const e of sorted) if (Date.parse(e.firstBatchAt) <= at) n = e.n;
    return n;
  };

  const attributeHref = (): string | null => {
    if (!can.attribution) return null;
    if (pair) return evalsHref.bisectNew({ surface: surface.id, good: pair[0], bad: pair[1] });
    if (!pinned) return null;
    const i = graded.findIndex((c) => c.batch === pinned);
    return i > 0 ? evalsHref.bisectNew({ surface: surface.id, good: graded[i - 1].batch, bad: pinned }) : null;
  };

  // The page's keys, while this pane owns the keyboard and no field or modal does.
  useEffect(() => {
    if (!keysActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || host.keysBusy(e.target)) return;
      const step = (d: number) => {
        if (!graded.length) return;
        const target = compare ?? pinned;
        const i = graded.findIndex((c) => c.batch === target);
        const next = graded[i < 0 ? graded.length - 1 : Math.max(0, Math.min(graded.length - 1, i + d))].batch;
        if (compare) onPins(pinned, next === pinned ? null : next);
        else onPins(next, null);
      };
      let done = true;
      if (e.key === "[") step(-1);
      else if (e.key === "]") step(1);
      else if (e.key === "e") {
        const n = can.epochs ? epochOf(compare ?? pinned) : null;
        if (n !== null) onEpoch(n);
        else done = false;
      } else if (e.key === "b") {
        const href = attributeHref();
        if (href) onNavigate(href);
        else done = false;
      } else if (e.key === "Escape" && (compare || pinned)) onPins(compare ? pinned : null, null);
      else done = false;
      if (done) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const zoomLabel = zoom ? `${new Date(zoom.from).toLocaleDateString(undefined, { month: "short", day: "numeric" })} to ${new Date(zoom.to).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : null;

  return (
    <div className={`ev-page ev-sf ${pair ? "ev-sf--compare" : ""}`} data-evals-page="surface" data-ev-surface={surface.id}>
      <header className="ev-sf-head">
        <div className="ev-sf-head-main">
          <nav className="ev-sf-crumb" aria-label="Breadcrumb">
            <EvalsLink href={evalsHref.home()}>Surfaces</EvalsLink>
            <ChevronRight />
            <span className="ev-mono">{surface.id}</span>
          </nav>
          <h1 className="ev-page-title">
            <VerdictGlyph state={latest ? verdictOfSet(latest.passed, latest.reps) : "unscored"} size={14} />
            {surface.title}
          </h1>
          <div className="ev-chips">
            {surface.gate && <GateChip gate={surface.gate} />}
            {surface.route && <span className="ev-chip" title="How the surface runs">{surface.route} route</span>}
            {surface.model && <span className="ev-chip" title="The pinned model">{surface.model}</span>}
            {surface.freezes && (
              <>
                <span className="ev-chip" title="Freezes committed with the code">
                  <Globe /> {surface.freezes.public} public
                </span>
                <span className="ev-chip ev-chip--private" title="Freezes kept only on this machine">
                  <Lock /> {surface.freezes.private} private
                </span>
              </>
            )}
            {surface.reps && surface.maxUsdPerRep !== undefined && (
              <span className="ev-chip" title="Reps per freeze in a check, and the most a rep may cost">
                {surface.reps.check} reps a freeze, at most {usd(surface.maxUsdPerRep)} a rep
              </span>
            )}
          </div>
          {data.latest && <LatestVerdict v={data.latest} stats={data.batches} pinned={pinned} compare={compare} onPins={onPins} />}
          {surface.criteria && (
            <div className="ev-sf-criteria">
              <button type="button" onClick={() => setCriteriaOpen((o) => !o)} aria-expanded={criteriaOpen} className="ev-sf-criteria-toggle">
                <ChevronRight />
                Criteria
              </button>
              {criteriaOpen ? (
                <div className="ev-sf-criteria-body">
                  <p>{surface.criteria}</p>
                  {!!surface.sources?.length && (
                    <div className="ev-chips">
                      {surface.sources.map((s) => (
                        <span key={s} className="ev-chip">{s}</span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <span className="ev-sf-criteria-peek">{surface.criteria}</span>
              )}
            </div>
          )}
        </div>
        {latest && (
          <div className="ev-sf-head-nums" data-ev-latest={latest.batch}>
            <div>
              <div className="ev-num">{latest.passRate === null ? "n/a" : `${Math.round(latest.passRate * 100)}%`}</div>
              <div className="ev-sf-num-label">passed, latest batch</div>
            </div>
            <div>
              <div className="ev-num">{score2(latest.median)}</div>
              <div className="ev-sf-num-label">median of {latest.reps} reps</div>
            </div>
          </div>
        )}
      </header>

      <div className="ev-sf-toolbar" role="toolbar" aria-label="Filters">
        <SegmentedToggle
          value={filters.cadence}
          onChange={(k) => onFilters({ ...filters, cadence: k as SurfaceCadence })}
          items={[
            { key: "all", label: "All batches" },
            { key: "nightly", label: "Nightly" },
            { key: "named", label: "By hand" },
          ]}
        />
        {models.length > 1 && (
          <SegmentedToggle value={filters.model ?? ""} onChange={(k) => onFilters({ ...filters, model: k || null })} items={[{ key: "", label: "Every model" }, ...models.map((m) => ({ key: m, label: shortModel(m), title: m }))]} />
        )}
        <span className="ev-sf-toolbar-gap" />
        <Toggle on={filters.dirty} onClick={() => onFilters({ ...filters, dirty: !filters.dirty })} title="Reps that ran on uncommitted edits, hatched">
          dirty <span className="ev-tabular ev-quiet">{dirtyReps}</span>
        </Toggle>
        <Toggle on={filters.dry} onClick={() => onFilters({ ...filters, dry: !filters.dry })} title="Dry renders: the prompt only, nothing graded">
          dry
        </Toggle>
        {can.bisect && (
          <Toggle on={filters.bisect} onClick={() => onFilters({ ...filters, bisect: !filters.bisect })} title="Probe batches a bisect ran on older commits">
            bisect probes
          </Toggle>
        )}
        <span className="ev-sf-toolbar-sep" />
        <Toggle on={facet} onClick={() => setFacet((f) => !f)} title="One lane per model">
          facet by model
        </Toggle>
        <SegmentedToggle
          value={axis}
          onChange={(k) => setAxis(k as SurfaceAxis)}
          items={[
            { key: "time", label: "Time", title: "Columns by when each batch began" },
            { key: "ordinal", label: "Ordinal", title: "One even column per batch" },
          ]}
        />
      </div>

      <div className="ev-sf-grid">
        <div className="ev-sf-main">
          <section className="ev-sf-chart" aria-label="Seismograph">
            <div className="ev-sf-chart-head">
              <h2 className="ev-title">
                <VerdictGlyph state={latest ? verdictOfSet(latest.passed, latest.reps) : "unscored"} size={12} />
                Every rep, {cols.list.length} {cols.list.length === 1 ? "batch" : "batches"}
                {refreshing && <span className="ev-sf-refreshing ev-pulse">updating</span>}
              </h2>
              <span className="ev-sf-legend">
                <span>
                  <VerdictGlyph state="pass" size={9} /> pass
                </span>
                <span>
                  <VerdictGlyph state="fail" size={9} /> fail
                </span>
                <span>
                  <span className="ev-sf-legend-hatch" /> dirty
                </span>
                <span>
                  <span className="ev-sf-legend-median" /> median
                </span>
                {zoom ? (
                  <button type="button" className="ev-btn" onClick={() => setZoom(null)} data-ev-unzoom>
                    {zoomLabel}, show all
                  </button>
                ) : (
                  <span className="ev-quiet">drag to zoom</span>
                )}
              </span>
            </div>
            <div ref={chartRef} className="ev-sf-chart-body">
              {cols.list.length === 0 ? (
                <p className="ev-sf-note ev-quiet">No batch matches these filters.</p>
              ) : (
                <>
                  <Seismograph
                    cols={cols}
                    runs={runs}
                    epochs={data.epochs}
                    footing={data.footing}
                    facet={facet}
                    pinned={pinned}
                    compare={compare}
                    hover={hover}
                    onHover={setHover}
                    onPick={pick}
                    onZoom={(a, b) => setZoom({ from: cols.byBatch.get(a)!.at, to: cols.byBatch.get(b)!.at })}
                    onOpenRun={(id) => onNavigate(evalsHref.run(id))}
                    onOpenEpoch={onEpoch}
                    commits={data.commits}
                    onOpenCommit={(sha) => onNavigate(evalsHref.commit(sha, { surface: surface.id }))}
                    baseline={data.latest?.baseline?.batches}
                    passMark={surface.passMark}
                  />
                  <CostTrack cols={cols} hover={hover} onHover={setHover} pinned={pinned} compare={compare} />
                </>
              )}
            </div>
            <div className="ev-sf-keys" aria-label="Keys">
              <span>click a column to pin it, shift-click a second to compare</span>
              <span>
                <KeyCap size="xs">[</KeyCap>
                <KeyCap size="xs">]</KeyCap> step the pin
              </span>
              {can.epochs && (
                <span>
                  <KeyCap size="xs">e</KeyCap> epoch diff
                </span>
              )}
              {can.attribution && (
                <span>
                  <KeyCap size="xs">b</KeyCap> attribute
                </span>
              )}
              <span>
                <KeyCap size="xs">esc</KeyCap> unpin
              </span>
            </div>
          </section>

          <section className="ev-sf-ledger-wrap" aria-label="Freeze ledger">
            <div className="ev-sf-chart-head">
              <h2 className="ev-title">
                <VerdictGlyph state={data.ledger.some((r) => r.flips) ? "mixed" : "pass"} size={12} />
                Freezes
                <span className="ev-quiet ev-tabular ev-sf-count">
                  {data.ledger.length} {data.ledger.length === 1 ? "freeze" : "freezes"}, {totalFlips} {totalFlips === 1 ? "flip" : "flips"} on the same footing
                  {pairFlips && pairFlips.size > 0 ? `, ${pairFlips.size} between the pinned pair` : ""}
                </span>
              </h2>
              <span className="ev-sf-legend">
                <span>
                  <span className="ev-sf-legend-notch ev-fail" /> broke
                </span>
                <span>
                  <span className="ev-sf-legend-notch ev-pass" /> fixed
                </span>
                <span className="ev-quiet">ink is the mean, the ring the majority</span>
              </span>
            </div>
            <FreezeLedger rows={data.ledger} columns={graded} pinned={pinned} compare={compare} hover={hover} onHover={setHover} onPick={pick} pairFlips={pairFlips} />
          </section>
        </div>

        {pair && allCols.get(pair[0]) && allCols.get(pair[1]) && (
          <ComparePanel
            surface={surface.id}
            route={surface.route}
            a={allCols.get(pair[0])!.stats}
            b={allCols.get(pair[1])!.stats}
            res={batches.res}
            loading={batches.loading}
            error={batches.error}
            onClose={() => onPins(pinned, null)}
          />
        )}
      </div>

      <EpochDiffSheet surface={surface.id} n={epoch.n} res={epoch.res} loading={epoch.loading} error={epoch.error} freezeNames={freezeNames} onClose={() => onEpoch(null)} />
    </div>
  );
}
