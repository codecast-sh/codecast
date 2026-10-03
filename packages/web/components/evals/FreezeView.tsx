// One freeze across time (docs/architecture/evals-ui.md section 4.3), props
// only: the label, the production reply and the frozen moment on the left;
// every rep of the freeze as dots in batch columns, and two reply cards either
// side of its newest flip, on the right. FreezePage feeds it; the fixture in
// __fixtures__/freeze.ts feeds it in the mount test and the rig.
//
// Which reps the cards hold by default is decided from the surface's ledger
// row, the child's own majority and flip per batch (the same cell the plate
// shows), so this page and the plate never disagree about where it flipped.

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowLeftRight, ChevronDown, ChevronRight, Crosshair } from "lucide-react";
import type { Epoch, FootingMarker, FreezeResponse, LedgerCell, MomentMessage, PromptFilePair, RunResponse, RunRow } from "@codecast/shared/contracts/evalsApi";
import { HoverTip, useContainerWidth } from "../ActivityHeatmap";
import { SegmentedToggle } from "../SegmentedToggle";
import { FootingGlyph } from "./charts/ScoreStrip";
import { PASS_MARK, jitter, scoreScale, stepPath } from "./charts/scale";
import { EpochBands, RepHatch, RepMark, RepTip, epochBandsOf, medianOf, repY, scoredRep, type ColumnRail } from "./Seismograph";
import { evalsHref } from "./evalsPaths";
import { CopyCommand, EvalsLink, LockBadge, PromptDiff, ReplyCard, ScoreBar, VerdictGlyph, score2, shortSha, verdictOfRow } from "./parts";

// ── What the page decides ───────────────────────────────────────────────────

/** The two reps the cards hold, by run id. */
export interface FreezePair {
  a: string | null;
  b: string | null;
}

export interface DefaultFreezePair extends FreezePair {
  /** The flip the pair straddles, when there is one on the same footing. */
  flip: { batch: string; before: string; direction: NonNullable<LedgerCell["flip"]> } | null;
  /** Why these two, in words. */
  why: string;
}

/** Reps the strip draws: dry renders graded nothing and bisect probes ran other commits on purpose (both hidden, as on the surface chart). */
export const shownRep = (r: RunRow) => r.status !== "dry" && r.cadence !== "bisect";
const graded = (r: RunRow) => r.status === "pass" || r.status === "fail";
const byStamp = (a: RunRow, b: RunRow) => a.stamp.localeCompare(b.stamp);

/** The freeze's batches oldest first, with the reps each holds. */
export function batchColumns(runs: RunRow[]): Array<{ batch: string; at: string; reps: RunRow[] }> {
  const by = new Map<string, { batch: string; at: string; reps: RunRow[] }>();
  for (const r of runs) {
    if (!shownRep(r) || !r.batch) continue;
    const col = by.get(r.batch) ?? { batch: r.batch, at: r.batchAt ?? r.stamp, reps: [] };
    col.reps.push(r);
    by.set(r.batch, col);
  }
  for (const c of by.values()) c.reps.sort(byStamp);
  return [...by.values()].sort((a, b) => a.at.localeCompare(b.at) || a.batch.localeCompare(b.batch));
}

/**
 * The default pair: the last rep that matched the verdict before the newest
 * flip, and the first that matched it after (for a break, the last pass before
 * and the first fail after). A batch the page was opened on (`?batch=`) takes
 * the flip's place. With no flip on record, the newest two graded batches.
 */
