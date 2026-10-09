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
  // Drop the client wrapper prefix line(s) and the "Uncaught Error:" lead. A
  // throw that crossed a ctx.runMutation hop (every chat write rides
  // dispatch.dispatch) arrives with one lead per hop, its structured data
  // flattened into the text of the outer one — so strip every lead, then
  // read the message back out of the JSON the inner ConvexError became.
  // String(err) puts the error's own name ahead of the wrapper, so a lead can come first too.
  const LEADS = /^(\s*(Uncaught\s+)?(Convex|ArgumentValidation)?Error:\s*)+/i;
  msg = msg.replace(LEADS, "");
  msg = msg.replace(/^\[CONVEX [^\]]*\]\s*(\[Request ID: [^\]]*\]\s*)?Server Error\s*/i, "");
  msg = msg.replace(LEADS, "");
  msg = msg.trim();
  if (msg.startsWith("{")) {
    try {
      const parsed = JSON.parse(msg);
      if (typeof parsed?.message === "string") return parsed.message;
    } catch {
      // Not JSON after all: the text is the message.
    }
  }
  return msg || fallback;
}

/**
 * The argument a deployed backend refused because it does not know it yet.
 *
 * A Convex validator is a closed object, so an argument added to a call after
 * the running deployment was pushed does not arrive unread: the whole call is
 * rejected, and the client is handed the validator's source. CLI binaries
 * auto-update on their own cadence, so a person can be on a CLI newer than
 * the backend it talks to and every call carrying the new argument dies.
 * Naming the argument lets a caller that only enriches a read ask again
 * without it, and lets everything else say what is actually wrong.
 */
export function unknownServerArg(raw: unknown): string | null {
  const text = String((raw as any)?.message ?? raw ?? "");
  return text.match(/contains extra field [`"']?([A-Za-z_][A-Za-z0-9_]*)[`"']? that is not in the validator/)?.[1] ?? null;
}

/**
 * The one line a CLI prints for a server error. Same as humanizeConvexError,
 * after redacting the api_token: an ArgumentValidationError dumps the whole
 * args object, token included (`api_token: "…"` or `"api_token":"…"`), and
 * the line must not carry it into a terminal, a transcript or `cast read`.
 */
export function cliErrorMessage(raw: unknown): string {
  const text = String((raw as any)?.message ?? raw ?? "").replace(/("?api_token"?\s*:\s*)"[^"]*"/g, '$1"***"');
  // A rejected argument reads as a validator dump, which tells a person
  // nothing about the cause: their CLI is ahead of the deployment.
  const unknown = unknownServerArg(text);
  if (unknown) return `this codecast server is older than your CLI: it does not take \`${unknown}\` on this call yet, so it refused the whole call. It needs a newer deployment.`;
  return humanizeConvexError(text, "Unknown error");
}
