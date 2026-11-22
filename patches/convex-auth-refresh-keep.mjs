#!/usr/bin/env bun
// Patch 4 for @convex-dev/auth: a failed refresh keeps the refresh token (ct-91563).
//
// fetchAccessToken({ forceRefreshToken }) removes the stored refresh token
// BEFORE it calls auth:signIn. On 2026-11-10 Convex answered that call with
// ExpiredInQueue (overload) in every window at once: the token was gone, the
// socket went anonymous, the next expiry signed people out, and the rejection
// escaped as an "Uncaught" toast.
//
// The rewrite removes nothing up front. A refresh token the server rejects
// still signs out: auth:signIn answers `tokens: null`, and setToken(null)
// clears both keys as before. Only a THROWN call (overload, network, a 5xx)
// keeps the token and answers with the current access token, which is what
// the Convex client already holds, so it neither rejects nor retries in a
// loop; the next reconnect or scheduled refetch tries again.
//
// Idempotent: skipped when the sentinel is present.

import { existsSync, readFileSync, writeFileSync, globSync, realpathSync } from "node:fs";
import { join } from "node:path";

const SENTINEL = "codecastRefreshKeep";
const REL = "dist/react/client.js";

const BEFORE = `                    setIsRefreshingToken(true);
                    await storageRemove(REFRESH_TOKEN_STORAGE_KEY);
                    await verifyCodeAndSetToken({ refreshToken }).finally(() => {
                        setIsRefreshingToken(false);
                    });`;

const AFTER = `                    setIsRefreshingToken(true);
                    // ${SENTINEL}: keep the refresh token until Convex answers; a thrown call (overload, network) is not a logout.
                    try {
                        await verifyCodeAndSetToken({ refreshToken });
                    }
                    catch (error) {
                        logVerbose(\`refresh failed, keeping the refresh token: \${error}\`);
                    }
                    finally {
                        setIsRefreshingToken(false);
                    }`;

const roots = [
  "node_modules/@convex-dev/auth",
  ...globSync("node_modules/.bun/@convex-dev+auth@*/node_modules/@convex-dev/auth"),
  ...globSync("packages/*/node_modules/@convex-dev/auth"),
  ...globSync("packages/*/node_modules/.bun/@convex-dev+auth@*/node_modules/@convex-dev/auth"),
];
const seen = new Set();
for (const root of roots) {
  const file = join(root, REL);
  if (!existsSync(file)) continue;
  const real = realpathSync(file);
  if (seen.has(real)) continue;
  seen.add(real);
  const src = readFileSync(file, "utf8");
  if (src.includes(SENTINEL)) continue;
  if (!src.includes(BEFORE)) {
    console.error(`[convex-auth-refresh-keep] ${file}: refresh code not found; @convex-dev/auth changed, re-check ct-91563`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(file, src.replace(BEFORE, AFTER));
  console.log(`[convex-auth-refresh-keep] Patched ${file}`);
}
