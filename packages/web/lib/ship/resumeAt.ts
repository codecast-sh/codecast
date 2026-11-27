// Resuming a stopped run at a station, from the app (convex failedRunResume.resume). A stop whose own words in the
// run's graph tell the person to resume the run (`cast workflow resume <task> --at <station>`: a personal Ship's
// Landing unknown and Land cut off, a change run's CI never reported) offers the same as a press: on the web's Ship
// bar, the phone's run card and its run screen. Only the graph's words count, never the run's reason as it came out:
// a reason can carry outside words (a reviewer's findings, a merge's output) that name a resume of their own. Pure,
// with relative imports only: the phone reads it too.
import { serverErrorText } from "../errorCause";
import { SHIPPED_FLOWS } from "../line/shippedFlows.generated";

export type ResumeAt = { at: string; label: string };

const RESUME = /`cast workflow resume \S*\s*--at ([\w-]+)`/;

type StopNode = { id: string; label?: string | null; stop?: string | null };

/**
 * The station a stopped run's stop says to resume it at, by its id and its graph's label; null for any other run. The
 * stop is the exit the run ended at, and its words are the graph's (`stop`), read before any $var was filled in. A
 * node that keeps no words of its own (a repo's variant that only extends the library flow, whose source names none)
 * reads the library flow's node of that `slug`, but only when it is that node: the same id and label. A repo's own
 * node at that id names none.
 */
export function resumeOf(run: { status: string; current_node_id?: string | null; workflow_slug?: string | null }, nodes?: ReadonlyArray<StopNode> | null, slug?: string | null): ResumeAt | null {
  if (run.status !== "failed" || !run.current_node_id) return null;
  const own = nodes?.find((n) => n.id === run.current_node_id);
  const library = (SHIPPED_FLOWS.find((f) => f.slug === (slug ?? run.workflow_slug))?.nodes ?? []) as ReadonlyArray<StopNode>;
  const kept = own && !own.stop ? library.find((n) => n.id === own.id && (n.label ?? n.id) === (own.label ?? own.id)) : undefined;
  const at = RESUME.exec(own?.stop ?? kept?.stop ?? "")?.[1];
  return at ? { at, label: nodes?.find((n) => n.id === at)?.label || at } : null;
}

/** The press's words. */
export const resumeWords = (r: ResumeAt) => `Resume at ${r.label}`;

/** Why the server refused a resume, in its own words (a ConvexError's message), never the error's envelope. */
export const resumeRefusal = (e: unknown): string => {
  const data = (e as { data?: unknown } | null)?.data;
  return typeof data === "string" && data.trim() ? data.trim() : serverErrorText(e);
};
