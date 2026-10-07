// The way back after a sign-in that only looked lost. Under load a token
// refresh can read as signed out long enough for AuthGuard to leave the page;
// the person lands on the marketing home or /welcome while still signed in.
// AuthGuard notes the page it leaves (this tab only, sessionStorage), and the
// page it lands on sends the person back the moment auth reads signed in
// again. A note older than RETURN_TTL_MS is a real sign-out followed by a
// later sign-in, which starts fresh.

const KEY = "cc.authReturn";
export const RETURN_TTL_MS = 2 * 60_000;

/** Pages that are never worth returning to: where the leave lands. */
const NOT_A_RETURN = /^\/(?:$|\?|#|welcome|login|signup|auth)/;

type Note = { path: string; at: number };

/** Notes the page being left, unless it is a landing page itself. */
export function noteAuthLeave(path: string, now = Date.now()): void {
  if (NOT_A_RETURN.test(path)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ path, at: now } satisfies Note));
  } catch {
    // Storage refused (private mode, quota): nothing to return to.
  }
}

/** The page to go back to, once, if a recent leave noted one. */
export function takeAuthReturn(now = Date.now()): string | null {
  let note: Note | null = null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    note = JSON.parse(raw) as Note;
  } catch {
    return null;
  }
  if (!note || typeof note.path !== "string" || typeof note.at !== "number") return null;
  if (now - note.at > RETURN_TTL_MS || NOT_A_RETURN.test(note.path)) return null;
  return note.path;
}
