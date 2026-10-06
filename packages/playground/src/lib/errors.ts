// The backend's failures are ConvexError({code, message, retry_after_ms?})
// (convex/lib/errors). This reads one back out of whatever was thrown.
import { ConvexError } from "convex/values";
import type { PlaygroundErrorData } from "../../convex/lib/errors";

export function errorData(err: unknown): PlaygroundErrorData {
  if (err instanceof ConvexError && typeof err.data === "object" && err.data && "code" in err.data) {
    return err.data as PlaygroundErrorData;
  }
  return { code: "invalid", message: "Something went wrong. Try again." };
}
