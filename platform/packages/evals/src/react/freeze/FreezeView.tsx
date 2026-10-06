// One freeze across time (docs/architecture/evals-ui.md section 4.3), props
// only: the label, the production reply and the frozen moment on the left;
// every rep of the freeze as dots in batch columns, and two reply cards either
// side of its newest flip, on the right. FreezePage feeds it; the fixture in
// mount test feeds it a product of its own.
//
// Which reps the cards hold by default is decided from the surface's ledger
// row, the child's own majority and flip per batch (the same cell the plate
// shows), so this page and the plate never disagree about where it flipped.

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowLeftRight, ChevronDown, ChevronRight, Crosshair } from "lucide-react";
import { jitter, scoreScale, stepPath, shortSha, batchLabel, whenLabel, verdictOfRow, type FreezePair, type DefaultFreezePair, shownRep, graded, batchColumns, attributionEnds, pairStory, replyOfRun, reasoningOfRun, promptFilePairs, dayLabel, tickLabel, FREEZE_WIDE_PX, epochBandsOf, medianOf, repY, scoredRep, type ColumnRail } from "../../client";
import type { Epoch, FootingMarker, FreezeResponse, LedgerCell, MomentMessage, RunResponse, RunRowCore } from "../../contract";
import { useEvalsCapabilities, useEvalsHost, useEvalsPaths, usePassMark } from "../hooks";
import { CopyCommand, EvalsLink, LockBadge, PromptDiff, ReplyCard, ScoreBar, VerdictGlyph } from "../shell/parts";
import { FootingGlyph } from "../surface/ScoreStrip";
import { EpochBands, RepHatch, RepMark, RepTip } from "../surface/Seismograph";

// ── Left pane ───────────────────────────────────────────────────────────────

/** A label's verdict, whatever the surface calls it. */
const LABEL_VERDICT_KEYS = ["verdict", "state", "expected", "answer", "label"];

export function LabelCard({ label, source }: { label: unknown; source: FreezeResponse["labelSource"] }) {
  const obj = label && typeof label === "object" && !Array.isArray(label) ? (label as Record<string, unknown>) : null;
  const verdictKey = obj ? LABEL_VERDICT_KEYS.find((k) => typeof obj[k] === "string" || typeof obj[k] === "boolean") : undefined;
  const rest = obj ? Object.entries(obj).filter(([k]) => k !== verdictKey) : [];
  return (
    <section className="ev-card ev-fz-label" data-ev-label={source ?? "none"}>
      <header className="ev-title ev-fz-wrap">
        <LabelGlyph />
        What a person said it should be
        <span className="ev-grow" />
        <span className="ev-fz-aside ev-fz-nowrap ev-quiet">{source === "labels" ? "EVALS_HOME/labels" : source === "inline" ? "the fixture's own label" : null}</span>
      </header>
      {label === null || label === undefined ? (
        <p className="ev-fz-empty ev-quiet">Nobody has labelled this freeze yet. The judge's criteria below are all it is held to.</p>
      ) : obj ? (
        <>
          {verdictKey && (
            <div className="ev-fz-verdict" data-ev-label-verdict>
              <span className="ev-fz-verdict-word ev-mono">{String(obj[verdictKey])}</span>
              <span className="ev-fz-verdict-key ev-quiet">{verdictKey}</span>
            </div>
          )}
          {rest.map(([k, v]) => (
            <div key={k} className="ev-fz-field">
              <span className="ev-fz-field-key ev-quiet ev-mono">{k}</span>
              <span className="ev-fz-prose">{typeof v === "string" ? v : JSON.stringify(v)}</span>
            </div>
          ))}
        </>
      ) : (
        <pre className="ev-fz-pre ev-mono">{typeof label === "string" ? label : JSON.stringify(label, null, 2)}</pre>
      )}
    </section>
  );
}

function LabelGlyph() {
  return (
    <svg width={13} height={13} viewBox="-7 -7 14 14" className="ev-quiet" aria-hidden>
      <path d="M-5.5,-5.5 H2 L5.5,0 L2,5.5 H-5.5 Z" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
      <circle cx={-2} cy={0} r={1.2} fill="currentColor" />
    </svg>
  );
}

