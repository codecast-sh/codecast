# Undo and history (ct-56508)

Undo and redo in the web app run through one generic mechanism. Any `action()` whose name has an undo spec records the cells it changed. Undo writes the old values back through the same middleware pipeline every action uses, and a hidden but discoverable timeline shows the window's history. This document is the design of record. It merges four independent designs (engine, server safety, coverage, timeline UI), and the "Decisions" section says which idea won each conflict and why.

## 1. What exists today, and what is broken

The engine undo stack (`~/src/platform/packages/engine/src/undoStack.ts`):

- Each entry is a closure pair `{label, undo, redo, ts}`.
- At most 30 entries are kept, each for 5 minutes.
- Pushing a new entry clears the redo stack.
- Nothing can subscribe to it.

Codecast installs sonner as its notifier (`packages/web/store/undoStack.ts`). The hand-written undos live in `packages/web/store/undoActions.ts`. Every one of them writes its local half with raw `useInboxStore.setState`. That bypasses `wrapAction` (`middleware.ts` ~1236), which is where pending locks, the view guard, IDB write-through, the replication tee and the outbox live, so each undo has to rebuild those by hand.

Verified defects the design must remove:

| # | Defect | Where |
|---|---|---|
| B1 | **Undo of a doc archive does not survive the next sync.** `archiveDoc` deletes the row, and the middleware plants a `docs:<id>` exclude. The undo restores the row with raw `setState` and leaves the exclude, and `restoreArchivedDoc` is a no-op action. `docs` is a delta collection, so the next push skips the excluded id. | `inboxStore.ts` `archiveDoc`/`restoreArchivedDoc` (~12377), `undoActions.ts` `undoableArchiveDoc` |
| B2 | **Undo of a defer, rest verdict or pin can be reverted by the next push.** `undoableFieldGesture` deletes only the `sessions:` locks. The `conversations:<id>:<field>` lock still holds the forward value, so a later push re-applies the forward value. | `undoActions.ts` ~272 |
| B3 | **Raw `setState` skips IDB and the follower tee.** A reload or a follower window can resurrect the undone state. | `undoActions.ts` ~171, ~274, ~406 |
| B4 | **The toast's Undo button undoes the newest entry, not its own.** | `undoStack.ts` `showUndoToast` |
| B5 | **⌘Z never reaches app undo on mac, and Ctrl+Z steals text undo inside fields.** The binding is `ctrl+z` with no `mac:` variant and with `skipInputCheck: true`. | `shortcuts/registry.ts` ~260; `keys/src/catalog.ts` `matchShortcut` and `inputGuardBypass` |
| B6 | **Undoing a stash or kill of a teammate's row does not stick on the server.** The forward write goes to `inbox_hides` through the side effect. The undo sends only conversation patches, and `applyPatches` drops those for non-owners. The server already has the right inverse, `restoreSession` (`dispatch.ts` ~1291). | `dispatch.ts` ~395-405 |
| B7 | **Holding the undo key wipes the whole stack at key-repeat speed.** The dispatcher never checks `e.repeat`. | `keys/src/dispatch.ts` ~79 |
| B8 | **The same verb is undoable from one surface and not from another.** Pin is undoable from triage but not from the context menu or the palette. Favorite, restore, snooze, bulk kill, task, doc, plan and bucket edits are never undoable. | call sites listed in section 9 |

## 2. Decisions

| Question | Decision | Why |
|---|---|---|
| What is recorded | **Cells**: `{store, id, field}` with before and after values, read from the two immutable states `wrapAction` already holds. Mutative's `inversePatches` are not used. | Inverse patches are positional on lists (`toggleBookmark` unshifts), so they corrupt a list once a sync reorders it. They also cannot detect drift, and they carry `pending` and view writes. Cells come from the same enumeration `generateAutoPending` uses, so locks and undo can never disagree about what an action touched. |
| Where the specs live | **A registry keyed by action name**, `UNDO_POLICY` in `packages/web/store/undo/`, passed to the engine as `PlatformConfig.undo.specs`. A guard test requires every creator to be classified, and a second one (`lib/__tests__/storeActionMutations.guard.test.ts`) fails any surface that calls a mutation a classified action's dispatch side effect runs, so no gesture writes past the store where undo cannot see it. Not `action(fn, {undo})` inline. | `inboxStore.ts` is 13.7k lines and shared with other sessions. A registry keeps ownership disjoint, follows the `SIDE_EFFECTS` and `REPLICATION_CLASSIFICATION` pattern, and lets the guard make classification exhaustive. |
| How undo writes locally | **A replay through the shared `runAction` pipeline**, with a synthetic recipe that writes the before values. | This gives locks, view guard, IDB, tee, outbox and refusal rollback with no extra code, and fixes B2 and B3 structurally. |
| How undo reaches the server | **Decided by the store key.** Keys on the patch rail (`sessions`, `conversations`, `buckets`, `sessionDecisions`) ride one `applyUndoPatches` dispatch. Keys off the rail use a per-collection **writer** (`store/undo/writers.ts`) that names the existing action to dispatch. A spec may override this with an explicit **inverse**. | One registration per collection covers every action that writes it: `updateTask`, `updateTaskStatus`, `setTaskParent` and `closeTaskWithGuard` all share the tasks writer. The override is only for transitions a field diff cannot express: archive, a non-owner unhide, a server toggle. |
| Redo | **Re-invoke the original action with its original args**, after checking that the cells still hold their before values. The fresh capture replaces the entry's cells. | Draft side effects and server side effects (sounds, broadcasts, hide-for-viewer) run with no extra code. Toggles are safe because the check guarantees the state is back at before. |
| Stale undo | **The guard is per row and all-or-nothing within a row. Across rows an undo may be partial.** For each protected cell: if the current value equals `after`, restore it. If it equals `before`, there is nothing to do. Anything else is a conflict, and the whole row is skipped. The toast reports a partial undo. An entry where no row applies is marked `conflict`, and the keypress stops there. | A half-restored row (a defer stamp without its snooze) is a state the user never had. A bulk gesture should still undo the rows nobody touched since. |
| Bulk gestures | **`undoGroup(label, fn)`**, synchronous only. `fileSessionsAsRest` waits for all exit animations, then files every row inside one group. There is no open-ended or timer-based group. | A timer-closed group has a nondeterministic boundary. Waiting for the animations first keeps one entry without inventing a new server action. |
| Rapid edits | Opt-in `coalesce: true`. When the same action changes the same cell set within 2 s of the top entry, with nothing recorded in between, the edits merge: first `before`, last `after`, last args. | This covers priority cycling and title edits that commit on every keystroke. |
| Org changes | **Not captured.** Org actions get `external: "org"`. The engine records a display-only history item that the timeline shows with "Open in org record"; ⌘Z skips it. | The org log is server-owned. Its batch ids are minted on the server and nothing on the client correlates them. Inverting local `orgTree` would fight the org log. |
| ⌘Z keys and text fields | `{ key: 'ctrl+z', mac: 'meta+z' }` and `{ key: 'ctrl+shift+z', mac: 'meta+shift+z' }`, plus `ctrl+y` for redo off mac, with **no `skipInputCheck`** and `noRepeat: true`. A secondary `ctrl+z` binding keeps ⌃Z working on mac. | Text fields keep their own undo. App undo fires when focus is not in an editable element. |
| Expiry | Blind ⌘Z and the toast reach entries up to 5 minutes old. The timeline can undo any older generic entry by an explicit click, because the guard makes that safe. Manual (closure) entries keep the 5 minute limit everywhere. | You see exactly what you take back in the timeline. You do not see it on a blind keypress. |
| Persistence | **In memory, per window.** Not persisted across reloads, not shared between windows. | Forward writes are already durable. A persisted record compared against a cache that hydrated stale adds failure modes nobody has asked for. The timeline header says "This window". |
| Toast targeting | The toast's Undo calls `undoEntry(id)`. If the entry is on top, that is a normal undo. If it is not, it is a selective undo of that one entry, guarded by the same rule. | Fixes B4. The guard is what makes out-of-order undo safe. |
| Conflict override | **None.** A conflicted row cannot be forced. | Overwriting someone's later change from a history list is the bug undo exists to prevent. |
| Server changes | **None in this version.** Every inverse reuses an existing side effect (`applyUndoPatches`, `updateTask`, `restoreArchivedDoc`, `restoreSession`, ...). | No Convex deploy gap. Compare-and-set in `applyUndoPatches` and new verbs (`addToStack`, soft deletes) are follow-ups (section 14). |

