"use client";

import { useEffect, useState } from "react";
import type { SessionActivity } from "@codecast/shared/contracts";

// How long an outgoing value stays painted for its exit animation. Matches the
// tailwindcss-animate duration the exit classes below use.
const EXIT_MS = 220;

/** The green "running" pulse every live surface shares (inbox card chrome,
 *  section headers, the composer's working line, the activity line). One
 *  definition so the meaning stays one color and one motion. */
export function LivePulseDot({ className = "w-1 h-1" }: { className?: string }) {
  return <span className={`shrink-0 rounded-full bg-sol-green animate-pulse motion-reduce:animate-none ${className}`} />;
}

/**
 * Hold the last non null value for one exit animation after it goes null, so a
 * node can fade out instead of vanishing. `leaving` is true during that hold.
 * A value that comes back before the hold ends cancels the exit.
 */
export function useLinger<T>(value: T | null): { value: T | null; leaving: boolean } {
  const [held, setHeld] = useState<T | null>(value);
  // eslint-disable-next-line no-restricted-syntax -- the exit timer is keyed to the value it is holding open
  useEffect(() => {
    if (value !== null) {
      setHeld(value);
      return;
    }
    if (held === null) return;
    const id = setTimeout(() => setHeld(null), EXIT_MS);
    return () => clearTimeout(id);
  }, [value, held]);
  return { value: value ?? held, leaving: value === null && held !== null };
}

/**
 * Text that crossfades when it changes: the old text fades out in place while
 * the new one fades in over it, both in one grid cell so the line never
 * changes height. The outgoing copy leaves on its animation end, with a
 * timer behind it for a node that is not painted (a collapsed section never
 * fires animation events).
 */
export function CrossfadeText({ text, className = "" }: { text: string; className?: string }) {
  const [shown, setShown] = useState(text);
  const [outgoing, setOutgoing] = useState<{ text: string; n: number } | null>(null);
  if (shown !== text) {
    setShown(text);
    setOutgoing({ text: shown, n: (outgoing?.n ?? 0) + 1 });
  }
  const n = outgoing?.n ?? 0;
  // eslint-disable-next-line no-restricted-syntax -- one exit timer per outgoing line, cancelled when it is replaced
  useEffect(() => {
    if (!outgoing) return;
    const id = setTimeout(() => setOutgoing((o) => (o && o.n === n ? null : o)), EXIT_MS * 2);
    return () => clearTimeout(id);
  }, [outgoing, n]);
  return (
    <span className={`grid min-w-0 ${className}`}>
      {outgoing && (
        <span
          key={`out-${n}`}
          aria-hidden
          className="col-start-1 row-start-1 truncate animate-out fade-out-0 fill-mode-forwards duration-200"
          onAnimationEnd={() => setOutgoing((o) => (o && o.n === n ? null : o))}
        >
          {outgoing.text}
        </span>
      )}
      <span
        key={`in-${n}`}
        data-sv-activity-text
        className={`col-start-1 row-start-1 truncate ${outgoing ? "animate-in fade-in-0 slide-in-from-bottom-0.5 duration-200" : ""}`}
      >
        {text}
      </span>
    </span>
  );
}

/**
 * What a working session is doing right now, on an inbox card: a live pulse
 * and a present tense phrase ("editing chat.ts"). The caller decides whether
 * there is anything to show (lib/sessionActivity liveActivityOf) and holds it
 * through useLinger so the line fades out when the session stops working;
 * this renders that held value. Hover shows the whole phrase.
 */
export function SessionActivityLine({
  shown,
  compact = false,
}: {
  shown: { value: SessionActivity | null; leaving: boolean };
  compact?: boolean;
}) {
  if (!shown.value) return null;
  return (
    <div
      data-sv-activity
      title={shown.value.text}
      className={`mt-0.5 flex items-center gap-1.5 min-w-0 leading-snug text-sol-text-secondary ${compact ? "text-[10px]" : "text-[11px]"} ${
        shown.leaving ? "animate-out fade-out-0 fill-mode-forwards duration-200" : "animate-in fade-in-0 duration-200"
      }`}
    >
      <LivePulseDot className={compact ? "w-1 h-1" : "w-1.5 h-1.5"} />
      <CrossfadeText text={shown.value.text} className="flex-1" />
    </div>
  );
}
