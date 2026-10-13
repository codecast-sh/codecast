// The window slot registry (docs/architecture/multiplayer-sim-harness.md,
// section 3.3).
//
// In production every browser window runs its own copy of every module, so a
// module-level `let` or Map belongs to one window. The sim runs every window in
// one process, so each such binding is classified here:
//
//   window     saved after a window's turn and restored before its next one,
//              through the seam its module exports ({ get, set, fresh })
//   memo       a derived cache, dropped on every switch so no window reads a
//              result another window computed
//   transient  must be idle whenever the sim switches windows
//   { shared } one copy for the process is correct; the string says why
//
// windowSlots.guard.test.ts walks the import graph from the sim and fails on
// any top-level binding of packages/web/{store,hooks,lib} missing from this
// table, so it cannot drift the way the legacy REPLICA_KEYS list did.
//
// This file must stay loadable without the store: the guard imports the table
// and is not allowed to pay for (or run) the store's module body. So the seams
// are reached through a lazy require on first use, never a static import.

export type SlotClass = "window" | "memo" | "transient" | { shared: string };

const CONSTANT: SlotClass = { shared: "constant lookup set, never written after module load" };
const DESKTOP: SlotClass = { shared: "desktop shell bridge; the sim has no shell, so it stays at its defaults" };
const NO_REACT: SlotClass = { shared: "subscribers registered by mounted components; the sim mounts no React" };
const IDB: SlotClass = { shared: "IndexedDB persistence: sim windows persist through their own _setIDBWrite tee, never idbCache" };
const DISK_LEDGER: SlotClass = { shared: "disk-write ledger: syncTable writes it, only the IndexedDB writer and hydration read it, and the sim runs neither" };
const OPEN_INTENT: SlotClass = { shared: "an open-beside intent set by a pointer gesture on a page; the sim makes none" };
const DRAFTS: SlotClass = { shared: "compose draft debounce; the sim types no drafts" };
const ANALYTICS: SlotClass = { shared: "analytics runtime; the sim never initializes analytics" };
const NO_WARM: SlotClass = { shared: "message-page warming (warmVisibleSessions); sim windows mount the feeders without it" };
const AUDIO: SlotClass = { shared: "audio output; bun has no AudioContext, so it stays null" };
const IMAGE_URLS: SlotClass = { shared: "storage id to image URL cache: the mapping is immutable and production keeps it origin-wide (localStorage); the sim serves no storage" };

/** The engine's source, as a path under packages/web (the vendored mirror). */
export const ENGINE = "../../platform/packages/engine/src/";

