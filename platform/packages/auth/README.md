# @platform/auth

Codecast's Convex Auth stack, parameterized. Five providers, hashed API tokens
with device binding, the nonce relay for CLI and desktop sign in, and the client
trust rules for web and mobile. Logic is the codecast code, byte for byte where
it is generic; app specifics (table names, deep link schemes, Apple ids, GitHub
scopes, email sending, analytics, the welcome email) are parameters.

No build step. Four subpaths:

| Subpath | Runs in | What it holds |
|---|---|---|
| `@platform/auth/convex` | Convex backend | `createAuthConfig`, the custom providers, the relay and token functions, access helpers |
| `@platform/auth/web` | React web | local auth signal, durable storage, auth gate, provider button model, sign out |
| `@platform/auth/native` | Expo / React Native | boot trust rule, trust anchor store, Apple sheet helper, biometric gate |
| `@platform/auth/cli` | Node CLI | localhost callback listener and the relay poller |

Peer dependencies are pinned to codecast's versions: `@convex-dev/auth 0.0.79`,
`convex ^1.31.6`, `@auth/core ^0.37.2`, `jose 5.10.0`, `oslo ^1.2.1`, `react ^19`.
The native subpath imports no Expo module; the app passes `expo-secure-store`,
`expo-local-authentication` and `expo-apple-authentication` in.

## Inventory (what came from where)

Server, from `codecast/packages/convex/convex`:

| Donor | Here | Change |
|---|---|---|
| `auth.ts` (227) | `convex/createAuthConfig.ts`, `convex/providers.ts`, `convex/callbacks.ts` | Providers and callbacks become factories over parameters. |
| `auth.config.ts` (8) | `convex/authHttpConfig.ts` | `createAuthHttpConfig()`. |
| `cliAuth.ts` (175) | `convex/cliAuth.ts` | Pure claim/sweep helpers unchanged; Convex functions come from `createCliAuthDefinitions`. |
| `apiTokens.ts` (315) | `convex/apiTokens.ts` | Pure helpers unchanged; functions come from `createApiTokenDefinitions`; analytics behind `onEvent`. |
| `lib/auth.ts` | `convex/access.ts` | `requireUser`, `getUserOrToken`, `requireUserOrToken`, `accessError`. |
| `testDb.ts` | `convex/testDb.ts` | Test only. |

Web, from `codecast/packages/web`:

| Donor | Here | Change |
|---|---|---|
| `lib/localAuth.ts` (56) | `web/localAuth.ts` | `createLocalAuth(convexUrl)` returns the four keys, `hasStoredAuthToken`, `useLocalAuth`. |
| `lib/durableAuthStorage.ts` (169) | `web/durableAuthStorage.ts` | `createDurableAuthStorage({ dbName })`. |
| `components/AuthGuard.tsx` (34) | `web/authGuard.tsx` | Pure `authGateDecision`, `useAuthGate`, and an `AuthGuard` that takes the loader and redirect elements. |
| `components/AuthProviderButtons.tsx` (148) | `web/providerSignIn.ts` | `useProviderSignIn` hook plus `OAUTH_PROVIDER_BUTTONS` (labels and glyph paths). No styling. |
| `hooks/useCodecastSignOut.ts` | `web/signOut.ts` | `useDurableSignOut({ keys, purge, beforeSignOut })`. |
| `app/auth/cli/page.tsx` (349) | stays in the app | It is a page. The two mutations it calls come from here. |

Mobile, from `codecast/packages/mobile/lib`:

| Donor | Here | Change |
|---|---|---|
| `authTrust.ts` (68) | `native/authTrust.ts` | Unchanged. |
| `auth.tsx` (422), parts | `native/accessIdentity.ts`, `native/trustAnchor.ts`, `native/appleNative.ts` | The JWT parse, the SecureStore anchor, the biometric preference and gate, and the Apple sheet params. The provider component and the inbox store wiring stay in the app. |

CLI, from `codecast/packages/cli/src`:

| Donor | Here | Change |
|---|---|---|
| `authServer.ts` (165) | `cli/authServer.ts` | Unchanged. |
| `authRelay.ts` (57) | `cli/authRelay.ts` | `cliFetch` is injected as `fetchImpl`; default is `fetch` with `AbortSignal.timeout`. |

