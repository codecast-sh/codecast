#!/usr/bin/env bun
// Patch 4 for @convex-dev/auth: a failed refresh keeps the refresh token (ct-91563).
//
// fetchAccessToken({ forceRefreshToken }) removes the stored refresh token
// BEFORE it calls auth:signIn. On 2026-11-10 Convex answered that call with
// ExpiredInQueue (overload) in every window at once: the token was gone, the
// socket went anonymous, the next expiry signed people out, and the rejection
// escaped as an "Uncaught" toast.
//
// The rewrite removes nothing up front and sorts a failed call by cause:
// - The server refuses the refresh token (auth:signIn answers `tokens: null`,
//   or throws its own error): both keys are cleared and the window signs out,
//   and a thrown error still rejects, as upstream does.
// - The call never reached a healthy server (ExpiredInQueue / Overloaded, or a
//   fetch TypeError): it is retried up to 3 attempts, 1s then 2s apart plus up
//   to 0.5s jitter, inside the cross-window refresh lock so windows queue
//   instead of piling on. When the attempts run out the refresh token stays,
//   the current access token is returned (the Convex client keeps the socket
//   until it expires), and one console.warn records it. Nothing rejects.
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
                    // ${SENTINEL}: keep the refresh token until Convex answers (ct-91563).
                    const isTransient = (error) => error instanceof TypeError ||
                        /ExpiredInQueue|Overloaded/.test(String(error?.message ?? error));
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
