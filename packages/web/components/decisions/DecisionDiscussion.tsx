"use client";
// A decision's team thread (ct-74449, convex decisionThread.ts), drawn by the
// shared comment components (components/comments): replies, @mentions of
// people, roles and sessions, edit and delete your own, markdown with pills
// and pasted images, drafts that survive navigation, resolve, and the reader's
// unread line. Comments are for people; the decision's own session (for a
// flow card, its presenter) hears the thread when someone asks it, and its
// answer fills a placeholder here. The same block sits on the decision page,
// the queue card, the change card and the Threads page.
import { lazy, Suspense, useMemo, useRef, useState, type ComponentType } from "react";
import { MessageSquare } from "lucide-react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore } from "../../store/inboxStore";
import { useDecisionComments, useDecisionThreadFeed, useDecisionThreadReadAt, useDecisionThreadUnread } from "../../hooks/useDecisionThread";
import { ownerReason } from "../../lib/decisionDiscussion";
import { askDecisionSession, decisionThreadComments, markDecisionThreadRead, newDecisionCommentId, sendDecisionComment } from "../../lib/decisionThread";
import { isThreadResolved, type CommentThread as ThreadModel } from "../../lib/commentThread";
import { cn } from "../../lib/utils";
import { toast } from "sonner";

const refusedToast = (why: string | null) => { if (why) toast.error(why); };

// The shared thread reaches the composer, and the composer the markdown the
// decision card is drawn inside (entity cards render decision cards), so a
// static import here closes an import cycle. It loads beside this module and
// is held once loaded, so only the very first paint can wait on it.
type ThreadComponent = typeof import("../comments/CommentThread").CommentThread;
let LoadedThread: ThreadComponent | null = null;
const threadModule = import("../comments/CommentThread").then((m) => { LoadedThread = m.CommentThread; return m; });
const LazyThread = lazy(() => threadModule.then((m) => ({ default: m.CommentThread as ComponentType<any> })));

/** `open`/`onOpenChange` let a page own the trigger (the decision page's
 *  button by its status); `bare` then drops the block's own trigger.
 *  `askerName` names the session when it is the one that asked, where the
 *  surface calls it by what it is (a line run's session is titled after its
 *  pipeline step). `compact` (a card) leaves the thread unread until the
 *  person opens it; elsewhere showing it reads it. `askFirst` opens the box
 *  on asking the session (a surface whose point is talking to it). */
