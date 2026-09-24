"use client";
import { useEffect, useState } from "react";
import { EXIT_MS } from "../hooks/useLinger";

/** The green "running" pulse every live surface shares (inbox card chrome,
 *  section headers, the composer's working line). One definition so the
 *  meaning stays one color and one motion. */
export function LivePulseDot({ className = "w-1 h-1" }: { className?: string }) {
  return <span className={`shrink-0 rounded-full bg-sol-green animate-pulse motion-reduce:animate-none ${className}`} />;
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
        className={`col-start-1 row-start-1 truncate ${outgoing ? "animate-in fade-in-0 slide-in-from-bottom-0.5 duration-200" : ""}`}
      >
        {text}
      </span>
    </span>
  );
}
