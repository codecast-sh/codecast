// The local-first fork, shared by every surface that forks from a message
// (the web conversation view, the phone's session screen). A leaf: no sonner,
// no DOM, everything through the store, so the caller says how a failure reads.
//
// Seed the stub conversation WITH the parent's loaded message window sliced at
// the fork point, so the fork renders fully populated in the same frame as the
// gesture. The server mutation, message copy, and daemon tmux spawn all happen
// behind it; the only visible artifact is the session status line above the
// input ("Starting session…" → "Ready"). resolveForkSessionId rekeys stub →
// real id when the mutation lands, and useConversationMessages freezes the
// server message sync while fork_status === "copying" so the half-copied
// server window can never clobber the seeded one.
import { agentSupportsFork } from "@codecast/shared/contracts";
import { useInboxStore, convBucketMap, type BucketItem, type InboxSession } from "./inboxStore";
import { DispatchNotWiredError } from "./mutativeMiddleware";
import { withoutUndo } from "@platform/engine";

// Loose view of the conversation a fork starts from: the fields the stub copies.
export type ForkSource = {
  _id?: { toString(): string } | string | null;
  title?: string | null;
  agent_type?: string;
  project_path?: string | null;
  git_root?: string | null;
  loaded_start_index?: number | null;
  messages?: any[] | null;
  user?: { name?: string | null; email?: string | null } | null;
} | null | undefined;

export type LocalFork = { forkSessionId: string; conversationId: string; ready: Promise<string> };

/** A fork's session id: a real UUID, so the daemon resumes it without remapping. */
export function newForkSessionId(): string {
  return (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
}

// Seed sessions[stub] from the parent and move the view onto it in one action
// (injectSession), so the fork renders instantly from local state. Server
// derived fields (title prefix, exact message_count) are approximate here and
// the meta subscription corrects them within a tick.
export function seedForkSessionRow(conversation: ForkSource, convId: string, fields: Partial<InboxSession>) {
  useInboxStore.getState().injectSession({
    _id: convId,
    session_id: convId,
    title: conversation?.title,
    updated_at: Date.now(),
    project_path: conversation?.project_path ?? undefined,
    git_root: conversation?.git_root ?? undefined,
    agent_type: conversation?.agent_type || "claude_code",
    message_count: 0,
    is_idle: true,
    has_pending: false,
    ...fields,
  } as InboxSession);
}

export function beginLocalFork(
  conversation: ForkSource,
  messageUuid: string,
  { currentUser, hasMoreAbove, onError }: { currentUser: any; hasMoreAbove: boolean | undefined; onError?: (message: string) => void },
): LocalFork | null {
  if (!conversation?._id) return null;
  // Honest degradation: a client with no fork mechanism (cursor/gemini/pi) would
  // copy the transcript server-side but leave the live agent context-less. The UI
  // hides the fork controls for these; this guards any programmatic path too.
  if (!agentSupportsFork(conversation.agent_type)) return null;
  const parentId = conversation._id.toString();
  const store = useInboxStore.getState();
  // Must be a valid UUID so the daemon can resume without ID remapping
  const forkSessionId = newForkSessionId();
  const now = Date.now();
  const forkTitle = conversation.title ? `Fork: ${conversation.title}` : "Fork";
  // Parent's server rows up to and including the fork point. Optimistic/queued
  // rows are excluded — they aren't in the messages table yet, so the server
  // copy won't include them either.
  const parentMsgs = (conversation.messages || []).filter((m: any) => !m._isOptimistic && !m._isQueued);
  const forkIdx = parentMsgs.findIndex((m: any) => m.message_uuid === messageUuid);
  const seededMsgs = forkIdx >= 0 ? parentMsgs.slice(0, forkIdx + 1) : parentMsgs;
  // Count as the user saw it on the parent: messages above the loaded window
  // plus the seeded slice. Keeps the "N older messages" indicator stable.
  const seededCount = (conversation.loaded_start_index ?? 0) + seededMsgs.length;
  // A fresh fork owns nothing yet: everything it holds is inherited, so the
  // stub declares its whole count as copied history. Without that the chip
  // reads the parent's prefix as "N messages in this branch since the fork".
  store.addOptimisticFork({
    _id: forkSessionId,
    user_id: currentUser?._id?.toString(),
    title: forkTitle,
    started_at: now,
    username: conversation.user?.name || conversation.user?.email?.split("@")[0],
    parent_message_uuid: messageUuid,
    message_count: seededCount,
    fork_copied: seededCount,
    agent_type: conversation.agent_type,
    origin_id: parentId,
    optimistic: true,
  });
  // conversations[stub] carries the fork metadata (storeMeta merge prefers it
  // over the session row); fork_status "copying" arms the message-sync freeze
  // from the first frame, before the server confirms it.
  store.syncRecord("conversations", forkSessionId, {
    _id: forkSessionId,
    session_id: forkSessionId,
    user_id: currentUser?._id?.toString() ?? "",
    title: forkTitle,
    agent_type: conversation.agent_type,
    project_path: conversation.project_path ?? undefined,
    git_root: conversation.git_root ?? undefined,
    started_at: now,
    updated_at: now,
    status: "active",
    message_count: seededCount,
    forked_from: parentId,
    parent_message_uuid: messageUuid,
    fork_status: "copying",
  });
  store.setMessages(forkSessionId, seededMsgs, { hasMoreAbove: !!hasMoreAbove || (conversation.loaded_start_index ?? 0) > 0, initialized: true });
  // Seeds sessions[stub] and navigates in one action — instant switch.
  seedForkSessionRow(conversation, forkSessionId, {
    session_id: forkSessionId,
    title: forkTitle,
    started_at: now,
    message_count: seededCount,
    fork_copied: seededCount,
    forked_from: parentId,
    parent_message_uuid: messageUuid,
  } as any);
  // Local-first label inheritance: mirror the server's inheritLabelAssignment
  // so the fork lands in its parent's label group on the first frame instead
  // of jumping there when the server's inherited row syncs. The dispatch
  // no-ops server-side on the stub id; rekeyId carries the local row to the
  // real id, where the server row supersedes it via altKey.
  const parentBucketId = convBucketMap(store.bucketAssignments)[parentId];
  const parentBucket = parentBucketId ? (store.buckets as Record<string, BucketItem>)[parentBucketId] : undefined;
  // The fork inherits its parent's label; nobody filed it, so no undo.
  if (parentBucket && !parentBucket.archived_at) {
    withoutUndo(() => store.assignSessionToBucket(forkSessionId, parentBucket._id));
  }
  const ready = store.convCommand(parentId, "forkFromMessage", {
    message_uuid: messageUuid,
    session_id: forkSessionId,
  }).then((result) => {
    useInboxStore.getState().resolveForkSessionId(forkSessionId, result.conversation_id);
    return result.conversation_id as string;
  });
  // Same contract as beginOptimisticSession: a message sent against the stub
  // resolves through awaitConvexId → pendingSessionCreates and waits here.
  store.trackSessionCreate(forkSessionId, ready);
  ready.catch((err) => {
    // Parked-unwired is "pending", not "failed": the outbox delivers the fork
    // create on the next drain (must-deliver) and the server row rekeys the
    // stub via altKey sync. Discarding here would tell the user the fork
    // failed while an agent for it spawns minutes later.
    if (err instanceof DispatchNotWiredError && err.parked) return;
    useInboxStore.getState().discardForkStub(forkSessionId, parentId);
    onError?.(err instanceof Error ? err.message : "Failed to fork");
  });
  return { forkSessionId, conversationId: forkSessionId, ready };
}
