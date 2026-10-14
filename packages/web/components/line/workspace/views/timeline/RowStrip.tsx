"use client";
// A Problems row's time strip (line-journeys.md LJ8.2): the problem's findings
// over the page's window as bars, its newest fix as a line where it went live,
// and the span since tinted by what followed it: green while nothing came back,
// red once something did. Findings after a close that did not hold are red.
// Pure drawing over rowStrip (problemsOverview); the row memoizes it.
import { memo } from "react";
import type { RowStrip as Strip } from "../../../../../lib/line/problemsOverview";

const W = 150;
const H = 24;
const TOP = 3;

export const RowStrip = memo(function RowStrip({ strip: s, words }: { strip: Strip; /** Its hover line (stripWords). */ words: string }) {
  const span = s.d1 - s.d0;
  const x = (t: number) => ((t - s.d0) / span) * W;
  const bw = W / s.n;
  const barW = Math.max(1.5, bw - (bw > 4 ? 1.5 : 0.5));
  const y = (n: number) => (n / s.max) * (H - TOP);
  const fixX = s.fix ? Math.max(0, Math.min(W, x(s.fix.at))) : null;
  return (
    <svg className="lwp-strip lwt-vars" width={W} height={H} viewBox={`0 0 ${W} ${H}`} data-state={s.state} data-fix={s.fix?.kind} role="img" aria-label={words}>
      <title>{words}</title>
      {fixX != null && fixX < W && s.fix!.kind !== "unlive" && <rect className="lwp-strip-after" x={fixX} y={0} width={W - fixX} height={H} />}
      <line className="lwp-strip-base" x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} />
      {s.bars.map((b) => {
        const bx = b.i * bw + (bw - barW) / 2;
        const h = Math.max(2, y(b.n));
        const hb = b.back ? Math.max(2, y(b.back)) : 0;
        return (
          <g key={b.i}>
            {h > hb && <rect className="lwp-strip-bar" x={bx} y={H - h} width={barW} height={h - hb} />}
            {hb > 0 && <rect className="lwp-strip-bar" data-back="" x={bx} y={H - hb} width={barW} height={hb} />}
          </g>
        );
      })}
      {s.closes.map((at) => <line key={at} className="lwp-strip-close" x1={x(at)} x2={x(at)} y1={0} y2={H} />)}
      {fixX != null && fixX > 0 && fixX < W && <line className="lwp-strip-fix" x1={fixX} x2={fixX} y1={0} y2={H} />}
    </svg>
  );
});
