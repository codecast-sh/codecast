// Reading an error through its `cause` chain.
//
// React does not hand you the error a render threw. It builds a NEW Error whose
// message is only a React error code — in a production build the unreadable
// "Minified React error #520" — and hangs the real failure off `cause`. Its
// default handler rethrows that wrapper at the window, so a toast, a console
// line and a Sentry event all named the code and nothing else. App code that
// rethrows with `new Error(msg, { cause })` produces the same shape.
//
// Every surface that shows an error to a person walks the chain first.

const MAX_DEPTH = 8;

/** Coerce a thrown value to an Error, or null when it carries no message. */
function asError(value: unknown): Error | null {
  if (value instanceof Error) return value;
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    // An opaque object tells a reader nothing the outer link doesn't already.
    return typeof message === "string" && message ? new Error(message) : null;
  }
  return new Error(String(value));
}

/**
 * The error and every cause under it, outermost first. Bounded in depth and
 * cycle-safe: a cause that points back up the chain stops the walk.
 */
export function errorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  let link = asError(error);
  while (link && chain.length < MAX_DEPTH && !chain.includes(link)) {
    chain.push(link);
    link = asError((link as { cause?: unknown }).cause);
  }
  return chain;
}

/**
 * The innermost link that actually says something — what really went wrong.
 * Falls back to the outermost error when nothing below it has a message, and
 * to a fresh Error when the thrown value was not one at all.
 */
export function rootError(error: unknown): Error {
  const chain = errorChain(error);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].message) return chain[i];
  }
  return chain[0] ?? new Error(String(error));
}

/** The one-line summary a toast title and a dedupe key both use. */
export function errorSummary(error: unknown): string {
  return rootError(error).message;
}

/** Every link's message and stack, for the copied trace and the fix prompt. */
export function describeError(error: unknown): string {
  const chain = errorChain(error);
  if (chain.length === 0) return String(error);
  return chain
    .map((link, i) => `${i === 0 ? "" : "caused by: "}${link.message}\n${link.stack || ""}`)
    .join("\n\n");
}
