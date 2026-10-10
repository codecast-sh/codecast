// The frame every rich block in a message wears: a cast-canvas and a mod's
// fence alike. A header with the block's name and its controls (show the
// source, copy it, open it fullscreen), a body that folds behind a fade past a
// fixed height with a control to show all of it, and a fullscreen view. The
// block draws only its content; the frame is what makes it read as codecast.

import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronUp, Code2, Copy, Eye, Maximize2, X } from "lucide-react";
import { copyToClipboard } from "../lib/utils";
import { useWatchEffect } from "../hooks/useWatchEffect";

// Blocks taller than this fold behind a fade with an expand control. A fixed
// pixel cap (not vh) keeps measured row heights stable in the virtualized
// message list.
const COLLAPSE_PX = 620;

const headerBtn = "p-1 rounded text-sol-text-dim/70 hover:text-sol-text-secondary hover:bg-sol-bg-highlight/50 transition-colors";

export function BlockFrame({
  title,
  icon,
  actions,
  source,
  copyText,
  copyLabel = "Copy",
  wide = false,
  measureKey,
  children,
  fullscreen: renderFullscreen,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  /** The block's own controls, in the header before the frame's. */
  actions?: ReactNode;
  /** What "show source" swaps the body for. Without it there is no source toggle. */
  source?: ReactNode;
  /** What the copy control copies. Without it there is no copy control. */
  copyText?: string;
  copyLabel?: string;
  /** Lets the fullscreen view run the width of the screen. */
  wide?: boolean;
  /** Changes when the content does, so the fold is measured again. */
  measureKey?: unknown;
  /** The block, as it reads inline. */
  children: ReactNode;
  /** The block in the fullscreen view; inline content when omitted. */
  fullscreen?: () => ReactNode;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const clipRef = useRef<HTMLDivElement>(null);

  // Watch the content's natural height (it can grow after mount: charts
  // hydrate late, tabs re-show panels, a mod redraws) to decide whether the
  // fold is needed. The observer targets the content INSIDE the clipped
  // container, because the container's own box is capped and never grows.
  useWatchEffect(() => {
    const content = clipRef.current?.firstElementChild;
    if (!content || showSource) return;
    const ro = new ResizeObserver(() => setOverflowing(((content as HTMLElement).offsetHeight ?? 0) > COLLAPSE_PX));
    ro.observe(content);
    return () => ro.disconnect();
  }, [showSource, measureKey]);

  const handleCopy = useCallback(async () => {
    if (copyText === undefined) return;
    try {
      await copyToClipboard(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  }, [copyText]);

  useWatchEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const collapsed = overflowing && !expanded;
  const copyButton = (size: number) => copyText !== undefined && (
    <button onClick={handleCopy} className={headerBtn} title={copyLabel}>
      {copied ? <Check size={size} className="text-sol-cyan" /> : <Copy size={size} />}
    </button>
  );

  return (
    <div className="not-prose my-3 overflow-hidden rounded border border-sol-border/40 bg-sol-bg-alt">
      <div className="flex items-center justify-between gap-2 border-b border-sol-border/40 px-3 py-1.5">
        {title ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-sol-text-muted">
            {icon}
            <span className="truncate">{title}</span>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          {actions ? <div className="mr-1 flex items-center gap-1.5">{actions}</div> : null}
          {source !== undefined && (
            <button onClick={() => setShowSource((v) => !v)} className={headerBtn} title={showSource ? "Show rendered" : "Show source"}>
              {showSource ? <Eye size={14} /> : <Code2 size={14} />}
            </button>
          )}
          {copyButton(14)}
          <button onClick={() => setFullscreen(true)} className={headerBtn} title="Fullscreen">
            <Maximize2 size={14} />
          </button>
        </div>
      </div>

      {showSource ? (
        <div className="px-1">{source}</div>
      ) : (
        <>
          <div ref={clipRef} className="relative overflow-hidden" style={collapsed ? { maxHeight: COLLAPSE_PX } : undefined}>
            {children}
            {collapsed && (
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-16"
                style={{ background: "linear-gradient(to bottom, transparent, var(--sol-bg-alt))" }}
              />
            )}
          </div>
          {overflowing && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center justify-center gap-1 border-t border-sol-border/40 py-1 text-[11px] text-sol-text-dim hover:bg-sol-bg-highlight/40 hover:text-sol-text-secondary transition-colors"
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {expanded ? "Collapse" : "Show all"}
            </button>
          )}
        </>
      )}

      {fullscreen &&
        createPortal(
          <div className="canvas-scroll fixed inset-0 z-[100] overflow-auto bg-sol-bg/95 backdrop-blur-xl">
            {title ? (
              <div className="absolute left-4 top-4 z-10 inline-flex max-w-[55%] items-center gap-1.5 rounded-lg border border-sol-border/40 bg-sol-bg-alt/80 px-3 py-1.5 text-xs font-medium text-sol-text-muted backdrop-blur">
                {icon}
                <span className="truncate">{title}</span>
              </div>
            ) : null}
            <div className="absolute right-4 top-4 z-10 flex items-center gap-0.5 rounded-lg border border-sol-border/40 bg-sol-bg-alt/80 px-1 py-0.5 backdrop-blur">
              {copyButton(16)}
              <button onClick={() => setFullscreen(false)} className={headerBtn} title="Close (Esc)">
                <X size={18} />
              </button>
            </div>
            <div className="flex min-h-full items-center justify-center p-8">
              <div className={`w-full ${wide ? "max-w-none" : "max-w-5xl"}`}>{renderFullscreen ? renderFullscreen() : children}</div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