Not here, on purpose: `googleOAuth.ts` and `oauthConnectors.ts`. They connect
third party services to an account; they do not sign anyone in. They are a
separate package decision.

## Exported API

### `@platform/auth/convex`

- `createAuthConfig(params): ConvexAuthConfig`. Pass the result to `convexAuth()`. Providers are opt-in per parameter: `google` (added for whisk, ct-44709; credentials from `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`, basic profile scope by default), `github`, `apple`, `appleNative`, `desktopRelay`, `password`.
- `createAuthHttpConfig(domain?)`: the `auth.config.ts` body.
- Providers: `appleNativeProvider({ audience, id? })`, `desktopRelayProvider({ claimForDesktop, id? })`, `otpEmailProvider(id, kind, sendOtp)`, `generateOtpCode()`.
- Callbacks: `makeRedirectCallback({ deepLinkSchemes, siteUrl? })`, `makeCreateOrUpdateUser({ tables?, onUserCreated?, onUserUpdated? })`.
- Relay: `createCliAuthDefinitions({ tables?, ttlMs? })` returning `{ mutations: { deposit }, queries: { pendingDeposit }, internalMutations: { claim, claimForDesktop, sweepExpired } }`; pure `claimCliAuthRequest`, `claimDesktopAuthExchange`, `sweepExpiredCliAuthRequests`, `CLI_AUTH_TTL_MS`.
- Tokens: `createApiTokenDefinitions({ tables?, onEvent?, exchangeExtras? })` returning `{ mutations: { createToken, createSetupToken, revokeToken, renameToken }, queries: { listTokens }, internalMutations: { exchangeSetupToken }, internalQueries: { deviceBindingAllows } }`; pure `hashToken`, `generateToken`, `findTokenDoc`, `verifyApiToken`, `deviceBindingAllows`, `exchangeSetupTokenFor`.

Both return plain `{ args, handler }` definitions, and the app calls its own
builders on them:

```ts
const defs = createApiTokenDefinitions({ onEvent, exchangeExtras });
export const createToken = mutation(defs.mutations.createToken);
export const listTokens = query(defs.queries.listTokens);
export const exchangeSetupToken = internalMutation(defs.internalMutations.exchangeSetupToken);
export const deviceBindingAllows = internalQuery(defs.internalQueries.deviceBindingAllows);
```

Call the builder at the app, never through this package. A Convex builder is
generic over its own args validator, and that inference does not survive being
passed in as a parameter: every function it builds falls back to `any`,
`ApiFromModules` then drops the whole module, and `api.apiTokens.*` stops
existing for callers. `engine-convex` solved the same problem the same way in
`createDispatchDefinition`.

The grouping names the visibility each function must be registered at, and one
of those is a security boundary. Wire callable, `deviceBindingAllows` would
answer "is this token real, and which machine is it tied to?" for anyone who
reaches the deployment. `claim`, `claimForDesktop` and `sweepExpired` hand out
or destroy live credentials on nothing but a nonce.

- Older form, kept working for apps already on it: `makeCliAuthFunctions({ mutation, internalMutation, query, ... })` and `makeApiTokenFunctions({ mutation, query, internalMutation, internalQuery, ... })` call the builders for you and return the functions flat. They return `any`, so an app on this form must state the wire contract of every export by hand. Prefer the definitions above.
- Access: `requireUser`, `getUserOrToken`, `requireUserOrToken`, `accessError`, `forbidden`, `notFound`, `invalidScope`.
- Tables: `DEFAULT_AUTH_TABLES`, `resolveTables`, type `AuthTables`.

### `@platform/auth/web`

- `createLocalAuth(convexUrl)` returning `{ namespace, namespacedKey, jwtKey, refreshTokenKey, oauthVerifierKey, serverStateKey, keys, hasStoredAuthToken, useLocalAuth }`; the raw key constants and `authStorageNamespace`.
- `createDurableAuthStorage({ dbName })` returning `{ storage, readDurableAuthValue, purgeDurableAuthValues }`.
- `authGateDecision`, `useAuthGate(useLocalAuth)`, `AuthGuard`.
- `useDurableSignOut({ keys, purge, beforeSignOut? })`.
- `useProviderSignIn({ verb, redirectTo, pendingDeposit, desktop?, desktopRelayProviderId? })`, `OAUTH_PROVIDER_BUTTONS`, `makeNonce`, `desktopAuthorizeUrl`.

