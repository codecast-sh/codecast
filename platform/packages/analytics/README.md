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
| `@platform/analytics/web` | Browser and Electron renderer, including global error listeners | `posthog-js`, `@sentry/react` |
| `@platform/analytics/web-runtime` | Lazy browser SDK runtime without error-listener imports | `posthog-js`, `@sentry/react` |
| `@platform/analytics/native` | React Native (Expo) | `posthog-react-native`, `@sentry/react-native` |
| `@platform/analytics/server` | Any server runtime | none — plain `fetch` |

Three more subpaths: `@platform/analytics` (the shared config types and
`resolveConfig`), `@platform/analytics/errors` (SDK-free global error
deduplication/listeners), and `@platform/analytics/web-vitals` (Core Web Vitals
forwarded to PostHog as `web_vital` events; needs the `web-vitals` peer).

Two codecast subpaths, neither with peers: `@platform/analytics/codecast`
(the sink for codecast's ingest door) and `@platform/analytics/replay` (the
semantic replay recorder). Both are described under "Codecast" below.

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
the web entry captures errors without browser tracing; browser session
recording, replay and dead click capture are off (they cost typing latency);
SPA pageviews are captured on history changes; `platform`, `environment` and
`app` ride every PostHog event as super properties. The native entry keeps
Sentry tracing at 1.0 in dev and 0.2 in prod and adds
`trackScreen`, `wrapRoot`, app lifecycle events, and mobile session replay
(`enableSessionReplay`, default on). It requires its SDKs lazily and
degrades to no-ops when the native module is absent, so an OTA update can
never crash a binary built before the SDKs were added.

An app whose links are credentials (share links, guest links, invite codes)
passes `scrubUrl`, a rewrite of any string holding a URL or path
(`"/share/doc/k3y"` to `"/share/doc/:token"`). The web entry runs it on every
URL that leaves the page: PostHog's `before_send` (page, referrer, element
hrefs, the person's first URL), Sentry's `beforeSend` and `beforeBreadcrumb`,
the codecast sink's error url, and the replay recorder's nav and network
entries (`src/scrub.ts`).

## Calls made before init

`identifyUser`, `resetUser`, `track` and native `trackScreen` are safe to call
before `initAnalytics`. Both entry points hold such a call and replay it, in
the order it was made, at the end of init — after both SDKs are up and the
super properties are registered. Apps do not have to order boot against the
query that produces the user id: an identify that loses the race still reaches
Sentry and PostHog, so a crash during a slow boot has a user attached.

At most `PRE_INIT_BUFFER_LIMIT` (50) calls are held, so a consumer that never
initializes cannot grow the buffer without limit. At the cap the oldest held
call is dropped, never the newest — the latest identify carries the identity
that is true now. A held call that throws is swallowed: one backend refusing
must not break boot, and the calls behind it still run. `captureError` is not
held; Sentry owns pre-init error capture itself.

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

## Codecast

Codecast (codecast docs/architecture/external-data.md X2, X5) takes in a
product's errors, warning logs, job failures, checks, counted events, deploys
and session replays, and joins them to the release and the session that wrote
the code.

**The sink.** `createCodecastSink({ ingestKey, endpoint?, release?,
environment?, flushMs?, maxBatch? })` batches items to
`POST <endpoint>/<ingestKey>` (default endpoint
`DEFAULT_CODECAST_INGEST_ENDPOINT`, codecast prod; never read from env). It
gzips where `CompressionStream` exists, retries 429 and 5xx with jittered
backoff (honoring `Retry-After`), splits on 413, drops a batch refused with
400, and stops for good on 401. In a browser it flushes by `sendBeacon` on
`pagehide`; on a server it is plain `fetch` with unref'd timers. Methods:
`captureError`, `log` (warn and above), `jobFailed`, `check`, `event`,
`deploy`, `replay`, `setUser`, `flush`. The key is write-only and safe to ship
in a bundle.

```ts
// a server or worker
const codecast = createCodecastSink({ ingestKey: process.env.CODECAST_INGEST_KEY!, release: GIT_SHA });
codecast.jobFailed("send-digest", err, { attempt: 3 });
codecast.check("db-reachable", ok);
```

**Web.** `initAnalytics({ ..., codecastIngestKey, codecastEndpoint?, release? })`
creates the sink (off in development, like Sentry). `captureError` reaches
Sentry and codecast together, with Sentry's ignore rules applied to both.
Uncaught errors and rejections share ONE listener pair in `./errors`: when the
app wires `setupErrorToasts`, its captureError reports to both backends; when
it does not, the runtime registers a codecast-only capture
(`setupErrorCapture`) on the same pair, since Sentry has its own handler.
`getCodecastSink()` returns the sink for the recorder.

**The recorder.** `startReplay({ sink, sampleRate = 0, redactUrl? })` keeps
the last 60 s of semantic events (nav, click, input length, submit, Enter /
Escape / Tab, coarse scroll, console warn and error, failed or slow requests,
errors, a visible text outline, app marks via `recorder.mark`). Every error
the sink captures uploads the buffer and keeps the recording, chunked every
10 s; a sampled session is kept from the start. Chunks are gzipped JSON PUT to
a URL from `POST <endpoint>/<key>/replay-sign` (body `{ replay_id, chunk,
bytes }`, answer `{ upload_url }` or `{ exists: true }`), followed by a
`replay` manifest item. It never reads an input value, skips `[data-private]`,
blanks query values, and costs one capture listener per event type plus
patches on history, console, fetch and XHR: no MutationObserver, nothing per
frame. The event types match codecast `packages/shared/contracts/replay.ts`
and codecast typechecks the two against each other.

## Tests

`bun test` — no network; `fetch`, PostHog and Sentry are mocked, and the
recorder runs against a happy-dom window (the one dev dependency). `npx tsc
--noEmit` type checks src and tests, including the export subpaths.
