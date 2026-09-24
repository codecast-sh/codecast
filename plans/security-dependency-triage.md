# Dependency advisory triage

Generated 2026-09-24T00:20:45.757Z (bun 1.3.14) by scripts/security/dependency-triage.ts from `bun audit --json`. A row's decision is a reading with evidence and an expiry; the raw audit output stays in plans/security-dependency-audit.json.

Packages: 40, advisories: 195, by severity {"critical":3,"high":93,"moderate":82,"low":17}, by status {"fixed":1,"not-reachable":27,"accepted-risk":5,"fix-planned":7,"untriaged":0,"expired":0}

| package | resolved | worst | decision | modes | untrusted input | owner | review by | evidence |
|---|---|---|---|---|---|---|---|---|
| @auth/core | 0.37.4 | critical | fix-planned | runtime-backend | indirect | identity worker (ct-53052) | 2026-11-01 | Convex Auth (@convex-dev/auth) is the consumer; our auth surface is GitHub, Apple and Google OAuth through @platform/auth (identity worker ct-53052), no email/magic link provider is configured, and getToken() is not called from our code. Upgrade rides the next @convex-dev/auth release that lifts the peer; tracked with the identity worker. |
| @babel/core |  | low | not-reachable | build-only | no | release owner | 2026-12-23 | build time only |
| @hono/node-server | 1.19.14 | moderate | not-reachable | dev-only | no | release owner | 2026-12-23 | same as hono |
| @opentelemetry/core | 2.2.0 | moderate | not-reachable | dev-only | no | release owner | 2026-12-23 | tooling chain; no OTel exporter runs in shipped code |
| @tiptap/core | 3.22.5 | high | fix-planned | runtime-web | indirect | content worker (ct-53054) | 2026-10-15 | the composer is a tiptap editor; content it loads is the viewer's own draft, not another user's, so the exposure is self inflicted. Bump with the content worker's renderer pass. |
| @tootallnate/once | 2.0.0 | low | not-reachable | build-only | no | release owner | 2026-12-23 | electron-builder chain |
| @xmldom/xmldom | 0.8.13 | high | not-reachable | build-only | no | release owner | 2026-12-23 | expo / plist tooling only |
| app-builder-lib | 25.1.8 | high | not-reachable | build-only | no | release owner | 2026-12-23 | electron-builder, build machine only |
| baseline-browser-mapping |  | moderate | not-reachable | build-only | no | release owner | 2026-12-23 | browserslist tooling |
| brace-expansion |  | high | not-reachable | build-only, dev-only | no | release owner | 2026-12-23 | glob tooling only |
| browserslist |  | high | not-reachable | build-only | no | release owner | 2026-12-23 | build time only |
| builder-util-runtime | 9.2.10 | high | not-reachable | build-only | no | release owner | 2026-12-23 | electron-builder, build machine only |
| decode-uri-component | 0.2.2 | moderate | not-reachable | build-only | no | release owner | 2026-12-23 | tooling only |
| dompurify | 3.4.8, 3.4.1 | moderate | fix-planned | runtime-web | yes | content worker (ct-53054) | 2026-10-15 | Renderer sanitisation is owned by the content worker (ct-53054, plan 003): canvasSanitize / HtmlSnippet decide what the sanitiser sees. The resolved copy must be at or above the advisory's fixed version before the plan closes; that worker owns the bump and its browser verification. |
| esbuild | 0.24.2, 0.27.0 | moderate | accepted-risk | dev-only | no | release owner | 2026-12-23 | the esbuild dev server is not what serves the app in dev (vite does), and never in prod; a developer's local port is the only exposure |
| fast-uri | 3.1.0 | high | not-reachable | dev-only | no | release owner | 2026-12-23 | ajv tooling chain only |
| fflate | 0.4.8 | moderate | accepted-risk | runtime-web, dev-only | indirect | release owner | 2026-12-23 | used for client side unzip of artefacts the viewer chose; a bomb stalls the viewer's own tab. Re-read if fflate ever runs server side. |
| form-data | 4.0.5 | high | not-reachable | dev-only | no | release owner | 2026-12-23 | resolved under node tooling; runtime uploads use the platform FormData |
| highlight.js | 11.11.1, 9.12.0 | moderate | accepted-risk | runtime-web | yes | release owner | 2026-12-23 | Highlighting runs in the viewer's own browser tab on content the viewer chose to open; a pathological block stalls that tab only. No server side highlighting. Re-read if highlighting ever moves server side. |
| hono | 4.12.15 | high | not-reachable | dev-only | no | release owner | 2026-12-23 | No production entrypoint runs a hono server: the backend is Convex http.ts, the web is Vite static plus Convex; hono appears only through dev tooling and package test harnesses (bun why hono). Re-read if a hono route ever ships. |
| image-size |  | high | not-reachable | build-only | no | release owner | 2026-12-23 | expo asset tooling only |
| ip-address | 10.1.1 | high | not-reachable | build-only | no | release owner | 2026-12-23 | under electron-builder / socks tooling only |
| js-yaml |  | high | not-reachable | build-only, dev-only | no | release owner | 2026-12-23 | no runtime parsing of untrusted YAML; the desktop feed parser is our own line parser |
| linkify-it | 5.0.0 | high | fix-planned | runtime-web | yes | content worker (ct-53054) | 2026-10-15 | same as markdown-it |
| markdown-it | 14.1.1 | moderate | fix-planned | runtime-web | yes | content worker (ct-53054) | 2026-10-15 | Markdown rendering of agent output is the content worker's surface (plan 003). Bump alongside dompurify with browser verification. |
| mermaid | 11.14.0 | moderate | fix-planned | runtime-web | yes | content worker (ct-53054) | 2026-10-15 | Mermaid renders agent output inside the web app; plan 003 content worker owns the sink and the bump. |
| nanoid | 5.1.9, 3.3.11 | high | not-reachable | runtime-web, runtime-backend | no | release owner | 2026-12-23 | no call site passes a caller controlled size; grep nanoid( in packages shows constant sizes only |
| postcss | 8.5.12 | high | not-reachable | build-only | no | release owner | 2026-12-23 | build time only |
| postcss-selector-parser | 6.0.10, 6.1.2 | low | not-reachable | build-only | no | release owner | 2026-12-23 | build time only |
| prismjs | 1.30.0, 1.17.1 | high | accepted-risk | runtime-web | yes | release owner | 2026-12-23 | same reasoning as highlight.js: client side only, viewer's own tab. |
| protobufjs | 7.5.6 | high | not-reachable | dev-only | no | release owner | 2026-12-23 | resolved under opentelemetry / tooling; no runtime protobuf decoding of untrusted bytes |
| react-router | 7.14.2 | high | fix-planned | runtime-web | indirect | release owner (jx7f70q) | 2026-10-15 | The web app is a client rendered SPA (no SSR, no RSC, no server loaders), so the DoS, CSRF and deserializeErrors rows do not apply. The backslash open redirect does apply wherever a navigation target comes from data (share links, deep links). Bump to >=7.18.2 in the next web release; verify the tab shell's route adoption still holds (tab_shell_routing traps). |
| shell-quote |  | critical | not-reachable | dev-only | no | release owner | 2026-12-23 | dev tooling; the CLI never builds shell strings from untrusted data (update.ts moved to argv on 2026-09-23) |
| tar | 7.5.13 | critical | not-reachable | build-only | no | release owner | 2026-12-23 | Only build tooling (electron-builder, expo prebuild) extracts archives it downloaded itself; no user supplied archive is ever extracted at runtime. |
| tmp | 0.2.5 | high | not-reachable | build-only, dev-only | no | release owner | 2026-12-23 | dev tooling only |
| turbo | 2.9.6 | moderate | not-reachable | dev-only | no | release owner | 2026-12-23 | repo task runner only |
| undici | 7.26.0, 6.25.0 | high | not-reachable | dev-only, build-only | no | release owner | 2026-12-23 | Runtime fetch is bun's own in the CLI and Convex's runtime on the backend; undici resolves only under node based tooling (electron-builder, expo, vite plugins). |
| uuid | 11.1.0, 8.3.2, 10.0.0, 7.0.3 | moderate | not-reachable | dev-only | no | release owner | 2026-12-23 | we use crypto.randomUUID / nanoid for identifiers; uuid resolves under tooling |
| vite | 6.4.2 | high | accepted-risk | dev-only | indirect | release owner | 2026-12-23 | dev server on a developer machine bound to localhost:3200; production is a static build served by Railway. Local exposure only; the browser sandbox note in plan 004 covers the same machine boundary. |
| ws |  | high | fixed | runtime-cli, dev-only | yes | release owner (jx7f70q) | 2026-12-23 | The CLI's own ws (bridge host, loopback WebSocket server for the extension and CDP clients) is 8.21.3 in package.json and bun.lock; the resolved import is asserted by packages/cli/src/browser/bridge/wsVersion.test.ts. The nested 8.18.0 under convex is the Convex client's outbound socket to our own backend, a client role the advisory does not cover, and it is pinned exactly by convex; it moves when convex does. The 8.20.0/7.x/6.x copies are expo, metro, react-native and ink dev tooling, never in a shipped bundle. Pre-auth bounds on the bridge (origin allow list, 256 KiB hello cap, 4 concurrent handshakes, hello timeout) landed in 30a74b510. |
