// Codecast's binding of the @platform/engine middleware. The engine owns the
// mechanics (mutative drafts, auto-pending, the durable dispatch outbox, the
// storage watchdog, receipt envelopes); everything codecast-shaped — the sync
// registry, the view-motion guard, must-deliver actions, create continuations —
// is injected here through PlatformConfig. The exported surface is unchanged:
// consumers keep importing from this module.
import {
  action,
  asyncAction,
  receiptAsyncAction,
  sync,
  mutativeMiddleware as engineMutativeMiddleware,
  groupPatchesByTable as engineGroupPatchesByTable,
  outboxCoalesceKeyFor as engineOutboxCoalesceKeyFor,
  makeIsMustDeliverEntry,
  makeOutboxFailureDisposition,
  defaultIsServerId,
  deriveRegistryMaps,
  type GroupPatchesContext,
  type MiddlewareOptions,
  type OutboxEntry,
  type PlatformConfig,
  type ReceiptContinuations,
  type ViewGuard,
  type ViewGuardChange,
} from "@platform/engine";
import { noteFreshDoc } from "../lib/docSyncCache";
import type { Patch } from "mutative";
import {
  CLIENT_SYNC_REGISTRY,
} from "./clientSyncRegistry";
import { consumeViewNav, noteViewNavApplied, recordNavEvent } from "./viewNav";

export {
  action,
  asyncAction,
  receiptAsyncAction,
  sync,
  isPermanentDispatchError,
  isParkedDispatchError,
  CommandReceiptRejectedError,
  DispatchNotWiredError,
  StaleDispatchBindingError,
  UnsupportedOutboxOperationSchemaError,
  MAX_OUTBOX_BOOT_ATTEMPTS,
  OUTBOX_MAX_REPLAY_AGE_MS,
  STORAGE_WATCHDOG_MS,
  STORAGE_WATCHDOG_MAX_TIMER_LAG_MS,
  STORAGE_WATCHDOG_RECHECK_MS,
  CURRENT_OUTBOX_OPERATION_SCHEMA_VERSION,
} from "@platform/engine";

export type DurableCreateContinuation =
  | { version: 1; kind: "navigate" }
  | { version: 1; kind: "assignBucket"; conversationIds: string[] };

const SINGLETON_KEY = "_";

// Everything the engine derives from the registry (dispatch table maps, the
// protected-collection check) comes from the same CLIENT_SYNC_REGISTRY the
// rest of the store wires from.
const REGISTRY_MAPS = deriveRegistryMaps(CLIENT_SYNC_REGISTRY as any);

const GROUP_CTX: GroupPatchesContext = {
  tableMap: REGISTRY_MAPS.dispatchTableMap,
  fieldToTable: REGISTRY_MAPS.dispatchFieldTableMap,
  isServerId: defaultIsServerId,
};

export function groupPatchesByTable(
  patches: Patch[],
  state?: any,
): Record<string, any> | undefined {
  return engineGroupPatchesByTable(patches, state, GROUP_CTX);
}

// A replayed dispatch is stale by definition — it survived a reload. The
// conversation pointer means "where the user is right now", so re-pushing an
// old value from the outbox would repoint the user's other clients at a
// position they already left. Drop it from replays; the rest of the patch
// (and the action itself) still re-fires.
export function stripStalePointerFromReplay(patches: any): any {
  const cs = patches?.client_state?.[SINGLETON_KEY];
  if (!cs || typeof cs !== "object" || !("current_conversation_id" in cs)) return patches;
  const { current_conversation_id: _omit, ...rest } = cs;
  if (Object.keys(rest).length > 0) {
    return { ...patches, client_state: { ...patches.client_state, [SINGLETON_KEY]: rest } };
  }
  const { [SINGLETON_KEY]: _doc, ...otherDocs } = patches.client_state;
  const { client_state: _table, ...otherTables } = patches;
  if (Object.keys(otherDocs).length > 0) {
    return { ...otherTables, client_state: otherDocs };
  }
  return Object.keys(otherTables).length > 0 ? otherTables : undefined;
}

// Actions carrying user-authored content that MUST reach the server — losing
// one silently drops something the user typed. These are never given up on:
// they ride the outbox until the server acknowledges them, however many
// reloads/outages that takes. The boot cap only bounds low-stakes bookkeeping
// writes (dismiss, client_state) whose loss is recoverable and which must not
// slow every page load forever if permanently broken. dispatch.sendMessage
// dedups on client_id, so unbounded retry is safe.
export const MUST_DELIVER_ACTIONS = new Set([
  "sendMessage",
  "addComment",
  "editComment",
  "deleteComment",
  "askAgentInThread",
  // A chat line is user-authored content on the same terms. chat.sendMessage
  // dedupes on client_id (and refuses to wake an anchor twice for it), so
  // re-driving it forever is safe.
  "dispatchChatSend",
]);

