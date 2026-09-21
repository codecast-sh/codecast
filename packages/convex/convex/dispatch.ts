import { mutation, syncAckPositions } from "./functions";
import { normalizeCharacterFields } from "@codecast/shared/contracts/sessionCharacter";
import { guardClientResolution, personMayResolve, reopenCore, settleClientResolution } from "./sessionDecisions";
import { createStackWithCore, removeFromStackCore, reorderStackCore } from "./decisionStacks";
import type { ThreadKind } from "./threadReads";
import { v } from "convex/values";
import { resolveSpawnDefinition } from "./spawn";
import { getAuthUserId } from "@convex-dev/auth/server";
import { enqueueStartSession } from "./devices";
import { upsertBinding } from "./capabilityBindings";
import { Id } from "./_generated/dataModel";
import { checkRateLimit } from "./rateLimit";
import { resolveTeamForPath, buildShareUpdate } from "./privacy";
import { hasRecentPendingDaemonCommand, resumeConversationSession } from "./daemonCommandUtils";
import { resolveAssigneeToUserId, recalcPlanProgress, notifySubscribers, subscribeUser, resolveWorkerParentConversation, resolveTaskGitContext } from "./tasks";
import { api, internal } from "./_generated/api";
import { AGENT_MODEL_CONFIG, findModelOption, modelAgentKey, fromConvexAgentType, type ConvexAgentType,
  checkoutInUseMessage,
  normalizeCloudWorkspace,
  posixRepoBasename,
} from "@codecast/shared/contracts";
import { applyHideTransition } from "./cleanup";
import { stampBrowserPaneOfferHandled } from "./conversations";
import { reactivateTasksCanceledOnKill } from "./agentTasks";
import { canAccessDoc } from "./docs";
import { canSendProductMessage, enqueuePendingMessage, retryPendingMessageForUser, cancelPendingMessageForUser } from "./pendingMessages";
import { enqueueCloudSpawn } from "./cloud";
import { effectiveStartFrom, parkOnCloudHost, resolveCloudDevice } from "./cloudPlacement";
import { findSharedCheckoutOccupant } from "./cloudPlacement";
import { findConversationBySessionReference } from "./conversationSessionLookup";
import { findAgentBoxSessionCreatedBy, retainSessionCreator, sessionLaunchRunner } from "./sessionLaunch";
import {
  BUCKETS_VIEW_CONTRACT_ID,
  BUCKETS_VIEW_KEY,
  createBucketForUser,
  createBucketWithAssignmentsV2ForUser,
  assignConversationToBucketForUser,
  canFileConversation,
} from "./buckets";
import { advanceLocalViewRevision, runLocalCommand } from "./localFirstCommands";
import { isSessionOwner } from "./sessionOwners";
import { patchCommentWithRevision } from "./commentViewWrites";
import { canAccessConversation, requireTeamMembership, patchConversationVisibility } from "./lib/access";
import { patchConversationThroughFavoriteView } from "./favoriteViewWrites";
import { pinCapExceeded, PIN_CAP_ERROR } from "./inboxProjection";
import { addConversationToWorkItem } from "./conversationLinks";
import { DISPATCHABLE_CONVERSATION_FIELDS } from "@codecast/shared/contracts";

type TableConfig =
  | {
      kind: "collection";
      ownerField: string;
      editable: Set<string>;
      beforePatch?: (doc: any, safe: Record<string, any>) => Record<string, any>;
    }
  | {
      kind: "singleton";
      ownerField: string;
      lookupIndex: string;
      editable: Set<string>;
    };

const TABLE_CONFIG: Record<string, TableConfig> = {
  conversations: {
    kind: "collection",
    ownerField: "user_id",
    editable: new Set([
      ...DISPATCHABLE_CONVERSATION_FIELDS,
      "title_is_custom", "project_path", "git_root", "draft_message", "inbox_killed_at",
      "model", "effort", "agent_definition",
      "thread_state", "thread_state_at", "thread_state_msg_count", "thread_state_status",
    ]),
    beforePatch: (_doc: any, safe: Record<string, any>) => normalizeCharacterFields(safe),
  },
  client_state: {
    kind: "singleton",
    ownerField: "user_id",
    lookupIndex: "by_user_id",
    editable: new Set([
      "current_conversation_id", "show_dismissed", "dismissed_ids", "ui", "layouts",
      "dismissed", "tips", "drafts", "tabs", "activeTabId", "sidebar_collapsed",
      "zen_mode", "layout", "updated_at",
    ]),
  },
  // Bucket field edits (rename / color / sort_order / archived_at) ride the
  // generic patch path. Creation and assignment need inserts/upserts, so they
  // live in SIDE_EFFECTS (createBucket / assignSessionToBucket).
  inbox_buckets: {
    kind: "collection",
    ownerField: "user_id",
    editable: new Set(["name", "color", "sort_order", "archived_at", "updated_at"]),
  },
  // Decision-queue resolutions (answer / dismiss) ride the generic patch
  // path. Creation comes only from the CLI (/cli/decide → sessionDecisions.ask),
  // so everything but the resolution fields is immutable here.
  session_decisions: {
    kind: "collection",
    ownerField: "user_id",
    editable: new Set(["status", "answer_index", "answer_text", "answer_json", "resolved_at"]),
    // First writer wins on this rail too: a resolution patch on a row a role
    // or a stack policy already resolved is dropped whole.
    beforePatch: (doc: any, safe: Record<string, any>) => guardClientResolution(doc, safe),
  },
  // Kept for backward compatibility with already-persisted generic edit
  // outbox rows. Current comment writes use named receipt-backed side effects;
  // everything structural remains immutable here.
  comments: {
    kind: "collection",
    ownerField: "user_id",
    editable: new Set(["content", "resolved_at"]),
  },
};

const PATCH_ONLY_ACTIONS = new Set([
  "answerDecision", "applyWorkbench", "clearCurrentConversation", "clearSelection",
  "clearSidePanelSession", "closeSidePanel", "closeTab", "deferSession",
  "initPagination", "injectSession", "killSession", "killSessions",
  "markKilling", "navigateToSession", "openSidePanel", "openTab",
  "patchConversation", "pinSession", "renameSession", "requestNavigate",
  "restoreSession", "saveCurrentTabState", "selectPanelSession", "setActiveBucketFilter",
  "setActiveProjectFilter", "setCloudSessionMode", "setCloudSharedCheckout", "setConversationAgent",
  "setConversationAgentDefinition", "setConversationModel", "setCurrentConversation", "setCurrentSession",
  "setIsolatedWorktreeMode", "setNavCollapsed", "setPagination", "setRecentProjects",
  "setSessionCharacter", "setSessionCharacters", "setSessionRest", "setViewingDismissedId",
  "snoozeSession", "stageCloseLeaf", "stageExpandLeaf", "stageFocusLeaf",
  "stageInsertLeaf", "stageMoveLeaf", "stageSetLeafPath", "stageSetSizes",
  "stashSession", "switchTab", "toggleBucketFilterTerm", "toggleCollapsedSection",
  "toggleFavorite", "toggleProjectFilterTerm", "toggleSidePanel", "touchMru",
  "updateClientDismissed", "updateSessionProject", "updateTab", "wakeSnoozedSession",
  "wsHide", "wsSetPresentation", "wsSetSize", "wsShow",
  "wsToggle",
]);

export function isDispatchAction(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(SIDE_EFFECTS, action) || PATCH_ONLY_ACTIONS.has(action);
}

export const dispatch = mutation({
  args: {
    action: v.string(),
    args: v.any(),
    patches: v.optional(v.any()),
    result: v.optional(v.any()),
    // Opt-in write acknowledgement (docs/architecture/sync-log-migration.md D8):
    // when set, the return value is wrapped as { __syncAckV1, result } carrying
    // the sync-log positions this transaction appended. Only new clients send
    // it, so the unwrapped shape old bundles rely on never changes.
    ack_positions: v.optional(v.boolean()),
  },
  handler: async (ctx, { action, args: actionArgs, patches, result, ack_positions }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const sideEffect = Object.prototype.hasOwnProperty.call(SIDE_EFFECTS, action) ? SIDE_EFFECTS[action] : undefined;
    if (!isDispatchAction(action)) throw new Error("Unknown dispatch action");

    // In final mode the receipt envelope is the one durable-write rail. Do not
    // also apply its compatibility patches as an independent server writer;
    // rollback builds omit the envelope and resume the legacy patch path.
    if (
      patches &&
      typeof patches === "object" &&
      !(hasReceiptCommandId(result) && RECEIPT_OWNS_SERVER_WRITE.has(action))
    ) {
      await applyPatches(ctx, userId, patches, { forceKill: EXPLICIT_KILL_ACTIONS.has(action) });
    }

    const out = sideEffect ? await sideEffect(ctx, userId, actionArgs, result) : undefined;
    if (ack_positions) {
      return { __syncAckV1: syncAckPositions(ctx), result: out };
    }
    return out;
  },
});

// A Convex document id is 32 base32 characters. The store's optimistic rows are
// keyed by shorter local stub ids until their server row supersedes them, and a
// stub reaching a mutation's `v.id()` validator is an argument error the outbox
// would then re-drive forever. Handlers that can receive one check first.
const SERVER_ID_RE = /^[a-z0-9]{32}$/;
function charterWire(fields: Record<string, any>): Record<string, any> {
  const { owner_role_id, ...rest } = fields;
  return owner_role_id === undefined ? rest : { ...rest, owner: owner_role_id };
}

function isServerId(value: unknown): value is string {
  return typeof value === "string" && SERVER_ID_RE.test(value);
}

type HandlerCtx = { db: any; storage?: any; runMutation?: any; runQuery?: any };
type HandlerFn = (ctx: HandlerCtx, userId: Id<"users">, args: any, result?: any) => Promise<any>;

type ReceiptActionEnvelope = {
  receiptActionVersion: 1;
  commandId: string;
  localResult?: unknown;
};

function receiptCommandId(action: string, result: unknown): string {
  const envelope = result as Partial<ReceiptActionEnvelope> | null;
  if (
    envelope?.receiptActionVersion !== 1 ||
    typeof envelope.commandId !== "string" ||
    !envelope.commandId
  ) {
    throw new Error(`${action} requires a durable command receipt id`);
  }
  return envelope.commandId;
}

function hasReceiptCommandId(result: unknown): result is ReceiptActionEnvelope {
  const envelope = result as Partial<ReceiptActionEnvelope> | null;
  return envelope?.receiptActionVersion === 1 &&
    typeof envelope.commandId === "string" &&
    envelope.commandId.length > 0;
}

const RECEIPT_OWNS_SERVER_WRITE = new Set([
  "createBucket",
  "updateBucket",
  "assignSessionToBucket",
  "addComment",
  "editComment",
  "deleteComment",
  "askAgentInThread",
  "sendMessage",
]);

function receiptLocalResult<T>(result: unknown): T {
  return (hasReceiptCommandId(result)
    ? result.localResult
    : result) as T;
}

function receiptOrLegacyCommandId(
  action: string,
  result: unknown,
  legacyCommandId: string,
): string {
  if (hasReceiptCommandId(result)) return receiptCommandId(action, result);
  const payload = result as { commandId?: unknown } | null;
  return typeof payload?.commandId === "string" && payload.commandId
    ? payload.commandId
    : legacyCommandId;
}

type DurableCreateContinuation =
  | { version: 1; kind: "navigate" }
  | { version: 1; kind: "assignBucket"; conversationIds: string[] };