/** "<path under packages/web>:<binding>" to its class. */
export const WINDOW_SLOTS: Record<string, SlotClass> = {
  // store/inboxStore.ts
  "store/inboxStore.ts:_heldOverlayFacts": "window",
  "store/inboxStore.ts:recentlyRequestedPendingMessages": "window",
  "store/inboxStore.ts:resolvedSessionPreparations": "window",
  "store/inboxStore.ts:recentThawTimer": "window",
  "store/inboxStore.ts:_userMsgsProbed": "window",
  "store/inboxStore.ts:_idbHydrating": "window",
  "store/inboxStore.ts:hydrationEpoch": "window",
  // A server-deleted session the prune skipped while it was open: per-store hide state.
  "store/inboxStore.ts:deferredDeletedSessions": "window",
  // The placement caches: each browser window keeps its own, and every key
  // checks that window's state refs, so they travel with the window and its
  // next turn may reuse them.
  "store/inboxStore.ts:_membershipKey": "window",
  "store/inboxStore.ts:_membershipVal": "window",
  "store/inboxStore.ts:_visibleKey": "window",
  "store/inboxStore.ts:_visibleVal": "window",
  "store/inboxStore.ts:_pendingSendSigRef": "window",
  "store/inboxStore.ts:_pendingSendSig": "window",
  "store/inboxStore.ts:_placementDeadlineMemo": "window",
  "store/inboxStore.ts:_placedMemo": "window",
  // The retired field locks' acknowledgement times: each window acknowledges its own writes.
  "store/inboxStore.ts:retiredAckTs": "window",
  // The dev parity check's throttle: one per window, as each browser window keeps its own.
  "store/inboxStore.ts:_lastParityCheckAt": "window",
  "store/inboxStore.ts:_depChanges": { shared: "dev render census, read only from the console" },
  "store/inboxStore.ts:KEEP_VISIBLE_OVERLAYS": CONSTANT,
  "store/inboxStore.ts:IN_FLIGHT_OVERLAYS": CONSTANT,
  "store/inboxStore.ts:EMPTY_TEAM_INBOX_IDS": CONSTANT,
  "store/inboxStore.ts:SESSIONS_STRIP_FIELD_SET": CONSTANT,
  "store/inboxStore.ts:INBOX_FACT_FIELD_SET": CONSTANT,
  "store/inboxStore.ts:SYNC_ACTIVITY_FIELDS": CONSTANT,
  "store/inboxStore.ts:EMPTY_PENDING_SEND_IDS": CONSTANT,
  "store/inboxStore.ts:PER_DEVICE_UI_KEYS": CONSTANT,
  "store/inboxStore.ts:HELD_IN_NEW": CONSTANT,

  // the rest of store/
  "store/gestureBridge.ts:sourceToken": "window",
  "store/gestureBridge.ts:channelFactory": { shared: "set once per realm by the sim's device bridge" },
  "store/viewNav.ts:pendingSource": "window",
  "store/viewNav.ts:appliedNavCount": "window",
  "store/viewNav.ts:navLog": { shared: "audit ring, persisted to the one origin-wide localStorage in production too" },
  "store/viewNav.ts:navListeners": NO_REACT,
  "store/syncActivity.ts:_lastApplyMono": "window",
  "store/syncActivity.ts:_applySeq": "window",
  "store/syncTransaction.ts:depth": "transient",
  "store/syncTransaction.ts:deferred": "transient",
  "store/syncTransaction.ts:deferredFanOut": "transient",
  "store/syncTransaction.ts:timer": "transient",
  "store/syncReplication.ts:running": { shared: "the sim never calls startSyncReplication; devices wire the runtime directly" },
  "store/syncReplication.ts:followerTees": { shared: "keyed by each window's own store (its tee setter), so one map serves every window" },
  "store/chatSlice.ts:railCacheKey": "memo",
  "store/chatSlice.ts:railCacheValue": "memo",
  "store/chatSlice.ts:dmOpensInFlight": { shared: "keyed by stub ids minted from the window's own seeded stream, so windows never collide" },
  "store/orgSlice.ts:intentSeq": { shared: "process-wide counter: ids stay unique across windows and no window reads another's value" },
  "store/orgSlice.ts:NO_REVERT_TREE_KINDS": CONSTANT,
  "store/pendingMessageJournal.ts:sequence": { shared: "process-wide counter: journal stamps stay unique across windows" },
  "store/stageSplit.ts:idCounter": { shared: "process-wide counter: pane ids stay unique across windows" },
  "store/storeListenerCensus.ts:liveListenerCount": { shared: "dev listener census, read only from the console" },
  "store/idbCache.ts:upgradeBlockedListener": IDB,
  "store/idbCache.ts:_hydrating": IDB,
  "store/idbCache.ts:pendingJournalFlush": IDB,
  "store/idbCache.ts:pendingJournalEpoch": IDB,
  "store/idbCache.ts:ownership": IDB,
  "store/idbCache.ts:boundOwner": IDB,
  "store/idbCache.ts:_msgWriteTimer": IDB,
  "store/idbCache.ts:_lastPruneAt": IDB,
  "store/idbCache.ts:purging": IDB,
  "store/idbCache.ts:lastPersisted": IDB,
  "store/idbCache.ts:_pendingMsgWrites": IDB,
  "store/idbCache.ts:_inFlightMsgWrites": IDB,
  "store/idbCache.ts:_touchedAt": IDB,
  "store/idbCache.ts:META_KEYS": CONSTANT,
  "store/idbCollectionDiff.ts:snapshotDrops": DISK_LEDGER,
  "store/idbCollectionDiff.ts:landedSnapshots": DISK_LEDGER,
  "store/idbCollectionDiff.ts:persistedCollections": CONSTANT,
  "store/clientSyncRegistry.ts:REPLICATED_COLLECTION_SET": CONSTANT,
  "store/clientSyncRegistry.ts:REPLICATED_TABLE_SET": CONSTANT,
  "store/mutativeMiddleware.ts:MUST_DELIVER_ACTIONS": CONSTANT,
  "store/mutativeMiddleware.ts:LEGACY_RECEIPT_ACTIONS": CONSTANT,
  "store/mutativeMiddleware.ts:UNDO_IGNORE_KEYS": CONSTANT,
  "store/mutativeMiddleware.ts:BRIDGED_FIELD_SET": CONSTANT,
  "store/mutativeMiddleware.ts:undoStoreBinding": {
    shared: "set once as inboxStore loads; its functions read the store through the useInboxStore facade, so they reach the active window",
  },
  "store/undo/onRevert.ts:hooks": {
    shared: "undo revert hooks registered once at module load (undoActions.ts); the one there animates a DOM row, and the sim has no DOM",
  },
  // Reached through the human actor's undo and redo (sim/actors.ts).
  "store/mutativeMiddleware.ts:replayBridgeTs": {
    shared: "written by an undo replay's beforeReplay and read by its afterReplay in the same synchronous call, inside one window's turn",
  },
  "store/undoStack.ts:liveEntryToasts": { shared: "ids of the undo toasts on screen; the sim renders no toasts" },

  // The store's engine (@platform/engine, mirrored under platform/packages).
  // Each browser window keeps its own undo history: ⌘Z in one window never
  // reaches a gesture another window recorded.
  ...Object.fromEntries(
    ["undoStack", "redoStack", "history", "version", "snapshot", "suppressDepth", "refreshTarget", "groupDepth", "groupChildren", "groupToast", "groupExternals", "recordingHolds", "vanishedRuns", "pendingGestures", "detachedChildren"].map(
      (name) => [`${ENGINE}undoStack.ts:${name}`, "window" as SlotClass],
    ),
  ),
  ...Object.fromEntries(
    ["keyboardWindowMs", "stackLimit", "historyLimit", "stampFields", "notifier"].map((name) => [
      `${ENGINE}undoStack.ts:${name}`,
      { shared: "undo configuration and notifier, set once as the store loads" },
    ]),
  ),
  [`${ENGINE}undoStack.ts:idCounter`]: { shared: "process-wide counter: entry ids stay unique across windows and no window reads another's value" },
  [`${ENGINE}undoStack.ts:undoSeqCounter`]: { shared: "process-wide counter: sequence numbers only order one window's own entries, and a shared one still rises" },
  [`${ENGINE}undoStack.ts:listeners`]: NO_REACT,
  [`${ENGINE}undoStack.ts:rekeyHooks`]: { shared: "rekey hooks registered once at module load" },
  [`${ENGINE}undoStack.ts:resetListeners`]: { shared: "reset listeners registered once at module load" },
  [`${ENGINE}undoStack.ts:rebaseHooks`]: { shared: "each window's controller registers one as its store loads; it rebases only the entries its own controller holds" },
  [`${ENGINE}syncProtocol.ts:lockIdCounter`]: { shared: "process-wide counter: lock ids stay unique across windows" },
  [`${ENGINE}wakeSig.ts:__refSeq`]: { shared: "process-wide counter: ref ids stay unique across windows" },
  [`${ENGINE}react.ts:_clocks`]: NO_REACT,
  [`${ENGINE}case.ts:VERBATIM`]: CONSTANT,
  ...Object.fromEntries(
    ["snapshot", "lastSteadyFocus", "returnTo", "cardTookFocus", "trackedDoc", "flash", "listeners", "flashListeners"].map((name) => [
      `lib/undoTimelineOpen.ts:${name}`,
      { shared: "the history timeline's open state and DOM focus bookkeeping; the sim never opens the timeline" },
    ]),
  ),
  "store/syncProtocol.ts:OPTIONAL_INBOX_TIMESTAMPS": CONSTANT,
  "store/workbench.ts:RESTORABLE_KINDS": CONSTANT,
  "store/workbench.ts:MAY_FAIL_TO_MATERIALIZE": CONSTANT,
  "store/workspace.ts:PERSISTABLE_KINDS": CONSTANT,

  // hooks/
  "hooks/reconcileCrawl.ts:states": "window",
  "hooks/useBootstrapCollection.ts:done": "window",
  "hooks/useSyncChangeFeed.ts:cargoSupported": "window",
  "hooks/useSyncChangeFeed.ts:applyTally": "window",
  "hooks/useSyncChangeFeed.ts:flushTimer": "window",
  "hooks/useSyncChangeFeed.ts:shadowApplied": "window",
  "hooks/syncWake.ts:listeners": NO_REACT,
  "hooks/useCoarseNow.ts:_clocks": { shared: "shared coarse-tick subscribers; sim windows tick their digest comparer by hand and subscribe none" },
  "hooks/inboxWarm.ts:lastPass": NO_WARM,
  "hooks/inboxWarm.ts:inFlight": NO_WARM,
  "hooks/inboxWarm.ts:syncedCount": NO_WARM,
  "hooks/useStorageImageUrl.ts:urlCache": IMAGE_URLS,
  "hooks/useStorageImageUrl.ts:loadedSrcs": IMAGE_URLS,
  "hooks/useStorageImageUrl.ts:persistScheduled": IMAGE_URLS,
  "hooks/useStorageImageUrl.ts:guestImageScope": { shared: "a guest share page's image scope; sim windows are signed in and set none" },
  "hooks/useStorageImageUrl.ts:pendingIds": IMAGE_URLS,
  "hooks/useStorageImageUrl.ts:waiters": IMAGE_URLS,
  "hooks/useStorageImageUrl.ts:flushScheduled": IMAGE_URLS,
  "hooks/useConversationMessages.ts:LIVENESS_ONLY_CONV_FIELDS": CONSTANT,

  // lib/
  "lib/analytics.ts:runtime": ANALYTICS,
  "lib/analytics.ts:initPromise": ANALYTICS,
  "lib/appWindowRegistry.ts:present": DESKTOP,
  "lib/appWindowRegistry.ts:channel": DESKTOP,
  "lib/appWindowRegistry.ts:installed": DESKTOP,
  "lib/appWindowRegistry.ts:announced": DESKTOP,
  "lib/appWindowRegistry.ts:watchers": DESKTOP,
  "lib/browserPane.ts:titles": { shared: "page titles a browser pane reports; the sim opens no pane" },
  "lib/browserPane.ts:listeners": NO_REACT,
  "lib/browserPane.ts:APP_HOSTS": CONSTANT,
  "lib/calls/recordingPress.ts:presses": { shared: "a Record press's own dispatch state, written only by a press; the sim presses no Record, so it stays empty" },
  "lib/calls/recordingPress.ts:pressedRuns": { shared: "the recording runs a press started, written only by a press; the sim presses no Record, so it stays empty" },
  "lib/calls/recordingPress.ts:pressListeners": NO_REACT,
  "lib/follow.ts:surfaces": NO_REACT,
  "lib/follow.ts:surfaceListeners": NO_REACT,
  ...Object.fromEntries(
    ["previousQuery", "normalizedQuery", "queryTokens"].map((name) => [
      `lib/mentionRanking.ts:${name}`,
      { shared: "the last query's tokens, a pure function of the query string; no window state goes into it" },
    ]),
  ),
  "lib/tabSafePath.ts:TAB_PATH_ACTIONS": CONSTANT,
  "lib/workflowRun.ts:HIDDEN_TYPES": CONSTANT,
  "store/inboxStore.ts:HOSTED_UNFOLDABLE_SECTIONS": CONSTANT,
  "store/orgSlice.ts:writeOptimisticMessage": { shared: "the store's optimistic message writer, bound once as the store module loads" },
  "lib/calls/recordingPress.ts:abandoned": { shared: "Record presses a person was told did not happen, written only by useRoomRecording; the sim presses no Record, so it stays empty" },
  "lib/chatViews.ts:knownAgents": { shared: "display-name fallback only; nothing an invariant compares reads it" },
  "lib/cuePlay.ts:shared": AUDIO,
  "lib/desktop.ts:shareCursorsUnsupported": DESKTOP,
  "lib/desktop.ts:lastDesktopInputAt": DESKTOP,
  "lib/desktop.ts:lastDesktopActivityAt": DESKTOP,
  "lib/desktop.ts:inputTrackerInstalled": DESKTOP,
  "lib/desktop.ts:windowRole": DESKTOP,
  "lib/desktop.ts:windowRoleBridge": DESKTOP,
  "lib/desktop.ts:reportedWindowState": DESKTOP,
  "lib/desktop.ts:paneCapabilities": DESKTOP,
  "lib/desktop.ts:paneProbe": DESKTOP,
  "lib/desktop.ts:windowRoleWatchers": DESKTOP,
  "lib/desktop.ts:paneWatchers": DESKTOP,
  "lib/desktopApps.ts:placedByShell": DESKTOP,
  "lib/desktopHandoff.ts:IN_SHELL_ROOT_SEGMENTS": CONSTANT,
  "lib/dispatchBinding.ts:CALLER_REPORTED_ACTIONS": CONSTANT,
  "lib/imageByteCache.ts:opaqueOrigins": IMAGE_URLS,
  "lib/inboxViewHistory.ts:applying": { shared: "true only inside a synchronous popstate re-apply, which the sim never drives" },
  "lib/migrationPlan.ts:CLAUDE_TYPES": CONSTANT,
  "lib/migrationPlan.ts:MID_TURN_STATUSES": CONSTANT,
  "lib/notificationDelivery.ts:current": { shared: "browser notifications; the sim installs no delivery" },
  "lib/notificationGate.ts:COMPLETION_KINDS": CONSTANT,
  "lib/openIntent.ts:splitOpener": NO_REACT,
  "lib/openIntent.ts:intent": OPEN_INTENT,
  "lib/openIntent.ts:clearTimer": OPEN_INTENT,
  "lib/openIntent.ts:installs": NO_REACT,
  "lib/openIntent.ts:prewarmTabIds": { shared: "background tabs TabContent mounts hidden; read only by components, and the sim mounts no React" },
  "lib/pendingDraftWrites.ts:exitHooked": DRAFTS,
  "lib/pendingDraftWrites.ts:pending": DRAFTS,
  "lib/pendingUploads.ts:pendingImageUploads": {
    shared: "in-flight image uploads keyed by blob preview URL; only the composer (a component) adds one, and the sim mounts no React",
  },
  "lib/shareTokenScope.ts:tokensByConversation": { shared: "share tokens a guest presented on a page; sim windows are signed in and present none" },
  "lib/sounds.ts:ctx": AUDIO,
  "lib/sounds.ts:soundedAt": { shared: "arrival sound de-dupe; affects only whether a sound plays" },
  "lib/syncLogCargo.ts:FACT_FIELDS": CONSTANT,
  "lib/tabRoutes.ts:NON_TAB_EXACT": CONSTANT,
  "lib/sessionCommands.ts:SESSION_COMMAND_ACTIONS": CONSTANT,
};

