// Resuming a stopped run at a station, from the app (convex failedRunResume.resume). A stop whose own words in the
// run's graph tell the person to resume the run (`cast workflow resume <task> --at <station>`: a personal Ship's
// Landing unknown and Land cut off, a change run's CI never reported) offers the same as a press: on the web's Ship
// bar, the phone's run card and its run screen. Only the graph's words count, never the run's reason as it came out:
// a reason can carry outside words (a reviewer's findings, a merge's output) that name a resume of their own. Pure,
// with relative imports only: the phone reads it too.
import { serverErrorText } from "../errorCause";

export type ResumeAt = { at: string; label: string };

const RESUME = /`cast workflow resume \S*\s*--at ([\w-]+)`/;

/**
 * The station a stopped run's stop says to resume it at, by its id and its graph's label; null for any other run. The
 * stop is the exit the run ended at, and its words are the graph's (`stop`), read before any $var was filled in.
 */
export function resumeOf(run: { status: string; current_node_id?: string | null }, nodes?: ReadonlyArray<{ id: string; label?: string | null; stop?: string | null }> | null): ResumeAt | null {
  if (run.status !== "failed" || !run.current_node_id) return null;
  const at = RESUME.exec(nodes?.find((n) => n.id === run.current_node_id)?.stop ?? "")?.[1];
  return at ? { at, label: nodes?.find((n) => n.id === at)?.label || at } : null;
}

/** The press's words. */
export const resumeWords = (r: ResumeAt) => `Resume at ${r.label}`;

/** Why the server refused a resume, in its own words (a ConvexError's message), never the error's envelope. */
export const resumeRefusal = (e: unknown): string => {
  const data = (e as { data?: unknown } | null)?.data;
  return typeof data === "string" && data.trim() ? data.trim() : serverErrorText(e);
};
