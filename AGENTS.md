# Codecast

## Working directory

Work directly in the main checkout. Other sessions may have uncommitted work in the tree — scan `git status`/`git diff` before editing shared files and never revert changes you didn't make.

## Vendored platform packages

`platform/packages/` is a GENERATED mirror of the shared `@platform/*` packages whose canonical home is `~/src/platform`. Never edit it by hand: change the canonical copy, then run `scripts/vendor-platform.sh` to refresh the mirror (`--check` reports drift). The script also purges bun's `node_modules/.bun/@platform+*` copies and `packages/web/node_modules/.vite` and reinstalls, because bun keeps serving the stale copy and vite the stale module graph otherwise. A running dev server restarts itself when that cache disappears (`plugins/depsCacheGuard.ts`); never delete the cache under a live server without that plugin, or every dep it has not served yet answers 504 "Outdated Optimize Dep". The mirror exists because Railway, the CLI release workflow and the desktop build all run from a fresh clone, so every `@platform` dep must point inside the checkout (`file:../../platform/packages/<name>`), never at `~/src/platform`. The package set is derived from the workspace `package.json` files, so adopting a new platform package is one dep line plus a rerun. A real vendor run also rewrites `platform/vendor-manifest.txt`, a content hash per mirrored package; commit it with the mirror. CI cannot run `--check`, because a runner has no `~/src/platform`, so the `test-platform` job runs `--check-manifest` instead: it re-hashes the mirror against that manifest and re-reads the dep lines the mirror was generated from, which catches a hand-edited mirror, a package adopted without a rerun, and a dep pointing outside the checkout. The same job runs each mirrored package's own `bun test`, installing inside the package first because the mirror is not a workspace member and its deps resolve nowhere from the repo root.

## Git history

Keep history flat — rebase, never merge. Pull with `git pull --rebase` (never plain `git pull` when it would create a merge commit), and bring branches up to date with `git rebase origin/main` instead of merging main in. Merge commits from routine syncing don't belong in the log.

## Convex deploys

Convex deploys push whole-tree snapshots: a tree behind origin/main doesn't just lack new code — it DELETES newer functions and routes from prod on push (three separate prod outages on 2026-07-15).

- Deploy ONLY via `packages/convex/deploy.sh`. It fetches origin, hard-fails if the tree is behind origin/main (naming the missing commits), moves the repo-root `.env.local` aside for the deploy (its `CONVEX_DEPLOYMENT=anonymous` pointer hijacks the CLI away from prod) and restores it after. **Raw `npx convex deploy` is banned.**
- The `convex dev` watcher pushes to prod the same way on every save. `dev.sh` refuses to start it from a stale tree and prints the pull instruction (web keeps running; the watcher starts automatically after the pull). Don't start the watcher by hand from `packages/convex`.
- A clean `git status` is NOT a freshness check — deploy only from a tree that is a superset of origin/main. If you're testing unpushed functions, push them early: any other superset deploy reverts whatever isn't on origin/main.

### Deploy convex BEFORE you push

The two halves ship on different clocks. Railway rebuilds web on every push to main. Convex ships only when a person runs `deploy.sh`. A push therefore delivers the new client immediately and the new backend not at all.

Any commit that adds a convex function AND the web code calling it opens a gap. Inside it the live site asks for a function prod does not have, and convex answers "Could not find public function". Convex treats that as terminal, so `useQuery` re-throws during render and the component that subscribed drops into its ErrorBoundary. On 2026-08-11 that took out the entire conversation header, because a header pill asked for `devices.getConversationMachine`.

So run `packages/convex/deploy.sh` **before** pushing such a commit, then push. Deploying a tree that is AHEAD of origin/main is safe and expected — `deploy.sh` refuses only trees that are behind. Ordering it this way costs nothing and closes the gap entirely.

Web carries a second layer of defence. A query that merely ENRICHES a surface goes through `useQueryNoThrow` (`packages/web/hooks/useQueryNoThrow.ts`), never plain `useQuery` — pills, badges, chips and name lookups all qualify. The test is what the component should show if the answer never arrives: if it can still render something honest, use the hook; if the surface is meaningless without the data, plain `useQuery` is right and the ErrorBoundary is the intended outcome.

## CLI releases

Cut CLI releases from CI. No laptop needs the signing certificate.

```bash
gh workflow run cut-cli-release.yml -R codecast-sh/codecast
```

The workflow builds all five binaries on a macOS runner, signs the darwin ones with the Developer ID certificate, uploads staging objects to R2, and dispatches "Finalize pre-uploaded CLI release". Finalize verifies hashes, publishes `latest.json`, commits the version bump, tags, and creates the GitHub release. Pass `-f dry_run=true` to build, sign, and verify without publishing anything.

