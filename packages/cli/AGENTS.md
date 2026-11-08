# packages/cli

See the root `CLAUDE.md` for typechecking, releases and prompt dry runs. This file covers CLI tests.

## Tests

**Run tests from this directory.** `bun test src/<file>.test.ts` here, or `bun run test` for the suite (`bun test ./src/`). From the repo root bun treats the path as a filter and scans the whole tree, and with this machine's shell descriptor limit above 10,240 every child spawn in that run exits 1 with empty stdout and stderr and no error. A test that spawns then records nothing; the install golden once saved a 0-byte `help.txt` and passed against it. `runCli` in `src/install.golden.test.ts` now throws on an empty capture. A red tmux or subprocess test seen from the root proves nothing until it is rerun from here.

**The preloads in `bunfig.toml` are load-bearing.** `src/test-helpers/isolatedTmuxServer.ts` points every tmux client in the process, the daemon's included, at a private server, and it must evaluate before `daemon.ts` snapshots `process.env`. That ordering only holds as a preload, because about 74 unrelated test files import `daemon.ts` and whichever bun loads first wins. Don't move real-tmux setup into per-file imports.

**Use the shared helpers in `src/test-helpers/` before writing your own.**
- `strictStub(name, impl)`: a fake that throws on any method the test did not plan for. A partial object cast to the full type answers new calls with `undefined`, so code that grows a dependency keeps passing while it skips the work.
- `pollUntil(check, what, opts)`: the one polling wait. Its budget stretches with machine load (`machineLoad.ts`) and, given `progress`, fails on a stall rather than on a slow machine. Never wait with a fixed sleep.
- `messagingHarness.ts`, `tmuxPane.ts`, `fakeClaudeShim.ts`: real-pane and fake-agent drivers for delivery tests.

**Fakes copy what they receive.** In bun 1.3.14, `expect(obj).toMatchObject({ host: expect.any(String) })` leaves the matcher object in `obj.host`. A fake server that stores the request body by reference then hands that matcher to a later route, which fails with `DataCloneError` far from the cause. Store `structuredClone(body)`, as `src/orgTemplate.test.ts` does.

**Attribute a full-suite failure before believing it.** With a dozen or more live agent sessions on this machine, the full 3,000+ test suite times out a handful of tests purely from load (messaging e2e `AGENT_STDIN_NOT_READY`, 3 to 6 s timeouts in `wipSnapshot`, `gitPlane`, `statusHook`). Rerun the failing files alone; a test that fails alone is a real failure. CI runs `messaging.e2e.test.ts` and the inject suites in their own steps for the same reason.

**Some guards are source scans.** `src/syncService.timeout.test.ts` requires exactly one `this.client.mutation(` call site and that it pass `{ skipQueue: true }`, because `ConvexHttpClient` otherwise runs every mutation through one serial queue and a backlog timed out every caller. Route new mutations through `SyncService.mutate()`.