## 3. Engine API (`@platform/engine`)

The canonical source is `~/src/platform/packages/engine/src`. Codecast holds a generated mirror, refreshed only by `scripts/vendor-platform.sh`. Commit `platform/vendor-manifest.txt` together with the mirror.

### 3.1 Config (`types.ts`, beside `viewGuard`)

```ts
export type Invocation = { action: string; args: unknown[]; runDraft?: boolean }; // runDraft default true

export type CellChange = {
  store: string; id: string; field?: string;   // field undefined = whole row (collection add/remove, list row)
  before: unknown; after: unknown; hadBefore: boolean; hadAfter: boolean;
  kind: "protected" | "mirror" | "view";
};

export type UndoCtx = {
  action: string; args: unknown[];
  before: any; after: any;                     // whole states, read-only
  result: unknown;
  changes: readonly CellChange[];
};

export type UndoSpec = {
  label: (ctx: UndoCtx) => string | null;      // null = do not record this call
  inverse?: (ctx: UndoCtx) => Invocation[] | null; // overrides the store-derived server half
  ignoreFields?: readonly string[];            // e.g. updateDoc: ["content", "overflow"]
  restoreView?: boolean;                       // restore view fields if the view has not moved since
  toast?: boolean;                             // show the "<label> · Undo" toast on record
  coalesce?: boolean;
  external?: string;                           // display-only history item (org); never on the stack
};

export type UndoWriter = {
  fields?: (id: string, fields: Record<string, unknown>, row: any, state: any) => Invocation[];
  restoreRow?: (id: string, row: any, state: any) => Invocation[];
  removeRow?: (id: string, row: any, state: any) => Invocation[];
};

// PlatformConfig
undo?: {
  specs: Record<string, UndoSpec>;
  replayAction: string;                        // codecast: "applyUndoPatches"
  writers?: Record<string, UndoWriter>;        // store keys off the patch rail
  stampFields?: ReadonlySet<string>;           // "updated_at": restamped Date.now(), never compared
  serverAssignedFields?: ReadonlySet<string>;  // "created_at": the echo of an add carries the server's own value
  tombstone?: (store: string, row: unknown) => boolean; // a row the server keeps marked after a delete reads as gone to the guard
  ignoreKeys?: ReadonlySet<string>;            // never captured (clientState, tabs, pagination, ...)
  beforeReplay?: (entry: UndoEntry, dir: "undo" | "redo") => void;
  afterReplay?: (entry: UndoEntry, dir: "undo" | "redo", applied: readonly CellChange[], how: "replay" | "reinvoke") => void;
  restoreView?: (draft: any, field: string, value: unknown) => void;
  keyboardWindowMs?: number;                   // default 300_000
  stackLimit?: number;                         // default 100
  historyLimit?: number;                       // default 200
};
```

If `undo` is absent, nothing is captured, and the engine behaves exactly as it does today.

### 3.2 Pipeline refactor

The per-call body of `wrapAction` becomes one function:

```ts
runAction(key, flags, recipe: (draft) => unknown, args, opts?: { capture?: UndoSpec | false; replay?: ReplayCtx })
```

- `wrapAction` calls `runAction(key, flagsOf(val), d => val.apply(d, args), args, { capture: specs[key] })`.
- The outbox block becomes `enqueueDispatch(...)`.
- Undo replays call `runAction` with a synthetic recipe and the dispatch target.

A map of raw creators, kept by `buildWrapped`, lets a replay run a target action's draft by name. The wrapped function carries the same flag symbols as its raw creator, and a new export, `actionKind(fn): "action" | "asyncAction" | "receipt" | "sync" | null`, lets a guard enumerate the creators. The refactor must not change behaviour: the existing `middleware.test.ts` stays green before any capture code lands.

### 3.3 Capture

`enumerateTouchedCells(patches, shape, prev, next)` is extracted from `generateAutoPending`:

- **Collections.** Each patch is truncated to depth 3, giving a field cell. A depth-2 add or remove gives a row cell.
- **Lists.** A row-identity diff.
- **Singletons.** A field diff.

`generateAutoPending` and capture both use it.

Each cell is classified:

| Class | What it covers | How undo treats it |
|---|---|---|
| `protected` | The store key is local-first (`isProtectedSyncCollection`) and the field is not in `unprotectedFields`. | Conflict-checked. |
| `mirror` | Any other touched key (`docDetails`, `favorites`, `threadInbox`, `threadUnread`, `savedViews`). | Restored only if it still equals `after`. Never blocks. |
| `view` | `viewGuard.fields`. | Restored only when the spec has `restoreView` and the view still equals `after`. |

Never captured: `pending`, `ignoreKeys`, the spec's `ignoreFields`, and anything recorded while a replay or `withoutUndo` is running. The capture also records `planted`: the pending entries the forward call added or replaced, including ones the draft wrote by hand, such as the `threadInbox` exclude in `updateTask`.

Capture runs only for `action`, `asyncAction` and receipt actions, never for `sync()`. Its cost is O(patches). A call that changed no cell records nothing.

### 3.4 Entries and the history

```ts
export type UndoEntry = {
  id: string; label: string; ts: number;
  status: "done" | "undone" | "conflict" | "refused" | "dropped" | "external";
  undo: () => UndoOutcome | void; redo: () => UndoOutcome | void;       // closures, unchanged contract
  action?: string; args?: unknown[]; changes?: CellChange[]; planted?: Record<string, unknown>;
  children?: UndoEntry[];                                              // undoGroup
  outboxIds?: string[];
  objects?: Array<{ store: string; id: string }>;                     // protected rows, for the timeline
  skipped?: Array<{ store: string; id: string }>;                     // rows a partial undo left
  external?: string; droppedBy?: string; undoneAt?: number; redoneAt?: number;
  mode: "generic" | "manual";
};
export type UndoOutcome = { ok: true; applied: number; skipped: number } | { ok: false; reason: "conflict" | "gone" | "expired" };
```

`pushUndo(Omit<UndoEntry, "id" | "ts" | "status" | "mode">)` keeps working for hand-written entries (`mode: "manual"`).

**Stack exports**

- `performUndo()` / `performRedo()` (keyboard; honours the keyboard window)
- `undoEntry(id)` (toast)
- `undoTo(id)` / `redoTo(id)`: walk the stack one step at a time, stopping at the first conflict; one notifier call
- `getUndoHistory()`: a snapshot, the **same reference until something changes**
- `subscribeUndoHistory(fn)`
- `undoGroup(label | (entries) => string, fn)`
- `withoutUndo(fn)`
- `canUndo`, `canRedo`, `_resetUndoStacks`

`react.ts` adds `useUndoHistory()` on `useSyncExternalStore`.

**Snapshot shape**

```ts
type UndoHistorySnapshot = {
  version: number;
  items: readonly UndoHistoryItem[];
  head: string | null;
  undoOrder: readonly string[]; // undo stack ids, top first (the order undos take them)
  redoOrder: readonly string[]; // redo stack ids, top first
};
type UndoHistoryItem = Omit<UndoEntry, "undo" | "redo">;   // newest first
```

**Status rules**

