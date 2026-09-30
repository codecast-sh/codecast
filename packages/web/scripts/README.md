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
- `rig/`: the two-identity headless rig for the header face row (walkie, ring, reconnect, dead seat); `rig/run.mjs` runs the legs, `rig/shots.mjs` captures every row state, `rig/eval.mjs` evaluates on a browser left up by `--keep`. Needs the dev server on localhost:3200 and `CONVEX_SELF_HOSTED_ADMIN_KEY`.
- `renderCueWaveforms.ts`: draws every walkie cue as a waveform PNG at one shared scale, so a cue's loudness is reviewed by eye instead of by ear (`[outDir]`).

## Build steps

`precompress.mjs`, `prerender.mjs` and `indexnow.mjs` run after `vite build` in the `build` script of `package.json`.