### `@platform/auth/native`

- `localBootTrust`, `shouldClearMemoryFor`, `authRenderDecision` (the trust rule).
- `parseAccessIdentity(token)`.
- `createTrustAnchorStore(secureStore, key?)`, `createBiometricPreference(secureStore, key?)`, `createBiometricGate(localAuth, prompt)`.
- `appleNativeSignInParams(credential)`, `signInWithAppleNative(apple, signIn, providerId?)`.

### `@platform/auth/cli`

- `AuthServer` (`listen`, `waitForCallback`, `getNonce`, `getPort`, `stop`), type `AuthResult`.
- `startRelayPoller(siteUrl, nonce, { intervalMs?, fetchImpl?, path? })`, `defaultRelayFetch`.

## Parameter surface

| Parameter | Where | Codecast value |
|---|---|---|
| Deep link schemes | `createAuthConfig.redirect.deepLinkSchemes` | `["codecast://", "exp+codecast://"]` |
| Site URL | `redirect.siteUrl` | `process.env.SITE_URL` (default) |
| Apple bundle id (native audience) | `appleNative.audience` | `com.ashotp.codecast` |
| Apple Services ID | Convex env `AUTH_APPLE_ID` / `AUTH_APPLE_SECRET` (read by `@auth/core`) | unchanged |
| GitHub scopes | `github.scope` | `read:user user:email repo read:org` |
| GitHub profile fields | `github.profile` | id, email, name, image, github_id, github_username, github_avatar_url, github_access_token |
| Session durations | `session.totalDurationMs`, `session.inactiveDurationMs` | 10 years, 2 years (defaults) |
| JWT duration | `jwt.durationMs` | 1 year (default) |
| OTP email sender | `password.sendOtp({ email, code, kind })` | `deliver(email, passwordReset(...) or verifyEmail(...), kind)` |
| Email verification | `password.emailVerification` | `process.env.AUTH_EMAIL_VERIFICATION === "1"` (default) |
| User created hook | `onUserCreated(ctx, { userId, email, name, profile })` | advance view revision, schedule `internal.emails.send.sendWelcome` |
| User updated hook | `onUserUpdated(ctx, { userId, patch })` | advance view revision |
| Table and index names | `tables` | the defaults |
| Relay TTL | `createCliAuthDefinitions.ttlMs` | 10 minutes (default) |
| Token events | `createApiTokenDefinitions.onEvent` | schedule `internal.analytics.capture` |
| Setup exchange extras | `createApiTokenDefinitions.exchangeExtras` | `{ team_id, convex_url }` |
| Storage namespace | `createLocalAuth(convexUrl)` | the deployment URL |
| IndexedDB name | `createDurableAuthStorage({ dbName })` | `codecast-auth` |
| SecureStore keys | `createTrustAnchorStore(store, key)` etc. | `last_verified_principal`, `biometric_enabled` |

## The two upstream patches (`patches/convex-auth-iss-fix.sh`)

The consuming app must run this script on postinstall until upstream ships
fixes. Copy it or reference it from the app's root `package.json`:

```json
"postinstall": "bash node_modules/@platform/auth/patches/convex-auth-iss-fix.sh"
```

It rewrites every installed copy of `@convex-dev/auth` (the direct one and the
ones bun caches under `node_modules/.bun`, `.ts` source and `.js` dist). It is
idempotent.

1. Strips the `iss` parameter from OAuth callback query params before
   validation (`server/oauth/callback`). GitHub rolled out RFC 9207 around
   2026-04-08; `@convex-dev/auth` sets a dummy issuer for providers that are not
   OIDC, so oauth4webapi v3 always rejects the mismatch, the callback silently
   catches it, and sign in breaks.
2. Widens `REFRESH_TOKEN_REUSE_WINDOW_MS` from 10 seconds to 30 days
   (`server/implementation/refreshTokens`). The Convex client rotates the
   refresh token on every websocket reconnect; with many tabs a tab can present
   a token two rotations behind, which the library reads as theft and answers by
   invalidating the whole session subtree. This is what stopped the recurring
   logouts. Tradeoff: a stolen and rotated refresh token stays replayable for
   30 days.