- Pushing a new entry marks the redo stack's entries `dropped`, with `droppedBy` set. They stay visible but cannot be acted on.
- Expiry is not stored. The UI derives it from `ts` and `keyboardWindowMs`. A redo stamps `redoneAt`, and the keyboard window counts from the later of `ts` and `redoneAt`, so the next ⌘Z reaches an entry that was just redone however old its record. `ts` stays the time the change was first made.

**Notifier**

The notifier gains `onHistoryStep?(kind: "undo" | "redo", steps: number, entry)` and `notifyWithUndo(label, entryId)`.

### 3.5 Undo replay

1. **Guard.** Run the rule from section 2 over the protected cells, grouped by row. `stampFields` are never compared. On a field in `PlatformConfig.optionalClearFields`, null and absent are the same value, as they are to the lock layer's echo check: the server's echo of a clear leaves the field out. A row that is gone counts as a conflict, unless the cell is a row add, which counts as already undone. A row add whose row is still there is taken back only while every field the forward wrote still holds its value (stamps, `_` system fields and `serverAssignedFields` aside, so a bookmark's echo with the server's own `created_at` stays undoable); otherwise it is a conflict. A mirror cell that holds neither its after nor its before value is left alone and recorded as a mirror conflict; a mirror-only entry whose cells all conflict is a conflict. Inside a group, a child whose rows all already hold their before values counts as undone, not as changed since. If no row applies, mark the entry `conflict`, notify "Can't undo <label>: changed since", remove it from the stack, and stop. The next keypress continues with the older entries.
2. **Prepare.** Call `beforeReplay(entry, "undo")`. Codecast uses it to call `declareViewNav("undo")`.
3. **Plan the passes.**
   - If the spec has `inverse`, use its invocations. The first one carries the overlay for every applicable cell. After a partial guard, or when a mirror cell changed since, the inverse is asked again with the skipped rows' cells and the conflicting mirror cells taken out of `ctx.changes`, so an inverse must derive its invocations from the changed cells. Otherwise it would send a teammate's later change back to its prior value on the server while the local row keeps the teammate's value. If an invocation still names a skipped row, the undo is refused as a conflict: sending it would overwrite that row's later change on the server.
   - Otherwise, the cells on keys with a writer are grouped per row into that writer's invocations, each carrying its row's overlay. All other cells (patch rail and mirror) go into one `replayAction` pass with args `[]`.
4. **Run each pass** through `runAction(inv.action, flagsOf(target), recipe, inv.args, { replay })`. The recipe does three things in order:
   1. deletes the forward's `planted` pending entries that still match exactly (same type, value and ts), which fixes B1 and B2;
   2. runs the target's draft, if `runDraft` is set;
   3. writes each `before` value field by field. It deletes the field when `hadBefore` is false, re-adds or deletes whole rows for row cells, and restamps `stampFields`.

   `generateAutoPending` then plants fresh locks on the restored values (an include replaces a stale exclude at the same key), and the grouped patches carry the exact prior values. `applyUndoPatches([])` is safe on the server: the handler applies the grouped patches, and the side effect falls back to `{}`.
5. **Finish.** Call `afterReplay(entry, "undo", appliedCells, "replay")`. Move the entry to the redo stack, set `skipped` and `undoneAt`, and notify once.

### 3.6 Redo

1. Check that every captured cell (protected and mirror, applied or found already undone; stamps and view cells aside) still holds its before value, judging a cell the undo wrote by the value it wrote. Where a spec's `spell` turned an added row into field cells (the row is kept, as the server keeps it), those field cells stand in for the captured row cell. Re-invoking the action writes all of them, so one that does not is a conflict. After a partial undo only the applied protected cells are checked, and step 5 applies.
2. Call `beforeReplay(entry, "redo")`.
3. Call the wrapped original action with the original args, inside a capture that **refreshes this entry's** `changes`, `planted` and `outboxIds` instead of pushing a new entry.
4. For a group, redo the children in order.
5. After a partial undo (`skipped` is non-empty), step 3 would write the forward value over the rows the undo left. Instead the cells the undo applied get their `after` values back through the same guard, passes and `runAction` replay as an undo, with no planted deletion. An entry whose server half is a spec `inverse` has no such mirror, so its redo is refused as a conflict. A refused redo replay returns the entry to the redo stack. Like an undo, this replay tells sibling windows the exact values it wrote to bridged fields (`afterReplay` receives `how: "replay"`); a redo that re-runs the action (`how: "reinvoke"`) leaves that to the action, and a vetoed re-run drops every outside effect its body asked for (`afterCommit`).

### 3.7 Refusal, stubs, async

