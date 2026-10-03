import { useCallback, type RefObject } from "react";
import { agentSupportsFork } from "@codecast/shared/contracts";
import { toast } from "sonner";
import { useInboxStore, type ForkChild, type InboxSession, type OptimisticImage } from "../store/inboxStore";
import { DispatchNotWiredError } from "../store/mutativeMiddleware";
import { beginLocalFork, newForkSessionId, seedForkSessionRow, type LocalFork } from "../store/beginLocalFork";
import { canAnchorForkChips } from "../components/conversation/classify";
import type { ConversationData } from "../components/conversation/types";

export function useForkActions({ conversation, currentUser, hasMoreAbove, convCommand, timelineRef, populateInputRef, addOptimisticMsg, sendInlineMessage }: {
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
  const seedForkSession = useCallback(
    (convId: string, fields: Partial<InboxSession>) => seedForkSessionRow(conversation, convId, fields),
    [conversation],
  );

  // Local-first fork (store/beginLocalFork.ts): the fork renders fully
  // populated in the same frame as the click.
  const doFork = useCallback(async (messageUuid: string): Promise<LocalFork | null> => (
    beginLocalFork(conversation, messageUuid, { currentUser, hasMoreAbove, onError: (message) => toast.error(message) })
  ), [conversation, currentUser, hasMoreAbove]);

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
    const forkSessionId = newForkSessionId();
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
