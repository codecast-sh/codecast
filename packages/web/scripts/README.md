# packages/web/scripts

Hand-run measurement and test harnesses for the web app. Run them from `packages/web` with `bun scripts/<name>`. Each file's header or argument parser holds the full usage.

## Chrome DevTools (CDP) harnesses

Each talks raw CDP over a WebSocket to a page on a Chrome started with `--remote-debugging-port`, picked by `--port` and a URL substring in `--target`.

- `cdp-trace.mjs`: records a performance trace (`Tracing`) and metrics around a reload or navigation, optionally seeding storage state first; writes `/tmp/codecast-trace.json` by default.
- `cdp-trace-summary.mjs`: summarizes a trace from `cdp-trace.mjs` for the renderer main thread: task and long-task totals, the longest tasks, and GC, script, layout and paint time (`<trace.json>`).
- `cdp-cpu-profile.mjs`: samples a CPU profile (`Profiler`) for `--duration-ms`, with optional `--reload` and `--offline`.
- `cdp-cpu-summary.mjs`: ranks a CPU profile's self time by original source through the build's source maps (`<profile.json> <dist>`).
- `cdp-boot-profile.mjs`: reloads the page with a boot probe injected and reports when the root commits, the shell paints, cached content shows and the conversation renders, optional `--offline` and `--screenshot`.
- `cdp-idb-profile.mjs`: reads the `codecast-store` IndexedDB tables in the page and reports rows, bytes and read time per table (`--tables`, `--meta-keys`).
- `cdp-copy-storage.mjs`: copies one origin's localStorage from a saved storage state into the page, so a profile runs signed in (`--state <file>`).

## Other harnesses

- `bundle-graph.mjs`: walks the Vite build manifest from one entry and reports the gzip size of its static import graph (`<manifest.json> <entry-key>`).
- `rig/`: two signed in headless Chromes driven over raw CDP. `rig/stack.mjs` decides which deployment a rig may reach: the local dev deployment by default, prod only under `RIG_DEPLOYMENT=prod`.
  - The face row rig (walkie, ring, reconnect, dead seat): `rig/run.mjs` runs the legs, `rig/shots.mjs` captures every row state, `rig/eval.mjs` evaluates on a browser left up by `--keep`. Its fixtures are the App Review accounts on prod and calls need prod's LiveKit, so it runs only with `RIG_DEPLOYMENT=prod`, the dev server on localhost:3200 and `CONVEX_SELF_HOSTED_ADMIN_KEY`.
  - The browser smoke suite: `rig/smoke.mjs` (below).
- `call-e2e/`: a synthetic call participant and its checks, for testing huddles, recordings, guests and frame snapshots with no camera, screen picker or person. `publish.mjs` joins a LiveKit room as a member or guest and publishes a generated camera and screen share whose every frame carries a decodable timecode; `inspect.mjs` shows LiveKit's own view of the room's tracks and egresses; `grab.mjs` saves frames as a receiver gets them; `decode.mjs` reads the timecode back out of a PNG or recording. Its own `package.json` (run `npm install` there, then `node <script>`); its README has the recipes.
- `renderCueWaveforms.ts`: draws every walkie cue as a waveform PNG at one shared scale, so a cue's loudness is reviewed by eye instead of by ear (`[outDir]`).

## Browser smoke suite

The real app in two headless Chromes, signed in as two test identities (Riley Smoke and Jordan Smoke in "Smoke Team") on a local dev deployment, never prod. Each leg asserts what the page shows, then photographs the viewport and compares it with a baseline.

```bash
bun scripts/rig/smoke.mjs                      # every leg; PASS or FAIL per leg, a diff image path on a visual failure
bun scripts/rig/smoke.mjs --legs chat,org      # some legs
bun scripts/rig/smoke.mjs accept               # store the latest run's shots as the baselines (or: accept <run dir>)
bun scripts/rig/smoke.mjs --accept             # run, then store this run's shots as the baselines
bun scripts/rig/stack.mjs status | up [--refresh] | down
```