- **Refusal.** Every capture stores its outbox id. When `releaseRefusedLocks` or `applyReceiptRejection` rolls an action back, the engine marks the entry that names that outbox id `refused` and removes it from both stacks. If an undo's own dispatch is refused, its locks roll back through the same path, and the entry returns to the undo stack.
- **Stub ids.** Wherever `rekeyExtra` and `rekeyPending` run (`syncEngine.ts` ~214), the engine also rewrites `id` in live entries' cells and objects, and any field value that names the stub. Codecast's own syncTable and `resolveSessionId` rekey through `rekeyId`, which calls `rekeyUndoIds`. A coalesced entry's run (the origin cells and each merged call's cells and args, kept beside the entry) is rekeyed with it, so a call under the server id merges into the same cells and a refusal rebuilds the entry under the server id.
- **Thin conversation rows** (`store/undo/thinConversation.ts`). A session never opened in this window has no `conversations` row, and an action that writes one (`toggleFavorite`, `patchConversation`, `switchProject`, `setPrivacy`, `setTeamVisibility`) creates a thin `{_id}` row to carry the write. The capture sees a whole-row add. No undoable action mints a conversation, so that row always stands for a server row: `UNDO_SPECS` (`store/undo/policy.ts`) wraps every spec's `spell` with `keepConversationRows`, which turns the add into one cell per field the action wrote and keeps the row. Deleting the row would plant a `conversations:<id>` exclude that nothing retires, so the conversation's meta could never sync in again, and it would discard meta that loaded between the gesture and its undo. The thin row says nothing about what a field held before; the inbox row does. `sessions` and `conversations` are two copies of one server row and the undo's patch merges their cells into one field, so each field cell takes the prior value of the `sessions` cell for the same row and field (unfavorite a favorited row, undo, and the server gets `is_favorite: true`, not a clear). A field the inbox row did not change is dropped. A field cell with no prior value on a row that already exists (a stub an earlier write left) takes the inbox row's prior value the same way. `toggleFavorite` adds its own `spell`: a row can be a favorite by the favorites list alone, so an `is_favorite` cell that went to false from nothing is restored to true. **A gesture whose prior values nothing knows is not recorded:** the same wrapper returns a null label when a conversations cell has no prior value, the row was never delivered by the server (no `_creationTime`), and there is no inbox row for it. That is the `/sessions` page acting on a row this window holds in neither store; an undo there could only send a clear, so taking back an unpin would unpin again. **The inbox row is the truth on a loaded row too.** The meta can lag: the server leaves a cleared stamp out of the meta and `syncRecord` merges field by field, so after a restore elsewhere the conversations copy kept the old `inbox_dismissed_at` while the inbox row showed it clear. A snooze writes the clear on both copies, only the stale one changed, and its undo sent the stale stamp to the server, which killed the session. So wherever the `sessions` row existed before the gesture, every conversations field cell takes the prior value of its `sessions` twin cell, and a cell with no twin whose written value the inbox row already showed is dropped. The meta feeder (`useConversationMessages`) also spells each inbox stamp the server left out of the whole doc as a clear (`withClearedInboxStamps`, `store/syncProtocol.ts`). Test: `undoThinConversation.test.ts`. The inverses of `switchProject`, `setPrivacy` and `setTeamVisibility` set the field back on the server instead of clearing it, so on a row whose meta is loaded without the field, a lock for an absent value would never meet its echo and would strip the field from the meta when it syncs. Their `spell` (`spellThinConversation`, `policies/work.ts`) uses the same `sessions` prior and drops the cell where the inbox row did not change. Test: `undoWorkInverses.test.ts`.
- **Offline.** Outbox rows replay in `ts` order (`nextOutboxTimestamp`), so a forward write and its undo arrive in causal order.
- **Order within a walk.** Two ⌘Z presses, `undoTo`, `redoTo` and a group step several entries that can write the same cell, and a live send that failed once retries after later sends went out. So the controller keeps, per cell (row id and field, or the whole row), the last send that wrote it: a forward capture, an undo replay pass or a redo. Every replay or re-invoke is ordered (`runAction`'s `after`) behind the entry's own sends and the last send of every cell it writes; a whole-row cell follows every field of its row. A send that is itself still held behind others counts as unsent, so a follower waits for it too and the order holds down the chain. Sends on other fields of the same row are not followed: a follower marks a first-attempt send it follows as overtaken, and that send is not retried. Test: "a walk of several steps reaches the server in order" in `undo.test.ts`.
- **Outbox ownership** (`outboxOwner.ts`). The outbox is one IndexedDB table per origin, and every window drains all of it (at boot, on `online`, on becoming visible, every 30 s). A window's guards against re-sending (in flight, already acknowledged) live in its own memory. So a sibling window could re-send rows another window had already delivered but not yet deleted. Under a slow IndexedDB (a read of the table took over 60 s during verification), that re-send landed after the undo and put the forward value back on the server: a task's status and assignee were undone at 8:36:55 and re-applied at 8:37:07. Each row now carries its window's `owner` id. Each window holds a Web Lock named for that id for its lifetime, and a drain skips rows whose owner is another window still holding its lock. A closed, reloaded or crashed window releases the lock, so its rows replay as before. Without Web Locks (React Native, tests) nothing changes. One gap remains, in section 14: a reloaded window's rows that were delivered but not yet deleted still replay once.

## 4. Codecast binding

**Config** (`packages/web/store/mutativeMiddleware.ts`, `CODECAST_PLATFORM_CONFIG`):

- `undo.specs = UNDO_SPECS`, built from `store/undo/policy.ts`.
- `replayAction: "applyUndoPatches"`.
- `writers = UNDO_WRITERS` (`store/undo/writers.ts`).
- `stampFields: {"updated_at"}`.
- `serverAssignedFields: {"created_at"}`.
- `ignoreKeys`: `pending`, `syncMeta`, `clientState`, `tabs`, `activeTabId`, `pagination`, `drafts`, `recentVisits`, `collapsedSections`, liveness and feed keys. The binding package writes the full list from `REPLICATION_CLASSIFICATION` "local" keys plus server-fed projections.
- `beforeReplay: () => declareViewNav("undo")`.
- `restoreView: (draft, field, value)`, which calls `recordCurrentConversationPointer` and `syncActiveInboxTabPath` for `currentSessionId`.
- `tombstone`: a `docs` or `docDetails` row with `archived_at` set. `archiveDoc` deletes the row here, but the server keeps it marked and the sync log delivers it that way once the archive's exclude retires, so the guard must read that row as still archived, not as already undone.
- `afterReplay`: for each applied `sessions`/`conversations` cell whose field is in `BRIDGED_FIELDS`, send one `broadcastGesture({kind: "fields", id, fields, exact: true, ts}, bridgeUserId(state))` per id with one `ts`. The `ts` is taken in `beforeReplay`, before the replay dispatches, because a sibling's bridged acknowledgement skips a lock newer than the send it acknowledges. `exact` says the fields are exactly the values the replay dispatched, so the receiver locks only those and plants no barrier locks on coupled fields that no acknowledgement covers. This replaces the hand bridge calls in `undoActions.ts`. It sends exact values, never a pin toggle. Whole rows the undo put back (a stash or kill that forgot a teammate's row or a stub) go first as one `{kind: "unforget", rows}`: a sibling lifts the excludes its forget planted (unless a newer one stands), puts the row back and holds it under an include lock. The sync host does the same for a follower's mut that re-adds a whole row (`MutUpdate.readds`), since its delta merge skips excluded ids.

**Policy files**, one owner each:

| File | Owner | Holds |
|---|---|---|
| `store/undo/policy.ts` | binding | Aggregates the files below; exports `UNDO_SPECS` and `UNDO_POLICY: Record<string, { spec: UndoSpec } \| { never: string }>`. |
| `store/undo/policies/sessions.ts` | session coverage | Sessions, inbox, buckets, favorites, decisions. |
| `store/undo/policies/work.ts` | work coverage | Tasks, plans, projects, initiatives, docs, comments, stacks, bookmarks, saved views, triggers, chat, privacy, org (`external`). |
| `store/undo/policies/never.ts` | binding | Navigation, layout, sends, creates, settings, read state, each with a reason. |

**Guard tests:**

- `undoPolicy.guard.test.ts`: every creator reported by `actionKind` on `useInboxStore.getState()` (excluding `sync`) appears in exactly one policy file.
- `undoWriters.guard.test.ts`: every local-first registry key without a `dispatchTable` has a writer in `UNDO_WRITERS`, or is listed in `LOCAL_ONLY_UNDO_KEYS` with a reason. An undoable spec whose action touches such a key without a writer or an `inverse` fails.

**Recording only gestures.** Programmatic callers of an undoable action (effects, sync hooks, automation) wrap the call in `withoutUndo`. The session and work coverage packages each audit the callers of the actions they classify.

**Toasts** (`store/undoStack.ts`):

