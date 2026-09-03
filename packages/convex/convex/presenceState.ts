// Coarse person-presence for display surfaces (team strip, hover cards,
// huddle affordances). This is the ONE place raw presence rows become a
// showable state — every UI reads the derived state, never the timestamps,
// so precision stays capped at "active / idle / away / offline" by design
// (honest presence, coarse presence: teammates should never be able to read
// "last keystroke at 14:02:31" off each other).
//
// Built on the same policy as push routing rather than fresh thresholds:
// "active" here and "hold my phone pushes" there must be the same judgment,
// or the app would claim someone is away while routing says they're at the desk.
import {
  INPUT_ACTIVE_MS,
  PRESENCE_FRESH_MS,
  isMachineActivePresence,
  type MachineDevice,
  type PresenceRow,
} from "./presencePolicy";

// Input this old means the person walked away from an otherwise-open surface.
export const PRESENCE_IDLE_MAX_MS = 20 * 60_000;
// The daemon heartbeats every 30s under launchd, independent of any UI. A
// fresh daemon with no other signal means "machine on, person not detectably
// there" — shown as away, never active.
export const DAEMON_FRESH_MS = 5 * 60_000;
// Display timestamps are floored to this bucket before leaving the server so
// a 30s heartbeat usually produces a byte-identical query result and Convex
// skips the push (the roster subscription is team-wide; see wakeSig history).
export const PRESENCE_BUCKET_MS = 60_000;

export type UserPresenceState = "active" | "idle" | "away" | "offline";

export interface PresenceStateInput {
  /** The user's user_presence row, if any. */
  presence?: PresenceRow | null;
  /** The user's devices rows; pass [] when machine-wide presence is opted out. */
  devices?: MachineDevice[];
  /** users.machine_wide_presence — absent means opted in (matches pushRouter). */
  machineWide?: boolean;
  /** users.daemon_last_seen. */
  daemonLastSeen?: number;
}

export function bucketTs(ts: number | undefined): number | undefined {
  if (ts === undefined) return undefined;
  return Math.floor(ts / PRESENCE_BUCKET_MS) * PRESENCE_BUCKET_MS;
}

// The freshest human-input timestamp across the surfaces we may look at.
// Mirrors isMachineActivePresence's device filter: remote boxes and devices
// that report no input contribute nothing (uncertainty degrades toward away).
function latestInputAt(input: PresenceStateInput, now: number): number | undefined {
  const candidates: number[] = [];
  const p = input.presence;
  if (p && now - p.last_seen < PRESENCE_FRESH_MS) candidates.push(p.last_input_at);
  if (input.machineWide ?? true) {
    for (const d of input.devices ?? []) {
      if (d.is_remote || d.last_input_at === undefined) continue;
      if (now - d.last_seen < PRESENCE_FRESH_MS) candidates.push(d.last_input_at);
    }
  }
  if (candidates.length === 0) return undefined;
  return Math.max(...candidates);
}

export function derivePresenceState(
  input: PresenceStateInput,
  now: number,
): UserPresenceState {
  const machineWide = input.machineWide ?? true;
  const surfaceAlive =
    !!input.presence && now - input.presence.last_seen < PRESENCE_FRESH_MS;
  const machineAlive =
    machineWide &&
    (input.devices ?? []).some(
      (d) =>
        !d.is_remote &&
        d.last_input_at !== undefined &&
        now - d.last_seen < PRESENCE_FRESH_MS,
    );

  if (surfaceAlive || machineAlive) {
    const inputAt = latestInputAt(input, now);
    // A future timestamp (clock skew that slipped past the duration-based
    // write path) clamps to "just now" rather than poisoning the math.
    const inputAge = inputAt === undefined ? Infinity : Math.max(0, now - inputAt);
    if (inputAge < INPUT_ACTIVE_MS) return "active";
    if (inputAge < PRESENCE_IDLE_MAX_MS) return "idle";
    return "away";
  }

  // No live surface, but the agent daemon is heartbeating: machine on,
  // person unaccounted for.
  if (input.daemonLastSeen && now - input.daemonLastSeen < DAEMON_FRESH_MS) {
    return "away";
  }
  return "offline";
}

// Re-exported so roster code has one import for the whole presence story.
export { isMachineActivePresence, INPUT_ACTIVE_MS, PRESENCE_FRESH_MS };
export type { MachineDevice, PresenceRow };
