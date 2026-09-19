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

## Traps

- A simulator build made with signing disabled has no `__TEXT,__entitlements` section; every keychain call fails and nobody can sign in. Check with `otool -s __TEXT __entitlements Codecast.app/Codecast`.
- Above a machine load of about 350 the simulator kills a slow launch by signal with no crash report. Wait for lower load and run again.
- `sim-reap` shuts down a pool simulator whose lock went stale. Reacquire it after a session resume.
