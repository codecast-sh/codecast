# Measuring mobile startup

These scripts measure a cold launch of the exact release bundle on a simulator, with numbers that hold on a loaded machine.

Wall clock times on this machine mostly measure other processes. So every run records two things: the `[boot]` marks the app logs (`lib/bootProfile.ts`), and the process CPU time sampled ten times a second. CPU time does not change with machine load.

## One comparison

1. Export the bundle: `node_modules/.bin/expo export --platform ios --source-maps --output-dir /tmp/export-a`. Call the local binary; `npx expo` spends minutes before it starts.
2. Dump the config once: `node_modules/.bin/expo config --type public --json > /tmp/expo-config.json`.
3. Serve it over the Expo updates protocol: `bun scripts/startup/serve-update.mjs /tmp/export-a 8093 /tmp/expo-config.json`. Set `RUNTIME_VERSION` when the installed binary is older than `app.json`.
4. Launch and measure: `scripts/startup/measure.sh <udid> a1 8093`. Run each bundle at least twice; the first launch after an install is not representative.

The installed app must be a dev client build. It loads the served bundle as an update, so the JS is the release artifact (Hermes bytecode, minified) even though the binary is a debug build.

## Where the time goes

- JS thread: start Metro, load the app from it, then `bun scripts/startup/hermes-trace.mjs <ws-url> 75 trace.json`. The websocket URL comes from `curl localhost:<port>/json` (the "React Native Bridgeless" page). This React Native version records through the `Tracing` domain; `Profiler.enable` is not supported. Convert and read it with `trace-to-cpuprofile.py` and `profile-by-module.py <cpuprofile> <dev bundle file>`.
- Native threads: `sample <pid> 10 -file out.txt`, then read the "Sort by top of stack" section. An idle JS thread with a busy process means native work driven from JS, as the SQLite fan out at boot was.

## Taps

`lib/perfProbe` logs one line per touch when the bundle is built with `EXPO_PUBLIC_PERF_PROBE=1` (export or Metro): how long until JS saw the touch (`lag`), the first frame after it (`first`), when frames came back to a steady beat (`settle`), the longest frame gap, the route before and after, and how many times the counted components rendered (`renders=`). Every time is measured from the native touch.

1. Export with the probe on (`EXPO_PUBLIC_PERF_PROBE=1 node_modules/.bin/expo export ...`) and serve it as above.
2. `scripts/startup/taps.sh <udid> <label> <port> scripts/startup/taps-main.seq`. It prints each tap's numbers beside the process CPU spent until the next tap.

On a loaded machine the wall times swing by seconds while CPU per tap and the render counts hold, so compare those, and run two bundles alternately rather than one after the other. A system prompt over the app (photo access, notifications) swallows every tap after it: check the screenshots `taps.sh` saves after each one.

To see where one tap's time goes, run Metro with the probe on, add `TRACE=<seconds>` to `taps.sh`, convert the trace, and read the window from the tap's `at=` to `at=` plus `first` with `profile-window.py`.

## Module evaluation at boot

`boot-trace.sh <udid> <label>` traces a cold launch against Metro from the moment the runtime registers, and `module-eval.py <cpuprofile> <dev bundle>` charges each sample to the module whose top-level code is running. A module that shows up there does work at import time; one that stays out is evaluated where it is first used (Metro's `inlineRequires`, metro.config.js).

## Traps

- A simulator build made with signing disabled has no `__TEXT,__entitlements` section; every keychain call fails and nobody can sign in. Check with `otool -s __TEXT __entitlements Codecast.app/Codecast`.
- Above a machine load of about 350 the simulator kills a slow launch by signal with no crash report. Wait for lower load and run again.
- `sim-reap` shuts down a pool simulator whose lock went stale. Reacquire it after a session resume.