/** One window's `window` bindings, by file. Detached: nothing in it aliases a live binding. */
export type SlotSnapshot = Record<string, object>;

interface SlotSeam {
  get(): object;
  set(s: object): void;
  fresh(): object;
}

// Paths are relative to this file. `require` keeps the store off the module
// graph until a realm actually runs; the guard only reads the table.
function load<T>(id: string): T {
  return require(id) as T;
}

type InboxBindings = typeof import("../../inboxStore").__inboxStoreWindowBindings;
type InboxSlots = ReturnType<InboxBindings["get"]>;

// The inboxStore window bindings declared as const collections: set() refills
// them in place, and the store's own setter reassigns the rest. A binding
// missing here is never restored, which realm.selftest's round trip catches.
const INBOX_CONST_COLLECTIONS = ["recentlyRequestedPendingMessages", "resolvedSessionPreparations", "_userMsgsProbed", "_idbHydrating", "deferredDeletedSessions", "_placedMemo", "retiredAckTs"] as const;

// inboxStore exports its live window bindings; the copying lives here. A
// snapshot copies the const collections and both levels of _heldOverlayFacts
// (a scope's hold is assigned, a landed id deleted from it, in place), so it
// never aliases a live binding. Every other binding passes by reference, as a
// production window holds it: a memo key may hold a draft mutative has
// already revoked, which must not be touched.
function inboxStoreSeam(b: InboxBindings): SlotSeam {
  const copy = (s: InboxSlots): InboxSlots => {
    const out: Record<string, unknown> = { ...s };
    for (const k of INBOX_CONST_COLLECTIONS) {
      const v = s[k] as Map<unknown, unknown> | Set<unknown>;
      out[k] = v instanceof Map ? new Map(v) : new Set(v);
    }
    out._heldOverlayFacts = Object.fromEntries(Object.entries(s._heldOverlayFacts).map(([scope, h]) => [scope, { ...h }]));
    return out as InboxSlots;
  };
  return {
    fresh: (): InboxSlots => ({
      _heldOverlayFacts: {},
      recentlyRequestedPendingMessages: new Map(),
      resolvedSessionPreparations: new Map(),
      recentThawTimer: null,
      _userMsgsProbed: new Set(),
      _idbHydrating: new Map(),
      hydrationEpoch: 0,
      _lastParityCheckAt: 0,
      deferredDeletedSessions: new Set(),
      _membershipKey: null,
      _membershipVal: null,
      _visibleKey: null,
      _visibleVal: null,
      _pendingSendSigRef: undefined,
      _pendingSendSig: "",
      _placementDeadlineMemo: null,
      _placedMemo: new Map(),
      retiredAckTs: new Map(),
    }),
    get: () => copy(b.get()),
    set: (snap: object) => {
      const s = copy(snap as InboxSlots);
      const live = b.get();
      for (const k of INBOX_CONST_COLLECTIONS) {
        const target = live[k] as Map<unknown, unknown> | Set<unknown>;
        target.clear();
        for (const v of s[k] as Iterable<any>) {
          if (target instanceof Map) target.set(v[0], v[1]);
          else target.add(v);
        }
      }
      b.set(s);
    },
  };
}

