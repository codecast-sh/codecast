// Validators for the recording and guest vocabularies, derived from the
// shared contracts so the schema, mutation args, the web and the CLI accept
// exactly one set of words. Import these rather than spelling a union again.
import { v } from "convex/values";
import {
  CALL_GUEST_LEFT_REASONS,
  CALL_GUEST_STATUSES,
  CALL_RECORDING_KINDS,
  CALL_RECORDING_STATUSES,
  CALL_RECORDING_STOP_REASONS,
} from "@codecast/shared/contracts";

export const callRecordingKindValidator = v.union(...CALL_RECORDING_KINDS.map((k) => v.literal(k)));
export const callRecordingStatusValidator = v.union(...CALL_RECORDING_STATUSES.map((s) => v.literal(s)));
export const callRecordingStopReasonValidator = v.union(...CALL_RECORDING_STOP_REASONS.map((r) => v.literal(r)));
export const callGuestStatusValidator = v.union(...CALL_GUEST_STATUSES.map((s) => v.literal(s)));
export const callGuestLeftReasonValidator = v.union(...CALL_GUEST_LEFT_REASONS.map((r) => v.literal(r)));