The certificate and its passphrase live in the repo secrets `MACOS_SIGN_CERT_P12` and `MACOS_SIGN_CERT_PASSPHRASE`. To rotate: export a fresh `.p12` from Keychain Access on Ashot's machine (the escrow copy) and replace both secrets.

`packages/cli/scripts/deploy.sh` is the laptop path. It is also the only path that publishes the npm package and the Homebrew tap; both are mirrors, and R2 plus `latest.json` are the real release. Details in `docs/GETTING-STARTED.md` under "Cut a release from CI".

## Workspace access vs routing

Two separate fields, and conflating them is the bug class this replaced.

- **`workspace` is ACCESS.** One stored value per row: `team:<id>` or `user:<id>`. Written at create time by `computeWorkspaceKey` (`convex/lib/access.ts`), recomputed only when a linked conversation's visibility changes. Every read — server and client — is one equality against the viewer's key.
- **`team_id` is ROUTING.** Which team's inbox, feed and notifications a row flows to. It grants nothing.

**No access path may read `team_id`; no routing path may read `workspace`.** A source-level test enforces the first. The sync log is the one deliberate exception on the delivery side: `sync_actions.scope_key` (which readers a row fans to) derives from access facts, and `sync_actions.access_key` is a write-time copy of `workspace` read only by `syncLog.getRange`'s per-caller projection — the stamp is built by `accessStampFor` in `lib/access.ts`, and `canAccessTask/Doc/Plan/Project` are defined as evaluating that same stamp, so the log and the byIds queries cannot disagree (docs/architecture/sync-log-cargo.md E4). This is what makes "routed to team T, readable only by its owner" expressible (`team_id: T` + `workspace: user:<owner>`) — granular privacy inside a team is a product requirement, not an accident.

**Reads may default, writes must be explicit.** Guessing on a read costs a re-run; guessing on a write puts a row in a workspace nobody was looking at. The CLI splits this (`resolveWorkspaceForRead` / `resolveWorkspaceForWrite`), as does chat (`resolveTeamForRead` / `requireTeamForWrite`).

**Personal is a positive value.** `user:<viewerId>`, never "absence of team_id". An unresolved viewer matches NOTHING — never everything. Unknown key variants (a future `restricted:`) grant no access. Never read `activeTeamId || currentUser.team_id` as a workspace pointer: an unset pointer IS the personal workspace, and that fallback makes personal unreachable.

**Go through the chokepoints.** Server reads: `createDataContext` / `scopedFetch` (`convex/data.ts`). Conversation visibility writes: `patchConversationVisibility` — a raw `ctx.db.patch` of `is_private`/`team_visibility`/`team_id`/`auto_shared` leaves linked work items with a stale key. Client enumeration: `useWorkspaceCollection`. Web team switch: `useSwitchWorkspace` (writes the canonical `users.active_team_id` AND the `clientState.ui` mirror — mirror-only desyncs the CLI). Guard tests fail on raw enumeration and on mirror-only writes.

**Do NOT "finish the migration" by deleting `teamVisibleConvTeam`.** It survives in exactly two correct roles: the writer inside `computeWorkspaceKey`, and the visibility rule for CONVERSATIONS, which keep their own graduated axis (`is_private`, `team_visibility`, membership visibility, redaction) and have no workspace key by design. Two axes on purpose: membership (binary) vs activity visibility (graduated). A table earns `workspace` only if a row can meaningfully be private to its owner inside a team — work items yes, session insights and pull requests no.

`teamScopeSweep` is the reconciler: it recomputes every key and reports disagreement, so staleness is provable rather than assumed.

## UI conventions

**Keyboard keys always render as `<KeyCap>`** (`components/KeyboardShortcutsHelp.tsx`) — never as plain text or unicode glyphs in the surrounding font (no `⌥K`, `↵ select`, `esc back` as bare strings in hints, footers, or tooltips). Use `isMac` from `shortcuts/` for the modifier name and `formatShortcutParts` when rendering a registered shortcut.

**Mobile: `Text`/`TextInput` come from `packages/mobile/components/Themed`, never from `react-native`.** The Themed wrappers are what apply JetBrains Mono app-wide (web parity) and map `fontWeight` to the correct bundled face (`constants/fonts.ts`) — a raw RN `Text` renders San Francisco, and a custom `fontFamily` + `fontWeight` pair silently falls back to the system font on iOS. Nav-level styles (`headerTitleStyle`, `tabBarLabelStyle`) can't use the wrapper: give them an explicit face from `Mono` (e.g. `Mono.semiBold`) and no `fontWeight`.