const SEAMS: Record<string, () => SlotSeam> = {
  "store/inboxStore.ts": () => inboxStoreSeam(load<typeof import("../../inboxStore")>("../../inboxStore").__inboxStoreWindowBindings),
  "store/gestureBridge.ts": () => load<typeof import("../../gestureBridge")>("../../gestureBridge").__gestureBridgeSimSlots() as SlotSeam,
  "store/viewNav.ts": () => load<typeof import("../../viewNav")>("../../viewNav").__viewNavSimSlots() as SlotSeam,
  [`${ENGINE}undoStack.ts`]: () => load<typeof import("@platform/engine")>("@platform/engine").__undoStackWindowSlots(),
  // No seam of its own: the module's getters plus its existing test setter.
  "store/syncActivity.ts": () => {
    const m = load<typeof import("../../syncActivity")>("../../syncActivity");
    type Slots = { _lastApplyMono: number; _applySeq: number };
    return {
      fresh: (): Slots => ({ _lastApplyMono: Number.NEGATIVE_INFINITY, _applySeq: 0 }),
      get: (): Slots => ({ _lastApplyMono: m.lastSyncApplyMono(), _applySeq: m.syncApplySeq() }),
      set: (s: object) => m.__setSyncActivityForTests((s as Slots)._lastApplyMono, (s as Slots)._applySeq),
    };
  },
  "hooks/useBootstrapCollection.ts": () =>
    load<typeof import("../../../hooks/useBootstrapCollection")>("../../../hooks/useBootstrapCollection").__bootstrapSimSlots() as SlotSeam,
  "hooks/useSyncChangeFeed.ts": () =>
    load<typeof import("../../../hooks/useSyncChangeFeed")>("../../../hooks/useSyncChangeFeed").__changeFeedSimSlots() as SlotSeam,
  "hooks/reconcileCrawl.ts": () =>
    load<typeof import("../../../hooks/reconcileCrawl")>("../../../hooks/reconcileCrawl").__reconcileCrawlSimSlots() as SlotSeam,
};