export function defaultFreezePair(runs: RunRow[], cells: Record<string, LedgerCell> | null, pinnedBatch: string | null): DefaultFreezePair {
  const cols = batchColumns(runs).filter((c) => c.reps.some(graded));
  const none: DefaultFreezePair = { a: null, b: null, flip: null, why: "No rep of this freeze has been graded yet." };
  if (!cols.length) return none;
  const index = (batch: string) => cols.findIndex((c) => c.batch === batch);
  const majorityOf = (batch: string) => cells?.[batch]?.majority ?? null;
  // The batch a flip is measured against: the nearest earlier one with a majority (the ledger's own rule).
  const before = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (!cells || majorityOf(cols[j].batch) !== null) return j;
    return -1;
  };
  let target = -1;
  let flip: DefaultFreezePair["flip"] = null;
  let why: string;
  const pinned = pinnedBatch ? index(pinnedBatch) : -1;
  if (pinned >= 0) {
    target = pinned;
    const f = cells?.[cols[pinned].batch]?.flip ?? null;
    why = f ? `The batch this page was opened on, where it ${f === "broke" ? "broke" : "was fixed"}, against the batch before.` : "The batch this page was opened on, against the batch before.";
  } else {
    for (let i = cols.length - 1; i >= 0 && target < 0; i--) if (cells?.[cols[i].batch]?.flip) target = i;
    if (target >= 0) why = "";
    else {
      target = cols.length - 1;
      why = cells ? "No flip on the same footing: the newest two graded batches." : "The newest two graded batches (the surface's ledger is not loaded, so flips are unknown).";
    }
  }
  const prev = before(target);
  const direction = cells?.[cols[target].batch]?.flip ?? null;
  if (direction && prev >= 0) {
    flip = { batch: cols[target].batch, before: cols[prev].batch, direction };
    if (!why) why = direction === "broke" ? "The last pass before the newest flip, and the first fail after it." : "The last fail before the newest fix, and the first pass after it.";
  }
  const pick = (col: (typeof cols)[number] | undefined, last: boolean): string | null => {
    if (!col) return null;
    const m = majorityOf(col.batch);
    const scored = col.reps.filter(graded);
    const wanted = m === null ? scored : scored.filter((r) => (r.status === "pass") === m);
    const pool = wanted.length ? wanted : scored.length ? scored : col.reps;
    return (last ? pool[pool.length - 1] : pool[0])?.id ?? null;
  };
  return { a: pick(cols[prev], true), b: pick(cols[target], false), flip, why };
}

const batchTime = (r: RunRow) => r.batchAt ?? r.stamp;

/**
 * The attribution launcher's endpoints for the pair on screen, read from the
 * freeze's own rows so a pick counts before its cards load: the earlier batch
 * is good and the later bad, whichever slot holds which. Two reps of one batch
 * name only the bad end and let the launcher find the good one. With nothing
 * picked, the default flip's batches.
 */
export function attributionEnds(pair: FreezePair, runs: RunRow[], pick: DefaultFreezePair): { good: string | null; bad: string | null } {
  const rows = [pair.a, pair.b].map((id) => runs.find((r) => r.id === id)).filter((r): r is RunRow => !!r?.batch);
  if (!rows.length) return { good: pick.flip?.before ?? null, bad: pick.flip?.batch ?? null };
  const [early, late] = [...rows].sort((x, y) => batchTime(x).localeCompare(batchTime(y)) || x.stamp.localeCompare(y.stamp));
  if (!late || early.batch === late.batch) return { good: null, bad: (late ?? early).batch };
  return { good: early.batch, bad: late.batch };
}

/** The cards' heading and the line beside it, true for the pair on screen: the default's reason, or the picked reps in words. */
export function pairStory(pair: FreezePair, pick: DefaultFreezePair, runs: RunRow[]): { title: string; why: string; isDefault: boolean } {
  if (pair.a === pick.a && pair.b === pick.b) {
    const title = pick.flip ? `Either side of the ${pick.flip.direction === "broke" ? "break" : "fix"}` : "Two reps side by side";
    return { title, why: pick.why, isDefault: true };
  }
  const row = (id: string | null) => (id ? runs.find((r) => r.id === id) ?? null : null);
  const a = row(pair.a);
  const b = row(pair.b);
  const said = (slot: "A" | "B", r: RunRow) => `${slot} is seed ${r.seed} from ${batchLabel(r.batch ?? r.stamp)}, ${r.status}${r.score !== null ? ` ${score2(r.score)}` : ""}`;
  if (!a || !b) return { title: "Two reps you picked", why: a ? `${said("A", a)}. Click a dot to set B.` : b ? `${said("B", b)}. Click a dot to set A.` : "Click two dots to set A and B.", isDefault: false };
  const order = a.batch === b.batch ? "Both ran in one batch, so only the seed differs." : batchTime(a) > batchTime(b) ? "A is the later of the two." : "";
  return { title: "Two reps you picked", why: `${said("A", a)}; ${said("B", b)}.${order ? ` ${order}` : ""}`, isDefault: false };
}

