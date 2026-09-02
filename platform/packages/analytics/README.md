# @platform/analytics

Product analytics (PostHog) and error reporting (Sentry) for the platform
apps, extracted from codecast. Config is injected: the entry points never
read env vars or carry keys. Each app reads its own env (`VITE_*`,
`EXPO_PUBLIC_*`, `process.env`) and passes the values in.

## Entry points

Three entry points, one per surface. Each is a separate export subpath so a
consumer only pulls the SDKs its surface needs.

| Import | Surface | Peers used |
| --- | --- | --- |
| `@platform/analytics/web` | Browser and Electron renderer | `posthog-js`, `@sentry/react` |
| `@platform/analytics/native` | React Native (Expo) | `posthog-react-native`, `@sentry/react-native` |
| `@platform/analytics/server` | Any server runtime | none — plain `fetch` |

Two more subpaths: `@platform/analytics` (the shared config types and
`resolveConfig`) and `@platform/analytics/web-vitals` (Core Web Vitals
forwarded to PostHog as `web_vital` events; needs the `web-vitals` peer).

All peers are optional and pinned to codecast's versions: `posthog-js`
^1.363.3, `posthog-react-native` ^4.37.6, `@sentry/react` ^10.45.0,
`@sentry/react-native` ^8.5.0, `web-vitals` ^5.1.0.

## Config

`initAnalytics` (web and native) takes one `AnalyticsConfig`:

```ts
initAnalytics({
  posthogKey: import.meta.env.VITE_POSTHOG_KEY,   // omit to disable PostHog
  posthogHost: import.meta.env.VITE_POSTHOG_HOST, // default https://us.i.posthog.com
  sentryDsn: import.meta.env.VITE_SENTRY_DSN,     // omit to disable Sentry
  environment: import.meta.env.DEV ? "development" : "production",
  platform: "web",        // "desktop", "mobile"; a Sentry tag and a PostHog super property
  appName: "codecast",    // optional; keeps apps sharing one project filterable
});
```

Behavior carried over from codecast: Sentry is disabled in development;
traces sample at 1.0 in dev and 0.2 in prod; browser session recording,
replay and dead click capture are off (they cost typing latency); SPA
pageviews are captured on history changes; `platform`, `environment` and
`app` ride every PostHog event as super properties. The native entry adds
`trackScreen`, `wrapRoot`, app lifecycle events, and mobile session replay
(`enableSessionReplay`, default on). It requires its SDKs lazily and
degrades to no-ops when the native module is absent, so an OTA update can
never crash a binary built before the SDKs were added.

The server entry has no React or browser imports and takes an injected
`fetch`:

```ts
const analytics = createServerAnalytics({
  posthogKey: process.env.POSTHOG_KEY!, // phc_ keys are publishable
  source: "convex",                     // "web_server", "daemon"; stamped on every event
});
await analytics.capture("cli_auth_completed", userId, { method: "device_code" });
await analytics.capturePersonless("install_script_downloaded", { script: "sh" });
```

`capture` sends an identified event. `capturePersonless` is for requests
with no identity to merge (install script fetches, download redirects): a
random `distinct_id` plus `$process_person_profile: false`, so no PostHog
person is created per request. Sends never throw; a PostHog outage must not
fail a product flow. Fire and forget from the caller side too (codecast
schedules a Convex `internalAction` with `runAfter(0, ...)`).

## The distinct_id convention

`distinct_id` is the app's own user id, on every surface. Codecast passes
the Convex `users._id` string to web `identifyUser`, mobile `identifyUser`
and server `capture`, so browser, mobile and server events merge into one
PostHog person. Keep this convention in any app that adopts the package.

## Env var names

The package reads none itself. The conventional names per surface:

- Web (Vite): `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`, `VITE_SENTRY_DSN`
- Mobile (Expo): `EXPO_PUBLIC_POSTHOG_KEY`, `EXPO_PUBLIC_POSTHOG_HOST`, `EXPO_PUBLIC_SENTRY_DSN`
- Server: `POSTHOG_KEY`, `POSTHOG_HOST` (codecast's web server reuses `VITE_POSTHOG_KEY`)

## Adoption

**codecast** — each donor file becomes a thin wrapper (or a plain import)
around one entry point:

- `packages/web/lib/analytics.ts` → `@platform/analytics/web`. Pass the
  Vite env values and the `desktop`/`web` platform pick; wire
  `setupErrorToasts` with the app's toast renderer and its ignored error
  patterns (the package no longer hardcodes them). Codecast also passes the
  three optional readers — `summarize`, `describe`, `toError` — so the toast
  title, the dedupe key and the Sentry event all name the failure hidden in
  `cause` rather than the wrapper React threw it inside of. Its recovered
  render error path calls the exported `claimErrorKey` to share the one 30
  second dedupe window with the window listeners.
- `packages/mobile/lib/analytics.ts` → `@platform/analytics/native` with
  the Expo env values and `platform: "mobile"`.
- `packages/convex/convex/analytics.ts` → keep the `internalAction` shell,
  call `createServerAnalytics({ posthogKey, source: "convex" })` in the
  handler.
- `phCapture` in `packages/web/server/index.ts` →
  `createServerAnalytics({ posthogKey, source: "web_server" }).capturePersonless(...)`.
- `packages/web/lib/reportWebVitals.ts` → `@platform/analytics/web-vitals`.

**whisk / aurora** — no analytics today, so wiring is two lines at boot:

```ts
// web entry (main.tsx)
import { initAnalytics } from "@platform/analytics/web";
initAnalytics({
  posthogKey: import.meta.env.VITE_POSTHOG_KEY,
  sentryDsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.DEV ? "development" : "production",
  platform: "web",
  appName: "whisk",
});
```

Then `identifyUser(user.id)` after sign in, `resetUser()` on sign out, and
`track(event, props)` at the product moments worth counting. A server
(worker, API route) that needs funnel events uses
`createServerAnalytics` with its own `source` label.

## Tests

`bun test` — no network; `fetch`, PostHog and Sentry are mocked. `npx tsc
--noEmit` type checks src and tests, including the export subpaths.