function validatedCreateContinuation(
  action: string,
  result: unknown,
): DurableCreateContinuation | null {
  if (!hasReceiptCommandId(result)) return null;
  const localResult = result.localResult;
  if (!localResult || typeof localResult !== "object") return null;
  const raw = (localResult as { continuation?: unknown }).continuation;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid ${action} continuation`);
  }
  const continuation = raw as Record<string, unknown>;
  if (
    continuation.version === 1 &&
    continuation.kind === "navigate" &&
    (action === "createDoc" ||
      action === "createPlan" ||
      action === "createProject")
  ) {
    return { version: 1, kind: "navigate" };
  }
  if (
    continuation.version === 1 &&
    continuation.kind === "assignBucket" &&
    action === "createBucket" &&
    Array.isArray(continuation.conversationIds) &&
    continuation.conversationIds.length > 0 &&
    continuation.conversationIds.length <= 100 &&
    continuation.conversationIds.every(
      (id) => typeof id === "string" && id.length > 0,
    )
  ) {
    return {
      version: 1,
      kind: "assignBucket",
      conversationIds: [...new Set(continuation.conversationIds as string[])],
    };
  }
  throw new Error(`Invalid ${action} continuation`);
}

async function runReceiptBackedCreate(
  ctx: HandlerCtx,
  userId: Id<"users">,
  input: {
    action: string;
    commandName: string;
    arguments: unknown;
    result: unknown;
    create: () => Promise<unknown>;
  },
) {
  return await runLocalCommand(ctx as any, {
    principalId: userId,
    commandId: receiptCommandId(input.action, input.result),
    commandName: input.commandName,
    arguments: input.arguments,
  }, async () => ({
    status: "acknowledged",
    result: await input.create(),
    // Docs/plans/projects still use their legacy paginated sync surfaces. The
    // receipt provides exact create dedupe/result recovery; those lists do not
    // yet expose a revision or command-id coverage contract to name here.
    coverageViews: [],
  }));
}

function deepMergeField(existing: any, incoming: any): any {
  if (
    incoming && typeof incoming === "object" && !Array.isArray(incoming) &&
    existing && typeof existing === "object" && !Array.isArray(existing)
  ) {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(existing)) {
      if (v !== null && v !== undefined) result[k] = v;
    }
    for (const [k, v] of Object.entries(incoming)) {
      if (v === null || v === undefined) delete result[k];
      else result[k] = v;
    }
    return result;
  }
  return incoming;
}

// The hide-transition decision + side effects live in cleanup.ts
// (classifyHideTransition / applyHideTransition), shared with the CLI
// visibility mutation. Re-exported here for the existing tests.
export { classifyHideTransition } from "./cleanup";

// The web's explicit kill gestures (inboxStore killSession / killSessions). A
// kill patch is indistinguishable at the FIELD level from a quiet re-assert of
// the same flag — a stub-rekey flushResolvedSessionFields, an applyUndoPatches
// replay — so the dispatched ACTION NAME is the only signal of intent the
// server gets, and a kill must tear down again even when the flag is already
// set (see applyHideTransition's forceKill). Every other action patching
// inbox_dismissed_at stays transition-gated.
const EXPLICIT_KILL_ACTIONS = new Set(["killSession", "killSessions"]);

// Exported for tests (the dispatch mutation is the only runtime caller).
export async function applyPatches(
  ctx: HandlerCtx,
  userId: Id<"users">,
  patches: Record<string, Record<string, Record<string, any>>>,
  opts?: { forceKill?: boolean }
) {
  let bucketViewChanged = false;
  for (const [table, docs] of Object.entries(patches)) {
    const config = Object.prototype.hasOwnProperty.call(TABLE_CONFIG, table) ? TABLE_CONFIG[table] : undefined;
    if (!config) continue;

    for (const [docKey, fields] of Object.entries(docs)) {
      const safe: Record<string, any> = {};
      for (const [k, val] of Object.entries(fields)) {
        if (config.editable.has(k)) safe[k] = val === null ? undefined : val;
      }
      if (Object.keys(safe).length === 0) continue;

      if (config.kind === "collection") {
        const documentId = ctx.db.normalizeId(table, docKey);
        if (!documentId) continue;
        const doc = await ctx.db.get(documentId);
        // Conversations: the second-party owner triages (dismiss/pin/stash)
        // an assigned session from their inbox exactly like the runner would.
        // owner_user_id itself is immutable here — assignment goes through the
        // validated setSessionOwner mutation only.
        let permitted = !!doc && (
          (doc as any)[config.ownerField] === userId ||
          (table === "conversations" && (doc as any).owner_user_id?.toString() === userId.toString()) ||
          // A decision is answerable by every person it was asked of
          // (docs/architecture/decisions-as-documents.md D6), not only the
          // asking session's owner.
          (table === "session_decisions" && personMayResolve(doc as any, userId))
        );
        // owner_user_id caches only the PRIMARY (first-added) owner; a SECONDARY
        // owner's triage patch must resolve through the canonical owner set or
        // it silently drops and the reconcile resurrects their dismiss forever.
        if (!permitted && doc && table === "conversations") {
          permitted = await isSessionOwner(ctx, doc._id as Id<"conversations">, userId);
        }
        if (!permitted) continue;
        if (table === "session_decisions" && safe.status !== "answered" && safe.status !== "dismissed") continue;
        const finalSafe = config.beforePatch ? config.beforePatch(doc, { ...safe }) : safe;
        // Favorite membership belongs to the conversation's runner principal,
        // not to second-party inbox owners. Those owners may triage the row but
        // cannot mutate somebody else's favorites relation.
        if (
          table === "conversations"
          && "is_favorite" in finalSafe
          && String(doc.user_id) !== String(userId)
        ) {
          delete finalSafe.is_favorite;
        }
        // inbox_killed_at is the retired marker: the daemon's reap/resurrection
        // gate and classifyWorkState both read it, and a killed persistent
        // anchor stays daemon-proof only while it's set. This generic rail
        // carries whatever fields an action's draft happened to touch, so a
        // gesture with nothing to do with revival can wipe it — the web's pin
        // nulls it in its draft (see ct-41083), which deleted the marker on the
        // very rows it matters most for (a killed row is only visible while
        // pinned, per shouldShowInInbox). Guard by FIELD, not by action name, so
        // an old client shipping the same patch is caught too: a CLEAR is
        // honored only when the patch is itself an un-kill (it clears
        // inbox_dismissed_at as well). The other sanctioned revivals — a human
        // send (pendingMessages.enqueue), delivery, Restart — are mutations and
        // never ride this rail. SETTING it is untouched.
        if (
          table === "conversations"
          && "inbox_killed_at" in finalSafe
          && !(finalSafe as any).inbox_killed_at
          && !("inbox_dismissed_at" in finalSafe && !(finalSafe as any).inbox_dismissed_at)
        ) {
          delete (finalSafe as any).inbox_killed_at;
        }
        // The pinned window is capped (conversations.INBOX_PINNED_CAP). This rail
        // carries whole drafts, and a thrown error would fail the outbox entry
        // (and every sibling patch in it) rather than one gesture — so the pin
        // is dropped here and the server echo reverts the optimistic pin; the
        // explicit patchConversation mutation refuses with the clear error.
        if (table === "conversations" && await pinCapExceeded(ctx, userId, doc as any, finalSafe)) {
          console.warn(`[dispatch] ${PIN_CAP_ERROR} (dropped pin on ${docKey})`);
          delete (finalSafe as any).inbox_pinned_at;
        }
        if (Object.keys(finalSafe).length === 0) continue;
        // Capture the PRE-patch hide state. The un-kill mirror below decides on
        // what the row looked like BEFORE this write, and reading it afterwards
        // would depend on ctx.db.get having handed back a snapshot rather than
        // the row the patch mutates.
        const wasDismissed = table === "conversations" && !!(doc as any).inbox_dismissed_at;
        const wasKilled = table === "conversations" && !!(doc as any).inbox_killed_at;
        if (table === "comments") {
          const conversation = await ctx.db.get(doc.conversation_id as Id<"conversations">);
          if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) continue;
          if ("resolved_at" in finalSafe) finalSafe.resolved_by = finalSafe.resolved_at ? userId : undefined;
          await patchCommentWithRevision(ctx as any, doc as any, finalSafe as any, conversation as any);
        } else if (table === "conversations" && "is_favorite" in finalSafe) {
          await patchConversationThroughFavoriteView(ctx as any, doc as any, finalSafe as any, "advance");
        } else {
          await ctx.db.patch(documentId, finalSafe);
        }
        if (table === "inbox_buckets") bucketViewChanged = true;
        // A decision resolved from the web: the same side effects a server
        // answer carries (inbox rows done, stack close, override scoring).
        if (table === "session_decisions" && "status" in finalSafe) {
          await settleClientResolution(ctx, doc as any, finalSafe as any, userId, Date.now());
        }
        // Lifecycle hooks on the DATA transition (a conversation patch setting
        // inbox_dismissed_at / inbox_stashed_at), not any one action, so every
        // dismiss/stash path funnels through here — the inbox shortcuts, the
        // palette, the /sessions toggle (patchConversation), and any future one.
        if (table === "conversations" && ((finalSafe as any).inbox_dismissed_at || (finalSafe as any).inbox_stashed_at)) {
          await applyHideTransition(ctx, doc, finalSafe as any, { forceKill: opts?.forceKill });
        }
        // The un-kill mirror: a patch CLEARING either hide stamp on a row that
        // had it is the restore/undo gesture (web restoreSession, the /sessions
        // restore, undo of a kill) — re-arm the schedules the kill canceled, or
        // the user gets their session back with its standing loop silently dead.
        // Only tasks stamped canceled_on_kill_at re-arm; natural completions
        // stay done. Same two scans as the kill: the runner's schedules, plus
        // the caller's when a second-party owner is restoring.
        //
        // BOTH stamps have to count, because the two kill surfaces do not write
        // the same fields: applyHideTransition (cast kill, dismiss→kill) stamps
        // inbox_dismissed_at AND inbox_killed_at, but the killSession command
        // stamps the marker ALONE. Keying on the dismissed stamp only meant
        // restoring a command-killed row cleared its marker and brought the card
        // back while its schedules stayed dead. This does not widen WHO may
        // un-kill: the guard above already stripped inbox_killed_at from the
        // patch unless it is un-kill-shaped, so a clear reaching here passed it.
        //
        // It does widen WHAT an un-kill does, on one path: a command-killed row
        // restored by a second-party OWNER now re-arms the RUNNER's schedules
        // (the first reactivate call below scans doc.user_id, not the caller).
        // That is deliberate and symmetric — the owner already had exactly this
        // effect on the dismissed path, and the schedules a kill canceled are
        // the runner's by construction, so restoring without them would hand
        // back a session whose standing loop is silently dead.
        const clearsDismissed =
          "inbox_dismissed_at" in (finalSafe as any) && !(finalSafe as any).inbox_dismissed_at;
        const clearsKilled =
          "inbox_killed_at" in (finalSafe as any) && !(finalSafe as any).inbox_killed_at;
        if (
          table === "conversations" &&
          ((clearsDismissed && wasDismissed) || (clearsKilled && wasKilled))
        ) {
          // Un-kill the row server-side. The web's restore gesture only nulls
          // the two hide stamps, but shouldShowInInbox hides a row on
          // inbox_killed_at alone — so without this the restored session stays
          // invisible unless it happens to be pinned. Doing it here (rather than
          // trusting a client to send the field) also keeps old clients working
          // and matches `cast undismiss`. `status` is left alone: restore brings
          // the CARD back, Restart brings the agent back.
          if (wasKilled) {
            await ctx.db.patch(doc._id as Id<"conversations">, { inbox_killed_at: undefined });
          }
          await reactivateTasksCanceledOnKill(ctx, (doc as any).user_id, doc._id as Id<"conversations">);
          if ((doc as any).user_id?.toString() !== userId.toString()) {
            await reactivateTasksCanceledOnKill(ctx, userId, doc._id as Id<"conversations">);
          }
        }
      } else {
        const existing = await ctx.db
          .query(table as any)
          .withIndex(config.lookupIndex, (q: any) =>
            q.eq(config.ownerField, userId)
          )
          .first();
        if (existing) {
          const merged: Record<string, any> = {};
          for (const [k, v] of Object.entries(safe)) {
            merged[k] = deepMergeField((existing as any)[k], v);
          }
          await ctx.db.patch(existing._id, { ...merged, updated_at: Date.now() });
        } else {
          await ctx.db.insert(table as any, {
            [config.ownerField]: userId,
            ...safe,
            updated_at: Date.now(),
          });
        }
      }
    }
  }
  if (bucketViewChanged) {
    await advanceLocalViewRevision(
      ctx as any,
      userId,
      BUCKETS_VIEW_CONTRACT_ID,
      BUCKETS_VIEW_KEY,
    );
  }
}

async function linkConversationToObject(
  ctx: HandlerCtx,
  userId: Id<"users">,
  objectType: string,
  objectId: string,
  conversationId: Id<"conversations">,
): Promise<void> {
  const conv = await ctx.db.get(conversationId);
  if (!conv || conv.user_id.toString() !== userId.toString()) {
    throw new Error("Unauthorized");
  }

  if (objectType === "doc") {
    const doc = await ctx.db.get(objectId as Id<"docs">);
    if (!doc || doc.user_id.toString() !== userId.toString()) return;
    const existing = doc.related_conversation_ids || (doc.conversation_id ? [doc.conversation_id] : []);
    if (!existing.some((id: any) => id.toString() === conversationId.toString())) {
      await ctx.db.patch(objectId as Id<"docs">, {
        related_conversation_ids: [...existing, conversationId],
      });
    }
    return;
  }

  if (objectType === "task") {
    const task = await ctx.db.get(objectId as Id<"tasks">);
    if (!task) return;
    if (task.user_id.toString() !== userId.toString()) {
      if (!task.team_id) return;
      const membership = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", task.team_id))
        .first();
      if (!membership) return;
    }
    await ctx.db.patch(conversationId, {
      active_task_id: objectId as Id<"tasks">,
    });
    // The list append and the association rail (best-effort; legacy fields
    // stay authoritative) are one helper — see conversationLinks.ts.
    await addConversationToWorkItem(ctx, userId, "task", task, conversationId);
    return;
  }

  if (objectType === "plan") {
    const plan = await ctx.db.get(objectId as Id<"plans">);
    if (!plan || plan.user_id.toString() !== userId.toString()) return;
    await addConversationToWorkItem(ctx, userId, "plan", plan, conversationId);
    return;
  }
}

const SIDE_EFFECTS: Record<string, HandlerFn> = {
  // Decisions (docs/architecture/decisions-as-documents.md D2 / D5). The web
  // patches sessionDecisions and decisionStacks on the draft first; these are
  // the server writes the optimistic rows reconcile against.
  reopenDecision: async (ctx, userId, [decisionId]: [string]) => reopenCore(ctx, userId, decisionId as Id<"session_decisions">),
  reorderStack: async (ctx, userId, [stackId, decisionIds]: [string, string[]]) =>
    reorderStackCore(ctx, userId, stackId, decisionIds as Id<"session_decisions">[]),
  removeFromStack: async (ctx, userId, [stackId, decisionId]: [string, string]) => removeFromStackCore(ctx, userId, stackId, decisionId),
  setStackPolicy: async (ctx, _userId, [stackId, args]: [string, Record<string, any>]) => ctx.runMutation!((api as any).decisionStacks.setStackPolicy, { stack: stackId, ...args }),
  createStackWith: async (ctx, userId, [input]: [{ title: string; decision_ids: string[]; team_id?: string; client_key?: string }]) =>
    createStackWithCore(ctx, userId, {
      title: input.title,
      decision_ids: input.decision_ids,
      team_id: input.team_id as Id<"teams"> | undefined,
      client_key: input.client_key,
    }),
  // Org roles (docs/architecture/org-roles.md S5/S6). The web patches the
  // `orgTree` store singleton optimistically; that snapshot is not a dispatch
  // table, so these named effects are the only server write. The functions
  // live in orgRoles.ts; `api` is widened so this file compiles before that
  // module exists in a given checkout.
  // One reparent path (org-staffing.md S11): the chart drag AND the ownership
  // menu (take ownership, add or remove an owner, move to a role) both reach
  // the core through here. `target` carries the owner-set arithmetic
  // ({ owners, mode }) or a role; `note` rides the reparent into the line the
  // session and role are told.
  reparentOrgSession: async (ctx, _userId, [conversationId, target, opts]: [string, any, { note?: string; from_session?: string } | undefined]) => {
    return await ctx.runMutation!((api as any).orgRoles.reparentSession, {
      conversation_id: conversationId,
      target,
      ...(opts?.note ? { note: opts.note } : {}),
      ...(opts?.from_session ? { from_session: opts.from_session } : {}),
    });
  },
  reparentOrgRole: async (ctx, _userId, [roleId, reportsTo, note]: [string, any, string | undefined]) => {
    return await ctx.runMutation!((api as any).orgRoles.reparent, { role_id: roleId, reports_to: reportsTo, ...(note ? { note } : {}) });
  },
  createOrgRole: async (ctx, _userId, [input]: [any]) => {
    // The hire form (org-init.md O3) creates and provisions in one gesture and
    // may set caps; the plain add-a-role path passes neither. Caps have their
    // own human-only mutation, so they ride a second call.
    const role = await ctx.runMutation!((api as any).orgRoles.create, {
      name: input.name,
      handle: input.handle,
      ...(input.team_id ? { team_id: input.team_id } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.reports_to ? { reports_to: input.reports_to } : {}),
      ...(input.charter ? { charter: input.charter } : {}),
      // Standing or program (S10) and the face (S13) ride the create.
      ...(input.tenure ? { tenure: input.tenure } : {}),
      ...(input.avatar ? { avatar: input.avatar } : {}),
      ...(input.provision ? { provision: true, project_path: input.project_path } : {}),
      ...(input.adopt_conversation_id ? { adopt_conversation_id: input.adopt_conversation_id } : {}),
      // The person's one edit on a hire with projects (R1).
      ...(input.leave_sessions ? { leave_sessions: true } : {}),
    });
    if (input.caps && role?._id) {
      await ctx.runMutation!((api as any).orgRoles.setCaps, { role_id: String(role._id), hands: input.caps.hands_per_day, wakes: input.caps.wakes_per_day, tokens: input.caps.tokens_per_day });
    }
    return role;
  },
  // `opts.leave_sessions` is the person's one edit on a scope that gains refs
  // (R1): the scope lands and the sessions in it stay with their owner.
  updateOrgRole: async (ctx, _userId, [roleId, fields, opts]: [string, any, { leave_sessions?: boolean } | undefined]) => {
    // A pause or resume is the standing agent's (org-roles-standing.md T4):
    // hands get their interrupt and held wakes flush, which a bare status
    // patch would skip. Trust and caps have their own human-only mutations.
    if (fields.status === "paused") await ctx.runMutation!((api as any).orgRoles.pause, { role_id: roleId });
    else if (fields.status === "active") await ctx.runMutation!((api as any).orgRoles.resume, { role_id: roleId });
    if (fields.trust !== undefined) await ctx.runMutation!((api as any).orgRoles.setTrust, { role_id: roleId, trust: fields.trust });
    if (fields.caps !== undefined) {
      await ctx.runMutation!((api as any).orgRoles.setCaps, { role_id: roleId, hands: fields.caps.hands_per_day, wakes: fields.caps.wakes_per_day, tokens: fields.caps.tokens_per_day });
    }
    // Who reports to the role (org-roles-run-work.md R6): the tab wrote the
    // whole list, and the mutation takes the difference against its own row.
    if (fields.reports_user_ids !== undefined) await ctx.runMutation!((api as any).orgRoles.setReports, { role_id: roleId, set: fields.reports_user_ids });
    const rest: Record<string, any> = { ...fields };
    delete rest.trust; delete rest.caps; delete rest.reports_user_ids;
    if (rest.status === "paused" || rest.status === "active") delete rest.status;
    // tenure (S10) and avatar (S13) go through the plain update.
    if (!["name", "handle", "scope", "charter", "status", "tenure", "avatar"].some((k) => rest[k] !== undefined)) return null;
    fields = rest;
    return await ctx.runMutation!((api as any).orgRoles.update, {
      role_id: roleId,
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
      ...(fields.scope !== undefined ? { scope: fields.scope, ...(opts?.leave_sessions ? { leave_sessions: true } : {}) } : {}),
      ...(fields.charter !== undefined ? { charter: fields.charter } : {}),
      ...(fields.status !== undefined ? { status: fields.status } : {}),
      ...(fields.tenure !== undefined ? { tenure: fields.tenure } : {}),
      ...(fields.avatar !== undefined ? { avatar: fields.avatar } : {}),
    });
  },
  // The scope's line (the-line.md L2): human only, logged, wakes the role.
  setRoleLine: async (ctx, _userId, [roleId, slug]: [string, string]) => {
    return await ctx.runMutation!((api as any).orgRoles.setLine, { role_id: roleId, slug });
  },
  // A role following a chat channel (agent-channels.md C1). orgChannels
  // resolves the role by short id or handle and checks the admin grant.
  followOrgChannel: async (ctx, _userId, [roleShortId, channelId, follow]: [string, string, boolean]) => {
    if (!isServerId(channelId)) return;
    return await ctx.runMutation!((api as any).orgChannels[follow ? "follow" : "unfollow"], {
      role: roleShortId,
      channel: channelId,
    });
  },
  retireOrgRole: async (ctx, _userId, [roleId, standingSession]: [string, "keep" | "retire" | undefined]) => {
    // S16: what becomes of the seat's standing agent. Absent lets the server
    // choose (keep for the chief of staff, retire for any other seat).
    return await ctx.runMutation!((api as any).orgRoles.retire, { role_id: roleId, ...(standingSession ? { standing_session: standingSession } : {}) });
  },
  // Staffing (org-staffing.md S4/S6). The web pushes a role stub for the
  // chief of staff and flips a proposal's changes to accepted on the draft;
  // these are the server writes those rows reconcile against.
  staffChiefOfStaff: async (ctx, _userId, [input]: [any]) => {
    return await ctx.runMutation!((api as any).orgRoles.staff, {
      ...(input.team_id ? { team_id: input.team_id } : {}),
      ...(input.adopt_conversation_id ? { adopt_conversation_id: input.adopt_conversation_id } : {}),
      ...(input.project_path ? { project_path: input.project_path } : {}),
      // S16: seat the existing standing agent (default) or start a fresh one.
      ...(input.seat ? { seat: input.seat } : {}),
    });
  },
  // `seen` (org-staffing.md S18): what the page showed when the verdict was
  // pressed; the mutation refuses a verdict the author revised under the reader.
  decideOrgProposalChange: async (ctx, _userId, [changeId, verdict, edits, seen]: [string, "accept" | "skip", any, { revised_at: number; seqs?: number[] } | undefined]) => {
    return await ctx.runMutation!((api as any).orgProposals.decide, {
      change_id: changeId,
      verdict,
      ...(edits && Object.keys(edits).length > 0 ? { edits } : {}),
      ...(seen ? { seen } : {}),
    });
  },
  // Withdraw from the pane (S4 supersession: the person takes the replaced
  // proposal down; the human gate on the mutation is what allows it).
  withdrawOrgProposal: async (ctx, _userId, [proposalRef]: [string]) => {
    return await ctx.runMutation!((api as any).orgProposals.withdraw, { proposal: proposalRef });
  },
  acceptAllOrgProposal: async (ctx, _userId, [proposalId, opts]: [string, { kinds?: string[]; seen?: { revised_at: number; seqs?: number[] } } | undefined]) => {
    const kinds = Array.isArray(opts?.kinds) && opts!.kinds!.length > 0 ? opts!.kinds : undefined;
    return await ctx.runMutation!((api as any).orgProposals.acceptAll, { proposal: proposalId, ...(kinds ? { kinds } : {}), ...(opts?.seen ? { seen: opts.seen } : {}) });
  },
  // One ask of a proposal, accepted or skipped whole (org-staffing.md S19):
  // `ask` is the position the card had and `seen` what the page had painted
  // (the latest revise, the card's seqs); the mutation reads the verdict
  // against that and refuses one the author revised under the reader.
  decideOrgProposalAsk: async (ctx, _userId, [proposalId, ask, verdict, seen, opts]: [string, number, "accept" | "skip", { revised_at: number; seqs?: number[] } | undefined, { leave_sessions?: boolean } | undefined]) => {
    return await ctx.runMutation!((api as any).orgProposals.decideAsk, { proposal: proposalId, ask, verdict, ...(seen ? { seen } : {}), ...(opts?.leave_sessions && verdict === "accept" ? { leave_sessions: true } : {}) });
  },
  // Take an entry of the org record back, or apply it again (org-staffing.md
  // S21). `with` names the later entries the preview said go with it: the
  // mutation undoes them together or refuses the gesture. Human only; the
  // mutation's own gate is what refuses a session.
  undoOrgChange: async (ctx, _userId, [batch, opts]: [string, { with?: string[] } | undefined]) => {
    return await ctx.runMutation!((api as any).orgChanges.undo, { batch, ...(opts?.with?.length ? { with: opts.with } : {}) });
  },
  redoOrgChange: async (ctx, _userId, [batch, opts]: [string, { with?: string[] } | undefined]) => {
    return await ctx.runMutation!((api as any).orgChanges.redo, { batch, ...(opts?.with?.length ? { with: opts.with } : {}) });
  },
  // Capability bindings ride dispatch as NAMED side effects, never as generic
  // table patches: applyPatches drops any table missing from TABLE_CONFIG with
  // no error, so a generic patch to capability_bindings would silently not
  // stick. Both call the one exported upsert, so the optimistic path and the
  // CLI mutation cannot diverge on the upsert key.
  setCapabilityBinding: async (ctx, userId, [opts]: [any]) => {
    return await upsertBinding(ctx, userId as unknown as string, {
      capability_slug: opts.capability_slug,
      scope_kind: opts.scope_kind,
      scope_key: opts.scope_key ?? "",
      enabled: !!opts.enabled,
      config: opts.config,
      client_filter: opts.client_filter,
      client_key: opts.client_key,
      team_id: opts.team_id,
    });
  },
  createCapabilityBinding: async (ctx, userId, [opts]: [any]) => {
    return await upsertBinding(ctx, userId as unknown as string, {
      capability_slug: opts.capability_slug,
      scope_kind: opts.scope_kind,
      scope_key: opts.scope_key ?? "",
      enabled: opts.enabled !== false,
      config: opts.config,
      client_filter: opts.client_filter,
      client_key: opts.client_key,
      team_id: opts.team_id,
    });
  },
  flushResolvedSessionFields: async (
    ctx,
    userId,
    [conversationId, fields]: [string, Record<string, any>],
  ) => {
    // Reuse the generic conversation patch gate so ownership, immutable fields,
    // null tombstones, and secondary-owner rules stay identical to ordinary
    // local-first patches. The named action exists solely to make the
    // stub→real flush durable in the legacy outbox.
    await applyPatches(ctx, userId, {
      conversations: { [conversationId]: fields || {} },
    });
  },

  applyUndoPatches: async (
    ctx,
    userId,
    [patches]: [Record<string, Record<string, Record<string, any>>>],
  ) => {
    // Undo values use the same allowlists, ownership checks, immutable-field
    // filtering, and null-tombstone semantics as ordinary optimistic patches.
    await applyPatches(ctx, userId, patches || {});
  },

  updateClientUI: async (ctx, userId, _args, result) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    // `result` is the exact client-stamped partial. Replaying it preserves LWW
    // time and still lands when the local value was already equal (and thus
    // action() generated no automatic patch).
    await applyPatches(ctx, userId, {
      client_state: { _: { ui: result as Record<string, any> } },
    });
  },

  saveView: async (ctx, userId, _args, result) => {
    if (!Array.isArray(result)) return;
    await applyPatches(ctx, userId, {
      client_state: { _: { ui: { saved_views: result } } },
    });
  },

  deleteView: async (ctx, userId, _args, result) => {
    if (!Array.isArray(result)) return;
    await applyPatches(ctx, userId, {
      client_state: { _: { ui: { saved_views: result } } },
    });
  },

  updateClientLayout: async (
    ctx,
    userId,
    [key, value]: [string, any],
  ) => {
    if (typeof key !== "string" || !key) return;
    await applyPatches(ctx, userId, {
      client_state: { _: { layouts: { [key]: value } } },
    });
  },

  persistClientTips: async (
    ctx,
    userId,
    [partial]: [Record<string, any>],
  ) => {
    // `_inlineSuppressed` is deliberately removed by the client wrapper. Build
    // the singleton patch here so its exact local update can remain one sync()
    // while this cross-device subset still rides a named durable action.
    await applyPatches(ctx, userId, {
      client_state: { _: { tips: partial || {} } },
    });
  },

  clearDraftFinal: async (ctx, userId, [conversationId]: [string]) => {
    if (typeof conversationId !== "string" || !conversationId) return;
    await applyPatches(ctx, userId, {
      client_state: { _: { drafts: { [conversationId]: null } } },
    });
    // The conversation row is the draft's second durable home (mobile persists
    // straight to conversations.draft_message). Clear it here too, so a send
    // doesn't depend on a fire-and-forget patchConversation that a live push
    // can race — or that throws outright on a session the user doesn't own.
    const convId = ctx.db.normalizeId("conversations", conversationId);
    const conv = convId ? await ctx.db.get(convId) : null;
    if (conv && conv.user_id === userId && conv.draft_message != null) {
      await ctx.db.patch(conv._id, { draft_message: undefined });
    }
  },

  switchProject: async (ctx, userId, [convId, path]: [string, string]) => {
    const conv = await ctx.db.get(convId as Id<"conversations">);
    if (!conv || conv.user_id !== userId) throw new Error("Not authorized");
    await ctx.db.patch(convId as Id<"conversations">, {
      project_path: path,
      git_root: path,
    });
    const now = Date.now();
    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "kill_session" as const,
      args: JSON.stringify({ conversation_id: convId }),
      created_at: now,
    });
    const daemonType = fromConvexAgentType(conv.agent_type);
    await enqueueStartSession(ctx, userId, {
      conversationId: convId as Id<"conversations">,
      agentType: daemonType,
      projectPath: path,
      gitRoot: path,
      createdAt: now + 1,
    });
  },

  createSession: async (ctx, userId, [opts]: [{ agent_type?: string; project_path?: string; git_root?: string; session_id?: string; linked_object?: { type: string; id: string }; model?: string; effort?: string; isolated?: boolean; worktree_name?: string; stable_mode?: string; stable_exclude?: string[]; target_device_id?: string; cloud_device_id?: string; cloud_workspace?: string; cloud_start_from?: string; agent_definition?: string }]) => {
    const sessionId = opts.session_id || crypto.randomUUID();
    // Dispatch args are v.any(): the mode and the seed choice are normalised at the boundary.
    const cloudWorkspace = normalizeCloudWorkspace(opts.cloud_workspace);
    const cloudStartFrom = effectiveStartFrom(cloudWorkspace, opts.cloud_start_from, undefined);
    // Idempotent on (user, session_id). The optimistic web client keys a New
    // Session by a client-minted stub id and passes it as session_id, then
    // waits for this conversation to sync back and supersede the stub. That
    // create can legitimately arrive more than once for the same session_id:
    // the dispatch outbox re-fires across reloads (MAX_OUTBOX_BOOT_ATTEMPTS),
    // and the client's stuck-stub heal re-issues it when the first attempt was
    // given up. Returning the existing row instead of inserting a duplicate
    // avoids stranding twin conversations (the fork-resume doppelganger class)
    // and is what makes client-side re-create safe. Skips the rate limit too —
    // reviving an already-created session shouldn't count against the quota.
    if (opts.session_id) {
      const existing = await findConversationBySessionReference(ctx, sessionId, userId)
        ?? await findAgentBoxSessionCreatedBy(ctx, sessionId, userId);
      if (existing) {
        // Older ContextChat created first and linked in a second dispatch. If
        // that follow-up was lost, an idempotent replay must repair the source
        // relation instead of returning before it has a chance to converge.
        if (opts.linked_object?.id) {
          await linkConversationToObject(
            ctx,
            userId,
            opts.linked_object.type,
            opts.linked_object.id,
            existing._id,
          );
        }
        return existing._id;
      }
    }
    await checkRateLimit(ctx as any, userId, "createConversation");
    const now = Date.now();
    // The compose bar's "as <definition>" pick: the definition's client, model
    // and effort fill whatever the row left unset, and the rest of it (tools,
    // prompt, mode, worktree) rides the start command to the daemon.
    const asDef = await resolveSpawnDefinition(ctx, userId, opts.agent_definition, {
      agentType: opts.agent_type,
      model: opts.model,
      effort: opts.effort,
      isolated: opts.isolated,
    });
    if (asDef.definition) {
      opts = { ...opts, agent_type: asDef.agentType ?? opts.agent_type, model: asDef.model, effort: asDef.effort, isolated: asDef.isolated };
    }
    const agentType = (opts.agent_type || "claude_code") as ConvexAgentType;
    const runnerUserId = await sessionLaunchRunner(ctx, userId, opts.target_device_id);
    // "Run in the cloud" names one of the RUNNER's own wake-on-use hosts; an
    // agent box (runner ≠ caller) or a foreign/laptop device id is refused
    // before any row exists.
    if (opts.cloud_device_id) await resolveCloudDevice(ctx, runnerUserId, opts.cloud_device_id);

    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();

    // Resolve project_path from linked task (or its team mapping) before falling back to client-supplied path.
    let resolvedProjectPath = opts.project_path;
    let resolvedGitRoot = opts.git_root;
    let resolvedGitRemoteUrl: string | undefined = undefined;
    let linkedTask: any = null;
    if (opts.linked_object?.type === "task" && opts.linked_object.id) {
      try {
        linkedTask = await ctx.db.get(opts.linked_object.id as Id<"tasks">);
      } catch { linkedTask = null; }
      if (linkedTask) {
        const hasAccess = linkedTask.user_id.toString() === userId.toString()
          || (linkedTask.team_id && !!(await ctx.db
              .query("team_memberships")
              .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", linkedTask.team_id))
              .first()));
        if (!hasAccess) {
          linkedTask = null;
        } else {
          // Resolve project_path/git_root/git_remote_url from the task. Shared
          // with tasks.assignToAgent so both task-launch paths route identically.
          const resolved = await resolveTaskGitContext(ctx, userId, linkedTask, mappings, {
            project_path: resolvedProjectPath,
            git_root: resolvedGitRoot,
          });
          resolvedProjectPath = resolved.project_path;
          resolvedGitRoot = resolved.git_root;
          resolvedGitRemoteUrl = resolved.git_remote_url;
        }
      }
    }

    const conversationPath = resolvedGitRoot || resolvedProjectPath;
    let { teamId: resolvedTeamId, isPrivate, autoShared } = resolveTeamForPath(
      mappings,
      conversationPath,
      linkedTask?.team_id
    );
    // Nest orchestration workers under their plan's creator session so they
    // don't clutter the top-level inbox. The plan is found via a linked task
    // or a directly-linked plan; resolveWorkerParentConversation only returns
    // a parent that the inbox will actually render the child under.
    const workerPlanId: Id<"plans"> | undefined =
      (linkedTask?.plan_id as Id<"plans"> | undefined) ??
      (opts.linked_object?.type === "plan" && opts.linked_object.id
        ? (opts.linked_object.id as Id<"plans">)
        : undefined);
    const parentConversationId = await resolveWorkerParentConversation(ctx, userId, workerPlanId);

    const conversationId = await ctx.db.insert("conversations", {
      user_id: runnerUserId,
      ...(runnerUserId !== userId ? { author_user_id: userId } : {}),
      team_id: resolvedTeamId,
      agent_type: agentType,
      session_id: sessionId,
      project_path: resolvedProjectPath,
      git_root: resolvedGitRoot,
      ...(resolvedGitRemoteUrl ? { git_remote_url: resolvedGitRemoteUrl } : {}),
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: isPrivate,
      auto_shared: autoShared || undefined,
      status: "active" as const,
      ...(linkedTask ? { active_task_id: linkedTask._id } : {}),
      // Stamp the plan so the inbox can group plan workers even without a viable
      // parent session to nest under (the grouping fallback).
      ...(workerPlanId ? { active_plan_id: workerPlanId } : {}),
      ...(parentConversationId
        ? { parent_conversation_id: parentConversationId, is_subagent: true }
        : {}),
      // "Run in the cloud": park the row on the host before anything is queued.
      // The same pair createQuickSession stamps — the web's deferred create just
      // reaches this side effect instead of that mutation.
      ...(opts.cloud_device_id
        ? { owner_device_id: opts.cloud_device_id, cloud_placement: "pending" as const, cloud_workspace: cloudWorkspace, cloud_start_from: cloudStartFrom }
        : {}),
    });

    await ctx.db.patch(conversationId, { short_id: conversationId.toString().slice(0, 7) });
    await retainSessionCreator(ctx, conversationId, userId, runnerUserId);

    // Context-launched sessions keep their source relation in the SAME
    // transaction as creation. A parked asyncAction has no later Promise result
    // for the client to hang a link continuation from, so post-create linking
    // would lose doc/plan context across an unwired window.
    if (opts.linked_object?.id) {
      await linkConversationToObject(
        ctx,
        userId,
        opts.linked_object.type,
        opts.linked_object.id,
        conversationId,
      );
    }

    const daemonType = fromConvexAgentType(agentType);
    // Per-session model/effort (validated against the shared contract; "default"
    // = omit). Stamped on the conversation so the badge is right from t=0 — the
    // rollup confirms/corrects from the first turn's switch echo or model field.
    const modelOpt = opts.model ? findModelOption(agentType, opts.model) : undefined;
    const effortOk = opts.effort && AGENT_MODEL_CONFIG[modelAgentKey(agentType)]?.efforts.includes(opts.effort);
    const requestedModel = modelOpt?.cliAlias ? modelOpt.key : undefined;
    if (requestedModel || effortOk) {
      await ctx.db.patch(conversationId, {
        ...(requestedModel ? { model: daemonType === "claude" ? `claude-${requestedModel}` : requestedModel } : {}),
        ...(effortOk ? { effort: opts.effort } : {}),
      });
    }
    // A cloud session starts nowhere yet: the browser cannot SSH, so an online
    // local daemon prepares the host (wake, refresh the checkout, acquire a
    // worktree) and then places the row, and placement is what enqueues the
    // start. Queuing start_session here would race that and route the session at
    // a host with no checkout to run in.
    if (opts.cloud_device_id) {
      if (cloudWorkspace === "shared") {
        // A busy checkout NEVER throws here: the outbox classifies a thrown
        // create as permanent and drops it, and the stub's self-heal would
        // re-issue the same refused create. The row stays parked with the
        // refusal as its session_error (visible on the card) and no
        // cloud_spawn — a pending shared row with an error holds nothing, so
        // it frees nothing it does not have; a later re-pick re-claims.
        const repo = resolvedGitRoot || resolvedProjectPath;
        const occupant = repo ? await findSharedCheckoutOccupant(ctx, runnerUserId, opts.cloud_device_id, { repoBasename: posixRepoBasename(repo) }) : null;
        if (occupant) {
          await ctx.db.patch(conversationId, {
            session_error: checkoutInUseMessage(occupant.cloud_checkout_path ?? occupant.project_path ?? repo!, occupant),
            updated_at: Date.now(),
          });
          return conversationId;
        }
      }
      const row = await ctx.db.get(conversationId);
      await parkOnCloudHost(ctx, runnerUserId, row, opts.cloud_device_id, {
        projectPath: resolvedProjectPath,
        gitRoot: resolvedGitRoot,
        workspace: cloudWorkspace,
        startFrom: cloudStartFrom,
      });
      return conversationId;
    }
    await enqueueStartSession(ctx, runnerUserId, {
      conversationId,
      agentType: daemonType,
      projectPath: resolvedProjectPath || resolvedGitRoot,
      gitRoot: resolvedGitRoot,
      createdAt: now,
      // The human behind the create: lets the chokepoint upgrade a dropdown
      // pick of the runner's own cloud host to placement (mobile has no cloud
      // toggle; it sends target_device_id alone).
      callerUserId: userId,
      // Isolated-worktree sessions: forward the launch flag so the daemon's
      // start_session creates the git worktree up front. This is the SAME path
      // reconfigureSession/createQuickSession use; without it the "isolated
      // worktree" toggle silently did nothing until a later project switch.
      ...(opts.isolated ? { isolated: true } : {}),
      ...(opts.worktree_name ? { worktreeName: opts.worktree_name } : {}),
      // The machine picked on the new-session page. Web creates are deferred to
      // the first send, so the pick rides the create itself — there is no blank
      // conversation to reconfigure beforehand (reconfigureSession serves the
      // eager-create surfaces, e.g. mobile).
      ...(opts.target_device_id ? { targetDeviceId: opts.target_device_id } : {}),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(effortOk ? { effort: opts.effort } : {}),
      ...(opts.stable_mode ? { stableMode: opts.stable_mode } : {}),
      ...(opts.stable_exclude?.length ? { stableExclude: opts.stable_exclude } : {}),
      ...(asDef.definition ? { definition: asDef.definition } : {}),
    });

    return conversationId;
  },

  retryPendingMessage: async (ctx, userId, [convId, ref]: [string, { messageId?: string; clientId?: string }]) =>
    retryPendingMessageForUser(ctx, userId, convId as Id<"conversations">, ref),

  // A person's message from the staffing pane into the thread bound to a
  // proposal (org-staffing.md S18). orgProposals.say wraps it with the row it
  // is about and enqueues it on the message rail under the pane's client id.
  sayOnOrgProposal: async (ctx, _userId, [_threadConvId, proposal, changeSeq, body, clientId, askIndex]: [string, string, number | null, string, string, (number | null)?]) => {
    return await ctx.runMutation!((api as any).orgProposals.say, {
      proposal, body, client_id: clientId, ...(changeSeq != null ? { change: changeSeq } : {}), ...(askIndex != null ? { ask: askIndex } : {}),
    });
  },
  cancelPendingMessage: async (ctx, userId, [convId, ref]: [string, { messageId?: string; clientId?: string }]) =>
    cancelPendingMessageForUser(ctx, userId, convId as Id<"conversations">, ref),

  sendMessage: async (
    ctx,
    userId,
    [convId, content, imageIds, clientId]: [string, string, string[] | undefined, string | undefined],
    result,
  ) => {
    if (hasReceiptCommandId(result)) {
      const commandId = receiptCommandId("sendMessage", result);
      return await ctx.runMutation!(api.pendingMessages.sendMessageV2, {
        command_id: commandId,
        client_id: commandId,
        conversation_id: convId as Id<"conversations">,
        content,
        ...(imageIds?.length ? { image_storage_ids: imageIds as Id<"_storage">[] } : {}),
      });
    }
    const conversation = await ctx.db.get(convId as Id<"conversations">);
    // Distinct error for a deleted row: the client may be sending into a cached
    // ghost (never-prune cache) and needs to surface "restore session", not a
    // baffling auth failure.
    if (!conversation) throw new Error("conversation_deleted");
    // One send rule for every surface. The web poll card and inline composer land
    // here; CollabComposer and `cast send` land in performSessionSend; the receipt
    // path above lands in sendMessageV2 — all three admit exactly the same senders
    // (runner, owner set, team member of a team-visible session, or a collab
    // grant). Delivery routing is unaffected: enqueuePendingMessage stamps the
    // RUNNER's id for the daemon poll either way.
    if (!(await canSendProductMessage(ctx, userId, conversation))) throw new Error("Unauthorized");

    // Single canonical writer: dedups on client_id, stamps owner_user_id for the daemon's
    // delivery poll, and wakes the conversation (un-dismiss, completed→active).
    return await enqueuePendingMessage(ctx, conversation, userId, {
      content,
      image_storage_ids: imageIds?.length ? (imageIds as any) : undefined,
      client_id: clientId,
      human: true,
    });
  },

  // Runner or second-party owner; runner-addressed, deduplicated, and re-queues
  // stranded messages — the same core as users.resumeSession.
  resumeSession: async (ctx, userId, [convId]: [string]) =>
    resumeConversationSession(ctx, userId, convId as Id<"conversations">),

  // Web-triggered "move to remote": enqueue a move_to_device command targeted
  // at the session's CURRENT owner device (the machine that has the checkout +
  // credential). That daemon performs the local-only transfer (git/jsonl/cred),
  // then flips ownership + resumes on the destination device.
  // args: [conversationId, toDeviceId?]  (toDeviceId defaults to the online remote device)
  moveToRemote: async (ctx, userId, [convId, toDeviceId]: [string, string | undefined]) => {
    const conv = await ctx.db.get(convId as Id<"conversations">);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");

    const now = Date.now();
    const ONLINE = 2 * 60 * 1000;
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const online = devices.filter((d: any) => now - d.last_seen < ONLINE);

    // Destination: explicit, else the online remote device.
    const dest = toDeviceId
      ? online.find((d: any) => d.device_id === toDeviceId)
      : online.find((d: any) => d.is_remote);
    if (!dest) throw new Error("No online destination device (start the remote daemon)");

    // Source daemon = current owner if online, else the online local device.
    const ownerOnline = conv.owner_device_id && online.some((d: any) => d.device_id === conv.owner_device_id);
    const source = ownerOnline
      ? conv.owner_device_id
      : (online.find((d: any) => !d.is_remote)?.device_id ?? null);
    if (!source) throw new Error("No online source device to perform the move");
    if (source === dest.device_id) throw new Error("Session is already on that device");

    const pendingCommands = await ctx.db
      .query("daemon_commands")
      .withIndex("by_user_pending", (q: any) => q.eq("user_id", userId).eq("executed_at", undefined))
      .collect();
    if (hasRecentPendingDaemonCommand(pendingCommands as any, { conversationId: convId, command: "move_to_device" })) {
      return { deduplicated: true };
    }

    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "move_to_device" as const,
      args: JSON.stringify({
        conversation_id: convId,
        session_id: conv.session_id,
        to_device_id: dest.device_id,
      }),
      created_at: now,
      target_device_id: source, // only the source daemon executes the transfer
    });
    return { command_id: commandId, source, dest: dest.device_id };
  },

  linkConversation: async (ctx, userId, [objectType, objectId, conversationId]: [string, string, string]) => {
    await linkConversationToObject(
      ctx,
      userId,
      objectType,
      objectId,
      conversationId as Id<"conversations">,
    );
  },

  // The reader opened or dismissed an agent's pane offer. One handler for both
  // gestures: the offer only has to know it was handled. `at` is the client's
  // own timestamp, written verbatim, so the optimistic value and the server's
  // echo are the same object and the local field lock retires (see
  // stampBrowserPaneOfferHandled).
  // The row's two triage gestures on a role's session (org-roles-run-work.md
  // R1). `line` and `at` are the draft's, so the echo equals it.
  putSessionInMyInbox: async (ctx, _userId, [convId, line, at]: [string, string, number]) => {
    return await ctx.runMutation!((api as any).sessionOwnership.escalateSession, { session_id: convId, line, at });
  },
  handSessionBackToRole: async (ctx, _userId, [convId]: [string]) => {
    return await ctx.runMutation!((api as any).sessionOwnership.escalateSession, { session_id: convId, clear: true });
  },

  dismissBrowserPaneOffer: async (ctx, userId, [convId, at]: [string, number]) => {
    await stampBrowserPaneOfferHandled(ctx, userId, convId as Id<"conversations">, at);
  },

  // Mirror of conversations.setPrivacy — these two fields are immutable in
  // applyPatches because flipping them re-resolves team sharing, so the write
  // happens here while the client optimistically updates local state.
  setPrivacy: async (ctx, userId, [convId, isPrivate]: [string, boolean]) => {
    const conv = await ctx.db.get(convId as Id<"conversations">);
    if (!conv) throw new Error("Conversation not found");
    if (conv.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");
    // Sharing must guarantee a team_id (buildShareUpdate); locking forces the
    // private visibility marker. Never let is_private:false and team_id diverge.
    const updates = isPrivate
      ? { is_private: true as const, team_visibility: "private" as const }
      : await buildShareUpdate(ctx, conv, userId);
    // Also rewrites linked work items' stored access key.
    await patchConversationVisibility(ctx, conv, updates);
  },

  setTeamVisibility: async (ctx, userId, [convId, visibility]: [string, "summary" | "full" | null]) => {
    const conv = await ctx.db.get(convId as Id<"conversations">);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");
    // Setting any team visibility shares the conversation, so guarantee a
    // team_id alongside it (else it's shared-with-nobody).
    const updates = await buildShareUpdate(ctx, conv, userId);
    await patchConversationVisibility(ctx, conv, {
      ...updates,
      team_visibility: visibility ?? undefined,
    });
  },

  // Delegate to tasks.webUpdate so every task-write rule lives in one place:
  // canAccessTask (stronger than the old active-team check), the parent
  // machinery (resolveParentTask: access + workspace + cycle + depth), the
  // close-guard on parents with open subtasks, the in_progress rollup, plan
  // progress recalc, and subscriber notifications — the old inline fork had
  // already drifted (it skipped recalc + notify on status-only changes).
  // The optional third element carries the close-guard resolution.
  updateTaskStatus: async (ctx, userId, [shortId, newStatus, resolution]: [string, string, string?]) => {
    await (ctx as any).runMutation(api.tasks.webUpdate, {
      short_id: shortId,
      status: newStatus,
      subtask_resolution: resolution === "cascade" || resolution === "only_parent" ? resolution : undefined,
    });
  },

  // Same delegation, with an explicit allowlist — dispatch fields come straight
  // from the client, and an unknown key must never silently become a write.
  // `parent` goes through here so resolveParentTask stays the ONLY entry point
  // for nesting writes; never copy it into a dispatch-side patch.
  updateTask: async (ctx, userId, [shortId, fields]: [string, Record<string, any>]) => {
    await (ctx as any).runMutation(api.tasks.webUpdate, {
      short_id: shortId,
      status: fields.status,
      status_id: fields.status_id,
      priority: fields.priority,
      title: fields.title,
      description: fields.description,
      labels: fields.labels,
      assignee: fields.assignee,
      triage_status: fields.triage_status,
      execution_status: fields.execution_status,
      project_id: fields.project_id,
      project_path: fields.project_path,
      parent: fields.parent,
      sort_order: fields.sort_order,
      duplicate_of: fields.duplicate_of,
      subtask_resolution:
        fields.subtask_resolution === "cascade" || fields.subtask_resolution === "only_parent"
          ? fields.subtask_resolution
          : undefined,
    });
  },

  // Delegate to tasks.webCreate so every workspace rule lives in one place:
  // team_id membership enforcement (createDataContext.resolveWorkspace),
  // plan access + same-workspace checks, and plan-workspace inheritance. The
  // old inline insert took a client-supplied team_id unchecked (any team) and
  // linked any plan by short_id without access control. Pass an explicit
  // allowlist of args — dispatch opts come straight from the client.
  createTask: async (ctx, userId, [opts]: [any]) => {
    return await (ctx as any).runMutation(api.tasks.webCreate, {
      title: opts.title,
      description: opts.description,
      task_type: opts.task_type,
      status: opts.status,
      status_id: opts.status_id,
      priority: opts.priority,
      project_id: opts.project_id,
      labels: opts.labels,
      plan_id: opts.plan_id,
      team_id: opts.team_id,
      workspace: opts.workspace,
      assignee: opts.assignee,
      project_path: opts.project_path,
      // Subtask create — resolved server-side by resolveParentTask.
      parent: opts.parent,
      // Idempotency key: a retried/replayed create returns the same row.
      client_key: opts.client_key,
    });
  },

  // Delegate to tasks.webAddComment so the local-first path keeps image
  // attachments, the canAccessTask check, and subscriber notifications — none of
  // which the old inline insert had. Same ctx.runMutation reuse as updatePlan.
  addTaskComment: async (ctx, userId, [shortId, text, commentType, imageIds]: [string, string, string?, string[]?]) => {
    await (ctx as any).runMutation(api.tasks.webAddComment, {
      short_id: shortId,
      text,
      comment_type: commentType || undefined,
      image_storage_ids: imageIds && imageIds.length ? imageIds : undefined,
    });
  },

  // The doc star (rendered as a star; stored as `pinned`). Access is the doc's
  // own workspace rule, not the viewer's active team: a doc in another team
  // the viewer belongs to must star too, and team_id is routing, never access.
  pinDoc: async (ctx, userId, [docId, pinned]: [string, boolean]) => {
    const doc = await ctx.db.get(docId as Id<"docs">);
    if (!doc) throw new Error("Doc not found");
    if (!(await canAccessDoc(ctx, userId, doc))) throw new Error("Unauthorized");
    await ctx.db.patch(doc._id, { pinned, updated_at: Date.now() });
  },

  archiveDoc: async (ctx, userId, [docId]: [string]) => {
    const doc = await ctx.db.get(docId as Id<"docs">);
    if (!doc) throw new Error("Doc not found");
    const user = await ctx.db.get(userId);
    const teamId = user?.active_team_id || user?.team_id;
    if (doc.user_id !== userId && doc.team_id !== teamId) throw new Error("Not authorized");
    await ctx.db.patch(doc._id, { archived_at: Date.now(), updated_at: Date.now() });
  },

  restoreArchivedDoc: async (ctx, userId, [docId]: [string]) => {
    const doc = await ctx.db.get(docId as Id<"docs">);
    if (!doc) throw new Error("Doc not found");
    if (!(await canAccessDoc(ctx, userId, doc))) throw new Error("Unauthorized");
    // Preserve the undo snapshot's exact metadata: only clear the archive flag;
    // do not synthesize a new updated_at that would reorder the restored doc.
    await ctx.db.patch(doc._id, { archived_at: undefined });
  },

  updateDoc: async (ctx, userId, [docId, fields]: [string, { content?: string; title?: string; doc_type?: string; labels?: string[] }]) => {
    const doc = await ctx.db.get(docId as Id<"docs">);
    if (!doc) throw new Error("Doc not found");
    if (!(await canAccessDoc(ctx, userId, doc))) throw new Error("Unauthorized");
    const updates: any = { updated_at: Date.now() };
    if (fields.content !== undefined) updates.content = fields.content;
    if (fields.title !== undefined) updates.title = fields.title;
    if (fields.doc_type !== undefined) updates.doc_type = fields.doc_type;
    if (fields.labels !== undefined) updates.labels = fields.labels;
    await ctx.db.patch(doc._id, updates);
  },

  // Plans/projects carry server-side logic (plan progress recalc, doc-title
  // sync, access checks) that already lives in their public mutations. Rather
  // than duplicate it, the side-effect delegates via ctx.runMutation in the
  // same transaction — same identity, atomic. The client mutates plans[]/
  // projects[] optimistically; this performs the authoritative write.
  // The charter's owner is stored as `owner_role_id` (the field the web row
  // paints) but travels as `owner`, a role ref the mutation resolves inside
  // the row's workspace (lib/orgCharter.ts). One translation for both tables.
  updatePlan: async (ctx, userId, [shortId, fields]: [string, Record<string, any>]) => {
    await (ctx as any).runMutation(api.plans.webUpdate, { short_id: shortId, ...charterWire(fields) });
  },

  updateProject: async (ctx, userId, [id, fields]: [string, Record<string, any>]) => {
    await (ctx as any).runMutation(api.projects.webUpdate, { id, ...charterWire(fields) });
  },

  // Naming a project's lead (org-roles-run-work.md R4): the owner and, when
  // the role's scope does not list the project, the scope, in one transaction.
  setProjectLead: async (ctx, userId, [projectId, roleId, opts]: [string, string | null, { leave_sessions?: boolean } | undefined]) => {
    if (!isServerId(projectId) || (roleId !== null && !isServerId(roleId))) return null;
    return await (ctx as any).runMutation((api as any).orgRoles.setProjectLead, { project_id: projectId, role_id: roleId, ...(opts?.leave_sessions ? { leave_sessions: true } : {}) });
  },

  // Initiatives (initiatives-projects-role-page.md I1). The store paints
  // initiatives[] and initiativeUpdates[] optimistically; each side effect is
  // the one public mutation the CLI also calls, so the rules live in one place.
  // The store's stub id for a new initiative is its `client_key`, and the
  // server resolves a client key to the caller's own row (lib/initiativeRef),
  // so an edit made before the create has echoed lands on the real row. When
  // the row is not there yet the mutation throws, and the outbox retries the
  // write behind the create instead of dropping it as a success.
  createInitiative: async (ctx, userId, [opts]: [Record<string, any>]) => {
    return await (ctx as any).runMutation(api.initiatives.create, opts);
  },
  updateInitiative: async (ctx, userId, [id, fields]: [string, Record<string, any>]) => {
    return await (ctx as any).runMutation(api.initiatives.update, { id, ...fields });
  },
  addInitiativeProject: async (ctx, userId, [id, projectId]: [string, string]) => {
    if (!isServerId(projectId)) throw new Error("Project not created yet");
    return await (ctx as any).runMutation(api.initiatives.addProject, { id, project_id: projectId });
  },
  removeInitiativeProject: async (ctx, userId, [id, projectId]: [string, string]) => {
    if (!isServerId(projectId)) return null;
    return await (ctx as any).runMutation(api.initiatives.removeProject, { id, project_id: projectId });
  },
  setInitiativeProjects: async (ctx, userId, [id, projectIds]: [string, string[]]) => {
    return await (ctx as any).runMutation(api.initiatives.setProjects, { id, project_ids: projectIds.filter(isServerId) });
  },
  postInitiativeUpdate: async (ctx, userId, [id, update]: [string, { client_key?: string; body: string; health?: string }]) => {
    return await (ctx as any).runMutation(api.initiatives.postUpdate, { id, ...update });
  },

  // Issue sync sources (docs/architecture/issue-sync.md S1.3, S9). Like plans
  // and projects above, the authoritative write already exists as a public
  // mutation — it creates the project when none is named, registers the
  // provider webhook and schedules the first import — so the side effect
  // delegates rather than re-deriving any of it. The store paints
  // issueSyncSources optimistically; these perform the real write.
  // Agent definitions and chains. The store's upsert returns the client_key
  // it stamped on the stub (and the server id when it patched a real row), so
  // the mutation lands on the same row and the stub supersedes onto it.
  upsertAgentDefinition: async (ctx, userId, [fields]: [any], result) => {
    const { _id, ...rest } = fields ?? {};
    const r = (result ?? {}) as { client_key?: string; id?: string };
    return await (ctx as any).runMutation(api.agentDefinitions.upsert, {
      ...rest,
      ...(isServerId(r.id ?? _id) ? { id: r.id ?? _id } : {}),
      client_key: r.client_key,
    });
  },
  removeAgentDefinition: async (ctx, userId, [id]: [string]) => {
    if (!isServerId(id)) return;
    await (ctx as any).runMutation(api.agentDefinitions.remove, { id });
  },
  upsertAgentChain: async (ctx, userId, [fields]: [any], result) => {
    const { _id, ...rest } = fields ?? {};
    const r = (result ?? {}) as { client_key?: string; id?: string };
    return await (ctx as any).runMutation(api.agentDefinitions.upsertChain, {
      ...rest,
      ...(isServerId(r.id ?? _id) ? { id: r.id ?? _id } : {}),
      client_key: r.client_key,
    });
  },
  removeAgentChain: async (ctx, userId, [id]: [string]) => {
    if (!isServerId(id)) return;
    await (ctx as any).runMutation(api.agentDefinitions.removeChain, { id });
  },
  addIssueSyncSource: async (ctx, userId, [opts]: [any]) => {
    return await (ctx as any).runMutation(api.issueSync.addSource, {
      provider: opts.provider,
      kind: opts.kind,
      external_id: opts.external_id,
      external_key: opts.external_key,
      name: opts.name,
      url: opts.url,
      // Absent project_id means "create a project named after the source" —
      // the mutation's own contract, so an unset value is passed as unset
      // rather than guessed at here.
      project_id: isServerId(opts.project_id) ? opts.project_id : undefined,
      // Delegation settings ride the create, so an edit made while the create
      // is still in flight (dropped below as a stub-id write) is not lost.
      delegate_label: opts.delegate_label,
      delegate_assignee: opts.delegate_assignee,
      auto_spawn: opts.auto_spawn,
      push_new_tasks: opts.push_new_tasks,
    });
  },
  updateIssueSyncSource: async (ctx, userId, [id, fields]: [string, Record<string, any>]) => {
    // A gesture on a row whose create is still in flight names a stub id that
    // no server row answers to; the outbox would re-drive the argument error
    // forever. Drop it — the create carries the same settings.
    if (!isServerId(id)) return;
    await (ctx as any).runMutation(api.issueSync.updateSource, { id, ...fields });
  },
  removeIssueSyncSource: async (ctx, userId, [id]: [string]) => {
    if (!isServerId(id)) return;
    await (ctx as any).runMutation(api.issueSync.removeSource, { id });
  },

  // Saved views. Creates carry a client_key so a retry returns the same row
  // rather than a second copy of the view (savedViews.webCreate is idempotent
  // on that key), and the optimistic stub supersedes onto it.
  // Local-first team create (inboxStore.createTeam). The mutation writes the
  // canonical users.active_team_id; the ui mirror patched above carried the
  // client's stub id, so rewrite it with the real id in the same transaction.
  // The stub id doubles as the idempotency key: a replayed dispatch returns
  // the team the first run made instead of minting a duplicate.
  dispatchCreateTeam: async (ctx, userId, [stubId, opts]: [string, { name: string; icon?: string; icon_color?: string }]) => {
    const teamId = await (ctx as any).runMutation(api.teams.createTeam, {
      name: opts.name,
      icon: opts.icon,
      icon_color: opts.icon_color,
      client_key: stubId,
    });
    await applyPatches(ctx, userId, {
      client_state: { _: { ui: { active_team_id: teamId } } },
    });
    return teamId;
  },
  // Local-first team delete (inboxStore.deleteTeam). The mutation repoints the
  // canonical users.active_team_id when it named the team; the ui mirror
  // already moved to the client's fallback, so re-stamp it with the server's
  // answer in the same transaction. Both apply the oldest-membership rule.
  dispatchDeleteTeam: async (ctx, userId, [teamId, confirmName]: [string, string, string | undefined]) => {
    const result = await (ctx as any).runMutation(api.teams.deleteTeam, {
      team_id: teamId,
      confirm_name: confirmName,
    });
    await applyPatches(ctx, userId, {
      client_state: { _: { ui: { active_team_id: result?.active_team_id ?? undefined } } },
    });
    return result;
  },
  createSavedView: async (ctx, userId, [opts]: [any]) => {
    return await (ctx as any).runMutation(api.savedViews.webCreate, opts);
  },
  updateSavedView: async (ctx, userId, [id, fields]: [string, Record<string, any>]) => {
    await (ctx as any).runMutation(api.savedViews.webUpdate, { id, ...fields });
  },
  deleteSavedView: async (ctx, userId, [id]: [string]) => {
    await (ctx as any).runMutation(api.savedViews.webDelete, { id });
  },

  linkEntityConversation: async (ctx, userId, [opts]: [any]) => {
    return await (ctx as any).runMutation(api.conversationLinks.webLinkConversation, opts);
  },
  unlinkEntityConversation: async (ctx, userId, [id]: [string]) => {
    await (ctx as any).runMutation(api.conversationLinks.webUnlinkConversation, { id });
  },

  toggleBookmark: async (ctx, userId, [conversationId, messageId]: [string, string]) => {
    return await (ctx as any).runMutation(api.bookmarks.toggleBookmark, {
      conversation_id: conversationId,
      message_id: messageId,
    });
  },

  // Manual presence status from the avatar-bar hover card. The client already
  // flipped its local roster row (store setMyStatus); this is the
  // authoritative write.
  setMyStatus: async (ctx, userId, [status]: ["available" | "busy" | "away"]) => {
    await (ctx as any).runMutation(api.users.updateProfile, { status });
  },

  // The walkie door, from settings (store setWalkiePref). Same shape as the
  // status above: the client already closed or opened its own door, this is the
  // authoritative write.
  setWalkiePref: async (ctx, userId, [pref]: ["team" | "off"]) => {
    await (ctx as any).runMutation(api.users.updateProfile, { walkie_pref: pref });
  },

  // Snooze, from the receiver strip (store snoozeWalkie). On the user doc
  // rather than in the client prefs bag because "leave me alone" is a
  // statement about the person: it has to hold on every device they are
  // signed in on, and the door is decided per client.
  snoozeWalkie: async (ctx, userId, [until]: [number]) => {
    await (ctx as any).runMutation(api.users.updateProfile, { walkie_snoozed_until: until });
  },

  // Trigger verbs (store triggerAction / deleteTrigger). The client flipped
  // the agent_tasks row on its draft; these run the real mutations, which own
  // leases, rescheduling and the run-now kick.
  triggerAction: async (
    ctx,
    userId,
    [taskId, verb]: [string, "pause" | "resume" | "runNow" | "cancel" | "reactivate"],
  ) => {
    const fn = {
      pause: api.agentTasks.webPause,
      resume: api.agentTasks.webResume,
      runNow: api.agentTasks.webRunNow,
      cancel: api.agentTasks.webCancel,
      reactivate: api.agentTasks.webReactivate,
    }[verb];
    if (!fn) throw new Error(`Unknown trigger verb: ${verb}`);
    return await (ctx as any).runMutation(fn, { task_id: taskId });
  },
  deleteTrigger: async (ctx, userId, [taskId]: [string]) => {
    await (ctx as any).runMutation(api.agentTasks.webDelete, { task_id: taskId });
  },

  markNotificationRead: async (ctx, userId, [id]: [string]) => {
    return await (ctx as any).runMutation(api.notifications.markAsRead, { notificationId: id });
  },
  markAllNotificationsRead: async (ctx, userId) => {
    return await (ctx as any).runMutation(api.notifications.markAllAsRead, {});
  },

  // Result-dependent creates carry a client-minted command id in their durable
  // outbox result. Exact replay returns the stored receipt instead of inserting
  // a duplicate, and the receipt's canonical id resumes navigation/assignment.
  createBucket: async (ctx, userId, [opts]: [{ name: string; color?: string }], result) => {
    // Backward compatibility for an outbox entry persisted by an older client,
    // before receiptActionVersion existed. New calls always take the V2 path.
    if (!hasReceiptCommandId(result)) {
      return await createBucketForUser(ctx as any, userId, opts);
    }
    const continuation = validatedCreateContinuation("createBucket", result);
    if (continuation?.kind === "assignBucket") {
      return await createBucketWithAssignmentsV2ForUser(
        ctx as any,
        userId,
        {
          commandId: receiptCommandId("createBucket", result),
          name: opts.name,
          color: opts.color,
          conversationIds: continuation.conversationIds as Id<"conversations">[],
        },
      );
    }
    return await ctx.runMutation!(api.buckets.webCreateV2, {
      command_id: receiptCommandId("createBucket", result),
      name: opts.name,
      ...(opts.color ? { color: opts.color } : {}),
    });
  },

  updateBucket: async (
    ctx,
    _userId,
    [bucketId, fields]: [
      string,
      {
        name?: string;
        color?: string;
        sort_order?: number;
        archived_at?: number | null;
      },
    ],
    result,
  ) => {
    // Rollback mode has already applied the ordinary compatibility patches.
    if (!hasReceiptCommandId(result)) return;
    // An edit against a still-optimistic label stub (created, then renamed /
    // archived / reordered before its server row landed) can never land: the
    // args froze the stub id, which no server row will ever carry. Reject it
    // as data — the store rolls the field back — instead of letting the v.id
    // validator throw a permanent error on a must-deliver receipt entry that
    // would then re-fire on every boot forever.
    const realBucketId = ctx.db.normalizeId("inbox_buckets", bucketId);
    if (!realBucketId) {
      return await runLocalCommand(ctx as any, {
        principalId: _userId,
        commandId: receiptCommandId("updateBucket", result),
        commandName: "buckets.update/v2",
        arguments: { bucketId, fields },
      }, async () => ({
        status: "rejected",
        code: "NOT_FOUND",
        message: "Label not found",
      }));
    }
    return await ctx.runMutation!(api.buckets.webUpdateV2, {
      command_id: receiptCommandId("updateBucket", result),
      bucket_id: realBucketId,
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      ...(fields.color !== undefined
        ? { color: fields.color === null ? null : fields.color }
        : {}),
      ...(fields.sort_order !== undefined ? { sort_order: fields.sort_order } : {}),
      ...(fields.archived_at !== undefined
        ? { archived: fields.archived_at !== null }
        : {}),
    });
  },

  // Teammate comment writes delegate to receipt-backed public mutations (which
  // carry notification / mention / fork and complete-view revision logic). The
  // store has already painted the optimistic state.
  addComment: async (ctx, _userId, _args, result) => {
    const r = receiptLocalResult<{
      conversationId: string;
      content: string;
      messageId?: string;
      parentCommentId?: string;
      filePath?: string;
      lineNumber?: number;
      clientId: string;
      commandId?: string;
    }>(result);
    return ctx.runMutation!(api.comments.addCommentV2, {
      command_id: receiptOrLegacyCommandId(
        "addComment",
        result,
        `legacy-comments-create:${r.clientId}`,
      ),
      conversation_id: r.conversationId as Id<"conversations">,
      content: r.content,
      message_id: r.messageId ? (r.messageId as Id<"messages">) : undefined,
      parent_comment_id: r.parentCommentId ? (r.parentCommentId as Id<"comments">) : undefined,
      file_path: r.filePath || undefined,
      line_number: typeof r.lineNumber === "number" ? r.lineNumber : undefined,
      client_id: r.clientId,
    });
  },
  editComment: async (ctx, _userId, args, result) => {
    // Backward compatibility for a generic editComment entry persisted before
    // this action became receipt-aware. It has no rollback snapshot or
    // conversation/client identity, so use the original authoritative mutation.
    if (!hasReceiptCommandId(result)) {
      const [commentId, content] = args as [string, string];
      if (!commentId || commentId.startsWith("commentstub")) return;
      return ctx.runMutation!(api.comments.updateComment, {
        comment_id: commentId as Id<"comments">,
        content,
      });
    }
    const r = receiptLocalResult<{
      commentId?: string;
      conversationId?: string;
      clientId?: string;
      content: string;
      previousContent: string;
      commandId?: string;
    }>(result);
    if (!r?.conversationId || (!r.commentId && !r.clientId)) {
      return {
        receiptVersion: 1,
        commandId: receiptCommandId("editComment", result),
        commandName: "comments.update/v2",
        status: "rejected",
        rejection: {
          code: "MISSING_LOCAL_CONTEXT",
          message: "The comment is no longer available to edit",
        },
        coverage: [],
        retryUntil: null,
      };
    }
    return ctx.runMutation!(api.comments.updateCommentV2, {
      command_id: receiptCommandId("editComment", result),
      conversation_id: r.conversationId as Id<"conversations">,
      ...(r.commentId ? { comment_id: r.commentId as Id<"comments"> } : {}),
      ...(r.clientId ? { client_id: r.clientId } : {}),
      content: r.content,
    });
  },
  deleteComment: async (ctx, _userId, _args, result) => {
    const r = receiptLocalResult<{
      commentId?: string;
      conversationId?: string;
      clientId?: string;
      commandId?: string;
    }>(result);
    // New optimistic deletes retain the conversation/client identity, allowing
    // an add→delete pair parked in one outbox to delete the real row after the
    // idempotent add lands. Legacy cached rows without that context still use
    // the original id-based mutation.
    if (r.conversationId && (r.commentId || r.clientId)) {
      return ctx.runMutation!(api.comments.deleteCommentV2, {
        command_id: receiptOrLegacyCommandId(
          "deleteComment",
          result,
          `legacy-comments-delete:${r.clientId || r.commentId}`,
        ),
        conversation_id: r.conversationId as Id<"conversations">,
        ...(r.commentId ? { comment_id: r.commentId as Id<"comments"> } : {}),
        ...(r.clientId ? { client_id: r.clientId } : {}),
      });
    }
    if (!r.commentId || r.commentId.startsWith("commentstub")) return;
    return ctx.runMutation!(api.comments.deleteComment, {
      comment_id: r.commentId as Id<"comments">,
    });
  },
  // Thread resolution is idempotent (stamp/clear the same fields), so the
  // plain optimistic-action path is enough — no receipt machinery needed.
  resolveCommentThread: async (
    ctx,
    _userId,
    [conversationId, anchor, resolved]: [string, { messageId?: string; filePath?: string; lineNumber?: number } | undefined, boolean],
  ) => {
    if (!isServerId(conversationId)) return;
    return ctx.runMutation!(api.comments.resolveThread, {
      conversation_id: conversationId as Id<"conversations">,
      message_id: anchor?.messageId && isServerId(anchor.messageId)
        ? (anchor.messageId as Id<"messages">)
        : undefined,
      file_path: anchor?.filePath || undefined,
      line_number: typeof anchor?.lineNumber === "number" ? anchor.lineNumber : undefined,
      resolved: !!resolved,
    });
  },

  askAgentInThread: async (ctx, _userId, _args, result) => {
    const r = receiptLocalResult<{
      conversationId: string;
      messageId?: string;
      filePath?: string;
      lineNumber?: number;
      clientId: string;
      commandId?: string;
    }>(result);
    return ctx.runMutation!(api.comments.askAgentInThreadV2, {
      command_id: receiptOrLegacyCommandId(
        "askAgentInThread",
        result,
        `legacy-comments-ask:${r.clientId}`,
      ),
      conversation_id: r.conversationId as Id<"conversations">,
      message_id: r.messageId ? (r.messageId as Id<"messages">) : undefined,
      file_path: r.filePath || undefined,
      line_number: typeof r.lineNumber === "number" ? r.lineNumber : undefined,
      client_id: r.clientId,
    });
  },

  // Exclusive per-user filing: upsert the single (user, conversation) row.
  // bucketId null = unassign (tombstone row, never deleted — delta sync).
  // Returns the gate it stopped at (or "ok") so a silent no-op is debuggable
  // from the client (`await store.assignSessionToBucket(...)`).
  assignSessionToBucket: async (
    ctx,
    userId,
    [convId, bucketId]: [string, string | null],
    result,
  ) => {
    if (hasReceiptCommandId(result)) {
      // Client stub ids reach this dispatch by design (fork label inheritance
      // sends the local fork id; the server files the fork itself via
      // inheritLabelAssignment). They must not hit webAssignV2's v.id
      // validators: an ArgumentValidationError is permanent AND receipt
      // entries are must-deliver, so the outbox would re-fire the refusal —
      // and its error toast — on every boot forever. Acknowledge the no-op
      // with a durable receipt instead, mirroring the legacy gate results.
      const realConvId = ctx.db.normalizeId("conversations", convId);
      const realBucketId = bucketId ? ctx.db.normalizeId("inbox_buckets", bucketId) : null;
      if (!realConvId || (bucketId && !realBucketId)) {
        return await runLocalCommand(ctx as any, {
          principalId: userId,
          commandId: receiptCommandId("assignSessionToBucket", result),
          commandName: "buckets.assign/v2",
          arguments: { conversationId: convId, bucketId: bucketId ?? undefined },
        }, async () => ({
          status: "acknowledged",
          result: { gate: !realConvId ? "conv_not_found" : "bucket_not_owned" },
          coverageViews: [],
        }));
      }
      return await ctx.runMutation!(api.buckets.webAssignV2, {
        command_id: receiptCommandId("assignSessionToBucket", result),
        conversation_id: realConvId,
        ...(realBucketId ? { bucket_id: realBucketId } : {}),
      });
    }
    let conv: any = null;
    let convErr: string | null = null;
    try {
      conv = await ctx.db.get(convId as Id<"conversations">);
    } catch (e: any) {
      convErr = String(e?.message || e);
    }
    if (!conv) return { gate: "conv_not_found", convErr };
    if (!(await canFileConversation(ctx as any, userId, conv))) return { gate: "conv_not_owned" };
    if (bucketId) {
      const bucket = await ctx.db.get(bucketId as Id<"inbox_buckets">).catch(() => null);
      if (!bucket || String((bucket as any).user_id) !== String(userId)) return { gate: "bucket_not_owned" };
    }
    // Shared with the CLI's `cast label set/clear` — see buckets.assignConversationToBucketForUser.
    await assignConversationToBucketForUser(
      ctx as any,
      userId,
      convId as Id<"conversations">,
      (bucketId ?? null) as Id<"inbox_buckets"> | null
    );
    return { gate: "ok" };
  },

  createDoc: async (ctx, userId, [opts]: [any], result) => {
    if (!hasReceiptCommandId(result)) {
      return await ctx.runMutation!(api.docs.webCreate, opts);
    }
    validatedCreateContinuation("createDoc", result);
    return await runReceiptBackedCreate(ctx, userId, {
      action: "createDoc",
      commandName: "docs.create/v2",
      arguments: opts,
      result,
      create: () => ctx.runMutation!(api.docs.webCreate, opts),
    });
  },
  createPlan: async (ctx, userId, [opts]: [any], result) => {
    if (!hasReceiptCommandId(result)) {
      return await ctx.runMutation!(api.plans.webCreate, opts);
    }
    validatedCreateContinuation("createPlan", result);
    return await runReceiptBackedCreate(ctx, userId, {
      action: "createPlan",
      commandName: "plans.create/v2",
      arguments: opts,
      result,
      create: () => ctx.runMutation!(api.plans.webCreate, opts),
    });
  },
  createProject: async (ctx, userId, [opts]: [any], result) => {
    if (!hasReceiptCommandId(result)) {
      return await ctx.runMutation!(api.projects.webCreate, opts);
    }
    validatedCreateContinuation("createProject", result);
    return await runReceiptBackedCreate(ctx, userId, {
      action: "createProject",
      commandName: "projects.create/v2",
      arguments: opts,
      result,
      create: () => ctx.runMutation!(api.projects.webCreate, opts),
    });
  },
  promoteDocToPlan: async (ctx, userId, [docId]: [string]) => {
    return await (ctx as any).runMutation(api.docs.webPromoteToPlan, { doc_id: docId });
  },
  ensurePlanDoc: async (ctx, userId, [planId]: [string]) => {
    return await (ctx as any).runMutation(api.plans.ensureDoc, { plan_id: planId });
  },
  publishToDirectory: async (ctx, userId, [opts]: [any]) => {
    return await (ctx as any).runMutation(api.conversations.publishToDirectory, opts);
  },
  moveDoc: async (ctx, userId, [id, parentId, sortOrder]: [string, string?, number?]) => {
    return await (ctx as any).runMutation(api.docs.webMoveDoc, {
      id,
      parent_id: parentId ?? undefined,
      sort_order: sortOrder ?? undefined,
    });
  },

  // ── Team chat ─────────────────────────────────────────────────────────────
  //
  // The store paints every one of these locally and hands delivery to the
  // outbox; here they delegate to the chat mutations, which own authorization,
  // rate limits, mention resolution and the anchor wake. Nothing is re-derived.
  //
  // Every handler refuses a stub id. The store's optimistic rows are keyed by a
  // local `chat…stub-` id until the server row supersedes them, and a gesture
  // that names one (reacting to a message still in flight) has no server row to
  // act on — passing it through would only turn a harmless local race into an
  // argument validation error the outbox then re-drives forever.
  dispatchChatSend: async (
    ctx,
    _userId,
    [channelId, content, clientId, opts]: [
      string,
      string,
      string,
      { threadRootId?: string; broadcast?: boolean; attachments?: any[]; origin?: "agent"; syncLocalOnly?: boolean }?,
    ],
  ) => {
    if (!isServerId(channelId)) return;
    return await ctx.runMutation!(api.chat.sendMessage, {
      channel_id: channelId as Id<"chat_channels">,
      content,
      ...(opts?.syncLocalOnly ? { sync_local_only: true } : {}),
      // The dedupe key: a re-driven delivery returns the existing row instead of
      // inserting a twin, and does not wake the anchor a second time.
      client_id: clientId,
      ...(opts?.threadRootId && isServerId(opts.threadRootId)
        ? {
          thread_root_id: opts.threadRootId as Id<"chat_messages">,
          ...(opts?.broadcast ? { broadcast: true } : {}),
        }
        : {}),
      ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(opts?.origin ? { origin: opts.origin } : {}),
    });
  },
  dispatchChatEdit: async (ctx, _userId, [messageId, content]: [string, string]) => {
    if (!isServerId(messageId)) return;
    return await ctx.runMutation!(api.chat.editMessage, {
      message_id: messageId as Id<"chat_messages">,
      content,
    });
  },
  dispatchChatDelete: async (ctx, _userId, [messageId]: [string]) => {
    if (!isServerId(messageId)) return;
    return await ctx.runMutation!(api.chat.deleteMessage, {
      message_id: messageId as Id<"chat_messages">,
    });
  },
  // An intent, not a state: the mutation splices the caller's own id in or out,
  // so a replayed toggle can never forge or wipe a teammate's reaction.
  toggleChatReaction: async (ctx, _userId, [messageId, emoji]: [string, string]) => {
    if (!isServerId(messageId)) return;
    return await ctx.runMutation!(api.chat.toggleReaction, {
      message_id: messageId as Id<"chat_messages">,
      emoji,
    });
  },
  markChannelRead: async (ctx, _userId, [channelId, lastMessageId]: [string, string?]) => {
    if (!isServerId(channelId)) return;
    return await ctx.runMutation!(api.chat.markRead, {
      channel_id: channelId as Id<"chat_channels">,
      ...(lastMessageId && isServerId(lastMessageId)
        ? { last_read_message_id: lastMessageId as Id<"chat_messages"> }
        : {}),
    });
  },
  // The viewer is looking at this session right now. `at` is the conversation's
  // own updated_at, so the mark the client already rendered is exactly what
  // lands and the card cannot flicker back to unread on the echo.
  writeSessionAck: async (ctx, _userId, [conversationId, at]: [string, number?]) => {
    if (!isServerId(conversationId)) return;
    return await ctx.runMutation!(api.sessionReads.acknowledge, {
      conversation_id: conversationId,
      ...(typeof at === "number" && at > 0 ? { acknowledged_at: at } : {}),
    });
  },
  // The manual "leave it lit" gesture. Cleared by the next presence ack.
  writeSessionUnread: async (ctx, _userId, [conversationId]: [string]) => {
    if (!isServerId(conversationId)) return;
    return await ctx.runMutation!(api.sessionReads.markUnread, {
      conversation_id: conversationId,
    });
  },
  // Two arg shapes: the legacy [rootId] (old bundles and persisted outbox
  // entries, always a chat thread) and [kind, rootKey]. A comment key is
  // `${conversation_id}:${anchor}`, so only its conversation half is an id.
  markThreadRead: async (ctx, _userId, args: [string] | [ThreadKind, string]) => {
    const [kind, rootKey] = args.length >= 2
      ? [args[0] as ThreadKind, String(args[1])]
      : ["chat" as ThreadKind, String(args[0])];
    if (!["chat", "comment", "task", "page"].includes(kind)) return;
    const idPart = kind === "comment" ? rootKey.split(":")[0] : rootKey;
    if (!isServerId(idPart)) return;
    return await ctx.runMutation!(api.threads.markRead, { kind, root_key: rootKey });
  },
  // One thread card's "done": archive the caller's own follow (threads.dismiss
  // deletes their thread_reads row). Same key rules as markThreadRead.
  dismissThread: async (ctx, _userId, args: [ThreadKind, string]) => {
    const [kind, rootKey] = [args[0] as ThreadKind, String(args[1])];
    if (!["chat", "comment", "task", "page"].includes(kind)) return;
    const idPart = kind === "comment" ? rootKey.split(":")[0] : rootKey;
    if (!isServerId(idPart)) return;
    return await ctx.runMutation!(api.threads.dismiss, { kind, root_key: rootKey });
  },
  markAllThreadsRead: async (ctx, _userId, args: [string?] | [string | null | undefined, (ThreadKind | "all")?]) => {
    const teamId = args[0] ?? undefined;
    // A one-argument call is the legacy chat-only sweep (old bundles and
    // persisted outbox entries). The unscoped every-kind sweep is opt-in: the
    // new client sends the explicit "all" sentinel.
    const kind = args.length === 1 ? "chat" : args[1];
    return await ctx.runMutation!(api.threads.markAllRead, {
      ...(teamId && isServerId(teamId) ? { team_id: teamId as Id<"teams"> } : {}),
      ...(kind && kind !== "all" && ["chat", "comment", "task", "page"].includes(kind)
        ? { kind: kind as ThreadKind }
        : {}),
    });
  },
  // The web's optimistic page reply: one comment onto a published page's
  // discussion, deduped server-side on (artifact, client_id) so an outbox
  // retry cannot double-post. Identity resolves from the caller's session.
  addPageComment: async (
    ctx,
    _userId,
    [o]: [{ slug?: string; artifactId?: string; text: string; parentId?: string; clientId: string }],
  ) => {
    if (!o?.text || (!o.slug && !(o.artifactId && isServerId(o.artifactId)))) return;
    return await ctx.runMutation!(api.artifacts.submitComments, {
      ...(o.slug ? { slug: o.slug } : { artifact_id: o.artifactId as Id<"artifacts"> }),
      author_name: "",
      deliver: false,
      ...(o.parentId && isServerId(o.parentId) ? { parent_id: o.parentId } : {}),
      client_id: o.clientId,
      comments: [{ text: o.text }],
    });
  },
  setChannelNotifyLevel: async (
    ctx,
    _userId,
    [channelId, level]: [string, "all" | "mentions" | "none"],
  ) => {
    if (!isServerId(channelId)) return;
    return await ctx.runMutation!(api.chat.setNotifyLevel, {
      channel_id: channelId as Id<"chat_channels">,
      notify_level: level,
    });
  },
  updateChatChannel: async (
    ctx,
    _userId,
    [channelId, fields]: [string, { name?: string; topic?: string }],
  ) => {
    if (!isServerId(channelId)) return;
    return await ctx.runMutation!(api.chat.updateChannel, {
      channel_id: channelId as Id<"chat_channels">,
      ...(fields?.name !== undefined ? { name: fields.name } : {}),
      ...(fields?.topic !== undefined ? { topic: fields.topic } : {}),
    });
  },
  // Slack mirror controls (slackSync). The link row is server-owned; the
  // store patches its copy and this carries the same patch.
  updateChatSlackLink: async (
    ctx,
    _userId,
    [linkId, patch]: [string, { direction?: any; options?: Record<string, boolean>; paused?: boolean; reimport?: boolean }],
  ) => {
    if (!isServerId(linkId)) return;
    return await ctx.runMutation!(api.slackSync.updateLink, {
      link_id: linkId as Id<"slack_channel_links">,
      ...(patch?.direction ? { direction: patch.direction } : {}),
      ...(patch?.options ? { options: patch.options } : {}),
      ...(typeof patch?.paused === "boolean" ? { paused: patch.paused } : {}),
      ...(patch?.reimport ? { reimport: true } : {}),
    });
  },
  unlinkChatSlack: async (ctx, _userId, [linkId]: [string]) => {
    if (!isServerId(linkId)) return;
    return await ctx.runMutation!(api.slackSync.unlinkChannel, { link_id: linkId as Id<"slack_channel_links"> });
  },
  shareChatMessageToSlack: async (ctx, _userId, [messageId]: [string]) => {
    if (!isServerId(messageId)) return;
    return await ctx.runMutation!(api.slackSync.shareMessageToSlack, { message_id: messageId as Id<"chat_messages"> });
  },
  archiveChatChannel: async (
    ctx,
    _userId,
    [channelId, archived]: [string, boolean],
  ) => {
    if (!isServerId(channelId)) return;
    return await ctx.runMutation!(api.chat.archiveChannel, {
      channel_id: channelId as Id<"chat_channels">,
      archived: !!archived,
    });
  },
  // Idempotent on client_id, so a replayed create returns the same channel
  // rather than a second one with the same name.
  dispatchCreateChatChannel: async (
    ctx,
    _userId,
    [clientId, name, opts]: [
      string,
      string,
      { topic?: string; teamId?: string; kind?: "private"; memberIds?: string[] }?,
    ],
  ) => {
    return await ctx.runMutation!(api.chat.createChannel, {
      name,
      client_id: clientId,
      ...(opts?.topic ? { topic: opts.topic } : {}),
      ...(opts?.teamId && isServerId(opts.teamId) ? { team_id: opts.teamId as Id<"teams"> } : {}),
      ...(opts?.kind === "private"
        ? {
            kind: "private" as const,
            member_ids: (opts.memberIds ?? []).filter(isServerId) as Id<"users">[],
          }
        : {}),
    });
  },

  addChatChannelMembers: async (
    ctx,
    _userId,
    [channelId, memberIds]: [string, string[]],
  ) => {
    if (!isServerId(channelId)) return;
    return await ctx.runMutation!(api.chat.addChannelMembers, {
      channel_id: channelId as Id<"chat_channels">,
      member_ids: memberIds.filter(isServerId) as Id<"users">[],
    });
  },
  removeChatChannelMember: async (
    ctx,
    _userId,
    [channelId, userId]: [string, string],
  ) => {
    if (!isServerId(channelId) || !isServerId(userId)) return;
    return await ctx.runMutation!(api.chat.removeChannelMember, {
      channel_id: channelId as Id<"chat_channels">,
      user_id: userId as Id<"users">,
    });
  },

  // Idempotent twice over: on client_id like every create, and on dm_key by
  // construction — the same member set always resolves to the same room.
  dispatchOpenDm: async (
    ctx,
    _userId,
    [clientId, memberIds, teamId]: [string, string[], string?],
  ) => {
    return await ctx.runMutation!(api.chat.openDm, {
      member_ids: memberIds.filter(isServerId) as Id<"users">[],
      client_id: clientId,
      ...(teamId && isServerId(teamId) ? { team_id: teamId as Id<"teams"> } : {}),
    });
  },

  // Generic session daemon-command dispatch: delegates to the existing mutation
  // so all its dedup / pending-reset / multi-command logic is reused verbatim.
  // The store's convCommand action routes every kill/restart/repair/reconfigure/
  // rewind/fork/sendKeys/sendEscape/resume here. Every target takes
  // conversation_id as its first arg; per-command extras ride extraArgs.
  hibernateSession: async (ctx, _userId, [requestId, convId, sessionId, ownerDeviceId]: [string, string, string, string]) => {
    return await ctx.runMutation!((api as any).sessionCommands.hibernate, {
      request_id: requestId, conversation_id: convId as Id<"conversations">,
      session_id: sessionId, owner_device_id: ownerDeviceId,
    });
  },

  convCommand: async (ctx, userId, [convId, command, extraArgs]: [string, string, Record<string, any>?]) => {
    const fn = (SESSION_COMMANDS as Record<string, any>)[command];
    if (!fn) throw new Error(`convCommand: unknown command ${command}`);
    try {
      return await (ctx as any).runMutation(fn, {
        conversation_id: convId,
        ...(extraArgs || {}),
      });
    } catch (e: any) {
      // Re-throw with routing context: the bare "Not authorized" from the
      // target mutation is undiagnosable in server logs (no args are logged).
      throw new Error(`convCommand ${command} conv=${convId} user=${userId}: ${e?.message ?? e}`);
    }
  },
};

const SESSION_COMMANDS = {
  killSession: api.conversations.killSession,
  restartSession: api.conversations.restartSession,
  repairSession: api.conversations.repairSession,
  reconfigureSession: api.conversations.reconfigureSession,
  switchSessionAgent: api.conversations.switchSessionAgent,
  rewindSession: api.conversations.rewindSession,
  forkFromMessage: api.conversations.forkFromMessage,
  sendKeysToSession: api.conversations.sendKeysToSession,
  setPermissionMode: api.conversations.setPermissionMode,
  sendEscapeToSession: api.conversations.sendEscapeToSession,
  resumeSession: api.users.resumeSession,
};