- **Legs.** `inbox`: Riley's inbox lists the seeded session and the team, and the fleet board files the session under Finished once its idle grace passes. `conversation`: the session's page shows its user and assistant messages. `chat`: Jordan types a line in a channel's composer and presses Enter; Jordan's channel shows it, then Riley's does, signed with Jordan's name (the run prints the time between). `org`: the org chart draws with Riley on it.
- **The stack** (`rig/stack.mjs`, started by the first run and reused after): a disposable local anonymous Convex deployment in tmux `smoke-deploy`, run from a scratch copy of the tree at `/tmp/codecast-smoke-deploy` (the recipe in `docs/architecture/sync-sim.md`, with its guards), and a second vite in tmux `smoke-web` on port 3297 with `VITE_CONVEX_URL` on that deployment, its own optimizer cache (`node_modules/.vite-smoke`, which `scripts/vendor-platform.sh` clears along with the dev server's, so the smoke vite restarts on new `@platform` code rather than serving the old bundle) and no HMR (`rig/vite.smoke.config.mjs`). The deployment's state survives restarts in `~/.convex/anonymous-convex-backend-state/anonymous-agent/`. The scratch copy is a snapshot: `--refresh` copies the tree again and waits for the push. The first push and the first app boot each take minutes on a loaded machine; later runs reuse both.
- **The world** (`rig/seed.mjs`) is written through the backend's own functions: Convex Auth's `auth:store` creates the people as a password sign up does, `teams:createTeam` and `teams:addMemberByOperator` make the team, chat and org are turned on, and tips are off so no tour covers a page. Each run replaces the previous run's session and channel and closes both people's open tabs (stored on the server in `client_state`, so a fresh browser would reopen the last run's pages), so every run's screens start from the same state.
- **Never prod.** The stack refuses any deployment that is not a loopback anonymous one, the seed refuses anything but the local deployment, both browsers resolve no host but localhost and 127.0.0.1 (each side proves `convex.codecast.sh` and the Google Fonts hosts unreachable, and the local deployment reachable, before a leg runs), and each side checks it is signed in as its `@smoke.invalid` identity before a leg runs.
- **Baselines** live in `~/.cache/codecast/smoke/baselines` (`RIG_BASELINES` moves them), one PNG and one mask list per leg and person. The diff (`rig/imagediff.mjs`) is per pixel YIQ distance, pixelmatch's measure: a pixel differs past `--threshold` (0.1), and a shot fails past `--max-ratio` (0.002) of its compared pixels or on a size change. Relative times, clocks and `<time>` elements are masked on both sides, plus any selectors a leg names. A shot with no baseline passes on its checks and says so. Shots are taken at 1280x800, scale 1, with the system color scheme pinned (the app's own theme setting decides what it draws), reduced motion, animations and the caret off, New York time and en-US, after the DOM holds still. Nothing outside the machine loads, so the app's Google Fonts stylesheet never arrives and text draws in the system's installed JetBrains Mono (or the fallback mono where it is not installed): with the fetch allowed, each shot drew in whichever of the web face and the installed face won the race, two builds whose glyph widths differ enough to rewrap a line. Baselines are therefore per machine, and installing or removing a font means accepting them again.
- **Timing.** A side waits up to 15 minutes to sign in (`RIG_BOOT_MS`), since the first boot on a cold vite runs minutes on a loaded machine; when the smoke vite optimizes a dependency mid boot, the side reloads its page the way vite's own client would (the server runs without HMR). A navigation the server refuses (it restarts itself when a re-vendor clears its cache) is retried for 2 minutes and then fails with Chrome's reason (`rig/cdp.mjs` `navigate`). The app boots once per side: a leg moves to its page inside the running app with the app's own `routerNavigate` (`lib/tabRoutes.ts`), as a link click does. Each check waits up to 2 minutes, the chat line 30 s to reach Jordan's screen and 60 s to reach Riley's.
- **Output.** Each run writes its shots, diff images and `results.json` to `/tmp/codecast-smoke/<time>` (`/tmp/codecast-smoke/latest` points at the newest) and prints a table of legs. A failed check also saves `<leg>-<person>-failed.png`. Page errors seen during a leg are printed under the table.
- **Needs** Google Chrome in /Applications (or `RIG_CHROME`), `ffmpeg` (the diff reads and writes PNGs through it, as `call-e2e/` does) and tmux.

`e2e/` scripts (`seed.ts`, `cleanup.ts`, `tokens.ts`) act on the same local deployment as the smoke world's Jordan through `e2e/target.ts`; `RIG_DEPLOYMENT=prod` points them at the App Review account on prod instead.

## Generated assets

Run by hand when their source changes; the output is checked in.

- `hero-page.ts`: builds `public/hero/page.html`, the published page the homepage hero's Publish chapter frames, from the hero's publish fixture, so the page's markdown and highlighting code stays out of the hero's bundle (no arguments).

## Build steps

`precompress.mjs`, `prerender.mjs` and `indexnow.mjs` run after `vite build` in the `build` script of `package.json`.