/** What production answered at this moment, pinned above it. */
export function ProductionCard({ production, surface }: { production: FreezeResponse["production"]; surface: string }) {
  const verdict = production?.verdict ?? null;
  return (
    <section className="ev-card ev-reply" data-ev-production>
      <header className="ev-reply-head ev-fz-wrap">
        <VerdictGlyph state={verdict ? (verdict.pass ? "pass" : "fail") : "unscored"} size={14} />
        <span className="ev-title ev-fz-nowrap" title={`What the live ${surface} surface said when this moment happened`}>
          Production's reply
        </span>
        {verdict && <ScoreBar score={verdict.score} width={80} />}
      </header>
      {production && production.messages.length ? (
        <div className="ev-reply-text">{production.messages.map((m) => m.text).join("\n\n")}</div>
      ) : (
        <div className="ev-fz-empty ev-quiet">Production's reply was not captured with this freeze.</div>
      )}
      {verdict?.reasoning && <div className="ev-judge">{verdict.reasoning}</div>}
    </section>
  );
}

/**
 * The frozen moment as the surface saw it. Everything above the cut happened
 * before the freeze's asOf and is what the model reads; below it is what
 * happened next, kept for the judge and shown dimmed.
 */
export function MomentPane({ messages, cutAt, asOf }: { messages: MomentMessage[]; cutAt: number; asOf: string }) {
  const cut = Math.max(0, Math.min(messages.length, cutAt));
  return (
    <section className="ev-card ev-fz-moment" data-ev-moment>
      <header className="ev-title ev-fz-moment-head">
        <MomentGlyph />
        The frozen moment
        <span className="ev-grow" />
        <span className="ev-fz-aside ev-quiet ev-tabular">{messages.length} messages</span>
      </header>
      {!messages.length ? (
        <p className="ev-fz-moment-none ev-quiet">The child could not render this moment.</p>
      ) : (
        <ol className="ev-fz-moment-list">
          {messages.map((m, i) => (
            <li key={`${m.id}:${i}`}>
              {i === cut && <FrozenCut asOf={asOf} />}
              <MomentLine m={m} after={i >= cut} />
            </li>
          ))}
          {cut === messages.length && <FrozenCut asOf={asOf} />}
        </ol>
      )}
    </section>
  );
}

function MomentGlyph() {
  return (
    <svg width={13} height={13} viewBox="-7 -7 14 14" className="ev-quiet" aria-hidden>
      <rect x={-5.5} y={-5.5} width={11} height={11} rx={2} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path d="M-5.5,1 H5.5" stroke="currentColor" strokeWidth={1.3} strokeDasharray="1.4 1.4" />
    </svg>
  );
}

/** A line of the moment. Who said it (data-direction) sets its colour and rule in freeze.css. */
function MomentLine({ m, after }: { m: MomentMessage; after: boolean }) {
  return (
    <div className="ev-fz-line" data-ev-moment-line={after ? "after" : "before"} data-direction={m.direction}>
      <span className="ev-fz-line-n ev-mono ev-quiet ev-tabular">{m.n}</span>
      <div className="ev-fz-line-body">
        <div className="ev-fz-line-meta">
          <span className="ev-fz-line-from">{m.from}</span>
          {m.room && <span className="ev-quiet ev-mono">{m.room}</span>}
          <span className="ev-quiet ev-tabular">{whenLabel(m.at)}</span>
        </div>
        <div className={m.direction === "system" ? "ev-fz-line-text ev-mono" : "ev-fz-line-text"}>{m.text}</div>
      </div>
    </div>
  );
}

/** The cut: a perforated tear across the moment, where the freeze was taken. */
function FrozenCut({ asOf }: { asOf: string }) {
  return (
    <div className="ev-fz-cut" data-ev-frozen-cut role="separator" aria-label={`Frozen here, ${whenLabel(asOf)}`}>
      <span className="ev-fz-cut-perf" />
      <span className="ev-fz-cut-word ev-mono">frozen here</span>
      <span className="ev-fz-aside ev-quiet ev-tabular">{whenLabel(asOf)}</span>
      <span className="ev-fz-aside ev-quiet">what follows is for the judge</span>
    </div>
  );
}

// ── The rep strip ───────────────────────────────────────────────────────────

