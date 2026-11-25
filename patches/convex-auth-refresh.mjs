#!/usr/bin/env bun
// Patch 4 for @convex-dev/auth: a failed token refresh signs the person out
// and then refuses their next sign-in.
//
// 0.0.79's client refresh (fetchAccessToken with forceRefreshToken):
//   1. deletes the stored refresh token, THEN calls auth:signIn with it. When
//      that call fails (the phone just resumed and has no network yet), the
//      only refresh token is gone and the session is lost for good.
//   2. with no refresh token, returns null to Convex without clearing its own
//      token. Convex marks the socket signed out (the app shows login) while
//      the library still reports isAuthenticated. A sign-in then stores new
//      tokens, but isAuthenticated never changes, so ConvexProviderWithAuth
//      never hands Convex the new token: the login screen stays until the app
//      is killed.
//
// This rewrite keeps the refresh token until a refresh answers (upstream does
// the same from 0.0.98, and the server tolerates a re-presented token, patch
// 2), retries a refresh that failed on the network (also upstream 0.0.98), and
// clears the library's token when there is nothing to refresh with, so its
// state matches what Convex shows and the next sign-in goes through.
//
// Idempotent: skipped when the sentinel is already present. A source that no
// longer has the expected text fails the install loudly rather than shipping
// the bug silently.

import { copies, rewriter } from "./convexAuthFiles.mjs";

const SENTINEL = "codecastRefresh";
const rewrite = rewriter("convex-auth-refresh");

const EDITS = [
  {
    old: `                    await storageRemove(REFRESH_TOKEN_STORAGE_KEY);
                    await verifyCodeAndSetToken({ refreshToken })`,
    new: `                    // ${SENTINEL}: the refresh token stays stored until the refresh answers.
                    await verifyCodeAndSetToken({ refreshToken })`,
  },
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
  {
    old: `        const { tokens } = await client.unauthenticatedCall("auth:signIn", "code" in args
            ? { params: { code: args.code }, verifier: args.verifier }
            : args);`,
    new: `        // ${SENTINEL}: retry a call that failed on the network (a phone resuming
        // from the background often has none for the first second).
        const call = () => client.unauthenticatedCall("auth:signIn", "code" in args
            ? { params: { code: args.code }, verifier: args.verifier }
            : args);
        let tokens;
        for (let attempt = 0;; attempt++) {
            try {
                ({ tokens } = await call());
                break;
            }
            catch (e) {
                if (!(e instanceof TypeError) || attempt >= 2) throw e;
                await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 500 : 2000));
            }
        }`,
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
