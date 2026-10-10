"use client";
// One problem's life on one time axis (line-workspace.md LW1 Timeline): the
// occurrences as a histogram, every fix attempt as a bar from its start to its
// end, the merges and ships under them, the deploys that carried a fix as flags
// through every lane, the watch after a ship shaded, and what came back after a
// fix went live marked as a regression. Every mark explains itself on hover;
// dragging across the chart zooms to that span.
//
// Performance: the marks are one memoized SVG built from the history and the
// domain; the pointer (crosshair, tooltip, brush) moves through refs, so a
// hover never re-renders a bar.
import { memo, useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { CauseHistory, HistoryAttempt, HistoryClose } from "../../../../../lib/line/causeHistory";
import {
  alignDown, attemptEndWords, attemptTone, bucketCounts, bucketStep, bucketWords, closeStepLabel, comebackTimes, momentWords, spanWords, timeTicks,
  type Domain, type MarkTone,
} from "../../../../../lib/line/timeline";
import { useDerivedSize } from "../../../../../hooks/useDerivedSize";

/** What a click on the chart picks: a bucket of occurrences, what came back after a close (a fix or a close without one), an attempt. */
export type TimelinePick =
  | { kind: "bucket"; from: number; to: number }
  | { kind: "comeback"; runId: string }
  | { kind: "attempt"; runId: string };

type Tip = { title: string; lines: string[]; tone?: MarkTone; hint?: string };

const GUTTER = 92;
const PAD_R = 18;
const FLAG_H = 22;
const HIST_TOP = FLAG_H + 6;
const HIST_H = 96;
const LANE_H = 20;
const LANE_GAP = 6;
const AXIS_H = 26;
const MAX_LANES = 4;
/** The narrowest an attempt bar draws, so its "#n" always reads: a dissolve that took minutes is still a mark you can name and click. */
const MIN_ATT_W = 26;
const CLOSE_WORDS: Record<HistoryClose["kind"], string> = { shipped: "fix live", dissolved: "dissolved", dropped: "dropped" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Bars that overlap on screen go to separate lanes, oldest first. */
function packLanes(attempts: ReadonlyArray<HistoryAttempt>, x: (t: number) => number, now: number): Map<string, number> {
  const ends: number[] = [];
  const out = new Map<string, number>();
  for (const a of [...attempts].sort((p, q) => p.start - q.start)) {
    const x0 = x(a.start);
    let lane = ends.findIndex((e) => e + 4 <= x0);
    if (lane < 0) lane = ends.length < MAX_LANES ? ends.length : ends.indexOf(Math.min(...ends));
    ends[lane] = Math.max(x0 + MIN_ATT_W, x(a.end ?? now));
    out.set(a.runId, lane);
  }
  return out;
}

export type TimelineChartProps = {
  history: CauseHistory;
  /** A step's label by id, for where a close happened. */
  labelOf?: (id: string) => string | undefined;
  domain: Domain;
  now: number;
  /** The attempt the page has open, ringed. */
  selectedRun: string | null;
  pick: TimelinePick | null;
  onPick: (p: TimelinePick) => void;
  onZoom: (d: Domain) => void;
  onReset: () => void;
};

export const TimelineChart = memo(function TimelineChart({ history: h, labelOf, domain, now, selectedRun, pick, onPick, onZoom, onReset }: TimelineChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const width = useDerivedSize(boxRef, (w) => Math.max(480, Math.round(w)), () => 960);
  const [d0, d1] = domain;
  const plotW = width - GUTTER - PAD_R;
  const x = useCallback((t: number) => GUTTER + ((t - d0) / (d1 - d0)) * plotW, [d0, d1, plotW]);
  const tAt = useCallback((px: number) => d0 + ((px - GUTTER) / plotW) * (d1 - d0), [d0, d1, plotW]);

  // ── the marks, built once per history, domain and width ──
  const drawn = useMemo(() => {
    const tips = new Map<string, Tip>();
    const times = h.occurrences.map((o) => o.at);
    const step = bucketStep(d1 - d0, Math.max(24, Math.min(96, Math.floor(plotW / 9))));
    const b0 = alignDown(d0, step);
    const all = bucketCounts(times, b0, d1, step);
    const back = bucketCounts(comebackTimes(h), b0, d1, step);
    const reopened = bucketCounts(h.occurrences.filter((o) => o.reopened).map((o) => o.at), b0, d1, step);
    const max = Math.max(1, ...all);
    const bars = all.map((n, i) => {
      const from = b0 + i * step;
      return { i, from, to: from + step, n, back: back[i], reopened: reopened[i] };
    }).filter((b) => b.n > 0 && b.to > d0);
    for (const b of bars) {
      const lines = [bucketWords(b.from, step)];
      if (b.back) lines.push(`${b.back === b.n ? (b.n === 1 ? "It" : "All") : b.back} came back after an attempt closed it`);
      if (b.reopened) lines.push(`${plural(b.reopened, "report")} reopened the problem`);
      tips.set(`b:${b.i}`, { title: plural(b.n, "occurrence"), lines, tone: b.back ? "bad" : undefined, hint: "Click to read them" });
    }

    const lanes = packLanes(h.attempts, x, now);
    const laneCount = Math.max(1, Math.min(MAX_LANES, Math.max(0, ...[...lanes.values()].map((l) => l + 1))));
    const attTop = HIST_TOP + HIST_H + 18;
    const shipTop = attTop + laneCount * (LANE_H + LANE_GAP) + 6;
    // The ship lane always draws: an empty one says so in words.
    const axisTop = shipTop + LANE_H + 10;
    const height = axisTop + AXIS_H;

    // A marker at each close, the way an error tracker marks "resolved in": a
    // fix whose deploy is drawn already has its deploy flag. Closes of one kind
    // too close to flag apart share one flag ("#1 to #3 dissolved"), each
    // keeping its own line.
    const marked = h.closes.filter((c) => !(c.kind === "shipped" && h.ships.find((s) => s.runId === c.runId)?.basis === "deploy"));
    const closes: Array<{ c: HistoryClose; cx: number }> = marked.map((c) => ({ c, cx: x(c.at) }));
    // A flag of another kind that would overlap slides right of the one before it, its line still at its own time.
    const flags: Array<{ key: string; cx: number; fx: number; text: string; w: number; kind: HistoryClose["kind"]; runId: string }> = [];
    for (const { c, cx } of closes) {
      const prev = flags[flags.length - 1];
      if (prev && prev.kind === c.kind && cx < prev.fx + prev.w + 4) {
        const first = prev.text.match(/^#(\d+)/)![1];
        prev.text = `#${first} to #${c.n} ${CLOSE_WORDS[c.kind]}`;
        prev.w = prev.text.length * 6 + 14;
        prev.runId = c.runId;
        continue;
      }
      const text = `#${c.n} ${CLOSE_WORDS[c.kind]}`;
      flags.push({ key: c.runId, cx, fx: prev ? Math.max(cx, prev.fx + prev.w + 4) : cx, text, w: text.length * 6 + 14, kind: c.kind, runId: c.runId });
    }
    for (const { c } of closes) {
      const step = closeStepLabel(c.step, labelOf);
      const recur = h.recurrences.find((r) => r.afterRunId === c.runId);
      const reg = h.regressions.find((r) => r.afterRunId === c.runId);
      tips.set(`c:${c.runId}`, {
        title: c.kind === "shipped" ? `Attempt ${c.n}'s fix went live` : `Attempt ${c.n} ${c.kind} it${step ? ` at ${step}` : ""}`,
        lines: [momentWords(c.at), recur ? `${recur.words}.` : reg ? `${reg.words}.` : "Nothing came back after it"],
        tone: recur || reg ? "bad" : c.kind === "shipped" ? "ok" : "closed",
      });
    }

    for (const a of h.attempts) {
      const end = a.end ?? now;
      tips.set(`a:${a.runId}`, {
        title: `Attempt ${a.n}: ${attemptEndWords(a)}`,
        lines: [
          a.outcome.text,
          `${momentWords(a.start)}${a.live ? ", running" : ` to ${momentWords(end)}`} (${spanWords(end - a.start)})`,
          ...(a.card?.headline ? [a.card.headline] : []),
          ...(a.superseded ? ["A later attempt replaced it"] : []),
        ],
        tone: attemptTone(a),
        hint: "Click for its card, diff and path",
      });
    }
    for (const s of h.ships) {
      const a = h.attempts.find((p) => p.runId === s.runId);
      if (s.merge) {
        tips.set(`m:${s.runId}`, {
          title: `Merged ${s.merge.sha.slice(0, 7)} into ${s.merge.into}`,
          lines: [`Attempt ${a?.n ?? "?"}'s fix, from ${s.merge.branch}`, momentWords(s.merge.at), ...(s.deploys.length ? [] : [s.words])],
          tone: "ok",
        });
      } else {
        tips.set(`s:${s.runId}`, { title: `Attempt ${a?.n ?? "?"} shipped`, lines: [s.words, momentWords(s.at)], tone: "ok" });
      }
    }
    for (const dpl of h.deploys) {
      const a = h.attempts.find((p) => p.runId === dpl.runId);
      tips.set(`d:${dpl.id}`, {
        title: dpl.title,
        lines: [
          `Carried attempt ${a?.n ?? "?"}'s fix (${dpl.how})`,
          `${momentWords(dpl.at)}${dpl.target ? `, ${dpl.target}` : ""}${dpl.source ? `, recorded by ${dpl.source}` : ""}`,
        ],
        tone: "ok",
      });
    }
    for (const w of h.watches) {
      const a = h.attempts.find((p) => p.runId === w.runId);
      const words = w.state === "reopened" ? `Reopened ${momentWords(w.reopenedAt ?? w.start)}`
        : w.state === "quiet" ? `Ended quiet${w.end ? ` ${momentWords(w.end)}` : ""}`
        : w.state === "watching" ? `Watching${w.end ? ` until ${momentWords(w.end)}` : ""}`
        : "No end recorded";
      tips.set(`w:${w.runId}`, { title: `Watch after attempt ${a?.n ?? "?"}`, lines: [words, `From ${momentWords(w.start)}`], tone: w.state === "reopened" ? "bad" : "ok" });
    }
    for (const r of h.regressions) {
      const a = h.attempts.find((p) => p.runId === r.afterRunId);
      tips.set(`r:${r.afterRunId}`, {
        title: "Regression",
        lines: [`${r.words}.`, `Attempt ${a?.n ?? "?"}'s fix went live ${momentWords(r.liveAt)}; first back ${momentWords(r.at)}`],
        tone: "bad",
        hint: "Click for the occurrences",
      });
    }
    for (const r of h.recurrences) {
      tips.set(`r:${r.afterRunId}`, {
        title: "Came back",
        lines: [`${r.words}.`, `Closed ${momentWords(r.closedAt)}; first back ${momentWords(r.at)}`],
        tone: "bad",
        hint: "Click for the occurrences",
      });
    }
    // Each comeback's span, a fix's or a close's, drawn the same way.
    const comebacks = [
      ...h.regressions.map((r) => ({ runId: r.afterRunId, from: r.liveAt, at: r.at, until: r.until, count: r.count, n: h.attempts.find((p) => p.runId === r.afterRunId)?.n ?? 0 })),
      ...h.recurrences.map((r) => ({ runId: r.afterRunId, from: r.closedAt, at: r.at, until: r.until, count: r.count, n: r.n })),
    ];
    const unreadBefore = h.capped && h.since ? h.since : h.occurrencesFrom === "recent" ? now - 14 * 24 * 3_600_000 : null;
    if (unreadBefore != null) {
      tips.set("unread", {
        title: "Older occurrences not shown",
        lines: [h.capped ? "The series stops at its cap; older ones exist but were not read." : "Only the last two weeks of reports are here until the full series arrives."],
      });
    }
    const ticks = timeTicks([d0, d1], Math.max(3, Math.floor(plotW / 92)));
    return { tips, step, max, bars, lanes, laneCount, attTop, shipTop, axisTop, height, ticks, unreadBefore, closes, flags, comebacks };
  }, [h, d0, d1, plotW, x, now, labelOf]);

  const { tips, step, max, bars, lanes, attTop, shipTop, axisTop, height, ticks, unreadBefore, closes, flags, comebacks } = drawn;
  const clampX = (v: number) => Math.max(GUTTER, Math.min(GUTTER + plotW, v));
  const barW = Math.max(2, x(d0 + step) - x(d0) - 2);
  const histY = (n: number) => HIST_TOP + HIST_H - (n / max) * (HIST_H - 8);
  const inView = (t0: number, t1: number) => t1 >= d0 && t0 <= d1;

  // ── the pointer: crosshair, tooltip and brush, through refs ──
  const svgRef = useRef<SVGSVGElement>(null);
  const crossRef = useRef<SVGGElement>(null);
  const crossText = useRef<SVGTextElement>(null);
  const brushRef = useRef<SVGRectElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipKey, setTipKey] = useState<string | null>(null);
  const drag = useRef<{ x0: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const frame = useRef(0);

  const localX = (e: { clientX: number }) => {
    const r = svgRef.current?.getBoundingClientRect();
    return r ? ((e.clientX - r.left) / r.width) * width : 0;
  };

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const px = localX(e);
    const target = (e.target as Element).closest?.("[data-tip]")?.getAttribute("data-tip") ?? null;
    if (target !== tipKey) setTipKey(target);
    const cx = e.clientX;
    const cy = e.clientY;
    const dr0 = drag.current;
    if (dr0 && !dr0.moved && Math.abs(px - dr0.x0) > 4) {
      dr0.moved = true;
      svgRef.current?.setPointerCapture(e.pointerId);
    }
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const inside = px >= GUTTER && px <= GUTTER + plotW;
      if (crossRef.current) {
        crossRef.current.style.opacity = inside ? "1" : "0";
        crossRef.current.setAttribute("transform", `translate(${px.toFixed(1)},0)`);
      }
      if (crossText.current && inside) crossText.current.textContent = momentWords(tAt(px));
      const wrap = wrapRef.current?.getBoundingClientRect();
      if (tipRef.current && wrap) {
        const left = Math.min(cx - wrap.left + 14, wrap.width - 280);
        // Below the pointer in the chart's top half, above it in the bottom half, so it never covers the time under the axis.
        const y = cy - wrap.top;
        const top = y > wrap.height / 2 ? y - tipRef.current.offsetHeight - 14 : y + 16;
        tipRef.current.style.transform = `translate(${Math.max(0, left)}px, ${top}px)`;
      }
      const dr = drag.current;
      if (dr && brushRef.current) {
        const a = clampX(Math.min(dr.x0, px));
        const b = clampX(Math.max(dr.x0, px));
        brushRef.current.setAttribute("x", String(a));
        brushRef.current.setAttribute("width", String(dr.moved ? b - a : 0));
      }
    });
  };
  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const px = localX(e);
    if (px < GUTTER || px > GUTTER + plotW) return;
    drag.current = { x0: px, moved: false };
  };
  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const dr = drag.current;
    drag.current = null;
    brushRef.current?.setAttribute("width", "0");
    if (!dr?.moved) return;
    swallowClick.current = true;
    const a = tAt(clampX(Math.min(dr.x0, localX(e))));
    const b = tAt(clampX(Math.max(dr.x0, localX(e))));
    if (b - a >= 10 * 60_000) onZoom([a, b]);
  };
  const onLeave = () => {
    setTipKey(null);
    if (crossRef.current) crossRef.current.style.opacity = "0";
  };

  const tip = tipKey ? tips.get(tipKey) : null;
  const pickRun = pick?.kind === "comeback" ? pick.runId : null;
  const pickBucket = pick?.kind === "bucket" ? pick : null;

  return (
    <div className="lwt-chart" ref={wrapRef} data-line-timeline-chart>
      <div ref={boxRef} className="lwt-box">
      <svg
        ref={svgRef}
        className="lwt-svg"
        style={{ width }}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onPointerMove={onMove}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerLeave={onLeave}
        onDoubleClick={onReset}
        onClickCapture={(e) => {
          if (swallowClick.current) { swallowClick.current = false; e.stopPropagation(); }
        }}
        role="img"
        aria-label="The problem's occurrences, fix attempts, closes, merges, deploys and watches over time"
      >
        <defs>
          <pattern id="lwt-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className="lwt-hatch-line" />
          </pattern>
          <pattern id="lwt-live" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="10" height="10" className="lwt-live-bg" />
            <rect width="4" height="10" className="lwt-live-stripe" />
          </pattern>
          <clipPath id="lwt-plot"><rect x={GUTTER} y={0} width={plotW} height={height} /></clipPath>
        </defs>

        {/* lane labels */}
        <g className="lwt-lane-labels">
          <text x={0} y={HIST_TOP + 12}>Occurrences</text>
          <text x={0} y={HIST_TOP + 27} className="lwt-lane-sub">{max > 1 ? `up to ${max} per ${spanWords(step)}` : `per ${spanWords(step)}`}</text>
          <text x={0} y={attTop + 14}>Fix attempts</text>
          <text x={0} y={shipTop + 14}>Ship, deploy</text>
        </g>

        {/* grid and axis */}
        <g className="lwt-grid">
          {ticks.map((t) => (
            <line key={t.at} x1={x(t.at)} x2={x(t.at)} y1={HIST_TOP} y2={axisTop} data-major={t.major ? "" : undefined} />
          ))}
          <line x1={GUTTER} x2={GUTTER + plotW} y1={HIST_TOP + HIST_H} y2={HIST_TOP + HIST_H} className="lwt-base" />
          <line x1={GUTTER} x2={GUTTER + plotW} y1={axisTop} y2={axisTop} className="lwt-base" />
        </g>
        <g className="lwt-ticks">
          {ticks.map((t) => (
            <text key={t.at} x={x(t.at)} y={axisTop + 16} data-major={t.major ? "" : undefined}>{t.label}</text>
          ))}
        </g>

        <g clipPath="url(#lwt-plot)">
          {/* what the series does not cover */}
          {unreadBefore != null && unreadBefore > d0 && (
            <rect x={GUTTER} y={HIST_TOP} width={Math.max(0, x(unreadBefore) - GUTTER)} height={HIST_H} fill="url(#lwt-hatch)" className="lwt-unread" data-tip="unread" />
          )}

          {/* watch windows, behind everything */}
          {h.watches.map((w) => {
            const end = w.end ?? d1;
            if (!inView(w.start, end)) return null;
            return (
              <g key={`w${w.runId}`} className="lwt-watch" data-state={w.state} data-tip={`w:${w.runId}`}>
                <rect x={x(w.start)} y={HIST_TOP} width={Math.max(2, x(end) - x(w.start))} height={shipTop + LANE_H - HIST_TOP} />
                <text x={x(w.start) + 6} y={HIST_TOP + 12}>{w.state === "reopened" ? "watch, reopened" : w.state === "quiet" ? "watch, quiet" : "watching"}</text>
              </g>
            );
          })}

          {/* what came back after a close: a fix that did not hold, or a close without a change that did not */}
          {comebacks.map((r) => {
            const end = r.until ?? Math.max(now, r.at);
            if (!inView(r.from, end)) return null;
            return (
              <g
                key={`r${r.runId}`}
                className="lwt-regress"
                data-picked={pickRun === r.runId ? "" : undefined}
                data-tip={`r:${r.runId}`}
                onClick={() => onPick({ kind: "comeback", runId: r.runId })}
              >
                <rect x={x(r.from)} y={HIST_TOP} width={Math.max(2, x(end) - x(r.from))} height={HIST_H} />
                <text x={Math.max(x(r.at), GUTTER + 4) + 4} y={HIST_TOP + 26}>came back {r.count === 1 ? "once" : `×${r.count}`} after #{r.n}</text>
              </g>
            );
          })}

          {/* the histogram */}
          <g className="lwt-bars">
            {bars.map((b) => {
              const bx = x(b.from) + 1;
              const picked = !!pickBucket && b.from >= pickBucket.from && b.to <= pickBucket.to;
              return (
                <g key={b.i} data-tip={`b:${b.i}`} data-picked={picked ? "" : undefined} onClick={() => onPick({ kind: "bucket", from: b.from, to: b.to })}>
                  <rect className="lwt-bar-hit" x={bx - 1} y={HIST_TOP} width={barW + 2} height={HIST_H} />
                  <rect className="lwt-bar" x={bx} y={histY(b.n)} width={barW} height={HIST_TOP + HIST_H - histY(b.n)} rx={Math.min(2, barW / 2)} />
                  {b.back > 0 && <rect className="lwt-bar" data-back="" x={bx} y={histY(b.back)} width={barW} height={HIST_TOP + HIST_H - histY(b.back)} rx={Math.min(2, barW / 2)} />}
                  {b.reopened > 0 && <circle className="lwt-reopen" cx={bx + barW / 2} cy={histY(b.n) - 6} r={3} />}
                </g>
              );
            })}
          </g>
          {!h.occurrences.some((o) => o.at >= d0 && o.at <= d1) && (
            <text className="lwt-none" x={GUTTER + plotW / 2} y={HIST_TOP + HIST_H / 2 + 4}>No occurrences in this window</text>
          )}

          {/* fix attempts */}
          {!h.attempts.length && <text className="lwt-none" x={GUTTER + plotW / 2} y={attTop + 14}>No run has taken this problem yet</text>}
          <g className="lwt-attempts">
            {h.attempts.map((a) => {
              const end = a.end ?? now;
              if (!inView(a.start, end)) return null;
              const lane = lanes.get(a.runId) ?? 0;
              const ax = x(a.start);
              const w = Math.max(MIN_ATT_W, x(end) - ax);
              const y = attTop + lane * (LANE_H + LANE_GAP);
              const words = `#${a.n} ${attemptEndWords(a)}`;
              const label = w > words.length * 6.2 + 12 ? words : `#${a.n}`;
              return (
                <g
                  key={a.runId}
                  className="lwt-att"
                  data-tone={attemptTone(a)}
                  data-live={a.live ? "" : undefined}
                  data-superseded={a.superseded ? "" : undefined}
                  data-selected={selectedRun === a.runId ? "" : undefined}
                  data-tip={`a:${a.runId}`}
                  onClick={() => onPick({ kind: "attempt", runId: a.runId })}
                >
                  <rect className="lwt-att-ring" x={ax - 2.5} y={y - 2.5} width={w + 5} height={LANE_H + 5} rx={8} />
                  <rect className="lwt-att-bar" x={ax} y={y} width={w} height={LANE_H} rx={6} fill={a.live ? "url(#lwt-live)" : undefined} />
                  {label && <text x={ax + 7} y={y + 14} className="lwt-att-t">{label}</text>}
                  {a.live && <circle className="lwt-att-pulse" cx={ax + w} cy={y + LANE_H / 2} r={4} />}
                </g>
              );
            })}
          </g>

          {/* merges and ships, and what is not known about their deploys */}
          {!h.ships.some((sh) => (sh.merge?.at ?? sh.at) >= d0 && (sh.merge?.at ?? sh.at) <= d1) && (
            <text className="lwt-none" x={GUTTER + plotW / 2} y={shipTop + 14}>
              {h.ships.length ? "No ship in this window" : h.closes.length ? "Nothing shipped: every close was without a change" : "Nothing shipped yet"}
            </text>
          )}
          <g className="lwt-ships">
            {h.ships.map((s) => {
              const at = s.merge?.at ?? s.at;
              if (at < d0 || at > d1) return null;
              const cx = x(at);
              const cy = shipTop + LANE_H / 2;
              const missing = !s.deploys.length && h.coverage.state !== "unread";
              return (
                <g key={s.runId} className="lwt-merge" data-unmerged={s.merge ? undefined : ""} data-tip={s.merge ? `m:${s.runId}` : `s:${s.runId}`} onClick={() => onPick({ kind: "attempt", runId: s.runId })}>
                  <rect className="lwt-hitbox" x={cx - 10} y={cy - 10} width={20} height={20} />
                  {s.merge
                    ? <rect x={cx - 5.5} y={cy - 5.5} width={11} height={11} rx={2} transform={`rotate(45 ${cx} ${cy})`} />
                    : <circle cx={cx} cy={cy} r={5.5} />}
                  {missing && <text className="lwt-ship-missing" x={cx + 12} y={cy + 4}>no deploy recorded for this fix</text>}
                </g>
              );
            })}
          </g>

          {/* a marker at each close: its line through every lane, then the flags over them */}
          <g className="lwt-closes">
            {closes.map(({ c, cx }) => {
              if (c.at < d0 || c.at > d1) return null;
              return (
                <g key={`c${c.runId}`} className="lwt-close" data-kind={c.kind} data-tip={`c:${c.runId}`} onClick={() => onPick({ kind: "attempt", runId: c.runId })}>
                  <line x1={cx} x2={cx} y1={FLAG_H - 4} y2={shipTop + LANE_H} />
                  <rect className="lwt-hitbox" x={cx - 4} y={FLAG_H} width={8} height={shipTop + LANE_H - FLAG_H} />
                </g>
              );
            })}
            {flags.map((f) => (
              <g key={`f${f.key}`} className="lwt-close" data-kind={f.kind} data-tip={`c:${f.runId}`} onClick={() => onPick({ kind: "attempt", runId: f.runId })}>
                {f.fx > f.cx && <path className="lwt-close-leader" d={`M${f.cx} 17 L${f.fx} 10`} />}
                <path d={`M${f.fx} 3 h${f.w} l-5 7 l5 7 h-${f.w} z`} />
                <text x={f.fx + 5} y={14}>{f.text}</text>
              </g>
            ))}
          </g>

          {/* deploys that carried a fix: a flag and a line through every lane */}
          <g className="lwt-deploys">
            {h.deploys.map((dpl) => {
              if (dpl.at < d0 || dpl.at > d1) return null;
              const dx = x(dpl.at);
              const label = dpl.target ?? "deploy";
              return (
                <g key={dpl.id} className="lwt-deploy" data-tip={`d:${dpl.id}`} onClick={() => onPick({ kind: "attempt", runId: dpl.runId })}>
                  <line x1={dx} x2={dx} y1={FLAG_H - 4} y2={shipTop + LANE_H} />
                  <rect className="lwt-hitbox" x={dx - 4} y={0} width={label.length * 6.2 + 20} height={FLAG_H} />
                  <rect className="lwt-hitbox" x={dx - 4} y={FLAG_H} width={8} height={shipTop + LANE_H - FLAG_H} />
                  <path d={`M${dx} 3 h${label.length * 6.2 + 14} l-5 7 l5 7 h-${label.length * 6.2 + 14} z`} />
                  <text x={dx + 5} y={14}>{label}</text>
                </g>
              );
            })}
          </g>

          {/* now */}
          {now >= d0 && now <= d1 && (
            <g className="lwt-now">
              <line x1={x(now)} x2={x(now)} y1={HIST_TOP} y2={axisTop} />
              <text x={x(now) - 4} y={axisTop - 4}>now</text>
            </g>
          )}
        </g>

        {/* the pointer */}
        <g ref={crossRef} className="lwt-cross" style={{ opacity: 0 }} pointerEvents="none">
          <line x1={0} x2={0} y1={HIST_TOP} y2={axisTop} />
          <rect x={-56} y={axisTop + 3} width={112} height={18} rx={5} />
          <text ref={crossText} x={0} y={axisTop + 16} />
        </g>
        <rect ref={brushRef} className="lwt-brush" x={0} y={HIST_TOP} width={0} height={axisTop - HIST_TOP} pointerEvents="none" />
      </svg>
      </div>

      <div ref={tipRef} className="lwt-tip" data-open={tip ? "" : undefined} data-tone={tip?.tone} role="tooltip" aria-hidden={!tip}>
        {tip && (
          <>
            <b>{tip.title}</b>
            {tip.lines.map((l, i) => <span key={i}>{l}</span>)}
            {tip.hint && <em>{tip.hint}</em>}
          </>
        )}
      </div>
    </div>
  );
});
