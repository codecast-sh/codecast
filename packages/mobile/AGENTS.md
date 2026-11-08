# packages/mobile

The root `CLAUDE.md` covers native modules and OTA safety, Metro's single copy of each package, the `@/` alias in shared web files, and the guard tests that enforce them (`lib/nativeDeps.guard.test.ts`, `metro.config.test.cjs`, `lib/bundleGraph.guard.test.ts`). This file adds how to test mobile code.

## Tests

**Run tests the way CI does.** From this directory, `bun test <file>` for one file and `bun test --isolate` for the suite. `components/identity/identity.test.tsx` and a few others replace `react-native` with `mock.module`, which lasts for the whole process without `--isolate`, so a plain multi-file run can fail in files that never asked for the mock.

**Keep logic testable by keeping React Native out of it.** bun cannot load `react-native` itself, so put pure decisions in a module with no React Native import and test that module directly. `lib/linkRoutes.ts` holds every URL routing decision and `lib/links.ts` holds the side that calls `expo-web-browser` and `Linking`; `lib/linkRoutes.test.ts` covers the first with no mocks. Reach for a `react-native` mock only for a component whose rendering is the point.

**A simulator check is separate from the suite.** Native behavior (gestures, keychain, links opened by the OS) only shows on a simulator; use `cast sim` as the global instructions describe, and build simulator binaries with signing allowed (root `CLAUDE.md`).
