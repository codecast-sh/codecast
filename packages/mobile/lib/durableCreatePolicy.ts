import { isParkedDispatchError } from "@codecast/web/store/mutativeMiddleware";

export type MobileCreateFailureDisposition = "accepted-pending" | "retry";

/**
 * Only a confirmed durable enqueue may advance optimistic mobile UI. A
 * parked:false gap and every storage/transport error remain visible so the
 * user can retry with the same intent instead of being navigated to a ghost.
 */
export function mobileCreateFailureDisposition(
  error: unknown,
): MobileCreateFailureDisposition {
  return isParkedDispatchError(error) ? "accepted-pending" : "retry";
}
