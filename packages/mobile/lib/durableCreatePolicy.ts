import { isRefusedDispatchError } from "@codecast/web/store/mutativeMiddleware";

export type MobileCreateFailureDisposition = "accepted-pending" | "retry";

/**
 * Only a create that will never land asks the user to retry: the server refused
 * it for good, or it was dropped before reaching the outbox (parked:false).
 * Everything else is still on its way. A stale dispatch binding (the auth
 * rewire every cold start goes through) and a transient failure both leave the
 * outbox row in place, and the next drain delivers it.
 */
export function mobileCreateFailureDisposition(
  error: unknown,
): MobileCreateFailureDisposition {
  return isRefusedDispatchError(error) ? "retry" : "accepted-pending";
}

/** The words for a create the server did not confirm: the person's choices
 *  are kept, and retrying is safe. */
export function mobileCreateErrorMessage(subject: string, error: unknown): string {
  const message = String((error as { message?: unknown })?.message ?? error ?? "");
  if (/dispatch not wired|dropped|no outbox/i.test(message)) {
    return `The ${subject} request was not saved. Your choices are still here—retry when the connection is ready.`;
  }
  return `CodeCast could not confirm the ${subject} request. Your choices are still here, and retrying is safe.`;
}