A shared package cannot sanely own a postinstall that rewrites three repos'
`node_modules`; the durable options are a maintained fork or an upstream
config knob. That decision is open (DESIGN.md, Open questions).

## Adopting in codecast

Backend (`packages/convex/convex`):

- `auth.ts` becomes `convexAuth(createAuthConfig({...}))` with the codecast
  parameters from the table above and the two hooks. Deletable: the provider
  definitions, both callbacks, the OTP providers.
- `auth.config.ts` becomes `export default createAuthHttpConfig()`.
- `cliAuth.ts` calls `createCliAuthDefinitions()` and exports one `const` per function through its own builders, imported from `./functions` so the change feed wrapper still applies. Keep re-exporting `CLI_AUTH_TTL_MS` if anything imports it.
- `apiTokens.ts` calls `createApiTokenDefinitions({...})` the same way, plus `export { hashToken, verifyApiToken } from "@platform/auth/convex"` for the many in-process callers. `onEvent` schedules `internal.analytics.capture`; `exchangeExtras` reads `team_id` and adds `convex_url`.
- Export through the app's own builders and the generated `api` keeps its types, so no export needs a hand written `RegisteredMutation` or `RegisteredQuery` annotation.
- `lib/auth.ts` becomes re-exports from `@platform/auth/convex`.
- Tests `cliAuth.test.ts` and `apiTokens.deviceBinding.test.ts` are now here; delete them from codecast.
- Unchanged: `http.ts` `cliRoute` (calls `internal.apiTokens.deviceBindingAllows`), `schema.ts`, `emails/*`, `analytics.ts`, `principalViewRevisions.ts`.

Web (`packages/web`):

- `lib/localAuth.ts` becomes `export const { jwtKey: AUTH_JWT_STORAGE_KEY, ... , useLocalAuth, hasStoredAuthToken } = createLocalAuth(CONVEX_URL)`; `localAuth.test.ts` deletable.
- `lib/durableAuthStorage.ts` becomes `createDurableAuthStorage({ dbName: "codecast-auth" })`.
- `components/AuthGuard.tsx` becomes the package `AuthGuard` with `loading={<AppLoader />}` and `unauthenticated={<RedirectToHome />}`.
- `components/AuthProviderButtons.tsx` keeps its JSX and Tailwind classes, but its state, nonce, URL and redeem effect come from `useProviderSignIn`.
- `hooks/useCodecastSignOut.ts` becomes `useDurableSignOut({ keys, purge: purgeDurableAuthValues, beforeSignOut })` where `beforeSignOut` clears inbox memory and the local cache.
- `app/auth/cli/page.tsx` stays.

Mobile (`packages/mobile/lib`):

- `authTrust.ts` and its test become imports from `@platform/auth/native`; both deletable.
- `auth.tsx` keeps the provider and the inbox store wiring, and imports `parseAccessIdentity`, `createTrustAnchorStore(SecureStore)`, `createBiometricPreference`, `createBiometricGate(LocalAuthentication, {...})`, `signInWithAppleNative(AppleAuthentication, signIn)`.

CLI (`packages/cli/src`):

- `authServer.ts` and `authRelay.ts` become re-exports; `startRelayPoller(url, nonce, { fetchImpl: cliFetch })`. Both tests deletable.

Deletable on adoption: `convex/cliAuth.test.ts`, `convex/apiTokens.deviceBinding.test.ts`, `web/lib/localAuth.test.ts`, `mobile/lib/authTrust.ts`, `mobile/lib/authTrust.test.ts`, `cli/src/authServer.ts`, `cli/src/authServer.test.ts`, `cli/src/authRelay.ts`, `cli/src/authRelay.test.ts`, `web/lib/durableAuthStorage.ts`, `web/lib/localAuth.ts` (reduced to one line), and the bodies of `convex/auth.ts`, `convex/cliAuth.ts`, `convex/apiTokens.ts`, `convex/lib/auth.ts`, `web/components/AuthGuard.tsx`, `web/hooks/useCodecastSignOut.ts`.