// Memo bindings, by file: each entry loads its module and returns the existing reset that drops them.
const MEMO_RESETS: Record<string, () => () => void> = {
  "store/chatSlice.ts": () => load<typeof import("../../chatSlice")>("../../chatSlice")._resetChatRailMemo,
};

const fileOf = (key: string) => key.slice(0, key.lastIndexOf(":"));
const bindingOf = (key: string) => key.slice(key.lastIndexOf(":") + 1);

function keysOfClass(cls: "window" | "memo" | "transient"): string[] {
  return Object.keys(WINDOW_SLOTS).filter((k) => WINDOW_SLOTS[k] === cls);
}

/** Every file that holds a binding of `cls`, sorted. */
export function filesOfClass(cls: "window" | "memo" | "transient"): string[] {
  return [...new Set(keysOfClass(cls).map(fileOf))].sort();
}

let seams: Map<string, SlotSeam> | null = null;
// Built with the seams, since a realm resets memos and checks transients on every window switch.
let memoResets: (() => void)[] = [];
let syncTransaction: typeof import("../../syncTransaction") | null = null;

// Loads every seam once and checks it carries exactly the bindings the table
// calls `window` for its file, so a seam and the table cannot disagree.
function windowSeams(): Map<string, SlotSeam> {
  if (seams) return seams;
  const out = new Map<string, SlotSeam>();
  for (const file of filesOfClass("window")) {
    const make = SEAMS[file];
    if (!make) throw new Error(`sim slots: ${file} has window bindings but no seam in SEAMS (sim/windowSlots.ts)`);
    const seam = make();
    const want = keysOfClass("window").filter((k) => fileOf(k) === file).map(bindingOf).sort();
    const have = Object.keys(seam.fresh()).sort();
    if (want.join() !== have.join()) {
      throw new Error(`sim slots: ${file} seam carries [${have.join(", ")}] but WINDOW_SLOTS lists [${want.join(", ")}] as window`);
    }
    out.set(file, seam);
  }
  for (const file of Object.keys(SEAMS)) {
    if (!out.has(file)) throw new Error(`sim slots: SEAMS has ${file}, which WINDOW_SLOTS gives no window binding`);
  }
  for (const file of filesOfClass("memo")) {
    if (!MEMO_RESETS[file]) throw new Error(`sim slots: ${file} has memo bindings but no reset in MEMO_RESETS (sim/windowSlots.ts)`);
  }
  memoResets = filesOfClass("memo").map((file) => MEMO_RESETS[file]());
  syncTransaction = load<typeof import("../../syncTransaction")>("../../syncTransaction");
  return (seams = out);
}

