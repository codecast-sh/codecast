import { useEffect, useState } from "react";
import { useIdentity } from "../lib/identity";
import { makeLiveSays, versionSummary } from "../lib/versionCopy";
import { Button } from "../ui/Button";
import { FaceStack } from "../ui/FaceStack";
import { ForkIcon } from "../ui/icons";
import { Keys } from "../ui/Keys";
import { useTip } from "../ui/Tip";
import { useAppState, useHereState } from "./appState";
import s from "./ViewingPill.module.css";

const NUDGE_MS = 1400;

/** Who else is looking at version `n` right now, besides you. */
export function useAlsoViewing(n: number | null) {
  const here = useHereState();
  const { me } = useIdentity();
  return n === null ? [] : here.entries.filter((e) => e.viewing_version === n && e.visitor.id !== me.id).map((e) => e.visitor);
}

/** "You're viewing v3, nobody else is", or with whoever is there too. */
export function viewingText(n: number, others: { name: string }[]): string {
  if (others.length === 0) return `You're viewing v${n}, nobody else is`;
  if (others.length === 1) return `You and ${others[0].name} are viewing v${n}`;
  if (others.length === 2) return `You, ${others[0].name} and ${others[1].name} are viewing v${n}`;
  return `You and ${others.length} others are viewing v${n}`;
}

/** Who else sees this version, the first half of the pill's second line. */
function whoSees(others: { name: string }[]): string {
  if (others.length === 0) return "Only you see this";
  if (others.length === 1) return `${others[0].name} is here too`;
  if (others.length === 2) return `${others[0].name} and ${others[1].name} are here too`;
  return `${others.length} others are here too`;
}

/** You are looking at the past (DESIGN 6.7): which version and what it was,
 *  that it is yours alone to look at and cannot be used, and the decisions
 *  it leads to: make it live, fork from it, or go back. It never sits on the
 *  app's own controls: `place` is "bar" (its own strip on top of the open
 *  timeline) or "capsule" (floating just above it). `compact`: a phone's
 *  width, which keeps only Back to live. `nudge`: when the app last tried
 *  to write, which the look-only line answers. */
export function ViewingPill({ number, place, compact, nudge, onBack }: { number: number; place: "bar" | "capsule"; compact: boolean; nudge: number; onBack: () => void }) {
  const { app, versionByNumber, restore, startFork } = useAppState();
  const others = useAlsoViewing(number);
  const entry = versionByNumber.get(number);
  const [restoring, setRestoring] = useState(false);
  const nudged = useNudged(nudge);
  const { describedBy, tip } = useTip(makeLiveSays(number, app.live_version, versionByNumber));
  return (
    <div className={`${s.pill} ${s[place]}`}>
      {others.length > 0 && <span className={s.faces}><FaceStack people={others} max={3} size={16} /></span>}
      <span className={s.text} role="status">
        <span className={s.what}>
          <b className={s.v}>v{number}</b>
          {entry && <span className={s.summary}>{versionSummary(entry, versionByNumber)}</span>}
        </span>
        <span className={`${s.look} ${nudged ? s.nudged : ""}`}>
          {compact ? whoSees(others) : `${whoSees(others)}. Make it live or fork it to use it.`}
        </span>
      </span>
      {!compact && (
        <span className={s.actions}>
          <Button
            variant="accent"
            className={s.tipped}
            busy={restoring}
            {...describedBy}
            onClick={async () => {
              setRestoring(true);
              await restore(number, app.live_version);
              setRestoring(false);
            }}
          >
            Make v{number} live
            {tip}
          </Button>
          <Button className={s.ghost} onClick={() => startFork(number)}><ForkIcon />Fork from here</Button>
        </span>
      )}
      <button className={s.back} onClick={onBack}>Back to live</button>
    </div>
  );
}

/** True for a moment after `at`. */
function useNudged(at: number) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!at) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), NUDGE_MS);
    return () => clearTimeout(t);
  }, [at]);
  return on;
}

/** Point and talk is on: click anything in the app. */
export function PickBanner({ onCancel }: { onCancel: () => void }) {
  return (
    <div className={s.banner}>
      Click anything in the app
      <button className={s.cancel} onClick={onCancel} aria-label="Stop pointing" aria-keyshortcuts="Escape">
        <Keys keys={["Esc"]} hidden>to cancel</Keys>
      </button>
    </div>
  );
}
