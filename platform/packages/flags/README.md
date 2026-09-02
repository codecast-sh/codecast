# @platform/flags

Feature gating for the platform apps, extracted from codecast's team
features. Pure TypeScript, no SDK imports: PostHog clients, storage and
React are injected, so every module runs and tests without network or
framework.

## The two halves

**Catalog gates** are server enforced entitlements. A gate is a named
switch stored per scope (a team, a workspace, an account); an admin flips
it, the server refuses at the feature's chokepoint when it is off, and the
clients hide the surface. Use this half when the flag decides what a scope
is allowed to do — the value must be enforceable on the server and
auditable in the scope's own row.

**PostHog flags** are remote flags and experiments that only the UI reads:
rollouts, A/B variants, payloads. The values live in PostHog and can change
without a deploy. Use this half for gradual rollouts and experiments —
never for entitlements, because a client-read flag enforces nothing.

The line: if the server must say no, it is a catalog gate. If you want to
turn something on for 10% of users tomorrow, it is a PostHog flag.

## API

Everything is exported from the root; `./react`, `./posthog` and
`./commands` exist as narrower subpaths.

Catalog (`src/catalog.ts`) — pure data and functions:

- `defineFeatures(descriptors)` builds a `FeatureCatalog` from
  `{ key, name, desc, defaultOn? }` descriptors. Duplicate keys throw.
  Extra descriptor fields (codecast's `snippets`) are kept and typed.
- `isEnabled`, `holderHasFeature`, `anyHolderHasFeature` read a stored bag
  (`StoredFlags`: only flags that were ever set; absent reads as the
  catalog default). `withFlag` returns a new bag.
- `attachedAvailability`, `featuresAttaching`, `attachedItemAvailable`
  fan a gate out to items a descriptor attaches (codecast: agent snippets).
- `featureOffMessage`, `featureOffCopy`, `ScopeWording` keep one wording
  for "this feature is off" across CLI, web and mobile.

Server guard (`src/guard.ts`):

- `createFeatureGuard({ catalog, loadFlags })` returns
  `has(scope, key)` / `require(scope, key, fail?)` / `offMessage(key)`.
  The app supplies how a scope's flags load; the guard supplies the rule
  and the wording.
- `applyFeatureChange(catalog, input)` is the admin toggle as a pure
  decision: checks admin, scope existence and key validity, returns the
  new bag to persist or throws.

CLI guard (`src/cliGuard.ts`):

- `requireFeatureOrExit(opts, key)` stops a command for an off or
  unscoped feature with the same words the server would use, instead of
  answering with an empty list. `featureRefusalMessage` is the line alone.

React (`src/react.ts`):

- `createFeatureHooks(catalog, useSource)` returns `useFeature`,
  `useAnyFeature` and `useFeatureState` as selectors over one injected
  source hook. No React import in the package.

Kill switch (`src/killSwitch.ts`):

- `createKillSwitch({ storage, authenticate })` — minimum version levers
  (`min_cli_version` and friends): `getMinimum`, admin only `setMinimum`,
  and `mustUpdate(lever, version)`. Plus the pure `compareVersions`,
  `isBelowMinimum`, `isValidVersion`.

PostHog (`src/posthog/`):

- One `FlagsClient` interface (`getFlag`, `getVariant`, `getPayload`,
  `reload`) with three adapters: `fromPostHogJs` (browser SDK),
  `fromPostHogReactNative` (RN SDK), and `createServerFlagsClient` — an
  HTTP evaluator over `${host}/flags/?v=2` with `fetch` injected, which
  accepts both the v2 response and the older decide shape.

## CLI

`src/commands.ts` exposes the verbs as plain functions
(`createFlagsCommands({ catalog, gates, posthog?, write, writeError })`)
so an app can mount them under its own command framework:

```
flags list <scope>                 gates and their state for a scope
flags get <scope> <key>            one gate
flags set <scope> <key> on|off     flip a gate (admin)
flags posthog <distinctId> [key]   PostHog flags as evaluated for an id
```

`src/cli.ts` (the `platform-flags` bin) is a standalone runner for trying
the verbs without an app: the catalog comes from a JSON file of
descriptors, gates live in a JSON file, and PostHog reads use the HTTP
evaluator.

## Env var names

The library reads no env vars. The standalone `src/cli.ts` reads:

- `POSTHOG_API_KEY` — project API key (`phc_...`); absent disables the
  `posthog` verb
- `POSTHOG_HOST` — default `https://us.i.posthog.com`
- `FLAGS_CATALOG` — path to a JSON array of `{key,name,desc,defaultOn?}`
- `FLAGS_STORE` — path to the JSON gate store, default `./flags-store.json`

## Adoption

**codecast** — the catalog stays, the machinery becomes imports:

- `shared/contracts/teamFeatures.ts` stays as the app's catalog, rebuilt
  as `defineFeatures(TEAM_FEATURES)`; the `snippets` field rides along as
  an extra descriptor field and the snippet fan out maps to
  `attachedAvailability` / `attachedItemAvailable`.
- `convex/teamFeatures.ts` (the server checks and the admin toggle) →
  `createFeatureGuard` with `loadFlags` reading `teams.features`, and
  `applyFeatureChange` inside the mutation.
- `web/lib/teamFeatures.ts` and `mobile/lib/teamFeatures.ts` →
  `createFeatureHooks` over each app's team source.
- `requireWorkspaceFeature` in `cli/src/index.ts` →
  `requireFeatureOrExit` with the cast specific `pickHint`.

**whisk / aurora** — no gating today; minimal wiring is one catalog plus
one guard:

```ts
// shared/features.ts
export const catalog = defineFeatures([
  { key: "beta_editor", name: "Beta editor", desc: "The new editor." },
]);

// server
const guard = createFeatureGuard({
  catalog,
  loadFlags: async (scopeId) => (await db.getScope(scopeId))?.features,
});
await guard.require(scopeId, "beta_editor"); // throws the shared wording when off

// web
export const { useFeature } = createFeatureHooks(catalog, useActiveScope);
```

For a PostHog experiment, wrap the app's existing client:
`const flags = fromPostHogJs(posthog)` then `flags.getVariant("exp_key")`;
a server or worker uses `createServerFlagsClient` with its own `fetch`.

## Tests

`bun test` — 38 tests, no network. `npx tsc --noEmit` covers src and
tests.
