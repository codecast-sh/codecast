// Resuming a stopped run at a station, from the app (convex failedRunResume.resume). A stop whose reason tells the
// person to resume the run (`cast workflow resume <task> --at <station>`: a personal Ship's Landing unknown and Land
// cut off) offers the same as a press: on the web's Ship bar, the phone's run card and its run screen. Pure, with
// relative imports only: the phone reads it too.
import { serverErrorText } from "../errorCause";

export type ResumeAt = { at: string; label: string };

/** The station a stopped run's own reason says to resume it at, by its id and its graph's label; null for any other run. */
export function resumeOf(run: { status: string; fail_reason?: string | null }, nodes?: ReadonlyArray<{ id: string; label?: string | null }> | null): ResumeAt | null {
  const at = run.status === "failed" ? /`cast workflow resume \S*\s*--at ([\w-]+)`/.exec(run.fail_reason ?? "")?.[1] : undefined;
  return at ? { at, label: nodes?.find((n) => n.id === at)?.label || at } : null;
}

/** The press's words. */
export const resumeWords = (r: ResumeAt) => `Resume at ${r.label}`;

/** Why the server refused a resume, in its own words (a ConvexError's message), never the error's envelope. */
export const resumeRefusal = (e: unknown): string => {
  const data = (e as { data?: unknown } | null)?.data;
  return typeof data === "string" && data.trim() ? data.trim() : serverErrorText(e);
};
