// Pending tool-permission requests and in-flight message delivery status —
// store-fed, per conversation.
import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useCoarseNow } from "./useCoarseNow";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";

const api = _api as any;

// Mirrors permissions.ts on the server: a request older than this is gone.
const PENDING_WINDOW_MS = 2 * 3600_000;

/**
 * Feeder: one conversation's pending permissions. Each push is the COMPLETE
 * pending set for that conversation, so absent in-scope rows are pruned
 * (a resolved permission must leave the store, and the disk).
 */
export function useSyncPendingPermissions(conversationId: string | null | undefined, enabled = true) {
  const syncOpts = useMemo(
    () => (conversationId ? { pruneAbsentScope: (row: any) => row?.conversation_id === conversationId } : undefined),
    [conversationId],
  );
  return useSyncCollection(
    "pendingPermissions",
    api.permissions.getPendingPermissions,
    enabled && conversationId ? { conversation_id: conversationId } : "skip",
    { syncOpts },
  );
}

const permSig = (p: any) => `${p.status}|${p.tool_name}|${p.arguments_preview ?? ""}|${p.resolved_at ?? ""}`;
const byCreatedAsc = (a: any, b: any) => (a.created_at ?? 0) - (b.created_at ?? 0);

/** Reader: one conversation's pending permissions, oldest first (the server's
 *  order). Undefined only while cold with an empty cache. */
export function usePendingPermissions(conversationId: string | null | undefined, enabled = true): any[] | undefined {
  const { ready } = useSyncPendingPermissions(conversationId, enabled);
  const now = useCoarseNow(60_000);
  const where = useMemo(
    () => (conversationId
      ? (p: any) => p.conversation_id === conversationId && p.status === "pending" && (p.created_at ?? 0) > now - PENDING_WINDOW_MS
      : () => false),
    [conversationId, now],
  );
  const rows = useCollectionRows<any>("pendingPermissions", { where, sig: permSig, sort: byCreatedAsc });
  if (!conversationId || !enabled) return undefined;
  if (rows.length > 0) return rows;
  return ready ? rows : undefined;
}

/**
 * Feeder + reader: delivery status of the viewer's in-flight message in one
 * conversation (getConversationPendingMessage). One row keyed by the
 * conversation id. The server's null IS the deletion: the row is dropped
 * directly (transient, non-localFirst collection — no tombstone per sent
 * message).
 */
export function usePendingMessageStatus(conversationId: string | null | undefined, enabled = true): any | null | undefined {
  const { data } = useQueryNoThrow(
    api.pendingMessages.getConversationPendingMessage,
    enabled && conversationId ? { conversation_id: conversationId } : "skip",
  );
  const syncTable = useInboxStore((s) => s.syncTable);
  const dropRows = useInboxStore((s) => s.dropRows);
  useConvexSync(
    data,
    useCallback(
      (row: any) => {
        if (!conversationId) return;
        if (row) syncTable("pendingMessageStatus", [{ _id: conversationId, conversation_id: conversationId, ...row }]);
        else dropRows("pendingMessageStatus", [conversationId]);
      },
      [conversationId, syncTable, dropRows],
    ),
  );
  const stored = useInboxStore((s) => (conversationId ? (s.pendingMessageStatus as any)[conversationId] : undefined));
  if (!conversationId || !enabled) return undefined;
  return stored ?? (data !== undefined ? null : undefined);
}
