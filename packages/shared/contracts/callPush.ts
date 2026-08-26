// The huddle ring on the wire — every string the server puts in a push and
// the phone matches against, in ONE place. Server (convex/calls.ts) and
// client (mobile usePushNotifications / CallOverlay) both import from here, so
// a rename can never half-land.

/** Push `data.type` for an incoming ring. The phone answers it. */
export const CALL_PUSH_TYPE_RING = "huddle_ring" as const;
/** Push `data.type` for a ring that was never answered. */
export const CALL_PUSH_TYPE_MISSED = "huddle_missed" as const;
/** iOS notification category the phone registers Join/Decline actions on. */
export const CALL_PUSH_CATEGORY = "huddle_ring" as const;
/** Action identifiers on that category. */
export const CALL_PUSH_ACTION_JOIN = "join" as const;
export const CALL_PUSH_ACTION_DECLINE = "decline" as const;
/**
 * The bundled ring sound. Must match a file the app binary ships in its
 * Resources — packages/mobile/assets/sounds/<name>, listed in app.json's
 * expo-notifications `sounds` — or iOS silently plays the default ding.
 */
export const CALL_PUSH_SOUND = "huddle-ring.caf" as const;

/**
 * Ring cadence: web's repeat interval for its synthesized ring, and the cell
 * length of the mobile loop asset (huddle-ring.m4a = one cell; huddle-ring.caf
 * = 8 cells for the closed-app push, iOS caps notification sounds at 30s).
 */
export const CALL_RING_PERIOD_MS = 3_000;

/**
 * Push `data.type` for a recording whose summary just landed.
 *
 * Not a ring and not a huddle, but the same contract problem: the server
 * writes the string, the phone matches it and opens the recording, and a
 * rename that half-lands leaves a push that taps into nothing.
 */
export const RECORDING_SUMMARY_PUSH_TYPE = "recording_summary" as const;

export type RecordingSummaryPush = {
  type: typeof RECORDING_SUMMARY_PUSH_TYPE;
  recordingId: string;
};

/** Parse untrusted push data into a finished recording, or null. */
export function parseRecordingSummaryPush(data: unknown): RecordingSummaryPush | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== RECORDING_SUMMARY_PUSH_TYPE) return null;
  if (typeof d.recordingId !== "string" || !d.recordingId) return null;
  return { type: RECORDING_SUMMARY_PUSH_TYPE, recordingId: d.recordingId };
}

export type CallRingPush = {
  type: typeof CALL_PUSH_TYPE_RING;
  invite_id: string;
  room_key: string;
};

/** Parse untrusted push data into a ring, or null. */
export function parseCallRingPush(data: unknown): CallRingPush | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== CALL_PUSH_TYPE_RING) return null;
  if (typeof d.invite_id !== "string" || typeof d.room_key !== "string") return null;
  return { type: CALL_PUSH_TYPE_RING, invite_id: d.invite_id, room_key: d.room_key };
}
