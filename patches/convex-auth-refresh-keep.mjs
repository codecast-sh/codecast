#!/usr/bin/env bun
// Patch 4 for @convex-dev/auth: a failed refresh keeps the refresh token (ct-91563).
//
// fetchAccessToken({ forceRefreshToken }) removes the stored refresh token
// BEFORE it calls auth:signIn. On 2026-11-10 Convex answered that call with
// ExpiredInQueue (overload) in every window at once: the token was gone, the
// socket went anonymous, the next expiry signed people out, and the rejection
// escaped as an "Uncaught" toast.
//
// Only two answers come from the auth function itself: `tokens: null` (the
// refresh token is refused) and an HTTP 560 (the function threw). Everything
// else never reached it: an overload (ExpiredInQueue), a gateway 502/504 with
// an HTML body, any other non-560 failure, a dropped connection.
//
// - dist/react/index.js: the provider's unauthenticatedCall marks an error
//   `codecastInTransit` unless Convex answered 560.
// - dist/react/client.js: the refresh removes nothing up front. A refusal
//   (tokens: null, or an unmarked throw) clears both keys and signs out, and a
//   throw still rejects, as upstream does. An in-transit failure is retried up
//   to 3 attempts, 1s then 2s apart plus up to 0.5s jitter, inside the
//   cross-window refresh lock so windows queue instead of piling on. When the
//   attempts run out the refresh token stays, the current access token is
//   returned (the Convex client keeps the socket until it expires), and one
//   console.warn records it. Nothing rejects.
//
// Idempotent: a file holding the current sentinel is skipped. A file holding
// an earlier revision of this patch is rewritten to the current one.

import { existsSync, readFileSync, writeFileSync, globSync, realpathSync } from "node:fs";
import { join } from "node:path";

const CLIENT_SENTINEL = "codecastRefreshKeep:v3";

const CLIENT_UPSTREAM = `                    setIsRefreshingToken(true);
                    await storageRemove(REFRESH_TOKEN_STORAGE_KEY);
                    await verifyCodeAndSetToken({ refreshToken }).finally(() => {
                        setIsRefreshingToken(false);
                    });`;

// Earlier revisions of this patch, so a node_modules patched by them upgrades.
const CLIENT_V1 = `                    setIsRefreshingToken(true);
                    // codecastRefreshKeep: keep the refresh token until Convex answers; a thrown call (overload, network) is not a logout.
                    try {
                        await verifyCodeAndSetToken({ refreshToken });
                    }
                    catch (error) {
                        logVerbose(\`refresh failed, keeping the refresh token: \${error}\`);
                    }
                    finally {
                        setIsRefreshingToken(false);
                    }`;

const retryLoop = (marker, isTransient) => `                    setIsRefreshingToken(true);
                    // ${marker}: keep the refresh token until Convex answers (ct-91563).
                    const isTransient = (error) => ${isTransient};
                    try {
                        for (let attempt = 1;; attempt++) {
                            try {
                                await verifyCodeAndSetToken({ refreshToken });
                                break;
                            }
                            catch (error) {
                                if (!isTransient(error)) {
                                    await setToken({ shouldStore: true, tokens: null });
                                    throw error;
                                }
                                if (attempt >= 3) {
                                    console.warn(\`[convex-auth] refresh failed \${attempt} times, keeping the refresh token: \${error?.message ?? error}\`);
                                    break;
                                }
                                await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1) + Math.random() * 500));
                            }
                        }
                    }
                    finally {
                        setIsRefreshingToken(false);
                    }`;

const CLIENT_V2 = retryLoop("codecastRefreshKeep", `error instanceof TypeError ||
                        /ExpiredInQueue|Overloaded/.test(String(error?.message ?? error))`);

const CLIENT_CURRENT = retryLoop(CLIENT_SENTINEL, `error instanceof TypeError || error?.codecastInTransit === true ||
                        /ExpiredInQueue|Overloaded/.test(String(error?.message ?? error))`);

const INDEX_SENTINEL = "codecastInTransit:v3";

const INDEX_UPSTREAM = `        unauthenticatedCall(action, args) {
            return new ConvexHttpClient(client.address).action(action, args);
        },`;

const INDEX_CURRENT = `        unauthenticatedCall(action, args) {
            // ${INDEX_SENTINEL}: only a 560 comes from the function; anything else never reached it (ct-91563).
            let fromFunction = false;
            const fetchMarkingStatus = async (...fetchArgs) => {
                const response = await fetch(...fetchArgs);
                fromFunction = response.ok || response.status === 560;
                return response;
            };
            return new ConvexHttpClient(client.address, { fetch: fetchMarkingStatus })
                .action(action, args)
                .catch((error) => {
                    if (!fromFunction && error && typeof error === "object")
                        error.codecastInTransit = true;
                    throw error;
                });
        },`;

const EDITS = [
  { rel: "dist/react/client.js", sentinel: CLIENT_SENTINEL, from: [CLIENT_UPSTREAM, CLIENT_V2, CLIENT_V1], to: CLIENT_CURRENT },
  { rel: "dist/react/index.js", sentinel: INDEX_SENTINEL, from: [INDEX_UPSTREAM], to: INDEX_CURRENT },
];

const roots = [
  "node_modules/@convex-dev/auth",
  ...globSync("node_modules/.bun/@convex-dev+auth@*/node_modules/@convex-dev/auth"),
  ...globSync("packages/*/node_modules/@convex-dev/auth"),
  ...globSync("packages/*/node_modules/.bun/@convex-dev+auth@*/node_modules/@convex-dev/auth"),
];
const seen = new Set();
for (const root of roots) {
  for (const { rel, sentinel, from, to } of EDITS) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    const real = realpathSync(file);
    if (seen.has(real)) continue;
    seen.add(real);
    const src = readFileSync(file, "utf8");
    if (src.includes(sentinel)) continue;
    const before = from.find((hunk) => src.includes(hunk));
    if (!before) {
      console.error(`[convex-auth-refresh-keep] ${file}: refresh code not found; @convex-dev/auth changed, re-check ct-91563`);
      process.exitCode = 1;
      continue;
    }
    writeFileSync(file, src.replace(before, to));
    console.log(`[convex-auth-refresh-keep] Patched ${file}`);
  }
}