- `notifyWithUndo(label, entryId)` wires the Undo button to `undoEntry(entryId)`. Each recorded toast has its own id (`undo-<entryId>`). Once its entry leaves the undo stack, by any route (the toast, the keyboard, the timeline's multi-step "Back to here", a conflict), a `subscribeUndoHistory` listener dismisses it, so no Undo button outlives its entry.
- Undo and redo announcements reuse one sonner id (`"undo-status"`), so chained undos update one toast in place. sonner merges an update into the toast it replaces, so every announcement passes `action` explicitly, `undefined` included. Otherwise a "Redid" would keep the "History" button of the "Undid" before it.
- Copy: "Undid: <label>"; a partial step reads "Undid: <label> (2 of 3; 1 changed since)", counting the protected rows (`objects`) and the rows left (`skipped`); a redo after a partial undo says the same. A conflict comes from the engine: "Can't undo <label>: changed since".
- When the timeline tier is `hidden` and the history holds more than the step just announced, the "Undid" toast carries a quiet `History` action that opens the timeline. A redo never offers it. `UNDO_HISTORY_TIER` lives in `lib/undoTimelineOpen.ts` (re-exported from `lib/undoHistory.ts`), so the notifier can read it without pulling the row model into the store's imports.
- While the timeline is open, the notifier stays silent. Opening the card also dismisses the toasts already showing in its corner: the status toast (the held peek opens 350 ms after the first ⌘Z, whose toast would otherwise sit on top of the card) and every recorded entry's Undo toast (the card lists those entries with their own way back, and the toast covered its lower rows).
- Dismissal is never gated on `toast.getToasts()`. A plain `toast()` never clears its id from sonner's dismissed set, so after its first dismissal the reused status id drops out of that list for good, even while it is on screen.

## 5. Coverage

**Route** says how the undo reaches the server:

- **patch**: `applyUndoPatches` pass
- **writer**: the collection's writer
- **inverse**: a spec override
- **never**
- **external**: the org record

| Action (inboxStore.ts unless named) | Route | Notes and label |
|---|---|---|
| `deferSession`, `setSessionRest`, `pinSession`, `snoozeSession`, `wakeSnoozedSession`, `renameSession`, `setSessionCharacter(s)`, `patchConversation`, `toggleFavorite` | patch | The cleared snooze, `title_is_custom` and the `favorites` mirror are captured automatically. "Deferred “{title}”", "Filed “{title}” as Done", "Pinned/Unpinned “{title}”", "Renamed “{old}” to “{new}”" |
| `stashSession`, `killSession`, `killSessions` | inverse: one `{action: "restoreSession", args: [id], runDraft: false}` per hidden id, read from `ctx.changes` (not the args) so a partial undo sends none for a skipped row. The first carries the overlay. A kill's spell adds an `inbox_killed_at: null` cell on each store copy of a row it retired that was not killed before: the server's kill stamps that marker, the kill's draft never wrote it, and `shouldShowInInbox` hides the row on it alone, so without the local clear an undo after the echo shows nothing until the server's un-kill returns. The cell rides the first `restoreSession` pass beside the row's `inbox_dismissed_at` clear, the un-kill shape the dispatch guard honours, so the server acknowledges it and the acknowledgement retires its locks even when a redo or a fresh kill reaches the server before any null echo. A clear sent on its own is stripped by that guard and its locks never retire. A kill also drops any lock still holding a clear of the marker on the rows it hides, and a sibling's replicated clear older than the stamp a row holds is ignored (only the server writes the marker). | Owners land through the patches; non-owners land through the `inbox_hides` unhide (B6). `restoreView: true`, `toast: true`. Kill label: "Killed “{title}” (agent stays stopped on undo)". Verify that `unhideConversationForViewer` is a no-op for owners. |
| `restoreSession` | patch | "Restored “{title}”" |
| `updateSessionProject`, `setConversationModel/Agent/AgentDefinition` | never | The switch is applied to the live agent or its daemon (a `/model` message, `switchSessionAgent`, `reconfigureSession`), and `agent_type` is not editable on the patch rail, so a field restore would leave the row disagreeing with the running session. A command inverse that re-runs the real switch is a follow-up. |
| `updateBucket` | patch | `inbox_buckets` rail |
| `assignSessionToBucket` | writer (`bucketAssignments` → `assignSessionToBucket(conv, prevBucket \| null)`) | "Labeled “{title}” {bucket}". The server never deletes an assignment row (an unfile keeps it with `bucket_id` unset and the next filing reuses it), so the undo of a filing that created the row keeps the row and clears `bucket_id`: the spec's `spell` turns the row-add cell into a `bucket_id` cell. Removing the row would exclude the server row's id, and this delta collection would skip every later push of it. |
| `switchProject` | inverse: `switchProject(id, prevPath)` | |
| `setPrivacy`, `setTeamVisibility` | inverse with the prior value | Immutable on the patch rail. Undo that widens access is offered only from the toast or the timeline, never from blind ⌘Z (spec flag `confirm`, a function asked when the entry is recorded: it is true only when the prior audience is wider than the new one or cannot be ordered against it, so taking back an accidental share is an ordinary ⌘Z; `performUndo` stops at a confirm entry with a notice and undoes nothing, so an older change is never taken back in its place). Not recorded when the prior audience cannot be restored: the prior `is_private` is unknown on both store copies, or the row was shared with no `team_id`. Returning to "shared" runs the server's `buildShareUpdate`, which assigns a team to a conversation that has none, and no verb takes a team away. |
| `toggleBookmark` | inverse: the same toggle | The guard ensures membership is still `after`. |
| `updateTask`, `updateTaskStatus` | writer: `updateTask(short_id, wire)`; `updateTask`, `updatePlan` and `updateProject` coalesce, and `description` is never captured (DocEditor owns its text undo, as for the doc body) | Wire: `parent_id` → `parent` (short id or `""`); a cleared `assignee`, `project_id`, `status_id`, `execution_status` or `parent` → `""`; drop `updated_at`, `closed_at` and `attempt_count`. A cascade close yields one invocation per child. The undo cannot recall assignment notifications. |
| `updatePlan`, `updateProject`, `updateInitiative`, `set/add/removeInitiativeProject` | writer | Already in server shape (`writeAsServerShape`). An initiative gesture that widens its owner role's scope (naming a role owner, or adding a project under one) is not recorded: the server widens the scope in the same transaction and logs it in the org record, and no initiative verb takes it back. With the org tree loaded, the `orgTree`/`orgIntents` cells the draft paints say whether the scope grew; without it, any such write is taken to have grown it. |
| `updateDoc` | writer: `updateDoc(id, {title, doc_type, labels})` | `ignoreFields: ["content", "overflow"]`. The label is null when nothing else changed, because the editor owns text undo. |
| `pinDoc`, `moveDoc` | writer: `pinDoc(id, pinned)`, `moveDoc(id, parent_id, sort_order)` | The docs writer splits by field group. Every doc spec records only when a `docs` cell changed: a doc held only in `docDetails` (opened by link before the list lands, or from another workspace) has no writer row, so its undo would restore the detail copy and send the server nothing. |
| `archiveDoc` | writer `restoreRow` → `restoreArchivedDoc(id)` (draft no-op); the overlay re-adds `docs` and `docDetails` | `toast: true`. Fixes B1. |
| `updateSavedView` | inverse: `updateSavedView(id, priorFields)` (`savedViews` is a mirror, not local-first) | Not recorded when a changed field had no prior value: `savedViews.webUpdate` cannot unset a field. |
| `resolveCommentThread`, `editComment` | inverse with the prior value | |
| `reorderStack`, `setStackPolicy` | inverse with the prior order or policy | |
| `triggerAction` pause/resume, `setTriggerInterval`, `editTrigger` (the triggers page form) | inverse with the opposite verb, prior interval, or prior prompt, title and schedule | Run now, cancel and reactivate: never. |
| chat `updateChatChannel`, `archiveChatChannel`, member add/remove, `dispatchChatEdit` | inverse | Re-adding a member notifies them. |
| Org verbs (`orgSlice.ts`) | external | A display-only timeline item: "Open in org record". |
| Sends, creates, deletes (`sendMessage`, `createTask/Doc/Plan/Session`, `deleteSession`, `deleteComment`, `deleteSavedView`, `removeFromStack`, `answerDecision`), share links, membership visibility, read state, machines, settings, navigation and layout | never | Each with a reason in `never.ts`. |

**Folding the ad-hoc "Undo" toasts:**

- `TriggerRow.tsx` and `LabelChipsRow.tsx` move onto the generic path in the work and session coverage packages.
- `ThreadStatePanel.tsx`, `settings/sync/page.tsx` and `useChatToasts.tsx` stay local, and each gets a one-line comment saying why.

## 6. Migrating `undoActions.ts`

**Deleted**

- `snapshotSession`, `undoableHideSession`
- `undoableFieldGesture` and the `*_FIELDS` lists
- `undoableDeferSession`, `undoableSetSessionRest`, `undoablePinSession`, `undoableRenameSession`, `undoableArchiveDoc`

Call sites call the store actions directly. The action itself is now undoable, so every surface gets undo (B8).

**Kept**

- `animateSessionEnter`, `animateSessionExit`, `animatedHideSession` (which now calls `stashSession`/`killSession` after `askRetireInstead`), `USER_REST_LABEL`.
- `animatedSetSessionRest` and `fileSessionsAsRest`. They run every exit animation, wait for all of them (`Promise.all`, each capped by the existing 250 ms fallback), then call `undoGroup(n > 1 ? "Filed {n} sessions as {rest}" : ..., () => ids.forEach(id => setSessionRest(id, rest)))` and `animateSessionEnter` for each id. The `toast.success` becomes the spec's undo toast.
- The client creator `applyUndoPatches` stays a no-op, so outbox rows from older bundles still deliver. `restoreArchivedDoc` stays a no-op.

**Undo enter animation**

The session coverage package adds an `afterReplay` extension point: `store/undo/onRevert.ts` exports a registry of per-store callbacks. Codecast's `afterReplay` calls `animateSessionEnter(id)` for a session row whose hide fields went from set to clear. The animation then plays for every un-hide undo.

## 7. Keyboard and focus rules

- **Bindings** (`shortcuts/registry.ts`):
  - `ui.undo`: `{key: 'ctrl+z', mac: 'meta+z', noRepeat: true}`, plus a mac-only secondary `ctrl+z`.
  - `ui.redo`: `{key: 'ctrl+shift+z', mac: 'meta+shift+z', noRepeat: true}` and `{key: 'ctrl+y'}`.
  - `ui.undoHistory`: `{key: 'ctrl+alt+z', mac: 'meta+alt+z'}`, plus `{key: 'meta+alt+z', mac: 'meta+alt+z', skipInputCheck: true}`.
  - `ui.undo` and `ui.redo` use `skipInputCheck: 'whenEmpty'`. ⌘⌥Z has no meaning in a text field, so on mac the history chord opens from one, the autofocused composer included (the second row). Off mac Ctrl+Alt is AltGr, and AltGr+Z types a letter on some layouts (Polish ż), so Ctrl+Alt+Z never fires from a field there.
- **Text fields keep native undo.** Inputs, textareas and contenteditable editors (TipTap, CodeMirror) do their own undo while they hold text. An empty field hands ⌘Z and ⌘⇧Z to app undo, because the triage chords fire from an empty composer and the defer and dormant advances move focus into the next one; without this the entry a chord just recorded is unreachable by keyboard there. `useUndoWalk` still declines a press from an empty field that was edited after the entry the press would reach (recorded, for undo; taken back, for redo), so clearing a draft and pressing ⌘Z brings the draft back through the browser. The field keeps the press only while the browser has something to take back: once it has nothing, the press is app undo and the field's edit time is dropped, so later presses go straight to the app. Chromium (the browser and the desktop app) says so synchronously through `document.queryCommandEnabled`; in the desktop app this must be synchronous, because a declined key reaches the native undo through the main process, later than any timer. Elsewhere a native undo always fires an `input`, so a declined press that produced none by the next task runs the app step. Edits are timed per element by a capture `input` listener; the rules are `fieldOwnsStep` and `createFieldUndoGuard` in `lib/undoWalk.ts`. A rich editor (TipTap over ProseMirror: the composer in rich mode, DocEditor, CollabDocEditor) edits its DOM itself, so select-all+Backspace and its own undo fire no `input`. Such a field (`richEditorOf`: the `.editor` TipTap hangs on its contenteditable) is timed from the editor's `update` instead, counted only while a user key, paste, cut or drop on it is in flight (a seeded draft or a collaborator's edit is no edit of the user's), and the guard asks the editor's own history (`can().undo()`) whether it has a step left.
- **Modals.** An open modal (`hasOpenModal`) blocks app undo, as today. The timeline card must not set `aria-modal`, so stepping with ⌘Z works while it is open.
- **`noRepeat`** (new in `@platform/keys`): a repeated keydown for such a def is swallowed (`preventDefault`, no handler call). Holding ⌘Z is one undo (B7).
- **Electron** (`packages/electron/editUndo.js`). Verified in a from-source desktop instance (Electron 44.3, its own profile), with real key events delivered through the app's event queue and a keydown probe in the page. With the stock `{ role: "undo" }` item, ⌘Z never reached the page's keydown when focus was outside a text field, while ⌘J (no menu item) did. So app undo was unreachable by keyboard in the desktop app. The Edit menu's Undo and Redo are now plain items with the same accelerators (`CmdOrCtrl+Z`, `Shift+CmdOrCtrl+Z`), and they behave differently: the page now sees ⌘Z first, and the item's click runs only when the page leaves the key unhandled. A ⌘Z the app handles is consumed there. One the page leaves (focus in a field, or nothing to undo) reaches the click, which probes the focused element. In a field (input, textarea, contenteditable, iframe) it calls `webContents.undo()` / `redo()`, and one press took back exactly one typing step. Anywhere else it sends `app-edit-command`, which the preload exposes as `onAppEditCommand` and `useUndoWalk` runs as a step (blocked while a modal is open). A page that is not one of ours (a browser pane) always gets the native command. Holding ⌘Z repeats the key equivalent, so `before-input-event` (emitted before menu shortcuts) records whether the last ⌘Z/⌘Y keydown was an auto-repeat, and a repeat sends no second app undo. A press that undoes nothing does not count as a step, so a declined key that comes back through the menu never counts twice.
- **Palette.** Undo and Redo use the `Undo2` and `Redo2` icons, not `RefreshCw`.

## 8. Timeline UI

**Data**

- `useUndoHistory()` reads the engine snapshot.
- `lib/undoHistory.ts` holds `UNDO_HISTORY_TIER: "hidden" | "visible" = "hidden"`, a pure row model `undoTimelineRows(snapshot, state, now)` (states, the head index, the dropped marker, "back N" counts, expiry derived from `now`), `describeUndoObject(state, store, id)` (a live title and pill per object, mapped onto the `RecentVisit` shape so `resolveVisit`, extracted from `lib/recentVisits.ts`, and `useOpenRecentVisit` do the resolving and opening), and `undoHistoryFixture(now)`.
- `lib/undoTimelineOpen.ts` is a tiny external store: `open`, `close`, `toggle`, `isOpen`, `subscribe`, and `mode: "peek" | "interactive"`.

**Placement and look**

- A fixed card at the bottom right (`right-4 bottom-4`), the toast corner, so a toast appears to grow into it.
- Width `min(380px, 100vw - 24px)`; height about six rows as a peek, `max-h-[min(560px,70vh)]` when interactive.
- The overlay look of `RecentSwitcher` (`bg-sol-bg/95 backdrop-blur-xl border-sol-border/60 shadow-2xl`).
- `<UndoTimelineHost />` mounts beside `<RecentSwitcherHost />` in `DashboardLayout.tsx` and renders null when closed.
- `role="dialog" aria-label="Undo history"`, without `aria-modal`.

**Header**

- A `History` icon in `text-sol-cyan`, the title "Undo history" on one line, and Esc close in `<KeyCap>` on its right (shown in the empty state too). The stepping keys (`ui.undo`, `ui.redo` from `MenuKeyCaps`) sit in the footer legend beside the list they move, as one "step" hint.
- A dim subline: "This window · ⌘Z reaches the last 5 minutes".

**Rail**

- The rail chrome (hairline, dots, fold) is extracted from `OrgHistoryView.tsx` into `components/history/HistoryRail.tsx`. Both the org record and the undo timeline render through it, and `OrgHistory.mount.test.tsx` must pass unchanged.
- Newest is at the top. A 1 px `--sol-cyan` "now" rule sits between undone rows (above) and done rows (below). It slides 160 ms ease-out when the head moves, and jumps under reduced motion.

**Rows** (two lines, laid out like `RecentVisitRow`)

- **Dot.** The object's glyph for done rows, `Redo2` dim for undone rows, `Network` for org rows, a `--sol-yellow` ring for conflict rows.
- **Line 1.** The captured label, whole, with a tooltip when cut. Relative time on the right in `tabular-nums` (`visitTimeAgo`).
- **Line 2** (11 px, dim), by state:
  - done: where it happened. That starts with the object's live title as a quiet link that opens it, unless the label already names it (`undoLabelNamesTitle`, which also matches a title the label cut at 40 characters) or the object is gone. Then come the facts the label does not already say (the short id is dropped). The facts keep their room and the title gives way. In the last minute of the keyboard window this reads "can undo for 40s more" (time-driven through `useNowWhen`). A group shows no single place: its fold sits on line 2;
  - undone: "undone 1m ago";
  - partial: "2 rows changed since, left as they are";
  - conflict: "changed since, can't be taken back";
  - refused: "the server refused this change";
  - org: "org change · opens the org record".
- **Groups** fold ("5 sessions") using the existing fold pattern.
- **Dropped redo branches** collapse into one line under the entry that caused them: "2 undone steps set aside when you <label>". They are struck and inert.
- **Affordance.** On hover or selection (hover only in a peek, which takes no keys), one button: "Back to here" (with a count, "Back 3") below the head, or "Forward to here" above it. These are `undoTo` / `redoTo`, which stop at the first conflict with a toast. Org rows show "Open in org record" instead. A dim "Start · before these changes" row ends the list.

**Keyboard (interactive mode)**

| Keys | Action |
|---|---|
| ↑ / ↓ | Move the selection |
| Enter | Go to the selected row |
| ⌘Z / ⌘⇧Z | Step; the selection follows the head |
| → / Space | Fold or unfold |
| O | Open the row's object |
| Home / End | Jump to the top or the bottom |
| Esc | Close; focus returns where it was (the page body included) |

The footer legend uses KeyCaps. The list is cmdk, like `RecentsPanel`, with no search field.

**The card owns its keys outright.** While it holds focus it claims every plain key and its own chords through `claimKeys` (`@platform/keys`, re-exported from `shortcuts/keyOwnership.ts`). A claim runs in the app's first key listener, the capture-phase window listener installed when `@platform/keys` loads, so a claimed key stops before the shortcut dispatcher, before every page listener (window or document, capture or bubble, `useEventListener` included) and before any React handler. No page needs a check of its own for the card, and a page added later inherits this. Tab and the chords the card does not take pass on. The card therefore moves its own selection on ↑ / ↓ instead of leaving them to cmdk. `UndoTimelineView.mount.test.tsx` proves it against listeners in every phase, and `keyOwnership.guard.test.ts` fails if the card handles a key in React again.

**Empty state.** "Nothing to take back yet. Changes you make in this window collect here, newest first, each with a way back."

**Narrow screens.** Below 480 px the card spans the full width at the bottom.

## 9. Discoverability gate

`UNDO_HISTORY_TIER = "hidden"`. With the tier hidden there is no header button and no Settings row, but five doorways are live, and none adds chrome:

1. **Palette row** "Undo history" (`ui.undoHistory`, keywords "undo redo history timeline changes revert"). Found by search, not by browsing.
2. **The chord** ⌘⌥Z / Ctrl+Alt+Z, listed automatically in the `?` panel's Global section.
3. **The "Undid" toast.** Its quiet `History` action appears only after an undo, when there is more history to show.
4. **The held-modifier peek.** After ⌘Z, keep the modifier held for 350 ms and the card peeks open, narrating each further undo (Z) or redo (Shift+Z). A second step inside the 350 ms opens it at once. H pins it interactive. Releasing fades it after 600 ms, unless the pointer is over it, or reaches it during the fade; either pins it. Any other key closes it and passes through. The logic is a pure reducer, `lib/undoWalk.ts` (`walk`, plus `walkView` for what the card shows and `walkTimer` for the one timer a state runs), fed by `hooks/useUndoWalk.ts`. The hook owns the `ui.undo` / `ui.redo` handlers and is mounted from `useGlobalShortcutActions`. Each press commits first, and only a press that took something back reaches the walk. The modifier is Meta on mac and Control elsewhere, tracked with window key listeners the way `useRecentSwitcher` tracks Control; a window blur counts as a release. The walk drives only a card it opened itself: a card opened from the palette, the chord or a toast is left as it is. In a browser on mac, ⌘H belongs to the OS (it hides the app), so H pins when pressed during the fade; off mac, Ctrl+H works while held. The walk's keys go through the shortcut dispatcher, which runs in the capture phase and stops every key it handles: H is the `undoWalk.pin` binding, live only in the `undoWalk` context the hook holds while the card peeks or fades and listed above `conv.toggleThinking`, and a key another shortcut handles ends the walk through `subscribeShortcutUsed` (`shortcuts/ShortcutProvider.tsx`), since it never reaches a window listener. A press counts as a step only when the top of the other stack changed, so a conflict or a confirm notice neither arms the peek nor counts toward the milestone.
5. **A milestone tip**, `m-undo-history`, fired by `checkMilestone` on the second undo within 10 s. It honours tips-off. `showMilestoneTip` gains a `<MenuKeyCaps action={tip.shortcutAction} />` description, so no key name is written as plain text.

**When the tier flips to `visible`,** add an `Undo2` header button beside `RecentlyViewedMenu` (shown only while something can be undone, with `ShortcutTooltip`), and an Interface toggle `undo_history_peek` for the held peek.

## 10. Grouping summary

- **`undoGroup`.** Captures inside it fold into one entry with `children`. Nested groups flatten into the outer one. The label is resolved when the group closes, so it can count rows.
- **Undo of a group.** Run the guard over every child first. Rows that conflict are skipped, as in a single entry. Then undo the children in reverse order.
- **Redo of a group.** Run the children forward.
- **Wrapped call sites.** The palette's multi-select loops (`CommandPalette.tsx` per-session verbs ~2281, snooze ~840, task fields and labels ~1035 and ~1063, doc archive ~2250), `ObjectContextMenus.tsx` multi-row verbs, `LabelChipsRow.tsx` reorder, and `fileSessionsAsRest`.
- **Existing bulk actions** (`killSessions`, `setSessionCharacters`) are already one entry each.

## 11. Test plan

**Engine** (`cd ~/src/platform/packages/engine && bun test`)

`src/undo.test.ts`, using the `middleware.test.ts` `CONFIG` fixture plus an `undo` config:

- capture
  - depth-3 cells, row add and remove, list rows by `rowKey`, singleton fields
  - mirror and view classification; `ignoreKeys` and `ignoreFields`
  - no entry for a no-op call or a null label; `withoutUndo` and `sync()` never record
- replay mechanics
  - patch replay restores locally, plants locks, deletes planted pending entries, and dispatches `replayAction` with grouped patches equal to the prior values (null tombstones for cleared fields)
  - a writer invocation runs the target draft plus the overlay and dispatches the target name and args
  - `runDraft: false`
  - `stampFields` are restamped and never compared
- conflicts and partial undo
  - conflict: a sync changes one cell of a two-cell row, so that row is untouched
  - partial across rows reports applied and skipped counts
  - an all-conflict entry stops the press and is removed
- redo and groups
  - redo re-invokes the action and refreshes the cells; a toggle redo lands on the original value
  - `undoGroup`: one entry; undo in reverse; redo forward
  - coalesce within 2 s
- refusal and rekey
  - a refused forward dispatch removes its entry
  - a rekey rewrites ids
- pipeline
  - the replay calls the tee and IDB write hooks
  - with no `undo` config there is no capture, and the existing tests stay green

`src/undoStack.test.ts`:

- the snapshot reference stays stable until a change
- `undoTo` / `redoTo` counts and the single notification
- the dropped branch on push
- the keyboard window
- `undoEntry` on a non-top entry
- `_resetUndoStacks`

Keys: `keys/src/dispatch.test.ts` covers `noRepeat`.

**Codecast** (`bun test <file>`; `cast check web`)

Ports, with the same assertions:

- `store/__tests__/undoFieldGesture.test.ts`: call `deferSession` / `setSessionRest` / `pinSession`, then `performUndo()`. The snooze comes back. Add a sync step after the undo: a push still carrying the forward value, then the null echo. No lock may be left (B2).
- `store/__tests__/undoHideSession.test.ts`: kill a row that was stashed, undo, and it is Stashed again. A push carrying the hide does not re-hide it. The undo dispatches `restoreSession` per id with the restored stamps (B6).
- `store/__tests__/gestureBridge.test.ts`: undo of a pin broadcasts `{kind: "fields"}` with the original `inbox_pinned_at`, never a pin toggle.

New:

- `undoPolicy.guard.test.ts` and `undoWriters.guard.test.ts`.
- `undoArchiveDoc.test.ts`: archive, undo, then `syncTable("docs", [row])` keeps the doc; no exclude is left (B1).
- `undoWriters.contract.test.ts`, generated over `UNDO_WRITERS`. For each writer field: forward, a stale push, undo, a stale push, the echo of the prior value. The row equals the prior value at every step, and no locks or excludes are left at the end. The outbox carries the writer's action and wire args.
- `undoGroup.test.ts`: `fileSessionsAsRest` over three rows is one entry and one undo.
- `undoToast.test.ts`: the toast undoes its own entry (B4).
- `shortcuts/registry.test.ts`: `meta+z` resolves to `ui.undo` on mac; `ui.undo` does not bypass the input guard; `noRepeat` is set.
- `store/__tests__/inboxMultiWindowSim.test.ts`: a follower undoes its own stash; the host converges through the mut; IDB holds the restored row (B3).

Timeline:

- `lib/__tests__/undoHistory.test.ts`: row model, head placement, dropped marker, expiry crossing, partial and conflict rows.
- `lib/__tests__/undoWalk.test.ts`: peek delay, Z, Shift+Z, H, release, release while hovered, another key cancels.
- `components/undo/UndoTimelineView.mount.test.tsx`: each state; Enter calls `undoTo` / `redoTo` with the right id; org rows open the org record; empty state.
- `components/org/history/OrgHistory.mount.test.tsx` passes unchanged.

## 12. Verification plan (browser)

Run on the dev server at http://localhost:3200 with `cast browser`. Use this session's tab, plus `--new-tab` for the second window.

1. **Two windows.** Open the inbox in tab A and tab B. In A, stash a session; B shows it gone. Press ⌘Z in A (`cast browser press "Meta+z"` with focus on the page). Both tabs show the row back. Reload A; the row stays.
2. **Defer, pin, snooze.** Defer a snoozed session, undo, and wait at least one sync push (30 s or a heartbeat). The snooze and position hold.
3. **Bulk filing.** Multi-select three sessions and file them as Done. The timeline shows one entry, and one ⌘Z restores all three.
4. **Tasks.** Change a task's status and assignee, then undo. Reload: the server holds the prior values.
5. **Docs.** Archive a doc from the doc page, click the toast's Undo, wait for a push, then reload. The doc is still there (B1).
6. **Conflict.** Change a task title in A. Change the same title in B. Press ⌘Z in A. A toast says "changed since", and the title stays at B's value.
7. **Text fields.** Type in the composer and press ⌘Z: the text is undone and no app entry is. Hold ⌘Z: exactly one app undo.
8. **Timeline.** Open it from the palette and with the chord. Hold ⌘ after ⌘Z to see the peek. Use "Back to here". Take screenshots in light and dark, and check the `?preview=1` fixture on a route that keeps its query, such as `/tasks?preview=1` (`/inbox` redirects to a conversation and drops it). Open the palette from a page with no live composer, and confirm its input has focus before typing.
9. **Desktop.** Repeat step 7 and one app undo in the Electron app to settle the Edit menu question.

**Results (2026-10-03, ct-56508 WP5).** Run with a raw-CDP driver over the `cast browser` bridge. Both tabs were background tabs, so each script enabled `Emulation.setFocusEmulationEnabled` (a background tab reloaded behind other windows has no focused frame, and key events to it are dropped) and allowed for throttled timers.

| # | Scenario | Result |
|---|---|---|
| 1 | Stash in A; B drops the row; real ⌘Z in A; both restore; reload A | Pass. The fields came back identical, the original `inbox_pinned_at` included, and stayed after reload. |
| 2 | Snooze, defer, ⌘Z the defer, wait 40 s | Pass. The snooze held in A and B. A second ⌘Z took the snooze back and restored the pin. |
| 3 | `fileSessionsAsRest` over three sessions | Pass. One toast, one timeline entry ("Filed 3 sessions as Done", folded), and one ⌘Z restored all three to their exact prior rest fields. |
| 4 | Task status and assignee, two ⌘Z, reload | First run failed: the server re-applied the forward values 11 s later through a sibling window's outbox drain. Fixed with outbox ownership (section 3.7); the rerun held for over 75 s and after reload. A cleared assignee comes back as `""`, the server's own unassigned value (`tasks.ts` writes `resolve(...) \|\| args.assignee`). |
| 5 | Archive a doc, toast Undo, wait, reload | Pass (B1). The exclude was replaced by an include lock, and the doc survived the push, the reload and a server read. |
| 6 | Rename in A, rename in B, ⌘Z in A | Pass. "Can't undo Renamed ct-…: changed since", and B's title stayed. |
| 7 | ⌘Z in the composer; held ⌘Z outside fields | Pass. Text undo took back one typing step and left the app entry alone; the app did not handle the key. One keydown plus four auto-repeats made exactly one app undo. |
| 8 | Palette row, chord, held peek, toast History, Back to here, light and dark, `?preview=1` | Pass after two fixes: the status toast covered the peek card, and the "now" label was clipped when the head was the newest row (the list gained `pt-2`). |
| 9 | Desktop Edit menu | The role swallowed ⌘Z; replaced, see section 7. |

A rerun the same afternoon (scenarios 1 to 8, after the validation rounds) passed again and found one more defect: a recorded entry's Undo toast stayed on top of the card opened from the chord and covered its lower rows. Opening the card now takes those toasts down too (section 4). Two findings outside undo: the palette ranks the "Undo history" row below session results for the query "undo history" (12th of 18), so Enter on that query opened a conversation (since fixed: a command the query names outranks session and entity hits, `lib/__tests__/paletteActions.test.ts`); and right after a reload, an archived doc can reappear in `docs` for about a second while its exclude lock still stands, without any undo involved (a boot-time write that skips the pending filter).

Close the tabs you opened when done.

## 13. Work packages

1. **Engine plus binding** (wave 1). Covers sections 3, 4 and 7, the vendoring, and the policy skeleton with the guard test.
2. **Session coverage and the `undoActions.ts` migration** (wave 2).
3. **Work-object coverage: writers and inverses** (wave 2).
4. **Timeline UI and doorways** (wave 2): sections 8 and 9, except the held peek.
5. **Held-modifier walk, polish and end-to-end verification** (wave 3).

## 14. Follow-ups (out of scope for this version)

- **Server dedupe for replayed outbox rows.** Outbox ownership stops a live window's rows being re-sent by a sibling. It cannot cover a window that reloads while its delivered rows are still waiting to be deleted: the reload releases the lock, and the next drain replays them once. During verification, rows from 8:42 replayed at 8:51 when the dev server reloaded every window. They replayed in order, so the end state held, but a replay can interleave with a later write. Deduping legacy actions by outbox id on the server (receipt actions already are) closes this.

- **The forward write of a thin row never reaches the server.** `groupPatchesByTable` (engine `middleware.ts`) skips a whole-row add (collection path of length 2), so a gesture that creates a thin `conversations` row with no inbox row behind it (`/sessions` Unpin, Stash, Restore through `patchConversation`, `app/sessions/page.tsx` and `ConversationList.tsx`; `toggleFavorite` on such a row) changes the store and sends nothing. It predates undo, and such a gesture is not recorded (section 5, thin conversation rows), so undo no longer writes on its behalf. The fix belongs to the engine middleware (dispatch the fields of a whole-row add to a server id) or to the page (feed its rows into the store before acting on them).
- **Compare-and-set** on `applyUndoPatches` (`[patches, expect]`), to close the last-writer-wins window for a remote change that has not yet reached this client. It needs a `deploy.sh` run before the web push.
- **Server verbs** that would make more things undoable: `addToStack` (for `removeFromStack`), soft deletes for comments and saved views, and create-undo through delete by `client_key`.
- **Org batch ids** returned by the org side effects, so org entries could undo in place through `undoOrgChange`.
- **History across windows**, shared over the replication channel. Only the originating window could undo.
- **Persisted history** as a registry key classified `local`.
