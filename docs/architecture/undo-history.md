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
| Where the specs live | **A registry keyed by action name**, `UNDO_POLICY` in `packages/web/store/undo/`, passed to the engine as `PlatformConfig.undo.specs`. A guard test requires every creator to be classified. Not `action(fn, {undo})` inline. | `inboxStore.ts` is 13.7k lines and shared with other sessions. A registry keeps ownership disjoint, follows the `SIDE_EFFECTS` and `REPLICATION_CLASSIFICATION` pattern, and lets the guard make classification exhaustive. |
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
  ignoreKeys?: ReadonlySet<string>;            // never captured (clientState, tabs, pagination, ...)
  beforeReplay?: (entry: UndoEntry, dir: "undo" | "redo") => void;
  afterReplay?: (entry: UndoEntry, dir: "undo" | "redo", applied: readonly CellChange[]) => void;
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
  external?: string; droppedBy?: string; undoneAt?: number;
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
type UndoHistorySnapshot = { version: number; items: readonly UndoHistoryItem[]; head: string | null };
type UndoHistoryItem = Omit<UndoEntry, "undo" | "redo">;   // newest first
```

**Status rules**

- Pushing a new entry marks the redo stack's entries `dropped`, with `droppedBy` set. They stay visible but cannot be acted on.
- Expiry is not stored. The UI derives it from `ts` and `keyboardWindowMs`.

**Notifier**

The notifier gains `onHistoryStep?(kind: "undo" | "redo", steps: number, entry)` and `notifyWithUndo(label, entryId)`.

### 3.5 Undo replay

1. **Guard.** Run the rule from section 2 over the protected cells, grouped by row. `stampFields` are never compared. A row that is gone counts as a conflict, unless the cell is a row add, which counts as already undone. If no row applies, mark the entry `conflict`, notify "Can't undo <label>: changed since", remove it from the stack, and stop. The next keypress continues with the older entries.
2. **Prepare.** Call `beforeReplay(entry, "undo")`. Codecast uses it to call `declareViewNav("undo")`.
3. **Plan the passes.**
   - If the spec has `inverse`, use its invocations. The first one carries the overlay for every applicable cell.
   - Otherwise, the cells on keys with a writer are grouped per row into that writer's invocations, each carrying its row's overlay. All other cells (patch rail and mirror) go into one `replayAction` pass with args `[]`.
4. **Run each pass** through `runAction(inv.action, flagsOf(target), recipe, inv.args, { replay })`. The recipe does three things in order:
   1. deletes the forward's `planted` pending entries that still match exactly (same type, value and ts), which fixes B1 and B2;
   2. runs the target's draft, if `runDraft` is set;
   3. writes each `before` value field by field. It deletes the field when `hadBefore` is false, re-adds or deletes whole rows for row cells, and restamps `stampFields`.

   `generateAutoPending` then plants fresh locks on the restored values (an include replaces a stale exclude at the same key), and the grouped patches carry the exact prior values. `applyUndoPatches([])` is safe on the server: the handler applies the grouped patches, and the side effect falls back to `{}`.
5. **Finish.** Call `afterReplay(entry, "undo", appliedCells)`. Move the entry to the redo stack, set `skipped` and `undoneAt`, and notify once.

### 3.6 Redo

1. Check that every applied protected cell equals `before`. If one does not, the outcome is a conflict.
2. Call `beforeReplay(entry, "redo")`.
3. Call the wrapped original action with the original args, inside a capture that **refreshes this entry's** `changes`, `planted` and `outboxIds` instead of pushing a new entry.
4. For a group, redo the children in order.

### 3.7 Refusal, stubs, async

- **Refusal.** Every capture stores its outbox id. When `releaseRefusedLocks` or `applyReceiptRejection` rolls an action back, the engine marks the entry that names that outbox id `refused` and removes it from both stacks. If an undo's own dispatch is refused, its locks roll back through the same path, and the entry returns to the undo stack.
- **Stub ids.** Wherever `rekeyExtra` and `rekeyPending` run (`syncEngine.ts` ~214), the engine also rewrites `id` in live entries' cells and objects.
- **Offline.** Outbox rows replay in `ts` order (`nextOutboxTimestamp`), so a forward write and its undo arrive in causal order.

## 4. Codecast binding

**Config** (`packages/web/store/mutativeMiddleware.ts`, `CODECAST_PLATFORM_CONFIG`):

- `undo.specs = UNDO_SPECS`, built from `store/undo/policy.ts`.
- `replayAction: "applyUndoPatches"`.
- `writers = UNDO_WRITERS` (`store/undo/writers.ts`).
- `stampFields: {"updated_at"}`.
- `ignoreKeys`: `pending`, `syncMeta`, `clientState`, `tabs`, `activeTabId`, `pagination`, `drafts`, `recentVisits`, `collapsedSections`, liveness and feed keys. The binding package writes the full list from `REPLICATION_CLASSIFICATION` "local" keys plus server-fed projections.
- `beforeReplay: () => declareViewNav("undo")`.
- `restoreView: (draft, field, value)`, which calls `recordCurrentConversationPointer` and `syncActiveInboxTabPath` for `currentSessionId`.
- `afterReplay`: for each applied `sessions`/`conversations` cell whose field is in `BRIDGED_FIELDS`, send one `broadcastGesture({kind: "fields", id, fields, ts}, bridgeUserId(state))` per id with one `ts`. This replaces the hand bridge calls in `undoActions.ts`. It sends exact values, never a pin toggle.

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

- `notifyWithUndo(label, entryId)` wires the Undo button to `undoEntry(entryId)`.
- Undo and redo announcements reuse one sonner id (`"undo-status"`), so chained undos update one toast.
- When the timeline tier is `hidden` and history has more than one item, the "Undid" toast carries a quiet `History` action that opens the timeline.
- While the timeline is open, the notifier stays silent.

## 5. Coverage

**Route** says how the undo reaches the server:

- **patch**: `applyUndoPatches` pass
- **writer**: the collection's writer
- **inverse**: a spec override
- **never**
- **external**: the org record

| Action (inboxStore.ts unless named) | Route | Notes and label |
|---|---|---|
| `deferSession`, `setSessionRest`, `pinSession`, `snoozeSession`, `wakeSnoozedSession`, `renameSession`, `setSessionCharacter(s)`, `patchConversation`, `toggleFavorite`, `updateSessionProject`, `setConversationModel/Agent/AgentDefinition` | patch | The cleared snooze, `title_is_custom` and the `favorites` mirror are captured automatically. "Deferred “{title}”", "Filed “{title}” as Done", "Pinned/Unpinned “{title}”", "Renamed “{old}” to “{new}”" |
| `stashSession`, `killSession`, `killSessions` | inverse: one `{action: "restoreSession", args: [id], runDraft: false}` per hidden id. The first carries the overlay. | Owners land through the patches; non-owners land through the `inbox_hides` unhide (B6). `restoreView: true`, `toast: true`. Kill label: "Killed “{title}” (agent stays stopped on undo)". Verify that `unhideConversationForViewer` is a no-op for owners. |
| `restoreSession` | patch | "Restored “{title}”" |
| `updateBucket` | patch | `inbox_buckets` rail |
| `assignSessionToBucket` | writer (`bucketAssignments` → `assignSessionToBucket(conv, prevBucket \| null)`) | "Labeled “{title}” {bucket}" |
| `switchProject` | inverse: `switchProject(id, prevPath)` | |
| `setPrivacy`, `setTeamVisibility` | inverse with the prior value | Immutable on the patch rail. Undo that widens access is offered only from the toast or the timeline, never from blind ⌘Z (spec flag `confirm: true`, which `performUndo` skips with a notice). |
| `toggleBookmark` | inverse: the same toggle | The guard ensures membership is still `after`. |
| `updateTask`, `updateTaskStatus` | writer: `updateTask(short_id, wire)` | Wire: `parent_id` → `parent` (short id or `""`); a cleared `assignee`, `project_id`, `status_id`, `execution_status` or `parent` → `""`; drop `updated_at`, `closed_at` and `attempt_count`. A cascade close yields one invocation per child. The undo cannot recall assignment notifications. |
| `updatePlan`, `updateProject`, `updateInitiative`, `set/add/removeInitiativeProject` | writer | Already in server shape (`writeAsServerShape`). |
| `updateDoc` | writer: `updateDoc(id, {title, doc_type, labels})` | `ignoreFields: ["content", "overflow"]`. The label is null when nothing else changed, because the editor owns text undo. |
| `pinDoc`, `moveDoc` | writer: `pinDoc(id, pinned)`, `moveDoc(id, parent_id, sort_order)` | The docs writer splits by field group. |
| `archiveDoc` | writer `restoreRow` → `restoreArchivedDoc(id)` (draft no-op); the overlay re-adds `docs` and `docDetails` | `toast: true`. Fixes B1. |
| `updateSavedView` | writer → `updateSavedView(id, f)` | |
| `resolveCommentThread`, `editComment` | inverse with the prior value | |
| `reorderStack`, `setStackPolicy` | inverse with the prior order or policy | |
| `triggerAction` pause/resume, `setTriggerInterval` | inverse with the opposite verb or prior interval | Run now, cancel and reactivate: never. |
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
  - `ui.undoHistory`: `{key: 'ctrl+alt+z', mac: 'meta+alt+z'}`.
  - None of these use `skipInputCheck`.
- **Text fields keep native undo.** Inputs, textareas and contenteditable editors (TipTap, CodeMirror) do their own undo. App undo fires only when focus is not editable. There is no fall-through into app undo when a field's own history is empty.
- **Modals.** An open modal (`hasOpenModal`) blocks app undo, as today. The timeline card must not set `aria-modal`, so stepping with ⌘Z works while it is open.
- **`noRepeat`** (new in `@platform/keys`): a repeated keydown for such a def is swallowed (`preventDefault`, no handler call). Holding ⌘Z is one undo (B7).
- **Electron.** The Edit menu has `{ role: "undo" }` (`packages/electron/main.js` ~2693). Verify in the desktop app which fires first. If the menu role swallows ⌘Z outside fields, replace the role items with click handlers that run `webContents.undo()` / `redo()` when the focused element is editable and otherwise send the renderer an IPC that calls `performUndo()` / `performRedo()`.
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

- A `History` icon in `text-sol-cyan`, the title "Undo history", and a legend in `<KeyCap>` drawn from `MenuKeyCaps` for `ui.undo`, `ui.redo` and Esc.
- A dim subline: "This window · ⌘Z reaches the last 5 minutes".

**Rail**

- The rail chrome (hairline, dots, fold) is extracted from `OrgHistoryView.tsx` into `components/history/HistoryRail.tsx`. Both the org record and the undo timeline render through it, and `OrgHistory.mount.test.tsx` must pass unchanged.
- Newest is at the top. A 1 px `--sol-cyan` "now" rule sits between undone rows (above) and done rows (below). It slides 160 ms ease-out when the head moves, and jumps under reduced motion.

**Rows** (two lines, laid out like `RecentVisitRow`)

- **Dot.** The object's glyph for done rows, `Redo2` dim for undone rows, `Network` for org rows, a `--sol-yellow` ring for conflict rows.
- **Line 1.** The captured label, with the object's live title as a quiet link that opens it. Relative time on the right in `tabular-nums` (`visitTimeAgo`).
- **Line 2** (11 px, dim), by state:
  - done: where it happened, or "can undo for 40s more" in the last minute of the keyboard window (time-driven through `useNowWhen`);
  - undone: "undone 1m ago";
  - partial: "2 rows changed since, left as they are";
  - conflict: "changed since, can't be taken back";
  - refused: "the server refused this change";
  - org: "org change · opens the org record".
- **Groups** fold ("5 sessions") using the existing fold pattern.
- **Dropped redo branches** collapse into one line under the entry that caused them: "2 undone steps set aside when you <label>". They are struck and inert.
- **Affordance.** On hover or selection, one button: "Back to here" (with a count, "Back 3") below the head, or "Forward to here" above it. These are `undoTo` / `redoTo`, which stop at the first conflict with a toast. Org rows show "Open in org record" instead. A dim "Start · before these changes" row ends the list.

**Keyboard (interactive mode)**

| Keys | Action |
|---|---|
| ↑ / ↓ | Move the selection |
| Enter | Go to the selected row |
| ⌘Z / ⌘⇧Z | Step; the selection follows the head |
| → / Space | Fold or unfold |
| O | Open the row's object |
| Home / End | Jump to the top or the bottom |
| Esc | Close; focus returns where it was |

The footer legend uses KeyCaps. The list is cmdk, like `RecentsPanel`, with no search field.

**Empty state.** "Nothing to take back yet. Changes you make in this window collect here, newest first, each with a way back."

**Narrow screens.** Below 480 px the card spans the full width at the bottom.

## 9. Discoverability gate

`UNDO_HISTORY_TIER = "hidden"`. With the tier hidden there is no header button and no Settings row, but five doorways are live, and none adds chrome:

1. **Palette row** "Undo history" (`ui.undoHistory`, keywords "undo redo history timeline changes revert"). Found by search, not by browsing.
2. **The chord** ⌘⌥Z / Ctrl+Alt+Z, listed automatically in the `?` panel's Global section.
3. **The "Undid" toast.** Its quiet `History` action appears only after an undo, when there is more history to show.
4. **The held-modifier peek.** After ⌘Z, keep the modifier held for 350 ms and the card peeks open, narrating each further undo (Z) or redo (Shift+Z). H pins it interactive. Releasing fades it after 600 ms, unless the pointer is over it, which pins it. Any other key closes it and passes through. The logic is a pure reducer, `lib/undoWalk.ts`, fed by `hooks/useUndoWalk.ts`, which takes ownership of the `ui.undo` / `ui.redo` handlers from `shortcuts/actions.ts`.
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
8. **Timeline.** Open it from the palette and with the chord. Hold ⌘ after ⌘Z to see the peek. Use "Back to here". Take screenshots in light and dark, and check the `?preview=1` fixture.
9. **Desktop.** Repeat step 7 and one app undo in the Electron app to settle the Edit menu question.

Close the tabs you opened when done.

## 13. Work packages

1. **Engine plus binding** (wave 1). Covers sections 3, 4 and 7, the vendoring, and the policy skeleton with the guard test.
2. **Session coverage and the `undoActions.ts` migration** (wave 2).
3. **Work-object coverage: writers and inverses** (wave 2).
4. **Timeline UI and doorways** (wave 2): sections 8 and 9, except the held peek.
5. **Held-modifier walk, polish and end-to-end verification** (wave 3).

## 14. Follow-ups (out of scope for this version)

- **Compare-and-set** on `applyUndoPatches` (`[patches, expect]`), to close the last-writer-wins window for a remote change that has not yet reached this client. It needs a `deploy.sh` run before the web push.
- **Server verbs** that would make more things undoable: `addToStack` (for `removeFromStack`), soft deletes for comments and saved views, and create-undo through delete by `client_key`.
- **Org batch ids** returned by the org side effects, so org entries could undo in place through `undoOrgChange`.
- **History across windows**, shared over the replication channel. Only the originating window could undo.
- **Persisted history** as a registry key classified `local`.
