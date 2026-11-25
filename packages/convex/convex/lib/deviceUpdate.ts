// A device's self update as desired state on its row (Settings > Daemon's
// Update button). The button writes a request; every beat carries it back to
// the daemon until the machine runs the version asked for, and the daemon's
// report of its run (installing, failed with the error) lands on the row, so
// the page shows a machine that has failed to update for a day, and why.
// A pushed daemon command would expire in five minutes and miss a laptop that
// was asleep.
import { v, type Infer } from "convex/values";
import { compareVersions } from "@codecast/shared/contracts/orgTemplateManifest";

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
  /** When the daemon that last beat started. */
  daemon_started_at?: number;
};
type Beat = {
  version: string;
  daemon_started_at?: number;
  update_available?: string;
  /** The newest request this daemon read the release manifest for (0: none yet); absent from older daemons. */
  update_checked_for?: number;
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
  // nothing newer. That check answers from a cache up to a day old, so its ""
  // counts only once the daemon has read the manifest for this request or
  // started a run for it: a request made just after a release was cleared on
  // the old answer before the daemon ever saw it (union-line-1, 2026-11-24).
  // A daemon too old to send update_checked_for is taken at its word, unless
  // the request names its release (below).
  const checked = beat.update_checked_for === undefined || beat.update_checked_for >= row.update_requested_at || row.update_state !== "requested";
  // A request that names its release is done only when the machine runs it:
  // a "" from a machine still below it is a stale cache, and every daemon on
  // 1.1.273 or older sends no update_checked_for to show it (2026-11-24: the
  // whole fleet on 1.1.272 had each press cleared that way).
  const asked = row.update_requested_version;
  const done = asked && isRelease(asked) && isRelease(beat.version)
    ? compareVersions(beat.version, asked) >= 0
    : beat.version === asked || (beat.update_available === "" && checked);
  if (done) {
    return { ...patch, update_requested_version: undefined, update_requested_at: undefined, update_state: undefined, update_error: undefined };
  }
  // A new daemon process (another start time than the one installing) that
  // does not run the version asked for: the run ended without it. End it
  // rather than hold it (and the Update button) as installing for good. A
  // late beat from the installing process itself, sent before its run began,
  // carries the same start time and changes nothing.
  // The daemon read the manifest for this request and found nothing newer
  // than what it runs, below the release asked for: a stale copy of the
  // manifest. Say so rather than leave the request waiting.
  if (asked && row.update_state === "requested" && beat.update_available === "" && beat.update_checked_for !== undefined && beat.update_checked_for >= row.update_requested_at) {
    return { ...patch, update_state: "failed", update_error: `its manifest read found nothing newer than ${beat.version}, not the ${asked} asked for` };
  }
  const restarted =beat.daemon_started_at !== undefined && row.daemon_started_at !== undefined && beat.daemon_started_at !== row.daemon_started_at;
  if (asked && row.update_state === "installing" && restarted && beat.update_status?.at !== row.update_requested_at) {
    return { ...patch, update_state: "failed", update_error: `restarted on ${beat.version}, not the ${asked} asked for` };
  }
  // Only the run answering THIS request moves its state: a failure left over
  // from an earlier press never overwrites a fresh one.
  if (beat.update_status && beat.update_status.at === row.update_requested_at) {
    patch.update_state = beat.update_status.state;
    patch.update_error = beat.update_status.state === "failed" ? beat.update_status.error : undefined;
  }
  return patch;
}

/** A release version (1.2.3), which compareVersions can order. */
export const isRelease = (version: string): boolean => /^\d+\.\d+\.\d+$/.test(version);

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