// Fork creates ride convCommand, so the action name alone can't mark them —
// but they carry the same "user-authored intent" stakes as a send: giving one
// up silently strands a fork stub the user is already working in. Safe to
// retry forever: forkFromMessage dedups on session_id.
const isForkCreateEntry = (entry: OutboxEntry): boolean =>
  entry.action === "convCommand" && Array.isArray(entry.args) && entry.args[1] === "forkFromMessage";

export const isMustDeliverEntry = makeIsMustDeliverEntry(MUST_DELIVER_ACTIONS, isForkCreateEntry);

// What to do with an outbox entry whose boot-time replay failed: keep it for
// the next boot with the attempt counted, or give up at the cap. User sends
// and fork creates are never dropped — see isMustDeliverEntry.
export const outboxFailureDisposition = makeOutboxFailureDisposition(isMustDeliverEntry);

// Comment commands were briefly persisted with their optimistic payload as
// `result`, before receiptAsyncAction added an envelope. New servers still
// return a V2 command receipt for those rows. Interpret a terminal rejection
// during replay so an upgraded client does not acknowledge it as success and
// leave the optimistic comment protected forever.
const LEGACY_RECEIPT_ACTIONS = new Set([
  "addComment",
  "editComment",
  "deleteComment",
  "askAgentInThread",
]);

// Repeated writes that rewrite the same logical value each time (full-value
// LWW per key). The outbox keeps at most one row per derived key: a newer
// enqueue replaces the older row instead of appending. This makes write floods
// structurally unable to grow the durable queue — a resize loop enqueues one
// row, not thousands. Only register actions whose args carry the COMPLETE new
// value for the key; partial-field updates (e.g. updateTab) must never
// coalesce, since dropping the older row would drop the older fields.
export const OUTBOX_COALESCE_KEYS: Record<string, (args: any[]) => string | null> = {
  updateClientLayout: (args) =>
    typeof args[0] === "string" ? `updateClientLayout:${args[0]}` : null,
  updateClientDismissed: (args) =>
    typeof args[0] === "string" ? `updateClientDismissed:${args[0]}` : null,
};

export function outboxCoalesceKeyFor(action: string, args: any[]): string | null {
  return engineOutboxCoalesceKeyFor(action, args, OUTBOX_COALESCE_KEYS);
}

// ---------------------------------------------------------------------------
// Receipt continuations — the follow-up work a create asks for once the server
// acknowledges its command (navigate to the new row, attach conversations to
// the new bucket).
// ---------------------------------------------------------------------------

function durableCreateContinuation(
  actionName: string,
  localResult: unknown,
): DurableCreateContinuation | null {
  if (!localResult || typeof localResult !== "object") return null;
  const raw = (localResult as { continuation?: unknown }).continuation;
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<DurableCreateContinuation>;
  if (candidate.version !== 1) return null;

  if (
    candidate.kind === "navigate" &&
    (actionName === "createDoc" ||
      actionName === "createPlan" ||
      actionName === "createProject")
  ) {
    return { version: 1, kind: "navigate" };
  }

  if (
    candidate.kind === "assignBucket" &&
    actionName === "createBucket" &&
    Array.isArray(candidate.conversationIds)
  ) {
    const conversationIds = [...new Set(candidate.conversationIds)]
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, 100);
    if (conversationIds.length > 0) {
      return { version: 1, kind: "assignBucket", conversationIds };
    }
  }
  return null;
}

function acknowledgedNavigationHref(
  actionName: string,
  result: unknown,
): string | null {
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, unknown>;
  if (actionName === "createDoc" && typeof value.id === "string" && value.id) {
    return `/docs/${encodeURIComponent(value.id)}`;
  }
  if (
    actionName === "createPlan" &&
    typeof value.short_id === "string" &&
    value.short_id
  ) {
    return `/plans/${encodeURIComponent(value.short_id)}`;
  }
  if (
    actionName === "createProject" &&
    typeof value.id === "string" &&
    value.id
  ) {
    return `/projects/${encodeURIComponent(value.id)}`;
  }
  return null;
}

