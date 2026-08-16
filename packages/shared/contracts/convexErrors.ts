/**
 * Human-readable message from a thrown Convex error. The client wraps every
 * server throw as "[CONVEX M(fn:name)] [Request ID: …] Server Error\nUncaught
 * Error: <the actual message>\n    at handler (…)" — none of which belongs in
 * a UI. Returns the actual message; a ConvexError with structured data
 * returns its .message.
 */
export function humanizeConvexError(err: unknown, fallback = "Something went wrong"): string {
  const data = (err as any)?.data;
  if (data && typeof data === "object" && typeof data.message === "string") return data.message;
  let msg = String((err as any)?.message ?? err ?? "");
  // Drop the stack tail.
  msg = msg.split(/\n\s*at\s/)[0];
  // Drop the client wrapper prefix line(s) and the "Uncaught Error:" lead.
  msg = msg.replace(/^\[CONVEX [^\]]*\]\s*(\[Request ID: [^\]]*\]\s*)?Server Error\s*/i, "");
  msg = msg.replace(/^\s*(Uncaught\s+)?(Convex|ArgumentValidation)?Error:\s*/i, "");
  msg = msg.trim();
  return msg || fallback;
}
