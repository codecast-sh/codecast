// What ran during a long frame, written into the replay as a `long_frame` mark.
//
// The replay recorder (@platform/analytics/replay) keeps a recording when one
// frame holds the main thread past a second and marks it `freeze {ms}`: how
// long, never why. The browser already knows why. A long-animation-frame entry
// lists the scripts that ran in the frame, what invoked each, how long each
// took, how much of that was layout it forced, and how long style and layout
// took after the scripts. This writes that beside the recorder's own mark, for
// every frame past LONG_FRAME_MS, so a kept recording says whether its freeze
// was a store apply, a React render, an IndexedDB callback or the browser
// laying the page out.
//
// A script is named by its chunk file and character position, which a source
// map turns back into a line; a URL's path, query and hash are dropped, and a
// page URL is never written.

/** A frame this long is written down. The recorder keeps a recording at 1,000. */
export const LONG_FRAME_MS = 250;
/** At most this many scripts per frame, longest first. */
const MAX_SCRIPTS = 5;
/** A script shorter than this is noise beside the ones that made the frame long. */
const MIN_SCRIPT_MS = 10;
/** At most one mark per this window, so a struggling page does not fill the ring. */
const MIN_GAP_MS = 1_000;

type ScriptTiming = {
  duration: number;
  forcedStyleAndLayoutDuration?: number;
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
};

export type LongFrameEntry = {
  startTime: number;
  duration: number;
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: readonly ScriptTiming[];
};

export type LongFrameMark = {
  ms: number;
  /** Time past 50 ms in the frame's tasks: what an input waited behind. */
  blocking: number;
  /** From the start of rendering (rAF callbacks, style, layout) to the frame's end. */
  render: number;
  /** Style and layout alone, after every script. */
  layout: number;
  /** Script time summed over the whole frame, listed or not. */
  script: number;
  scripts: Array<{ ms: number; forced: number; type: string; by: string; fn: string; src: string; at: number }>;
};

/**
 * The file a script came from: the last path segment when it names a script
 * file, no query or hash. An inline script reports the page's own URL, whose
 * last segment can be a conversation id or a link that is a key, so anything
 * that is not a script file is only "(page)".
 */
function fileOf(url: string | undefined): string {
  if (!url) return "";
  const path = url.split(/[?#]/, 1)[0];
  const file = path.slice(path.lastIndexOf("/") + 1);
  return /\.(?:m?js|cjs|ts|tsx|jsx)$/i.test(file) ? file.slice(-60) : "(page)";
}

/**
 * What invoked a script. The browser spells it as a URL for a script element
 * and as `Type.handler` or `TimerHandler:setTimeout` for a callback; only the
 * URL form carries a path, which goes the way of every other URL here.
 */
function invokerOf(invoker: string | undefined): string {
  if (!invoker) return "";
  return (/^[a-z][a-z0-9+.-]*:\/\//i.test(invoker) ? fileOf(invoker) : invoker).slice(0, 60);
}

/** The mark for one long-animation-frame entry, or null when it is not long. */
export function summarizeLongFrame(entry: LongFrameEntry, minMs: number = LONG_FRAME_MS): LongFrameMark | null {
  if (!(entry.duration >= minMs)) return null;
  const end = entry.startTime + entry.duration;
  const all = entry.scripts ?? [];
  let script = 0;
  for (const s of all) script += s.duration;
  const scripts = all
    .filter((s) => s.duration >= MIN_SCRIPT_MS)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, MAX_SCRIPTS)
    .map((s) => ({
      ms: Math.round(s.duration),
      forced: Math.round(s.forcedStyleAndLayoutDuration ?? 0),
      type: s.invokerType ?? "",
      by: invokerOf(s.invoker),
      fn: (s.sourceFunctionName ?? "").slice(0, 40),
      src: fileOf(s.sourceURL),
      at: s.sourceCharPosition ?? -1,
    }));
  return {
    ms: Math.round(entry.duration),
    blocking: Math.round(entry.blockingDuration ?? 0),
    render: entry.renderStart ? Math.max(0, Math.round(end - entry.renderStart)) : 0,
    layout: entry.styleAndLayoutStart ? Math.max(0, Math.round(end - entry.styleAndLayoutStart)) : 0,
    script: Math.round(script),
    scripts,
  };
}

/**
 * Write a `long_frame` mark for each long frame from now on. Returns the stop.
 * A no-op where the browser reports no long animation frames (Safari, Firefox).
 */
export function watchLongFrames(mark: (name: string, data: Record<string, unknown>) => void): () => void {
  if (typeof PerformanceObserver === "undefined") return () => {};
  if (!(PerformanceObserver.supportedEntryTypes ?? []).includes("long-animation-frame")) return () => {};
  let lastAt = -Infinity;
  try {
    const observer = new PerformanceObserver((list) => {
      // The longest frame of the batch speaks for it.
      let worst: LongFrameEntry | null = null;
      for (const entry of list.getEntries() as unknown as LongFrameEntry[]) {
        if (entry.duration >= LONG_FRAME_MS && (!worst || entry.duration > worst.duration)) worst = entry;
      }
      if (!worst || worst.startTime - lastAt < MIN_GAP_MS) return;
      const summary = summarizeLongFrame(worst);
      if (!summary) return;
      lastAt = worst.startTime;
      try {
        mark("long_frame", summary);
      } catch {
        // The recorder stopped under us; the next frame tries again.
      }
    });
    observer.observe({ type: "long-animation-frame", buffered: false });
    return () => observer.disconnect();
  } catch {
    return () => {};
  }
}