export interface FreezeRepStripProps {
  runs: RunRowCore[];
  epochs: Epoch[];
  footing: FootingMarker[];
  cells: Record<string, LedgerCell> | null;
  pair: FreezePair;
  pinnedBatch: string | null;
  width: number;
  /** Which slot the next click sets, for the tooltip. */
  nextSlot?: "a" | "b";
  onPick?: (run: RunRowCore) => void;
}

const STRIP_H = 178;
const TOP = 30;
const AXIS_H = 30;
const PAD_L = 12;
const PAD_R = 12;

/**
 * Every rep of the freeze as a dot in its batch's column, ordinal by batch.
 * The marks, epoch bands, median and footing glyphs are the surface
 * seismograph's own (Seismograph.tsx), so a rep reads the same on both pages;
 * this strip adds the flip notches from the ledger and the A and B rings.
 */
export function FreezeRepStrip({ runs, epochs, footing, cells, pair, pinnedBatch, width, nextSlot = "a", onPick }: FreezeRepStripProps) {
  const { HoverTip } = useEvalsHost().ui;
  const passMark = usePassMark()();
  const [tip, setTip] = useState<{ run: RunRowCore; x: number; y: number } | null>(null);
  const cols = useMemo(() => batchColumns(runs), [runs]);
  const w = Math.max(width, 240);
  const colW = (w - PAD_L - PAD_R) / Math.max(cols.length, 1);
  const rail: ColumnRail = useMemo(
    () => ({ list: cols.map((c, i) => ({ batch: c.batch, at: Date.parse(c.at), x: PAD_L + colW * (i + 0.5) })), width: w, padL: PAD_L, padR: PAD_R }),
    [cols, colW, w],
  );
  const plotBottom = STRIP_H - AXIS_H;
  // Room under 0 for the unscored ring the shared mark puts just below the axis.
  const y = scoreScale(TOP + 4, plotBottom - 14);
  const bands = useMemo(() => epochBandsOf(rail, epochs), [rail, epochs]);
  const r = Math.max(2.1, Math.min(3.1, colW * 0.22));
  const spread = Math.max(1.5, Math.min(7, colW * 0.28));
  const colOf = useMemo(() => new Map(rail.list.map((c) => [c.batch, c])), [rail]);

  const medians = rail.list
    .map((c, i) => ({ x: c.x, m: medianOf(cols[i].reps.filter(scoredRep).map((rep) => rep.score as number)) }))
    .filter((p): p is { x: number; m: number } => p.m !== null);
  const ticks = useMemo(() => {
    const every = Math.max(1, Math.ceil(110 / Math.max(colW, 1)));
    const out: number[] = [];
    for (let i = 0; i < cols.length; i += every) out.push(i);
    if (cols.length > 1 && out[out.length - 1] !== cols.length - 1 && (cols.length - 1 - out[out.length - 1]) * colW > 60) out.push(cols.length - 1);
    return out;
  }, [cols, colW]);

  if (!cols.length) {
    return <div className="ev-card ev-bench ev-fz-strip-empty ev-quiet" data-ev-rep-strip="empty">No graded rep of this freeze yet.</div>;
  }
  const pinnedX = pinnedBatch ? colOf.get(pinnedBatch)?.x ?? null : null;
  return (
    <div className="ev-card ev-bench ev-sf-seis ev-fz-strip" data-ev-rep-strip>
      <svg width={w} height={STRIP_H} viewBox={`0 0 ${w} ${STRIP_H}`} role="img" aria-label={`Every rep of this freeze across ${cols.length} batches`} className="ev-fz-strip-svg">
        <defs>
          <RepHatch />
        </defs>
        <EpochBands bands={bands} top={TOP} bottom={plotBottom} />
        {pinnedX !== null && <rect x={pinnedX - 6} y={TOP - 4} width={12} height={plotBottom - TOP + 4} rx={3} className="ev-sf-pin" data-ev-pinned-col />}
        {passMark !== null && <line x1={PAD_L} x2={w - PAD_R} y1={y(passMark)} y2={y(passMark)} className="ev-sf-passmark" data-ev-passmark />}
        {medians.length > 0 && <path d={stepPath(medians.map((p) => ({ x: p.x, y: y(p.m) })), Math.min(w - PAD_R, medians[medians.length - 1].x + colW / 2))} className="ev-sf-median" data-ev-median />}
        {cols.map((c) => {
          const flip = cells?.[c.batch]?.flip ?? null;
          const x = colOf.get(c.batch)!.x;
          return flip ? (
            <g key={c.batch} className={flip === "broke" ? "ev-fail" : "ev-pass"} data-ev-strip-flip={flip}>
              <title>{`${flip === "broke" ? "Broke" : "Fixed"} at ${batchLabel(c.batch)}`}</title>
              <path d={`M${x - 3.6},${TOP - 4} L${x + 3.6},${TOP - 4} L${x},${TOP + 1.6} Z`} fill="currentColor" />
            </g>
          ) : null;
        })}
        {cols.map((c, i) =>
          c.reps.map((rep) => {
            const cx = colOf.get(c.batch)!.x + jitter(rep.id, spread);
            const cy = repY(rep, y);
            return (
              <RepMark
                key={rep.id}
                row={rep}
                cx={cx}
                y={y}
                r={r}
                style={{ "--ev-delay": `${Math.min(i * 10, 600)}ms`, cursor: onPick ? "pointer" : "default" } as CSSProperties}
                data-ev-rep={rep.id}
                data-ev-rep-status={rep.status}
                onMouseEnter={(e) => setTip({ run: rep, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setTip(null)}
                onClick={() => onPick?.(rep)}
              >
                {/* A wider target than the dot, so a dense column is still clickable. */}
                <circle cx={cx} cy={cy} r={Math.max(r + 3, 6)} fill="transparent" />
              </RepMark>
            );
          }),
        )}
        {/* A and B sit above every rep, so a later rep in the same column never paints over the letter. */}
        {(["A", "B"] as const).map((slot) => {
          const rep = runs.find((x) => x.id === (slot === "A" ? pair.a : pair.b));
          const col = rep?.batch ? colOf.get(rep.batch) : undefined;
          if (!rep || !col || !shownRep(rep)) return null;
          const cx = col.x + jitter(rep.id, spread);
          const cy = repY(rep, y);
          return (
            <g key={slot} data-ev-rep-selected={slot} data-ev-selected-rep={rep.id} pointerEvents="none">
              <circle cx={cx} cy={cy} r={r + 3.2} className="ev-fz-ring" />
              {/* Haloed like the pass mark's label, so the median step line and neighbouring dots never run through the letter. */}
              <text x={cx} y={cy - r - 6} textAnchor="middle" className="ev-mono ev-sf-ylabel--halo ev-fz-ring-letter">
                {slot}
              </text>
            </g>
          );
        })}
        {/* Drawn after the reps, with a halo, so a dot near the mark never hides its label. */}
        {passMark !== null && (
          <text x={PAD_L + 2} y={y(passMark) + 11} className="ev-sf-ylabel ev-sf-ylabel--mark ev-sf-ylabel--halo">
            {passMark}
          </text>
        )}
        <line x1={PAD_L} x2={w - PAD_R} y1={plotBottom + 1} y2={plotBottom + 1} className="ev-sf-axis" />
        {footing.map((m, k) => {
          const c = colOf.get(m.batch);
          return c ? <FootingGlyph key={k} marker={m} x={c.x} y={plotBottom + 9} scale={1.4} /> : null;
        })}
        {ticks.map((i, k) => (
          <text key={i} x={rail.list[i].x} y={STRIP_H - 5} textAnchor={i === 0 ? "start" : i === cols.length - 1 ? "end" : "middle"} className="ev-sf-xlabel">
            {tickLabel(cols, ticks, k)}
          </text>
        ))}
      </svg>
      {tip && (
        <HoverTip x={tip.x} y={tip.y - 10}>
          <RepTip row={tip.run} hint={onPick ? `click to set ${nextSlot === "a" ? "A" : "B"}` : undefined} />
        </HoverTip>
      )}
    </div>
  );
}

// ── The cards ───────────────────────────────────────────────────────────────

export type CardPairing = "ab" | "prod-a" | "prod-b";

const PAIRINGS = [
  { key: "ab", label: "A and B", title: "The two picked reps" },
  { key: "prod-a", label: "prod and A", title: "Production's reply against A" },
  { key: "prod-b", label: "prod and B", title: "Production's reply against B" },
];

function RunCard({ slot, run, loading, heading }: { slot: "A" | "B"; run: RunResponse | null; loading: boolean; heading: ReactNode }) {
  const paths = useEvalsPaths();
  if (!run)
    return (
      <div className="ev-card ev-fz-card-wait ev-quiet" data-ev-card-slot={slot}>
        {loading ? `Reading rep ${slot}...` : `Pick rep ${slot}: click a dot on the strip.`}
      </div>
    );
  return (
    <div data-ev-card-slot={slot}>
      <ReplyCard row={run.row} reply={replyOfRun(run)} reasoning={reasoningOfRun(run)} heading={heading} href={paths.href.run(run.row.id)} />
    </div>
  );
}

function SlotTag({ slot }: { slot: "A" | "B" | "prod" }) {
  return (
    <span className="ev-fz-slot ev-mono" data-ev-slot={slot}>
      {slot}
    </span>
  );
}

/** The seismograph's epoch boundary in small: a perforated rule between two bands. */
function EpochCutGlyph() {
  return (
    <svg width={13} height={13} viewBox="-7 -7 14 14" aria-hidden className="ev-quiet">
      <rect x={-6} y={-5.5} width={5} height={11} rx={1} fill="currentColor" opacity={0.18} />
      <path d="M0,-6 V6" stroke="currentColor" strokeWidth={1.3} strokeDasharray="1.6 1.4" />
      <rect x={1.5} y={-5.5} width={4.5} height={11} rx={1} fill="none" stroke="currentColor" strokeWidth={1.1} />
    </svg>
  );
}

/** Between the two cards: whether the model saw a different prompt, and the diff when it did. */
function PromptChange({ a, b }: { a: RunResponse; b: RunResponse }) {
  const { SegmentedToggle } = useEvalsHost().ui;
  const { promptFiles } = useEvalsCapabilities();
  const changed = a.row.promptSha !== b.row.promptSha;
  const pairs = useMemo(() => promptFilePairs(a, b).filter((p) => p.a.text !== p.b.text), [a, b]);
  const [file, setFile] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  if (!changed)
    return (
      <div className="ev-fz-prompt-same ev-quiet" data-ev-prompt-same>
        <span className="ev-mono">=</span>
        Same prompt on both reps (promptSha {shortSha(a.row.promptSha)}): the difference is the model's, not the prompt's.
      </div>
    );
  const shown = pairs.find((p) => p.file === file) ?? pairs[0] ?? null;
  return (
    // Neutral, like the surface page's epoch chips: a prompt change is a new epoch, not a verdict, so it borrows no pass or fail colour.
    <section className="ev-fz-prompt" data-ev-prompt-changed>
      <button type="button" className="ev-fz-prompt-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown className="ev-icon ev-quiet" /> : <ChevronRight className="ev-icon ev-quiet" />}
        <EpochCutGlyph />
        <span className="ev-fz-prompt-title">Prompt changed</span>
        <span className="ev-note">
          {pairs.length ? `${pairs.length} file${pairs.length === 1 ? " differs" : "s differ"}` : promptFiles ? "the files read the same, so the change is in a request parameter" : "kept by its hash, so the change cannot be shown"}
        </span>
        <span className="ev-grow" />
        <span className="ev-fz-aside ev-mono ev-quiet">
          {shortSha(a.row.promptSha)} → {shortSha(b.row.promptSha)}
        </span>
      </button>
      {open && shown && (
        <div className="ev-fz-prompt-body">
          {pairs.length > 1 && <SegmentedToggle value={shown.file} onChange={setFile} items={pairs.map((p) => ({ key: p.file, label: p.file }))} />}
          <PromptDiff pair={shown} />
        </div>
      )}
    </section>
  );
}

// ── The view ────────────────────────────────────────────────────────────────

export interface FreezeViewProps {
  freeze: FreezeResponse;
  /** The surface ledger's row for this freeze: the child's majority and flip per batch. Null while it loads or when it cannot. */
  cells: Record<string, LedgerCell> | null;
  footing: FootingMarker[];
  /** The batch the page was opened on (`?batch=`). */
  pinnedBatch: string | null;
  pair: FreezePair;
  /** Why the pair is what it is, and the flip it straddles. */
  pick: DefaultFreezePair;
  /** The two reps' full records, by slot; null while loading or unpicked. */
  runA: RunResponse | null;
  runB: RunResponse | null;
  loadingA?: boolean;
  loadingB?: boolean;
  onPair: (pair: FreezePair) => void;
}

export function FreezeView({ freeze, cells, footing, pinnedBatch, pair, pick, runA, runB, loadingA = false, loadingB = false, onPair }: FreezeViewProps) {
  const f = freeze.freeze;
  const { useContainerWidth, ui: { SegmentedToggle } } = useEvalsHost();
  const paths = useEvalsPaths();
  // A product that cannot attribute (no git or prompts) gets no launcher.
  const { attribution } = useEvalsCapabilities();
  const { ref: rootRef, width: rootWidth } = useContainerWidth(1200);
  const wide = rootWidth >= FREEZE_WIDE_PX;
  const { ref, width } = useContainerWidth(640);
  const [pairing, setPairing] = useState<CardPairing>("ab");
  const [nextSlot, setNextSlot] = useState<"a" | "b">("a");
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const shown = freeze.runs.filter(shownRep);
  const hidden = freeze.runs.length - shown.length;
  const passed = shown.filter((r) => r.status === "pass").length;
  const scored = shown.filter(graded).length;
  const newest = shown.reduce<RunRowCore | null>((n, r) => (!n || r.stamp > n.stamp ? r : n), null);
  const ends = attributionEnds(pair, freeze.runs, pick);
  const story = pairStory(pair, pick, freeze.runs);

  const pickRep = (run: RunRowCore) => {
    const next = nextSlot === "a" ? { a: run.id, b: pair.b === run.id ? pair.a : pair.b } : { a: pair.a === run.id ? pair.b : pair.a, b: run.id };
    onPair(next);
    setNextSlot(nextSlot === "a" ? "b" : "a");
  };

  const left = (
    <div className="ev-fz-col" data-ev-freeze-left>
      <LabelCard label={freeze.label} source={freeze.labelSource} />
      <ProductionCard production={freeze.production} surface={f.surface} />
      <MomentPane messages={freeze.moment} cutAt={freeze.cutAt} asOf={f.asOf} />
    </div>
  );

  const cardFor = (slot: "A" | "B" | "prod") => {
    if (slot === "prod") return <ProductionCard production={freeze.production} surface={f.surface} />;
    const run = slot === "A" ? runA : runB;
    // Named by the rep's own batch, so it stays true after a swap or a pick.
    const flipWord = !pick.flip || !run ? null : run.row.batch === pick.flip.before ? "before the flip" : run.row.batch === pick.flip.batch ? "after the flip" : null;
    return (
      <RunCard
        slot={slot}
        run={run}
        loading={slot === "A" ? loadingA : loadingB}
        heading={
          <span className="ev-fz-cardhead">
            <SlotTag slot={slot} />
            <span className="ev-fz-cardhead-meta ev-quiet">
              {run?.row.batch ? batchLabel(run.row.batch, run.row.batchAt) : ""}
              {run ? `, seed ${run.row.seed}` : ""}
              {flipWord ? `, ${flipWord}` : ""}
            </span>
          </span>
        }
      />
    );
  };
  const [first, second] = pairing === "ab" ? (["A", "B"] as const) : pairing === "prod-a" ? (["prod", "A"] as const) : (["prod", "B"] as const);

  const right = (
    <div className="ev-fz-col" data-ev-freeze-right>
      <div ref={ref} className="ev-fz-stripbox">
        <FreezeRepStrip runs={freeze.runs} epochs={freeze.epochs} footing={footing} cells={cells} pair={pair} pinnedBatch={pinnedBatch} width={width} nextSlot={nextSlot} onPick={pickRep} />
      </div>
      <div className="ev-fz-legend ev-quiet">
        <span className="ev-fz-key">
          <VerdictGlyph state="pass" size={10} /> pass
        </span>
        <span className="ev-fz-key">
          <VerdictGlyph state="fail" size={10} /> fail
        </span>
        <span className="ev-fz-key">
          <svg width={10} height={10} viewBox="-5 -5 10 10" className="ev-fail" aria-hidden>
            <path d="M-3.6,-3 L3.6,-3 L0,2.6 Z" fill="currentColor" />
          </svg>
          broke
        </span>
        <span className="ev-tabular">
          {passed} of {scored} graded reps passed
        </span>
        {hidden > 0 && <span className="ev-tabular">{hidden} dry or bisect reps hidden</span>}
        <span className="ev-grow" />
        <span className="ev-fz-key" data-ev-next-slot={nextSlot}>
          <Crosshair className="ev-fz-icon-sm" />
          A click on a dot sets {nextSlot === "a" ? "A" : "B"}
        </span>
      </div>

      <div className="ev-fz-pairbar">
        <span className="ev-title" data-ev-pair-title={story.isDefault ? "default" : "picked"}>
          <VerdictGlyph state={story.glyph} size={12} title={story.glyph === "mixed" ? "One of A and B passed, the other did not" : story.glyph === "pass" ? "A and B both passed" : story.glyph === "fail" ? "A and B both failed" : undefined} />
          {story.title}
        </span>
        <span className="ev-note" data-ev-pair-why>
          {story.why}
        </span>
        {!story.isDefault && pick.a && (
          <button type="button" className="ev-chip" onClick={() => onPair({ a: pick.a, b: pick.b })} title="Put back the pair this page opened with" data-ev-pair-reset>
            default pair
          </button>
        )}
        <span className="ev-grow" />
        <SegmentedToggle value={pairing} onChange={(k) => setPairing(k as CardPairing)} items={PAIRINGS} />
        <button
          type="button"
          className="ev-chip"
          onClick={() => onPair({ a: pair.b, b: pair.a })}
          disabled={!pair.a || !pair.b}
          title="Swap A and B"
          data-ev-swap
        >
          <ArrowLeftRight /> swap
        </button>
      </div>

      <div className="ev-fz-cards" data-ev-cards={pairing}>
        {cardFor(first)}
        {pairing === "ab" && runA && runB ? <PromptChange a={runA} b={runB} /> : <div className="ev-fz-gap" />}
        {cardFor(second)}
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="ev-page ev-fz" data-evals-freeze={f.id}>
      <header className="ev-fz-header">
        <div className="ev-fz-titlerow">
          <VerdictGlyph state={newest ? verdictOfRow(newest) : "unscored"} size={16} title="The newest rep's verdict" />
          <h1 className="ev-page-title ev-mono">
            {f.name}
          </h1>
          <LockBadge visibility={f.visibility} />
          <EvalsLink href={paths.href.surface(f.surface)} className="ev-chip" title="Open the surface">
            {f.surface}
          </EvalsLink>
          <span className="ev-chip" title={`Freeze id ${f.id}`}>
            {f.id.slice(0, 8)}
          </span>
          {f.freezeSha && (
            <span className="ev-chip" title={`freezeSha ${f.freezeSha}: the freeze JSON and its snapshot`}>
              sha {shortSha(f.freezeSha)}
            </span>
          )}
        </div>
        <div className="ev-fz-meta ev-quiet">
          <span>
            {f.subject.kind} <span className="ev-fz-subject">{f.subject.title}</span>
          </span>
          <span className="ev-tabular">frozen {whenLabel(f.asOf)}</span>
          <span className="ev-tabular">captured {dayLabel(f.createdAt)}</span>
          {f.judge && (
            <button type="button" className="ev-fz-criteria ev-quiet" onClick={() => setCriteriaOpen((o) => !o)} aria-expanded={criteriaOpen}>
              {criteriaOpen ? <ChevronDown className="ev-fz-icon-sm" /> : <ChevronRight className="ev-fz-icon-sm" />}
              criteria
            </button>
          )}
        </div>
        {criteriaOpen && f.judge && <div className="ev-judge" data-ev-criteria>{f.judge}</div>}
        <div className="ev-fz-actions">
          <CopyCommand command={`./evals freeze replay ${f.id} --reps 3`} />
          {attribution && (
            <EvalsLink
              href={paths.href.bisectNew({ surface: f.surface, good: ends.good, bad: ends.bad, freeze: f.id })}
              className="ev-chip ev-fz-attribute"
              data-ev-attribute
              title="Attribute the change between A and B on this freeze alone, which keeps probe cost lowest"
            >
              Attribute this freeze
            </EvalsLink>
          )}
        </div>
      </header>
      {/* One tree for both layouts: swapping trees would remount the panes and strand the strip's width observer on a dead node. */}
      <div className="ev-fz-layout" data-ev-layout={wide ? "wide" : "narrow"}>
        <div className="ev-fz-pane ev-fz-pane--left">{left}</div>
        <div className="ev-fz-pane">{right}</div>
      </div>
    </div>
  );
}
