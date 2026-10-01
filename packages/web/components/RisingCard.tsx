"use client";
// The app's rising corner card: a face, a serif title, a line or two and two
// actions, riding sonner (bottom right) so the rise, the stack and the swipe
// to dismiss are the toast's own. While it is up it lifts above whatever
// composer sits under the corner. Its look is in globals.css under
// "rise-card"; `accent` tints the border and the primary button.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { OrgButton } from "./org/OrgButton";
import { useMountEffect } from "../hooks/useMountEffect";
import { composerLift } from "../lib/orgIntroCard";

/** The lift, kept current while the card is up: the composer comes and goes
 *  with the route and moves with the window. It moves the toast's own
 *  wrapper (the app paints that wrapper's background), so the whole card
 *  rises and nothing blank is left under it. */
function useComposerLift(ref: React.RefObject<HTMLDivElement | null>): number {
  const [lift, setLift] = useState(0);
  useMountEffect(() => {
    const measure = () => setLift(composerLift(document, window.innerHeight));
    measure();
    const id = window.setInterval(measure, 500);
    window.addEventListener("resize", measure);
    return () => { window.clearInterval(id); window.removeEventListener("resize", measure); };
  });
  // eslint-disable-next-line no-restricted-syntax -- writes the row's margin to match the measured lift, and clears it on the way out
  useEffect(() => {
    const li = ref.current?.closest("li");
    if (!li) return;
    li.style.marginBottom = lift ? `${lift}px` : "";
    return () => { li.style.marginBottom = ""; };
  }, [ref, lift]);
  return lift;
}

export function RisingCard({
  face,
  title,
  lines,
  primaryLabel,
  onPrimary,
  laterLabel,
  onLater,
  accent = "var(--sol-violet)",
  ...data
}: {
  face: ReactNode;
  title: string;
  lines: readonly string[];
  primaryLabel: string;
  onPrimary: () => void;
  laterLabel: string;
  onLater: () => void;
  accent?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  const ref = useRef<HTMLDivElement | null>(null);
  const lift = useComposerLift(ref);
  return (
    <div
      ref={ref}
      className="rise-card"
      role="status"
      style={{ "--rise-accent": accent } as React.CSSProperties}
      data-rise-lift={lift || undefined}
      {...data}
    >
      <div className="rise-card-face">{face}</div>
      <div className="rise-card-body">
        <div className="rise-card-title">{title}</div>
        {lines.map((line) => <p key={line} className="rise-card-copy">{line}</p>)}
        <div className="rise-card-actions">
          <OrgButton primary size="sm" onClick={onPrimary} style={{ background: accent }} data-rise-primary>{primaryLabel}</OrgButton>
          <button type="button" className="rise-card-later" onClick={onLater} data-rise-later>{laterLabel}</button>
        </div>
      </div>
    </div>
  );
}
