// Where a sign-in or a sign-up sends the person afterwards: the `return_to`
// it was given, as URLSearchParams already decoded it (decoding it a second
// time sent a path holding a `%` to the wrong page, and a malformed one threw).
// Only a path on this site is followed; anything else goes to `fallback`.
export function safeReturnTo(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}
