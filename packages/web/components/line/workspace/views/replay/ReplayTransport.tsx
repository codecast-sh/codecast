"use client";
// Replay's transport (line-workspace.md LW1), ported from the prototype: first,
// back, play, forward, last; a scrubber with one segment per visit (who decides
// wider than a script), colored as it plays, marked where a decision was
// marked wrong, with the step's name and decision on hover and drag to seek;
// where the playhead is in words; and the speed.
import { memo, useRef, useState } from "react";
import type { LineRunModel } from "../../../../../lib/line/lineModel";
import { scrubWeight } from "../../../../../lib/line/replay";
import { KeyCap } from "../../../../KeyCap";
import { durationWords, outcomeWords } from "../../../widgets";

export type ReplayTransportProps = {
  run: LineRunModel;
  cur: number;
  playing: boolean;
  speed: number;
  /** Steps whose decision on this run someone marked wrong. */
  wrong: ReadonlySet<string>;
  onGo: (i: number) => void;
  onPlay: () => void;
  onSpeed: () => void;
};

const Icon = ({ d }: { d: string }) => <svg viewBox="0 0 16 16" aria-hidden><path d={d} /></svg>;

export const ReplayTransport = memo(function ReplayTransport({ run, cur, playing, speed, wrong, onGo, onPlay, onSpeed }: ReplayTransportProps) {
  const visits = run.visits;
  const n = visits.length;
  const weights = visits.map((v) => scrubWeight(v.kind));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const before = weights.slice(0, cur).reduce((a, b) => a + b, 0);
  const gap = 2;
  // Where the playhead sits: the middle of its segment, gaps counted.
  const headLeft = n ? `calc(${(before + weights[cur] / 2) / total} * (100% - ${(n - 1) * gap}px) + ${cur * gap}px)` : "0px";

  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [tip, setTip] = useState<{ i: number; left: number } | null>(null);
  const segAt = (x: number) => {
    const el = track.current;
    if (!el) return 0;
    const left = x - el.getBoundingClientRect().left;
    let best = 0;
    Array.from(el.children).forEach((c, i) => { if (left >= (c as HTMLElement).offsetLeft - 1) best = i; });
    return best;
  };
  const tipAt = (i: number) => {
    const c = track.current?.children[i] as HTMLElement | undefined;
    return c ? c.offsetLeft + c.offsetWidth / 2 : 0;
  };

  const v = visits[cur];
  const t0 = visits.find((x) => x.startedAt != null)?.startedAt ?? null;
  const since = v?.startedAt != null && t0 != null ? durationWords(v.startedAt - t0) : null;
  const tv = tip ? visits[tip.i] : null;

  return (
    <footer className="rp-transport" data-replay-transport>
      <div className="rp-t-buttons">
        <button type="button" onClick={() => onGo(0)} aria-label="First step" disabled={cur === 0}><Icon d="M3 3v10M13 3 6 8l7 5z" /></button>
        <button type="button" onClick={() => onGo(cur - 1)} aria-label="Step back" disabled={cur === 0}><Icon d="M11 3 4 8l7 5z" /></button>
        <button type="button" className="rp-play" onClick={onPlay} aria-label={playing ? "Pause" : "Play"} aria-pressed={playing} data-replay-play>
          <Icon d={playing ? "M4 3h3v10H4zM9 3h3v10H9z" : "M5 3l8 5-8 5z"} />
        </button>
        <button type="button" onClick={() => onGo(cur + 1)} aria-label="Step forward" disabled={cur >= n - 1}><Icon d="M5 3l7 5-7 5z" /></button>
        <button type="button" onClick={() => onGo(n - 1)} aria-label="Last step" disabled={cur >= n - 1}><Icon d="M13 3v10M3 3l7 5-7 5z" /></button>
      </div>
      <div
        className="rp-scrub"
        role="slider"
        tabIndex={-1}
        aria-label="The run, a step at a time"
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={cur + 1}
        aria-valuetext={v ? `${v.label}, step ${cur + 1} of ${n}` : undefined}
        onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); onGo(segAt(e.clientX)); }}
        onPointerMove={(e) => {
          const i = segAt(e.clientX);
          if (dragging.current && i !== cur) onGo(i);
          if (!tip || tip.i !== i) setTip({ i, left: tipAt(i) });
        }}
        onPointerUp={() => { dragging.current = false; }}
        onPointerCancel={() => { dragging.current = false; }}
        onPointerLeave={() => setTip(null)}
      >
        <div className="rp-track" ref={track}>
          {visits.map((x, i) => (
            <div key={x.index} className="rp-seg" data-kind={x.kind} data-status={x.status} data-played={i <= cur ? "" : undefined} style={{ flex: weights[i] }}>
              {wrong.has(x.node) && !x.inferred && <span className="rp-seg-mark" />}
            </div>
          ))}
        </div>
        <div className="rp-head" style={{ left: headLeft }} />
        {tv && tip && (
          <div className="rp-tip" style={{ left: tip.left }}>
            {tv.label}{tv.kind === "agent" || tv.kind === "person" ? ` · ${tv.kind === "person" ? tv.decided.toWords ?? outcomeWords(tv.decided.outcome, tv.status) : outcomeWords(tv.decided.outcome, tv.status)}` : ""}
          </div>
        )}
      </div>
      <div className="rp-read" aria-live="polite">
        <span>Step <b>{cur + 1}</b> of {n}{v?.label || since ? "," : ""}</span>
        {v?.label && <span className="rp-read-step">{v.label}{since ? "," : ""}</span>}
        {since && <span>{since} in</span>}
      </div>
      <button type="button" className="rp-speed" onClick={onSpeed} aria-label={`Playback speed, ${speed} times`}>{speed}x</button>
      <span className="rp-keys" aria-hidden>
        <KeyCap size="xs">Space</KeyCap><KeyCap size="xs">←</KeyCap><KeyCap size="xs">→</KeyCap>
      </span>
    </footer>
  );
});
