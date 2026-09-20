import { useCallback, type RefObject } from "react";
import { agentSupportsFork } from "@codecast/shared/contracts";
import { toast } from "sonner";
import { useInboxStore, convBucketMap, type BucketItem, type ForkChild, type InboxSession, type OptimisticImage } from "../store/inboxStore";
import { DispatchNotWiredError } from "../store/mutativeMiddleware";
import { canAnchorForkChips } from "../components/conversation/classify";
import type { ConversationData } from "../components/conversation/types";

export function useForkActions({ injectSession, conversation, addOptimisticFork, currentUser, hasMoreAbove, convCommand, timelineRef, populateInputRef, addOptimisticMsg, sendInlineMessage }: {
  injectSession: (session: InboxSession) => void;
  conversation: ConversationData | null | undefined;
  addOptimisticFork: (fork: ForkChild) => void;
  currentUser: any;
  hasMoreAbove: boolean | undefined;
  convCommand: (convId: string, command: string, extraArgs?: Record<string, any>, optimistic?: Record<string, any>) => Promise<any>;
  timelineRef: RefObject<any[]>;
  populateInputRef: RefObject<((text: string, opts?: { append?: boolean; }) => void) | null>;
  addOptimisticMsg: (convId: string, content: string, images?: Array<OptimisticImage>, clientId?: string) => string;
  sendInlineMessage: (convId: string, content: string, imageIds?: string[], clientId?: string) => void;
}) {
  // Fork UI state (panels). Forks themselves are first-class conversations
  // (we navigate to them); no overlay state to keep in sync.
  const forkSetMessages = useInboxStore((s) => s.setMessages);
  const resolveForkSessionId = useInboxStore((s) => s.resolveForkSessionId);

  // Switch to a freshly created fork instantly from local state. injectSession seeds
  // sessions[id] AND sets currentSessionId in one action, so the inbox renders the
  // fork immediately — no server round-trip, no skeleton. Its real metadata/messages
  // reconcile in the background via getConversationWithMeta + listMessages as the
  // server-side copy advances. Deliberately NOT router.push('/conversation/{id}'): that
  // routes through the redirector page (resolveConversation + loading skeleton +
  // redirect to /inbox), reloading the conversation. QueuePageClient syncs the URL via
  // history.replaceState. Server-derived fields (title prefix, exact message_count) are
  // approximate here and get corrected by the meta subscription within a tick.
  const seedForkSession = useCallback((convId: string, fields: Partial<InboxSession>) => {
    injectSession({
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
    });
  }, [conversation?.title, conversation?.project_path, conversation?.git_root, conversation?.agent_type, injectSession]);

  // Local-first fork: seed the stub conversation WITH the parent's loaded
  // message window sliced at the fork point and navigate to it synchronously —
  // the fork renders fully populated in the same frame as the click. The
  // server mutation, message copy, and daemon tmux spawn all happen behind it;
  // the only visible artifact is the session status line above the input
  // ("Starting session…" → "Ready"). resolveForkSessionId rekeys stub → real id
  // when the mutation lands, and useConversationMessages freezes the server
  // message sync while fork_status === "copying" so the half-copied server
  // window can never clobber the seeded one.
  const doFork = useCallback(async (messageUuid: string): Promise<{ forkSessionId: string; conversationId: string; ready: Promise<string> } | null> => {
    if (!conversation?._id) return null;
    // Honest degradation: a client with no fork mechanism (cursor/gemini/pi) would
    // copy the transcript server-side but leave the live agent context-less. The UI
    // hides the fork controls for these; this guards any programmatic path too.
    if (!agentSupportsFork(conversation.agent_type)) return null;
    const parentId = conversation._id.toString();
    // Must be a valid UUID so the daemon can resume without ID remapping
    const forkSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
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
    addOptimisticFork({
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
    useInboxStore.getState().syncRecord("conversations", forkSessionId, {
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
    forkSetMessages(forkSessionId, seededMsgs, { hasMoreAbove: !!hasMoreAbove || (conversation.loaded_start_index ?? 0) > 0, initialized: true });
    // Seeds sessions[stub] and navigates in one action — instant switch.
    seedForkSession(forkSessionId, {
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
    const forkStore = useInboxStore.getState();
    const parentBucketId = convBucketMap(forkStore.bucketAssignments)[parentId];
    const parentBucket = parentBucketId ? (forkStore.buckets as Record<string, BucketItem>)[parentBucketId] : undefined;
    if (parentBucket && !parentBucket.archived_at) {
      forkStore.assignSessionToBucket(forkSessionId, parentBucket._id);
    }
    const ready = convCommand(parentId, "forkFromMessage", {
      message_uuid: messageUuid,
      session_id: forkSessionId,
    }).then((result) => {
      resolveForkSessionId(forkSessionId, result.conversation_id);
      return result.conversation_id as string;
    });
    // Same contract as beginOptimisticSession: a message sent against the stub
    // resolves through awaitConvexId → pendingSessionCreates and waits here.
    useInboxStore.getState().trackSessionCreate(forkSessionId, ready);
    ready.catch((err) => {
      // Parked-unwired is "pending", not "failed": the outbox delivers the fork
      // create on the next drain (must-deliver) and the server row rekeys the
      // stub via altKey sync. Discarding here would tell the user the fork
      // failed while an agent for it spawns minutes later.
      if (err instanceof DispatchNotWiredError && err.parked) return;
      useInboxStore.getState().discardForkStub(forkSessionId, parentId);
      toast.error(err instanceof Error ? err.message : "Failed to fork");
    });
    return { forkSessionId, conversationId: forkSessionId, ready };
  }, [conversation?._id, conversation?.title, conversation?.messages, conversation?.loaded_start_index, conversation?.project_path, conversation?.git_root, conversation?.agent_type, hasMoreAbove, convCommand, forkSetMessages, addOptimisticFork, resolveForkSessionId, seedForkSession, currentUser?._id, conversation?.user]);

  const handleForkFromMessage = useCallback(async (messageUuid: string) => {
    const tl = timelineRef.current;
    const idx = tl.findIndex((item: any) => item.type === "message" && item.data?.message_uuid === messageUuid);
    if (idx !== -1) {
      const msg = tl[idx].data;
      if (msg.role === "user") {
        for (let i = idx - 1; i >= 0; i--) {
          if (tl[i].type === "message" && canAnchorForkChips(tl[i].data)) {
            await doFork(tl[i].data.message_uuid);
            if (msg.content && populateInputRef.current) {
              setTimeout(() => populateInputRef.current?.(msg.content), 100);
            }
            return;
          }
        }
      }
    }
    await doFork(messageUuid);
  }, [doFork, populateInputRef, timelineRef]);

  // Gate every fork affordance on the client's fork capability: claude/codex/opencode
  // can branch into a live session carrying the copied history; cursor/gemini/pi can't,
  // so the control is HIDDEN (undefined handler) rather than shown as a false success.
  const forkHandler = agentSupportsFork(conversation?.agent_type) ? handleForkFromMessage : undefined;

  // Fork from an ARBITRARY branch — the branch map's "fork higher" drill lets you
  // pick a message in the current branch OR any ancestor/sibling. For the current
  // conversation we reuse the rich, edit-the-prompt path (handleForkFromMessage);
  // for another branch the server copies that branch's history up to the chosen
  // message and the stub fills in as the copy lands.
  const doForkFrom = useCallback(async (branchId: string, messageUuid: string) => {
    if (branchId === conversation?._id?.toString()) return doFork(messageUuid);
    const store = useInboxStore.getState();
    const src = store.sessions[branchId];
    const forkSessionId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
    const now = Date.now();
    const forkTitle = src?.title ? `Fork: ${src.title}` : "Fork";
    store.syncRecord("conversations", forkSessionId, {
      _id: forkSessionId,
      session_id: forkSessionId,
      user_id: currentUser?._id?.toString() ?? "",
      title: forkTitle,
      agent_type: src?.agent_type,
      project_path: src?.project_path ?? undefined,
      git_root: src?.git_root ?? undefined,
      started_at: now,
      updated_at: now,
      status: "active",
      forked_from: branchId,
      parent_message_uuid: messageUuid,
      fork_status: "copying",
    });
    seedForkSession(forkSessionId, {
      session_id: forkSessionId,
      title: forkTitle,
      started_at: now,
      forked_from: branchId,
      parent_message_uuid: messageUuid,
      agent_type: src?.agent_type,
    } as any);
    const ready = convCommand(branchId, "forkFromMessage", { message_uuid: messageUuid, session_id: forkSessionId })
      .then((result: any) => { resolveForkSessionId(forkSessionId, result.conversation_id); return result.conversation_id as string; });
    store.trackSessionCreate(forkSessionId, ready);
    ready.catch((err: any) => {
      // Parked-unwired keeps the stub — see doFork's catch.
      if (err instanceof DispatchNotWiredError && err.parked) return;
      useInboxStore.getState().discardForkStub(forkSessionId, branchId);
      toast.error(err instanceof Error ? err.message : "Failed to fork");
    });
    return { forkSessionId, conversationId: forkSessionId, ready };
  }, [conversation?._id, doFork, currentUser?._id, seedForkSession, convCommand, resolveForkSessionId]);

  const handleForkFromBranch = useCallback((branchId: string, messageUuid: string, _content: string) => {
    if (branchId === conversation?._id?.toString()) { handleForkFromMessage(messageUuid); return; }
    doForkFrom(branchId, messageUuid);
  }, [conversation?._id, handleForkFromMessage, doForkFrom]);

  const handleForkReply = useCallback(async (content: string) => {
    if (!conversation) return;
    const msgs = conversation.messages || [];
    const lastMsg = [...msgs].reverse().find((m: any) => canAnchorForkChips(m));
    if (!lastMsg?.message_uuid) {
      toast.error("No messages to fork from");
      return;
    }
    const forkResult = await doFork(lastMsg.message_uuid);
    if (!forkResult) return;
    // Optimistic bubble lands on the stub instantly (rekeyId carries pending
    // messages to the real id); the durable send waits for the real Convex id
    // since the dispatch pipeline can't address a stub.
    const clientId = addOptimisticMsg(forkResult.conversationId, content);
    forkResult.ready
      .then((realId) => sendInlineMessage(realId, content, undefined, clientId))
      .catch(() => {}); // fork failure already surfaced by doFork
  }, [conversation, doFork, addOptimisticMsg, sendInlineMessage]);

  // Same capability gate as forkHandler: hide fork-and-send where forks can't run.
  const forkSendHandler = agentSupportsFork(conversation?.agent_type) ? handleForkReply : undefined;

  return { handleForkFromMessage, forkHandler, handleForkFromBranch, handleForkReply, forkSendHandler };
}