/** The live `window` bindings, detached. */
export function saveSlots(): SlotSnapshot {
  const snap: SlotSnapshot = {};
  for (const [file, seam] of windowSeams()) snap[file] = seam.get();
  return snap;
}

/** Loads a snapshot into the live bindings. */
export function restoreSlots(s: SlotSnapshot): void {
  for (const [file, seam] of windowSeams()) {
    if (!(file in s)) throw new Error(`sim slots: snapshot has no entry for ${file}`);
    seam.set(s[file]);
  }
}

/** The bindings of a window that has not run yet. */
export function freshSlots(): SlotSnapshot {
  const snap: SlotSnapshot = {};
  for (const [file, seam] of windowSeams()) snap[file] = seam.fresh();
  return snap;
}

/** Drops every memo binding. */
export function resetMemos(): void {
  windowSeams();
  for (const reset of memoResets) reset();
}

/**
 * Publishes a fold the window's own writes left held (syncTransaction holds a
 * notification for one 33 ms frame). The sim models no frames, so a turn ends
 * with it published, while the window that produced it is still bound.
 */
export function settleTransients(): void {
  windowSeams();
  syncTransaction!.flushSyncPublishes();
}

/** Throws unless every transient binding is idle: a held publish belongs to the store that produced it. */
export function assertTransientIdle(): void {
  windowSeams();
  if (!syncTransaction!.__syncTransactionIdleForTests()) {
    throw new Error(
      `sim slots: a window switch found ${keysOfClass("transient").join(", ")} busy (a sync transaction open or a folded publish held)`,
    );
  }
}
