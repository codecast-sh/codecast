import { Ban, Check, Hourglass, type LucideIcon } from "lucide-react";
import { waitTone, type WaitState, type WaitTone } from "@codecast/shared/tasks";

// How a wait (docs/architecture/task-graph.md TG2) DRAWS, on the web only.
// It lives apart from lib/taskBlockers because that module's store readers
// (`storeStatusOf`, `storeTitleOf`) are what the phone's task graph reads
// (packages/mobile/lib/taskGraphRows.ts), and a lucide-react import there
// put all 3,802 web icons in the native bundle — the class of incident
// CLAUDE.md records for `@sentry/react`. The phone draws its own glyphs from
// FontAwesome and its own tones from Theme (app/task/[id].tsx), so nothing
// native needs this file. Keep it that way: anything icon-free a native
// surface could want belongs in taskBlockers, and `lucide-react` is named in
// mobile's bundle guard (lib/bundleGraph.guard.test.ts) so a future import
// fails in seconds instead of shipping.

/** How each wait tone (`waitTone`) draws on every web surface (the row mark,
 *  the task page's lines, the timeline, the plan graph): its sol token for
 *  SVG and its text class. */
export const WAIT_TONE_STYLE: Record<WaitTone, { token: string; text: string }> = {
  waiting: { token: "--sol-orange", text: "text-sol-orange" },
  met: { token: "--sol-green", text: "text-sol-green" },
  failed: { token: "--sol-red", text: "text-sol-red" },
  dim: { token: "--sol-text-dim", text: "text-sol-text-dim" },
};

/** A wait that can no longer clear, wherever one is drawn: a "no entry" sign,
 * never the warning triangle, which marks urgent priority on the same rows. */
const FailedWaitIcon = Ban;

const WAIT_ICON: Record<WaitState, LucideIcon> = { waiting: Hourglass, met: Check, failed: FailedWaitIcon };

/** `tone` is the `waitTone` the style came from, so a caller that also dims
 *  the whole line reads the one decision instead of re-deriving it. */
export type WaitStyle = { icon: LucideIcon; tone: WaitTone; token: string; text: string };

/** Each wait state's glyph in its own colour (`WAIT_TONE_STYLE`). Where it
 *  sits on a task, read `waitStateStyle`. */
export const WAIT_STATE_STYLE = Object.fromEntries(
  Object.entries(WAIT_ICON).map(([state, icon]) => [state, { icon, tone: state as WaitState, ...WAIT_TONE_STYLE[state as WaitState] }]),
) as Record<WaitState, WaitStyle>;

/** A wait's glyph on a task in `status`, in its `waitTone`: its state's
 *  colour while it holds something, dim past that. */
export function waitStateStyle(state: WaitState, status: string | null | undefined, opts?: { untilClosed?: boolean }): WaitStyle {
  const tone = waitTone(state, status, opts);
  return { icon: WAIT_ICON[state], tone, ...WAIT_TONE_STYLE[tone] };
}
