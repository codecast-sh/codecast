"use client";

import { Fragment, useState, type ReactNode } from "react";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { copyToClipboard } from "@/lib/utils";
import { SOL } from "../blog/blogChrome";

/**
 * Primitives every /features/<slug> page shares. Each page keeps its own look
 * (sections, frames, mocks); what lives here is behaviour that must not drift
 * between them: still mode, how commands wrap, how copying works.
 */

/**
 * Still mode: the reader asked for reduced motion, or the URL carries
 * `?static` (how a background tab, where timers stall, gets the end state).
 * Mocks render their finished frame and run no clocks.
 */
export function useStillMode(): boolean {
  const [still, setStill] = useState(false);
  useWatchEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => setStill(reduce.matches || new URLSearchParams(window.location.search).has("static"));
    read();
    reduce.addEventListener("change", read);
    return () => reduce.removeEventListener("change", read);
  }, []);
  return still;
}

/** Copies `text` and reports `copied` for a moment afterwards. */
export function useCopy(text: string): { copied: boolean; copy: () => Promise<void> } {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy: async () => {
      await copyToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    },
  };
}

/**
 * Command text that wraps only between its words. Browsers break after any
 * hyphen, which splits `--spawn` into `--` and `spawn`, and inside a quoted
 * argument; each such token is kept whole.
 */
export function Whole({ text }: { text: string }) {
  const parts = text.match(/"[^"]*"|\s+|[^\s"]+/g) ?? [text];
  return (
    <>
      {parts.map((p, i) =>
        /^\s/.test(p) ? <Fragment key={i}>{p}</Fragment> : <span key={i} className="whitespace-nowrap">{p}</span>,
      )}
    </>
  );
}

/**
 * Inline code in prose. Short tokens never split; longer ones wrap between
 * words so a phone never scrolls sideways. `tint` colours the chip with the
 * page's accent; `dark` is for chips on a dark band.
 */
export function C({ children, tint, dark = false }: { children: ReactNode; tint?: string; dark?: boolean }) {
  const long = typeof children === "string" && children.length > 24;
  const bg = dark
    ? SOL.base02
    : tint
      ? `color-mix(in srgb, ${tint} 10%, ${SOL.base3})`
      : SOL.base2;
  return (
    <code
      className={`font-mono text-[0.87em] px-1.5 py-0.5 rounded ${long ? "" : "whitespace-nowrap"}`}
      style={{ backgroundColor: bg, color: dark ? SOL.base2 : SOL.base02 }}
    >
      {long ? <Whole text={children} /> : children}
    </code>
  );
}

/** A command on a dark chip with a copy button: the hero and closing call to action. */
export function CopyCommand({ cmd, className = "", onDark = false }: { cmd: string; className?: string; onDark?: boolean }) {
  const { copied, copy } = useCopy(cmd);
  return (
    <button
      type="button"
      onClick={copy}
      className={`group inline-flex max-w-full items-center gap-3 rounded-lg px-4 py-2.5 font-mono text-[13px] text-left transition-colors ${className}`}
      style={{ backgroundColor: onDark ? SOL.base02 : SOL.base03, color: SOL.base2, border: `1px solid ${onDark ? "#0b4a5a" : SOL.base03}` }}
      aria-label={`Copy ${cmd}`}
    >
      <span className="min-w-0 break-words">
        <span style={{ color: SOL.green }}>$ </span>
        <Whole text={cmd} />
      </span>
      <span className="ml-auto shrink-0 text-[11px] transition-colors" style={{ color: copied ? SOL.green : SOL.base1 }}>
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}