## Store (inboxStore)

### Local-first is the law

**Every piece of server data a surface renders lives in the store, and the surface reads the store.** A live Convex query is a *feeder*, never a render source: it subscribes in a hook, hands each push to `syncTable`, and the component paints from `useTrackedStore` / `useCollectionRows` / `useWorkspaceCollection` synchronously — a populated cache is the ordinary first paint, and a skeleton is only honest for a genuinely cold cache (`!ready && rows.length === 0`). Never gate paint on `result === undefined` when the store could already hold the answer.

**Adding a synced collection is ONE registration** in `store/clientSyncRegistry.ts` — persistence, hydration phase, `sync` opts (`isDelta` for windowed/paged channels, snapshot for a query that returns the complete visible set), `indexes`, `workspaceScoped`, and `feeds` (the query names that feed it). From that entry the Dexie schema, the sync defaults, the `{}` at boot, the typed store slot, the workspace-enumeration guard and the feed-leakage guard all derive. Then bump `CACHE_SCHEMA_VERSION` (`store/idbCache.ts`) — the signature test tells you when. Feeder: `useSyncCollection(key, api.x.y, args)` (`hooks/useSyncCollection.ts`), or a bespoke `useSync*` hook when a payload fans out. Reader: `useCollectionRows(key, { where, sig, sort })` — subscribe to a signature of the fields you render, never the raw collection ref.

**Registering a `feed` is a promise:** a source-level test (`lib/__tests__/registeredFeeds.guard.test.ts`) fails any file under `app/` or `components/` that subscribes to a registered feed query directly. If it fails on your code, the fix is to read the store and mount the feeder — not to widen the allowlist. Writes are `action()`s that patch the row on the draft and ride a named dispatch side effect (`convex/dispatch.ts`) to the real mutation; a `localFirst` collection then protects the field until the server echoes it.

Every user-visible mutation renders from the local store synchronously — the UI must never wait on a server round-trip to show the result of a user action. The optimistic write happens in the `action()` draft; the server echo reconciles afterward through the sync/pending machinery. For **creates**, write a stub row keyed by a non-Convex id and let the collection's `altKey` config supersede it when the server row syncs back (`beginOptimisticSession`, `createBucket`, `assignSessionToBucket` are the canonical examples). If a feature seems to need an await-then-render flow, it is modeled wrong — restructure it as draft + side effect. `asyncAction` exists so a *caller* can await the server result (e.g. a real id for follow-up writes), never so the UI can.

**The store already provides optimism.** Update the draft through `action()` / `asyncAction()` and render from the store. Do not add parallel optimistic state, timers, reconciliation effects, or handwritten pending locks. Check the existing action and sync paths first; fix a bypass there. Any exception needs a concrete limitation of the default path, not an assumption that optimism must be implemented again.

All store mutations go through `mutativeMiddleware`. Default to `action()` for new functions. Only use raw `set()` for ephemeral UI gestures (modal open/close, palette toggle) that don't touch shared state.

### One window syncs, the rest replicate (sync host)

Exactly one window per origin is the elected sync host (Web Locks; `store/syncReplication.ts`). It mounts the global feeders and owns IDB write-through; every other window is a follower — global feeders skipped (gated on `syncRole`), shared slice applied from the host's BroadcastChannel stream, its own optimistic writes offered back as muts. Full design: `docs/architecture/sync-host.md`.

