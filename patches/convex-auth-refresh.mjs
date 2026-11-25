#!/usr/bin/env bun
// Patch 5 for @convex-dev/auth: with no refresh token left, sign the library
// out too.
//
// In 0.0.79, fetchAccessToken with forceRefreshToken and no stored refresh
// token returns null to Convex without clearing the library's own token.
// Convex marks the socket signed out (the app shows login) while the library
// still reports isAuthenticated. A sign-in then stores new tokens, but
// isAuthenticated never changes, so ConvexProviderWithAuth never hands Convex
// the new token: the login screen stays until the app is killed. This clears
// the library's token on that null, so its state matches what Convex shows.
//
// Keeping the refresh token through a failed refresh, and retrying one that
// failed in transit, is patch 4 (convex-auth-refresh-keep.mjs), which runs
// first.
//
// Idempotent: skipped when the sentinel is already present. A source that no
// longer has the expected text fails the install loudly rather than shipping
// the bug silently.

import { copies, rewriter } from "./convexAuthFiles.mjs";

const SENTINEL = "codecastRefreshSignout";
const rewrite = rewriter("convex-auth-refresh");

const EDITS = [
  {
    old: `                    setIsRefreshingToken(false);
                    logVerbose(\`returning null, there is no refresh token\`);
                    return null;`,
    new: `                    setIsRefreshingToken(false);
                    logVerbose(\`returning null, there is no refresh token\`);
                    // ${SENTINEL}: Convex signs the socket out on this null; sign the
                    // library out with it, or the next sign-in never reaches Convex.
                    await setToken({ shouldStore: true, tokens: null });
                    return null;`,
  },
];

function patchClient(src) {
  if (src.includes(SENTINEL)) return src;
  let out = src;
  for (const edit of EDITS) {
    if (!out.includes(edit.old)) {
      throw new Error(`[convex-auth-refresh] expected text not found; re-check the patch against this @convex-dev/auth version:\n${edit.old}`);
    }
    out = out.replace(edit.old, edit.new);
  }
  return out;
}

for (const f of copies("dist/react/client.js")) rewrite(f, patchClient);