const RECEIPT_CONTINUATIONS: ReceiptContinuations = {
  resolve: durableCreateContinuation,
  apply: ({ actionName, continuation, serverResult, commandId, getState }) => {
    const resolved = continuation as DurableCreateContinuation;

    if (resolved.kind === "assignBucket") {
      const handler = getState()?._handleReceiptAcknowledgement;
      if (
        !serverResult ||
        typeof serverResult !== "object" ||
        typeof (serverResult as { bucketId?: unknown }).bucketId !== "string" ||
        !(serverResult as { bucketId: string }).bucketId
      ) {
        throw new Error(
          "Acknowledged createBucket receipt is missing its bucket id",
        );
      }
      if (typeof handler !== "function") {
        throw new Error("Create-label continuation runtime is unavailable");
      }
      handler(actionName, resolved, serverResult, commandId);
      return true;
    }

    const href = acknowledgedNavigationHref(actionName, serverResult);
    if (!href) {
      throw new Error(
        `Acknowledged ${actionName} receipt is missing its navigation id`,
      );
    }
    if (typeof window === "undefined" || !window.location) {
      throw new Error("Create navigation runtime is unavailable");
    }
    if (window.location.pathname === href) return true;

    // Seed local state BEFORE moving the view, so the target page paints from
    // the store on its first frame instead of waiting for the list feed to
    // echo the create. A doc created empty also gets its collab cache seeded:
    // the editor then mounts live with no snapshot round trip.
    const handler = getState()?._handleReceiptAcknowledgement;
    if (typeof handler === "function") {
      handler(actionName, resolved, serverResult, commandId);
    }
    if (actionName === "createDoc") {
      const row = (serverResult as { row?: { content?: string } }).row;
      noteFreshDoc((serverResult as { id: string }).id, {
        empty: !!row && !(row.content ?? "").trim(),
      });
    }

    // Navigate in-app: push the history entry the way tabNavigate does and
    // fire popstate, which is exactly what browser back/forward does —
    // DashboardLayout mirrors the URL into the active tab and React Router
    // re-matches outside the tab shell. Hook-free, so it also works during a
    // boot replay; the pathname then proves completion and the row retires.
    if (
      typeof window.history?.pushState === "function" &&
      typeof window.dispatchEvent === "function"
    ) {
      const state = { tabNav: true, tabId: getState()?.activeTabId };
      window.history.pushState(state, "", href);
      window.dispatchEvent(
        typeof PopStateEvent === "function"
          ? new PopStateEvent("popstate", { state })
          : new Event("popstate"),
      );
      return true;
    }
    if (typeof window.location.assign !== "function") {
      throw new Error("Create navigation runtime is unavailable");
    }
    // Last resort (no History API): a full navigation. Deliberately leave the
    // row in place: the next runtime observes the target pathname, then
    // retires the intent — a crash after navigation stays idempotent.
    window.location.assign(href);
    return false;
  },
};

// ---------------------------------------------------------------------------
// View-motion guard — the two fields that decide which conversation the user
// is looking at. Changing either to a different conversation requires a
// declared ViewNavSource (see viewNav.ts); an undeclared change is reverted
// and logged instead of applied. Clearing to null is always allowed (it can't
// teleport anyone) but still audited.
// ---------------------------------------------------------------------------

const VIEW_FIELDS = ["currentSessionId", "pendingNavigateId"] as const;

// Shared verdict for both write paths (action patches and raw setState).
// Returns the fields that must be reverted to their previous values.
function auditViewWrites(changes: ViewGuardChange[], actionName: string): string[] {
  // Consume unconditionally: a token declared by a write that ended up not
  // changing the view must not linger and authorize a later unrelated write.
  const source = consumeViewNav();
  if (changes.length === 0) return [];
  const revert: string[] = [];
  for (const { field, from, to } of changes) {
    if (source) {
      recordNavEvent({ field: field as any, from, to, source });
      if (field === "currentSessionId") noteViewNavApplied();
    } else if (to == null) {
      recordNavEvent({ field: field as any, from, to: null, source: `untracked:${actionName}` });
    } else {
      recordNavEvent({ field: field as any, from, to, source: `untracked:${actionName}`, blocked: "undeclared view change" });
      revert.push(field);
    }
  }
  return revert;
}

const VIEW_GUARD: ViewGuard = {
  fields: [...VIEW_FIELDS],
  audit: auditViewWrites,
};

// The middleware reads only `registry` and the hook fields from this config.
// dbName/dbVersion/syncRegistry belong to the persistence and sync stages of
// the engine, which codecast still wires through its own idbCache/inboxStore —
// they are placeholders until those layers move over too.
const CODECAST_PLATFORM_CONFIG: PlatformConfig = {
  dbName: "codecast",
  dbVersion: 0,
  registry: CLIENT_SYNC_REGISTRY as any,
  syncRegistry: {},
  mustDeliverActions: MUST_DELIVER_ACTIONS,
  mustDeliverExtra: isForkCreateEntry,
  legacyReceiptActions: LEGACY_RECEIPT_ACTIONS,
  outboxCoalesceKeys: OUTBOX_COALESCE_KEYS,
  transformReplayPatches: stripStalePointerFromReplay,
  viewGuard: VIEW_GUARD,
  receiptContinuations: RECEIPT_CONTINUATIONS,
  storageWatchdogHint:
    'usually another Codecast tab holding the database open across a schema upgrade — look for a Dexie "blocked" warning above',
};

export function mutativeMiddleware(
  config: any,
  opts?: Omit<MiddlewareOptions, "registryMaps">,
): any {
  return engineMutativeMiddleware(config, CODECAST_PLATFORM_CONFIG, {
    ...opts,
    registryMaps: REGISTRY_MAPS,
  });
}
