// A device's self update as desired state on its row (Settings > Daemon's
// Update button). The button writes a request; every beat carries it back to
// the daemon until the machine runs the version asked for, and the daemon's
// report of its run (installing, failed with the error) lands on the row, so
// the page shows a machine that has failed to update for a day, and why.
// A pushed daemon command would expire in five minutes and miss a laptop that
// was asleep.
import { v, type Infer } from "convex/values";

export const distributionValidator = v.union(v.literal("installer"), v.literal("brew"), v.literal("npm"), v.literal("source"));
export const updateStateValidator = v.union(v.literal("requested"), v.literal("installing"), v.literal("failed"));
/** The daemon's run answering the request made at `at`. */
export const updateStatusValidator = v.object({
  state: v.union(v.literal("installing"), v.literal("failed")),
  error: v.optional(v.string()),
  at: v.optional(v.number()),
});

type Distribution = Infer<typeof distributionValidator>;
type Row = {
  can_self_update?: boolean;
  distribution?: Distribution;
  update_requested_version?: string;
  update_requested_at?: number;
  update_state?: "requested" | "installing" | "failed";
  update_error?: string;
};
type Beat = {
  version: string;
  update_available?: string;
  can_self_update?: boolean;
  distribution?: Distribution;
  update_status?: { state: "installing" | "failed"; error?: string; at?: number };
};

/** The row fields this beat changes. Absent keys leave the row alone. */
export function selfUpdateBeatPatch(row: Row | null | undefined, beat: Beat): Partial<Row> {
  const patch: Partial<Row> = {};
  if (beat.can_self_update !== undefined) patch.can_self_update = beat.can_self_update;
  if (beat.distribution !== undefined) patch.distribution = beat.distribution;
  if (!row?.update_requested_at) return patch;
  // Done: the machine runs the version asked for, or its own check finds
  // nothing newer. The request clears itself.
  if (beat.version === row.update_requested_version || beat.update_available === "") {
    return { ...patch, update_requested_version: undefined, update_requested_at: undefined, update_state: undefined, update_error: undefined };
  }
  // Only the run answering THIS request moves its state: a failure left over
  // from an earlier press never overwrites a fresh one.
  if (beat.update_status && beat.update_status.at === row.update_requested_at) {
    patch.update_state = beat.update_status.state;
    patch.update_error = beat.update_status.state === "failed" ? beat.update_status.error : undefined;
  }
  return patch;
}

/** What the beat's reply asks of the daemon: the open request, until it starts. */
export function updateRequestFor(row: Row | null | undefined): { version: string; at: number } | undefined {
  if (!row?.update_requested_at || row.update_state !== "requested") return undefined;
  return { version: row.update_requested_version ?? "latest", at: row.update_requested_at };
}

/** Why Update cannot run on this install, or null when it can. */
export function selfUpdateBlocked(row: Row): string | null {
  if (row.can_self_update !== false) return null;
  return row.distribution === "source"
    ? "Runs from source"
    : "Binary folder not writable";
}
