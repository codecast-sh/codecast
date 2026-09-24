# PARENT-10: document policy draft (report-only)

The policy lives in `packages/web/server/responsePolicy.ts` as `DOCUMENT_POLICY`. It is sent only as `Content-Security-Policy-Report-Only`, so no browser blocks anything. Violation reports go to Sentry's CSP security endpoint, which is built from `VITE_SENTRY_DSN`. Reports are sent only from a Railway deploy, for 10% of HTML documents, with at most 120 reporting documents per hour for each server process. One document covers a whole app session, because the SPA does not reload the page.

## Sources and why each is needed

| Directive | Sources | Needed by |
|---|---|---|
| script-src | 'self', us.i.posthog.com, us-assets.i.posthog.com, Google Ads hosts | the app bundle; PostHog remote config and site apps; gtag, which is on in prod because VITE_GOOGLE_ADS_SEND_TO is set |
| style-src | 'self' 'unsafe-inline' fonts.googleapis.com | the inline boot style; runtime style tags from mermaid, cytoscape, tiptap and xterm; style attributes in sanitized canvas HTML; Google Fonts |
| font-src | 'self' data: fonts.gstatic.com | KaTeX fonts, data fonts in CSS, Google Fonts |
| img-src | 'self' data: blob: https: | Convex storage, avatars, repo READMEs, markdown images the user clicks to load |
| media-src | 'self' blob: Convex, loopback | call recordings, voice messages, sent files, vault media served by the daemon |
| connect-src | 'self', Convex https and wss, PostHog, Sentry ingest, loopback http and ws, wss://api.openai.com, *.livekit.cloud, avatar hosts, Google Ads | sync websocket and uploads; analytics; errors; CLI auth callback, terminal, browser watch, vault; call transcription; calls; the avatar byte cache |
| frame-src | 'self' https: loopback | published pages from Convex, codecast routes in browser panes, any https page the user opens in a browser pane, vault assets |
| worker-src | 'self' | the graph layout worker and /sw.js |
| object-src | Convex | PDF previews of sent files (`SentFileBlock.tsx`) |
| base-uri, form-action | 'self' | no form posts to another origin; OAuth uses redirects |
| frame-ancestors | 'self' https://local.codecast.sh | browser panes frame codecast routes; a local checkout can frame a prod page. Electron loads the app as the top page, and the Chrome extension frames nothing. |

The Vite dev server (local.codecast.sh, ports 3200 and up) does not run the Hono middleware, so dev gets no policy.

## Before enforcing

1. Inline scripts. Three items need hashes or a nonce: the handoffBoot script (its content changes every build, so the hash must come from the build), the theme script in `index.html`, and `window.__SHARE_PRELOAD__` on share pages (a nonce, or `type="application/json"`). The inline `onload` on the Google Fonts link needs `'unsafe-hashes'` plus a hash, or a small refactor. Until then, every reporting document reports these, as expected.
2. Not verified: the LiveKit host (`*.livekit.cloud` is assumed, because the prod `LIVEKIT_URL` is in Convex env), the exact Google Ads hosts, and private network hosts in browser panes other than loopback. The reports settle these.
3. Other `local.N.codecast.sh` checkouts that frame a prod page will report on frame-ancestors.
4. Cross-Origin-Opener-Policy is not set. `same-origin` would break OAuth popups that need `window.opener`; decide separately.

## HSTS

`Strict-Transport-Security: max-age=86400` on every response, with no includeSubDomains and no preload. Checked on 2026-09-23: `http://codecast.sh/` answers 301 to `https://codecast.sh/`, and prod serves HTTPS through Cloudflare. After the review date, raise it to `max-age=31536000` if nothing reported a problem.