/** What a rep answered: its sends, else its last call's reply, else what its agent said. */
export function replyOfRun(run: RunResponse): string | null {
  if (run.sends.length) return run.sends.map((s) => s.text).join("\n\n");
  const call = run.calls[run.calls.length - 1];
  if (call) return call.reply;
  const said = run.agents.flatMap((a) => a.said);
  return said.length ? said.join("\n\n") : null;
}

/** The judge's most telling note: the reasoning of the lowest-scoring check that gave one. */
export function reasoningOfRun(run: RunResponse): string | null {
  const checks = (run.score?.checks ?? []).filter((c) => c.reasoning);
  if (!checks.length) return null;
  return [...checks].sort((x, y) => x.score - y.score)[0].reasoning ?? null;
}

/** Every rendered prompt file of two reps, as pairs: call system and prompt, agent prompt and follow-up turns. */
export function promptFilePairs(a: RunResponse, b: RunResponse): PromptFilePair[] {
  const files = (r: RunResponse) => {
    const out = new Map<string, string>();
    for (const c of r.calls) {
      if (c.system !== null) out.set(`${c.dir}/system.md`, c.system);
      out.set(`${c.dir}/prompt.md`, c.prompt);
    }
    for (const g of r.agents) {
      out.set(`${g.dir}/prompt.md`, g.prompt);
      g.then.forEach((t, i) => out.set(`${g.dir}/then${i + 2}.md`, t));
    }
    return out;
  };
  const fa = files(a);
  const fb = files(b);
  const names = [...new Set([...fa.keys(), ...fb.keys()])];
  return names.map((file) => ({ freezeId: a.row.freezeId, file, a: { runId: a.row.id, text: fa.get(file) ?? null }, b: { runId: b.row.id, text: fb.get(file) ?? null } }));
}

// ── Formatting ──────────────────────────────────────────────────────────────

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const timeLabel = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const batchLabel = (batch: string) => batch.slice(5, 16).replace("T", " ");

// ── Left pane ───────────────────────────────────────────────────────────────

/** A label's verdict, whatever the surface calls it. */
const LABEL_VERDICT_KEYS = ["verdict", "state", "expected", "answer", "label"];