export function DecisionDiscussion({ decisionId, compact = false, className, open: openProp, onOpenChange, bare = false, askerName, askFirst = false }: { decisionId: string; compact?: boolean; className?: string; open?: boolean; onOpenChange?: (open: boolean) => void; bare?: boolean; askerName?: string; askFirst?: boolean }) {
  const [openOwn, setOpenOwn] = useState(false);
  const open = openProp ?? openOwn;
  const setOpen = (o: boolean) => { setOpenOwn(o); onOpenChange?.(o); };
  // "Discuss with …" opens the box so that the next comment also asks the session.
  const [asking, setAsking] = useState(askFirst);

  const unread = useDecisionThreadUnread(decisionId);
  const rows = useDecisionComments(decisionId);
  // A card whose thread holds nothing subscribes nothing until it is opened.
  useDecisionThreadFeed(decisionId, open || rows.length > 0 || unread > 0 || !compact);
  const owner = useInboxStore((s) => s.decisionThreads[decisionId]?.owner ?? null);
  const askingConversation = useInboxStore((s) => (s.sessionDecisions[decisionId] as { conversation_id?: string } | undefined)?.conversation_id);
  const sessionId = owner?.conversation_id ?? askingConversation ?? "";
  const teamId = useInboxStore((s) => (s.sessions[sessionId] as { team_id?: string } | undefined)?.team_id);
  const me = useInboxStore((s) => (s.currentUser as { _id?: string } | null | undefined)?._id);

  const comments = useMemo(() => decisionThreadComments(rows, sessionId), [rows, sessionId]);
  const thread: ThreadModel = useMemo(() => ({
    key: `decision:${decisionId}`,
    comments,
    lastActivity: comments.length ? comments[comments.length - 1].created_at : 0,
    resolved: isThreadResolved(comments),
  }), [comments, decisionId]);

  // Where the news started when the thread was first drawn, so marking it read leaves the line in place.
  const readAt = useDecisionThreadReadAt(decisionId);
  const frozenReadAt = useRef<number | undefined>(undefined);
  if (frozenReadAt.current === undefined && (rows.length > 0 || unread > 0)) frozenReadAt.current = unread > 0 ? readAt : Number.MAX_SAFE_INTEGER;
  const reading = open || !compact;
  useWatchEffect(() => { if (reading && unread > 0 && rows.length > 0) markDecisionThreadRead(decisionId); }, [reading, unread, rows.length, decisionId]);

  const name = (owner?.via === "asker" && askerName) || owner?.name || "the session that asked";
  const ask = () => { void askDecisionSession(decisionId).then(refusedToast); };
  const discuss = () => { setAsking(true); setOpen(true); };

  const shown = open || comments.length > 0;
  const Thread = (LoadedThread ?? LazyThread) as ThreadComponent;
  if (!shown) {
    if (bare) return null;
    return (
      <div className={cn("flex flex-wrap items-center gap-2", className)} data-decision-discussion onClick={(e) => e.stopPropagation()}>
        <AskButton name={name} title={owner ? ownerReason(owner.via) : undefined} onClick={discuss} />
        <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12.5px] text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text transition-colors" data-discuss-button>
          <MessageSquare className="h-3.5 w-3.5" />Comment
        </button>
      </div>
    );
  }

  return (
    <section className={cn("decision-discussion", className)} data-decision-discussion data-decision-thread onClick={(e) => e.stopPropagation()}>
      <Suspense fallback={null}>
        <Thread
          thread={thread}
          conversationId={sessionId}
          variant="global"
          header={
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <AskButton name={name} title={owner ? ownerReason(owner.via) : undefined} onClick={discuss} />
              {compact && unread > 0 && <span className="rounded-full bg-sol-cyan/15 px-1.5 text-[11px] text-sol-cyan" data-decision-thread-unread>{unread} new</span>}
            </div>
          }
          authed={!!me}
          canWrite={open || !compact}
          currentUserId={me}
          composerAutoFocus={open}
          scopeKey={`decision:${decisionId}`}
          mentionTeamId={teamId}
          placeholder={asking ? `Ask ${name}…` : "Comment for the team"}
          readAt={frozenReadAt.current}
          onAdd={async ({ content, parentCommentId }) => {
            const why = await sendDecisionComment(decisionId, content, newDecisionCommentId(), parentCommentId?.startsWith("dcstub-") ? undefined : parentCommentId);
            refusedToast(why);
            if (!why && asking) { if (!askFirst) setAsking(false); ask(); }
          }}
          onEdit={(commentId, content) => { void useInboxStore.getState().editDecisionComment(commentId, content).then((r: any) => refusedToast(r?.error ?? null)); }}
          onDelete={(commentId) => { void useInboxStore.getState().deleteDecisionComment(commentId).then((r: any) => refusedToast(r?.error ?? null)); }}
          onAskAgent={ask}
          onResolve={(resolved) => useInboxStore.getState().resolveDecisionThread(decisionId, resolved)}
        />
      </Suspense>
      {compact && !open && (
        <button type="button" onClick={() => setOpen(true)} className="mt-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12.5px] text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text transition-colors" data-discuss-button>
          <MessageSquare className="h-3.5 w-3.5" />Comment
        </button>
      )}
    </section>
  );
}

/** Talking the decision over with its session, as plain as the answer buttons. */
function AskButton({ name, title, onClick }: { name: string; title?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title={title} className="inline-flex items-center gap-1.5 rounded-md border border-sol-cyan/40 px-2 py-0.5 text-[12.5px] text-sol-cyan hover:bg-sol-cyan/10 transition-colors" data-decision-ask>
      <MessageSquare className="h-3.5 w-3.5" />Discuss with {name}
    </button>
  );
}
