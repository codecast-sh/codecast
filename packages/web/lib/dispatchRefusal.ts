import { PRESENCE_REQUIRED } from "@codecast/shared/contracts/secrets";

/**
 * The person-facing reason inside a server refusal: the last refusal in a
 * (possibly nested, convCommand-wrapped) Convex error message, minus the
 * client tag, request id, stack frames and routing context. "Not authorized"
 * reads as the session access it is.
 */
export function dispatchRefusalReason(message: string, fallback = "rejected by the server"): string {
  const reason =
    message
      .split(/Uncaught (?:Convex)?Error:/)
      .pop()
      ?.split("\n")[0]
      ?.replace(/\s+at\s+(?:async\s+)?\S+\s+\(.*$/, "")
      .replace(/\s+Called by client.*$/, "")
      .replace(`${PRESENCE_REQUIRED}: `, "")
      .trim() || fallback;
  return /not authorized/i.test(reason) ? "you don't have access to that session" : reason;
}
