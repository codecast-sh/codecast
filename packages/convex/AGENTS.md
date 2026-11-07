# packages/convex

Deploys go through `deploy.sh` only; the root `CLAUDE.md` explains why, and covers workspace access rules. This file covers tests and the typecheck failures specific to Convex code.

## Tests

**Run tests from this directory.** `bun test convex/<file>.test.ts`, or `bun run test` for what CI runs (`bun test convex/ scripts/`).

**Function tests use convex-test with the shared module map.** Pass `allModules` from `convex/testModules.testkit.ts` to `convexTest(schema, allModules)` so any function a write schedules (titles, wakes, live activity) is found. Shared fixtures go in a `*.testkit.ts` file: a name with two dots keeps the Convex bundler from deploying it, which matters because testkits use Bun APIs the Convex runtime lacks. Some older suites hand-roll a fake `ctx.db`; new ones should not.

**Every entry module must load on its own.** `convex/moduleLoad.test.ts` loads each of the ~200 entry modules in its own process. Run it after adding an import between Convex modules. Two rules it enforces:
- Never use `import()` in `convex/`. The runtime refuses it at call time (`dynamic module import unsupported`), and typecheck and the pusher stay green; a day of shares failed in prod this way on 2026-09-22.
- Nothing reachable from `convex/functions.ts` may import a module that defines functions at load. A static import on that cycle throws `Cannot access 'mutation' before initialization` in every entry that loads it. Break a cycle by moving the pure part into a leaf, as `lib/accessKeys.ts` does for `lib/access.ts`.

**An action that runs a query from its own module needs explicit return types.** Without them inference loops through the generated `api` types and `cast check cli` and `cast check web` fail with TS7022 on the action, then with implicit-any errors in files nobody touched, while `cast check convex` may pass. Give both handlers explicit `Promise<T>` return types and annotate the `ctx.runQuery` result. When implicit-any errors appear in untouched files, look for a new action/query pair first.

**Build credential-shaped test strings at runtime.** GitHub push protection rejects a push containing a Stripe-shaped literal such as `"sk_live_..."`, fake ones included (it blocked `secrets.test.ts` and `passkeys.test.ts`). Split the prefix (`"sk_" + "live_..."`), as `convex/secrets.test.ts` does, or generate the body as `packages/cli/src/secretPatterns.test.ts` does.
