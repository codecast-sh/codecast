// Argument resolution for `cast own` / `cast disown`.
//
// Both take (session, member), both optional in practice: `cast own jx7c6zk`
// claims a session for yourself, and `cast own <member>` should hand the
// CURRENT session to someone — the shape every sibling command already has
// (cast rename, cast label set, cast state). Before this existed, a lone
// argument always filled the SESSION slot, so `cast own ashot@example.com`
// died with `No session found for "ashot@example.com"`.
//
// Lives in its own module so the rule is unit-testable: index.ts runs the whole
// CLI as an import side effect, and driving it as a subprocess spawns a daemon
// per invocation.

// A lone argument is a PERSON only when it cannot be a session reference.
//
// The test is deliberately positive-for-member rather than negative-for-session:
// an email or a name containing whitespace is unmistakably a person, while
// anything id-shaped keeps its old meaning. Guessing the other way round could
// silently retarget a real session, which is far worse than an error message.
export const looksLikeMember = (arg: string) => arg.includes("@") || /\s/.test(arg.trim());

export type OwnTarget =
  | { ok: true; sessionId: string; member: string | undefined }
  | { ok: false; member: string };

// Split the positionals into their two slots. `detect` supplies the current
// session; when a lone member is named and nothing is detectable, this reports
// the failure rather than guessing a session or exiting, so the caller owns the
// message and the exit code.
export function resolveOwnTarget(
  first: string,
  second: string | undefined,
  detect: () => string | null,
): OwnTarget {
  if (second !== undefined || !looksLikeMember(first)) {
    return { ok: true, sessionId: first, member: second };
  }
  const current = detect();
  if (!current) return { ok: false, member: first };
  return { ok: true, sessionId: current, member: first };
}
