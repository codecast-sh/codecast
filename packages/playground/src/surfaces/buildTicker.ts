// A change on its way, as the one-line views outside its card say it (the
// capsule's callout, the phone sheet's peek): where it is (starting, in line,
// building, going live, live, failed), which version, how long, the line
// Clay is on, and how far the build line has grown.
import type { BuildView, MessageView } from "../../convex/messages";
import { useBuildProgress } from "../data/builds";
import { ordinal } from "../lib/format";
import { useNow } from "../lib/useNow";
import { buildProgress, type BuildLineState } from "../ui/BuildLine";
import { useAppState, useStream } from "./appState";

/** "landing": live on the server, on its way to this screen. */
export type ChangePhase = "starting" | "queued" | "building" | "landing" | "live" | "failed";

/** Where a request's build stands for this screen, or null once a newer
 *  version has landed over it. `busy`: another build is running now. */
export function changePhase(b: BuildView, landed: number, busy: boolean): ChangePhase | null {
  if (b.status === "queued") return place(b, busy) === 1 ? "starting" : "queued";
  if (b.status === "building") return "building";
  if (b.status === "failed") return "failed";
  const n = b.result_version ?? 0;
  return n > landed ? "landing" : n === landed ? "live" : null;
}

/** Its place in line, counting the build running ahead of it. */
const place = (b: BuildView, busy: boolean) => (b.queue_position ?? 1) + (busy ? 1 : 0);

/** A queued request's chip: "Starting" when nothing is ahead, else its place. */
export function lineLabel(b: BuildView, busy: boolean): string {
  const at = place(b, busy);
  return at === 1 ? "Starting" : ordinal(at);
}

/** Whether any build in the room is running now. */
export function useBusy(): boolean {
  return useStream().messages.some((m) => m.build?.status === "building");
}

export type BuildTicker = {
  phase: ChangePhase;
  version: number;
  /** "Starting", "2nd in line", "Building v15", "v15 going live", "v15 is live", "Didn't make it". */
  title: string;
  /** The line Clay is on, else the request itself. */
  line: string;
  /** Which line that is, steady while its text streams in. */
  lineKey: number | string;
  elapsed: number;
  progress: number;
  state: BuildLineState;
};

export function useBuildTicker(m: MessageView | null): BuildTicker | null {
  const { app, landed } = useAppState();
  const busy = useBusy();
  const now = useNow(1000);
  const b = m?.build;
  const { narration } = useBuildProgress(b?.id);
  const phase = b ? changePhase(b, landed, busy) : null;
  if (!m || !b || !phase) return null;
  const version = b.result_version ?? app.version_count + 1;
  const end = b.finished_at && phase !== "building" ? b.finished_at : now;
  const elapsed = b.started_at ? end - b.started_at : 0;
  const done = phase === "landing" || phase === "live";
  return {
    phase,
    version,
    title: {
      starting: "Starting",
      queued: `${lineLabel(b, busy)} in line`,
      building: `Building v${version}`,
      landing: `v${version} going live`,
      live: `v${version} is live`,
      failed: "Didn't make it",
    }[phase],
    line: phase === "failed" ? (b.error ?? "Clay couldn't finish this one.") : ((phase === "building" || phase === "landing") && narration.at(-1)?.text) || m.body,
    lineKey: (phase === "building" || phase === "landing") && narration.length ? narration[narration.length - 1].at : phase,
    elapsed,
    progress: done ? 100 : phase === "building" || phase === "failed" ? buildProgress(elapsed) : 0,
    state: done ? "live" : phase === "failed" ? "failed" : "building",
  };
}
