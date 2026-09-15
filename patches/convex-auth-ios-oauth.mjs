#!/usr/bin/env bun
// Patch 3 for @convex-dev/auth: Chrome iOS GitHub OAuth.
//
// Chrome iOS (WKWebView) drops the PKCE/state/redirectTo cookies Convex Auth
// sets on the authorize 302: it rejects `Partitioned`, and it often ignores
// Set-Cookie on a 302 that immediately leaves the origin. The callback then
// fails silently and redirects to SITE_URL — the marketing homepage.
//
// This rewrite:
//   - omits `partitioned` from SHARED_COOKIE_OPTIONS
//   - packs pkce+redirectTo into the OAuth `state` param (GitHub round-trips it)
//   - serves a 200 HTML interstitial instead of a 302 so cookies can commit
//   - recovers packed state on the callback when cookies are missing
//   - on callback failure, sends the browser to /login?reason=oauth
//   - uses location.assign for the client-side hop onto convex.site
//
// Idempotent: each rewrite is skipped when its sentinel is already present.

import { existsSync, readFileSync, writeFileSync, globSync } from "node:fs";
import { join } from "node:path";

const SENTINEL = "codecastIosOAuth";

function copies(rel) {
  const out = [];
  const direct = join("node_modules/@convex-dev/auth", rel);
  if (existsSync(direct)) out.push(direct);
  for (const dir of globSync("node_modules/.bun/@convex-dev+auth@*")) {
    const p = join(dir, "node_modules/@convex-dev/auth", rel);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

function rewrite(file, fn) {
  if (!existsSync(file)) return;
  const before = readFileSync(file, "utf8");
  const after = fn(before);
  if (after === before) return;
  writeFileSync(file, after);
  console.log(`[convex-auth-ios-oauth] Patched ${file}`);
}

function stripPartitioned(src) {
  if (!src.includes("partitioned: true")) return src;
  return src.replace(
    /\n\s*partitioned:\s*true,?\n/,
    `\n    // ${SENTINEL}: omit Partitioned — Chrome iOS WKWebView rejects the cookie\n`,
  );
}

const PACK_AND_INTERSTITIAL_JS = `let { redirect, cookies, signature } = await getAuthorizationUrl({
                            provider: await oAuthConfigToInternalProvider(provider),
                            cookies: defaultCookiesOptions(providerId),
                        });
                        await callVerifierSignature(ctx, {
                            verifier,
                            signature,
                        });
                        const redirectTo = url.searchParams.get("redirectTo");
                        if (redirectTo !== null) {
                            cookies.push(redirectToParamCookie(providerId, redirectTo));
                        }
                        // ${SENTINEL}: pack pkce+redirectTo into OAuth state so the
                        // callback can recover when Chrome iOS drops Set-Cookie.
                        const stateCookie = cookies.find((c) => /OAuthstate$/.test(c.name));
                        const pkceCookie = cookies.find((c) => /OAuthpkce$/.test(c.name));
                        if (stateCookie) {
                            const packed = btoa(JSON.stringify({
                                s: stateCookie.value,
                                v: pkceCookie ? pkceCookie.value : undefined,
                                r: redirectTo || undefined,
                            })).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
                            stateCookie.value = packed;
                            try {
                                const u = new URL(redirect);
                                u.searchParams.set("state", packed);
                                redirect = u.toString();
                            } catch {}
                        }
                        const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
                        for (const { name, value, options } of cookies) {
                            headers.append("Set-Cookie", serializeCookie(name, value, options));
                        }
                        // ${SENTINEL}: 200 HTML instead of 302 so Chrome iOS commits cookies.
                        const htmlSafe = String(redirect).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
                        const html = \`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=\${htmlSafe}"></head><body><script>location.replace(\${JSON.stringify(redirect)})</script><a href="\${htmlSafe}">Continue</a></body></html>\`;
                        return new Response(html, { status: 200, headers });`;

const SIGNIN_JS_OLD = `const { redirect, cookies, signature } = await getAuthorizationUrl({
                            provider: await oAuthConfigToInternalProvider(provider),
                            cookies: defaultCookiesOptions(providerId),
                        });
                        await callVerifierSignature(ctx, {
                            verifier,
                            signature,
                        });
                        const redirectTo = url.searchParams.get("redirectTo");
                        if (redirectTo !== null) {
                            cookies.push(redirectToParamCookie(providerId, redirectTo));
                        }
                        const headers = new Headers({ Location: redirect });
                        for (const { name, value, options } of cookies) {
                            headers.append("Set-Cookie", serializeCookie(name, value, options));
                        }
                        return new Response(null, { status: 302, headers });`;

const PACK_AND_INTERSTITIAL_TS = `let { redirect, cookies, signature } =
                await getAuthorizationUrl({
                  provider: await oAuthConfigToInternalProvider(provider),
                  cookies: defaultCookiesOptions(providerId),
                });

              await callVerifierSignature(ctx, {
                verifier,
                signature,
              });

              const redirectTo = url.searchParams.get("redirectTo");

              if (redirectTo !== null) {
                cookies.push(redirectToParamCookie(providerId, redirectTo));
              }

              // ${SENTINEL}: pack pkce+redirectTo into OAuth state so the
              // callback can recover when Chrome iOS drops Set-Cookie.
              const stateCookie = cookies.find((c) => /OAuthstate$/.test(c.name));
              const pkceCookie = cookies.find((c) => /OAuthpkce$/.test(c.name));
              if (stateCookie) {
                const packed = btoa(JSON.stringify({
                  s: stateCookie.value,
                  v: pkceCookie ? pkceCookie.value : undefined,
                  r: redirectTo || undefined,
                })).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
                stateCookie.value = packed;
                try {
                  const u = new URL(redirect);
                  u.searchParams.set("state", packed);
                  redirect = u.toString();
                } catch {}
              }

              const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
              for (const { name, value, options } of cookies) {
                headers.append(
                  "Set-Cookie",
                  serializeCookie(name, value, options),
                );
              }

              // ${SENTINEL}: 200 HTML instead of 302 so Chrome iOS commits cookies.
              const htmlSafe = String(redirect).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
              const html = \`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=\${htmlSafe}"></head><body><script>location.replace(\${JSON.stringify(redirect)})</script><a href="\${htmlSafe}">Continue</a></body></html>\`;
              return new Response(html, { status: 200, headers });`;

const SIGNIN_TS_OLD = `const { redirect, cookies, signature } =
                await getAuthorizationUrl({
                  provider: await oAuthConfigToInternalProvider(provider),
                  cookies: defaultCookiesOptions(providerId),
                });

              await callVerifierSignature(ctx, {
                verifier,
                signature,
              });

              const redirectTo = url.searchParams.get("redirectTo");

              if (redirectTo !== null) {
                cookies.push(redirectToParamCookie(providerId, redirectTo));
              }

              const headers = new Headers({ Location: redirect });
              for (const { name, value, options } of cookies) {
                headers.append(
                  "Set-Cookie",
                  serializeCookie(name, value, options),
                );
              }

              return new Response(null, { status: 302, headers });`;

const RECOVER_JS = `const cookies = getCookies(request);
                    const params = url.searchParams;
                    // Handle OAuth providers that use formData (such as Apple)
                    if (request.headers.get("Content-Type") ===
                        "application/x-www-form-urlencoded") {
                        const formData = await request.formData();
                        for (const [key, value] of formData.entries()) {
                            if (typeof value === "string") {
                                params.append(key, value);
                            }
                        }
                    }
                    // ${SENTINEL}: recover pkce/state/redirectTo from packed state
                    // when Chrome iOS dropped Set-Cookie on the authorize hop.
                    {
                        const packedState = params.get("state");
                        if (packedState) {
                            try {
                                const b64 = packedState.replace(/-/g, "+").replace(/_/g, "/");
                                const parsed = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
                                if (parsed && typeof parsed === "object") {
                                    const names = defaultCookiesOptions(provider.id);
                                    if (!cookies[names.state.name]) cookies[names.state.name] = packedState;
                                    if (parsed.v && !cookies[names.pkceCodeVerifier.name]) cookies[names.pkceCodeVerifier.name] = parsed.v;
                                    const host = "__Host-" + provider.id + "RedirectTo";
                                    const plain = provider.id + "RedirectTo";
                                    if (parsed.r && !cookies[host] && !cookies[plain]) {
                                        cookies[host] = parsed.r;
                                        cookies[plain] = parsed.r;
                                    }
                                }
                            } catch {}
                        }
                    }
                    const maybeRedirectTo = useRedirectToParam(provider.id, cookies);
                    const destinationUrl = await redirectAbsoluteUrl(config, {
                        redirectTo: maybeRedirectTo?.redirectTo,
                    });
                    try {`;

const CALLBACK_JS_OLD = `const cookies = getCookies(request);
                    const maybeRedirectTo = useRedirectToParam(provider.id, cookies);
                    const destinationUrl = await redirectAbsoluteUrl(config, {
                        redirectTo: maybeRedirectTo?.redirectTo,
                    });
                    const params = url.searchParams;
                    // Handle OAuth providers that use formData (such as Apple)
                    if (request.headers.get("Content-Type") ===
                        "application/x-www-form-urlencoded") {
                        const formData = await request.formData();
                        for (const [key, value] of formData.entries()) {
                            if (typeof value === "string") {
                                params.append(key, value);
                            }
                        }
                    }
                    try {`;

const RECOVER_TS = `const cookies = getCookies(request);

            const params = url.searchParams;

            // Handle OAuth providers that use formData (such as Apple)
            if (
              request.headers.get("Content-Type") ===
              "application/x-www-form-urlencoded"
            ) {
              const formData = await request.formData();
              for (const [key, value] of formData.entries()) {
                if (typeof value === "string") {
                  params.append(key, value);
                }
              }
            }

            // ${SENTINEL}: recover pkce/state/redirectTo from packed state
            // when Chrome iOS dropped Set-Cookie on the authorize hop.
            {
              const packedState = params.get("state");
              if (packedState) {
                try {
                  const b64 = packedState.replace(/-/g, "+").replace(/_/g, "/");
                  const parsed = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
                  if (parsed && typeof parsed === "object") {
                    const names = defaultCookiesOptions(provider.id);
                    if (!cookies[names.state.name]) cookies[names.state.name] = packedState;
                    if (parsed.v && !cookies[names.pkceCodeVerifier.name]) cookies[names.pkceCodeVerifier.name] = parsed.v;
                    const host = "__Host-" + provider.id + "RedirectTo";
                    const plain = provider.id + "RedirectTo";
                    if (parsed.r && !cookies[host] && !cookies[plain]) {
                      cookies[host] = parsed.r;
                      cookies[plain] = parsed.r;
                    }
                  }
                } catch {}
              }
            }

            const maybeRedirectTo = useRedirectToParam(provider.id, cookies);

            const destinationUrl = await redirectAbsoluteUrl(config, {
              redirectTo: maybeRedirectTo?.redirectTo,
            });

            try {`;

const CALLBACK_TS_OLD = `const cookies = getCookies(request);

            const maybeRedirectTo = useRedirectToParam(provider.id, cookies);

            const destinationUrl = await redirectAbsoluteUrl(config, {
              redirectTo: maybeRedirectTo?.redirectTo,
            });

            const params = url.searchParams;

            // Handle OAuth providers that use formData (such as Apple)
            if (
              request.headers.get("Content-Type") ===
              "application/x-www-form-urlencoded"
            ) {
              const formData = await request.formData();
              for (const [key, value] of formData.entries()) {
                if (typeof value === "string") {
                  params.append(key, value);
                }
              }
            }

            try {`;

const FAIL_JS_OLD = `catch (error) {
                        logError(error);
                        return Response.redirect(destinationUrl);
                    }`;

const FAIL_JS_NEW = `catch (error) {
                        logError(error);
                        // ${SENTINEL}: a failed callback used to dump the user on SITE_URL (/).
                        return Response.redirect(new URL("/login?reason=oauth", destinationUrl).toString());
                    }`;

const FAIL_TS_OLD = `} catch (error) {
              logError(error);
              return Response.redirect(destinationUrl);
            }`;

const FAIL_TS_NEW = `} catch (error) {
              logError(error);
              // ${SENTINEL}: a failed callback used to dump the user on SITE_URL (/).
              return Response.redirect(new URL("/login?reason=oauth", destinationUrl).toString());
            }`;

function patchIndexJs(src) {
  if (src.includes(SENTINEL)) return src;
  let out = src;
  if (!out.includes(SIGNIN_JS_OLD)) {
    throw new Error("signin JS block not found");
  }
  out = out.replace(SIGNIN_JS_OLD, PACK_AND_INTERSTITIAL_JS);
  if (!out.includes(CALLBACK_JS_OLD)) {
    throw new Error("callback JS block not found");
  }
  out = out.replace(CALLBACK_JS_OLD, RECOVER_JS);
  if (!out.includes(FAIL_JS_OLD)) {
    throw new Error("callback failure JS block not found");
  }
  out = out.replace(FAIL_JS_OLD, FAIL_JS_NEW);
  return out;
}

function patchIndexTs(src) {
  if (src.includes(SENTINEL)) return src;
  let out = src;
  if (!out.includes(SIGNIN_TS_OLD)) {
    throw new Error("signin TS block not found");
  }
  out = out.replace(SIGNIN_TS_OLD, PACK_AND_INTERSTITIAL_TS);
  if (!out.includes(CALLBACK_TS_OLD)) {
    throw new Error("callback TS block not found");
  }
  out = out.replace(CALLBACK_TS_OLD, RECOVER_TS);
  if (!out.includes(FAIL_TS_OLD)) {
    throw new Error("callback failure TS block not found");
  }
  out = out.replace(FAIL_TS_OLD, FAIL_TS_NEW);
  return out;
}

function patchClient(src) {
  if (src.includes(`${SENTINEL}: location.assign`)) return src;
  if (!src.includes("window.location.href = url.toString();")) return src;
  return src.replace(
    "window.location.href = url.toString();",
    `window.location.assign(url.toString()); // ${SENTINEL}: location.assign`,
  );
}

for (const f of copies("src/server/cookies.ts")) rewrite(f, stripPartitioned);
for (const f of copies("dist/server/cookies.js")) rewrite(f, stripPartitioned);
for (const f of copies("src/server/implementation/index.ts")) rewrite(f, patchIndexTs);
for (const f of copies("dist/server/implementation/index.js")) rewrite(f, patchIndexJs);
for (const f of copies("src/react/client.tsx")) rewrite(f, patchClient);
for (const f of copies("dist/react/client.js")) rewrite(f, patchClient);
