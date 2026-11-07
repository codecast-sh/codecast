# packages/web

The root `CLAUDE.md` covers the store, the sync host, guard tests for registered feeds, the typing budget and the render gallery. This file adds what you need to write and debug web tests.

## Tests

**Run tests the way CI does when a result surprises you.** Run a file from this directory with `bun test <file>`. CI runs `bun test --isolate --shard=N/4` (`.github/workflows/ci.yml`, job test-web), which gives every file its own global. A plain multi-file `bun test` runs every file in one process, so `mock.module` replacements and a jsdom window on `globalThis` outlive the file that made them. When a test passes alone and fails in a suite, rerun with `--isolate`, then bisect the files that ran before it (`bun test <half of them> <target>`) and look for module-load-time environment checks before blaming the product code.

**Process-wide test setup lives in one preload.** `test-helpers/preload.ts` (wired in `bunfig.toml`) runs before every file. It stubs the tiptap sync hook, stands in for `@pierre/diffs` drawing, and points every installed copy of Radix's `react-use-layout-effect` shim at React's own `useLayoutEffect`. Radix picks the real hook or a no-op once, at first import, depending on whether `document` exists; a DOM-less store test that loaded Radix first left the no-op, and every later Portal (dialogs, the consequential review) silently never mounted. A mock many files need belongs here, not in each file.

**A module mock keeps the real exports.** Write `const real = { ...(await import("<module>")) }; mock.module("<module>", () => ({ ...real, useThing: stub }))`. A mock that returns only the hook makes any later importer of a sibling export die with `SyntaxError: Export named 'orgRolesSig' not found`, and only in a combined run. Two files that mock the same module must return the same shape and values, because the first registration wins for constants computed at import time.

**Leave the process as you found it.**
- Close a jsdom window with `closeDomWindow` from `test-helpers/domGlobals.ts`. A bare `window.close()` leaves a dead window installed and the next file fails inside jsdom (`idlUtils.implForWrapper(window._document)._location`).
- bun runs tests in UTC with `process.env.TZ` unset. Restore a changed TZ to `Intl.DateTimeFormat().resolvedOptions().timeZone` captured before the change; assigning `undefined` stores the string "undefined" and `delete` falls back to the machine zone. `components/ops/issuesRound9.test.ts` shows the pattern.

**IndexedDB tests reopen the cache explicitly.** Dexie copies `indexedDB` into the instance when `store/idbCache.ts` constructs its singleton and caches a failed open, usually in an earlier file. Importing `fake-indexeddb/auto` later does nothing. Call `await _reopenForTests({ indexedDB, IDBKeyRange })` (from `fake-indexeddb`) before any read or write; `store/__tests__/conversationUserMessagesCache.test.ts` is the example.

**Guard tests encode past outages; fix the code they name.** Source-level guards live in `lib/__tests__/*.guard.test.ts` and `store/__tests__/`. Two that catch failures nothing else does:
- `markdownMapCycles.guard.test.ts`: a markdown component map that reads a `const` through an import cycle throws `Cannot access 'X' before initialization` in the production bundle and holds the app on the splash. Import a const component from the module that declares it, never through a re-export.
- `fastRefreshBoundaries.guard.test.ts`: a component invoked as a plain function from another component's body runs its hooks on the wrong fiber, and Fast Refresh then crashes on a hook-order change.

**Hot paths have exact-count budgets.** `scripts/perf-budgets.sh` holds what a warm conversation switch, the 5,000-session inbox and a long diff may cost (fetches, subscriptions, store writes, commits, layout reads), and `scripts/perf-bench.sh` times base against head with strobe. When a change moves a count, `perf/README.md` says how to read it and when to update it.
