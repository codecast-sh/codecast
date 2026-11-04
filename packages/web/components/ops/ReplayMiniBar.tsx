// The replay page's player bar, compact, for a replay embedded at a moment
// (ReplayMomentEmbed): the same scrubber, with the moment marked and the part
// the import does not hold drawn as the page draws it, the same play button
// and speeds. The player inside the frame hides its own bar and this one
// drives it, so a recording looks and moves the same wherever it plays.
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Pause, Play } from "lucide-react";
import { REPLAY_PLAYER_SPEEDS } from "@codecast/shared/contracts/replayPlayer";
import { formatReplayTime } from "@codecast/shared/replay";
import "./replays.css";

const SPEEDS = REPLAY_PLAYER_SPEEDS.filter((s) => s === 1 || s === 2 || s === 4);

export function ReplayMiniBar({
  t,
  length,
  playing,
  speed,
  moment,
  cut,
  onSeek,
  onToggle,
  onSpeed,
}: {
  t: number;
  length: number;
  playing: boolean;
  speed: number;
  /** The moment the embed was opened at, marked like an issue on the page's scrubber. */
  moment: { t: number; label: string } | null;
  /** Where the imported copy stops, when the recording runs well past it. */
  cut: number | null;
  onSeek: (t: number) => void;
  onToggle: () => void;
  onSpeed: (s: number) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const len = Math.max(1, length);
  const pct = (ms: number) => `${(Math.min(len, Math.max(0, ms)) / len) * 100}%`;
  const at = (clientX: number) => {
    const r = railRef.current?.getBoundingClientRect();
    if (r && r.width > 0) onSeek(Math.min(cut ?? len, ((clientX - r.left) / r.width) * len));
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const to = e.key === "ArrowRight" ? t + 5_000 : e.key === "ArrowLeft" ? t - 5_000 : e.key === "Home" ? 0 : null;
    if (to === null) return;
    e.preventDefault();
    onSeek(Math.max(0, Math.min(cut ?? len, to)));
  };
  const short = (ms: number) => formatReplayTime(ms).replace(/\.\d$/, "");
  return (
    <div className="rp-controls rp-mini">
      <div
        ref={railRef}
        className="ops-scrub rp-scrub"
        role="slider"
        tabIndex={0}
        aria-label="Position"
        aria-valuemin={0}
        aria-valuemax={len}
        aria-valuenow={Math.round(t)}
        aria-valuetext={`${short(t)} of ${short(len)}`}
        onKeyDown={onKey}
        onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          at(e.clientX);
        }}
        onPointerMove={(e) => e.buttons === 1 && at(e.clientX)}
      >
        {moment && <span className="rp-issue-tick" style={{ left: pct(moment.t) }} title={`${short(moment.t)} ${moment.label}`} />}
        {cut !== null && (
          <span className="rp-cut" data-state="none" style={{ left: pct(cut), width: `calc(100% - ${pct(cut)})` }} title={`${short(cut)} of ${short(len)} imported`}>
            <span className="rp-cut-label">not imported</span>
          </span>
        )}
        <div className="ops-scrub-rail" />
        <div className="ops-scrub-fill" style={{ width: pct(t) }} />
        <div className="ops-scrub-head" style={{ left: pct(t) }} />
      </div>
      <div className="ops-player-bar rp-bar">
        <button type="button" className="ops-btn rp-play" onClick={onToggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        </button>
        <span className="ops-mono ops-num text-[12px] whitespace-nowrap rp-clock">
          {short(t)} <span className="ops-dim">/ {short(len)}</span>
        </span>
        <div className="ops-seg rp-speeds" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" data-on={s === speed ? "true" : undefined} aria-pressed={s === speed} onClick={() => onSpeed(s)}>
              {s}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
