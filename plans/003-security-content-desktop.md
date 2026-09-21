# Plan 003: Keep untrusted content outside application and desktop authority

> Proposed implementation plan for discussion; this review does not authorize execution or deployment.
> Planned against 07a081b853ca9bad1a1872eb757eb69a5c1acd34 on 2026-09-21, including existing uncommitted work.

Priority P0 chart sink; P1 desktop; P2 canvas containment/egress and headers. Effort L split into independent fixes; change risk medium. Covers CLIENT-01/02/03/05/06 and PARENT-10. No blocking dependency.

## Why and current state

The initial HTML sanitizer runs before Observable Plot. packages/web/lib/castChart.ts:111-148 forwards arbitrary mark options, then inserts the result:

    const { type, data, transform, ...opts } = m;
    return (fn as (d: unknown, o: unknown) => unknown)(data ?? spec.data ?? [], finalOpts);
    el.replaceChildren(fig);

Plot-generated SVG links bypass the initial URL policy. A real Chrome marker executed when clicked. HtmlSnippet.tsx uses an ordinary shadow root, which does not isolate script authority or contain hostile host CSS. canvasSanitize.ts uses regex CSS URL removal and leaves media sources; mobile CastCanvas.tsx duplicates this policy.

Electron shell preloads are exposed unconditionally (preload.js:62), shell navigation lacks a main-document guard, and voice-command at main.js:1725 ignores sender. Permission callbacks at :3249 trust webContents.getURL rather than the requesting frame; missing webContents can be approved. The complete packaged exploitation chain remains unverified and must be tested with fake capabilities.

## Scope and conventions

Edit castChart.ts, canvasSanitize.ts, HtmlSnippet.tsx and adjacent tests; mobile CastCanvas.tsx and its tests; Electron main.js/preload.js plus fake main-process tests; FrameBackend.tsx permission delegation; web server/index.ts headers. Preserve existing rich charts, internal link routing, fullscreen and trusted image policy. Native browser panes have a separate deny-all session and no preload: retain that isolation.

Use packages/web/lib/__tests__/canvasSanitize.test.ts and packages/electron/appWindow.main.test.js as patterns. Real browser tests must pass the actual sanitizer and actual hydrator, not test only a URL helper.

## Steps and verification

1. Define allowed chart marks/options and validate resolved URL channels, including URLs sourced from each data row. Sanitize/check generated DOM after hydration and apply external-link target/rel policy. A temporary explicit denial of URL-bearing marks is acceptable containment if documented.
   Verify: bun test packages/web/lib/__tests__/canvasSanitize.test.ts packages/web/lib/canvasLinks.test.ts plus new castChart security tests. In cast browser, click generated links in a fixture: script marker stays unset, valid HTTPS links follow policy, no forbidden image request occurs.
2. Enforce a complete media/attribute policy and CSS parsing/isolated-document policy rather than spelling-based regex. Put mobile canvas under network-denying CSP while allowing trusted shell code and approved assets. Add an untargetable outer layout/paint boundary for web canvas or use an iframe for arbitrary styles.
   Verify: browser request interception records zero unapproved egress across media/poster, CSS escapes, imports, SVG and generated chart output. Hit-testing outside the canvas rectangle reaches trusted UI, never canvas content. Run bun test packages/mobile/lib/linkRoutes.test.ts packages/mobile/lib/authTrust.test.ts and new mobile canvas tests; perform device/WebView verification before claiming mobile closure.
3. Centralize exact-origin, registered-shell-window and senderFrame admission for every privileged Electron IPC channel. Validate payloads. Prevent unapproved top-level/frame navigation; route permitted external URLs to the browser/native pane. Gate preload exposure too, but keep main-process checks authoritative.
   Verify: node --test packages/electron/appWindow.main.test.js packages/electron/browserPanes.test.js plus new IPC policy tests. Test foreign top-level navigation through an ordinary chart link in a packaged fixture: it cannot inherit/invoke privileged channels. Test foreign iframe separately; never assume iframe IPC availability.
4. Use request-frame origin for permissions. Deny null/opaque/foreign frames and unexpected schemes/ports. Bind screen selection and one-shot approval to the requesting frame. Remove delegated iframe clipboard capability unless explicitly intended and separately approved.
   Verify: fake permission callbacks reject all negative matrix cases. Packaged tests use fake clipboard/media/screen providers; no personal clipboard or live call. First-party calls/screenshare and native-pane denial still pass.
5. Add tested response headers. Begin CSP report-only, inspect real violations, then enforce. Avoid broad unsafe-eval/script exceptions; preserve intentional embeddings and dev origins explicitly.
   Verify: header tests plus curl -I against the fixture server; real browser auth, charts, calls, OAuth return and desktop windows work. Run cast check web and cast check mobile.

## Acceptance and maintenance

All DOM generators, including later hydration, obey one content contract. Foreign documents never gain preload/IPC or first-party permission authority. Charts, tables, tabs and fullscreen still work. Keep URL-channel tests when upgrading Plot, DOMPurify, WebView or Electron. Do not wait for a large iframe redesign to fix the immediate chart sink.

## Working and release rules

Work in the main checkout, as this repository requires. Before edits run git status --short and git diff for the scoped files; other sessions own existing diffs. Compare this plan's excerpts with current code and pause to reconcile material drift. Do not revert or stage others' changes. Keep fixes in small conventional commits, for example fix(security): enforce resource authority. No push, merge or production deployment is part of executing this proposed plan without the human's direction.

Use Bun and existing test helpers. Run long commands in a dedicated tmux session; keep its log and result. Typecheck only with cast check, never a separate tsc. After focused tests pass, the release owner runs cast check, bun run lint and bun run test once for the integrated change; record unrelated baseline failures without claiming the gate passed. Add backend integration tests with disposable accounts and fixtures; client changes require real-browser verification through cast browser. Browser probes must use harmless markers and fake capabilities, never live private data.

Shared platform code is canonical in ~/src/platform: change and test it there, then run scripts/vendor-platform.sh from Codecast, followed by scripts/vendor-platform.sh --check-manifest. The vendor script refreshes dependency caches, so coordinate with active dev-server owners. Never hand-edit platform/packages. For an authorized release, deploy Convex only through packages/convex/deploy.sh, before a dependent web push; use CI for CLI releases. Record backend, web, CLI, desktop and mobile versions separately.

Stop and report if current behavior invalidates the stated threat model, a proposed fix needs an unlisted authority/schema migration, legitimate cross-user execution has no documented grant, or a test would affect production or real credentials. Resolve ordinary test failures, but do not invent a permissive fallback to make compatibility tests pass.

Done means all stated negative cases fail with no side effects, positive cases pass, focused gates and required integration checks have receipts, affected release versions and compatibility windows are recorded, and the matching plans/README.md row is updated. A passing old test suite alone is insufficient.