- **Every registry key is classified** in `REPLICATION_CLASSIFICATION` (`store/clientSyncRegistry.ts`) — adding a registry key without classifying it is a compile error. `pending` never replicates; per-window paging/arrangement keys stay `local`.
- **A global feeder must gate on the role**: mount it inside `HostFeeders` (DashboardLayout) or skip its query via `useIsSyncHost()`. Per-view queries (a conversation's messages, a doc body) never gate.
- **Replicated data enters only through `syncTable`/the store's sync actions** (`applyUpdatesToStore`), so pending protection and merge policies behave as if the rows came from Convex. Never apply replication by raw assignment.
- Followers keep their own dispatch + outbox (writes are unchanged) and never stamp sync-log acks (`syncMeta` replicates from the host).

### Decorators

- `action(fn)` — mutative draft + IDB persistence + server dispatch. The return value of fn flows back to the caller AND to the server as `result`. Default choice.
- `sync(fn)` — mutative draft + IDB persistence, no server dispatch. Use for incoming data sync and local-only bookkeeping.
- Raw `set()` — only for ephemeral state that doesn't need persistence or drafts (modal toggles, transient flags).

Never use raw `set()` to modify `sessions`, `conversations`, `clientState`, `tasks`, `docs`, or `plans`.

### Sync

All incoming data goes through `syncTable(field, data, opts?)`. Don't create per-table sync functions — register the table's config in `SYNC_REGISTRY` instead.

- `kind: "collection"` — keyed by `_id`, runs pending filter
- `kind: "singleton"` — single object with merge strategies
- `kind: "list"` — raw array, replaces wholesale
- `kind: "scalar"` — primitive value

Merge strategies for singletons: `"replace"`, `"local_wins"`, `"set_union"`, `"deep_merge"`, or nested `Record<string, MergeSpec>`.

Use `syncRecord(field, id, record)` for single-record updates within a collection.

### Reading state in components

Use `useTrackedStore` — declare deps (what triggers re-renders), access the full state:

```ts
const s = useTrackedStore([
  s => s.messages[id],
  s => s.sessions[id],
  s => s.conversations[id],
]);
// Full state access — read any field, call any getter
const meta = s.conversations[id] ?? s.sessions[id];
const messages = s.messages[id] ?? [];
```

- One subscription per component instead of N separate `useInboxStore(selector)` calls.
- Deps control re-renders (compared via `Object.is` on return values). Non-dep fields may be stale between re-renders — add to deps if freshness matters.
- For non-React code (event handlers, callbacks), use `useInboxStore.getState()` or the `store` proxy directly.

**Never subscribe an always-mounted component to a whole high-churn collection (`s => s.sessions`) or whole row (`s => s.sessions[id]`).** The store is a mutative draft, so any field change on any row hands back a new collection/row ref — with ~1s liveness heartbeats across N live sessions that ref flips constantly and re-renders you on every tick, even though `updated_at`/`last_heartbeat`/a streamed `message_count` changed nothing you show. (This pegged the inbox sidebar at ~70% idle main-thread.) Instead subscribe to a **wake signature** of just the fields you branch on — `store/wakeSig.ts`: `makeCollectionSig(project)` for a collection (the sidebar uses `sessionsWakeSig`), `rowSigExcluding(row, deny)` for one row (`useConversationMessages`). The body still reads the raw field for data; the signature only gates re-renders. Pair it with `useCoarseNow` for anything **time-driven** (a relative clock, a TTL-based reclassification) — that's not a field change, so a signature alone would freeze it.

### Derived/enriched fields are snapshots — derive them live (`lib/liveEntities`)

Convex queries return records enriched with **derived/joined** fields: `task.assignee_info` (from `assignee`), `plan.progress` (from task statuses), `plan.tasks` (embedded snapshot), `doc.display_title` (from `content`). These are **snapshots** — an optimistic store write to the underlying *raw* field (e.g. `updateTask` sets `task.assignee`) does NOT update the derived twin until the server round-trips. Binding a derived field straight off a server query is the root of "the change isn't instant" bugs.

**Default: never store-and-protect a derived object field; derive it at render** via `lib/liveEntities`:
- `resolveAssigneeInfo(assignee, fallback, teamMembers, currentUser)` — avatar/name from the live roster.
- `computePlanProgress(tasks)` — progress counts from a live task list.
- `mergeLiveTasks(snapshotTasks, storeTasks, teamMembers, currentUser)` — overlay live store tasks onto a server snapshot (e.g. `plan.tasks`), preserving server-only fields and re-deriving `assignee_info`. Memo-stable (returns the same row ref when nothing diverged).

Why not store the derived value optimistically: field-protection reconciles by `===`, so an optimistic **object** never matches the server's re-enriched object and freezes forever. Why not auto-derive in `syncTable`: a `config.transform` bypasses the no-change early-return and re-pushes the whole collection on every no-op sync (jank). String-valued derived fields (e.g. `display_title`) are the exception — they reconcile cleanly, so deriving them on the optimistic write (see `updateDoc`) is fine.

### Dev console access

Every build, dev and prod, exposes the store as `window.__inboxStore` (end of `store/inboxStore.ts`). Use it from the browser console (or javascript_tool when verifying in Chrome) to inspect state or drive flows that have no URL of their own — e.g. fire an in-app deep-link to a message:

```js
__inboxStore.getState().sessions            // inspect
__inboxStore.getState().requestNavigate("<session key>", { scrollToMessageId: "<message _id>" })
__navLog()                                  // audit trail of every view change (and blocked attempts)
```

Raw `setState` writes to `currentSessionId`/`pendingNavigateId` are reverted by the view-motion guard (`store/viewNav.ts`): every change of the visible conversation must declare a source, and machine-initiated sources can't move the view mid-session. If a "random session jump" is ever reported, read `__navLog()` first — it names the writer.