## Migrating whisk and aurora (ct-44709)

Both apps use hand rolled opaque tokens today: a 32 byte base64url token whose
sha256 is stored, passed as an argument to every public function. Convex Auth
resolves the caller from the request, so the migration is two jobs: swap the
sign in, and rewrite how every function resolves its caller. Size it like the
codecast `inboxStore.ts` split, not like a config change.

Schema, both apps:

1. Add `authTables` from `@convex-dev/auth/server` to the schema (`users`,
   `authSessions`, `authAccounts`, `authRefreshTokens`, `authVerificationCodes`,
   `authVerifiers`, `authRateLimits`) with the `email` index on `users`.
2. Add `api_tokens` (`by_token_hash`, `by_user_id`) and `cli_auth_requests`
   (`by_nonce_hash`, `by_created_at`) only if the app gets a CLI or desktop.
3. Add `convex/auth.ts` with `createAuthConfig`, `convex/auth.config.ts` with
   `createAuthHttpConfig()`, and the `auth.addHttpRoutes(http)` line.

Whisk (`packages/convex/convex/lib/auth.ts`, `auth_sessions`):

1. The roster stays: a user owns accounts, `requireAccounts` returns them in
   connect order, `attachAccountToSession` merges two users. Keep those as
   domain logic keyed by the Convex Auth user id instead of the session row.
2. Data: for each `auth_sessions` row with a `user_id`, the user row becomes or
   maps to a Convex Auth `users` row (match on email where one exists; otherwise
   create and record the mapping). Legacy rows keyed by `account_id` with no
   `user_id` go through `ensureUserForSessions` first, then the same mapping.
3. The two minting sites (Gmail OAuth callback, `demo.seed`) stop minting
   tokens. Gmail OAuth keeps connecting the mailbox to the signed in user
   (that is the connectors system, not sign in); the sign in itself becomes a
   Convex Auth provider (GitHub, Apple, Password, or a Google provider).
4. Every public function drops its `token` argument and calls `requireUser`
   from `@platform/auth/convex`. The `auth_sessions` table is read only until
   every device has signed in once through the new path, then dropped.
5. The web client swaps its token header for `ConvexAuthProvider` with
   `createDurableAuthStorage` and gates rendering on `createLocalAuth`.

Aurora (`lib/auth.ts` plus `authApi.ts`, PBKDF2 passwords):

1. One session names one account, one account is one family, and the second
   parent joins with a six character code. The family and the join code stay
   aurora domain logic keyed by the new user id.
2. Password hashes are PBKDF2 SHA-256, 100,000 iterations, per user salt.
   Convex Auth's Password provider verifies Scrypt and will not read them.
   Decide before writing code: either a custom credentials provider that checks
   the old hash and rehashes with Scrypt on next sign in (then drop the old
   column once every active parent has signed in), or a forced reset for every
   parent through `resend-otp-password-reset`. The first keeps parents signed
   in; the second is less code.
3. Password reset today is a six digit code by email, fifteen minutes, one live
   code at a time. The package's OTP provider is six characters from `0-9A-Z`,
   fifteen minutes. Keep the "same error for unknown email and wrong password"
   behavior in the app's sign in screen.
4. Sessions: each `sessions` row maps to one account; create the Convex Auth
   user per account email, then every public function calls `requireUser` and
   looks up the family by user id.
5. Bearer token adapter or rewrite is an open question in DESIGN.md. This
   package ships no adapter; `requireUserOrToken` accepts an `api_tokens`
   token as a fallback, which is the CLI path, not a session replacement.

## Tests

`bun test` from this directory: 59 tests across 8 files.

- `convex/cliAuth.test.ts`, `convex/apiTokens.deviceBinding.test.ts` (ported).
- `convex/createAuthConfig.test.ts` (new): codecast's parameters produce the
  donor's provider ids in order, durations, GitHub scope and profile fields,
  redirect allowlist, email dedup and the two hooks, OTP code shape, and the
  dark email verification flag.
- `web/localAuth.test.ts` (ported, pins the library's storage key layout).
- `native/authTrust.test.ts` (ported), `native/appleNative.test.ts` (new).
- `cli/authServer.test.ts`, `cli/authRelay.test.ts` (ported).