export function LabelCard({ label, source }: { label: unknown; source: FreezeResponse["labelSource"] }) {
  const obj = label && typeof label === "object" && !Array.isArray(label) ? (label as Record<string, unknown>) : null;
  const verdictKey = obj ? LABEL_VERDICT_KEYS.find((k) => typeof obj[k] === "string" || typeof obj[k] === "boolean") : undefined;
  const rest = obj ? Object.entries(obj).filter(([k]) => k !== verdictKey) : [];
  return (
    <section className="ev-card px-4 py-3 flex flex-col gap-2" data-ev-label={source ?? "none"}>
      <header className="ev-title flex-wrap">
        <LabelGlyph />
        What a person said it should be
        <span className="flex-1" />
        <span className="text-[11px] font-normal ev-quiet whitespace-nowrap">{source === "labels" ? "EVALS_HOME/labels" : source === "inline" ? "the fixture's own label" : null}</span>
      </header>
      {label === null || label === undefined ? (
        <p className="text-[12.5px] ev-quiet m-0">Nobody has labelled this freeze yet. The judge's criteria below are all it is held to.</p>
      ) : obj ? (
        <>
          {verdictKey && (
            <div className="flex items-baseline gap-2" data-ev-label-verdict>
              <span className="text-[22px] leading-none font-medium ev-mono">{String(obj[verdictKey])}</span>
              <span className="text-[11.5px] ev-quiet">{verdictKey}</span>
            </div>
          )}
          {rest.map(([k, v]) => (
            <div key={k} className="grid gap-x-3 text-[12.5px]" style={{ gridTemplateColumns: "64px 1fr" }}>
              <span className="ev-quiet ev-mono text-[11px] pt-px">{k}</span>
              <span className="whitespace-pre-wrap break-words">{typeof v === "string" ? v : JSON.stringify(v)}</span>
            </div>
          ))}
        </>
      ) : (
        <pre className="ev-mono text-[12px] m-0 whitespace-pre-wrap">{typeof label === "string" ? label : JSON.stringify(label, null, 2)}</pre>
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
      <header className="ev-reply-head flex-wrap">
        <VerdictGlyph state={verdict ? (verdict.pass ? "pass" : "fail") : "unscored"} size={14} />
        <span className="ev-title whitespace-nowrap" title={`What the live ${surface} surface said when this moment happened`}>
          Production's reply
        </span>
        {verdict && <ScoreBar score={verdict.score} width={80} />}
      </header>
      {production && production.messages.length ? (
        <div className="ev-reply-text">{production.messages.map((m) => m.text).join("\n\n")}</div>
      ) : (
        <div className="text-[12.5px] ev-quiet">Production's reply was not captured with this freeze.</div>
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
    <section className="ev-card overflow-hidden" data-ev-moment>
      <header className="ev-title px-4 py-2.5 border-b" style={{ borderColor: "var(--ev-rule)" }}>
        <MomentGlyph />
        The frozen moment
        <span className="flex-1" />
        <span className="text-[11px] font-normal ev-quiet ev-tabular">{messages.length} messages</span>
      </header>
      {!messages.length ? (
        <p className="px-4 py-4 text-[12.5px] ev-quiet m-0">The child could not render this moment.</p>
      ) : (
        <ol className="m-0 p-0 list-none">
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

function MomentLine({ m, after }: { m: MomentMessage; after: boolean }) {
  const human = m.direction === "in";
  const system = m.direction === "system";
  return (
    <div
      className="grid gap-x-3 px-4 py-2 text-[12.5px] leading-[1.55]"
      style={{ gridTemplateColumns: "26px 1fr", opacity: after ? 0.48 : 1 }}
      data-ev-moment-line={after ? "after" : "before"}
      data-direction={m.direction}
    >
      <span className="ev-mono text-[10.5px] ev-quiet ev-tabular pt-[3px] text-right">{m.n}</span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="font-semibold" style={{ color: human ? "var(--sol-text)" : "var(--sol-text-muted)" }}>
            {m.from}
          </span>
          {m.room && <span className="ev-quiet ev-mono">{m.room}</span>}
          <span className="ev-quiet ev-tabular">{timeLabel(m.at)}</span>
        </div>
        <div
          className={`whitespace-pre-wrap break-words ${system ? "ev-mono text-[11.5px]" : ""}`}
          style={human ? undefined : { color: system ? "var(--sol-text-dim)" : "var(--sol-text-secondary)", borderLeft: system ? undefined : "2px solid var(--ev-rule)", paddingLeft: system ? undefined : 8 }}
        >
          {m.text}
        </div>
      </div>
    </div>
  );
}

/** The cut: a perforated tear across the moment, where the freeze was taken. */
function FrozenCut({ asOf }: { asOf: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-1.5" data-ev-frozen-cut role="separator" aria-label={`Frozen here, ${timeLabel(asOf)}`}>
      <span
        className="flex-1 h-[6px]"
        style={{ backgroundImage: "radial-gradient(circle, var(--sol-text-dim) 1.1px, transparent 1.4px)", backgroundSize: "7px 6px", backgroundRepeat: "repeat-x", backgroundPosition: "left center", opacity: 0.7 }}
      />
      <span className="text-[11px] font-semibold ev-mono" style={{ color: "var(--sol-text)" }}>
        frozen here
      </span>
      <span className="text-[11px] ev-quiet ev-tabular">{timeLabel(asOf)}</span>
      <span className="text-[11px] ev-quiet">what follows is for the judge</span>
    </div>
  );
}

// ── The rep strip ───────────────────────────────────────────────────────────

export interface FreezeRepStripProps {
  runs: RunRow[];
  epochs: Epoch[];
  footing: FootingMarker[];
  cells: Record<string, LedgerCell> | null;
  pair: FreezePair;
  pinnedBatch: string | null;
  width: number;
  /** Which slot the next click sets, for the tooltip. */
  nextSlot?: "a" | "b";
  onPick?: (run: RunRow) => void;
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
  const [tip, setTip] = useState<{ run: RunRow; x: number; y: number } | null>(null);
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
    return <div className="ev-card ev-bench px-4 py-6 text-[12.5px] ev-quiet" data-ev-rep-strip="empty">No graded rep of this freeze yet.</div>;
  }
  const pinnedX = pinnedBatch ? colOf.get(pinnedBatch)?.x ?? null : null;
  return (
    <div className="ev-card ev-bench ev-sf-seis overflow-hidden" data-ev-rep-strip>
      <svg width={w} height={STRIP_H} viewBox={`0 0 ${w} ${STRIP_H}`} role="img" aria-label={`Every rep of this freeze across ${cols.length} batches`} className="block">
        <defs>
          <RepHatch />
        </defs>
        <EpochBands bands={bands} top={TOP} bottom={plotBottom} />
        {pinnedX !== null && <rect x={pinnedX - 6} y={TOP - 4} width={12} height={plotBottom - TOP + 4} rx={3} className="ev-sf-pin" data-ev-pinned-col />}
        <line x1={PAD_L} x2={w - PAD_R} y1={y(PASS_MARK)} y2={y(PASS_MARK)} className="ev-sf-passmark" data-ev-passmark />
        <text x={PAD_L + 2} y={y(PASS_MARK) + 11} className="ev-sf-ylabel ev-sf-ylabel--mark">
          {PASS_MARK}
        </text>
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
            const sel = pair.a === rep.id ? "A" : pair.b === rep.id ? "B" : null;
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
                {sel && (
                  <g data-ev-rep-selected={sel}>
                    <circle cx={cx} cy={cy} r={r + 3.2} fill="none" stroke="var(--sol-text)" strokeWidth={1.3} />
                    <text x={cx} y={cy - r - 6} textAnchor="middle" className="ev-mono" style={{ fontSize: 10, fontWeight: 700, fill: "var(--sol-text)" }}>
                      {sel}
                    </text>
                  </g>
                )}
              </RepMark>
            );
          }),
        )}
        <line x1={PAD_L} x2={w - PAD_R} y1={plotBottom + 1} y2={plotBottom + 1} className="ev-sf-axis" />
        {footing.map((m, k) => {
          const c = colOf.get(m.batch);
          return c ? <FootingGlyph key={k} marker={m} x={c.x} y={plotBottom + 9} scale={1.4} /> : null;
        })}
        {ticks.map((i) => (
          <text key={i} x={rail.list[i].x} y={STRIP_H - 5} textAnchor={i === 0 ? "start" : i === cols.length - 1 ? "end" : "middle"} className="ev-sf-xlabel">
            {dayLabel(cols[i].at)}
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
  if (!run)
    return (
      <div className="ev-card px-4 py-5 text-[12.5px] ev-quiet" data-ev-card-slot={slot}>
        {loading ? `Reading rep ${slot}...` : `Pick rep ${slot}: click a dot on the strip.`}
      </div>
    );
  return (
    <div data-ev-card-slot={slot}>
      <ReplyCard row={run.row} reply={replyOfRun(run)} reasoning={reasoningOfRun(run)} heading={heading} href={evalsHref.run(run.row.id)} />
    </div>
  );
}

function SlotTag({ slot }: { slot: "A" | "B" | "prod" }) {
  return (
    <span
      className="inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded ev-mono text-[10.5px] font-bold"
      style={{ color: "var(--sol-bg)", background: slot === "prod" ? "var(--sol-text-muted)" : "var(--sol-text)" }}
    >
      {slot}
    </span>
  );
}

/** Between the two cards: whether the model saw a different prompt, and the diff when it did. */
function PromptChange({ a, b }: { a: RunResponse; b: RunResponse }) {
  const changed = a.row.promptSha !== b.row.promptSha;
  const pairs = useMemo(() => promptFilePairs(a, b).filter((p) => p.a.text !== p.b.text), [a, b]);
  const [file, setFile] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  if (!changed)
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[12px] ev-quiet" data-ev-prompt-same>
        <span className="ev-mono">=</span>
        Same prompt on both reps (promptSha {shortSha(a.row.promptSha)}): the difference is the model's, not the prompt's.
      </div>
    );
  const shown = pairs.find((p) => p.file === file) ?? pairs[0] ?? null;
  return (
    <section
      className="rounded-lg overflow-hidden"
      style={{ border: "1px solid color-mix(in srgb, var(--sol-magenta) 40%, transparent)", background: "color-mix(in srgb, var(--sol-magenta) 5%, var(--sol-card))" }}
      data-ev-prompt-changed
    >
      <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-left bg-transparent border-0 cursor-pointer" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown className="w-3.5 h-3.5 ev-quiet" /> : <ChevronRight className="w-3.5 h-3.5 ev-quiet" />}
        <span className="text-[13px] font-semibold" style={{ color: "var(--sol-text)" }}>
          Prompt changed
        </span>
        <span className="text-[12px] ev-quiet">
          {pairs.length ? `${pairs.length} file${pairs.length === 1 ? " differs" : "s differ"}` : "the files read the same, so the change is in a request parameter"}
        </span>
        <span className="flex-1" />
        <span className="ev-mono text-[11px] ev-quiet">
          {shortSha(a.row.promptSha)} → {shortSha(b.row.promptSha)}
        </span>
      </button>
      {open && shown && (
        <div className="px-3 pb-3 flex flex-col gap-2">
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

/** At this width and up the two panes sit side by side (40/60); below it the reps come first. */
export const FREEZE_WIDE_PX = 1080;

export function FreezeView({ freeze, cells, footing, pinnedBatch, pair, pick, runA, runB, loadingA = false, loadingB = false, onPair }: FreezeViewProps) {
  const f = freeze.freeze;
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
  const newest = shown.reduce<RunRow | null>((n, r) => (!n || r.stamp > n.stamp ? r : n), null);
  const ends = attributionEnds(pair, freeze.runs, pick);
  const story = pairStory(pair, pick, freeze.runs);

  const pickRep = (run: RunRow) => {
    const next = nextSlot === "a" ? { a: run.id, b: pair.b === run.id ? pair.a : pair.b } : { a: pair.a === run.id ? pair.b : pair.a, b: run.id };
    onPair(next);
    setNextSlot(nextSlot === "a" ? "b" : "a");
  };

  const left = (
    <div className="flex flex-col gap-3 min-w-0" data-ev-freeze-left>
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
          <span className="inline-flex items-center gap-2">
            <SlotTag slot={slot} />
            <span className="font-normal ev-quiet text-[12px]">
              {run?.row.batch ? batchLabel(run.row.batch) : ""}
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
    <div className="flex flex-col gap-3 min-w-0" data-ev-freeze-right>
      <div ref={ref} className="min-w-0">
        <FreezeRepStrip runs={freeze.runs} epochs={freeze.epochs} footing={footing} cells={cells} pair={pair} pinnedBatch={pinnedBatch} width={width} nextSlot={nextSlot} onPick={pickRep} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] ev-quiet">
        <span className="inline-flex items-center gap-1.5">
          <VerdictGlyph state="pass" size={10} /> pass
        </span>
        <span className="inline-flex items-center gap-1.5">
          <VerdictGlyph state="fail" size={10} /> fail
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width={10} height={10} viewBox="-5 -5 10 10" aria-hidden>
            <path d="M-3.6,-3 L3.6,-3 L0,2.6 Z" fill="var(--sol-magenta)" />
          </svg>
          broke
        </span>
        <span className="ev-tabular">
          {passed} of {scored} graded reps passed
        </span>
        {hidden > 0 && <span className="ev-tabular">{hidden} dry or bisect reps hidden</span>}
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1.5" data-ev-next-slot={nextSlot}>
          <Crosshair className="w-3 h-3" />
          A click on a dot sets {nextSlot === "a" ? "A" : "B"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <span className="ev-title" data-ev-pair-title={story.isDefault ? "default" : "picked"}>
          <VerdictGlyph state={story.isDefault && pick.flip ? "mixed" : "unscored"} size={12} />
          {story.title}
        </span>
        <span className="text-[12px] ev-quiet" data-ev-pair-why>
          {story.why}
        </span>
        {!story.isDefault && pick.a && (
          <button type="button" className="ev-chip" onClick={() => onPair({ a: pick.a, b: pick.b })} title="Put back the pair this page opened with" data-ev-pair-reset>
            default pair
          </button>
        )}
        <span className="flex-1" />
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

      <div className="flex flex-col gap-2" data-ev-cards={pairing}>
        {cardFor(first)}
        {pairing === "ab" && runA && runB ? <PromptChange a={runA} b={runB} /> : <div className="h-1" />}
        {cardFor(second)}
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="ev-page flex flex-col gap-4" data-evals-freeze={f.id}>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <VerdictGlyph state={newest ? verdictOfRow(newest) : "unscored"} size={16} title="The newest rep's verdict" />
          <h1 className="m-0 text-[20px] font-semibold ev-mono" style={{ color: "var(--sol-text)", letterSpacing: "-0.01em" }}>
            {f.name}
          </h1>
          <LockBadge visibility={f.visibility} />
          <EvalsLink href={evalsHref.surface(f.surface)} className="ev-chip" title="Open the surface">
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] ev-quiet">
          <span>
            {f.subject.kind} <span style={{ color: "var(--sol-text-secondary)" }}>{f.subject.title}</span>
          </span>
          <span className="ev-tabular">frozen {timeLabel(f.asOf)}</span>
          <span className="ev-tabular">captured {dayLabel(f.createdAt)}</span>
          {f.judge && (
            <button type="button" className="inline-flex items-center gap-1 bg-transparent border-0 p-0 text-[12px] ev-quiet cursor-pointer hover:underline" onClick={() => setCriteriaOpen((o) => !o)} aria-expanded={criteriaOpen}>
              {criteriaOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              criteria
            </button>
          )}
        </div>
        {criteriaOpen && f.judge && <div className="ev-judge" data-ev-criteria>{f.judge}</div>}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <CopyCommand command={`./evals freeze replay ${f.id} --reps 3`} />
          <EvalsLink
            href={evalsHref.bisectNew({ surface: f.surface, good: ends.good, bad: ends.bad, freeze: f.id })}
            className="ev-chip"
            style={{ height: 28, padding: "0 10px", color: "var(--sol-text)" }}
            data-ev-attribute
            title="Attribute the change between A and B on this freeze alone, which keeps probe cost lowest"
          >
            Attribute this freeze
          </EvalsLink>
        </div>
      </header>
      {/* One tree for both layouts: swapping trees would remount the panes and strand the strip's width observer on a dead node. */}
      <div className={wide ? "grid gap-5 items-start" : "flex flex-col gap-5"} style={wide ? { gridTemplateColumns: "minmax(0, 2fr) minmax(0, 3fr)" } : undefined} data-ev-layout={wide ? "wide" : "narrow"}>
        <div className="min-w-0" style={{ order: wide ? 0 : 1 }}>
          {left}
        </div>
        <div className="min-w-0" style={{ order: wide ? 1 : 0 }}>
          {right}
        </div>
      </div>
    </div>
  );
}
