import { ConvexError } from "convex/values";

/** The codes a client can branch on. `unauthorized` means the stored visitor
 *  credentials are no good: register again. */
export type ErrorCode = "unauthorized" | "not_found" | "invalid" | "rate_limited";

export type PlaygroundErrorData = {
  code: ErrorCode;
  message: string;
  retry_after_ms?: number;
  /** visitors.register: the proof of work it asks for now (lib/proof). */
  proof_bits?: number;
};

export function fail(code: ErrorCode, message: string, extra: Partial<PlaygroundErrorData> = {}): never {
  throw new ConvexError<PlaygroundErrorData>({ code, message, ...extra });
}
